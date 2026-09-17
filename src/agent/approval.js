// 逐次批准策略（对标 DSH 的 approval 语义：唯一的授权形态是「仅这一次」）。
//
// 为什么需要它：旧实现按 risk 分级后，某次调用被批准，同一 run 内后续同类调用就直接放行——
// 用户以为同意的是「写这一个文件」，实际同意的是「这次任务里所有文件写入」。这是无意的批量授权。
//
// 现行语义（三档策略）：
//   always  → 每次调用都问，连只读工具也问
//   risky   → 写类（risk ∉ {read, transform}）每次都问
//   never   → 一概不问（用户显式选择，尊重；但 tool.confirm === 'always' 仍然问）
//
// 唯一的复用：同一 run 内「同一工具 + 同一参数」的重复调用折叠为一次询问。
// 折叠键用 canonicalJson（键名递归排序）而不是 JSON.stringify —— 后者对键序敏感，
// {a,b} 与 {b,a} 会算出两个键，等于没折叠。
//
// 批准与拒绝都记账，但语义不同：
//   已批准 → 直接放行（reason: repeated-call）
//   已拒绝 → 直接拒绝（reason: denied-before），**不再弹第二次卡**
// 后者是必需的：拒绝后我们把拒绝作为反馈回灌给模型，模型若原样重试同一调用，
// 不记账就会对同一张卡片反复追问，把步数预算耗在重复确认上。
//
// 本模块保持纯函数：不 import Vue / Tauri / i18n，可在 node 环境直接单测。

export const APPROVAL_MODES = Object.freeze(["risky", "always", "never"]);
const CONFIRM_SOURCE = "human";
const POLICY_SOURCE = "policy";

/** 归一策略模式：非法值（含用户手改 settings 的脏值）一律落回 risky。 */
export function normalizeMode(mode) {
  return APPROVAL_MODES.includes(mode) ? mode : "risky";
}

/**
 * 稳定序列化：递归排序对象键。数组顺序保留（数组语义上有序，[1,2] 与 [2,1] 是不同参数）。
 *
 * 这里是「要不要问人」的判定依据，所以**碰撞的代价是误放行**，必须把不同值序列化成不同串：
 *   - `undefined` 显式标出，不能与「键缺失」或 `null` 混同（JSON.stringify 会直接省略它，
 *     于是 {x: undefined} 与 {} 算出同一个折叠键——一次批准就被内容不同的调用复用）
 *   - `NaN` / `±Infinity` 显式标出，不能退化成 `null`（JSON.stringify(NaN) === "null"）
 *   - `Date` 取时间戳，不能退化成 `{}`（否则两个不同时刻算出同一个键）
 * 不认识的类实例退化为带类名的标记。永不抛错——折叠键算不出来不该让工具调用失败。
 *
 * seen 记的是**当前路径**（进出成对增删），所以只判真环；同一对象在兄弟位置复用不算环。
 */
export function canonicalJson(value, seen = new Set()) {
  if (value === undefined) return '"[undefined]"';
  if (value === null) return "null";
  if (typeof value === "number") {
    if (Number.isNaN(value)) return '"[NaN]"';
    // ±Infinity 必须分开：都写成 "[Infinity]" 会让 {x: Infinity} 与 {x: -Infinity}
    // 算出同一个折叠键，一次批准就被另一个参数的调用复用（碰撞的代价是误放行）。
    if (!Number.isFinite(value)) return value > 0 ? '"[Infinity]"' : '"[-Infinity]"';
    return String(value);
  }
  if (typeof value === "bigint") return `"[bigint:${value}]"`;
  if (typeof value !== "object") return JSON.stringify(value) ?? String(value);
  if (value instanceof Date) return `"[date:${value.getTime()}]"`;
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, seen)).join(",")}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k], seen)}`).join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** 折叠键：同名工具 + 同参数视为同一次请求。 */
export function collapseKey(name, args) {
  return `${name}\u0000${canonicalJson(args ?? {})}`;
}

/** 该工具是否必须问人（不受策略影响）。 */
export function isAlwaysConfirm(tool) {
  return tool?.confirm === "always";
}

/**
 * 判断一次工具调用是否需要人工确认。
 * 返回 { ask, source, reason, collapseKey }：
 *   ask=false + source='policy' → 策略判定无需询问（不是「假装批准」，审计事件会写明来源）
 *   ask=true                   → 调用方需要询问人类，并把结果交给 record()
 */
export function evaluate(policy, tool, args) {
  if (!tool) return { ask: false, source: POLICY_SOURCE, reason: "no-tool", collapseKey: "" };
  const key = collapseKey(tool.name, args);
  // 已被拒绝过的同一调用优先判定：不再追问，也绝不执行（见 runtime 的 denied-before 处理）。
  // 放在 confirm:'always' 之前——否则连「必须人工确认」的工具也会被同一张卡片反复追问。
  if (policy.isDenied(key)) return { ask: false, source: CONFIRM_SOURCE, reason: "denied-before", collapseKey: key };
  if (isAlwaysConfirm(tool)) return { ask: true, source: CONFIRM_SOURCE, reason: "always-confirm", collapseKey: key };
  const mode = policy.mode;
  if (mode === "never") return { ask: false, source: POLICY_SOURCE, reason: "mode-never", collapseKey: key };
  if (mode === "always") {
    if (policy.isApproved(key)) return { ask: false, source: CONFIRM_SOURCE, reason: "repeated-call", collapseKey: key };
    return { ask: true, source: CONFIRM_SOURCE, reason: "mode-always", collapseKey: key };
  }
  const safe = ["read", "transform"].includes(tool.risk);
  if (safe) return { ask: false, source: POLICY_SOURCE, reason: "safe-risk", collapseKey: key };
  if (policy.isApproved(key)) return { ask: false, source: CONFIRM_SOURCE, reason: "repeated-call", collapseKey: key };
  return { ask: true, source: CONFIRM_SOURCE, reason: "risky-write", collapseKey: key };
}

/**
 * 建一次运行的批准策略。已批准 / 已拒绝集合按折叠键记账，存活期就是本次运行。
 * @param {{mode?: string}} options mode 来自 resolveRunOptions 夹取后的 requireConfirmation
 */
export function createApprovalPolicy(options = {}) {
  const mode = normalizeMode(options.mode);
  const approved = new Set();
  const denied = new Set();
  const isApproved = (key) => !!key && approved.has(key);
  const isDenied = (key) => !!key && denied.has(key);
  return {
    mode,
    isApproved,
    isDenied,
    /** 判定是否要问人。 */
    decide: (tool, args) => evaluate({ mode, isApproved, isDenied }, tool, args),
    /** 记账一次人类决定：批准后可折叠复用，拒绝后不再追问。 */
    record(key, approvedByHuman) {
      if (!key) return { approved: approved.size, denied: denied.size };
      if (approvedByHuman) approved.add(key);
      else denied.add(key);
      return { approved: approved.size, denied: denied.size };
    },
    /** 已折叠的调用数，供测试与调试。 */
    get approvedCount() {
      return approved.size;
    },
    get deniedCount() {
      return denied.size;
    },
  };
}
