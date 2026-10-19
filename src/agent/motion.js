// 动作原型：把「工具在干什么」压成四类可复用的 running 微动效。
// 分类看动作全名（如 pdf.merge），命中优先级：拉取 > 落盘 > 流动 > 扫描。
// 未命中的工具不硬套动画，只保留卡片的呼吸描边。
const RULES = [
  ["stream", /(^|[._-])(db|data|http|https)($|[._-])|(^|[._-])(query|fetch|request)($|[._-])/i],
  ["stamp", /write|save|merge|split|export|create|modify|repair|delete|remove|move|rename|download|upload|archive|extract/i],
  ["flow", /convert|format|encode|decode|transform|render/i],
  ["scan", /read|parse|md5|hash|stat|inspect|diff|compare|detect|scan|check|list|search/i],
];

export function motionKind(name) {
  const text = String(name || "");
  if (!text) return "";
  for (const [kind, re] of RULES) if (re.test(text)) return kind;
  return "";
}
