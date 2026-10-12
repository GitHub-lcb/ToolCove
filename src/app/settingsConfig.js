// 设置页辅助逻辑。平台集成配置函数不随 ToolCove 迁移，此处仅保留侧边栏模块隐藏列表归一。

// 遥测配置归一（旧数据/缺字段自动补默认值）：enabled 默认 false、prompted 默认 false、installId 非法置 null
// installId 仅限 1..=128 字符字符串，其他一律置 null（由调用方按需补生成）
export function normalizeTelemetry(raw) {
  const t = raw && typeof raw === "object" ? raw : {};
  const enabled = t.enabled === true;
  const prompted = t.prompted === true;
  let installId = typeof t.installId === "string" ? t.installId : null;
  if (installId !== null && (installId.length === 0 || installId.length > 128)) installId = null;
  return { enabled, prompted, installId };
}

// 云同步配置归一（旧数据/缺字段补默认）：默认全关；serverUrl 仅接受 http(s) 且长度受限
export function normalizeSync(raw) {
  const s = raw && typeof raw === "object" ? raw : {};
  let serverUrl = typeof s.serverUrl === "string" ? s.serverUrl.trim() : "";
  if (serverUrl && !/^https?:\/\//.test(serverUrl)) serverUrl = "";
  if (serverUrl.length > 512) serverUrl = serverUrl.slice(0, 512);
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);
  return {
    enabled: s.enabled === true,
    serverUrl,
    collectionId: str(s.collectionId, 64),
    deviceName: str(s.deviceName, 64),
    deviceId: str(s.deviceId, 64),
    salt: str(s.salt, 64),
    keyCipher: str(s.keyCipher, 1024),
    tokenCipher: str(s.tokenCipher, 1024),
    cursor: num(s.cursor),
    lastPushedAt: num(s.lastPushedAt),
    lastSyncAt: num(s.lastSyncAt),
    status: s.status === "revoked" ? "revoked" : "idle",
  };
}

// TypeSafe（System One）配置归一（旧数据/缺字段补默认）。
// 这是**可选增强**，所以默认关闭：现有用户升级后行为一字不变，语义匹配必须显式开启。
// baseUrl 留空即用官方端点（用户只需要粘一个 key）；非法协议清空而不是原样透传。
//
// 匹配旋钮（gate/floor/limit/置信度分档/正文预算）刻意归一成 **undefined 而不是默认值**：
// 默认值只有一个真相源，就是 skillSuggest.js 里的那几个常量。这里补一遍默认，
// 将来调默认值就会出现「新库用新默认、老配置里的数字还是老默认」的分裂。
export const TYPESAFE_DEFAULT_TIMEOUT_MS = 8000;
const TYPESAFE_TIMEOUT_RANGE = [1000, 30000];

/** 可选覆盖值：只认落在区间内的有限数，其余（含空串与 null）留 undefined 交给模块默认值。 */
function optionalNumber(raw, min, max) {
  if (typeof raw !== "number" && typeof raw !== "string") return undefined;
  if (typeof raw === "string" && raw.trim() === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
}

/**
 * 必带数值：坏值用默认，越界**夹取**而不是退回默认。
 * 超时是安全边界而不是偏好值：填 300 的人想要的是「快点失败」，给他默认 8000 恰好是反的；
 * 填 999999 的人想要「别催」，夹到 30000 仍比回到默认更贴近他的意图。
 * Rust 侧的 timeout_ms 也是夹取，两端必须同一套规则。
 */
function clampedNumber(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}

export function normalizeTypeSafe(raw) {
  const c = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  let baseUrl = typeof c.baseUrl === "string" ? c.baseUrl.trim() : "";
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) baseUrl = "";
  if (baseUrl.length > 512) baseUrl = baseUrl.slice(0, 512);
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");
  const [tMin, tMax] = TYPESAFE_TIMEOUT_RANGE;
  return {
    enabled: c.enabled === true,
    baseUrl,
    apiKey: str(c.apiKey, 1024),
    model: str(c.model, 64),
    timeoutMs: clampedNumber(c.timeoutMs, tMin, tMax, TYPESAFE_DEFAULT_TIMEOUT_MS),
    gate: optionalNumber(c.gate, 0, 1),
    floor: optionalNumber(c.floor, 0, 1),
    limit: optionalNumber(c.limit, 1, 10),
    candidates: optionalNumber(c.candidates, 1, 50),
    // 歧义预判默认开：它复用运行前的那一次请求，不额外增加延迟；只认显式 false
    clarify: c.clarify === undefined ? true : c.clarify === true,
    clarifyAt: optionalNumber(c.clarifyAt, 0, 1),
    confidenceLow: optionalNumber(c.confidenceLow, 0, 1),
    confidenceHigh: optionalNumber(c.confidenceHigh, 0, 1),
    bodyChars: optionalNumber(c.bodyChars, 40, 4000),
    stateBudget: optionalNumber(c.stateBudget, 500, 200000),
  };
}

// 侧边栏模块展示/隐藏：只保留当前存在的模块 key，去重且保持顺序
export function normalizeHiddenModules(allKeys, hidden) {
  const keys = Array.isArray(allKeys) ? allKeys.filter((k) => typeof k === "string") : [];
  const list = Array.isArray(hidden) ? hidden : [];
  const seen = new Set();
  const result = [];
  for (const key of list) {
    if (!keys.includes(key) || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

// settings.json 由多方写入（设置页表单、telemetry.consent、sync.writeSyncConfig），而设置页表单只渲染
// 部分分组。保存必须以磁盘快照为基底做浅合并，否则表单快照会删掉它没渲染的分组（曾导致云同步配置
// 在改一次界面密度后静默丢失、设备失联）。
export function mergeSettingsSnapshot(rawSnapshot, formSnapshot) {
  const base = rawSnapshot && typeof rawSnapshot === "object" && !Array.isArray(rawSnapshot) ? rawSnapshot : {};
  const form = formSnapshot && typeof formSnapshot === "object" && !Array.isArray(formSnapshot) ? formSnapshot : {};
  return { ...base, ...form };
}

// 冻结：数组常量被直接引用，防止上层误改
export const AGENT_CONFIRM_POLICIES = Object.freeze(["risky", "always", "never"]);
// 与 runtime.js 的 bounded(options.maxSteps, 12, 50) 上限保持一致
export const AGENT_MAX_STEPS_HARD_CAP = 50;
export const AGENT_MAX_RETRIES = 3;

const AGENT_DISABLED_SKILLS_CAP = 200;

// Agent 设置归一（旧数据/缺字段补默认）。用【停用清单】而非启用清单：将来新增的内置工具
// 对老用户默认开启，与本文件既有的「旧数据自动补默认」惯例一致。
export function normalizeAgent(raw, allToolNames) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const names = Array.isArray(allToolNames) ? allToolNames.filter((n) => typeof n === "string") : [];
  const maxSteps = Number.isInteger(a.maxSteps) && a.maxSteps > 0
    ? Math.min(a.maxSteps, AGENT_MAX_STEPS_HARD_CAP)
    : 12;
  const retries = Number.isInteger(a.retries) && a.retries >= 0
    ? Math.min(a.retries, AGENT_MAX_RETRIES)
    : 1;
  const requireConfirmation = AGENT_CONFIRM_POLICIES.includes(a.requireConfirmation) ? a.requireConfirmation : "risky";
  let disabledTools = Array.isArray(a.disabledTools)
    ? [...new Set(a.disabledTools.filter((n) => names.includes(n)))]
    : [];
  // 全关等于空 registry（Agent 什么都做不了），视为未配置
  if (names.length && disabledTools.length >= names.length) disabledTools = [];
  // 技能 id 是用户自己沉淀出来的，设置页写进来时无法预先校验存在性，所以只做形状与条数约束；
  // 找不到的 id 在匹配阶段自然被忽略（见 skills.js 的 matchSkills）。
  const disabledSkills = Array.isArray(a.disabledSkills)
    ? [...new Set(a.disabledSkills.filter((id) => typeof id === "string" && id.trim()))].slice(0, AGENT_DISABLED_SKILLS_CAP)
    : [];
  return { maxSteps, retries, requireConfirmation, disabledTools, disabledSkills };
}
