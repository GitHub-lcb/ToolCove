// Markdown 工具的纯逻辑：大纲/目录、统计、表格对齐、规范化、检查、导出 HTML 文档。
//
// 与相邻工具的边界（刻意划清）：
//   · 渲染本身**不在这里**——`src/shared.js` 的 `renderMarkdown` 已有一份（AI 回复也在用），
//     重写第二份必然导致预览与聊天里的显示不一致。这里只做"围绕 Markdown 的处理"。
//   · 不做通用文本处理（正则/替换）→ 那是 text 工具
//   · 不做 JSON/YAML → 那是 json 工具
//
// 全部纯函数、零依赖（连 renderMarkdown 都是注入进来的），所以三端共用且可单测。
// `shared.js` 引了 i18n 与高亮器，纯逻辑模块不该把它拖进来。

/** 围栏代码块的起始/结束标记（三个及以上反引号或波浪号，可带语言）。 */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

/**
 * 逐行扫描，标记每行是否在代码块内。
 *
 * 为什么要单独做：`# 这不是标题` 出现在 ```bash 代码块里时**不是标题**，
 * 直接按行正则抓标题会把代码里的注释也算进去——大纲和统计就全错了。
 */
export function scanLines(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const flags = [];
  let fence = null; // 当前围栏标记（记录字符与长度，短围栏不能闭合长围栏）
  for (const line of lines) {
    const match = FENCE.exec(line);
    if (!fence && match) {
      fence = { char: match[2][0], len: match[2].length };
      flags.push({ inCode: true, isFence: true });
      continue;
    }
    if (fence && match && match[2][0] === fence.char && match[2].length >= fence.len) {
      flags.push({ inCode: true, isFence: true });
      fence = null;
      continue;
    }
    flags.push({ inCode: Boolean(fence), isFence: false });
  }
  return { lines, flags, unclosed: Boolean(fence) };
}

/**
 * 提取标题大纲（ATX 风格 `#`～`######`）。
 *
 * 跳过代码块内的内容；`#标题`（井号后无空格）**不算标题**——多数渲染器都不认，
 * 认了反而与预览不一致。
 */
export function outline(markdown, { maxLevel = 6 } = {}) {
  const { lines, flags } = scanLines(markdown);
  const out = [];
  const slugCount = new Map();
  lines.forEach((line, index) => {
    if (flags[index].inCode) return;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) return;
    const level = match[1].length;
    if (level > maxLevel) return;
    const text = stripInline(match[2]);
    const base = slugify(text);
    // 同名标题的锚点会冲突，加序号区分（与 GitHub 的行为一致）
    const seen = slugCount.get(base) || 0;
    slugCount.set(base, seen + 1);
    out.push({ level, text, slug: seen ? `${base}-${seen}` : base, line: index + 1 });
  });
  return out;
}

/** 去掉行内标记（粗体/行内码/链接），用于标题纯文本与锚点。 */
export function stripInline(text) {
  return String(text ?? "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

/** 生成锚点：小写、空格转连字符、去掉标点，保留中文（中文标题也要能当锚点）。 */
export function slugify(text) {
  const slug = String(text ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, "-")
    // 保留字母数字、连字符、下划线与中日韩字符
    .replace(/[^\w\-\u4e00-\u9fff\u3040-\u30ff]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

/** 生成目录（嵌套 Markdown 列表）。 */
export function toToc(headings, { ordered = false, maxLevel = 6 } = {}) {
  const list = (headings || []).filter((item) => item.level <= maxLevel);
  if (!list.length) return "";
  // 以最小层级为基准缩进，避免"文档从 h2 开始"时整体多缩进一层
  const base = Math.min(...list.map((item) => item.level));
  const lines = [];
  for (const item of list) {
    const indent = "  ".repeat(Math.max(0, item.level - base));
    const marker = ordered ? "1." : "-";
    lines.push(`${indent}${marker} [${item.text}](#${item.slug})`);
  }
  return lines.join("\n");
}

/** 统计：字数、标题、链接、图片、代码块、表格、预计阅读时长。 */
export function stats(markdown) {
  const { lines, flags, unclosed } = scanLines(markdown);
  const text = lines.join("\n");
  let codeBlocks = 0;
  let tables = 0;
  let inTable = false;
  let fenceOpen = false;
  let maxHeading = 0;
  let headings = 0;

  lines.forEach((line, index) => {
    const flag = flags[index];
    if (flag.isFence) {
      if (!fenceOpen) {
        codeBlocks += 1;
        fenceOpen = true;
      } else {
        fenceOpen = false;
      }
      return;
    }
    if (flag.inCode) return;
    // 表格：连续的含 `|` 行算一个表格
    const isTableRow = /^\s*\|.*\|\s*$/.test(line);
    if (isTableRow && !inTable) {
      tables += 1;
      inTable = true;
    } else if (!isTableRow) {
      inTable = false;
    }
    const heading = /^(#{1,6})\s+/.exec(line);
    if (heading) {
      headings += 1;
      maxHeading = Math.max(maxHeading, heading[1].length);
    }
  });

  // ⚠️ 先数图片再数链接：`![图](url)` 里也含 `[图](url)`，
  // 用同一个正则数两遍会把每张图片重复算成一个链接（实测踩过）。
  const images = (text.match(/!\[[^\]]*\]\([^)]*\)/g) || []).length;
  const links = (text.match(/(?<!!)\[[^\]]*\]\([^)]*\)/g) || []).length;
  // 去掉代码块与标记后再数正文，否则代码里的符号会被算成字数
  const plain = lines
    .filter((_, index) => !flags[index].inCode)
    .join(" ")
    .replace(/[#*`>~\-|[\]()]/g, " ");
  const cjk = (plain.match(/[\u4e00-\u9fff\u3040-\u30ff]/g) || []).length;
  const words = (plain.match(/[A-Za-z0-9_]+/g) || []).length;
  // 中文按 300 字/分钟、英文按 200 词/分钟估算（阅读时长只是参考值）
  const minutes = Math.max(cjk / 300 + words / 200, 0);

  return {
    lines: lines.length,
    chars: text.length,
    cjk,
    words,
    headings,
    maxHeading,
    links,
    images,
    codeBlocks,
    tables,
    unclosed,
    readMinutes: minutes < 1 && minutes > 0 ? 1 : Math.round(minutes),
  };
}

/**
 * 表格对齐：把源码里的表格补齐空格，让列在**纯文本里**也对齐。
 *
 * 为什么有用：Markdown 表格在渲染后是对齐的，但源码里参差不齐时很难读、diff 也难看。
 * 只处理表格行，其余行原样保留（不碰代码块）。
 */
export function formatTables(markdown) {
  const { lines, flags } = scanLines(markdown);
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (flags[index].inCode || !/^\s*\|.*\|\s*$/.test(line)) {
      out.push(line);
      index += 1;
      continue;
    }
    // 收集连续表格行
    const block = [];
    while (index < lines.length && !flags[index].inCode && /^\s*\|.*\|\s*$/.test(lines[index])) {
      block.push(lines[index]);
      index += 1;
    }
    out.push(...alignTableBlock(block));
  }
  return out.join("\n");
}

/** 对齐一个表格块（首行是表头，第二行是分隔行）。 */
function alignTableBlock(block) {
  const rows = block.map((line) => splitTableRow(line));
  const width = Math.max(...rows.map((row) => row.length));
  const isSeparator = (row) => row.every((cell) => /^:?-{1,}:?$/.test(cell.trim()) || cell.trim() === "");
  // 计算每列宽度：以内容为准，分隔行至少要 3 个连字符
  const sizes = Array.from({ length: width }, (_, col) =>
    Math.max(3, ...rows.map((row) => (isSeparator(row) ? 0 : displayWidth(row[col] ?? ""))))
  );
  return rows.map((row, rowIndex) => {
    const cells = Array.from({ length: width }, (_, col) => {
      const raw = (row[col] ?? "").trim();
      if (rowIndex === 1 && isSeparator(row)) {
        const left = raw.startsWith(":");
        const right = raw.endsWith(":");
        const dashes = "-".repeat(sizes[col] - (left ? 1 : 0) - (right ? 1 : 0));
        return `${left ? ":" : ""}${dashes}${right ? ":" : ""}`;
      }
      const pad = sizes[col] - displayWidth(raw);
      return raw + " ".repeat(Math.max(0, pad));
    });
    return `| ${cells.join(" | ")} |`;
  });
}

/** 拆一行表格为单元格（去掉首尾竖线，但不动转义的 `\|`）。 */
export function splitTableRow(line) {
  const trimmed = String(line).trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/**
 * 显示宽度：中日韩字符占两列。
 * 不这样算的话，含中文的表格对齐后仍然参差不齐。
 */
export function displayWidth(text) {
  let width = 0;
  for (const char of String(text ?? "")) {
    const code = char.codePointAt(0);
    width += (code >= 0x1100 && code <= 0x115f) || (code >= 0x2e80 && code <= 0xa4cf) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) ? 2 : 1;
  }
  return width;
}

/**
 * 规范化：修掉常见的手写毛病，让源码更规整。
 * **不碰代码块内部**（代码里的空行与缩进是有意义的）。
 */
export function normalize(markdown) {
  const { lines, flags } = scanLines(markdown);
  const out = [];
  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    if (flags[index].inCode) {
      out.push(line);
      continue;
    }
    // 全角空格当缩进在 Markdown 里无效，换成半角（中文输入法很容易打出来）
    line = line.replace(/^\u3000+/, (match) => " ".repeat(match.length));
    // 行尾空格去掉（两个空格在 Markdown 里是强制换行，是"有意义的"，
    // 但一个空格纯属噪声——这里保守地只去掉单个的行尾空格）
    if (/(?<! ) $/.test(line)) line = line.replace(/ +$/, "");
    // 标题井号后补空格（`#标题` 多数渲染器不认）
    line = line.replace(/^(#{1,6})([^\s#])/, "$1 $2");
    // 无序列表标记统一为 `-`（`*` 与 `+` 混用会让 diff 很乱）
    line = line.replace(/^(\s*)[*+](\s+)/, "$1-$2");
    out.push(line);
  }
  // 连续空行压成一个（代码块外的）
  const compact = [];
  for (let index = 0; index < out.length; index += 1) {
    const blank = out[index].trim() === "" && !flags[index].inCode;
    if (blank && compact.length && compact[compact.length - 1] === "") continue;
    compact.push(blank ? "" : out[index]);
  }
  // 标题前后各留一个空行（紧贴正文的标题在很多渲染器里会与上一段粘连）
  const spaced = [];
  for (let index = 0; index < compact.length; index += 1) {
    const isHeading = !flags[index]?.inCode && /^#{1,6}\s/.test(compact[index]);
    if (isHeading && spaced.length && spaced[spaced.length - 1] !== "") spaced.push("");
    spaced.push(compact[index]);
    if (isHeading && compact[index + 1] !== undefined && compact[index + 1] !== "") spaced.push("");
  }
  // 收尾：
  //   · 只去掉**开头的空行**与**末尾的空白**，不能用 trim()——那会把首行有意义的缩进也吃掉
  //     （比如文档以一个缩进的列表项开头，或者刚把全角空格转成半角）；
  //   · 不再用 /\n{3,}/ 压缩空行：那会把**代码块里的连续空行**也压掉，而代码里的空行是有意义的。
  //     代码块外的连续空行已经在上面按 inCode 感知的方式压过了。
  const text = spaced.join("\n").replace(/^\n+/, "").replace(/\s+$/, "");
  return `${text}\n`;
}

/**
 * 检查：返回错误码而不是文案（界面按语言渲染，与标签工具的体检同一约定）。
 */
export function lint(markdown) {
  const { lines, flags, unclosed } = scanLines(markdown);
  const issues = [];
  const push = (code, line, params = {}) => issues.push({ code, line, params });

  if (unclosed) push("unclosedFence", lines.length);

  let previousLevel = 0;
  const seenSlugs = new Map();
  lines.forEach((line, index) => {
    if (flags[index].inCode) return;
    const heading = /^(#{1,6})\s*(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      if (!heading[2].trim()) {
        push("emptyHeading", index + 1);
      } else {
        // 井号后没有空格：多数渲染器不认，是"我写了标题但没生效"的常见原因
        if (!/^#{1,6}\s/.test(line)) push("noSpaceAfterHash", index + 1);
        const slug = slugify(stripInline(heading[2]));
        if (seenSlugs.has(slug)) push("duplicateHeading", index + 1, { text: stripInline(heading[2]) });
        seenSlugs.set(slug, index + 1);
      }
      // 层级跳跃（h1 → h3）会让目录结构看起来缺了一层
      if (previousLevel && level > previousLevel + 1) push("headingJump", index + 1, { from: previousLevel, to: level });
      previousLevel = level;
    }
    if (/^\u3000/.test(line)) push("fullWidthSpace", index + 1);
    if (/\]\(\s*\)/.test(line)) push("emptyLink", index + 1);
    if (/\t/.test(line) && /^\t/.test(line)) push("tabIndent", index + 1);
  });
  return issues;
}

/**
 * 导出为完整 HTML 文档（自带样式，双击就能看）。
 *
 * `render` 由调用方注入（桌面/手机用 `shared.renderMarkdown`）——这样这个模块保持零依赖，
 * 而预览与导出又必然一致（同一个渲染器）。
 */
export function toHtmlDocument(markdown, { render, title = "Document", dark = false } = {}) {
  const body = typeof render === "function" ? render(markdown, { highlight: false }) : escapeHtml(markdown);
  const safeTitle = escapeHtml(title);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
:root { color-scheme: ${dark ? "dark" : "light"}; }
body {
  max-width: 820px;
  margin: 0 auto;
  padding: 40px 20px;
  font: 16px/1.75 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  color: ${dark ? "#e6e6e6" : "#1f2328"};
  background: ${dark ? "#1b1f23" : "#ffffff"};
}
h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.6em 0 0.6em; }
h1 { font-size: 1.9em; border-bottom: 1px solid ${dark ? "#30363d" : "#d8dee4"}; padding-bottom: 0.3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid ${dark ? "#30363d" : "#d8dee4"}; padding-bottom: 0.3em; }
code { background: ${dark ? "#2d333b" : "#f0f1f3"}; padding: 0.15em 0.4em; border-radius: 4px; font-size: 0.9em; }
pre { background: ${dark ? "#161b22" : "#f6f8fa"}; padding: 14px; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
blockquote { margin: 1em 0; padding: 0 1em; border-left: 4px solid ${dark ? "#3d444d" : "#d0d7de"}; color: ${dark ? "#9aa4af" : "#59636e"}; }
table { border-collapse: collapse; width: 100%; margin: 1em 0; }
th, td { border: 1px solid ${dark ? "#30363d" : "#d8dee4"}; padding: 6px 12px; text-align: left; }
th { background: ${dark ? "#21262d" : "#f6f8fa"}; }
img { max-width: 100%; }
hr { border: 0; border-top: 1px solid ${dark ? "#30363d" : "#d8dee4"}; margin: 2em 0; }
a { color: ${dark ? "#6cb6ff" : "#0969da"}; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** HTML 转义（导出时没有渲染器可注入的兜底路径）。 */
export function escapeHtml(text) {
  return String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
