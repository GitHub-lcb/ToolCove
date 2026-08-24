// AI 对话工具的会话纯逻辑：创建/删除/标题/裁剪/上下文构建/默认提示词。
// 与组件解耦，便于 vitest 单测（项目「纯函数抽 .js + .test.js」约定）。

export const DEFAULT_PRESETS = [
  { id: "general", name: "通用助手", content: "你是一个乐于助人的研发助手。回答准确、简洁，代码使用 Markdown 围栏代码块。" },
  { id: "regex", name: "正则生成", content: "你是正则表达式专家。根据用户描述生成正则表达式，并简要解释每个组成部分。" },
  { id: "code-explain", name: "代码解释", content: "你是资深研发工程师。解释用户贴出的代码：作用、关键实现点、潜在问题与改进建议。" },
  { id: "polish", name: "文案润色", content: "你是中文文案专家。润色用户提供的文本，保持原意，语气自然专业，直接输出润色结果。" },
  { id: "test-data", name: "测试数据", content: "你是测试数据生成助手。按用户要求生成真实感强的虚构数据，不要使用真实隐私信息。" },
];

export function createSession(presetId = "") {
  return {
    id: crypto.randomUUID(),
    title: "新对话",
    presetId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  };
}

// 会话标题：取首条用户消息文本前 20 字；纯图片消息回退「图片对话」；无消息「新对话」
export function sessionTitle(messages) {
  for (const m of messages || []) {
    if (m.role !== "user") continue;
    const text =
      typeof m.content === "string"
        ? m.content.trim()
        : Array.isArray(m.content)
          ? m.content
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join(" ")
              .trim()
          : "";
    if (text) return text.slice(0, 20);
    if (Array.isArray(m.images) && m.images.length) return "图片对话";
  }
  return "新对话";
}

export function renameSession(session, title) {
  const t = String(title || "").trim();
  session.title = t || sessionTitle(session.messages);
  session.updatedAt = Date.now();
  return session;
}

export function deleteSession(sessions, id) {
  return (sessions || []).filter((s) => s.id !== id);
}

// 消息上限裁剪：超出删最旧（返回新数组，不就地修改）
export function trimMessages(messages, max = 100) {
  if (!Array.isArray(messages)) return [];
  return messages.length > max ? messages.slice(-max) : messages;
}

// 构建发给模型的上下文：system + 最近 maxRounds 轮（user+assistant 配对，跳过空回复）
export function buildContextMessages(messages, system, maxRounds = 10) {
  const list = Array.isArray(messages) ? messages : [];
  const msgs = [];
  const s = String(system || "").trim();
  if (s) msgs.push({ role: "system", content: s });
  const tail = [];
  let rounds = 0;
  for (let i = list.length - 1; i >= 0 && rounds < maxRounds; i--) {
    const m = list[i];
    if (!m || m.role !== "user") continue;
    const pair = [{ role: "user", content: m.content }];
    const next = list[i + 1];
    if (next && next.role === "assistant" && hasContent(next.content)) {
      pair.push({ role: "assistant", content: next.content });
    }
    tail.unshift(...pair);
    rounds++;
  }
  return msgs.concat(tail);
}

function hasContent(content) {
  if (typeof content === "string") return !!content.trim();
  if (Array.isArray(content)) return content.length > 0;
  return false;
}
