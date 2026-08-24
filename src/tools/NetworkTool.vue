<script setup>
import { computed, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import Icon from "../Icon.vue";
import { analyzeCidr, parseUrl, parseUserAgent, rebuildUrl } from "../networkTool.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const TABS = [
  { key: "url", label: "URL 解析" },
  { key: "cidr", label: "IP / CIDR" },
  { key: "dns", label: "DNS 查询" },
  { key: "tcp", label: "端口检测" },
  { key: "path", label: "Ping / 路由" },
  { key: "local", label: "本机网络" },
  { key: "ua", label: "UA 解析" },
];
const activeTab = ref("url");
const isTauri = !!window.__TAURI_INTERNALS__;

const urlInput = ref("");
const urlParts = ref(null);
const urlParams = ref([]);
const urlError = ref("");
watch(urlInput, parseUrlInput, { immediate: true });
const rebuiltUrl = computed(() => {
  if (!urlParts.value) return "";
  try {
    return rebuildUrl(urlParts.value, urlParams.value);
  } catch {
    return "";
  }
});

function parseUrlInput() {
  if (!urlInput.value.trim()) {
    urlParts.value = null;
    urlParams.value = [];
    urlError.value = "";
    return;
  }
  try {
    const result = parseUrl(urlInput.value);
    urlParts.value = result;
    urlParams.value = result.params.map((item) => ({ ...item }));
    urlError.value = "";
  } catch (error) {
    urlParts.value = null;
    urlParams.value = [];
    urlError.value = errorMessage(error);
  }
}

function addUrlParam() {
  urlParams.value.push({ key: "", value: "" });
}

function applyRebuiltUrl() {
  if (!rebuiltUrl.value) return;
  urlInput.value = rebuiltUrl.value;
  props.showToast("已应用重建后的 URL");
}

const cidrInput = ref("");
const cidrResult = computed(() => safeResult(() => cidrInput.value.trim() ? analyzeCidr(cidrInput.value) : null));
const cidrItems = computed(() => {
  const result = cidrResult.value.data;
  if (!result) return [];
  return [
    ["IP 地址", result.ip], ["CIDR 前缀", `/${result.prefix}`],
    ["子网掩码", result.subnetMask], ["反掩码", result.wildcardMask],
    ["网络地址", result.network], ["广播地址", result.broadcast],
    ["首个主机", result.firstHost], ["末个主机", result.lastHost],
    ["地址总数", result.totalAddresses.toLocaleString("zh-CN")],
    ["可用主机", result.usableHosts.toLocaleString("zh-CN")],
    ["整数形式", result.integer.toLocaleString("zh-CN")],
    ["地址类型", result.private ? "私有地址" : "公网 / 特殊地址"],
  ];
});

const dnsHost = ref("");
const dnsState = ref(taskState());
async function runDns() {
  if (!dnsHost.value.trim()) return props.showToast("请输入域名或主机名");
  await runNative(dnsState, "network_dns_lookup", { host: dnsHost.value.trim() });
}

const tcpHost = ref("");
const tcpPort = ref(443);
const tcpTimeout = ref(3000);
const tcpState = ref(taskState());
async function runTcp() {
  if (!tcpHost.value.trim()) return props.showToast("请输入主机名或 IP 地址");
  const port = Number(tcpPort.value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return props.showToast("端口必须在 1 到 65535 之间");
  await runNative(tcpState, "network_tcp_check", {
    host: tcpHost.value.trim(), port, timeoutMs: Number(tcpTimeout.value),
  });
}

const pathMode = ref("ping");
const pathTarget = ref("");
const pingCount = ref(4);
const maxHops = ref(15);
const pathTimeout = ref(1000);
const pathState = ref(taskState());
async function runPath() {
  if (!pathTarget.value.trim()) return props.showToast("请输入主机名或 IP 地址");
  const command = pathMode.value === "ping" ? "network_ping" : "network_trace";
  const args = pathMode.value === "ping"
    ? { target: pathTarget.value.trim(), count: Number(pingCount.value), timeoutMs: Number(pathTimeout.value) }
    : { target: pathTarget.value.trim(), maxHops: Number(maxHops.value), timeoutMs: Number(pathTimeout.value) };
  await runNative(pathState, command, args);
}

const localState = ref(taskState());
async function loadInterfaces() {
  await runNative(localState, "network_interfaces", {});
}

const userAgentInput = ref(navigator.userAgent || "");
const userAgentResult = computed(() => parseUserAgent(userAgentInput.value));
const uaItems = computed(() => {
  const result = userAgentResult.value;
  return [
    ["浏览器", joinNameVersion(result.browser)],
    ["操作系统", joinNameVersion(result.os)],
    ["平台类型", result.platform.type || "未知"],
    ["平台厂商", result.platform.vendor || "未知"],
    ["平台型号", result.platform.model || "未知"],
    ["渲染引擎", joinNameVersion(result.engine)],
  ];
});

function selectTab(key) {
  activeTab.value = key;
  if (key === "local" && !localState.value.data && !localState.value.loading) loadInterfaces();
}

function taskState() {
  return { loading: false, data: null, error: "" };
}

async function runNative(stateRef, command, args) {
  stateRef.value = { loading: true, data: null, error: "" };
  if (!isTauri) {
    stateRef.value = { loading: false, data: null, error: "此检测需要在桌面应用中运行" };
    return;
  }
  try {
    const data = await invoke(command, args);
    stateRef.value = { loading: false, data, error: "" };
  } catch (error) {
    stateRef.value = { loading: false, data: null, error: errorMessage(error) };
  }
}

function safeResult(fn) {
  try {
    return { data: fn(), error: "" };
  } catch (error) {
    return { data: null, error: errorMessage(error) };
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function joinNameVersion(value) {
  return [value?.name, value?.version].filter(Boolean).join(" ") || "未知";
}

async function copyText(value, label = "结果") {
  if (!value) return props.showToast(`没有可复制的${label}`);
  try {
    await navigator.clipboard.writeText(String(value));
    props.showToast(`已复制${label}`);
  } catch (error) {
    props.showToast("复制失败：" + errorMessage(error));
  }
}
</script>

<template>
  <div class="network-tool">
    <nav class="mode-tabs" aria-label="网络诊断类型">
      <button v-for="tab in TABS" :key="tab.key" type="button" class="mode-tab" :class="{ on: activeTab === tab.key }" @click="selectTab(tab.key)">{{ tab.label }}</button>
    </nav>

    <section v-if="activeTab === 'url'" class="workspace url-workspace">
      <label class="field wide"><span>URL</span><input v-model="urlInput" class="mono" placeholder="https://example.com/api?name=value" /></label>
      <div v-if="urlError" class="inline-error"><Icon name="alert" :size="16" />{{ urlError }}</div>
      <template v-else-if="urlParts">
        <div class="url-layout">
          <section class="panel parts-panel">
            <header class="panel-head"><b>组成部分</b><span v-if="urlParts.inferredProtocol">已补全 HTTPS</span></header>
            <dl class="detail-list">
              <div><dt>协议</dt><dd>{{ urlParts.protocol }}</dd></div>
              <div><dt>主机</dt><dd :title="urlParts.hostname">{{ urlParts.hostname }}</dd></div>
              <div><dt>端口</dt><dd>{{ urlParts.port || "默认" }}</dd></div>
              <div><dt>路径</dt><dd :title="urlParts.pathname">{{ urlParts.pathname }}</dd></div>
              <div><dt>认证用户</dt><dd>{{ urlParts.username || "无" }}</dd></div>
              <div><dt>片段</dt><dd :title="urlParts.hash">{{ urlParts.hash || "无" }}</dd></div>
            </dl>
          </section>
          <section class="panel params-panel">
            <header class="panel-head"><b>查询参数</b><button class="icon-btn xs" type="button" title="添加查询参数" @click="addUrlParam"><Icon name="plus" :size="14" /></button></header>
            <div class="param-list">
              <div v-for="(param, index) in urlParams" :key="index" class="param-row">
                <input v-model="param.key" class="mono" aria-label="参数名" placeholder="参数名" />
                <input v-model="param.value" class="mono" aria-label="参数值" placeholder="参数值" />
                <button class="icon-btn xs" type="button" title="删除参数" @click="urlParams.splice(index, 1)"><Icon name="x" :size="13" /></button>
              </div>
              <p v-if="!urlParams.length" class="empty-line">没有查询参数</p>
            </div>
          </section>
        </div>
        <div class="result-strip">
          <code :title="rebuiltUrl">{{ rebuiltUrl }}</code>
          <button class="btn-ghost xs" type="button" @click="applyRebuiltUrl">应用</button>
          <button class="icon-btn xs" type="button" title="复制重建 URL" @click="copyText(rebuiltUrl, ' URL')"><Icon name="copy" :size="13" /></button>
        </div>
      </template>
      <div v-else class="blank-state"><Icon name="link" :size="24" /><span>URL 解析结果</span></div>
    </section>

    <section v-else-if="activeTab === 'cidr'" class="workspace cidr-workspace">
      <label class="field cidr-field"><span>IPv4 / CIDR</span><input v-model="cidrInput" class="mono" placeholder="192.168.1.20/24" /></label>
      <div v-if="cidrResult.error" class="inline-error"><Icon name="alert" :size="16" />{{ cidrResult.error }}</div>
      <template v-else-if="cidrResult.data">
        <div class="stats-grid"><div v-for="item in cidrItems" :key="item[0]" class="stat-item"><span>{{ item[0] }}</span><b :title="String(item[1])">{{ item[1] }}</b></div></div>
        <div class="binary-row"><span>二进制</span><code>{{ cidrResult.data.binary }}</code><button class="icon-btn xs" title="复制二进制地址" @click="copyText(cidrResult.data.binary)"><Icon name="copy" :size="13" /></button></div>
      </template>
      <div v-else class="blank-state"><Icon name="network" :size="24" /><span>IP 与网段计算结果</span></div>
    </section>

    <section v-else-if="activeTab === 'dns'" class="workspace task-workspace">
      <div class="query-bar"><label class="field grow"><span>域名或主机名</span><input v-model="dnsHost" class="mono" placeholder="example.com" @keyup.enter="runDns" /></label><button class="btn-primary" type="button" :disabled="dnsState.loading" @click="runDns"><Icon name="search" :size="15" />查询</button></div>
      <div class="panel task-result">
        <header class="panel-head"><b>解析结果</b><span v-if="dnsState.data">{{ dnsState.data.durationMs }} ms</span></header>
        <div v-if="dnsState.loading" class="loading-state"><span class="spinner"></span>正在查询</div>
        <div v-else-if="dnsState.error" class="error-state"><Icon name="alert" :size="20" /><span>{{ dnsState.error }}</span></div>
        <div v-else-if="dnsState.data" class="address-list"><div v-for="item in dnsState.data.addresses" :key="item.address" class="address-row"><span class="type-chip">{{ item.family }}</span><code>{{ item.address }}</code><button class="icon-btn xs" title="复制地址" @click="copyText(item.address, '地址')"><Icon name="copy" :size="13" /></button></div></div>
        <div v-else class="blank-state"><Icon name="globe" :size="24" /><span>DNS 地址记录</span></div>
      </div>
    </section>

    <section v-else-if="activeTab === 'tcp'" class="workspace task-workspace">
      <div class="query-bar tcp-bar">
        <label class="field grow"><span>主机名或 IP</span><input v-model="tcpHost" class="mono" placeholder="example.com" @keyup.enter="runTcp" /></label>
        <label class="field number-field"><span>端口</span><input v-model.number="tcpPort" type="number" min="1" max="65535" /></label>
        <label class="field number-field"><span>超时（ms）</span><input v-model.number="tcpTimeout" type="number" min="200" max="30000" step="100" /></label>
        <button class="btn-primary" type="button" :disabled="tcpState.loading" @click="runTcp"><Icon name="activity" :size="15" />检测</button>
      </div>
      <div class="panel task-result">
        <header class="panel-head"><b>检测结果</b><span v-if="tcpState.data">{{ tcpState.data.durationMs }} ms</span></header>
        <div v-if="tcpState.loading" class="loading-state"><span class="spinner"></span>正在连接</div>
        <div v-else-if="tcpState.error" class="error-state"><Icon name="alert" :size="20" /><span>{{ tcpState.error }}</span></div>
        <div v-else-if="tcpState.data" class="tcp-result" :class="{ open: tcpState.data.open }"><span class="status-icon"><Icon :name="tcpState.data.open ? 'check' : 'x'" :size="24" /></span><b>{{ tcpState.data.open ? "端口开放" : "无法连接" }}</b><code>{{ tcpState.data.host }}:{{ tcpState.data.port }}</code><span v-if="tcpState.data.remoteAddress">解析地址 {{ tcpState.data.remoteAddress }}</span><span v-if="tcpState.data.error">{{ tcpState.data.error }}</span></div>
        <div v-else class="blank-state"><Icon name="activity" :size="24" /><span>TCP 端口检测结果</span></div>
      </div>
    </section>

    <section v-else-if="activeTab === 'path'" class="workspace task-workspace">
      <div class="query-bar path-bar">
        <div class="segmented"><button type="button" :class="{ on: pathMode === 'ping' }" @click="pathMode = 'ping'">Ping</button><button type="button" :class="{ on: pathMode === 'trace' }" @click="pathMode = 'trace'">路由跟踪</button></div>
        <label class="field grow"><span>主机名或 IP</span><input v-model="pathTarget" class="mono" placeholder="example.com" @keyup.enter="runPath" /></label>
        <label v-if="pathMode === 'ping'" class="field small-field"><span>次数</span><input v-model.number="pingCount" type="number" min="1" max="10" /></label>
        <label v-else class="field small-field"><span>最大跳数</span><input v-model.number="maxHops" type="number" min="1" max="30" /></label>
        <label class="field number-field"><span>等待（ms）</span><input v-model.number="pathTimeout" type="number" min="200" max="10000" step="100" /></label>
        <button class="btn-primary" type="button" :disabled="pathState.loading" @click="runPath"><Icon name="terminal" :size="15" />运行</button>
      </div>
      <div class="panel task-result terminal-result">
        <header class="panel-head"><b>{{ pathMode === 'ping' ? 'Ping 输出' : '路由跟踪输出' }}</b><span v-if="pathState.data">{{ pathState.data.durationMs }} ms</span></header>
        <div v-if="pathState.loading" class="loading-state"><span class="spinner"></span>正在运行</div>
        <div v-else-if="pathState.error" class="error-state"><Icon name="alert" :size="20" /><span>{{ pathState.error }}</span></div>
        <pre v-else-if="pathState.data" :class="{ failed: !pathState.data.success }">{{ pathState.data.output || "命令未返回文本" }}</pre>
        <div v-else class="blank-state"><Icon name="terminal" :size="24" /><span>系统网络命令输出</span></div>
      </div>
    </section>

    <section v-else-if="activeTab === 'local'" class="workspace task-workspace">
      <div class="local-bar"><div><b>网络接口</b><span v-if="localState.data?.hostname">{{ localState.data.hostname }}</span></div><button class="btn-ghost sm" type="button" :disabled="localState.loading" @click="loadInterfaces"><Icon name="refresh" :size="14" />刷新</button></div>
      <div class="panel task-result">
        <div v-if="localState.loading" class="loading-state"><span class="spinner"></span>正在读取</div>
        <div v-else-if="localState.error" class="error-state"><Icon name="alert" :size="20" /><span>{{ localState.error }}</span></div>
        <div v-else-if="localState.data" class="interface-list"><div v-for="(item, index) in localState.data.interfaces" :key="`${item.name}-${item.address}-${index}`" class="interface-row"><span class="interface-icon"><Icon name="network" :size="16" /></span><div><b :title="item.name">{{ item.name }}</b><code :title="item.address">{{ item.address }}</code></div><span class="type-chip">{{ item.family }}</span><span v-if="item.loopback" class="muted-chip">回环</span><button class="icon-btn xs" title="复制地址" @click="copyText(item.address, '地址')"><Icon name="copy" :size="13" /></button></div></div>
        <div v-else class="blank-state"><Icon name="network" :size="24" /><span>本机网络接口</span></div>
      </div>
    </section>

    <section v-else class="workspace ua-workspace">
      <section class="panel ua-input"><header class="panel-head"><b>User-Agent</b><button class="icon-btn xs" title="使用当前 User-Agent" @click="userAgentInput = navigator.userAgent"><Icon name="refresh" :size="13" /></button></header><textarea v-model="userAgentInput" class="text-editor mono" spellcheck="false" placeholder="粘贴 User-Agent 字符串"></textarea></section>
      <div class="ua-results"><div v-for="item in uaItems" :key="item[0]" class="ua-item"><span>{{ item[0] }}</span><b :title="item[1]">{{ item[1] }}</b></div></div>
    </section>
  </div>
</template>

<style scoped>
.network-tool { height: 100%; min-height: 0; display: flex; flex-direction: column; gap: var(--sp-3); }
.mode-tabs { flex-shrink: 0; display: flex; align-items: center; gap: var(--sp-1); overflow-x: auto; padding-bottom: var(--sp-1); border-bottom: 1px solid var(--border); }
.mode-tab { flex-shrink: 0; padding: var(--sp-2) var(--sp-4); border: 1px solid transparent; border-radius: var(--r-sm); background: transparent; color: var(--text-weak); font-size: var(--fs-md); cursor: pointer; transition: color 0.15s, background 0.15s, border-color 0.15s; }
.mode-tab:hover { color: var(--text); background: var(--ghost); }
.mode-tab.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.workspace { flex: 1; min-height: 0; }
.field { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.field > span { color: var(--text-weak); font-size: var(--fs-sm); font-weight: 600; }
.field input { min-width: 0; width: 100%; height: 34px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text); font-size: var(--fs-md); }
.field input:focus, .param-row input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field.grow { flex: 1; }
.field.wide { width: 100%; }
.mono, code, pre { font-family: var(--font-mono); }
.panel { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.panel-head { min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }
.panel-head b { font-size: var(--fs-md); }
.panel-head > span { margin-left: auto; color: var(--muted); font-family: var(--font-num); font-size: var(--fs-xs); }
.panel-head > button { margin-left: auto; }
.inline-error { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border-danger); border-radius: var(--r-sm); background: var(--danger-soft); color: var(--danger-deep); font-size: var(--fs-sm); }
.blank-state, .loading-state, .error-state { flex: 1; min-height: 150px; display: flex; align-items: center; justify-content: center; gap: var(--sp-2); color: var(--muted); font-size: var(--fs-sm); }
.blank-state svg { color: var(--faint); }
.error-state { padding: var(--sp-6); color: var(--danger-deep); text-align: center; }
.spinner { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--primary); border-radius: var(--r-pill); animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.url-workspace, .cidr-workspace, .task-workspace { display: flex; flex-direction: column; gap: var(--sp-3); }
.url-layout { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(260px, 0.8fr) minmax(340px, 1.2fr); gap: var(--sp-3); }
.detail-list { margin: 0; padding: var(--sp-2) var(--sp-4); }
.detail-list > div { display: grid; grid-template-columns: 86px minmax(0, 1fr); gap: var(--sp-3); align-items: center; min-height: 42px; border-bottom: 1px solid var(--border); }
.detail-list > div:last-child { border-bottom: none; }
.detail-list dt { color: var(--muted); font-size: var(--fs-sm); }
.detail-list dd { min-width: 0; margin: 0; overflow: hidden; color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }
.params-panel { display: flex; flex-direction: column; }
.param-list { flex: 1; min-height: 0; padding: var(--sp-3); overflow: auto; }
.param-row { display: grid; grid-template-columns: minmax(100px, 0.8fr) minmax(140px, 1.2fr) 24px; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.param-row input { min-width: 0; height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); outline: none; background: var(--card); color: var(--text-code); font-size: var(--fs-sm); }
.empty-line { margin: var(--sp-6) 0; color: var(--muted); font-size: var(--fs-sm); text-align: center; }
.result-strip { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: var(--sp-2); min-height: 42px; padding: 0 var(--sp-3); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); }
.result-strip code { overflow: hidden; color: var(--text-code); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }

.cidr-field { max-width: 480px; }
.stats-grid { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(4, minmax(130px, 1fr)); align-content: start; gap: var(--sp-3); overflow: auto; }
.stat-item, .ua-item { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-2); min-height: 82px; padding: var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }
.stat-item span, .ua-item span { color: var(--muted); font-size: var(--fs-sm); }
.stat-item b, .ua-item b { overflow: hidden; color: var(--text-code); font-family: var(--font-mono); font-size: var(--fs-base); text-overflow: ellipsis; white-space: nowrap; }
.binary-row { display: grid; grid-template-columns: auto minmax(0, 1fr) 24px; align-items: center; gap: var(--sp-3); min-height: 42px; padding: 0 var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); }
.binary-row > span { color: var(--muted); font-size: var(--fs-sm); }
.binary-row code { overflow: hidden; color: var(--text-code); font-size: var(--fs-sm); text-overflow: ellipsis; white-space: nowrap; }

.query-bar { flex-shrink: 0; display: flex; align-items: flex-end; gap: var(--sp-3); }
.query-bar > button { flex-shrink: 0; height: 34px; }
.number-field { width: 130px; }
.small-field { width: 80px; }
.task-result { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.address-list, .interface-list { flex: 1; min-height: 0; overflow: auto; }
.address-row { display: grid; grid-template-columns: 54px minmax(0, 1fr) 24px; align-items: center; gap: var(--sp-3); min-height: 46px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); }
.address-row code { overflow: hidden; color: var(--text-code); font-size: var(--fs-md); text-overflow: ellipsis; white-space: nowrap; }
.type-chip, .muted-chip { justify-self: start; padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--primary-soft); color: var(--primary-hover); font-family: var(--font-num); font-size: var(--fs-xs); white-space: nowrap; }
.muted-chip { background: var(--well); color: var(--muted); }
.tcp-result { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-6); color: var(--danger-deep); text-align: center; }
.tcp-result.open { color: var(--success-deep); }
.tcp-result .status-icon { width: 48px; height: 48px; display: grid; place-items: center; border-radius: var(--r-pill); background: var(--danger-soft); }
.tcp-result.open .status-icon { background: var(--success-soft); }
.tcp-result b { font-size: var(--fs-lg); }
.tcp-result code { color: var(--text-code); font-size: var(--fs-base); }
.tcp-result > span:not(.status-icon) { max-width: 600px; color: var(--muted); font-size: var(--fs-sm); word-break: break-word; }
.segmented { flex-shrink: 0; display: inline-grid; grid-template-columns: repeat(2, auto); padding: 2px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.segmented button { height: 30px; padding: 0 var(--sp-4); border: none; border-radius: var(--r-xs); background: transparent; color: var(--muted); font-size: var(--fs-sm); cursor: pointer; }
.segmented button.on { background: var(--card); color: var(--primary-hover); box-shadow: var(--shadow); font-weight: 600; }
.terminal-result pre { flex: 1; min-height: 0; margin: 0; padding: var(--sp-4); overflow: auto; background: var(--well); color: var(--success-deep); font-size: var(--fs-sm); line-height: var(--lh-body); white-space: pre-wrap; word-break: break-word; }
.terminal-result pre.failed { color: var(--danger-deep); }

.local-bar { display: flex; align-items: center; justify-content: space-between; min-height: 34px; }
.local-bar > div { display: flex; align-items: baseline; gap: var(--sp-3); }
.local-bar b { font-size: var(--fs-base); }
.local-bar span { color: var(--muted); font-family: var(--font-mono); font-size: var(--fs-sm); }
.interface-row { display: grid; grid-template-columns: 34px minmax(0, 1fr) auto auto 24px; align-items: center; gap: var(--sp-3); min-height: 58px; padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); }
.interface-icon { width: 30px; height: 30px; display: grid; place-items: center; border-radius: var(--r-xs); background: var(--primary-soft); color: var(--primary-hover); }
.interface-row > div { min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.interface-row b, .interface-row code { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.interface-row b { font-size: var(--fs-sm); }
.interface-row code { color: var(--text-code); font-size: var(--fs-sm); }

.ua-workspace { display: grid; grid-template-columns: minmax(280px, 0.8fr) minmax(360px, 1.2fr); gap: var(--sp-3); }
.ua-input { display: flex; flex-direction: column; }
.text-editor { flex: 1; min-height: 0; width: 100%; padding: var(--sp-4); resize: none; border: none; outline: none; background: transparent; color: var(--text-code); font-size: var(--fs-md); line-height: var(--lh-body); }
.ua-results { min-height: 0; display: grid; grid-template-columns: repeat(2, minmax(140px, 1fr)); align-content: start; gap: var(--sp-3); overflow: auto; }

@media (max-width: 820px) {
  .url-layout, .ua-workspace { grid-template-columns: 1fr; grid-template-rows: minmax(180px, 0.8fr) minmax(220px, 1.2fr); overflow: auto; }
  .stats-grid { grid-template-columns: repeat(2, minmax(130px, 1fr)); }
  .query-bar { flex-wrap: wrap; }
  .query-bar .grow { flex-basis: 100%; }
  .path-bar .grow { order: -1; }
}
</style>
