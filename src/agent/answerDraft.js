// Agent 结论写回记录（知识沉淀）：把最终答复正文转成「速记 / 问题」的创建草稿。
//
// 为什么抽成纯函数：写回本身走 repository（视图侧调用），但「答复正文 → 记录字段」的映射
// 是规则而不是 IO，抽出来才能在 node 环境直接单测（SSR 渲染测试不适合断言落盘形状）。
// 字段形状严格对齐两个视图的手动新建（见 SnippetView.createSnippetsFromAI / ProblemView.saveForm），
// 不臆造字段——写回去的记录要能被现有界面正常打开、编辑、搜索。

/**
 * 摘要：取正文第一行非标题行并截断（复用 TaskView.reportSummary 的思路）。
 * 为什么不是直接取首行：答复常以 Markdown 标题（# 结论 / 概述）开头，把「## 概述」当标题
 * 存进列表没有任何辨识度。顺手剥掉列表/引用前缀：答案也常以 `- 步骤` 或 `1. ...` 起头。
 */
export function answerSummary(text, max = 48) {
  const s = String(text ?? "").trim();
  const line = s.split("\n").find((l) => l.trim() && !/^#/.test(l)) || s.slice(0, max);
  const clean = line.replace(/^\s*(?:[-*+]|\d+[.)]|>)\s+/, "").trim();
  const out = clean || line.trim();
  return out.length > max ? out.slice(0, max) + "…" : out;
}

/** 速记草稿。字段对标 SnippetView 的新建：{ title, category, content, fields, images, pinned }。 */
export function answerToSnippetDraft(answer) {
  const content = String(answer ?? "");
  return {
    title: answerSummary(content),
    // 不预设分类：分类属于用户自己的归档习惯，写回先留空（与「字段速记」一样是进阶用法，默认纯文本）
    category: "",
    content,
    fields: [],
    images: [],
    pinned: false,
  };
}

/** 问题草稿。字段对标 ProblemView 的新建：{ title, type, status, note, tags, logs }。 */
export function answerToProblemDraft(answer) {
  const content = String(answer ?? "");
  return {
    title: answerSummary(content),
    // 归到「其他」：Agent 结论既不是线上故障，也不是会议纪要或临时事项——不硬套语义类别
    type: "other",
    status: "open",
    // 问题正文存 note（ProblemView 里 note 是描述正文、resolution 是解决结论），不塞进 resolution
    note: content,
    tags: [],
    logs: [],
  };
}
