// AI 对话工具的会话纯逻辑：创建/删除/标题/裁剪/上下文构建/默认提示词。
// 与组件解耦，便于 vitest 单测（项目「纯函数抽 .js + .test.js」约定）。
// 界面文案走 i18n（默认预设 name 为字典键 toolbox.ai.preset*，content 为提示词功能数据键 prompt.preset*）。

import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

export const DEFAULT_PRESETS = [
  { id: "general", nameKey: "presetGeneral", contentKey: "prompt.presetGeneral" },
  { id: "regex", nameKey: "presetRegex", contentKey: "prompt.presetRegex" },
  { id: "code-explain", nameKey: "presetCodeExplain", contentKey: "prompt.presetCodeExplain" },
  { id: "polish", nameKey: "presetPolish", contentKey: "prompt.presetPolish" },
  { id: "test-data", nameKey: "presetTestData", contentKey: "prompt.presetTestData" },
];

export function createSession(presetId = "") {
  return {
    id: crypto.randomUUID(),
    title: t("toolbox.ai.newSession"),
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
    if (Array.isArray(m.images) && m.images.length) return t("toolbox.ai.imageSession");
  }
  return t("toolbox.ai.newSession");
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
