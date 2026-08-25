// AI 周报的提示词与「风格记忆」管理（纯函数，可单测）
// 数据落在独立 key reportPrefs.json：{ template: 用户导入的模板原文, style: AI 从历史周报提炼的风格说明 }
// 生成周报时 buildReportSystem 把它们合入 system 提示词，让 AI 模仿用户自己的写作风格。

// 默认提示词：无模板/风格时的兜底要求
export const DEFAULT_REPORT_SYSTEM =
  "你是研发工程师的周报助手。根据用户提供的工作素材，用第一人称写一份简洁自然的中文周报（Markdown 格式）。" +
  "结构固定三段，二级标题措辞与统计区间对应（本周/上周）：「本周工作总结」「本周心得」「下周工作计划」。要求：" +
  "1. 本周工作总结：只基于素材写，不编造不存在的工作；同一需求的多个子任务合并成一条，突出结果而非流水账；" +
  "每条不超过一句话，末尾用一句话提一下总工时；2. 本周心得：不限于工作内容，可写个人感悟、生活启发、成长收获等，" +
  "结合本周实际经历写一件具体的事，再写出真实感受与反思，避免空话套话，150~300 字；" +
  "3. 下周工作计划：基于素材中的未完成需求与迭代安排写，列出 2~4 条；" +
  "4. 全文用自然、口语化的中文，像真人随手写的，不要有 AI 味（避免“总而言之”“综上所述”“赋能”“抓手”等套话，" +
  "不要机械排比、不要每段都工整对仗）；5. 直接输出周报正文，不要寒暄和解释。";

// 周报固定三段的小节名（生成与单独重写心得都依赖这些标题）
export const REPORT_SECTIONS = ["本周工作总结", "本周心得", "下周工作计划"];

// 长度上限（防止模板/样本/风格说明撑爆上下文）
export const TEMPLATE_MAX = 4000; // 保存模板原文时截断
export const STYLE_MAX = 800; // 保存提炼出的风格说明时截断
export const SAMPLE_MAX = 2000; // 单份历史周报截断
export const SAMPLE_COUNT_MAX = 6; // 提炼时最多取的份数

// 截断超长文本（尾部带省略号提示被截断）
export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

// 合成生成周报时的 system 提示词：
// 默认要求 +（可选）用户模板（模仿结构措辞）+（可选）提炼出的风格说明（遵循）
export function buildReportSystem(prefs = {}) {
  const parts = [DEFAULT_REPORT_SYSTEM];
  const tpl = String(prefs.template ?? "").trim();
  if (tpl) {
    parts.push(
      "\n\n【用户历史周报样本】以下是用户本人写过的周报，请模仿它的措辞与行文风格（结构仍需按上述三段固定，不要照搬其中的具体事项）：\n" +
        truncate(tpl, TEMPLATE_MAX)
    );
  }
  const style = String(prefs.style ?? "").trim();
  if (style) {
    parts.push("\n\n【用户的周报写作风格说明（必须遵循）】\n" + truncate(style, STYLE_MAX));
  }
  return parts.join("");
}

// 把粘贴的多份历史周报切分成样本数组：
// 分隔线 = 单独一行且整行由 - = * 中同一字符组成（≥3 个）；无分隔线时整体算一份。
export function splitReportSamples(text) {
  const sep = /^\s*(?:-{3,}|={3,}|\*{3,})\s*$/;
  const groups = [[]];
  for (const line of String(text ?? "").split("\n")) {
    if (sep.test(line)) {
      if (groups[groups.length - 1].length) groups.push([]);
    } else {
      groups[groups.length - 1].push(line);
    }
  }
  return groups
    .map((g) => g.join("\n").trim())
    .filter(Boolean)
    .slice(0, SAMPLE_COUNT_MAX)
    .map((s) => truncate(s, SAMPLE_MAX));
}

// 构建「提炼周报写作风格」的对话消息（system + user），供 aiComplete 使用
export function buildDistillPrompt(samples) {
  const list = samples.slice(0, SAMPLE_COUNT_MAX).map((s, i) => `【第 ${i + 1} 份】\n${s}`);
  return {
    system:
      "你是周报写作风格分析师。用户会提供多份他本人写的中文周报，请提炼出他的写作风格说明，" +
      "供另一个 AI 在代写周报时模仿。输出一份「风格说明」正文，要求：" +
      "1. 只输出风格说明本身，不要寒暄和解释；2. 按以下维度提炼（样本中无明显特征的就跳过）：" +
      "整体结构与分段习惯、标题与小节措辞、条目的颗粒度与句式、常用开头结尾套路、语气与篇幅倾向、特殊格式（表格/列表/加粗等）；" +
      "3. 每个维度一句话给出结论，不要举例；4. 总字数控制在 300 字以内。",
    user: `以下是用户的 ${list.length} 份历史周报：\n\n${list.join("\n\n")}`,
  };
}

// 构建「按主题方向重写本周心得」的对话消息（system + user），供 aiChat/aiComplete 使用
// topic 为空时表示自由发挥（不限于工作内容）；images 为 data URL 数组（可选图片素材，最多 HEART_IMAGE_MAX 张）
// 无图片时 user 为纯文本；有图片时 user 为 content 块数组（[{type:"text"},{type:"image_url"}]，OpenAI 兼容格式）
export const HEART_IMAGE_MAX = 4;

export function buildHeartPrompt(topic, currentReport, images = []) {
  const t = String(topic ?? "").trim();
  const list = (Array.isArray(images) ? images : [images]).filter(Boolean).slice(0, HEART_IMAGE_MAX);
  const system =
    "你是周报撰写助手。用户会给你一份已生成的周报、一个可选的「心得主题方向」以及可选的图片素材，" +
    "请你只重写其中的「本周心得」部分。要求：" +
    "1. 只输出心得正文，不要输出小标题、编号或任何解释；" +
    "2. 心得不限于工作内容，可写个人感悟、生活启发、成长收获等；" +
    "3. 若给了主题方向，则围绕该方向写；未给则顺着周报其余部分的风格自由发挥；" +
    "4. 若附带了图片，可参考图片内容（如生活照、灵感截图、见闻）作为心得素材，但不要直接描述图片本身；" +
    "5. 写法：结合周报总结中提到的具体工作或图片内容，先讲一件具体的事或触动你的细节，再写出真实感受与反思，" +
    "可按『发生了什么 → 我的感受 → 我学到/想通了什么』展开，避免空话套话；" +
    "6. 语气与周报整体保持一致；7. 用自然、口语化的中文，像真人随手写的，不要有 AI 味" +
    "（避免“总而言之”“综上所述”“受益匪浅”“赋能”等套话，不要机械排比、不要工整对仗）；8. 150~300 字。";
  const text = `【主题方向】${t || "（无，自由发挥）"}\n\n【当前周报全文】\n${String(currentReport ?? "")}`;
  if (!list.length) {
    return { system, user: text };
  }
  const content = [
    { type: "text", text: `${text}\n\n【图片素材】共 ${list.length} 张（按顺序标注，可综合参考）：` },
    ...list.map((url) => ({ type: "image_url", image_url: { url } })),
  ];
  return { system, user: content };
}

// ---------- 周报历史管理 ----------
// 周报状态机：新建(pending) → 确认(confirmed) → 归档(archived)，归档可恢复为确认
export const REPORT_STATUS = { pending: "新建", confirmed: "确认", archived: "归档" };
export const REPORT_STATUS_ORDER = ["pending", "confirmed", "archived"];

// 状态前进一步：新建 → 确认 → 归档（归档为终态，不再前进）
export function advanceReportStatus(status) {
  if (status === "pending") return "confirmed";
  if (status === "confirmed") return "archived";
  return status;
}

// 归档恢复为确认（其余状态不变）
export function recoverReportStatus(status) {
  return status === "archived" ? "confirmed" : status;
}

// 保存/更新某范围的周报：同 range 且处于「新建」态的草稿直接更新内容，否则新增一条
// 返回 { list, item, created }；list 为新的数组（新条目插在最前）
export function upsertReport(list, { range, rangeLabel, text }) {
  const items = Array.isArray(list) ? list : [];
  const idx = items.findIndex((r) => r.range === range && r.status === "pending");
  const now = new Date().toISOString();
  if (idx >= 0) {
    const item = { ...items[idx], text, updatedAt: now };
    return { list: items.map((r, i) => (i === idx ? item : r)), item, created: false };
  }
  const item = {
    id: crypto.randomUUID(),
    range,
    rangeLabel,
    text,
    status: "pending",
    createdAt: now,
    updatedAt: now,
  };
  return { list: [item, ...items], item, created: true };
}

// 按 id 更新状态并刷新 updatedAt；找不到该 id 时原样返回
export function updateReportStatus(list, id, status) {
  const items = Array.isArray(list) ? list : [];
  return items.map((r) =>
    r.id === id ? { ...r, status, updatedAt: new Date().toISOString() } : r
  );
}

// 从 Markdown 周报中提取某个二级标题小节的内容（不含标题行）；找不到返回空串
export function extractReportSection(markdown, title) {
  const lines = String(markdown ?? "").split("\n");
  const re = new RegExp(`^##\\s*${escapeRegExp(title)}\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join("\n").trim();
}

// 用新内容替换某二级标题小节（保留标题行与相邻空行结构）；找不到标题时原样返回
export function replaceReportSection(markdown, title, content) {
  const src = String(markdown ?? "");
  const lines = src.split("\n");
  const re = new RegExp(`^##\\s*${escapeRegExp(title)}\\s*$`);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return src;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = String(content ?? "").trim();
  const head = lines.slice(0, start + 1);
  const tail = lines.slice(end);
  const result = [...head, "", body, ...(tail.length ? ["", ...tail] : [])];
  // 收尾清理：去掉可能出现的连续空行
  return result.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// 正则转义（小节名可能含特殊字符）
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
