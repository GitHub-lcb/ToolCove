// 会话绑定当前工作域（三期上下文）：把选中的领域压成一行提示，注入规划器提示词。
//
// 为什么这让「引擎无数据依赖」：领域/代码池数据由持有它的视图（AgentView）读好后，拼成
// 现成的字符串传进来；本模块只做格式化，不 import repository、不碰 IPC。session 也只透传。
//
// 为什么这一行走 i18n（而 clarifyPromptLine 是硬编码中文）：这是**进模型**的上下文提示，
// 语言随界面走——中文用户给中文背景、英文用户给英文背景，模型贴着用户语言作答更稳。
// clarifyPromptLine 依赖 TypeSafe 的英文判定、且只在达门槛时出现，措辞不进上下文，性质不同。
//
// 无领域（或名称为空）返回空串：调用方据此判断「不加这一行」，默认提示词一字不变。

/**
 * @param {{ name?: string, pools?: string[] } | null} domain 选中领域（pools 为其代码池名列表）
 * @param {(key: string, params?: object) => string} t i18n 函数（界面注入 useI18n 的 t，测试可注入桩）
 * @returns {string} 一行提示；未选领域时为空串
 */
export function buildContextLine(domain, t) {
  const name = String(domain?.name ?? "").trim();
  if (!name) return "";
  const pools = (Array.isArray(domain?.pools) ? domain.pools : []).map((p) => String(p ?? "").trim()).filter(Boolean);
  // 代码池括号片段单独成键：没有池时不显示空括号，措辞也各自本地化，避免在代码里拼中文
  const poolText = pools.length ? t("agent.contextPools", { pools: pools.join("、") }) : "";
  return t("agent.contextPrompt", { name, pools: poolText });
}
