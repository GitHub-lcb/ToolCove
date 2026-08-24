<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, inject } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  METHODS, splitUrl, buildUrl, headersToPairs, findHeader,
  detectBodyLang, prettyBody, sizeText, statusClass, parseCurl,
  envVarsToMap, substituteVars, formEncode,
  dispositionName, suggestFileName, describeContentType,
} from "./request.js";
import { formatJson } from "./json.js";
import { highlightLines } from "./jsonHighlight.js";
import { relativeTime } from "../shared.js";
import { loadToolbox, saveToolbox, flushToolbox } from "../toolboxStore.js";
import {
  loadSecureToolbox, saveSecureToolbox, flushSecureToolbox,
  protectRequestState, restoreRequestState,
  protectRequestHistory, restoreRequestHistory,
  protectRequestCollections, restoreRequestCollections,
  protectRequestEnvs, restoreRequestEnvs,
} from "../secureToolbox.js";
import Icon from "../Icon.vue";
import ReqCollectionsSide from "./ReqCollectionsSide.vue";
import ReqResponsePanel from "./ReqResponsePanel.vue";
import ReqEnvDialog from "./ReqEnvDialog.vue";
import { askConfirm } from "../confirm.js";
import { useI18n } from "vue-i18n";

const { t } = useI18n();

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  openInJson: { type: Function, default: null },
});

const SAVED_KEY = "toolbox-request-saved"; // 旧版扁平收藏（localStorage 遗留），仅用于迁移
const HIST_MAX = 12;
const HL_MAX = 150 * 1024;
const isTauri = !!window.__TAURI_INTERNALS__;

const BODY_TYPES = [
  { key: "none", labelKey: "bodyNone" },
  { key: "json", labelKey: "bodyJson" },
  { key: "text", labelKey: "bodyTextLabel" },
  { key: "form", labelKey: "bodyFormLabel" },
];

// ---------- 多请求页（标签） ----------
const TAB_MAX = 12;
const EMPTY_ROW = () => [{ key: "", value: "", on: true }];
// 每个标签一份独立请求配置 + 响应状态；运行时字段（query/response/loading）不持久化
const tabs = ref([]);
const activeTabId = ref("");
let internalUrl = false; // 防 URL↔参数 同步死循环

const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) || null);
function createTab(init) {
  init = init || {};
  return {
    id: init.id || "t" + Date.now() + Math.random().toString(16).slice(2, 6),
    name: typeof init.name === "string" ? init.name : "",
    method: METHODS.includes(init.method) ? init.method : "GET",
    url: typeof init.url === "string" ? init.url : "",
    headers: Array.isArray(init.headers) && init.headers.length ? init.headers : EMPTY_ROW(),
    bodyType: BODY_TYPES.some((b) => b.key === init.bodyType) ? init.bodyType : "none",
    bodyText: typeof init.bodyText === "string" ? init.bodyText : "",
    bodyForm: Array.isArray(init.bodyForm) && init.bodyForm.length ? init.bodyForm : EMPTY_ROW(),
    reqTab: ["params", "headers", "body"].includes(init.reqTab) ? init.reqTab : "params",
    respTab: init.respTab === "headers" ? "headers" : "body",
    respPretty: init.respPretty !== false,
    savedId: typeof init.savedId === "string" ? init.savedId : "", // 关联的集合请求 id
    // 运行时（不持久化）
    query: [],
    response: null, respError: "", loading: false,
  };
}
function newTab() {
  if (tabs.value.length >= TAB_MAX) return props.showToast(t("toolbox.request.tabMax", { max: TAB_MAX }));
  const tab = createTab();
  syncQueryFromUrl(tab);
  tabs.value.push(tab);
  activeTabId.value = tab.id;
  return tab;
}

// 当前标签的请求配置 / 响应状态（computed 代理，模板与旧逻辑读写方式不变）
function proxyState(get, set) {
  return computed({
    get: () => (activeTab.value ? get(activeTab.value) : null),
    set: (v) => { if (activeTab.value) set(activeTab.value, v); },
  });
}
const method = proxyState((t) => t.method, (t, v) => { t.method = v; });
const url = proxyState((t) => t.url, (t, v) => { t.url = v; });
const query = proxyState((t) => t.query, (t, v) => { t.query = v; });
const headers = proxyState((t) => t.headers, (t, v) => { t.headers = v; });
const bodyType = proxyState((t) => t.bodyType, (t, v) => { t.bodyType = v; });
const bodyText = proxyState((t) => t.bodyText, (t, v) => { t.bodyText = v; });
const bodyForm = proxyState((t) => t.bodyForm, (t, v) => { t.bodyForm = v; });
const reqTab = proxyState((t) => t.reqTab, (t, v) => { t.reqTab = v; });
const response = proxyState((t) => t.response, (t, v) => { t.response = v; });
const respError = proxyState((t) => t.respError, (t, v) => { t.respError = v; });
const loading = proxyState((t) => t.loading, (t, v) => { t.loading = v; });
const respTab = proxyState((t) => t.respTab, (t, v) => { t.respTab = v; });
const respPretty = proxyState((t) => t.respPretty, (t, v) => { t.respPretty = v; });

// ---------- 历史 / 集合 / 环境 ----------
const history = ref([]); // [{...snapshot, ts}]
const collections = ref([]); // [{ id, name, open, requests: [{id,name,...snapshot}] }]
const envs = ref([]); // [{ id, name, vars: [{key,value,on}] }]
const activeEnvId = ref(""); // "" = 不使用环境

// ---------- 弹窗 ----------
const curlOpen = ref(false);
const curlText = ref("");
const CURL_PH = t("toolbox.request.curlPh");
const curlInputRef = ref(null);
const saveOpen = ref(false);
const saveName = ref("");
const saveCollId = ref("");
const saveInputRef = ref(null);
const collOpen = ref(false);
const collName = ref("");
const collInputRef = ref(null);
const envOpen = ref(false);
const importRef = ref(null);

// ---------- 初始化（数据资产化：走 load_data/save_data 落盘 AppData，旧 localStorage 数据自动迁移） ----------
// 首帧先放一个空标签保证界面不空（ready=false 期间 persistTabs 不写盘，避免占位覆盖真实数据），
// 异步恢复完成后替换为真实状态并放开持久化。
let ready = false; // 状态恢复完成前禁止写盘
tabs.value = [createTab()];
activeTabId.value = tabs.value[0].id;
onMounted(async () => {
  try {
    await loadState();
    await loadHistory();
    await loadCollections();
    await loadEnvs();
    ready = true;
    // 兼容旧明文资产：成功读出后立即按新规则重写为 DPAPI 密文。
    persistTabs();
    persistHistory();
    persistCollections();
    persistEnvs();
  } catch (e) {
    props.showToast(t("toolbox.request.loadSecureFail", { error: e }));
    return;
  }
});
onBeforeUnmount(async () => {
  await flushSecureToolbox();
  flushToolbox(); // 卸载前冲刷全部待写数据，避免视图切换丢失
});

async function loadState() {
  const s = await loadSecureToolbox("request", null, restoreRequestState);
  if (s && Array.isArray(s.tabs) && s.tabs.length) {
    tabs.value = s.tabs.map(createTab);
  } else {
    // 旧版单请求快照 → 迁移为单个标签
    tabs.value = [createTab({
      method: s?.method, url: s?.url, headers: s?.headers,
      bodyType: s?.bodyType, bodyText: s?.bodyText, bodyForm: s?.bodyForm,
    })];
  }
  tabs.value.forEach((t) => { syncQueryFromUrl(t); ensureTrailingHeaderOf(t); ensureTrailingFormOf(t); });
  activeTabId.value = tabs.value.some((t) => t.id === s?.activeId) ? s.activeId : tabs.value[0].id;
}

async function loadHistory() {
  const h = await loadSecureToolbox("request-history", [], restoreRequestHistory);
  if (Array.isArray(h)) history.value = h.slice(0, HIST_MAX);
}
async function loadCollections() {
  let colls = null;
  colls = await loadSecureToolbox("request-collections", null, restoreRequestCollections);
  if (!Array.isArray(colls)) {
    // 从旧版扁平收藏迁移为「默认集合」（toolbox-request-saved 为 localStorage 遗留，迁移后清除）
    let legacy = [];
    try { legacy = JSON.parse(localStorage.getItem(SAVED_KEY) || "[]"); } catch { legacy = []; }
    colls = (Array.isArray(legacy) && legacy.length)
      ? [{ id: "c" + Date.now(), name: t("toolbox.request.collDefaultName"), open: true, requests: legacy.map(normalizeRequest) }]
      : [];
    if (colls.length) persistCollectionsRaw(colls);
    if (legacy.length) { try { localStorage.removeItem(SAVED_KEY); } catch { /* 忽略 */ } }
  }
  collections.value = colls.map(normalizeCollection);
}
async function loadEnvs() {
  const e = await loadSecureToolbox("request-envs", [], restoreRequestEnvs);
  if (Array.isArray(e)) envs.value = e.map(normalizeEnv);
  const active = await loadToolbox("request-env-active", "");
  if (envs.value.some((en) => en.id === active)) activeEnvId.value = active;
}

// ---------- 归一化（导入/迁移的数据可能缺字段） ----------
function rid(p) { return p + Date.now() + Math.random().toString(16).slice(2, 6); }
function normalizeRequest(r) {
  r = r || {};
  return {
    id: r.id || rid("r"),
    name: r.name || t("toolbox.request.reqUnnamed"),
    method: METHODS.includes(r.method) ? r.method : "GET",
    url: typeof r.url === "string" ? r.url : "",
    headers: Array.isArray(r.headers) ? r.headers : [],
    bodyType: BODY_TYPES.some((b) => b.key === r.bodyType) ? r.bodyType : "none",
    bodyText: typeof r.bodyText === "string" ? r.bodyText : "",
    bodyForm: Array.isArray(r.bodyForm) ? r.bodyForm : [],
  };
}
function normalizeCollection(c) {
  c = c || {};
  return {
    id: c.id || rid("c"),
    name: c.name || t("toolbox.request.collUnnamed"),
    open: c.open !== false,
    requests: Array.isArray(c.requests) ? c.requests.map(normalizeRequest) : [],
  };
}
function normalizeEnv(e) {
  e = e || {};
  const vars = Array.isArray(e.vars) ? e.vars.filter((v) => v && typeof v.key === "string") : [];
  return {
    id: e.id || rid("e"),
    name: e.name || t("toolbox.request.envUnnamed"),
    vars: vars.length
      ? vars.map((v) => ({ key: v.key, value: String(v.value ?? ""), on: v.on !== false }))
      : [{ key: "", value: "", on: true }],
  };
}

// 持久化所有标签的请求配置（不含运行时 response / loading，避免写入大响应；防抖合并高频写入）
watch(tabs, persistTabs, { deep: true });
function persistTabs() {
  if (!ready) return; // 状态恢复完成前不写盘（首帧占位标签不落盘）
  const payload = {
    version: 2,
    activeId: activeTabId.value,
    tabs: tabs.value.map((t) => ({
      id: t.id, name: t.name, savedId: t.savedId,
      method: t.method, url: t.url, headers: t.headers,
      bodyType: t.bodyType, bodyText: t.bodyText, bodyForm: t.bodyForm,
      reqTab: t.reqTab, respTab: t.respTab, respPretty: t.respPretty,
    })),
  };
  saveSecureToolbox("request", payload, protectRequestState, secureSaveError);
}

function secureSaveError(e) {
  props.showToast(t("toolbox.request.secureSaveFail", { error: e }));
}

// ---------- URL ↔ 查询参数 双向同步 ----------
watch(url, () => {
  if (!internalUrl) { const t = activeTab.value; if (t) syncQueryFromUrl(t); }
});
function syncQueryFromUrl(t) {
  const rows = splitUrl(t.url).query;
  rows.push({ key: "", value: "", on: true }); // 末尾留空行供录入
  t.query = rows;
}
function rebuildUrl() {
  const t = activeTab.value;
  if (!t) return;
  const base = splitUrl(t.url).base;
  internalUrl = true;
  t.url = buildUrl(base, t.query);
  nextTick(() => { internalUrl = false; });
}
function onQueryEdit() { ensureTrailingQuery(); rebuildUrl(); }
function ensureTrailingQuery() {
  const t = activeTab.value;
  if (!t) return;
  const q = t.query; const last = q[q.length - 1];
  if (!last || last.key.trim() !== "" || String(last.value).trim() !== "") q.push({ key: "", value: "", on: true });
}
function removeQuery(i) {
  const t = activeTab.value;
  if (!t) return;
  t.query.splice(i, 1);
  ensureTrailingQuery();
  rebuildUrl();
}

// ---------- 请求头 ----------
function ensureTrailingHeaderOf(t) {
  const h = t.headers; const last = h[h.length - 1];
  if (!last || last.key.trim() !== "" || String(last.value).trim() !== "") h.push({ key: "", value: "", on: true });
}
function ensureTrailingHeader() { const t = activeTab.value; if (t) ensureTrailingHeaderOf(t); }
function onHeaderEdit() { ensureTrailingHeader(); }
function removeHeader(i) {
  const t = activeTab.value;
  if (!t) return;
  t.headers.splice(i, 1);
  ensureTrailingHeaderOf(t);
}

// ---------- Form 表单 ----------
function ensureTrailingFormOf(t) {
  const f = t.bodyForm; const last = f[f.length - 1];
  if (!last || last.key.trim() !== "" || String(last.value).trim() !== "") f.push({ key: "", value: "", on: true });
}
function ensureTrailingForm() { const t = activeTab.value; if (t) ensureTrailingFormOf(t); }
function onFormEdit() { ensureTrailingForm(); }
function removeForm(i) {
  const t = activeTab.value;
  if (!t) return;
  t.bodyForm.splice(i, 1);
  ensureTrailingFormOf(t);
}

const activeQueryCount = computed(() => (activeTab.value ? activeTab.value.query.filter((q) => q.on !== false && q.key.trim()).length : 0));
const activeHeaderCount = computed(() => (activeTab.value ? activeTab.value.headers.filter((h) => h.on !== false && h.key.trim()).length : 0));
const bodyRawOf = (t) => (t.bodyType === "form" ? formEncode(t.bodyForm) : t.bodyText);
const hasBodyOf = (t) => t.bodyType !== "none" && bodyRawOf(t).trim() !== "" && !["GET", "HEAD"].includes(t.method);
const bodyRaw = computed(() => (activeTab.value ? bodyRawOf(activeTab.value) : ""));
const hasBody = computed(() => (activeTab.value ? hasBodyOf(activeTab.value) : false));
const bodyPlaceholder = computed(() => {
  if (bodyType.value === "json") return '{\n  "key": "value"\n}';
  if (bodyType.value === "text") return t("toolbox.request.bodyTextPh");
  return "";
});

// ---------- 环境变量 ----------
const activeEnv = computed(() => envs.value.find((e) => e.id === activeEnvId.value) || null);
const envMap = computed(() => (activeEnv.value ? envVarsToMap(activeEnv.value.vars) : {}));
watch(activeEnvId, () => {
  saveToolbox("request-env-active", activeEnvId.value || "");
});

// ---------- 发送 ----------
function autoContentType(t) {
  if (t.bodyType === "json") return "application/json";
  if (t.bodyType === "form") return "application/x-www-form-urlencoded";
  if (t.bodyType === "text") return "text/plain";
  return "";
}
async function send() {
  const tab = activeTab.value;
  if (!tab || tab.loading) return;
  const map = envMap.value;
  const target = substituteVars(tab.url.trim(), map);
  if (!target) return props.showToast(t("toolbox.request.urlRequired"));
  if (!/^https?:\/\//i.test(target)) return props.showToast(t("toolbox.request.urlScheme"));

  const pairs = headersToPairs(tab.headers).map(([k, v]) => [substituteVars(k, map), substituteVars(v, map)]);
  const ct = autoContentType(tab);
  if (hasBodyOf(tab) && ct && !findHeader(pairs, "content-type")) pairs.push(["Content-Type", ct]);
  const sendBody = hasBodyOf(tab) ? substituteVars(bodyRawOf(tab), map) : null;

  tab.loading = true;
  tab.respError = "";
  try {
    let res;
    if (isTauri) {
      res = await invoke("http_request", {
        method: tab.method, url: target, headers: pairs, body: sendBody, timeoutMs: 30000,
      });
    } else {
      res = await browserFetch(tab.method, target, pairs, sendBody);
    }
    tab.response = res;
    tab.respTab = "body";
    pushHistory(tab);
  } catch (e) {
    tab.response = null;
    tab.respError = e && e.message ? e.message : String(e);
    props.showToast(t("toolbox.request.sendFail", { error: tab.respError }));
  } finally {
    tab.loading = false;
  }
}

// 非 Tauri（dev 预览）降级：浏览器 fetch，可能受 CORS 限制
async function browserFetch(m, target, pairs, body) {
  const t0 = performance.now();
  const headersObj = {};
  pairs.forEach(([k, v]) => { headersObj[k] = v; });
  const resp = await fetch(target, {
    method: m, headers: headersObj,
    body: ["GET", "HEAD"].includes(m) ? undefined : body ?? undefined,
  });
  const text = await resp.text();
  const rh = [];
  resp.headers.forEach((v, k) => rh.push([k, v]));
  return {
    status: resp.status, statusText: resp.statusText, headers: rh,
    body: text, durationMs: Math.round(performance.now() - t0),
    size: new TextEncoder().encode(text).length,
  };
}

// ---------- 响应展示 ----------
const respContentType = computed(() => (response.value ? findHeader(response.value.headers, "content-type") : ""));
const respLang = computed(() => (response.value ? detectBodyLang(respContentType.value, response.value.body) : "text"));
const respBodyPretty = computed(() => {
  if (!response.value) return "";
  return respPretty.value ? prettyBody(response.value.body, respLang.value) : response.value.body;
});
const respLines = computed(() => {
  const b = respBodyPretty.value;
  if (respLang.value !== "json" || !respPretty.value || !b || b.length > HL_MAX) return null;
  return highlightLines(b);
});
const respStatusClass = computed(() => (response.value ? statusClass(response.value.status) : "other"));
const respSizeText = computed(() => (response.value ? sizeText(response.value.size) : ""));
const respIsJson = computed(() => respLang.value === "json" && !!respBodyPretty.value);
// 文件流（二进制）响应：Rust 侧非 UTF-8 时附带 bodyBase64，可原样保存为文件
const respIsBinary = computed(() => !!response.value?.bodyBase64);
const respKindLabel = computed(() => (response.value ? describeContentType(findHeader(response.value.headers, "content-type")) : ""));
const respFileName = computed(() => {
  const t = activeTab.value;
  return t?.response ? suggestFileName(t.response.headers, t.url) : "";
});

async function copyResp() {
  if (!response.value) return;
  try {
    await navigator.clipboard.writeText(respBodyPretty.value);
    props.showToast(t("toolbox.request.copied"));
  } catch (e) { props.showToast(t("toolbox.request.copyFail", { error: e })); }
}

// 保存响应为本地文件：二进制走 base64 原样落盘，文本走 UTF-8 直写
async function saveResponse() {
  const t = activeTab.value;
  if (!t || !t.response) return props.showToast(t("toolbox.request.sendFirst"));
  const res = t.response;
  const isBin = !!res.bodyBase64;
  const name = suggestFileName(res.headers, t.url);
  if (!isTauri) {
    // 浏览器预览降级：文本用 Blob 触发下载；文件流无法还原原始字节
    if (isBin) return props.showToast(t("toolbox.request.binDesktopOnly"));
    blobDownload(res.body, name);
    return props.showToast(t("toolbox.request.downloadStart", { name }));
  }
  const path = await saveDialog({ title: t("toolbox.request.saveRespTitle"), defaultPath: name });
  if (!path) return; // 用户取消
  try {
    if (isBin) {
      await invoke("export_file_b64", { path, contentB64: res.bodyBase64 });
    } else {
      await invoke("export_file", { path, content: res.body });
    }
    props.showToast(t("toolbox.request.savedSize", { size: sizeText(res.size) }));
  } catch (e) {
    props.showToast(t("toolbox.request.saveFail", { error: (e && e.message) ? e.message : e }));
  }
}
function blobDownload(text, name) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(a.href);
}

// ---------- 请求体：美化 / 跳 JSON 工具 ----------
function beautifyBody() {
  const r = formatJson(bodyText.value, 2);
  if (r.ok) { bodyText.value = r.output; props.showToast(t("toolbox.request.formattedJson")); }
  else props.showToast(t("toolbox.request.jsonInvalid", { line: (r.error && r.error.line) ? t("toolbox.request.atLine", { line: r.error.line }) : "" }));
}
function jumpReqToJson() {
  if (!props.openInJson) return;
  if (!bodyText.value.trim()) return props.showToast(t("toolbox.request.bodyEmpty"));
  props.openInJson(bodyText.value);
}
function jumpRespToJson() {
  if (!props.openInJson || !response.value) return;
  props.openInJson(respBodyPretty.value);
}

// ---------- 历史 ----------
function snapshot(t) {
  return {
    method: t.method, url: t.url,
    headers: JSON.parse(JSON.stringify(t.headers)),
    bodyType: t.bodyType, bodyText: t.bodyText,
    bodyForm: JSON.parse(JSON.stringify(t.bodyForm)),
  };
}
function pushHistory(t) {
  const item = { ...snapshot(t), ts: Date.now() };
  history.value = [item, ...history.value.filter((h) => !(h.method === item.method && h.url === item.url))].slice(0, HIST_MAX);
  persistHistory();
}
function persistHistory() { saveSecureToolbox("request-history", history.value, protectRequestHistory, secureSaveError); }
function restoreHistory(h) { applySnapshot(activeTab.value, h); props.showToast(t("toolbox.request.histRestored")); }
function clearHistory() {
  history.value = [];
  histQuery.value = "";
  persistHistory();
}

// 历史搜索：按 URL（含查询串）大小写不敏感过滤
const histQuery = ref("");
const filteredHistory = computed(() => {
  const q = histQuery.value.trim().toLowerCase();
  if (!q) return history.value;
  return history.value.filter((h) => String(h.url || "").toLowerCase().includes(q));
});
function applySnapshot(t, s) {
  if (!t) return;
  t.method = METHODS.includes(s.method) ? s.method : "GET";
  t.url = s.url || "";
  syncQueryFromUrl(t);
  t.headers = (s.headers && s.headers.length) ? JSON.parse(JSON.stringify(s.headers)) : EMPTY_ROW();
  ensureTrailingHeaderOf(t);
  t.bodyType = s.bodyType || "none";
  t.bodyText = s.bodyText || "";
  t.bodyForm = (s.bodyForm && s.bodyForm.length) ? JSON.parse(JSON.stringify(s.bodyForm)) : EMPTY_ROW();
  ensureTrailingFormOf(t);
  t.response = null;
  t.respError = "";
}

// ---------- 集合 ----------
function persistCollectionsRaw(colls) {
  saveSecureToolbox("request-collections", colls, protectRequestCollections, secureSaveError);
}
function persistCollections() { persistCollectionsRaw(collections.value); }
function persistEnvs() {
  saveSecureToolbox("request-envs", envs.value, protectRequestEnvs, secureSaveError);
}

function deriveName(t) { return splitUrl(t.url).base.split("/").filter(Boolean).pop() || t("toolbox.request.reqNewName"); }

function openCollDialog() {
  collName.value = "";
  collOpen.value = true;
  nextTick(() => collInputRef.value?.focus());
}
function confirmColl() {
  const name = collName.value.trim() || t("toolbox.request.collNewName");
  collections.value.push({ id: "c" + Date.now(), name, open: true, requests: [] });
  persistCollections();
  collOpen.value = false;
  props.showToast(t("toolbox.request.collCreated"));
}
function toggleColl(c) { c.open = !c.open; persistCollections(); }
function removeCollection(c) {
  collections.value = collections.value.filter((x) => x.id !== c.id);
  persistCollections();
}

function openSaveDialog(collId) {
  const t = activeTab.value;
  if (!t || !t.url.trim()) return props.showToast(t("toolbox.request.urlRequired"));
  saveName.value = deriveName(t);
  if (collId) saveCollId.value = collId;
  else if (!collections.value.some((c) => c.id === saveCollId.value)) saveCollId.value = collections.value[0]?.id || "";
  saveOpen.value = true;
  nextTick(() => saveInputRef.value?.focus());
}
function confirmSave() {
  const name = saveName.value.trim();
  if (!name) return props.showToast(t("toolbox.request.nameRequired"));
  let collId = saveCollId.value;
  if (!collId || !collections.value.some((c) => c.id === collId)) {
    const c = { id: "c" + Date.now(), name: t("toolbox.request.collDefaultName"), open: true, requests: [] };
    collections.value.push(c);
    collId = c.id;
  }
  const coll = collections.value.find((c) => c.id === collId);
  const item = { id: "r" + Date.now(), name, ...snapshot(activeTab.value) };
  coll.requests.unshift(item);
  coll.open = true;
  const curTab = activeTab.value;
  if (curTab) {
    curTab.savedId = item.id;
    if (!curTab.name.trim()) curTab.name = name; // 未起名时标签跟随集合请求名
  }
  persistCollections();
  saveOpen.value = false;
  props.showToast(t("toolbox.request.savedTo", { name: coll.name }));
}
function loadRequest(r) {
  const cur = activeTab.value;
  // 当前标签是空白草稿则直接填充，否则新开标签避免覆盖正在编辑的内容
  const tab = (cur && !cur.url.trim() && !cur.response) ? cur : newTab();
  if (!tab) return;
  applySnapshot(tab, r);
  tab.savedId = r.id;
}
function removeRequest(c, r) {
  c.requests = c.requests.filter((x) => x.id !== r.id);
  tabs.value.forEach((t) => { if (t.savedId === r.id) t.savedId = ""; });
  persistCollections();
}
const totalRequests = computed(() => collections.value.reduce((n, c) => n + c.requests.length, 0));
const tabSavedId = computed(() => activeTab.value?.savedId ?? "");

// ---------- 环境变量管理 ----------
function openEnvPanel() { envOpen.value = true; }
function addEnv() {
  const en = { id: "e" + Date.now(), name: t("toolbox.request.envNewName"), vars: [{ key: "", value: "", on: true }] };
  envs.value.push(en);
  if (!activeEnvId.value) activeEnvId.value = en.id;
  persistEnvs();
}
function removeEnv(en) {
  envs.value = envs.value.filter((x) => x.id !== en.id);
  if (activeEnvId.value === en.id) activeEnvId.value = "";
  persistEnvs();
}
function ensureTrailingVar(en) {
  const vs = en.vars; const last = vs[vs.length - 1];
  if (!last || last.key.trim() !== "" || String(last.value).trim() !== "") vs.push({ key: "", value: "", on: true });
}
function onVarEdit(en) { ensureTrailingVar(en); persistEnvs(); }
function removeVar(en, i) { en.vars.splice(i, 1); ensureTrailingVar(en); persistEnvs(); }
function useEnv(en) { activeEnvId.value = activeEnvId.value === en.id ? "" : en.id; }

// ---------- 导入 / 导出 ----------
async function exportData() {
  const ok = await askConfirm({
    title: t("toolbox.request.exportTitle"),
    message: t("toolbox.request.exportMsg"),
    okText: t("toolbox.request.exportOk"),
    danger: false,
  });
  if (!ok) return;
  const data = { app: "toolcove-request", version: 1, exportedAt: new Date().toISOString(), collections: collections.value, envs: envs.value };
  try {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "request-tool-export.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    props.showToast(t("toolbox.request.exported"));
  } catch (e) { props.showToast(t("toolbox.request.exportFail", { error: e })); }
}
function triggerImport() { importRef.value?.click(); }
function onImportFile(e) {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(String(reader.result || "{}"));
      let addedC = 0, addedE = 0;
      if (Array.isArray(data.collections)) {
        for (const c of data.collections) {
          collections.value.push(normalizeCollection({ ...c, id: undefined, requests: (c.requests || []).map((r) => ({ ...r, id: undefined })) }));
          addedC++;
        }
        persistCollections();
      }
      if (Array.isArray(data.envs)) {
        for (const en of data.envs) { envs.value.push(normalizeEnv({ ...en, id: undefined })); addedE++; }
        persistEnvs();
      }
      if (!addedC && !addedE) props.showToast(t("toolbox.request.importEmpty"));
      else props.showToast(t("toolbox.request.imported", { collections: addedC, envs: addedE }));
    } catch { props.showToast(t("toolbox.request.importBad")); }
  };
  reader.readAsText(file);
  e.target.value = "";
}

// ---------- cURL 导入 ----------
function toggleCurl() {
  curlOpen.value = !curlOpen.value;
  if (curlOpen.value) nextTick(() => curlInputRef.value?.focus());
}
function importCurl() {
  const t = activeTab.value;
  if (!t) return;
  try {
    const r = parseCurl(curlText.value);
    t.method = r.method;
    t.url = r.url;
    syncQueryFromUrl(t);
    t.headers = r.headers.length ? r.headers.map((h) => ({ ...h })) : [];
    ensureTrailingHeaderOf(t);
    if (r.body) {
      t.bodyText = r.body;
      t.bodyType = r.body.trim().startsWith("{") || r.body.trim().startsWith("[") ? "json" : "text";
      t.reqTab = "body";
    } else {
      t.bodyType = "none";
    }
    curlOpen.value = false;
    curlText.value = "";
    props.showToast(t("toolbox.request.curlImported"));
  } catch (e) {
    props.showToast(e && e.message ? e.message : String(e));
  }
}

// ---------- 标签页管理 ----------
const renameId = ref("");
const renameText = ref("");
const renameInputRef = ref(null);
function tabLabel(t) {
  if (t.name.trim()) return t.name;
  const seg = splitUrl(t.url).base.split("/").filter(Boolean).pop();
  return seg || t("toolbox.request.reqNewName");
}
function closeTab(id) {
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i < 0) return;
  tabs.value.splice(i, 1);
  if (!tabs.value.length) { // 至少保留一个空标签
    const tab = createTab();
    syncQueryFromUrl(tab);
    tabs.value.push(tab);
  }
  if (activeTabId.value === id) {
    const idx = Math.min(i, tabs.value.length - 1);
    activeTabId.value = tabs.value[idx].id;
  }
  if (renameId.value === id) renameId.value = "";
}
function startRename(t) {
  renameId.value = t.id;
  renameText.value = t.name;
  nextTick(() => renameInputRef.value?.focus());
}
function commitRename() {
  const t = tabs.value.find((x) => x.id === renameId.value);
  if (t) t.name = renameText.value.trim();
  renameId.value = "";
}

// 标签右键菜单：关闭 / 关闭左侧 / 关闭右侧 / 全部关闭（走 App.vue 全局 openCtxMenu，z 400 分层）
const openCtxMenu = inject("openCtxMenu");
function openCtx(e, t) {
  const isFirst = t.id === tabs.value[0]?.id;
  const isLast = t.id === tabs.value[tabs.value.length - 1]?.id;
  openCtxMenu(e, [
    { label: t("toolbox.request.closeTab"), icon: "x", fn: () => closeTab(t.id) },
    // 首/尾标签无左/右侧可关，直接不出菜单项（全局菜单无禁用态）
    ...(isFirst ? [] : [{ label: t("toolbox.request.closeLeft"), icon: "minus", fn: () => closeLeft(t.id) }]),
    ...(isLast ? [] : [{ label: t("toolbox.request.closeRight"), icon: "minus", fn: () => closeRight(t.id) }]),
    { label: t("toolbox.request.closeAll"), icon: "trash", danger: true, fn: closeAll },
  ]);
}
function closeLeft(id) {
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i <= 0) return;
  tabs.value.splice(0, i);
  activeTabId.value = id;
}
function closeRight(id) {
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i < 0 || i >= tabs.value.length - 1) return;
  tabs.value.splice(i + 1);
  activeTabId.value = id;
}
function closeAll() {
  const tab = createTab();
  syncQueryFromUrl(tab);
  tabs.value = [tab];
  activeTabId.value = tab.id;
  renameId.value = "";
}

function methodClass(m) { return "m-" + String(m).toLowerCase(); }

// 字面量 {{变量}} - 直接写在模板插值里会被 Vue 编译器误当作嵌套插值；语法示例跟随界面语言
const VAR_SYNTAX = computed(() => "{{" + t("toolbox.request.varToken") + "}}");
const VAR_NAME_SYNTAX = computed(() => "{{" + t("toolbox.request.varTokenName") + "}}");
</script>

<template>
  <div class="req-tool">
    <!-- 左：集合树（详见 ReqCollectionsSide） -->
    <ReqCollectionsSide
      :collections="collections"
      :tab-saved-id="tabSavedId"
      :total-requests="totalRequests"
      :method-class="methodClass"
      @new-collection="openCollDialog"
      @toggle-coll="toggleColl"
      @save-dialog="openSaveDialog"
      @remove-collection="removeCollection"
      @load-request="loadRequest"
      @remove-request="removeRequest"
    />

    <!-- 中：请求 / 响应 -->
    <section class="col-main">
      <!-- 多请求页标签栏 -->
      <div class="tab-bar">
        <div
          v-for="t in tabs"
          :key="t.id"
          class="tab"
          :class="{ on: t.id === activeTabId }"
          :title="t.url"
          @click="activeTabId = t.id"
          @dblclick="startRename(t)"
          @contextmenu.prevent="openCtx($event, t)"
        >
          <span class="mtag" :class="methodClass(t.method)">{{ t.method }}</span>
          <input
            v-if="renameId === t.id"
            ref="renameInputRef"
            v-model="renameText"
            class="tab-name-input"
            spellcheck="false"
            @click.stop
            @keyup.enter="commitRename"
            @keyup.esc="renameId = ''"
            @blur="commitRename"
          />
          <span v-else class="tab-name">{{ tabLabel(t) }}</span>
          <span v-if="t.loading" class="tab-spin" :title="t('toolbox.request.loading')"></span>
          <button class="tab-close" :title="t('toolbox.request.closeTab')" @click.stop="closeTab(t.id)"><Icon name="x" :size="11" /></button>
        </div>
        <button class="tab-add" :title="t('toolbox.request.newTab')" @click="newTab"><Icon name="plus" :size="14" /></button>
      </div>

      <!-- 环境 + 导入导出 工具条 -->
      <div class="env-bar">
        <div class="env-pick">
          <Icon name="layers" :size="14" class="env-ico" />
          <select v-model="activeEnvId" class="env-sel">
            <option value="">{{ t("toolbox.request.noEnv") }}</option>
            <option v-for="en in envs" :key="en.id" :value="en.id">{{ en.name }}</option>
          </select>
        </div>
        <button class="env-manage" @click="openEnvPanel">
          <Icon name="settings" :size="14" />{{ t("toolbox.request.envTitle") }}<span v-if="envs.length" class="env-badge">{{ envs.length }}</span>
        </button>
        <span class="spacer"></span>
        <button class="io-btn" @click="triggerImport"><Icon name="download" :size="14" />{{ t("toolbox.request.import") }}</button>
        <button class="io-btn" @click="exportData"><Icon name="open" :size="14" />{{ t("toolbox.request.export") }}</button>
        <input ref="importRef" type="file" accept="application/json,.json" class="hidden-file" @change="onImportFile" />
      </div>

      <!-- URL 行 -->
      <div class="url-bar">
        <select v-model="method" class="method-sel" :class="methodClass(method)">
          <option v-for="m in METHODS" :key="m" :value="m">{{ m }}</option>
        </select>
        <input
          v-model="url"
          class="url-input"
          spellcheck="false"
          :placeholder="t('toolbox.request.urlPh', { host: '{{host}}', syntax: VAR_SYNTAX })"
          @keyup.enter="send"
        />
        <button class="send-btn" :disabled="loading" @click="send">
          <Icon name="send" :size="14" />{{ loading ? t("toolbox.request.loading") : t("toolbox.request.send") }}
        </button>
      </div>

      <!-- 请求配置 tabs -->
      <div class="req-tabs">
        <button class="rt" :class="{ on: reqTab === 'params' }" @click="reqTab = 'params'">{{ t("toolbox.request.params") }}<span v-if="activeQueryCount" class="dot">{{ activeQueryCount }}</span></button>
        <button class="rt" :class="{ on: reqTab === 'headers' }" @click="reqTab = 'headers'">Headers<span v-if="activeHeaderCount" class="dot">{{ activeHeaderCount }}</span></button>
        <button class="rt" :class="{ on: reqTab === 'body' }" @click="reqTab = 'body'">Body<span v-if="hasBody" class="dot dot-on"></span></button>
      </div>

      <div class="req-body">
        <!-- 查询参数 -->
        <table v-if="reqTab === 'params'" class="kv">
          <thead><tr><th class="th-ck"></th><th>{{ t("toolbox.request.paramName") }}</th><th>{{ t("toolbox.request.value") }}</th><th class="th-op"></th></tr></thead>
          <tbody>
            <tr v-for="(q, i) in query" :key="'q' + i">
              <td class="td-ck"><input v-model="q.on" type="checkbox" @change="rebuildUrl" /></td>
              <td><input v-model="q.key" class="cell" spellcheck="false" :placeholder="t('toolbox.request.paramName')" @input="onQueryEdit(i)" /></td>
              <td><input v-model="q.value" class="cell" spellcheck="false" :placeholder="t('toolbox.request.value')" @input="onQueryEdit(i)" /></td>
              <td class="td-op"><button v-if="i < query.length - 1" class="row-del" @click="removeQuery(i)"><Icon name="x" :size="13" /></button></td>
            </tr>
          </tbody>
        </table>

        <!-- 请求头 -->
        <table v-else-if="reqTab === 'headers'" class="kv">
          <thead><tr><th class="th-ck"></th><th>Header</th><th>{{ t("toolbox.request.value") }}</th><th class="th-op"></th></tr></thead>
          <tbody>
            <tr v-for="(h, i) in headers" :key="'h' + i">
              <td class="td-ck"><input v-model="h.on" type="checkbox" /></td>
              <td><input v-model="h.key" class="cell" spellcheck="false" :placeholder="t('toolbox.request.headerName')" @input="onHeaderEdit" /></td>
              <td><input v-model="h.value" class="cell" spellcheck="false" :placeholder="t('toolbox.request.value')" @input="onHeaderEdit" /></td>
              <td class="td-op"><button v-if="i < headers.length - 1" class="row-del" @click="removeHeader(i)"><Icon name="x" :size="13" /></button></td>
            </tr>
          </tbody>
        </table>

        <!-- 请求体 -->
        <div v-else class="body-pane">
          <div class="body-types">
            <button
              v-for="b in BODY_TYPES"
              :key="b.key"
              class="bt"
              :class="{ on: bodyType === b.key }"
              @click="bodyType = b.key"
            >{{ t(b.labelKey) }}</button>
            <span v-if="['GET','HEAD'].includes(method) && bodyType !== 'none'" class="body-warn">{{ t("toolbox.request.noBodyForMethod", { method }) }}</span>
            <span class="spacer"></span>
            <template v-if="bodyType === 'json'">
              <button class="body-act" @click="beautifyBody"><Icon name="sparkles" :size="13" />{{ t("toolbox.request.pretty") }}</button>
              <button v-if="openInJson" class="body-act" :title="t('toolbox.request.openInJson')" @click="jumpReqToJson"><Icon name="open" :size="13" />{{ t("toolbox.request.jsonTool") }}</button>
            </template>
          </div>
          <!-- Form 表单：键值对（x-www-form-urlencoded） -->
          <table v-if="bodyType === 'form'" class="kv">
            <thead><tr><th class="th-ck"></th><th>{{ t("toolbox.request.fieldName") }}</th><th>{{ t("toolbox.request.value") }}</th><th class="th-op"></th></tr></thead>
            <tbody>
              <tr v-for="(f, i) in bodyForm" :key="'f' + i">
                <td class="td-ck"><input v-model="f.on" type="checkbox" /></td>
                <td><input v-model="f.key" class="cell" spellcheck="false" :placeholder="t('toolbox.request.fieldName')" @input="onFormEdit" /></td>
                <td><input v-model="f.value" class="cell" spellcheck="false" :placeholder="t('toolbox.request.value')" @input="onFormEdit" /></td>
                <td class="td-op"><button v-if="i < bodyForm.length - 1" class="row-del" @click="removeForm(i)"><Icon name="x" :size="13" /></button></td>
              </tr>
            </tbody>
          </table>
          <!-- JSON / 文本 -->
          <textarea
            v-else-if="bodyType !== 'none'"
            v-model="bodyText"
            class="body-input"
            spellcheck="false"
            :placeholder="bodyPlaceholder"
          ></textarea>
          <p v-else class="ph">{{ t("toolbox.request.noBodyPh") }}</p>
        </div>
      </div>

      <!-- 响应（详见 ReqResponsePanel） -->
      <ReqResponsePanel
        :response="response"
        :resp-error="respError"
        v-model:resp-tab="respTab"
        v-model:resp-pretty="respPretty"
        :resp-status-class="respStatusClass"
        :resp-size-text="respSizeText"
        :resp-is-json="respIsJson"
        :resp-is-binary="respIsBinary"
        :resp-kind-label="respKindLabel"
        :resp-file-name="respFileName"
        :resp-lines="respLines"
        :resp-body-pretty="respBodyPretty"
        :resp-lang="respLang"
        :open-in-json="openInJson"
        @save="saveResponse"
        @copy="copyResp"
        @jump-to-json="jumpRespToJson"
      />
    </section>

    <!-- 右：历史 + 快捷操作 -->
    <aside class="col-side">
      <div class="side-card">
        <div class="side-head">
          <b>{{ t("toolbox.request.history") }}</b>
          <button v-if="history.length" class="side-clear" @click="clearHistory">{{ t("toolbox.request.clear") }}</button>
        </div>
        <div v-if="history.length" class="hist-search">
          <Icon name="search" :size="13" />
          <input v-model="histQuery" class="hist-input" :placeholder="t('toolbox.request.histSearchPh')" spellcheck="false" />
        </div>
        <div v-if="history.length" class="hist-list">
          <button v-for="(h, i) in filteredHistory" :key="h.ts + '-' + i" class="hist-item" @click="restoreHistory(h)" :title="h.url">
            <span class="mtag" :class="methodClass(h.method)">{{ h.method }}</span>
            <span class="hi-url">{{ splitUrl(h.url).base }}</span>
            <span class="hi-time">{{ relativeTime(h.ts) }}</span>
          </button>
          <p v-if="!filteredHistory.length" class="side-empty">{{ t("toolbox.request.histNoMatch", { q: histQuery }) }}</p>
        </div>
        <p v-else class="side-empty">{{ t("toolbox.request.histEmpty") }}</p>
      </div>

      <div class="side-card">
        <div class="side-title">{{ t("toolbox.request.quickOps") }}</div>
        <div class="quick-grid">
          <button class="quick" @click="newTab"><Icon name="plus" :size="15" />{{ t("toolbox.request.newTab") }}</button>
          <button class="quick" :class="{ on: curlOpen }" @click="toggleCurl"><Icon name="download" :size="15" />{{ t("toolbox.request.importCurl") }}</button>
          <button class="quick" @click="openSaveDialog()"><Icon name="folder" :size="15" />{{ t("toolbox.request.saveAsColl") }}</button>
          <button class="quick" @click="saveResponse"><Icon name="download" :size="15" />{{ t("toolbox.request.saveRespFile") }}</button>
          <button class="quick" @click="copyResp"><Icon name="copy" :size="15" />{{ t("toolbox.request.copyResp") }}</button>
        </div>
      </div>

      <div class="tip-card">
        <b>{{ t("toolbox.request.tipTitle") }}</b>
        <span>{{ t("toolbox.request.tipBody", { syntax: VAR_SYNTAX }) }}</span>
        <Icon name="sparkles" :size="18" class="tip-ico" />
      </div>
    </aside>

    <!-- 保存命名弹窗 -->
    <div v-if="saveOpen" class="save-mask" @click.self="saveOpen = false">
      <div class="save-box">
        <div class="save-title">{{ t("toolbox.request.saveToColl") }}</div>
        <label class="save-label">{{ t("toolbox.request.targetColl") }}</label>
        <select v-model="saveCollId" class="save-select">
          <option v-for="c in collections" :key="c.id" :value="c.id">{{ c.name }}</option>
          <option value="">{{ t("toolbox.request.newDefaultColl") }}</option>
        </select>
        <label class="save-label">{{ t("toolbox.request.reqName") }}</label>
        <input ref="saveInputRef" v-model="saveName" class="save-input" :placeholder="t('toolbox.request.reqName')" @keyup.enter="confirmSave" />
        <div class="save-acts">
          <button class="save-cancel" @click="saveOpen = false">{{ t("toolbox.request.cancel") }}</button>
          <button class="save-ok" @click="confirmSave">{{ t("toolbox.request.save") }}</button>
        </div>
      </div>
    </div>

    <!-- 新建集合弹窗 -->
    <div v-if="collOpen" class="save-mask" @click.self="collOpen = false">
      <div class="save-box">
        <div class="save-title">{{ t("toolbox.request.newCollection") }}</div>
        <input ref="collInputRef" v-model="collName" class="save-input" :placeholder="t('toolbox.request.collNamePh')" @keyup.enter="confirmColl" />
        <div class="save-acts">
          <button class="save-cancel" @click="collOpen = false">{{ t("toolbox.request.cancel") }}</button>
          <button class="save-ok" @click="confirmColl">{{ t("toolbox.request.create") }}</button>
        </div>
      </div>
    </div>

    <!-- cURL 导入弹窗（居中模态，避免侧栏 overflow 裁切） -->
    <div v-if="curlOpen" class="curl-mask" @click.self="curlOpen = false">
      <div class="curl-box">
        <div class="curl-title">{{ t("toolbox.request.importCurlTitle") }}</div>
        <textarea ref="curlInputRef" v-model="curlText" class="curl-input" spellcheck="false" :placeholder="CURL_PH"></textarea>
        <div class="curl-acts">
          <button class="curl-cancel" @click="curlOpen = false">{{ t("toolbox.request.cancel") }}</button>
          <button class="curl-ok" @click="importCurl">{{ t("toolbox.request.parseImport") }}</button>
        </div>
      </div>
    </div>

    <!-- 环境变量管理弹窗（详见 ReqEnvDialog） -->
    <ReqEnvDialog
      v-if="envOpen"
      :envs="envs"
      :active-env-id="activeEnvId"
      :var-name-syntax="VAR_NAME_SYNTAX"
      @close="envOpen = false"
      @add="addEnv"
      @use="useEnv"
      @remove="removeEnv"
      @remove-var="removeVar"
      @var-edit="onVarEdit"
      @persist="persistEnvs"
    />
  </div>
</template>

<style scoped>
.req-tool { display: grid; grid-template-columns: 210px minmax(0, 1fr) 240px; gap: 12px; height: 100%; min-height: 0; }

/* 通用小标签：方法着色 */
.mtag { flex-shrink: 0; padding: 1px 6px; font-size: var(--fs-xs); font-weight: 700; font-family: var(--font-mono); border-radius: var(--r-xs); }
.m-get { color: var(--success); background: var(--success-tint); }
.m-post { color: var(--warn); background: var(--warn-tint); }
.m-put { color: var(--primary); background: var(--primary-soft); }
.m-patch { color: var(--primary-hover); background: var(--primary-soft); }
.m-delete { color: var(--danger); background: var(--danger-soft); }
.m-head, .m-options { color: var(--muted); background: color-mix(in srgb, var(--text) 6%, transparent); }
.spacer { flex: 1; }

/* 中：主区 */
.col-main { display: flex; flex-direction: column; gap: 10px; min-width: 0; }

/* 多请求页标签栏 */
.tab-bar { flex-shrink: 0; display: flex; align-items: flex-end; gap: 4px; overflow-x: auto; }
.tab { display: inline-flex; align-items: center; gap: 6px; max-width: 200px; padding: 6px 8px 6px 10px; background: var(--card); border: 1px solid var(--card-border); border-bottom: none; border-radius: var(--r-sm) var(--r-sm) 0 0; cursor: pointer; color: var(--muted); transition: color 0.15s; white-space: nowrap; }
.tab:hover { color: var(--text); }
.tab.on { color: var(--text); border-color: var(--border-blue); background: var(--primary-soft); box-shadow: inset 0 2px 0 var(--primary); }
.tab-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-sm); }
.tab-name-input { width: 90px; padding: 2px 6px; font-size: var(--fs-sm); border: 1px solid var(--primary); border-radius: var(--r-xs); outline: none; background: var(--card); color: var(--text); }
.tab-spin { flex-shrink: 0; width: 10px; height: 10px; border: 2px solid var(--border-blue); border-top-color: var(--primary); border-radius: 50%; animation: tab-spin 0.8s linear infinite; }
@keyframes tab-spin { to { transform: rotate(360deg); } }
.tab-close { flex-shrink: 0; display: grid; place-items: center; width: 16px; height: 16px; padding: 0; border: none; background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; }
.tab-close:hover { color: var(--danger); background: var(--danger-soft); }
.tab-add { flex-shrink: 0; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; margin-bottom: 2px; border: 1px dashed var(--card-border); background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; }
.tab-add:hover { color: var(--primary-hover); border-color: var(--border-blue); background: var(--primary-soft); }

/* 环境 / 导入导出 工具条 */
.env-bar { flex-shrink: 0; display: flex; align-items: center; gap: 8px; }
.env-pick { display: inline-flex; align-items: center; gap: 6px; padding: 0 4px 0 10px; border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); }
.env-ico { color: var(--primary); }
.env-sel { padding: 7px 6px; font-size: var(--fs-sm); border: none; background: transparent; color: var(--text); cursor: pointer; outline: none; }
.env-manage { display: inline-flex; align-items: center; gap: 5px; padding: 7px 12px; font-size: var(--fs-sm); color: var(--text); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.env-manage:hover { color: var(--primary-hover); border-color: var(--border-blue); background: var(--primary-soft); }
.env-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; font-size: var(--fs-xs); font-weight: 700; color: var(--text-invert); background: var(--primary); border-radius: var(--r-pill); }
.io-btn { display: inline-flex; align-items: center; gap: 5px; padding: 7px 12px; font-size: var(--fs-sm); color: var(--muted); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.io-btn:hover { color: var(--primary); border-color: var(--primary); }
.hidden-file { display: none; }

.url-bar { flex-shrink: 0; display: flex; gap: 8px; }
.method-sel { flex-shrink: 0; width: 104px; padding: 0 10px; font-size: var(--fs-md); font-weight: 700; font-family: var(--font-mono); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); cursor: pointer; }
.method-sel.m-get { color: var(--success); }
.method-sel.m-post { color: var(--warn); }
.method-sel.m-put { color: var(--primary); }
.method-sel.m-patch { color: var(--primary-hover); }
.method-sel.m-delete { color: var(--danger); }
.url-input { flex: 1; min-width: 0; padding: 10px 12px; font-size: var(--fs-sm); font-family: var(--font-mono); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); color: var(--text); outline: none; }
.url-input:focus { border-color: var(--primary); }
.send-btn { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; padding: 0 22px; font-size: var(--fs-md); font-weight: 600; color: var(--text-invert); background: var(--primary); border: none; border-radius: var(--r-sm); cursor: pointer; transition: filter 0.15s; }
.send-btn:hover:not(:disabled) { filter: brightness(1.08); }
.send-btn:disabled { opacity: 0.6; cursor: default; }

/* 请求 tabs */
.req-tabs { flex-shrink: 0; display: flex; gap: 4px; border-bottom: 1px solid var(--card-border); }
.rt { position: relative; display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; font-size: var(--fs-md); color: var(--muted); background: none; border: none; border-bottom: 2px solid transparent; cursor: pointer; margin-bottom: -1px; }
.rt:hover { color: var(--text); }
.rt.on { color: var(--primary-hover); border-bottom-color: var(--primary); font-weight: 600; }
.dot { display: inline-flex; align-items: center; justify-content: center; min-width: 16px; height: 16px; padding: 0 4px; font-size: var(--fs-xs); font-weight: 700; color: var(--text-invert); background: var(--primary); border-radius: var(--r-pill); }
.dot-on { min-width: 8px; width: 8px; height: 8px; padding: 0; }

.req-body { flex-shrink: 0; max-height: 38%; overflow: auto; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }

/* 键值表 */
.kv { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.kv thead th { position: sticky; top: 0; padding: 8px 10px; text-align: left; font-weight: 600; color: var(--muted); background: color-mix(in srgb, var(--text) 3%, transparent); border-bottom: 1px solid var(--card-border); }
.kv th.th-ck, .kv td.td-ck { width: 34px; text-align: center; }
.kv th.th-op, .kv td.td-op { width: 36px; text-align: center; }
.kv td { padding: 2px 6px; border-bottom: 1px solid color-mix(in srgb, var(--text) 5%, transparent); }
.cell { width: 100%; padding: 6px 4px; font-size: var(--fs-sm); font-family: var(--font-mono); border: none; background: transparent; color: var(--text); outline: none; }
.cell:focus { background: var(--primary-soft); border-radius: var(--r-xs); }
.row-del { padding: 3px; border: none; background: transparent; color: var(--muted); cursor: pointer; border-radius: var(--r-xs); }
.row-del:hover { color: var(--danger); background: var(--danger-soft); }

/* Body */
.body-pane { display: flex; flex-direction: column; gap: 8px; padding: 10px; }
.body-types { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.bt { padding: 4px 12px; font-size: var(--fs-sm); color: var(--muted); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); cursor: pointer; }
.bt.on { color: var(--primary-hover); background: var(--primary-soft); border-color: var(--border-blue); font-weight: 600; }
.body-warn { font-size: var(--fs-xs); color: var(--warn); }
.body-act { display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px; font-size: var(--fs-xs); color: var(--primary-hover); background: var(--primary-soft); border: 1px solid var(--border-blue); border-radius: var(--r-sm); cursor: pointer; }
.body-act:hover { filter: brightness(0.98); }
.body-input { min-height: 120px; padding: 10px; font-size: var(--fs-xs); font-family: var(--font-mono); line-height: 1.6; border: 1px solid var(--card-border); border-radius: var(--r-sm); background: color-mix(in srgb, var(--text) 2%, transparent); color: var(--text); outline: none; resize: vertical; white-space: pre-wrap; word-break: break-all; }
.body-input:focus { border-color: var(--primary); }
/* 空态提示（Body 无内容时） */
.ph { margin: 0; padding: 16px; font-size: var(--fs-sm); color: var(--muted); }

/* 右侧栏 */
.col-side { display: flex; flex-direction: column; gap: 12px; min-width: 0; overflow: auto; }
.side-card { flex-shrink: 0; padding: 12px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); }
.side-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.side-head b { font-size: var(--fs-base); }
.side-title { margin-bottom: 10px; font-size: var(--fs-base); font-weight: 700; }
.side-clear { padding: 2px 8px; font-size: var(--fs-sm); border: none; background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; }
.side-clear:hover { color: var(--danger); background: var(--danger-soft); }

/* 历史搜索框 */
.hist-search { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; padding: 0 9px; border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); }
.hist-search .icon { flex-shrink: 0; color: var(--muted); }
.hist-input { flex: 1; min-width: 0; padding: 6px 0; font-size: var(--fs-sm); border: none; background: transparent; color: var(--text); outline: none; }
.hist-input::placeholder { color: var(--muted); }

/* 历史列表：限高内部滚动，避免撑满侧栏无限拉长 */
.hist-list { display: flex; flex-direction: column; gap: 2px; max-height: 300px; overflow-y: auto; }
.hist-item { display: flex; align-items: center; gap: 7px; width: 100%; padding: 6px 6px; border: none; background: transparent; border-radius: var(--r-sm); cursor: pointer; text-align: left; }
.hist-item:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.hi-url { flex: 1; min-width: 0; font-size: var(--fs-xs); font-family: var(--font-mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hi-time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); }
.side-empty { margin: 0; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }

.quick-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.quick { display: flex; align-items: center; justify-content: center; gap: 6px; width: 100%; padding: 9px 6px; font-size: var(--fs-sm); color: var(--text); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.quick:hover, .quick.on { color: var(--primary-hover); border-color: var(--border-blue); background: var(--primary-soft); }

.tip-card { position: relative; display: flex; flex-direction: column; gap: 4px; padding: 14px 40px 14px 14px; background: var(--grad-promo); border: 1px solid var(--border-blue); border-radius: var(--r-md); }
.tip-card b { font-size: var(--fs-sm); color: var(--primary-hover); }
.tip-card span { font-size: var(--fs-xs); color: var(--muted); line-height: var(--lh-body); }
.tip-ico { position: absolute; top: 12px; right: 12px; color: var(--primary); }

/* 弹窗：保存 / 新建集合共用 save-*，cURL 单独样式；环境弹窗样式见 ReqEnvDialog */
.save-mask, .curl-mask { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; background: rgba(17, 24, 39, 0.4); }
.save-box { width: 360px; padding: 20px; background: var(--card); border-radius: var(--r-lg); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25); }
.save-title { margin-bottom: 12px; font-size: var(--fs-base); font-weight: 700; }
.save-label { display: block; margin: 10px 0 4px; font-size: var(--fs-xs); color: var(--muted); }
.save-select { width: 100%; padding: 9px 10px; font-size: var(--fs-md); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card); color: var(--text); outline: none; cursor: pointer; }
.save-select:focus { border-color: var(--primary); }
.save-input { width: 100%; padding: 9px 12px; font-size: var(--fs-md); border: 1px solid var(--card-border); border-radius: var(--r-sm); outline: none; }
.save-input:focus { border-color: var(--primary); }
.save-acts, .curl-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.save-cancel, .curl-cancel { padding: 7px 16px; font-size: var(--fs-sm); color: var(--muted); background: transparent; border: 1px solid var(--card-border); border-radius: var(--r-sm); cursor: pointer; }
.save-ok, .curl-ok { padding: 7px 16px; font-size: var(--fs-sm); color: var(--text-invert); background: var(--primary); border: none; border-radius: var(--r-sm); cursor: pointer; }

/* cURL 导入弹窗 */
.curl-box { width: 520px; max-width: calc(100vw - 48px); padding: 20px; background: var(--card); border-radius: var(--r-lg); box-shadow: 0 12px 40px rgba(0, 0, 0, 0.25); }
.curl-title { margin-bottom: 12px; font-size: var(--fs-base); font-weight: 700; }
.curl-input { width: 100%; height: 160px; padding: 10px; font-size: var(--fs-xs); font-family: var(--font-mono); line-height: 1.6; border: 1px solid var(--card-border); border-radius: var(--r-sm); background: color-mix(in srgb, var(--text) 2%, transparent); color: var(--text); outline: none; resize: vertical; white-space: pre-wrap; word-break: break-all; }
.curl-input:focus { border-color: var(--primary); }

/* ============ 窄窗口适配：三列（集合 210 / 请求 / 历史 240）逐步降级，保证中间请求编辑区可用 ============ */
@media (max-width: 1150px) {
  .req-tool { grid-template-columns: 190px minmax(0, 1fr) 220px; }
  .cl-count { display: none; } /* 集合列收窄后隐藏计数，避免挤压标题 */
}
@media (max-width: 980px) {
  /* 右列（历史/快捷操作）为辅助功能，窄屏让位给请求主链路；数据仍在本地，恢复宽度后可见 */
  .req-tool { grid-template-columns: 190px minmax(0, 1fr); }
  .col-side { display: none; }
}
@media (max-width: 820px) {
  .req-tool { grid-template-columns: 150px minmax(0, 1fr); }
}
</style>
