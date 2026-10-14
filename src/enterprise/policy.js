// 企业权限门禁（三期管理面）——策略的**纯规则**层。
//
// 策略形状：
//   disabledTools: string[]  被禁用的工具箱工具 key（按 tool.key 判定，投影时用）
//   maxRisk: "transform"|"read"|"write"|"database"|null  允许的最高风险级别（动作维度），null = 不设上限
//
// 为什么「只在企业态生效」的判断不写在这里：纯函数应当能给任意策略算出结果（单测也不必先搭企业态
// 环境）。把版本判断揉进规则会让「规则是什么」与「何时应用规则」两件事纠缠，所以版本判断放在消费点
// （toolboxTools.visibleToolboxTools / agent/tools.* 的投影处）。
//
// 风险级别取值与既有口径一致（contracts.test.js 的 RISKS、agent/catalog 的 risk、AgentView 的
// RISK_KEY）：transform / read / write / database，数值越大越危险。门禁「允许到某级」按本表比较。

export const POLICY_KEY = "enterprisePolicy";

// 单一口径的风险排序：与 RISK_KEY（AgentView）一一对应。若日后新增风险级别，改这里一处即可。
export const RISK_RANK = { transform: 0, read: 1, write: 2, database: 3 };
// 供设置页渲染下拉用（顺序 = 由宽到严）
export const RISK_LEVELS = ["transform", "read", "write", "database"];

const asArray = (value) => (Array.isArray(value) ? value : []);

/**
 * 归一化策略：脏值一律回退到合法形状。
 * - disabledTools 只保留非空字符串，去首尾空白、去重；
 * - maxRisk 只接受上面四个枚举值或 null（不设上限）。
 * 空策略（无禁用、无上限）＝ 不限制，与个人版行为一致。
 */
export function normalizePolicy(raw) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seen = new Set();
  const disabledTools = [];
  for (const item of asArray(source.disabledTools)) {
    if (typeof item !== "string") continue;
    const key = item.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    disabledTools.push(key);
  }
  const maxRisk = RISK_LEVELS.includes(source.maxRisk) ? source.maxRisk : null;
  return { disabledTools, maxRisk };
}

/** 工具是否被策略放行：toolKey 不在禁用清单里。无归属的 key（空）不参与工具级禁用。 */
export function policyAllowsTool(policy, toolKey) {
  const key = String(toolKey ?? "");
  if (!key) return true;
  return !asArray(policy?.disabledTools).includes(key);
}

/**
 * 动作风险是否在策略允许范围内。
 * - 无上限（maxRisk 为 null/undefined）＝ 不限制；
 * - 设了上限时，未知风险（不在 RISK_RANK 里的值）一律**保守拒绝**——判不出它是否在上限内时，
 *   拒绝比误放行更安全（误放行的代价是执行了不该执行的动作）。
 */
export function policyAllowsRisk(policy, risk) {
  const max = policy?.maxRisk;
  if (!max) return true;
  const cap = RISK_RANK[max];
  const rank = RISK_RANK[risk];
  if (rank === undefined || cap === undefined) return false;
  return rank <= cap;
}

/** 工具箱工具过滤：只按被禁用的工具 key 判（工具本身没有风险级别）。返回新数组，不改入参。 */
export function applyPolicyToTools(policy, tools) {
  return asArray(tools).filter((tool) => policyAllowsTool(policy, tool?.key));
}

/** Agent 动作过滤：工具级禁用 + 风险上限两条一起判。返回新数组，不改入参。 */
export function applyPolicyToActions(policy, actions) {
  return asArray(actions).filter(
    (action) => policyAllowsTool(policy, action?.toolKey) && policyAllowsRisk(policy, action?.risk)
  );
}
