// 能力（工具）清单的共享投影：风险分组、风险色/词条映射、启用计数。
//
// 为什么抽出来：这份投影原先只活在 AgentView 的右栏里。三期把「工具开关」从对话右侧
// 常驻面板搬进设置页之后，两处（对话主区的确认卡/时间线、设置页的开关矩阵）都要用
// 同一套风险语义——再各写一份就会出现「时间线标红、设置页标橙」这类分裂。
//
// 纯函数 + 常量，不 import Vue；数据源是 agent/tools.js 的 listAgentTools（只读目录，
// 不加载工具实现层，见那边的注释）。

/** 展示顺序：从最安全到最危险。列表顺序本身就是一种风险提示。 */
export const RISK_ORDER = Object.freeze(["read", "transform", "write", "database"]);

/** 风险 → 语义色（tc-chip 的修饰类，见 styles/primitives.css）。 */
export const RISK_CHIP = Object.freeze({ read: "tc-sky", transform: "tc-primary", write: "tc-danger", database: "tc-teal" });

/** 风险 → 词条 key。 */
export const RISK_KEY = Object.freeze({
  read: "agent.riskRead",
  transform: "agent.riskTransform",
  write: "agent.riskWrite",
  database: "agent.riskDatabase",
});

export const riskChip = (risk) => RISK_CHIP[risk] || "tc-neutral";
export const riskKey = (risk) => RISK_KEY[risk] || "agent.riskRead";

/**
 * listAgentTools 的输出 → 「按风险分组的清单」，空组剔除。
 * 分组为空时返回空数组（调用方不必再判空）。
 */
export function buildCapabilityGroups(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return RISK_ORDER.map((risk) => ({ risk, tools: list.filter((x) => x.risk === risk) })).filter((g) => g.tools.length > 0);
}

/** 已启用工具数 / 总数。设置页的「{n} / {total} 个工具已启用」用它。 */
export function countEnabledTools(tools) {
  const list = Array.isArray(tools) ? tools : [];
  return { enabled: list.filter((x) => x.enabled).length, total: list.length };
}
