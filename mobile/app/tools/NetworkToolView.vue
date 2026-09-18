<script setup>
// 网络工具（手机端）：URL 解析 / IP·CIDR 计算 / UA 解析 / 端口可达性检测。
//
// 前三块是**纯逻辑**（src/networkTool.js，桌面端同一模块），手机端 100% 可用且离线可算。
// 端口检测在桌面端走原生 TCP 握手（network_tcp_check）；手机端目前没有那个原生能力，
// 这里用浏览器能做的**可达性探测**（fetch no-cors）代替，并在界面上如实标注差异——
// 因为"能连上"与"TCP 握手成功"在排查时不是一回事，不能混为一谈。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { analyzeCidr, parseUrl, parseUserAgent, rebuildUrl } from "../../../src/networkTool.js";
import { capabilities } from "../../../src/platform/env.js";

const { t } = useI18n();

const TABS = [
  { key: "url", labelKey: "toolbox.network.tabUrl" },
  { key: "cidr", labelKey: "toolbox.network.tabCidr" },
  { key: "ua", labelKey: "toolbox.network.tabUa" },
  { key: "tcp", labelKey: "toolbox.network.tabTcp" },
];

const tab = ref("url");
const error = ref("");

// ---------- URL 解析 ----------
const urlInput = ref("");
const urlResult = ref(null);
const params = ref([]);

function runUrl() {
  error.value = "";
  urlResult.value = null;
  if (!urlInput.value.trim()) return;
  try {
    const parsed = parseUrl(urlInput.value);
    urlResult.value = parsed;
    params.value = parsed.params.map((p) => ({ ...p }));
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

/** 改完参数能拼回完整 URL —— 这是 URL 解析最实用的地方（去掉追踪参数、改端口）。 */
const rebuiltUrl = computed(() => {
  if (!urlResult.value) return "";
  try {
    return rebuildUrl(urlResult.value, params.value);
  } catch {
    return "";
  }
});

// ---------- CIDR ----------
//
// 注意：错误状态**不能在 computed 里赋值**（Vue 明确反对在 computed 里做副作用，
// 会造成多余重算与竞态）。computed 只返回 { result, error }，由模板取用。
const cidrInput = ref("192.168.1.10/24");
const cidrComputed = computed(() => {
  if (!cidrInput.value.trim()) return { result: null, error: "" };
  try {
    return { result: analyzeCidr(cidrInput.value), error: "" };
  } catch (e) {
    return { result: null, error: e?.message || String(e) };
  }
});
const cidrResult = computed(() => cidrComputed.value.result);
const cidrError = computed(() => cidrComputed.value.error);

// ---------- UA 解析 ----------
// 默认填本机 UA：手机端最常见的用途就是"我现在这个 WebView 到底是什么内核"（排查兼容性问题）
const uaInput = ref(typeof navigator !== "undefined" ? navigator.userAgent : "");
const uaResult = computed(() => {
  if (!uaInput.value.trim()) return null;
  return parseUserAgent(uaInput.value);
});

// ---------- 端口可达性 ----------
const tcpHost = ref("");
const tcpPort = ref(443);
const tcpTimeout = ref(3000);
const tcpBusy = ref(false);
const tcpState = ref(null); // { ok, detail }

/**
 * 可达性探测。
 *
 * 桌面端是原生 TCP 握手；手机端目前只能这样：`fetch(url, { mode:"no-cors" })`——
 * 只要拿到任何响应（哪怕是 opaque）就说明**网络层可达**；抛错则不可达。
 * ⚠️ 局限（界面上也写了）：只能探测 Web 端口（80/443 之类），且无法区分
 * "端口关闭" 与 "被 CORS/安全策略拦掉"。Phase 5 接上原生桥后与桌面端等价。
 */
async function runTcp() {
  error.value = "";
  tcpState.value = null;
  const host = tcpHost.value.trim();
  const port = Number(tcpPort.value);
  if (!host) {
    error.value = t("toolbox.network.tcpHostEmpty");
    return;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    error.value = t("toolbox.network.tcpPortInvalid");
    return;
  }
  tcpBusy.value = true;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(tcpTimeout.value) || 3000));
  try {
    await fetch(`http://${host}:${port}/`, { mode: "no-cors", signal: controller.signal, redirect: "follow" });
    tcpState.value = { ok: true, detail: `${Date.now() - started}ms` };
  } catch (e) {
    // abort 与网络错误都算"不可达"，但要把区别说清楚
    tcpState.value = { ok: false, detail: e?.name === "AbortError" ? t("toolbox.network.waitLabel") : e?.message || String(e) };
  } finally {
    clearTimeout(timer);
    tcpBusy.value = false;
  }
}

const copied = ref("");
async function copy(text) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copied.value = t("toolbox.network.copied");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    error.value = t("toolbox.network.copyFailed");
  }
}

/** 结果行渲染：统一 [标签, 值] 形态，空值显示「—」而不是空白。 */
const rows = (pairs) => pairs.map(([label, value]) => ({ label, value: value === "" || value == null ? t("toolbox.network.valueNone") : String(value) }));
</script>

<template>
  <section class="m-tool" data-tool="network">
    <div class="m-chips">
      <button v-for="item in TABS" :key="item.key" class="m-chip" :class="{ on: tab === item.key }" :data-tab="item.key" @click="tab = item.key">
        {{ t(item.labelKey) }}
      </button>
    </div>

    <!-- URL 解析 -->
    <template v-if="tab === 'url'">
      <label class="m-field">
        <span>URL</span>
        <input v-model="urlInput" spellcheck="false" inputmode="url" data-role="url" placeholder="https://example.com/a?x=1" />
      </label>
      <div class="m-actions">
        <button class="m-btn primary" data-role="parse-url" @click="runUrl">{{ t("toolbox.network.runBtn") }}</button>
      </div>

      <ul v-if="urlResult" class="m-stats" data-role="url-parts">
        <li v-for="row in rows([
          [t('toolbox.network.urlProtocol'), urlResult.protocol],
          [t('toolbox.network.urlHost'), urlResult.hostname],
          [t('toolbox.network.urlPort'), urlResult.port],
          [t('toolbox.network.urlPath'), urlResult.pathname],
          [t('toolbox.network.urlFragment'), urlResult.hash],
          [t('toolbox.network.urlUser'), urlResult.username],
        ])" :key="row.label">
          <b>{{ row.label }}</b><span>{{ row.value }}</span>
        </li>
      </ul>

      <template v-if="urlResult">
        <p class="m-hint-sm">{{ t("toolbox.network.paramsTitle") }}</p>
        <p v-if="!params.length" class="m-hint-sm" data-role="no-params">{{ t("toolbox.network.noParams") }}</p>
        <div v-for="(param, index) in params" :key="index" class="m-field-row">
          <label class="m-field">
            <input v-model="param.key" spellcheck="false" />
          </label>
          <label class="m-field">
            <input v-model="param.value" spellcheck="false" />
          </label>
          <button class="m-op danger" @click="params = params.filter((_, i) => i !== index)">×</button>
        </div>
        <div class="m-actions">
          <button class="m-btn" @click="params = [...params, { key: '', value: '' }]">{{ t("toolbox.network.applyBtn") }}</button>
        </div>
        <label class="m-field">
          <span>{{ t("toolbox.network.appliedRebuilt") }}</span>
          <textarea :value="rebuiltUrl" rows="3" readonly spellcheck="false" data-role="rebuilt"></textarea>
        </label>
        <div class="m-actions">
          <button class="m-btn" data-role="copy-url" @click="copy(rebuiltUrl)">{{ t("toolbox.network.copyDefaultLabel") }}</button>
        </div>
      </template>
    </template>

    <!-- CIDR -->
    <template v-else-if="tab === 'cidr'">
      <label class="m-field">
        <span>IP / CIDR</span>
        <input v-model="cidrInput" spellcheck="false" inputmode="numeric" data-role="cidr" placeholder="192.168.1.10/24" />
      </label>
      <p v-if="cidrError" class="m-err" data-role="error">{{ cidrError }}</p>
      <ul v-if="cidrResult" class="m-stats" data-role="cidr-result">
        <li><b>{{ t("toolbox.network.cidrNetwork") }}</b><span data-role="cidr-network">{{ cidrResult.network }}/{{ cidrResult.prefix }}</span></li>
        <li><b>{{ t("toolbox.network.cidrMask") }}</b><span>{{ cidrResult.subnetMask }}</span></li>
        <li><b>{{ t("toolbox.network.cidrWildcard") }}</b><span>{{ cidrResult.wildcardMask }}</span></li>
        <li><b>{{ t("toolbox.network.cidrBroadcast") }}</b><span>{{ cidrResult.broadcast }}</span></li>
        <li><b>{{ t("toolbox.network.cidrFirstHost") }}</b><span>{{ cidrResult.firstHost }}</span></li>
        <li><b>{{ t("toolbox.network.cidrLastHost") }}</b><span>{{ cidrResult.lastHost }}</span></li>
        <li><b>{{ t("toolbox.network.cidrUsable") }}</b><span data-role="cidr-usable">{{ cidrResult.usableHosts }}</span></li>
        <li><b>{{ t("toolbox.network.cidrType") }}</b><span>{{ cidrResult.private ? t("toolbox.network.cidrPrivate") : t("toolbox.network.cidrPublic") }}</span></li>
        <li><b>{{ t("toolbox.network.binaryLabel") }}</b><span class="m-mono">{{ cidrResult.binary }}</span></li>
      </ul>
    </template>

    <!-- UA 解析 -->
    <template v-else-if="tab === 'ua'">
      <label class="m-field">
        <span>User-Agent</span>
        <textarea v-model="uaInput" rows="4" spellcheck="false" data-role="ua"></textarea>
      </label>
      <div class="m-actions">
        <button class="m-btn" @click="uaInput = navigator.userAgent">{{ t("toolbox.network.refreshBtn") }}</button>
      </div>
      <ul v-if="uaResult" class="m-stats" data-role="ua-result">
        <li><b>{{ t("toolbox.network.uaBrowser") }}</b><span data-role="ua-browser">{{ uaResult.browser?.name || t("toolbox.network.unknown") }} {{ uaResult.browser?.version || "" }}</span></li>
        <li><b>{{ t("toolbox.network.uaOs") }}</b><span>{{ uaResult.os?.name || t("toolbox.network.unknown") }} {{ uaResult.os?.version || "" }}</span></li>
        <li><b>{{ t("toolbox.network.uaEngine") }}</b><span>{{ uaResult.engine?.name || t("toolbox.network.unknown") }}</span></li>
        <li><b>{{ t("toolbox.network.uaPlatformType") }}</b><span>{{ uaResult.platform?.type || t("toolbox.network.unknown") }}</span></li>
        <li><b>{{ t("toolbox.network.uaPlatformVendor") }}</b><span>{{ uaResult.platform?.vendor || t("toolbox.network.unknown") }}</span></li>
        <li><b>{{ t("toolbox.network.uaPlatformModel") }}</b><span>{{ uaResult.platform?.model || t("toolbox.network.unknown") }}</span></li>
      </ul>
    </template>

    <!-- 端口可达性 -->
    <template v-else>
      <label class="m-field">
        <span>{{ t("toolbox.network.tcpHostLabel") }}</span>
        <input v-model="tcpHost" spellcheck="false" data-role="tcp-host" placeholder="example.com" />
      </label>
      <div class="m-field-row">
        <label class="m-field">
          <span>{{ t("toolbox.network.portLabel") }}</span>
          <input v-model.number="tcpPort" type="number" min="1" max="65535" inputmode="numeric" data-role="tcp-port" />
        </label>
        <label class="m-field">
          <span>{{ t("toolbox.network.timeoutLabel") }}</span>
          <input v-model.number="tcpTimeout" type="number" min="500" max="30000" inputmode="numeric" data-role="tcp-timeout" />
        </label>
      </div>
      <div class="m-actions">
        <button class="m-btn primary" :disabled="tcpBusy" data-role="check" @click="runTcp">
          {{ tcpBusy ? t("toolbox.network.tcpLoading") : t("toolbox.network.checkBtn") }}
        </button>
      </div>
      <p v-if="tcpState" class="m-ok" :class="{ 'm-err': !tcpState.ok }" data-role="tcp-state" :data-ok="tcpState.ok">
        {{ (tcpState.ok ? t("toolbox.network.tcpOpen") : t("toolbox.network.tcpClosed")) + " · " + tcpState.detail }}
      </p>
      <!-- 如实标注与桌面端的差异：这里是"网络层可达"，不是原生 TCP 握手 -->
      <p class="m-hint-sm" data-role="tcp-note">{{ t("mobile.netTcpNote") }}</p>
    </template>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="copied" class="m-ok">{{ copied }}</p>
  </section>
</template>
