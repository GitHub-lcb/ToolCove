<script setup>
// 设置页（UI 2.0 工作台式）：左侧分类导航 + 右侧内容区，替代原设置弹窗。
// 分类：AI 模型 / 系统设置；保存后 dispatch settings-saved 供全局刷新。
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { capabilities, isEnterprise } from "../platform/env.js";
import { configureRemote, getRemoteConfig, remoteConfigured, remotePing, remoteMembers, remoteCreateMember, remoteRevokeMember } from "../platform/remoteStore.js";
import { saveEnterpriseConfig, clearEnterpriseConfig, loadEnterpriseConfig } from "../app/enterpriseServer.js";
import { getPolicySync, loadPolicy, setPolicy } from "../enterprise/policyStore.js";
import { RISK_LEVELS } from "../enterprise/policy.js";
import { clearAudit, loadAudit } from "../enterprise/audit.js";
import { TOOLBOX_TOOLS, groupToolboxTools } from "../toolboxTools.js";
import { open as openDialog, save as saveDialog } from "../platform/dialog.js";
import { relaunch } from "../platform/shell.js";
import { openUrl } from "../platform/shell.js";
import Icon from "../ui/Icon.vue";
import { vFieldError } from "../ui/fieldError.js";
import MembersPanel from "../enterprise/MembersPanel.vue";
import { testAI, listAIModels, AI_PRESETS, PROVIDER_GROUPS } from "../ai.js";
import { newProfileId, normalizeAi, profileLabel, toStoredAi } from "../agent/modelProfiles.js";
import { testTypeSafe } from "../typesafe.js";
import { checkForUpdate } from "../app/updater.js";
import { encryptValue, decryptValue } from "../secure.js";
import { ACCENT_PRESETS, saveAccentKey, loadAccentKey } from "../app/accentTheme.js";
import { getConfig as telemetryGetConfig, consent as telemetryConsent } from "../app/telemetry.js";
import { createSyncCollection, joinSyncCollectionFull, syncNowManual, listDevices, revokeDevice, regeneratePairingCode, getSyncSnapshot, setSyncEnabled, setSyncDeviceName, getEngine } from "../sync/index.js";
import { askConfirm } from "../ui/confirm.js";
import { flushToolbox } from "../toolboxStore.js";
import { flushSecureToolbox } from "../secureToolbox.js";
import { cloneJsonData } from "../jsonData.js";
import { normalizeHiddenModules, mergeSettingsSnapshot, normalizeTypeSafe, AGENT_CONFIRM_POLICIES, AGENT_MAX_STEPS_HARD_CAP, AGENT_MAX_RETRIES } from "../app/settingsConfig.js";
import { saveAgentConfig } from "../agent/config.js";
import { listAgentTools } from "../agent/tools.js";
import { buildCapabilityGroups, countEnabledTools, riskChip, riskKey } from "../agent/capabilities.js";
import { agentSession, clearSpills, deleteSkill, initAgentSession, refreshAgentConfig, setSkillEnabled } from "../agent/session.js";
import { NAV_MODULES } from "../app/navConfig.js";
import { applyLocale } from "../i18n/index.js";
import pkg from "../../package.json";

const { t } = useI18n();

const props = defineProps({
  showToast: { type: Function, default: () => {} },
  section: { type: String, default: "general" }, // 侧边栏系统管理入口定位的分类
});
// 唯一的外部动作是「打开对应工具箱工具」：App.vue 对所有模块视图统一透传 @navigate，
// 设置页不自建窗口逻辑（工作台那条独立窗口路径属于对话区，见 AgentView 的 openManual）。
const emit = defineEmits(["navigate"]);

const SECTIONS = [
  { key: "ai", labelKey: "settings.navAi", icon: "sparkles", descKey: "settings.navAiDesc" },
  // Agent 分节：工具开关原先常驻在对话右栏的「能力清单」里，三栏改版后那一栏撤掉，
  // catalogue（工具开关 / 技能库 / 溢出结果区）落到设置里——agent.capSettingsHint 的文案
  // 「工具开关与运行上限可在设置 → Agent 中调整」本来就是指向这里的。
  // icon 用 zap：与工作台的状态图标同源（Agent 是「会动手」的那一区）。
  { key: "agent", labelKey: "settings.navAgent", icon: "zap", descKey: "settings.navAgentDesc" },
  { key: "sync", labelKey: "settings.navSync", icon: "refresh", descKey: "settings.navSyncDesc" },
  { key: "enterprise", labelKey: "settings.navEnterprise", icon: "network", descKey: "settings.navEnterpriseDesc" },
  // 管理面仅企业态出现（见下方 sections 过滤）：成员/席位管理走服务端成员 API，仅管理员可读写。
  { key: "admin", labelKey: "settings.navAdmin", icon: "shield", descKey: "settings.navAdminDesc" },
  { key: "sponsor", labelKey: "settings.navSponsor", icon: "heart", descKey: "settings.navSponsorDesc" },
  { key: "general", labelKey: "settings.navGeneral", icon: "settings", descKey: "settings.navGeneralDesc" },
];
// 云同步依赖原生代理（服务端未开 CORS 前浏览器直连不可用），浏览器端整节隐藏；
// 管理面是企业独占，个人版整节隐藏（判据与投影同源：isEnterprise()）。
const sections = computed(() => SECTIONS.filter((s) => (s.key !== "sync" || capabilities.cloudSync) && (s.key !== "admin" || isEnterprise())));
const section = ref(SECTIONS.some((s) => s.key === props.section) ? props.section : "general");
watch(
  () => props.section,
  (v) => {
    if (SECTIONS.some((s) => s.key === v)) section.value = v;
  }
);
// 兜底显式指向 general（插入 pro 后 SECTIONS[1] 不再等于 general，评审注意项）
const currentMeta = computed(() => sections.value.find((s) => s.key === section.value) || SECTIONS.find((s) => s.key === "general") || SECTIONS[0]);

// 侧边栏模块展示/隐藏选项（与 App.vue 同一份 navConfig，设置不入列表）。
// agent 不在选项里：二期导航重构后它是默认主区（侧边栏没有它的按钮），
// 「隐藏 agent」语义不再成立——历史脏值由 schema v9 迁移清掉（见 navConfig.js）。
const NAV_MODULE_OPTIONS = NAV_MODULES.filter((m) => m.key !== "agent");
function isNavModuleVisible(key) {
  return !form.value.ui.hiddenModules.includes(key);
}
function toggleNavModule(key, visible) {
  const hidden = new Set(form.value.ui.hiddenModules);
  if (visible) hidden.delete(key);
  else hidden.add(key);
  // 按 NAV_MODULE_OPTIONS 固定顺序回写，列表稳定
  form.value.ui.hiddenModules = NAV_MODULE_OPTIONS.map((m) => m.key).filter((k) => hidden.has(k));
}

const saving = ref(false);
const dirty = ref(false);
const testingAI = ref(false);
const testingTypeSafe = ref(false);
const showKey = ref(false);
const showTypeSafeKey = ref(false);
const fieldErr = ref({});
const form = ref(newSettings());
// 设置页里的「正在编辑哪条模型配置」：纯界面状态，不进 dirty 与落盘
const editingProfileId = ref("");
const editingProfile = computed(() => {
  const list = form.value.ai.profiles || [];
  return list.find((p) => p.id === editingProfileId.value) || list[0] || null;
});

// ------- 模型列表自动拉取 -------
// 按「地址 + Key」缓存：地址或 Key 一变，旧列表自动作废（fetchedModels 比对 key）。
const modelsByProfile = ref({}); // profileId -> { key, list }
const fetchingModels = ref(false);
const modelFetchError = ref("");
let modelFetchToken = 0;

const cacheKeyOf = (profile) =>
  `${(profile?.baseUrl || "").trim().replace(/\/+$/, "")}\u0000${(profile?.apiKey || "").trim()}`;

const fetchedModels = computed(() => {
  const profile = editingProfile.value;
  if (!profile) return [];
  const entry = modelsByProfile.value[profile.id];
  return entry && entry.key === cacheKeyOf(profile) ? entry.list : [];
});

/** 下拉候选：当前模型不在端点返回里也要保留，否则一保存就被悄悄换掉。 */
const modelChoices = computed(() => {
  const list = fetchedModels.value;
  const current = String(editingProfile.value?.model || "").trim();
  return current && !list.includes(current) ? [current, ...list] : list;
});
const settingsLoadError = ref("");
// 开机启动是系统状态不是应用数据：进入页面时读真实状态，保存时写回，不落 settings.json
const autostartOn = ref(false);
// 磁盘上的完整 settings 快照。表单只渲染 ai/ui，保存时以它为基底合并，
// 否则 sync/telemetry 等未渲染分组会被表单快照整体覆盖掉。
let rawSnapshot = {};
// ---------- 遥测隐私开关（即改即存，不走表单保存路径） ----------
const telemetryOn = ref(false);
async function loadTelemetryPref() {
  const cfg = await telemetryGetConfig().catch(() => ({ enabled: false }));
  telemetryOn.value = !!cfg.enabled;
}
async function toggleTelemetry(ev) {
  const next = !!ev.target.checked;
  telemetryOn.value = next;
  await telemetryConsent(next).catch(() => {});
  props.showToast(next ? t("telemetry.onMsg") : t("telemetry.offMsg"));
}
// ---------- 云同步 ----------
const syncCfg = ref(null); // normalizeSync 后的快照
const syncStatus = ref("disabled");
const syncBusy = ref(false);
const syncErrKey = ref("");
const syncCodeInput = ref("");
const syncPassword = ref("");
const syncJoinId = ref("");
const syncDevices = ref([]);
const pairingResult = ref({ code: "", expiresAt: 0 });
const syncField = ref(""); // paint
const showSyncPassword = ref(false);
async function refreshSync() {
  try {
    syncCfg.value = await getSyncSnapshot();
    syncStatus.value = syncCfg.value.status || "idle";
    const e = await getEngine().catch(() => null);
    if (e && syncCfg.value.enabled && syncCfg.value.tokenCipher) {
      try { syncDevices.value = await listDevices(); } catch { /* 未就绪 */ }
    }
  } catch { /* 设置页仍可用 */ }
}
async function toggleSync(ev) {
  const next = !!ev.target.checked;
  try {
    await setSyncEnabled(next);
    await refreshSync();
  } catch (e) {
    props.showToast(String(e));
  }
}
async function doCreateSync() {
  syncBusy.value = true;
  syncErrKey.value = "";
  try {
    if (syncPassword.value.length < 8) {
      syncErrKey.value = "sync.errShortPw";
      return;
    }
    const r = await createSyncCollection(syncField.value, syncPassword.value);
    pairingResult.value = { code: r.pairingCode, expiresAt: r.expiresAt };
    await refreshSync();
    syncBusy.value = false;
    props.showToast(t("sync.created"));
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
    syncBusy.value = false;
  }
}
async function doJoinSync() {
  syncBusy.value = true;
  syncErrKey.value = "";
  try {
    if (syncPassword.value.length < 8) { syncErrKey.value = "sync.errShortPw"; return; }
    await joinSyncCollectionFull(syncField.value, syncJoinId.value.trim(), syncCodeInput.value.trim(), syncPassword.value);
    await refreshSync();
    syncBusy.value = false;
    props.showToast(t("sync.joined"));
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
    syncBusy.value = false;
  }
}
async function doSyncNow() {
  syncBusy.value = true;
  try {
    const e = await getEngine();
    const st = await e.syncNow();
    await refreshSync();
    props.showToast(t("sync.syncNowOk", { pushed: st.pushed || 0, pulled: st.pulled || 0 }));
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
  } finally {
    syncBusy.value = false;
  }
}
async function doRegenCode() {
  try {
    const r = await regeneratePairingCode();
    pairingResult.value = { code: r.pairingCode, expiresAt: r.expiresAt };
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
  }
}
async function doRevoke(hash, self) {
  const ok = await askConfirm({
    title: t("sync.revokeTitle"),
    message: self ? t("sync.revokeSelfMsg") : t("sync.revokeMsg"),
    okText: t("sync.revokeBtn"),
  });
  if (!ok) return;
  try {
    await revokeDevice(hash, self);
    await refreshSync();
  } catch (e) {
    syncErrKey.value = String(e && e.message || e);
  }
}
function statusKey(st) {
  const map = { disabled: "sync.statusDisabled", idle: "sync.statusIdle", syncing: "sync.statusSyncing", error: "sync.statusError", revoked: "sync.statusRevoked" };
  return map[st] || "sync.statusIdle";
}
function fmtSyncTime(ts) {
  return new Date(Number(ts)).toLocaleString();
}
async function copyPairing() {
  try {
    await navigator.clipboard.writeText(pairingResult.value.code);
  } catch { /* 选中即复制，手抄兜底 */ }
}
function registerSyncRefresh() {
  window.addEventListener("sync-status", refreshSyncListener);
}
function refreshSyncListener() {
  refreshSync();
}
// ---------- 企业服务器（二期：数据桥接企业服务器） ----------
// 与云同步一样是即改即存、不走表单保存路径：配置本身必须存本地（app/enterpriseServer.js），
// 不能进 settings.json——数据桥路由到远端后，settings.json 就在服务器上了，配置存里面是自举悖论。
const entUrl = ref("");
const entToken = ref("");
const showEntToken = ref(false);
const entTesting = ref(false);
const entConfigured = ref(false); // 数据桥当前是否路由到企业服务器
const entState = ref("none"); // none / ok / fail
const entName = ref(""); // ping 返回的服务端显示名
const entErr = ref("");
async function loadEnterprise() {
  const cfg = await loadEnterpriseConfig();
  entUrl.value = cfg?.baseUrl || "";
  entToken.value = cfg?.token || "";
  entConfigured.value = remoteConfigured();
  entState.value = entConfigured.value ? "ok" : "none";
}
function entErrorText(code) {
  const map = { REMOTE_UNAUTHORIZED: "settings.enterpriseErrAuth", REMOTE_UNREACHABLE: "settings.enterpriseErrUnreachable" };
  return map[code] ? t(map[code]) : String(code || "");
}
async function doEntTest() {
  entErr.value = "";
  const baseUrl = entUrl.value.trim();
  const token = entToken.value.trim();
  if (!baseUrl || !/^https?:\/\//.test(baseUrl) || !token) {
    entState.value = "fail";
    entErr.value = t("settings.enterpriseErrInvalid");
    return;
  }
  entTesting.value = true;
  // 先暂存旧配置：测试成功才落 configureRemote（规格），失败恢复原状，已连着的配置不被一次失败测试打断
  const prev = getRemoteConfig();
  try {
    configureRemote({ baseUrl, token });
    const r = await remotePing();
    if (r.ok) {
      await saveEnterpriseConfig({ baseUrl, token });
      entConfigured.value = true;
      entState.value = "ok";
      entName.value = r.name || "";
      entRole.value = r.role || "";
      props.showToast(t("settings.enterpriseConnected"));
      if (entRole.value === "admin") await loadMembers();
    } else {
      configureRemote(prev);
      entState.value = "fail";
      entErr.value = entErrorText(r.error);
    }
  } catch (e) {
    configureRemote(prev);
    entState.value = "fail";
    entErr.value = e && e.message ? e.message : String(e);
  } finally {
    entTesting.value = false;
  }
}
async function doEntDisconnect() {
  configureRemote(null);
  clearEnterpriseConfig();
  entConfigured.value = false;
  entState.value = "none";
  entName.value = "";
  entErr.value = "";
  // 断开后清空成员面：名册与一次性令牌都只属于已连接的企业服务器，不能留在界面上
  entRole.value = "";
  members.value = [];
  membersErr.value = "";
  newMemberToken.value = "";
  props.showToast(t("settings.enterpriseDisconnected"));
}
// ---------- 管理面（三期：企业权限门禁 + 操作审计留痕，仅企业态出现） ----------
// 与 enterprise 段同款「即改即存、不走表单保存路径」：策略与审计是管理面数据，不是用户偏好，
// 存 enterprise/policyStore 与 enterprise/audit（走 invoke 数据桥，企业态落服务器）。
const RISK_KEY = { read: "agent.riskRead", transform: "agent.riskTransform", write: "agent.riskWrite", database: "agent.riskDatabase" };
const policy = ref(getPolicySync());
const policyGroups = computed(() => groupToolboxTools(TOOLBOX_TOOLS));
const auditRows = ref([]);
const riskLabelKey = (risk) => RISK_KEY[risk] || "agent.riskRead";
const auditDecisionKey = (decision) => (decision === "deny" ? "settings.adminAuditDeny" : "settings.adminAuditAllow");
const auditSourceKey = (source) => (source === "human" ? "settings.adminAuditSourceHuman" : "settings.adminAuditSourcePolicy");
const fmtAuditTime = (ts) => new Date(Number(ts)).toLocaleString();
function isToolAllowed(key) {
  return !policy.value.disabledTools.includes(key);
}
// 工具准入：开=允许（移出禁用清单），关=禁用（进禁用清单）。setPolicy 同时刷新缓存并落盘。
function toggleToolPolicy(key, allowed) {
  const disabled = new Set(policy.value.disabledTools);
  if (allowed) disabled.delete(key);
  else disabled.add(key);
  policy.value = setPolicy({ disabledTools: [...disabled], maxRisk: policy.value.maxRisk });
  props.showToast(t("settings.adminPolicySaved"));
}
function changeMaxRisk(value) {
  policy.value = setPolicy({ disabledTools: policy.value.disabledTools, maxRisk: value || null });
  props.showToast(t("settings.adminPolicySaved"));
}
async function refreshAuditLog() {
  auditRows.value = await loadAudit().catch(() => []);
}
async function clearAuditLog() {
  const ok = await askConfirm({
    title: t("settings.adminAuditConfirmTitle"),
    message: t("settings.adminAuditConfirmMsg"),
    okText: t("settings.adminAuditConfirmOk"),
  });
  if (!ok) return;
  await clearAudit();
  await refreshAuditLog();
}
// 导出沿用项目既有惯例：saveDialog 取目标 → invoke("export_file") 落盘（浏览器端转成下载）。
async function exportAuditLog() {
  const p = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  try {
    const dest = await saveDialog({
      title: t("settings.adminAuditExportDlg"),
      defaultPath: `toolcove-audit-${stamp}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!dest) return;
    await invoke("export_file", { path: dest, content: JSON.stringify(auditRows.value, null, 2) });
    props.showToast(t("settings.adminAuditExportDone"));
  } catch (e) {
    props.showToast(t("settings.adminAuditExportFailed", { err: e }));
  }
}
// ---------- 成员/席位管理（三期：对接服务端成员 API，仅企业态且当前令牌为管理员才可用） ----------
// 与上面的策略/审计同款「不走表单保存路径」：名册以服务端为权威来源，这里只做读写与展示。
const entRole = ref(""); // ping 返回的当前令牌角色（admin | member）
const members = ref([]);
const membersBusy = ref(false);
const membersErr = ref(""); // 错误码，展示时映射为文案
const newMemberToken = ref(""); // 创建成功后返回的令牌：只显示一次，关闭即清空
function memberErrorText(code) {
  const map = {
    REMOTE_FORBIDDEN: "settings.membersForbidden",
    REMOTE_SEAT_LIMIT: "settings.memberSeatLimit",
    CANNOT_REVOKE_SELF: "settings.memberCannotRevokeSelf",
    REMOTE_UNAUTHORIZED: "settings.enterpriseErrAuth",
  };
  return map[code] ? t(map[code]) : String(code || "");
}
async function loadMembers() {
  membersBusy.value = true;
  membersErr.value = "";
  try {
    members.value = (await remoteMembers()).members;
  } catch (e) {
    membersErr.value = e?.code || "REMOTE_ERROR";
  } finally {
    membersBusy.value = false;
  }
}
// 进企业态后先 ping 取角色：只有管理员才拉名册（普通成员看到的是 MembersPanel 的「无权查看」提示）
async function refreshMembers() {
  if (!remoteConfigured()) return;
  membersErr.value = "";
  const r = await remotePing();
  if (!r.ok) {
    membersErr.value = r.error || "REMOTE_UNREACHABLE";
    return;
  }
  entRole.value = r.role || "";
  if (r.name) entName.value = r.name;
  if (entRole.value === "admin") await loadMembers();
}
async function createMember({ name, role }) {
  membersBusy.value = true;
  membersErr.value = "";
  try {
    const { token } = await remoteCreateMember({ name, role });
    newMemberToken.value = token || "";
    await loadMembers();
  } catch (e) {
    membersErr.value = e?.code || "REMOTE_ERROR";
  } finally {
    membersBusy.value = false;
  }
}
async function revokeMember(member) {
  const ok = await askConfirm({
    title: t("settings.memberRevoke"),
    message: t("settings.memberRevokeConfirm", { name: member.name }),
    okText: t("settings.memberRevoke"),
  });
  if (!ok) return;
  membersBusy.value = true;
  membersErr.value = "";
  try {
    await remoteRevokeMember(member.id);
    await loadMembers();
  } catch (e) {
    membersErr.value = e?.code || "REMOTE_ERROR";
  } finally {
    membersBusy.value = false;
  }
}
// ---------- Agent 设置（运行上限 / 确认策略 / 工具开关 / 技能库 / 溢出结果区） ----------
// 即改即存，**刻意不走页面底部的「保存」按钮**：save() 的合并基底是磁盘快照，而表单只渲染
// ai / ui 两组——把 agent 塞进表单快照，等于让「改一次界面密度」有机会整组覆盖 Agent 配置
// （先例：云同步配置曾被表单快照抹掉，见 mergeSettingsSnapshot 的注释）。
// 即改即存也是老能力面板的既有行为（agent/session.js 的 setToolEnabled 直接落盘），
// 与本节同页的云同步 / 遥测 / 管理面一致，沿用同一条路径最不容易出岔子。
const agentMaxSteps = ref(null); // 数字输入框的本地值：落盘后按磁盘上的归一化结果回填（越界值会被夹取）
const agentRetries = ref(null);
// 三选一的词条：值域来自 AGENT_CONFIRM_POLICIES（冻结数组，顺序即展示顺序），
// 不自己再写一遍 ["risky","always","never"]——那样值域就有两份真相了。
const CONFIRM_LABEL_KEY = {
  risky: "settings.agentConfirmRisky",
  always: "settings.agentConfirmAlways",
  never: "settings.agentConfirmNever",
};
// 工具清单走 tools.js 的 listAgentTools：**只读目录**、同步返回、不碰实现层。
// 绝不能用 buildAgentRegistry——那是实现层（executors / dataTools，约 300KB），为画一份开关列表
// 把它拉进设置页，正是当初把「目录 / 实现」拆成两层要避免的事（见 agent/tools.js 头部说明）。
const agentTools = computed(() => {
  // 显式读一次 policy：企业态在管理面改完门禁后这份清单要跟着重算，而 getPolicySync() 读的是
  // 模块级非响应式缓存（同步投影的代价，见 enterprise/policyStore.js），不读这个 ref 会一直显示旧清单。
  void policy.value;
  return listAgentTools(agentSession.cfg);
});
const agentToolGroups = computed(() => buildCapabilityGroups(agentTools.value));
const agentToolCount = computed(() => countEnabledTools(agentTools.value));
// 运行中不允许清溢出：正在跑的那次运行可能还要读回自己的大结果（与老面板的禁用条件一致）
const agentBusy = computed(() => agentSession.status !== "idle");
const skillDisabled = (id) => (agentSession.cfg?.disabledSkills || []).includes(id);

/** 表单值按**会话配置**回填（不另读一次盘）：保证输入框显示的就是将要生效的那一份。 */
function syncAgentFields() {
  const cfg = agentSession.cfg;
  if (!cfg) return;
  agentMaxSteps.value = cfg.maxSteps;
  agentRetries.value = cfg.retries;
}

/**
 * 即改即存。落盘后走 refreshAgentConfig() 而不是直接相信入参：normalizeAgent 会夹取越界步数、
 * 把「工具全关」当未配置重置——这些修正只有读回磁盘才看得见，界面不能显示一个没落地的值。
 * 它同时把 agentSession.cfg 刷成新值：对话主区与运行链路读的就是它，只写盘不刷新会话会留下
 * 「设置页改了、Agent 还用旧清单」的时间差。
 * 失败必须出声：静默吞掉会造成「开关看着关了、重启又打开」（agent/config.js 的既有纪律）。
 */
async function saveAgentPatch(patch) {
  try {
    await saveAgentConfig(patch);
    await refreshAgentConfig();
    syncAgentFields();
    props.showToast(t("settings.agentSaved"));
    return true;
  } catch {
    props.showToast(t("settings.agentSaveFail"));
    return false;
  }
}

/** 数字旋钮在 @change（失焦 / 回车）落盘：绑 input 事件会把打字中间态（空串、半截数字）写进配置。 */
function onRunLimitChange(key) {
  const raw = key === "maxSteps" ? agentMaxSteps.value : agentRetries.value;
  const value = Number(raw);
  // 清空输入框只是打字过程中的中间态，不等于「设为 0」：回填现值，不写盘
  if (raw === "" || raw === null || !Number.isFinite(value)) return syncAgentFields();
  // 取整：normalizeAgent 只认整数，3.5 落盘会被当成坏值退回默认值——用户要的是 3
  saveAgentPatch({ [key]: Math.trunc(value) });
}

async function onToggleAgentTool(tool, ev) {
  const disabled = new Set(agentSession.cfg?.disabledTools || []);
  if (tool.enabled) disabled.add(tool.name);
  else disabled.delete(tool.name);
  const ok = await saveAgentPatch({ disabledTools: [...disabled] });
  // 开关一律按**落盘后的真实配置**回正。原因：复选框的 :checked 只在 vnode 上的值发生变化时
  // 才写回 DOM，而落盘失败（值没变）与「关掉最后一个工具被归一化重置成全开」（目标值本来就是
  // true，diff 不出来）这两种情况下 DOM 会停在用户刚拨过去的位置——一个看着关掉、其实没关的开关。
  if (ev?.target) ev.target.checked = !(agentSession.cfg?.disabledTools || []).includes(tool.name);
  // 关掉最后一个工具：归一化把「全关 = 空 registry」视为未配置并重置成全开，这次改动因此不生效。
  // 不假装成功，也不自己弹回去——如实说明开关为什么又亮了。
  if (ok && tool.enabled && ev?.target?.checked) {
    props.showToast(t("settings.agentAllToolsOff"));
  }
}

/** 打开对应工具箱工具：沿用工作台那条「跳工具箱 + 带工具 key」的路径（见 AgentView 的 fallback）。 */
function openToolManual(toolKey) {
  if (toolKey) emit("navigate", { module: "toolbox", id: toolKey });
}

// 技能与溢出：行为与老能力面板一致。技能开关复用 disabledSkills（与 disabledTools 同一惯例：
// 记**停用**清单，默认全开）；关掉最后一条不报错——技能是可选增强，不是可执行能力。
async function onToggleSkill(skill, ev) {
  try {
    await setSkillEnabled(skill.id, skillDisabled(skill.id));
  } catch {
    props.showToast(t("settings.agentSaveFail"));
  }
  // 同工具开关：按真实配置回正复选框（落盘失败时 cfg 没变，界面不该停在用户拨过去的位置）
  if (ev?.target) ev.target.checked = !skillDisabled(skill.id);
}

async function onDeleteSkill(skill) {
  try {
    if (await deleteSkill(skill.id)) props.showToast(t("agent.skillDeleted", { name: skill.name }));
  } catch {
    props.showToast(t("settings.agentSaveFail"));
  }
}

async function onClearSpills() {
  try {
    await clearSpills();
    // 这里只回执「已执行」：老面板用的 agent.spillCleared / agent.spillClearEmpty（带条数与字符数、
    // 以及如实说「本来就是空的」）不在本次可用的词条清单里，而字典 JSON 由并行的另一个改动持有、
    // 不能动。补上那两把键之后应换回带条数的措辞——「清掉了几条」对用户是有用信息。
    props.showToast(t("agent.spillClear"));
  } catch {
    props.showToast(t("settings.agentSaveFail"));
  }
}

// 打开设置页时刷新 + 订阅状态（遥测与云同步都是桌面端专属，浏览器端跳过）
onMounted(async () => {
  loadSettings();
  loadEnterprise();
  // Agent 分节读的是**会话配置**（agentSession.cfg），不另读一次盘：它是对话主区与运行链路
  // 将要使用的那一份，换个来源就可能出现「设置页开着、运行时不认」的分裂。
  // refreshAgentConfig() 内部就是 loadAgentConfig()（顺带刷新 aiReady），于是两处对齐。
  // 会话还没初始化时走 initAgentSession()：它除了配置还带起技能库（agentSession.skills）——
  // 设置页是技能库的第二个入口，用户完全可能从侧边栏直接进来而没经过工作台，
  // 那时只刷配置会把技能库显示成空的。两者都幂等。
  if (agentSession.ready) await refreshAgentConfig();
  else await initAgentSession();
  syncAgentFields();
  // 管理面数据：企业态才需要（策略回填缓存的当前值、审计读回列表）。loadPolicy 顺带刷新缓存，
  // 保证设置页展示的策略与投影处实际生效的策略是同一份。
  if (isEnterprise()) {
    policy.value = await loadPolicy();
    refreshAuditLog();
    refreshMembers();
  }
  if (capabilities.telemetryUpload) loadTelemetryPref();
  if (!capabilities.cloudSync) return;
  await refreshSync();
  registerSyncRefresh();
});
// 支持与链接 ----------
function openAfdian() {
  openUrl("https://afdian.com/a/toolcove").catch((e) => props.showToast(String(e)));
}
function openRepo() {
  openUrl("https://github.com/GitHub-lcb/ToolCove").catch((e) => props.showToast(String(e)));
}
// ---------- 自定义主题色 ----------
const accentKey = ref(loadAccentKey() || "");
async function pickAccent(key) {
  saveAccentKey(key || "");
  accentKey.value = key || "";
  window.dispatchEvent(new CustomEvent("accent-changed"));
  props.showToast(key ? t("settings.accentApplied") : t("settings.accentReset"));
}

/** 第一条不完整的配置（启用 AI 时所有已保存配置都必须是可用的）。 */
function invalidProfile(profiles = form.value.ai.profiles) {
  return profiles.find((p) => !(p.baseUrl || "").trim() || !(p.apiKey || "").trim() || !(p.model || "").trim()) || null;
}

function validate() {
  const err = {};
  if (form.value.ai.enabled) {
    const profiles = form.value.ai.profiles;
    if (!profiles.length) {
      err.aiProfile = t("settings.errAiProfiles");
    } else {
      const bad = invalidProfile(profiles);
      if (bad) {
        err.aiProfile = t("settings.errAiProfileIncomplete", {
          name: profileLabel(bad) || t("settings.aiProfileUntitled"),
        });
        // 字段级错误只对「正在编辑的那条」可见；其他条目由上面这条汇总提示点名
        if (bad.id === editingProfileId.value) {
          if (!(bad.baseUrl || "").trim()) err.aiBase = t("settings.errAiBase");
          if (!(bad.apiKey || "").trim()) err.aiKey = t("settings.errAiKey");
          if (!(bad.model || "").trim()) err.aiModel = t("settings.errAiModel");
        }
      }
    }
  }
  if (form.value.typesafe.enabled) {
    // 地址留空是合法的（用官方端点），只有填了却不合法才拦
    const base = (form.value.typesafe.baseUrl || "").trim();
    if (base && !/^https?:\/\//.test(base)) err.typesafeBase = t("settings.errTypeSafeBase");
    if (!(form.value.typesafe.apiKey || "").trim()) err.typesafeKey = t("settings.errTypeSafeKey");
  }
  if (!NAV_MODULE_OPTIONS.some((m) => !form.value.ui.hiddenModules.includes(m.key)))
    err.navModules = t("settings.errNavModules");
  return err;
}

function blankProfile() {
  return { id: newProfileId(), name: "", baseUrl: "", apiKey: "", model: "", temperature: 0.7, reasoningEffort: "" };
}

function newSettings() {
  const profile = blankProfile();
  return {
    ai: { enabled: false, activeId: profile.id, profiles: [profile] },
    // 归一后的**完整形状**：保存是整组替换，表单里没有的字段会被写没，
    // 所以高级旋钮（bodyChars/stateBudget/置信度分档）即使不给渲染也要带上原值。
    typesafe: normalizeTypeSafe({}),
    ui: { density: "compact", hiddenModules: [], locale: "system" },
  };
}

const LOCALE_PREFS = ["system", "zh-CN", "en-US"];

/**
 * 回填闸门：为 true 时 dirty 的 watch 忽略一切变更（程序化回填不算用户的改动）。
 * 定义在 loadSettings **之前**——它虽因函数提升不会真的报错，但读代码的人不该
 * 先看到一个"未定义"的变量。语义见下方 watch 处的注释。
 */
let applying = false;

/**
 * 读盘并把 settings 组装成表单形状（解密敏感字段）。失败时回退到默认值并记下 loadError。
 * 抽出来是为了让 loadSettings 只剩「开闸 → 回填 → 关闸」三件事——回填的每一步都必须在
 * 闸门内完成，把它摊在 loadSettings 里会让人分不清哪几行属于回填、哪几行是别的初始化。
 */
async function readSettingsForm() {
  try {
    const s = (await invoke("load_data", { key: "settings" })) || {};
    // load_data 对缺失文件返回 []，只接受真正的对象作为合并基底
    rawSnapshot = s && typeof s === "object" && !Array.isArray(s) ? s : {};
    // TypeSafe 的高级旋钮只在这两处渲染其中几项，但表单必须持有**全部**归一后的值：
    // 保存时整组替换，漏带一项就会把用户在 settings.json 里手调过的高级值抹掉。
    const typesafeCfg = normalizeTypeSafe(s.typesafe);
    // 旧版单模型字段由 normalizeAi 迁成一条配置；这里逐条解密，编辑器拿到的都是明文草稿
    const aiCfg = normalizeAi(s.ai);
    const aiProfiles = [];
    for (const profile of aiCfg.profiles) {
      aiProfiles.push({ ...profile, apiKey: await decryptValue(profile.apiKey || "") });
    }
    if (!aiProfiles.length) aiProfiles.push(blankProfile());
    const aiActiveId = aiProfiles.some((p) => p.id === aiCfg.activeId) ? aiCfg.activeId : aiProfiles[0].id;
    form.value = {
      ai: { enabled: aiCfg.enabled, activeId: aiActiveId, profiles: aiProfiles },
      ui: {
        density: s.ui?.density === "comfort" ? "comfort" : "compact",
        hiddenModules: normalizeHiddenModules(NAV_MODULE_OPTIONS.map((m) => m.key), s.ui?.hiddenModules),
        locale: LOCALE_PREFS.includes(s.ui?.locale) ? s.ui.locale : "system",
      },
      typesafe: { ...typesafeCfg, apiKey: await decryptValue(typesafeCfg.apiKey) },
    };
    editingProfileId.value = aiActiveId;
    // 已有 Key 的配置：进页面就把模型列表拉出来（静默失败则保持手动输入）
    nextTick(maybeFetchModels);
  } catch (e) {
    form.value = newSettings();
    editingProfileId.value = form.value.ai.activeId;
    settingsLoadError.value = e && e.message ? e.message : String(e);
    props.showToast(t("settings.loadFailed", { err: settingsLoadError.value }));
  }
  if (capabilities.autostart) {
    try {
      autostartOn.value = !!(await invoke("autostart_status"));
    } catch (e) {
      // 读不到就按「关」显示：这是系统状态不是应用数据，不该因读失败而拦住整个设置页
      autostartOn.value = false;
    }
  }
  fieldErr.value = {};
}

// 进入设置页加载真实配置。
//
// 回填期间（applying = true）dirty 的 watch 一律忽略——见下方 watch 处的注释。
// 用 try/finally 而不是在尾部置 false：中间任何一个 await 抛错都不能把闸门留在关闭状态，
// 否则之后用户的真实改动不再标记未保存（比原来的 bug 更糟）。
async function loadSettings() {
  settingsLoadError.value = "";
  applying = true;
  try {
    await readSettingsForm();
  } finally {
    // 关闸门 + 把 dirty 归零。因为 watch 是 flush:"sync"（见下），回填的每一次赋值都已在
    // 当场被闸门拦下，这里不需要再 await 什么——少一个 await 就少一处时序推理，
    // 而「靠先后顺序消除副作用」正是这个 bug 的成因。
    applying = false;
    dirty.value = false;
  }
}
// 任意字段改动标记未保存。
//
// 程序化回填必须**显式豁免**（`applying` 闸门），不能靠「回填完再把 dirty 置回 false」——
// 那正是这里原先的写法，也是「一进设置页就显示有未保存修改」的根因：loadSettings 里有
// await（解密 apiKey、读开机启动状态），回填跨越了多个微任务，而 watch 是异步触发的，
// 于是 dirty = false 之后还有一批变更落进来，把标记又点亮。
// 而且 onMounted 里 loadSettings() 并没有被 await，回填与外层那些 async 初始化是并发的，
// 「谁后跑完」本身就不确定——用先后顺序来消除副作用，本质上就不可靠。
//
// 闸门写法把语义说清楚：**只有非回填期间的变化才算用户的改动**。
// flush: "sync" 让回调在赋值那一刻就同步跑掉，于是 loadSettings 的 finally 里关闸门
// 必然发生在全部回填之后——默认的 pre 队列会把回调推迟到组件更新前，
// 「关闸门与回调谁先谁后」又要靠推理，而那正是这个 bug 的成因。
watch(
  () => JSON.stringify({ f: form.value, a: autostartOn.value }),
  () => {
    if (applying) return;
    dirty.value = true;
  },
  { flush: "sync" }
);

async function save() {
  if (settingsLoadError.value) {
    props.showToast(t("settings.saveBlocked"));
    return;
  }
  fieldErr.value = validate();
  if (Object.keys(fieldErr.value).length) {
    // 出问题的不是当前编辑的配置时，自动切过去，否则用户看不到是哪个字段
    if (fieldErr.value.aiProfile) {
      const bad = invalidProfile();
      if (bad) {
        editingProfileId.value = bad.id;
        fieldErr.value = validate();
      }
    }
    props.showToast(t("settings.fixRequired", { err: Object.values(fieldErr.value)[0] }));
    return;
  }
  saving.value = true;
  try {
    // 在独立副本里加密，失败时不污染表单中的明文草稿。
    const formCopy = cloneJsonData(form.value);
    // 完全空白的草稿不落盘（用户点了「添加模型」但没填任何字段）
    const encryptedProfiles = [];
    for (const profile of formCopy.ai.profiles) {
      const blank = !(profile.name || "").trim() && !(profile.baseUrl || "").trim()
        && !(profile.apiKey || "").trim() && !(profile.model || "").trim();
      if (blank) continue;
      encryptedProfiles.push({ ...profile, apiKey: await encryptValue(profile.apiKey) });
    }
    const activeId = encryptedProfiles.some((p) => p.id === formCopy.ai.activeId)
      ? formCopy.ai.activeId
      : encryptedProfiles[0]?.id || "";
    formCopy.ai = toStoredAi({ enabled: formCopy.ai.enabled, activeId, profiles: encryptedProfiles });
    formCopy.typesafe.apiKey = await encryptValue(formCopy.typesafe.apiKey);
    // 重读磁盘作为合并基底：本页的云同步与遥测开关是即改即存、不经表单的，
    // 进页面时缓存的快照此时已过期，直接写会抹掉用户刚开启的配置。
    let base = rawSnapshot;
    try {
      const disk = await invoke("load_data", { key: "settings" });
      if (disk && typeof disk === "object" && !Array.isArray(disk)) base = disk;
    } catch (e) {
      // 重读失败退回进页面时的快照，仍比只写表单分组安全
    }
    const payload = mergeSettingsSnapshot(cloneJsonData(base), formCopy);
    await invoke("save_data", { key: "settings", data: payload });
    rawSnapshot = payload;
    // 空白草稿被丢弃后，表单里的默认指向也要跟着收敛
    form.value.ai.activeId = activeId;
    try {
      if (capabilities.autostart) await invoke("autostart_set", { enabled: autostartOn.value });
    } catch (e) {}
    window.dispatchEvent(new CustomEvent("settings-saved"));
    // 界面语言即时生效，无需重启。字典是按需加载的（首屏只打包当前语言），
    // 所以这里要 await：切到另一种语言时先把它的字典取回来再切，避免闪一堆词条 key。
    await applyLocale(form.value.ui.locale);
    dirty.value = false;
    props.showToast(t("settings.saved"));
  } catch (e) {
    props.showToast(t("settings.saveFailed", { err: e }));
  } finally {
    saving.value = false;
  }
}

// ------- 多模型配置：列表选中 / 新增 / 删除 / 设为默认 -------
function selectProfile(id) {
  editingProfileId.value = id;
  showKey.value = false;
  fieldErr.value = {};
  modelFetchError.value = "";
  // 切到另一套配置：已有地址与 Key 就顺手拉一次列表（有缓存则不重复请求）
  nextTick(maybeFetchModels);
}
function addProfile() {
  const profile = blankProfile();
  form.value.ai.profiles.push(profile);
  if (!form.value.ai.activeId) form.value.ai.activeId = profile.id;
  editingProfileId.value = profile.id;
  modelFetchError.value = "";
}
function removeProfile(id) {
  form.value.ai.profiles = form.value.ai.profiles.filter((p) => p.id !== id);
  if (form.value.ai.activeId === id) form.value.ai.activeId = form.value.ai.profiles[0]?.id || "";
  if (editingProfileId.value === id) editingProfileId.value = form.value.ai.profiles[0]?.id || "";
  const rest = { ...modelsByProfile.value };
  delete rest[id];
  modelsByProfile.value = rest;
}
function setActiveProfile(id) {
  form.value.ai.activeId = id;
}

/** 厂商下拉的分组（国际 / 国内 / 聚合 / 本地），目录来自 agent/modelCatalog.js。 */
const providerGroups = computed(() =>
  PROVIDER_GROUPS.map((group) => ({ ...group, items: AI_PRESETS.filter((p) => p.group === group.key) }))
);

/** 当前配置对应的服务商键：匹配内置预设，匹配不上就是自定义端点。 */
const editingProviderKey = computed({
  get: () => {
    const base = (editingProfile.value?.baseUrl || "").trim().replace(/\/+$/, "");
    return AI_PRESETS.find((p) => p.baseUrl === base)?.key || "custom";
  },
  set: (key) => {
    const target = editingProfile.value;
    if (!target) return;
    if (key === "custom") {
      // 从预设切到自定义：清掉预设地址，让输入框直接可用；本来就是自定义则保留
      if (AI_PRESETS.some((p) => p.baseUrl === target.baseUrl)) target.baseUrl = "";
      modelFetchError.value = "";
      return;
    }
    const preset = AI_PRESETS.find((p) => p.key === key);
    if (preset) applyAIPreset(preset);
  },
});

/**
 * 从端点拉模型列表（GET /models）。静默模式用于「填完 Key 失焦/换预设/进页面」的自动获取：
 * 失败不弹错、不占提示位——手动输入框还在，用户不会卡住。
 */
async function fetchModels({ silent = false } = {}) {
  const profile = editingProfile.value;
  if (!profile) return;
  const baseUrl = (profile.baseUrl || "").trim();
  const apiKey = (profile.apiKey || "").trim();
  if (!baseUrl || !apiKey) {
    if (!silent) props.showToast(t("settings.aiFetchNeedConfig"));
    return;
  }
  const token = ++modelFetchToken;
  fetchingModels.value = true;
  if (!silent) modelFetchError.value = "";
  try {
    const list = await listAIModels({ baseUrl, apiKey });
    if (token !== modelFetchToken) return;
    modelsByProfile.value = { ...modelsByProfile.value, [profile.id]: { key: cacheKeyOf(profile), list } };
    if (!String(profile.model || "").trim()) profile.model = list[0];
    if (!silent) props.showToast(t("settings.aiFetchOk", { n: list.length }));
  } catch (e) {
    if (token !== modelFetchToken) return;
    if (!silent) modelFetchError.value = t("settings.aiFetchFail", { err: e?.message || String(e) });
  } finally {
    if (token === modelFetchToken) fetchingModels.value = false;
  }
}

function maybeFetchModels() {
  const profile = editingProfile.value;
  if (!profile || fetchingModels.value) return;
  if (!(profile.baseUrl || "").trim() || !(profile.apiKey || "").trim()) return;
  const entry = modelsByProfile.value[profile.id];
  if (entry && entry.key === cacheKeyOf(profile)) return;
  fetchModels({ silent: true });
}

function applyAIPreset(p) {
  const target = editingProfile.value;
  if (!target) return;
  const changed = target.baseUrl !== p.baseUrl;
  target.baseUrl = p.baseUrl;
  // 换厂商时模型名跟着换（旧厂商的模型名在新端点上通常必然 404）；同厂商不覆盖用户选择
  if (changed || !target.model) target.model = p.model;
  // 本地服务（Ollama）不需要真实密钥，但配置校验要求非空；不覆盖用户已填的值
  if (p.apiKey && !target.apiKey) target.apiKey = p.apiKey;
  // 换了端点：旧列表自然作废；Key 已在的话顺手拉一次
  modelFetchError.value = "";
  nextTick(maybeFetchModels);
}

async function testAIConn() {
  const target = editingProfile.value;
  if (!target) return;
  testingAI.value = true;
  try {
    const cfg = {
      baseUrl: (target.baseUrl || "").trim().replace(/\/$/, ""),
      apiKey: (target.apiKey || "").trim(),
      model: (target.model || "").trim(),
      temperature: 0,
      reasoningEffort: (target.reasoningEffort || "").trim(),
    };
    const reply = await testAI(cfg);
    props.showToast(t("settings.aiTestOk", { reply }));
  } catch (e) {
    props.showToast(t("settings.aiTestFail", { err: e && e.message ? e.message : e }));
  } finally {
    testingAI.value = false;
  }
}

// 测试 TypeSafe：发一个最小探针请求，把模型名与概率显示出来。
// 与「测试 AI」分开是因为两者端点形状不同（System One vs Chat Completions），
// 复用同一个按钮只会让人以为是同一个服务。
async function testTypeSafeConn() {
  testingTypeSafe.value = true;
  try {
    const cfg = {
      baseUrl: (form.value.typesafe.baseUrl || "").trim().replace(/\/$/, ""),
      apiKey: (form.value.typesafe.apiKey || "").trim(),
      model: (form.value.typesafe.model || "").trim(),
      // 带上未保存的超时值：测试连接的作用就是验「这样配下去行不行」，
      // 用旧默认值去验一个改了超时的配置，测出来的结论对不上实际运行。
      timeoutMs: normalizeTypeSafe({ timeoutMs: form.value.typesafe.timeoutMs }).timeoutMs,
    };
    const { model, noul } = await testTypeSafe(cfg);
    props.showToast(t("settings.typesafeTestOk", { model, noul: noul.toFixed(2) }));
  } catch (e) {
    props.showToast(t("settings.typesafeTestFail", { err: e && e.message ? e.message : e }));
  } finally {
    testingTypeSafe.value = false;
  }
}

const appVersion = pkg.version;
const checkingUpdate = ref(false);
async function checkUpdateNow() {
  checkingUpdate.value = true;
  try {
    await checkForUpdate({ silent: false, showToast: props.showToast });
  } finally {
    checkingUpdate.value = false;
  }
}

const backingUp = ref(false);
const restoring = ref(false);
async function backupNow() {
  const p = (n) => String(n).padStart(2, "0");
  const d = new Date();
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  try {
    const dest = await saveDialog({
      title: t("settings.backupDlgTitle"),
      defaultPath: `toolcove-backup-${stamp}.zip`,
      filters: [{ name: "Zip", extensions: ["zip"] }],
    });
    if (!dest) return;
    backingUp.value = true;
    const summary = await invoke("backup_data", { dest });
    props.showToast(t("settings.backupDone", { summary }));
  } catch (e) {
    props.showToast(t("settings.backupFailed", { err: e }));
  } finally {
    backingUp.value = false;
  }
}

async function restoreNow() {
  const source = await openDialog({
    multiple: false,
    directory: false,
    title: t("settings.restoreDlgTitle"),
    filters: [{ name: "Zip", extensions: ["zip"] }],
  });
  if (typeof source !== "string" || !source) return;
  const ok = await askConfirm({
    title: t("settings.restoreConfirmTitle"),
    message: t("settings.restoreConfirmMsg"),
    okText: t("settings.restoreOk"),
  });
  if (!ok) return;
  restoring.value = true;
  try {
    await flushSecureToolbox();
    await flushToolbox();
    const summary = await invoke("restore_data", { source });
    props.showToast(t("settings.restoreDone", { summary }), { duration: 5000 });
    await relaunch();
  } catch (e) {
    props.showToast(t("settings.restoreFailed", { err: e }), { duration: 5000 });
  } finally {
    restoring.value = false;
  }
}
</script>

<template>
  <div class="settings-view">
    <!-- 左侧分类导航（Qoder Work 式设置页） -->
    <aside class="sv-side">
      <div class="sv-title">{{ t("nav.settings") }}</div>
      <button
        v-for="s in sections"
        :key="s.key"
        class="sv-nav"
        :class="{ on: section === s.key }"
        :title="t(s.descKey)"
        @click="section = s.key"
      >
        <Icon :name="s.icon" :size="17" />
        <span class="sv-nav-label">{{ t(s.labelKey) }}</span>
      </button>
      <div class="sv-foot">
        <span class="ver-tag">v{{ appVersion }}</span>
      </div>
    </aside>

    <!-- 右侧内容区 -->
    <main class="sv-main">
      <div class="sv-bar">
        <div class="sv-bar-txt">
          <b>{{ t(currentMeta.labelKey) }}</b>
          <span class="sv-desc">{{ t(currentMeta.descKey) }}</span>
          <span v-if="dirty" class="sv-dirty">{{ t("settings.dirty") }}</span>
        </div>
        <button class="btn-primary sm" :disabled="saving" @click="save">
          <Icon name="check" :size="14" /> {{ saving ? t("settings.saving") : t("settings.save") }}
        </button>
      </div>

      <div class="sv-body">
        <!-- ============ AI 模型 ============ -->
        <div v-show="section === 'ai'" class="sect">
          <div class="sect-head">
            <span class="sect-title"><Icon name="sparkles" :size="15" class="sect-ico" /> {{ t("settings.aiTitle") }}</span>
            <label class="switch">
              <input type="checkbox" v-model="form.ai.enabled" />
              <span class="track"></span>
              <span>{{ t("settings.aiEnable") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("settings.aiDesc") }}</p>

          <!-- 已保存的配置：一行一套；点行编辑，「设为默认」决定下一次运行用哪套 -->
          <div class="ai-profiles" role="list">
            <div
              v-for="p in form.ai.profiles"
              :key="p.id"
              class="ai-profile"
              :class="{ on: editingProfileId === p.id }"
              role="listitem"
              data-role="ai-profile"
            >
              <button type="button" class="ai-profile-main" @click="selectProfile(p.id)">
                <span class="ai-profile-name">{{ profileLabel(p) || t("settings.aiProfileUntitled") }}</span>
                <span class="ai-profile-meta">
                  {{ p.model || t("settings.aiModelUnset") }}<template v-if="p.baseUrl"> · {{ p.baseUrl }}</template>
                </span>
              </button>
              <span v-if="form.ai.activeId === p.id" class="ai-profile-badge">{{ t("settings.aiProfileActive") }}</span>
              <button v-else type="button" class="btn-ghost sm" data-role="ai-profile-use" @click="setActiveProfile(p.id)">{{ t("settings.aiProfileUse") }}</button>
              <button
                type="button"
                class="btn-ghost sm"
                data-role="ai-profile-remove"
                :title="t('settings.aiProfileRemove')"
                :aria-label="t('settings.aiProfileRemove')"
                @click="removeProfile(p.id)"
              >
                <Icon name="trash" :size="13" />
              </button>
            </div>
            <p v-if="!form.ai.profiles.length" class="ai-profile-empty">{{ t("settings.aiProfileEmpty") }}</p>
          </div>
          <button type="button" class="btn-ghost sm" data-role="ai-profile-add" @click="addProfile">
            <Icon name="plus" :size="14" /> {{ t("settings.aiProfileAdd") }}
          </button>

          <template v-if="editingProfile">
            <p v-if="fieldErr.aiProfile" class="field-err ai-profile-err">{{ fieldErr.aiProfile }}</p>

            <!-- 厂商下拉：选中即填好内置地址；只有「自定义端点」才需要手填地址 -->
            <label class="field">
              <span>{{ t("settings.aiProvider") }}</span>
              <select v-model="editingProviderKey" class="select" data-role="ai-provider">
                <optgroup v-for="group in providerGroups" :key="group.key" :label="t(group.labelKey)">
                  <option v-for="p in group.items" :key="p.key" :value="p.key">{{ t(p.labelKey) }}</option>
                </optgroup>
                <option value="custom">{{ t("settings.aiProviderCustom") }}</option>
              </select>
              <span v-if="editingProviderKey !== 'custom'" class="field-hint">{{ editingProfile.baseUrl }}</span>
            </label>

            <label v-if="editingProviderKey === 'custom'" class="field" :class="{ err: fieldErr.aiBase }" v-field-error="fieldErr.aiBase">
              <span>{{ t("settings.aiBaseUrl") }}</span>
              <input v-model="editingProfile.baseUrl" :placeholder="t('settings.aiBaseUrlPh')" @blur="maybeFetchModels" />
              <span v-if="fieldErr.aiBase" class="field-err">{{ fieldErr.aiBase }}</span>
            </label>

            <label class="field" :class="{ err: fieldErr.aiKey }" v-field-error="fieldErr.aiKey">
              <span>{{ t("settings.aiKey") }}</span>
              <div class="token-row">
                <input
                  :type="showKey ? 'text' : 'password'"
                  v-model="editingProfile.apiKey"
                  :placeholder="t('settings.aiKeyPh')"
                  autocomplete="off"
                  @blur="maybeFetchModels"
                />
                <button type="button" class="btn-ghost sm" @click="showKey = !showKey">
                  <Icon :name="showKey ? 'x' : 'open'" :size="14" /> {{ showKey ? t("settings.hide") : t("settings.show") }}
                </button>
              </div>
              <span v-if="fieldErr.aiKey" class="field-err">{{ fieldErr.aiKey }}</span>
            </label>

            <!-- 模型：填完 Key 自动从端点拉取；拉不到就退回手动输入 -->
            <label class="field" :class="{ err: fieldErr.aiModel }" v-field-error="fieldErr.aiModel">
              <span>{{ t("settings.aiModel") }}</span>
              <div class="token-row">
                <select v-if="modelChoices.length" v-model="editingProfile.model" class="select" data-role="ai-model-select">
                  <option v-for="m in modelChoices" :key="m" :value="m">{{ m }}</option>
                </select>
                <input v-else v-model="editingProfile.model" :placeholder="t('settings.aiModelPh')" />
                <button
                  type="button"
                  class="btn-ghost sm"
                  :disabled="fetchingModels"
                  data-role="ai-fetch-models"
                  @click="fetchModels()"
                >
                  <Icon name="refresh" :size="14" />
                  {{ fetchingModels ? t("settings.aiFetching") : fetchedModels.length ? t("settings.aiRefreshModels") : t("settings.aiFetchModels") }}
                </button>
              </div>
              <span v-if="modelFetchError" class="field-err">{{ modelFetchError }}</span>
              <span v-if="fieldErr.aiModel" class="field-err">{{ fieldErr.aiModel }}</span>
              <span v-else-if="fetchedModels.length" class="field-hint">{{ t("settings.aiModelsFound", { n: fetchedModels.length }) }}</span>
            </label>

            <!-- 低频项收进高级：名称、手动覆盖模型、推理档位、温度、连接测试 -->
            <details class="ai-advanced">
              <summary>{{ t("settings.aiAdvanced") }}</summary>

              <label class="field">
                <span>{{ t("settings.aiProfileName") }}</span>
                <input v-model="editingProfile.name" :placeholder="t('settings.aiProfileNamePh')" />
              </label>

              <label class="field">
                <span>{{ t("settings.aiModelManual") }}</span>
                <input v-model="editingProfile.model" :placeholder="t('settings.aiModelPh')" />
              </label>

              <label class="field">
                <span>{{ t("settings.aiReason") }}</span>
                <select v-model="editingProfile.reasoningEffort" class="select">
                  <option value="">{{ t("settings.aiReasonNone") }}</option>
                  <option value="minimal">{{ t("settings.aiReasonFastest") }}</option>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                  <option value="xhigh">{{ t("settings.aiReasonXhigh") }}</option>
                </select>
              </label>

              <label class="field" v-if="!editingProfile.reasoningEffort">
                <span>{{ t("settings.aiTemp", { value: Number(editingProfile.temperature).toFixed(1) }) }}</span>
                <input type="range" min="0" max="1" step="0.1" v-model.number="editingProfile.temperature" class="range" />
              </label>

              <div class="sect-foot">
                <button class="btn-ghost sm" :disabled="testingAI" @click="testAIConn"><Icon name="sparkles" :size="14" /> {{ testingAI ? t("settings.aiTesting") : t("settings.aiTest") }}</button>
              </div>
            </details>
          </template>
        </div>
        <!-- ============ TypeSafe 语义判断（可选增强，未启用/失败自动退回关键词匹配） ============ -->
        <div v-show="section === 'ai'" class="sect">
          <div class="sect-head">
            <span class="sect-title"><Icon name="sparkles" :size="15" class="sect-ico" /> {{ t("settings.typesafeTitle") }}</span>
            <label class="switch">
              <input type="checkbox" v-model="form.typesafe.enabled" />
              <span class="track"></span>
              <span>{{ t("settings.typesafeEnable") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("settings.typesafeDesc") }}</p>

          <label class="field" :class="{ err: fieldErr.typesafeBase }" v-field-error="fieldErr.typesafeBase">
            <span>{{ t("settings.typesafeBaseUrl") }}</span>
            <input v-model="form.typesafe.baseUrl" :placeholder="t('settings.typesafeBaseUrlPh')" />
            <span v-if="fieldErr.typesafeBase" class="field-err">{{ fieldErr.typesafeBase }}</span>
          </label>

          <label class="field">
            <span>{{ t("settings.typesafeModel") }}</span>
            <input v-model="form.typesafe.model" :placeholder="t('settings.typesafeModelPh')" />
          </label>

          <label class="field">
            <span>{{ t("settings.typesafeTimeout") }}</span>
            <input type="number" min="1000" max="30000" step="500" v-model="form.typesafe.timeoutMs" :placeholder="t('settings.typesafeTimeoutPh')" />
          </label>

          <p class="sect-desc">{{ t("settings.typesafeTuningDesc") }}</p>
          <div class="field-row">
            <label class="field">
              <span>{{ t("settings.typesafeGate") }}</span>
              <input type="number" min="0" max="1" step="0.05" v-model="form.typesafe.gate" placeholder="0.3" />
            </label>
            <label class="field">
              <span>{{ t("settings.typesafeFloor") }}</span>
              <input type="number" min="0" max="1" step="0.05" v-model="form.typesafe.floor" placeholder="0.15" />
            </label>
            <label class="field">
              <span>{{ t("settings.typesafeLimit") }}</span>
              <input type="number" min="1" max="10" step="1" v-model="form.typesafe.limit" placeholder="3" />
            </label>
          </div>

          <label class="field" :class="{ err: fieldErr.typesafeKey }" v-field-error="fieldErr.typesafeKey">
            <span>{{ t("settings.typesafeKey") }}</span>
            <div class="token-row">
              <input
                :type="showTypeSafeKey ? 'text' : 'password'"
                v-model="form.typesafe.apiKey"
                :placeholder="t('settings.typesafeKeyPh')"
                autocomplete="off"
              />
              <button type="button" class="btn-ghost sm" @click="showTypeSafeKey = !showTypeSafeKey">
                <Icon :name="showTypeSafeKey ? 'x' : 'open'" :size="14" /> {{ showTypeSafeKey ? t("settings.hide") : t("settings.show") }}
              </button>
            </div>
            <span v-if="fieldErr.typesafeKey" class="field-err">{{ fieldErr.typesafeKey }}</span>
          </label>

          <div class="sect-foot">
            <button class="btn-ghost sm" :disabled="testingTypeSafe" @click="testTypeSafeConn"><Icon name="sparkles" :size="14" /> {{ testingTypeSafe ? t("settings.typesafeTesting") : t("settings.typesafeTest") }}</button>
          </div>
        </div>
        <!-- ============ Agent（运行上限 / 确认策略 / 工具开关 / 技能库 / 溢出结果区） ============
             这一节整体即改即存：没有「保存」按钮，也没有 dirty 标记（表单只渲染 ai / ui）。 -->
        <div v-show="section === 'agent'" class="sect agent">
          <div class="sect-head">
            <span class="sect-title"><Icon name="zap" :size="15" class="sect-ico" /> {{ t("settings.agentRunTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.agentRunDesc") }}</p>
          <div class="grid2">
            <label class="field">
              <span>{{ t("settings.agentMaxSteps") }}</span>
              <input
                type="number"
                min="1"
                :max="AGENT_MAX_STEPS_HARD_CAP"
                step="1"
                v-model.number="agentMaxSteps"
                @change="onRunLimitChange('maxSteps')"
              />
            </label>
            <label class="field">
              <span>{{ t("settings.agentRetries") }}</span>
              <input
                type="number"
                min="0"
                :max="AGENT_MAX_RETRIES"
                step="1"
                v-model.number="agentRetries"
                @change="onRunLimitChange('retries')"
              />
            </label>
          </div>

          <div class="sect-head admin-sub">
            <span class="sect-title"><Icon name="alert" :size="15" class="sect-ico" /> {{ t("settings.agentConfirmTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.agentConfirmDesc") }}</p>
          <!-- 三选一用预设胶囊而不是 select：三种模式的差别（风险 / 频率）要一眼可比，
               select 只能看到当前选中的那一项。与 AI 预设同一套 .preset-chip。 -->
          <div class="presets">
            <button
              v-for="p in AGENT_CONFIRM_POLICIES"
              :key="p"
              type="button"
              class="preset-chip"
              :class="{ on: agentSession.cfg?.requireConfirmation === p }"
              @click="saveAgentPatch({ requireConfirmation: p })"
            >{{ t(CONFIRM_LABEL_KEY[p]) }}</button>
          </div>

          <div class="sect-head admin-sub">
            <span class="sect-title"><Icon name="grid" :size="15" class="sect-ico" /> {{ t("settings.agentToolsTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.agentToolsDesc", { n: agentToolCount.enabled, total: agentToolCount.total }) }}</p>
          <div v-for="group in agentToolGroups" :key="group.risk" class="agent-group">
            <div class="agent-group-title">
              <span class="tc-chip sm" :class="riskChip(group.risk)">{{ t(riskKey(group.risk)) }}</span>
              <span class="agent-group-count">{{ group.tools.length }}</span>
            </div>
            <div v-for="tool in group.tools" :key="tool.name" class="agent-tool-row" :class="{ off: !tool.enabled }">
              <div class="agent-tool-main">
                <code class="agent-tool-name">{{ tool.name }}</code>
                <!-- 缺词条的目录项退化成工具名（与工作台同一判据），不显示成空行 -->
                <span class="agent-tool-desc">{{ tool.descriptionKey ? t(tool.descriptionKey) : tool.name }}</span>
              </div>
              <div class="agent-tool-side">
                <button v-if="tool.toolKey" type="button" class="link-btn" :title="t('agent.capOpenTool')" @click="openToolManual(tool.toolKey)">
                  <Icon name="open" :size="13" />
                </button>
                <label class="switch" :title="t('agent.capEnabled')">
                  <input type="checkbox" :checked="tool.enabled" @change="onToggleAgentTool(tool)" />
                  <span class="track"></span>
                </label>
              </div>
            </div>
          </div>

          <!-- 技能库：单独包一层 .agent-skills。技能行与工具行共用 .agent-tool-row 的观感，
               但语义上是两个清单（一个来自目录、一个来自用户沉淀），e2e 与样式都需要一个边界，
               否则「在技能里点第一个开关」会选到上面工具清单里的第一个。 -->
          <div class="agent-skills">
            <div class="sect-head admin-sub">
              <span class="sect-title"><Icon name="archive" :size="15" class="sect-ico" /> {{ t("agent.capSkills") }}</span>
              <span class="agent-group-count">{{ agentSession.skills.length }}</span>
            </div>
            <p class="sect-desc">{{ t("agent.capSkillsDesc") }}</p>
            <p v-if="!agentSession.skills.length" class="sect-desc sub">{{ t("agent.skillEmpty") }}</p>
            <div v-for="skill in agentSession.skills" :key="skill.id" class="agent-tool-row" :class="{ off: skillDisabled(skill.id) }">
              <div class="agent-tool-main">
                <code class="agent-tool-name">{{ skill.name }}</code>
                <span class="agent-tool-desc">{{ skill.description || t("agent.skillNoDesc") }}</span>
              </div>
              <div class="agent-tool-side">
                <button type="button" class="link-btn danger" :title="t('agent.skillDelete')" @click="onDeleteSkill(skill)">
                  <Icon name="trash" :size="13" />
                </button>
                <label class="switch" :title="t('agent.skillToggle')">
                  <input type="checkbox" :checked="!skillDisabled(skill.id)" @change="onToggleSkill(skill)" />
                  <span class="track"></span>
                </label>
              </div>
            </div>
          </div>

          <div class="sect-head admin-sub">
            <span class="sect-title"><Icon name="box" :size="15" class="sect-ico" /> {{ t("agent.capSpills") }}</span>
          </div>
          <p class="sect-desc">{{ t("agent.capSpillsDesc") }}</p>
          <div class="sect-foot">
            <!-- 运行中禁用：正在跑的那次运行可能还要读回自己的大结果 -->
            <button class="btn-ghost sm" :disabled="agentBusy" @click="onClearSpills">
              <Icon name="trash" :size="14" /> {{ t("agent.spillClear") }}
            </button>
          </div>
        </div>
        <!-- ============ 云同步（端到端加密，免费内置） ============ -->
        <div v-if="capabilities.cloudSync" v-show="section === 'sync'" class="sect sync">
          <div class="sect-head">
            <span class="sect-title"><Icon name="refresh" :size="15" class="sect-ico" /> {{ t("sync.title") }}</span>
            <label class="switch">
              <input type="checkbox" :checked="syncCfg && syncCfg.enabled" @change="toggleSync" />
              <span class="track"></span>
              <span>{{ t("sync.enable") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("sync.desc") }}</p>

          <!-- 服务器地址与配对（未入伙时） -->
          <template v-if="!syncCfg || !syncCfg.collectionId">
            <label class="field">
              <span>{{ t("sync.serverUrl") }}</span>
              <input v-model="syncField" :placeholder="t('sync.serverUrlPh')" />
            </label>
            <p v-if="syncField && !syncField.startsWith('https://')" class="field-err">{{ t("sync.serverUrlHttpWarn") }}</p>
            <label class="field">
              <span>{{ t("sync.syncPasswordPh") }} <span class="faint-hint">{{ t("sync.syncPasswordHint") }}</span></span>
              <div class="token-row">
                <input :type="showSyncPassword ? 'text' : 'password'" v-model="syncPassword" :placeholder="t('sync.syncPasswordPh')" autocomplete="new-password" />
                <button type="button" class="btn-ghost sm" @click="showSyncPassword = !showSyncPassword">{{ showSyncPassword ? t("settings.hide") : t("settings.show") }}</button>
              </div>
            </label>
            <div class="sync-actions">
              <button class="btn-primary sm" :disabled="syncBusy" @click="doCreateSync"><Icon name="plus" :size="14" /> {{ t("sync.createBtn") }}</button>
              <span class="sync-or">{{ t("sync.or") }}</span>
              <input v-model="syncJoinId" :placeholder="t('sync.joinIdPh')" class="lic-input sm-input" />
              <input v-model="syncCodeInput" :placeholder="t('sync.joinCodePh')" class="lic-input sm-input" />
              <button class="btn-ghost sm" :disabled="syncBusy" @click="doJoinSync"><Icon name="link" :size="14" /> {{ t("sync.joinBtn") }}</button>
            </div>
            <p v-if="syncErrKey && !syncCfg.collectionId" class="field-err">{{ t(syncErrKey) }}</p>
          </template>

          <!-- 已入伙：状态 + 配对码 + 设备 + 操作 -->
          <template v-else>
            <div class="sync-state" :class="syncStatus">
              <span class="sync-dot"></span>
              <span>{{ t(statusKey(syncStatus)) }}<template v-if="syncCfg.lastSyncAt"> · {{ t("sync.lastSyncAt", { time: fmtSyncTime(syncCfg.lastSyncAt) }) }}</template></span>
            </div>

            <div class="sync-actions">
              <button class="btn-primary sm" :disabled="syncBusy" @click="doSyncNow"><Icon name="refresh" :size="14" /> {{ t("sync.syncNowBtn") }}</button>
              <button class="btn-ghost sm" @click="doRegenCode"><Icon name="repeat" :size="14" /> {{ t("sync.regenCodeBtn") }}</button>
            </div>
            <div v-if="pairingResult.code" class="pairing-box">
              <div class="pairing-code" @click="copyPairing">{{ pairingResult.code }}</div>
              <p class="sect-desc">{{ t("sync.pairingCodeHint") }}</p>
            </div>

            <div class="devices-box">
              <div class="sect-title sm-title">{{ t("sync.devicesTitle") }}</div>
              <div v-for="d in syncDevices" :key="d.tokenHash" class="device-row">
                <Icon name="laptop" :size="14" />
                <span class="dev-name">{{ d.name }}{{ d.self ? t("sync.selfTag") : "" }}</span>
                <span class="dev-tail">{{ d.tokenTail }}</span>
                <button class="btn-danger xs" :disabled="syncBusy" @click="doRevoke(d.tokenHash, d.self)">{{ t("sync.revokeBtn") }}</button>
              </div>
              <p v-if="!syncDevices.length" class="sect-desc">{{ t("sync.noDevices") }}</p>
            </div>
            <p v-if="syncErrKey" class="field-err">{{ t(syncErrKey) }}</p>
            <p class="sect-desc sub">{{ t("sync.viewTip") }}</p>
          </template>
        </div>

        <!-- ============ 企业服务器（二期：数据桥接企业服务器，配置存本地） ============ -->
        <div v-show="section === 'enterprise'" class="sect">
          <div class="sect-head">
            <span class="sect-title"><Icon name="network" :size="15" class="sect-ico" /> {{ t("settings.enterpriseTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.enterpriseHint") }}</p>

          <div class="sync-state" :class="{ idle: entState === 'ok', error: entState === 'fail' }">
            <span class="sync-dot"></span>
            <span v-if="entState === 'ok'">{{ t("settings.enterpriseStatusOk") }}{{ entName ? ` · ${entName}` : "" }}</span>
            <span v-else-if="entState === 'fail'">{{ t("settings.enterpriseStatusFail", { err: entErr }) }}</span>
            <span v-else>{{ t("settings.enterpriseStatusNone") }}</span>
          </div>

          <label class="field">
            <span>{{ t("settings.enterpriseUrl") }}</span>
            <input v-model="entUrl" :placeholder="t('settings.enterpriseUrlPh')" autocomplete="off" />
          </label>

          <label class="field">
            <span>{{ t("settings.enterpriseToken") }}</span>
            <div class="token-row">
              <input
                :type="showEntToken ? 'text' : 'password'"
                v-model="entToken"
                :placeholder="t('settings.enterpriseTokenPh')"
                autocomplete="off"
              />
              <button type="button" class="btn-ghost sm" @click="showEntToken = !showEntToken">
                <Icon :name="showEntToken ? 'x' : 'open'" :size="14" /> {{ showEntToken ? t("settings.hide") : t("settings.show") }}
              </button>
            </div>
          </label>

          <div class="sect-foot">
            <button class="btn-primary sm" :disabled="entTesting" @click="doEntTest">
              <Icon name="link" :size="14" /> {{ entTesting ? t("settings.enterpriseTesting") : t("settings.enterpriseTest") }}
            </button>
            <button v-if="entConfigured" class="btn-ghost sm" :disabled="entTesting" @click="doEntDisconnect">
              <Icon name="x" :size="14" /> {{ t("settings.enterpriseDisconnect") }}
            </button>
          </div>
        </div>

        <!-- ============ 管理（企业态专属：权限门禁 + 操作审计留痕） ============ -->
        <div v-show="section === 'admin'" class="sect admin">
          <div class="sect-head">
            <span class="sect-title"><Icon name="shield" :size="15" class="sect-ico" /> {{ t("settings.adminToolsTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.adminToolsDesc") }}</p>
          <div v-for="group in policyGroups" :key="group.key" class="admin-group">
            <div class="admin-group-title">{{ t(group.labelKey) }}</div>
            <label v-for="tool in group.tools" :key="tool.key" class="admin-tool-row">
              <span class="admin-tool-name">{{ t(tool.labelKey) }}</span>
              <span class="switch">
                <input type="checkbox" :checked="isToolAllowed(tool.key)" @change="toggleToolPolicy(tool.key, $event.target.checked)" />
                <span class="track"></span>
              </span>
            </label>
          </div>

          <div class="sect-head admin-sub">
            <span class="sect-title"><Icon name="gauge" :size="15" class="sect-ico" /> {{ t("settings.adminRiskTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.adminRiskDesc") }}</p>
          <label class="field">
            <span>{{ t("settings.adminRiskLabel") }}</span>
            <select class="select" :value="policy.maxRisk || ''" @change="changeMaxRisk($event.target.value)">
              <option value="">{{ t("settings.adminRiskNone") }}</option>
              <option v-for="risk in RISK_LEVELS" :key="risk" :value="risk">{{ t("settings.adminRiskUpTo", { level: t(riskLabelKey(risk)) }) }}</option>
            </select>
          </label>

          <div class="sect-head admin-sub">
            <span class="sect-title"><Icon name="archive" :size="15" class="sect-ico" /> {{ t("settings.adminAuditTitle") }}</span>
            <div class="admin-audit-actions">
              <button class="btn-ghost sm" :disabled="!auditRows.length" @click="exportAuditLog">
                <Icon name="download" :size="14" /> {{ t("settings.adminAuditExport") }}
              </button>
              <button class="btn-danger" :disabled="!auditRows.length" @click="clearAuditLog">
                <Icon name="trash" :size="14" /> {{ t("settings.adminAuditClear") }}
              </button>
            </div>
          </div>
          <p class="sect-desc">{{ t("settings.adminAuditDesc") }}</p>
          <p v-if="!auditRows.length" class="sect-desc sub">{{ t("settings.adminAuditEmpty") }}</p>
          <div v-else class="audit-list">
            <div v-for="row in auditRows" :key="row.id" class="audit-row">
              <span class="audit-time">{{ fmtAuditTime(row.ts) }}</span>
              <span class="audit-goal" :title="row.goal">{{ row.goal }}</span>
              <span class="audit-tool">{{ row.tool }}</span>
              <span class="audit-risk">{{ t(riskLabelKey(row.risk)) }}</span>
              <span class="audit-badge" :class="row.decision">{{ t(auditDecisionKey(row.decision)) }}</span>
              <span class="audit-source">{{ t(auditSourceKey(row.source)) }}</span>
            </div>
          </div>

          <!-- 成员/席位管理：仅企业态的管理员可用；非管理员时块内说明原因而不是隐藏 -->
          <MembersPanel
            :members="members"
            :self-name="entName"
            :is-admin="entRole === 'admin'"
            :busy="membersBusy"
            :new-token="newMemberToken"
            @create="createMember"
            @revoke="revokeMember"
            @dismiss-token="newMemberToken = ''"
          />
          <p v-if="membersErr" class="field-err">{{ memberErrorText(membersErr) }}</p>
        </div>

        <!-- ============ 赞助与开源（全面免费，自愿支持） ============ -->
        <div v-show="section === 'sponsor'" class="sect sponsor">
          <div class="sect-head">
            <span class="sect-title"><Icon name="heart" :size="15" class="sect-ico" /> {{ t("sponsor.title") }}</span>
            <span class="free-tag">{{ t("sponsor.freeTag") }}</span>
          </div>
          <p class="sect-desc">{{ t("sponsor.desc") }}</p>

          <div class="sponsor-card">
            <div class="sponsor-ico"><Icon name="heart" :size="22" /></div>
            <div class="sponsor-txt">
              <b>{{ t("sponsor.whyTitle") }}</b>
              <p>{{ t("sponsor.whyBody") }}</p>
            </div>
          </div>

          <div class="sect-foot">
            <button class="btn-primary sm" @click="openAfdian"><Icon name="heart" :size="14" /> {{ t("sponsor.afdianBtn") }}</button>
            <button class="btn-ghost sm" @click="openRepo"><Icon name="star" :size="14" /> {{ t("sponsor.starBtn") }}</button>
            <span class="sect-desc inline">{{ t("sponsor.afdianHint") }}</span>
          </div>

          <div class="oss-box">
            <div class="sect-title sm-title">{{ t("sponsor.ossTitle") }}</div>
            <p class="sect-desc">{{ t("sponsor.ossDesc") }}</p>
          </div>
        </div>


        <!-- ============ 系统设置 ============ -->
        <div v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="palette" :size="15" /> {{ t("settings.accentTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.accentDesc") }}</p>
          <div class="accent-row">
            <button
              v-for="p in ACCENT_PRESETS"
              :key="p.key"
              type="button"
              class="accent-dot"
              :class="{ on: accentKey === p.key }"
              :style="{ background: p.light['--primary'] }"
              :title="t(p.labelKey)"
              @click="pickAccent(p.key)"
            ></button>
            <button type="button" class="btn-ghost sm" @click="pickAccent('')">{{ t("settings.accentDefault") }}</button>
          </div>
        </div>

        <div v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="grid" :size="15" /> {{ t("settings.densityTitle") }}</span>
            <select v-model="form.ui.density" class="density-sel">
              <option value="compact">{{ t("settings.densityCompact") }}</option>
              <option value="comfort">{{ t("settings.densityComfort") }}</option>
            </select>
          </div>
          <p class="sect-desc">{{ t("settings.densityDesc") }}</p>
        </div>

        <div v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="eye" :size="15" /> {{ t("settings.navModulesTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.navModulesDesc") }}</p>
          <div class="nav-mod-grid">
            <label v-for="m in NAV_MODULE_OPTIONS" :key="m.key" class="switch">
              <input type="checkbox" :checked="isNavModuleVisible(m.key)" @change="toggleNavModule(m.key, $event.target.checked)" />
              <span class="track"></span>
              <span>{{ t(m.labelKey) }}</span>
            </label>
          </div>
          <p v-if="fieldErr.navModules" class="field-err nav-mod-err">{{ fieldErr.navModules }}</p>
        </div>

        <div v-if="capabilities.autostart" v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="rocket" :size="15" /> {{ t("settings.autostartTitle") }}</span>
            <label class="switch">
              <input type="checkbox" v-model="autostartOn" />
              <span class="track"></span>
              <span>{{ t("settings.autostartOn") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("settings.autostartDesc") }}</p>
        </div>

        <div v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="globe" :size="15" /> {{ t("settings.langTitle") }}</span>
            <select v-model="form.ui.locale" class="density-sel">
              <option value="system">{{ t("settings.langSystem") }}</option>
              <option value="zh-CN">&#20013;&#25991;</option>
              <option value="en-US">English</option>
            </select>
          </div>
          <p class="sect-desc">{{ t("settings.langDesc") }}</p>
        </div>

        <div v-if="capabilities.telemetryUpload" v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="shield" :size="15" /> {{ t("telemetry.title") }}</span>
            <label class="switch">
              <input type="checkbox" :checked="telemetryOn" @change="toggleTelemetry" />
              <span class="track"></span>
              <span>{{ t("telemetry.enable") }}</span>
            </label>
          </div>
          <p class="sect-desc">{{ t("telemetry.desc") }}</p>
          <p class="sect-desc sub">{{ t("telemetry.privacyNote") }}</p>
        </div>

        <div v-if="capabilities.backup" v-show="section === 'general'" class="sect gen">
          <div class="sect-head">
            <span class="sect-title"><Icon name="box" :size="15" /> {{ t("settings.backupTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.backupDesc") }}</p>
          <div class="sect-foot">
            <button class="btn-ghost sm" :disabled="backingUp || restoring" @click="backupNow">
              <Icon name="download" :size="14" /> {{ backingUp ? t("settings.backuping") : t("settings.backupBtn") }}
            </button>
            <button class="btn-ghost sm" :disabled="backingUp || restoring" @click="restoreNow">
              <Icon name="repeat" :size="14" /> {{ restoring ? t("settings.restoring") : t("settings.restoreBtn") }}
            </button>
          </div>
        </div>

        <div v-if="capabilities.updater" v-show="section === 'general'" class="sect gen gen-last">
          <div class="sect-head">
            <span class="sect-title"><Icon name="download" :size="15" /> {{ t("settings.updateTitle") }}</span>
            <span class="ver-tag">{{ t("settings.updateVer", { version: appVersion }) }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.updateDesc") }}</p>
          <div class="sect-foot">
            <button class="btn-ghost sm" :disabled="checkingUpdate" @click="checkUpdateNow">
              <Icon name="repeat" :size="14" /> {{ checkingUpdate ? t("settings.updateCheckingBtn") : t("settings.updateBtn") }}
            </button>
          </div>
        </div>

        <!-- 浏览器版说明：说明存储位置与桌面版差异 -->
        <div v-if="!capabilities.multiWindow" v-show="section === 'general'" class="sect gen gen-last">
          <div class="sect-head">
            <span class="sect-title"><Icon name="globe" :size="15" /> {{ t("settings.browserTitle") }}</span>
          </div>
          <p class="sect-desc">{{ t("settings.browserDesc") }}</p>
        </div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.settings-view { flex: 1; display: flex; min-height: 0; gap: var(--sp-6); padding: var(--sp-2) 28px 18px; }

/* 左侧分类导航 */
.sv-side {
  flex-shrink: 0;
  width: 176px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-05);
  padding: var(--sp-5) var(--sp-3);
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow);
  align-self: flex-start;
}
.sv-title { font-size: var(--fs-sm); font-weight: 700; color: var(--muted); padding: 2px var(--sp-3) var(--sp-2); letter-spacing: 1px; }
.sv-nav {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px var(--sp-3);
  border: none;
  background: none;
  border-radius: var(--r-sm);
  font-size: var(--fs-md);
  font-weight: 600;
  color: var(--text-weak);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.sv-nav:hover { background: var(--primary-soft); color: var(--primary-hover); }
.sv-nav.on { background: var(--grad-selected); color: var(--primary-hover); border: 1px solid var(--border-blue); box-shadow: inset 2px 0 0 var(--primary); }
.sv-nav-label { white-space: nowrap; }
.sv-foot { margin-top: auto; padding: var(--sp-3) var(--sp-3) 2px; }
.ver-tag { font-size: var(--fs-xs); color: var(--faint); }

/* 右侧内容区 */
.sv-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-4); }
.sv-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-6);
  background: var(--card);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  box-shadow: var(--shadow);
}
.sv-bar-txt { display: flex; align-items: baseline; gap: var(--sp-3); min-width: 0; }
.sv-bar-txt b { font-size: var(--fs-base); font-weight: 700; }
.sv-desc { font-size: var(--fs-sm); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sv-dirty { font-size: var(--fs-xs); font-weight: 600; color: var(--warn-deep); background: var(--warn-soft); padding: 1px var(--sp-2); border-radius: var(--r-pill); flex-shrink: 0; }
.sv-body { flex: 1; min-height: 0; overflow-y: auto; padding-right: var(--sp-0); }

.sect { border: 1px solid var(--card-border); border-radius: var(--r-lg); padding: 18px; margin-bottom: 18px; background: var(--card-soft); }
.sect.gen { border: none; background: transparent; border-radius: 0; padding: var(--sp-6) 2px; margin-bottom: 0; border-bottom: 1px solid var(--border); }
.sect.gen.gen-last { border-bottom: none; }
.sub-group { margin: 2px 0 var(--sp-6); }
.sub-group h4 { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-4); font-size: var(--fs-sm); font-weight: 700; color: var(--text-soft); }
.sub-group h4::after { content: ""; flex: 1; height: 1px; background: var(--border); }
.sect-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); margin-bottom: var(--sp-2); }
.sect-head .switch { margin-left: auto; }
.sect-title { display: inline-flex; align-items: center; gap: 7px; font-size: var(--fs-base); font-weight: 700; }
.sect-ico { flex-shrink: 0; color: var(--primary-hover); }
.sect-desc { font-size: var(--fs-sm); color: var(--muted); margin: 0 0 var(--sp-6); line-height: var(--lh-body); }
.switch { display: inline-flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-md); color: var(--text-soft); cursor: pointer; user-select: none; }
.switch input { display: none; }
.switch .track { position: relative; width: 36px; height: 20px; flex-shrink: 0; border-radius: var(--r-pill); background: var(--border-strong); transition: background 0.15s; }
.switch .track::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--text-invert); box-shadow: 0 1px 3px rgba(15, 23, 42, 0.25); transition: transform 0.15s; }
.switch input:checked + .track { background: var(--primary-hover); }
.switch input:checked + .track::after { transform: translateX(16px); }
.switch input:focus-visible + .track { outline: 2px solid var(--accent-soft-text); outline-offset: 2px; }

.presets { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-bottom: var(--sp-6); }
.preset-chip { padding: var(--sp-1) var(--sp-4); border-radius: var(--r-pill); border: 1px solid var(--border-strong); background: var(--card); color: var(--text); font-size: var(--fs-sm); cursor: pointer; transition: all 0.15s; }
.preset-chip:hover { border-color: var(--primary); color: var(--primary-hover); }
.preset-chip.on { border-color: var(--primary); background: var(--primary-soft); color: var(--primary-hover); font-weight: 600; }

/* 多模型配置：列表一行一套；选中行进入下方编辑器 */
.ai-profiles { display: flex; flex-direction: column; gap: var(--sp-2); margin: var(--sp-3) 0; }
.ai-profile { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); transition: border-color 0.15s, background 0.15s; }
.ai-profile.on { border-color: var(--primary); background: var(--primary-soft); }
.ai-profile-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-0); padding: 0; text-align: left; background: none; border: none; cursor: pointer; }
.ai-profile-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sm); font-weight: 600; color: var(--text); }
.ai-profile-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-xs); color: var(--muted); }
.ai-profile-badge { flex-shrink: 0; padding: 1px var(--sp-2); font-size: var(--fs-xs); font-weight: 600; color: var(--primary-hover); background: var(--card); border: 1px solid var(--border-blue); border-radius: var(--r-pill); }
.ai-profile-empty { margin: 0; padding: var(--sp-2) 0; font-size: var(--fs-xs); color: var(--faint); }
.ai-profile-err { margin: var(--sp-2) 0 0; }
.field-hint { display: block; margin-top: var(--sp-05); font-size: var(--fs-xs); color: var(--faint); }
/* 低频配置收进高级：默认不占视觉，展开后仍是完整表单 */
.ai-advanced { margin-top: var(--sp-3); padding-top: var(--sp-2); border-top: 1px dashed var(--border); }
.ai-advanced > summary { cursor: pointer; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); }
.ai-advanced[open] > summary { margin-bottom: var(--sp-2); }

.field { display: block; margin-bottom: var(--sp-5); }
/* 并排的短数值旋钮（gate/floor/limit）：三个等宽，标签在上，与 .field 的纵向排布同一套间距 */
.field-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4); }
.field > span { display: block; font-size: var(--fs-md); color: var(--muted); margin-bottom: 7px; font-weight: 600; }
.field.err > span { color: var(--danger-deep); }
.field.err input, .field.err .select { border-color: var(--danger); box-shadow: 0 0 0 3px var(--danger-soft); }
.field-err { display: block; margin-top: 5px; font-size: var(--fs-xs); font-weight: 600; color: var(--danger-deep); }
.field-hint { display: block; margin-top: 5px; font-size: var(--fs-xs); color: var(--muted); }
.field input { width: 100%; padding: var(--sp-3) 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; background: var(--card); color: var(--text); }
.field input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.field .select { width: 100%; padding: var(--sp-3) 13px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); font-size: var(--fs-base); font-family: inherit; outline: none; background: var(--card); color: var(--text); cursor: pointer; }
.field .select:focus { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.density-sel { padding: 5px var(--sp-3); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); color: var(--text); font-size: var(--fs-sm); font-family: inherit; cursor: pointer; }
.density-sel:focus { border-color: var(--primary); outline: none; }
.field input.range { padding: 0; height: 24px; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0 var(--sp-5); }
.tpl-hint { font-size: var(--fs-sm); color: var(--muted); margin: 2px 0 var(--sp-4); line-height: var(--lh-body); }
.tpl-hint code { background: color-mix(in srgb, var(--text-weak) 13%, transparent); border-radius: var(--r-xs); padding: 1px 5px; font-size: var(--fs-xs); }
.tips-box { margin: -4px 0 var(--sp-5); }
.tips-toggle { display: inline-flex; align-items: center; gap: 5px; background: none; border: none; padding: 0; color: var(--primary); font-size: var(--fs-sm); cursor: pointer; }
.tips-arrow { transition: transform 0.15s; }
.tips-arrow.open { transform: rotate(180deg); }
.tips-body { margin-top: var(--sp-2); padding: var(--sp-4) var(--sp-5); border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: color-mix(in srgb, var(--text-weak) 6%, transparent); font-size: var(--fs-sm); color: var(--text); line-height: var(--lh-body); }
.tips-body p { margin: 0 0 var(--sp-2); }
.tips-body ol { margin: 0 0 var(--sp-2); padding-left: 18px; }
.tips-body li { margin-bottom: var(--sp-05); }
.tips-body b { color: var(--primary); font-weight: 600; }
.tips-note { color: var(--muted); font-size: var(--fs-sm); }
.token-row { display: flex; gap: var(--sp-2); }
.token-row input { flex: 1; }

.sect-foot { display: flex; align-items: center; gap: var(--sp-5); margin-top: var(--sp-05); }
.nav-mod-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4) var(--sp-5); }
.nav-mod-err { margin-top: var(--sp-3); }
.team-reminder-err { margin: -6px 0 var(--sp-5); }
.link-btn { background: none; border: none; color: var(--primary); font-size: var(--fs-sm); cursor: pointer; display: inline-flex; align-items: center; gap: var(--sp-05); padding: 0; }
.link-btn:hover { text-decoration: underline; }

@media (prefers-color-scheme: dark) {
  .field input { background: var(--card-raised); }
  .field .select { background: var(--card-raised); }
  .preset-chip { background: var(--card-raised); }
  .preset-chip.on { background: var(--accent-soft-deep); color: var(--accent-soft-text); }
  .lic-input { background: var(--card-raised); }
}

/* ============ 赞助与开源分区样式 ============ */
.free-tag { font-size: var(--fs-xs); font-weight: 700; color: var(--success); border: 1px solid color-mix(in srgb, var(--success) 45%, transparent); border-radius: 999px; padding: 1px 7px; }
.sponsor-card {
  display: flex;
  gap: var(--sp-5);
  align-items: flex-start;
  margin: var(--sp-1) 0 18px;
  padding: var(--sp-5) var(--sp-6);
  border: 1px solid var(--card-border);
  border-radius: var(--r-md);
  background: linear-gradient(160deg, color-mix(in srgb, var(--accent-soft) 55%, var(--card)), var(--card));
}
.sponsor-ico { flex-shrink: 0; width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; background: var(--grad-brand); color: var(--text-invert); }
.sponsor-txt b { font-size: var(--fs-base); }
.sponsor-txt p { margin: var(--sp-05) 0 0; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }
.oss-box { margin-top: 18px; padding: var(--sp-3) var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card-soft); }
.oss-box .sect-desc { margin: 0; }
.lic-input {
  flex: 1;
  min-width: 240px;
  padding: 7px var(--sp-3);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--input-bg, var(--card));
  color: var(--text);
}
.accent-row { display: flex; gap: var(--sp-3); align-items: center; margin: var(--sp-3) 0 4px; }
.accent-dot {
  width: 30px; height: 30px; border-radius: 50%;
  border: 2px solid var(--card-border);
  cursor: pointer; padding: 0;
  transition: transform 0.12s, border-color 0.12s;
}
.accent-dot:hover { transform: scale(1.12); border-color: var(--primary); }
.accent-dot.on { border-color: var(--text); box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 30%, transparent); }
.sect-desc.inline { display: inline; margin: 0; }

/* ============ 云同步组样式 ============ */
.sync-actions { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin: var(--sp-3) 0; }
.sync-or { color: var(--faint); font-size: var(--fs-sm); }
.sm-input { min-width: 150px; flex: 0 1 200px; }
.faint-hint { color: var(--faint); font-size: var(--fs-xs); font-weight: 400; }
.sync-state { display: flex; align-items: center; gap: var(--sp-2); margin: var(--sp-2) 0 4px; font-size: var(--fs-sm); color: var(--text-weak); }
.sync-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--faint); }
.sync-state.syncing .sync-dot { background: var(--primary); animation: sync-pulse 1.1s ease-in-out infinite; }
.sync-state.idle .sync-dot { background: var(--success); }
.sync-state.error .sync-dot { background: var(--danger); }
.sync-state.revoked .sync-dot { background: var(--warn); }
@keyframes sync-pulse { 0%, 100% { opacity: 0.35; } 50% { opacity: 1; } }
.pairing-box { margin: var(--sp-2) 0 var(--sp-4); padding: var(--sp-4) var(--sp-5); border: 1px dashed var(--border-strong); border-radius: var(--r-sm); background: var(--well); }
.pairing-code { font-family: var(--font-mono); font-size: var(--fs-xl); font-weight: 700; letter-spacing: 4px; text-align: center; color: var(--primary-hover); cursor: pointer; user-select: all; }
.devices-box { margin: var(--sp-2) 0 var(--sp-4); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--card-border); border-radius: var(--r-sm); background: var(--card-soft); }
.sm-title { font-size: var(--fs-sm); margin-bottom: var(--sp-2); }
.device-row { display: flex; align-items: center; gap: var(--sp-2); padding: 5px 0; font-size: var(--fs-sm); color: var(--text); }
.dev-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dev-tail { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--muted); }
.btn-danger { background: none; border: 1px solid var(--border-danger); color: var(--danger); border-radius: var(--r-sm); padding: 3px var(--sp-3); font-size: var(--fs-xs); cursor: pointer; }
.btn-danger:hover { background: var(--danger-soft); }

/* ============ 管理面（权限门禁 + 审计留痕）============ */
.admin-sub { margin-top: var(--sp-6); }
.admin-group { margin-bottom: var(--sp-5); }
.admin-group-title { font-size: var(--fs-sm); font-weight: 700; color: var(--muted); margin-bottom: var(--sp-2); }
.admin-tool-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); cursor: pointer; }
.admin-tool-row:last-child { border-bottom: none; }
.admin-tool-name { font-size: var(--fs-md); color: var(--text); }
.admin-audit-actions { display: flex; align-items: center; gap: var(--sp-3); margin-left: auto; }
.admin-audit-actions button { display: inline-flex; align-items: center; gap: var(--sp-05); }
.admin-audit-actions button:disabled { opacity: 0.5; cursor: default; }
.audit-list { display: flex; flex-direction: column; gap: var(--sp-0); margin-top: var(--sp-2); }
.audit-row { display: grid; grid-template-columns: 150px minmax(120px, 1fr) 140px 56px 58px 70px; gap: var(--sp-3); align-items: center; padding: 5px var(--sp-2); font-size: var(--fs-xs); border-bottom: 1px solid var(--border); }
.audit-row:last-child { border-bottom: none; }
.audit-time { color: var(--muted); white-space: nowrap; }
.audit-goal { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-tool { font-family: var(--font-mono); color: var(--text-weak); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.audit-risk { color: var(--muted); }
.audit-badge { font-weight: 600; text-align: center; border-radius: var(--r-pill); padding: 1px var(--sp-1); }
.audit-badge.allow { color: var(--success); background: color-mix(in srgb, var(--success) 14%, transparent); }
.audit-badge.deny { color: var(--danger); background: var(--danger-soft); }
.audit-source { color: var(--faint); }

/* ============ Agent（运行上限 / 确认策略 / 工具开关 / 技能库 / 溢出结果区）============
   工具行与技能行同构：左侧「名字 + 一句说明」，右侧「打开工具 / 删除」+ 开关。
   与老能力面板（AgentView 的 .cap-row）同一套信息层级，只是从窄栏换成了设置页的整幅宽度。 */
.agent-group { margin-bottom: var(--sp-5); }
.agent-group-title { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-2); }
.agent-group-count { font-size: var(--fs-xs); color: var(--faint); font-family: var(--font-num); }
.agent-tool-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-4); padding: var(--sp-1) 0; border-bottom: 1px solid var(--border); }
.agent-tool-row:last-child { border-bottom: none; }
/* 停用态整体压暗：一眼看出哪些不在运行时的清单里（与老面板的 .cap-row.off 同义） */
.agent-tool-row.off { opacity: 0.55; }
.agent-tool-main { display: flex; align-items: baseline; gap: var(--sp-3); min-width: 0; }
.agent-tool-name { font-family: var(--font-mono); font-size: var(--fs-sm); font-weight: 600; color: var(--text); flex-shrink: 0; }
.agent-tool-desc { font-size: var(--fs-xs); color: var(--muted); line-height: var(--lh-tight); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-tool-side { display: flex; align-items: center; gap: var(--sp-3); flex-shrink: 0; }
/* 行内的图标按钮：.link-btn 的下划线是给文字链准备的，图标按钮不要 */
.agent-tool-side .link-btn:hover { text-decoration: none; }
.agent-tool-side .link-btn.danger { color: var(--muted); }
.agent-tool-side .link-btn.danger:hover { color: var(--danger); }
</style>
