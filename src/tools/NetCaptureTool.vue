<script setup>
// 抓包（桌面端）：通过 CDP 观察本机某个应用的接口请求，并把选中的那一条转成
// 自动签到工具能直接用的站点描述。
//
// 为什么不是 Fiddler/mitmproxy 那一套：抓包要看到 https 明文，通常得装根证书做 TLS 中间人。
// 那等于把**整机所有程序**的 HTTPS 都交出去，代价和风险都远超需要。
// CDP 是「只看这一个应用」的办法：不装证书、不改系统代理，代价是目标应用必须带
// --remote-debugging-port 重启一次（Chromium 不允许附加到已运行的进程）。
//
// 三条红线：
// 1. **不谎报能力**：探不到端口就说探不到，并区分「应用没开」和「开了但没带调试端口」——
//    这两种的处置完全不同，混成一句「连不上」等于让用户瞎试。
// 2. **不碰凭据**：Cookie/Authorization 一律脱敏后才进列表。CDP 本来也不给 Cookie，
//    这里不做任何"想办法绕过去"的事。
// 3. **不替用户填错**：生成描述时猜不到的字段留空并说明原因，不填一个看起来能用的假值。
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { emit } from "../platform/events.js";
import { SITES_CHANGED_EVENT, loadSites, saveSites } from "../checkin/index.js";
import { startCapture } from "./netcapture/cdp.js";
import { buildDescriptor } from "./netcapture/descriptor.js";
import { appendSite, evaluateAdd, HANDOFF, parseDescriptorObject } from "./netcapture/handoff.js";
import { combineRequests } from "./netcapture/combine.js";
import { guessReadPaths } from "./netcapture/descriptor.js";
import { DEFAULT_PREFS, loadPrefs, parseEnvText, savePrefs } from "./netcapture/prefs.js";
import { envTextFor, matchPreset, needsEnv, shouldPassArgs } from "./netcapture/presets.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const port = ref(DEFAULT_PREFS.port);
const exePath = ref(DEFAULT_PREFS.exePath);
const filterText = ref("");
// 只认环境变量的应用靠这一栏开调试端口（实测 Qoder / WorkBuddy 都是）。
const envText = ref("");
const capturing = ref(false);
const browserName = ref("");
const targetCount = ref(0);
const requests = ref([]);
const selectedId = ref(null);
// 「查状态」那条请求单独记一个 id：签到端点里的动态 ID 只能从它的响应里取，
// 所以需要同时选中两条，不能只有一个 selectedId。
const statusId = ref(null);
const status = ref("");
const statusTone = ref("muted");
const logs = ref([]);
const descriptorText = ref("");
const descriptorWarnings = ref([]);

let session = null;

const selected = computed(() => requests.value.find((r) => r.id === selectedId.value) || null);
const statusRecord = computed(() => requests.value.find((r) => r.id === statusId.value) || null);
const filtered = computed(() => {
  const key = filterText.value.trim().toLowerCase();
  if (!key) return requests.value;
  return requests.value.filter((r) => `${r.method} ${r.url}`.toLowerCase().includes(key));
});

function setStatus(text, tone = "muted") {
  status.value = text;
  statusTone.value = tone;
}

function pushLog(text) {
  logs.value = [...logs.value.slice(-40), text];
}

/** 探测走 Rust：CDP 的 HTTP 端点不认跨域，前端 fetch 会被浏览器拒掉。 */
async function probeTargets() {
  const result = await invoke("netcapture_probe", { port: Number(port.value) || 0 });
  return Array.isArray(result?.targets) ? result.targets : [];
}

async function doProbe() {
  setStatus(t("netcapture.probing"));
  try {
    const result = await invoke("netcapture_probe", { port: Number(port.value) || 0 });
    browserName.value = result?.browser || "";
    targetCount.value = Array.isArray(result?.targets) ? result.targets.length : 0;
    setStatus(
      targetCount.value
        ? t("netcapture.probeOk", { browser: browserName.value, n: targetCount.value })
        : t("netcapture.probeNoTargets"),
      targetCount.value ? "ok" : "warn",
    );
  } catch (error) {
    browserName.value = "";
    targetCount.value = 0;
    // 区分「没带调试端口启动」和「应用根本没开」——处置方式完全不同
    const running = await isRunning();
    setStatus(
      running ? t("netcapture.probeRunningNoPort") : t("netcapture.probeFailed", { err: error?.message || error }),
      "bad",
    );
  }
  return targetCount.value;
}

async function isRunning() {
  const name = exePath.value.trim().split(/[\\/]/).pop();
  if (!name) return false;
  try {
    const result = await invoke("netcapture_find_processes", { name });
    return Array.isArray(result?.processes) && result.processes.length > 0;
  } catch {
    return false;
  }
}

async function launchWithPort() {
  const path = exePath.value.trim();
  if (!path) {
    props.showToast(t("netcapture.needPath"));
    return;
  }
  const p = Number(port.value) || 0;
  // --remote-allow-origins=* 是必需的：没有它，本工具窗口（带 Origin）连不上 CDP 的 WebSocket。
  // 认出来的应用如果声明「不吃参数」，就只靠环境变量——传了它也会忽略，不如不传。
  const args = shouldPassArgs(preset.value)
    ? [`--remote-debugging-port=${p}`, "--remote-allow-origins=*"]
    : [];
  const env = parseEnvText(envText.value);
  try {
    await invoke("netcapture_launch", { exePath: path, args, env });
  } catch (error) {
    props.showToast(`${t("netcapture.launchFailed")}：${error?.message || error}`);
    return;
  }

  // 进程起来了 ≠ 调试端口开了。中间还有好几种静默失败：
  //   - 启动器只拉起后台组件，桌面应用根本没起（实测 Qoder 的 Launcher 就是这样）；
  //   - 应用外壳是 Node SFA，把 --remote-debugging-port 当非法 Node 选项拒掉并退出（Qoder 也是）；
  //   - 应用把参数丢了、或已有实例持有单实例锁，新进程直接退出。
  // 这几种情况下进程表里都能看到东西，所以**只能以端口通不通为准**。
  // 之前这里直接提示「已启动」，等于把上面几种失败都说成了成功——用户只会觉得工具坏了。
  setStatus(t("netcapture.waitPort", { port: p }), "warn");
  const up = await waitForPort(p, 15000);
  if (up) {
    props.showToast(t("netcapture.launched", { port: p }));
    setStatus(t("netcapture.portReady", { port: p }), "ok");
    return;
  }
  setStatus(t("netcapture.portNeverOpened", { port: p }), "bad");
  props.showToast(t("netcapture.launchNoPort"));
}

/** 轮询调试端口，返回它是否真的开了。 */
async function waitForPort(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const result = await invoke("netcapture_probe", { port: p, timeoutMs: 2000 });
      if (result?.browser) return true;
    } catch {
      // 没起来就是没起来，继续等
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function start() {
  if (capturing.value) return;
  setStatus(t("netcapture.starting"));
  try {
    session = await startCapture({
      port: Number(port.value) || 0,
      probe: probeTargets,
      urlFilter: filterText.value.trim() ? new RegExp(escapeRegExp(filterText.value.trim()), "i") : null,
      onTarget: (target) => pushLog(t("netcapture.attached", { title: target.title || target.url })),
      onLog: pushLog,
      onRequest: (record) => {
        requests.value = [record, ...requests.value].slice(0, 300);
        // 计数必须跟着走。之前只在 start() 里设过一次，于是那句「已抓到 N 条」
        // 永远停在开始那一刻的数字——列表里明明有 6 条、状态却写 0 条，
        // 用户会以为抓包没生效，然后去反复点「开始抓包」。
        if (capturing.value) setStatus(t("netcapture.running", { n: requests.value.length }), "ok");
      },
    });
    capturing.value = true;
    targetCount.value = session.targetCount;
    setStatus(t("netcapture.running", { n: requests.value.length }), "ok");
  } catch (error) {
    session = null;
    capturing.value = false;
    setStatus(`${t("netcapture.startFailed")}：${error?.message || error}`, "bad");
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stop() {
  session?.stop();
  session = null;
  capturing.value = false;
  setStatus(t("netcapture.stopped"), "muted");
}

function clear() {
  requests.value = [];
  selectedId.value = null;
  descriptorText.value = "";
  descriptorWarnings.value = [];
}

function select(record) {
  selectedId.value = record.id;
  descriptorText.value = "";
  descriptorWarnings.value = [];
}

/** 标记/取消「这条是查状态请求」。再点一次取消，免得标错了没法退。 */
function markStatus(record) {
  statusId.value = statusId.value === record.id ? null : record.id;
  descriptorText.value = "";
  descriptorWarnings.value = [];
}

function generate() {
  if (!selected.value) return;
  // 同时选中了查状态请求就合并生成：签到端点里带每天会变的 ID 时，
  // 只靠一条请求生成不出可用配置（拿不到那个 ID，也判断不了「今天是否已签」）。
  const out = statusRecord.value
    ? combineRequests(selected.value, statusRecord.value, { buildDescriptor, guessReadPaths })
    : buildDescriptor(selected.value);
  descriptorWarnings.value = out.warnings;
  descriptorText.value = JSON.stringify(out.descriptor ?? {}, null, 2);
  if (!out.valid) props.showToast(t("netcapture.descriptorIncomplete"));
}

/** 一键把描述框里的内容加进签到站点列表，省掉「复制 → 粘贴」这一段。 */
async function addToCheckIn() {
  if (!selected.value) return;
  const parsed = parseDescriptorObject(descriptorText.value);
  if (!parsed) {
    props.showToast(t("netcapture.addRejected"));
    return;
  }
  // 真实列表要到这里才拿得到，所以校验和冲突判定一起做，避免解析两遍。
  const existing = (await loadSites()) || [];
  const result = evaluateAdd(parsed, existing);
  if (!result.ok) {
    descriptorWarnings.value = result.errors;
    props.showToast(result.reason === HANDOFF.DUPLICATE ? t("netcapture.siteExists") : t("netcapture.addRejected"));
    return;
  }

  saveSites(appendSite(existing, result.site));
  await emit(SITES_CHANGED_EVENT);
  props.showToast(t("netcapture.added", { label: result.site.label }));
}

async function copyDescriptor() {
  if (!descriptorText.value) return;
  try {
    await navigator.clipboard.writeText(descriptorText.value);
    props.showToast(t("netcapture.copied"));
  } catch {
    props.showToast(t("netcapture.copyFailed"));
  }
}

function statusToneOf(record) {
  if (record.error) return "bad";
  if (!record.status) return "muted";
  if (record.status >= 500) return "bad";
  if (record.status >= 400) return "warn";
  return "ok";
}

function pretty(value) {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

/**
 * 路径一填进来就认出是哪个应用，把端口和启动方式全部自动配好。
 *
 * 用户不该知道「这个应用吃参数、那个只认环境变量」——那是应用内部实现。
 * 他看到的应该只是「选个程序，点启动」。
 */
const preset = computed(() => matchPreset(exePath.value));

async function applyPreset() {
  const p = preset.value;
  if (!p) return;
  // 端口没被手动改过就自动挑一个空闲的
  if (!portTouched.value) {
    const picked = await invoke("netcapture_pick_port").catch(() => 0);
    if (picked) port.value = picked;
  }
  if (needsEnv(p)) envText.value = envTextFor(p, port.value);
}

// 端口是否是用户自己填的。自己填过就不再覆盖——自动不能盖掉明确意图。
const portTouched = ref(false);

watch(exePath, () => { void applyPreset(); });
watch(port, (next) => {
  const p = preset.value;
  if (needsEnv(p)) envText.value = envTextFor(p, next);
});

onMounted(async () => {
  // 程序路径、端口、过滤条件都记住：路径长且带空格，手打既慢又容易打错，
  // 而打错的表现是「启动失败」，很容易被误判成工具坏了。
  const saved = await loadPrefs();
  port.value = saved.port;
  exePath.value = saved.exePath;
  filterText.value = saved.filterText;
  envText.value = saved.envText;
});

// 三项都是「填一次就长期不变」的输入，逐项监听即可。
// saveToolbox 自带 200ms 防抖，边打字边写不会打爆磁盘。
watch([exePath, port, filterText, envText], () => {
  savePrefs({ exePath: exePath.value, port: port.value, filterText: filterText.value, envText: envText.value }, (detail) => {
    props.showToast(t("netcapture.saveFailed"));
    console.warn("抓包工具偏好保存失败", detail);
  });
});

onUnmounted(() => session?.stop());
</script>

<template>
  <div class="nc">
    <header class="nc-head">
      <div class="nc-title">
        <h2>{{ t("netcapture.title") }}</h2>
        <p class="nc-sub">{{ t("netcapture.subtitle") }}</p>
      </div>
      <div class="nc-actions">
        <button v-if="!capturing" class="btn primary" data-role="start" @click="start">{{ t("netcapture.start") }}</button>
        <button v-else class="btn danger" data-role="stop" @click="stop">{{ t("netcapture.stop") }}</button>
        <button class="btn" data-role="clear" @click="clear">{{ t("netcapture.clear") }}</button>
      </div>
    </header>

    <section class="nc-conn">
      <label class="nc-field grow">
        <span>{{ t("netcapture.exePath") }}</span>
        <input v-model="exePath" spellcheck="false" :placeholder="t('netcapture.exePathPh')" data-role="exe-path" />
      </label>
      <button class="btn" data-role="probe" @click="doProbe">{{ t("netcapture.probe") }}</button>
      <button class="btn primary" data-role="launch" @click="launchWithPort">{{ t("netcapture.launch") }}</button>

      <!-- 认出来的应用：只显示一句人话，端口和环境变量都藏起来 -->
      <p v-if="preset" class="nc-hint nc-preset" data-role="preset">
        {{ t("netcapture.presetRecognized", { app: preset.label }) }}
      </p>

      <!-- 认不出来才展开这些。它们是实现细节，不该默认摆在用户面前。 -->
      <details v-else class="nc-advanced" data-role="advanced">
        <summary>{{ t("netcapture.advanced") }}</summary>
        <label class="nc-field">
          <span>{{ t("netcapture.portLabel") }}</span>
          <input v-model="port" type="number" min="1" max="65535" data-role="port" @change="portTouched = true" />
        </label>
        <label class="nc-field nc-field-wide">
          <span>{{ t("netcapture.envLabel") }}</span>
          <textarea v-model="envText" rows="2" spellcheck="false" data-role="env" :placeholder="t('netcapture.envPlaceholder')"></textarea>
        </label>
        <p class="nc-hint">{{ t("netcapture.envHint") }}</p>
      </details>

      <p v-if="preset" class="nc-hint" data-role="preset-note">{{ preset.note }}</p>
      <span class="nc-hint">{{ t("netcapture.rememberHint") }}</span>
    </section>

    <p class="nc-status" :data-tone="statusTone" data-role="status">{{ status || t("netcapture.idle") }}</p>

    <details class="nc-note">
      <summary>{{ t("netcapture.whyTitle") }}</summary>
      <ul>
        <li>{{ t("netcapture.why1") }}</li>
        <li>{{ t("netcapture.why2") }}</li>
        <li>{{ t("netcapture.why3") }}</li>
      </ul>
    </details>

    <section class="nc-list-head">
      <label class="nc-field grow">
        <input v-model="filterText" :placeholder="t('netcapture.filterPh')" data-role="filter" />
      </label>
      <span class="nc-count">{{ filtered.length }} / {{ requests.length }}</span>
    </section>

    <ul class="nc-list">
      <li
        v-for="record in filtered"
        :key="record.id"
        class="nc-item"
        :data-selected="record.id === selectedId"
        :data-role="`req-${record.id}`"
        @click="select(record)"
      >
        <span class="nc-method" :data-method="record.method">{{ record.method }}</span>
        <span class="nc-status-badge" :data-tone="statusToneOf(record)">{{ record.status || "—" }}</span>
        <span class="nc-path">{{ record.host }}{{ record.path }}</span>
        <!-- 第二个选择槽：有些站点的签到端点带一个每天会变的 ID，那个 ID 只能从
             另一个请求的响应里拿到，所以必须能同时选中两条。 -->
        <button
          class="nc-mark"
          :class="{ on: record.id === statusId }"
          :title="t('netcapture.markStatusTitle')"
          :data-role="`mark-${record.id}`"
          @click.stop="markStatus(record)"
        >{{ record.id === statusId ? t("netcapture.isStatus") : t("netcapture.markStatus") }}</button>
      </li>
      <li v-if="!filtered.length" class="nc-empty">{{ t("netcapture.empty") }}</li>
    </ul>

    <section v-if="selected" class="nc-detail" data-role="detail">
      <h3>{{ selected.method }} {{ selected.host }}{{ selected.path }}</h3>
      <details><summary>{{ t("netcapture.reqHeaders") }}</summary><pre>{{ pretty(selected.requestHeaders) }}</pre></details>
      <details v-if="selected.requestBody != null"><summary>{{ t("netcapture.reqBody") }}</summary><pre>{{ pretty(selected.requestBody) }}</pre></details>
      <details><summary>{{ t("netcapture.resHeaders") }}</summary><pre>{{ pretty(selected.responseHeaders) }}</pre></details>
      <details><summary>{{ t("netcapture.resBody") }}</summary><pre>{{ pretty(selected.responseBody) }}</pre></details>
      <div class="nc-detail-actions">
        <button class="btn primary" data-role="generate" @click="generate">{{ t("netcapture.generate") }}</button>
        <span v-if="statusRecord" class="nc-hint nc-hint-inline" data-role="combine-note">
          {{ t("netcapture.combineNote", { path: statusRecord.path }) }}
        </span>
        <span v-else class="nc-hint nc-hint-inline">{{ t("netcapture.markStatusHint") }}</span>
      </div>
      <ul v-if="descriptorWarnings.length" class="nc-warns" data-role="warnings">
        <li v-for="(w, i) in descriptorWarnings" :key="i">{{ w }}</li>
      </ul>
      <textarea v-if="descriptorText" v-model="descriptorText" rows="14" spellcheck="false" data-role="descriptor"></textarea>
      <p v-if="descriptorText" class="nc-hint" data-role="edit-hint">{{ t("netcapture.editableHint") }}</p>
      <div v-if="descriptorText" class="nc-detail-actions">
        <button class="btn primary" data-role="add-site" @click="addToCheckIn">{{ t("netcapture.addToCheckIn") }}</button>
        <button class="btn" data-role="copy" @click="copyDescriptor">{{ t("netcapture.copy") }}</button>
      </div>
    </section>

    <details v-if="logs.length" class="nc-logs">
      <summary>{{ t("netcapture.logs") }}</summary>
      <ul><li v-for="(line, i) in logs" :key="i">{{ line }}</li></ul>
    </details>
  </div>
</template>

<style scoped>
.nc { display: flex; flex-direction: column; gap: var(--fs-sm); padding: var(--fs-md); height: 100%; overflow: auto; }
.nc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--fs-md); }
.nc-title h2 { margin: 0 0 4px; font-size: var(--fs-lg); }
.nc-sub { margin: 0; color: var(--text-weak); font-size: var(--fs-sm); line-height: var(--lh-body); }
.nc-actions { display: flex; gap: var(--r-xs); }
.btn { padding: 5px 11px; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--card); color: var(--text); cursor: pointer; font-size: var(--fs-sm); }
.btn:hover:not(:disabled) { border-color: var(--primary); }
.btn.primary { background: var(--primary); border-color: var(--primary); color: var(--text-invert); }
.btn.danger { color: var(--danger); border-color: var(--border-danger); }
.nc-conn { display: flex; flex-wrap: wrap; align-items: center; gap: var(--r-xs); padding: var(--fs-sm); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--card); }
.nc-field { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); }
.nc-field.grow { flex: 1; min-width: 180px; }
.nc-field input { flex: 1; min-width: 0; padding: 3px 6px; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--bg); color: var(--text); }
.nc-hint { flex-basis: 100%; font-size: var(--fs-xs); color: var(--text-weak); }
.nc-field-wide { flex: 1 1 100%; align-items: flex-start; }
.nc-field-wide textarea { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-xs); padding: 3px 6px; border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--bg); color: var(--text); resize: vertical; }
.nc-hint-inline { flex-basis: auto; }
.nc-mark { margin-left: auto; padding: 1px 6px; font-size: var(--fs-xs); border: 1px solid var(--border); border-radius: var(--r-xs); background: transparent; color: var(--text-weak); cursor: pointer; }
.nc-mark.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.nc-status { margin: 0; font-size: var(--fs-sm); color: var(--text-weak); }
.nc-status[data-tone="ok"] { color: var(--success); }
.nc-status[data-tone="warn"] { color: var(--warn); }
.nc-status[data-tone="bad"] { color: var(--danger); }
.nc-note { font-size: var(--fs-xs); color: var(--text-weak); }
.nc-note summary { cursor: pointer; }
.nc-note ul { margin: 6px 0 0; padding-left: 18px; line-height: var(--lh-body); }
.nc-list-head { display: flex; align-items: center; gap: var(--r-xs); }
.nc-count { font-size: var(--fs-xs); color: var(--text-weak); font-family: var(--font-num); }
.nc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.nc-item { display: flex; align-items: center; gap: var(--r-xs); padding: 6px var(--fs-sm); border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--card); cursor: pointer; font-size: var(--fs-sm); }
.nc-item:hover { border-color: var(--primary); }
.nc-item[data-selected="true"] { border-color: var(--primary); }
.nc-method { min-width: 44px; font-family: var(--font-mono); font-size: var(--fs-xs); font-weight: 600; }
.nc-method[data-method="POST"] { color: var(--primary); }
.nc-method[data-method="GET"] { color: var(--success); }
.nc-status-badge { min-width: 32px; text-align: center; font-size: var(--fs-xs); font-family: var(--font-num); color: var(--text-weak); }
.nc-status-badge[data-tone="ok"] { color: var(--success); }
.nc-status-badge[data-tone="warn"] { color: var(--warn); }
.nc-status-badge[data-tone="bad"] { color: var(--danger); }
.nc-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-xs); }
.nc-empty { padding: 18px; text-align: center; color: var(--text-weak); border: 1px dashed var(--border); border-radius: var(--r-sm); }
.nc-detail { display: flex; flex-direction: column; gap: var(--r-xs); padding: var(--fs-md); border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--card); }
.nc-detail h3 { margin: 0; font-size: var(--fs-md); font-family: var(--font-mono); word-break: break-all; }
.nc-detail summary { cursor: pointer; color: var(--text-weak); font-size: var(--fs-sm); }
.nc-detail pre { margin: 4px 0 0; padding: var(--r-xs); background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-xs); font-size: var(--fs-xs); overflow: auto; max-height: 220px; }
.nc-detail textarea { width: 100%; font-family: var(--font-mono); font-size: var(--fs-sm); padding: var(--r-xs); border: 1px solid var(--border); border-radius: var(--r-xs); background: var(--bg); color: var(--text); resize: vertical; }
.nc-detail-actions { display: flex; gap: var(--r-xs); }
.nc-warns { margin: 0; padding-left: 18px; color: var(--warn); font-size: var(--fs-xs); line-height: var(--lh-body); }
.nc-logs { font-size: var(--fs-xs); color: var(--text-weak); }
.nc-logs summary { cursor: pointer; }
.nc-logs ul { margin: 6px 0 0; padding-left: 18px; }
</style>