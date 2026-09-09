// Agent 的 Pro 门禁：把授权态翻译成「哪些工具存在、单次能跑多少步、允许哪种确认策略」。
//
// 三层执行点，全部在客户端：
//   1 能力移除   buildAgentRegistry() 不把 Pro 风险工具放进 registry → 不进 registry.list()
//                → 不进 planner prompt（index.js 只从 list() 取工具）。模型无从提议；
//                即使幻觉出工具名，runtime.js 会抛 Unknown tool。
//   2 调用时复检 Pro 风险工具的 execute 包一层，执行瞬间重读实时授权态。覆盖「建 registry 时是 Pro、
//                运行中在另一个窗口停用」。非 read/transform 工具 retries 本来就是 0，拒绝不会重试打转。
//   3 参数钳制   resolveRunOptions() 每次运行都重算，settings.agent 是用户可改的 JSON，永不信任。
//
// 与 cloud-sync 的纯 UI 门禁相比，这三层意味着免费用户那里能力真的不存在，而不只是按钮变灰。
import { isFeatureEnabled } from "../features.js";
import { AGENT_CONFIRM_POLICIES, AGENT_MAX_STEPS_HARD_CAP, AGENT_MAX_RETRIES } from "../settingsConfig.js";
import { FREE_DAILY_RUNS, FREE_DAILY_STEPS } from "./quota.js";
import { createBuiltinRegistry } from "./builtins.js";
import { createToolRegistry } from "./runtime.js";

export const AGENT_FEATURE = "agent-pro";

// 免费档单次运行步数上限（Pro 到 AGENT_MAX_STEPS_HARD_CAP）
export const FREE_MAX_STEPS = 8;

// 只有写入类锁进 Pro。read/transform/database 全免费：db.query_readonly 有 runtime 正则 +
// isReadOnlySql 双重只读防护，且工具箱里 DB 查询本来就免费，锁它会造成「同一个查询隔壁免费」的自相矛盾。
export const PRO_RISK_LEVELS = Object.freeze(["write"]);

export const FREE_LIMITS = Object.freeze({
  pro: false,
  dailyRuns: FREE_DAILY_RUNS,
  dailySteps: FREE_DAILY_STEPS,
  maxSteps: FREE_MAX_STEPS,
  proRisks: PRO_RISK_LEVELS,
  confirmPolicies: Object.freeze(["risky", "always"]),
});

export const PRO_LIMITS = Object.freeze({
  pro: true,
  dailyRuns: Infinity,
  dailySteps: Infinity,
  maxSteps: AGENT_MAX_STEPS_HARD_CAP,
  proRisks: Object.freeze([]),
  confirmPolicies: AGENT_CONFIRM_POLICIES,
});

const liveStatus = (getStatus) => {
  if (typeof getStatus !== "function") return null;
  try {
    return getStatus();
  } catch {
    return null; // 读不到授权态按免费处理（fail closed）
  }
};

export function resolveLimits(status) {
  return isFeatureEnabled(status, AGENT_FEATURE) ? PRO_LIMITS : FREE_LIMITS;
}

export const isProRisk = (risk) => PRO_RISK_LEVELS.includes(risk);

// 设置值与授权额度的交汇点，纯函数。返回的就是要交给 runAgent 的三个受控参数。
export function resolveRunOptions(cfg, limits = FREE_LIMITS) {
  const c = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  const l = limits && typeof limits === "object" ? limits : FREE_LIMITS;
  const cap = Number.isFinite(Number(l.maxSteps)) && Number(l.maxSteps) > 0 ? Math.trunc(Number(l.maxSteps)) : FREE_MAX_STEPS;
  const wantedSteps = Number.isInteger(c.maxSteps) && c.maxSteps > 0 ? c.maxSteps : 12;
  const wantedRetries = Number.isInteger(c.retries) && c.retries >= 0 ? c.retries : 1;
  const mode = AGENT_CONFIRM_POLICIES.includes(c.requireConfirmation) ? c.requireConfirmation : "risky";
  const policies = Array.isArray(l.confirmPolicies) ? l.confirmPolicies : ["risky"];
  return {
    maxSteps: Math.min(wantedSteps, cap),
    retries: Math.min(wantedRetries, AGENT_MAX_RETRIES),
    // 免费档选了「从不确认」→ 降级为「危险操作才确认」，绝不允许免费档跳过写入确认
    requireConfirmation: policies.includes(mode) ? mode : "risky",
  };
}

// 第 2 层：执行瞬间复检。免费态下这条路径通常不可达（第 1 层已移除工具），
// 它兜的是运行途中授权被停用的情形。
function guardExecute(tool, getStatus) {
  const execute = async (args, ctx) => {
    if (!isFeatureEnabled(liveStatus(getStatus), AGENT_FEATURE)) {
      throw Object.assign(Error(`需要 Pro 授权：${tool.name}`), { code: "FORBIDDEN", tool: tool.name });
    }
    return tool.execute(args, ctx);
  };
  return { ...tool, execute };
}

// 建一个「当前授权态 + 用户开关」下的工具 registry。resume 守卫会用同一个 registry 判定，
// 所以试图续跑含已锁工具的历史运行会被既有 canResume 逻辑拒绝，无需额外代码。
export function buildAgentRegistry(cfg, getStatus = () => null) {
  const full = createBuiltinRegistry();
  const c = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  const limits = resolveLimits(liveStatus(getStatus));
  const disabled = new Set(Array.isArray(c.disabledTools) ? c.disabledTools : []);
  const tools = full
    .list()
    .filter((t) => !limits.proRisks.includes(t.risk)) // 第 1 层：能力移除
    .filter((t) => !disabled.has(t.name)) // 用户开关
    // list() 剥掉了 execute，这里按名字从完整 registry 取回可执行定义
    .map((t) => (isProRisk(t.risk) ? guardExecute(full.get(t.name), getStatus) : full.get(t.name)));
  return createToolRegistry(tools);
}

// 能力面板/设置矩阵的数据源：始终返回全部内置工具（含被锁与被停用的），由 UI 决定怎么展示。
// locked = Pro 门禁；enabled = 用户开关状态（locked 时 UI 应禁用该开关）。
export function listAgentTools(status, cfg) {
  const limits = resolveLimits(status);
  const c = cfg && typeof cfg === "object" && !Array.isArray(cfg) ? cfg : {};
  const disabled = new Set(Array.isArray(c.disabledTools) ? c.disabledTools : []);
  return createBuiltinRegistry().list().map((t) => ({
    name: t.name,
    risk: t.risk,
    descriptionKey: t.descriptionKey || "",
    toolKey: t.toolKey || "",
    locked: limits.proRisks.includes(t.risk),
    enabled: !disabled.has(t.name),
  }));
}
