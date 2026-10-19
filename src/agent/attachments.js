// 目标输入框的附件模型（纯函数，零平台依赖，可单测）。
//
// 为什么附件只带「路径 + 轻量元信息」而不是文件正文：
//   Agent 的规划器每次只吃一段文本提示词（见 agent/index.js 的 buildPrompt），没有多模态通道。
//   把整份文件塞进提示词，一次 10MB 的日志就能把上下文预算烧穿；而 Agent 本来就有
//   file.read_text / file.inspect / file.list_directory 三只手，正确做法是「把路径交给它，
//   让它按需读」（与 DSH 的 @file 同思路）。浏览器端拿不到真实路径，退化成把文本内容内联
//   （有上限），其余类型如实拒绝并提示，而不是假装附上去了。

export const ATTACH_MAX = 8;
export const ATTACH_INLINE_MAX_CHARS = 6000;
export const ATTACH_INLINE_TOTAL_CHARS = 18000;
export const ATTACH_NAME_MAX = 120;
export const ATTACH_PATH_MAX = 1024;

const TEXT_EXT = new Set(
  "txt md markdown json jsonl yaml yml csv tsv log xml html htm css scss less js mjs cjs ts tsx jsx vue py java kt kts go rs c h cpp hpp cc cs php rb sh bash zsh ps1 psm1 sql ini toml conf config env properties gradle gitignore".split(" ")
);
const IMAGE_EXT = new Set("png jpg jpeg gif webp bmp svg ico avif heic tif tiff".split(" "));

/** 取路径末段（Windows 与 POSIX 分隔符都认）。 */
export function basename(path) {
  const raw = String(path ?? "").trim();
  if (!raw) return "";
  const parts = raw.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : raw;
}

/** 扩展名（小写、不含点）。 */
export function extensionOf(name) {
  const base = basename(name);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** 附件类别：目录 / 图片 / 文本 / 其他二进制。决定图标与提示词里的一句说明。 */
export function attachmentKind(name, isDirectory = false) {
  if (isDirectory) return "folder";
  const ext = extensionOf(name);
  if (IMAGE_EXT.has(ext)) return "image";
  if (TEXT_EXT.has(ext)) return "text";
  return "file";
}

/** 类别 → 图标名（Icon.vue 的既有集合，不新造字形）。 */
export function attachmentIcon(kind) {
  if (kind === "folder") return "folder";
  if (kind === "image") return "image";
  if (kind === "text") return "file";
  return "box";
}

/** 人类可读体积：0 / 空值返回空串，让界面省掉一个「0 B」。 */
export function formatBytes(size) {
  const value = Number(size);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${Math.round(value)} B`;
  const kb = value / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

let seq = 0;
function newId() {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  } catch {
    // 非安全上下文等场景：退化为进程内自增，只用于列表 key 与去重，不参与持久化语义
  }
  seq += 1;
  return `att-${Date.now().toString(36)}-${seq}`;
}

/**
 * 归一出附件形状。`content` 只在内联正文时存在（浏览器端读到的文本），
 * 落盘 / 进提示词前一律按预算截断，避免一次粘贴把运行撑爆。
 */
export function createAttachment(input = {}) {
  const path = typeof input.path === "string" ? input.path.trim().slice(0, ATTACH_PATH_MAX) : "";
  // 名字与路径都没有 = 无效附件：这里返回空名，让 normalizeAttachments 统一丢弃，
  // 而不是编一个 "file" 名字骗过上层（界面上会出现一个点不掉的空壳 chip）。
  const name = (typeof input.name === "string" && input.name.trim()) || basename(path);
  const kind = input.kind || attachmentKind(name, !!input.isDirectory);
  const size = Number(input.size);
  const raw = typeof input.content === "string" ? input.content : "";
  const content = raw.slice(0, ATTACH_INLINE_MAX_CHARS);
  return {
    id: String(input.id || newId()),
    name: name.slice(0, ATTACH_NAME_MAX),
    path,
    kind,
    size: Number.isFinite(size) && size > 0 ? Math.trunc(size) : 0,
    content,
    // 创建时就截断过：提示词里要如实标一句，否则模型会以为拿到的是全文
    truncated: raw.length > content.length,
    source: input.source === "drop" || input.source === "paste" ? input.source : "picker",
  };
}

/** 去重键：桌面端同一路径 = 同一个文件；浏览器端没有路径，退回文件名。 */
export function attachmentKey(attachment) {
  const a = attachment || {};
  return String(a.path || a.name || "").toLowerCase();
}

/** 列表归一并按首次出现去重（持久化记录里的旧数据也走这里）。 */
export function normalizeAttachments(list, max = ATTACH_MAX) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    if (!raw || typeof raw !== "object") continue;
    const attachment = createAttachment(raw);
    if (!attachment.name) continue;
    const key = attachmentKey(attachment);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(attachment);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * 合并新选择：返回 `{ list, added, rejected }`。
 * rejected 带机器可读的 reason（duplicate / limit / invalid），文案由视图映射 i18n，
 * 纯逻辑里不写人话，避免中英双份。
 */
export function mergeAttachments(current, incoming, { max = ATTACH_MAX } = {}) {
  const list = normalizeAttachments(current, max);
  const seen = new Set(list.map(attachmentKey));
  const added = [];
  const rejected = [];
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!raw || typeof raw !== "object") {
      rejected.push({ name: "", reason: "invalid" });
      continue;
    }
    const attachment = createAttachment(raw);
    if (!attachment.name) {
      rejected.push({ name: "", reason: "invalid" });
      continue;
    }
    const key = attachmentKey(attachment);
    if (seen.has(key)) {
      rejected.push({ name: attachment.name, reason: "duplicate" });
      continue;
    }
    if (list.length >= max) {
      rejected.push({ name: attachment.name, reason: "limit" });
      continue;
    }
    seen.add(key);
    list.push(attachment);
    added.push(attachment);
  }
  return { list, added, rejected };
}

const KIND_LABEL = { text: "文本", image: "图片", folder: "目录", file: "二进制" };

/**
 * 附件 → 规划器提示词里的一段（无附件时返回空串，调用方据此做到「不加附件时提示词一字不变」）。
 * 路径优先：那是 Agent 真正能读的东西；内联正文只在没有路径时出现。
 */
export function attachmentPromptLine(list) {
  const items = normalizeAttachments(list);
  if (!items.length) return "";
  // 有路径才提「用文件工具读」：网页端没有 file.* 工具（desktopOnly），正文已内联，
  // 写一句用不了的读取方式只会诱导模型去调一个不存在的工具。
  const hasPath = items.some((a) => a.path);
  const lines = [
    hasPath
      ? "附件（用户已随目标附上，下列路径有效，不要再向用户索要这些文件的路径；按需用 file.read_text / file.inspect / file.list_directory / file.md5 读取或校验，不要臆测内容）："
      : "附件（用户已随目标附上，不要再向用户索要这些文件的路径；不要臆测内容）：",
  ];
  items.forEach((a, index) => {
    const meta = [];
    if (a.size) meta.push(formatBytes(a.size));
    meta.push(KIND_LABEL[a.kind] || KIND_LABEL.file);
    const target = a.path || a.name;
    lines.push(`${index + 1}. ${target}${meta.length ? `（${meta.join("，")}）` : ""}`);
  });
  let budget = ATTACH_INLINE_TOTAL_CHARS;
  for (const a of items) {
    const text = String(a.content || "").trim();
    if (!text || budget <= 0) continue;
    const slice = text.slice(0, Math.min(ATTACH_INLINE_MAX_CHARS, budget));
    budget -= slice.length;
    lines.push(`<附件 name="${a.name}">`);
    lines.push(slice + (a.truncated || slice.length < text.length ? "\n…（内容已截断）" : ""));
    lines.push("</附件>");
  }
  if (items.some((a) => !a.path && !String(a.content || "").trim())) {
    lines.push("说明：个别附件只有文件名，没有可读取的路径或正文；需要处理时先向用户索取完整路径。");
  }
  // 这一句是用户实测反馈的直接产物：附了 A 却被问「A 在哪」，或者附件与目标对不上时
  // 模型闷头追问一个笼统的路径。要求它先复述附件是什么，再只问缺的那一份。
  lines.push("说明：先看清附件是什么。若目标与附件对不上（例如目标是 PDF、附件是 SQL），先用一句话说明附件是哪份文件，再只追问缺少的那一份，不要笼统地再次索要路径。");
  return lines.join("\n");
}
