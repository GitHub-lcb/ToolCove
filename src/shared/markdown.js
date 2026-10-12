// 轻量 Markdown 渲染（AI 分析结果、Markdown 工具预览、对话气泡共用）。
//
// 为什么单独成文件：它是本仓**唯一**能把文本变成 HTML 的地方，而 `v-html` 的
// 使用点都指向它——"先整体转义、再按语法替换"这个顺序是安全边界，
// 埋在 564 行的 shared.js 里等于把安全边界藏起来。eslint 也把 `vue/no-v-html` 保持为 error，
// 每个 v-html 都必须能追溯到这里的转义前提。
//
// 支持：标题 / 粗体 / 行内码 / 围栏代码块（可选语言高亮）/ 表格 / 无序·有序列表 / 引用 / 分割线 / 链接。
// opts.highlight=true 时围栏代码块走 highlight.js 并带复制按钮（AI 对话用）；默认 false 保持既有输出。
import { i18n } from "../i18n/index.js";
import { highlightCode } from "../highlight.js";

const t = (key, params) => i18n.global.t(key, params);

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function mdInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function mdCodeBlock(code, lang, highlight) {
  if (highlight && lang) {
    return `<pre class="md-code" data-lang="${lang}"><button type="button" class="md-copy">${t("common.copy")}</button><code class="hljs">${highlightCode(code, lang)}</code></pre>`;
  }
  return `<pre class="md-code">${escapeHtml(code)}</pre>`;
}

export function renderMarkdown(src, opts = {}) {
  const highlight = !!opts.highlight;
  const raw = String(src || "").replace(/\r\n/g, "\n");
  // 转义不改变行数，escapedLines 与 rawLines 下标一一对应；代码块内保留原文供高亮
  const escapedLines = escapeHtml(raw).split("\n");
  const rawLines = raw.split("\n");
  const out = [];
  let inCode = false;
  let codeLang = "";
  let codeBuf = []; // 代码块原始行
  let listTag = ""; // "ul" | "ol"
  let tableBuf = []; // 连续表格行
  const closeList = () => {
    if (listTag) {
      out.push(`</${listTag}>`);
      listTag = "";
    }
  };
  const openList = (tag) => {
    if (listTag !== tag) {
      closeList();
      out.push(`<${tag}>`);
      listTag = tag;
    }
  };
  const flushTable = () => {
    if (!tableBuf.length) return;
    const rows = tableBuf.map((line) => {
      const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
      return body.split("|").map((c) => mdInline(c.trim()));
    });
    tableBuf = [];
    // 第二行全为分隔单元（--- / :---: 等）才按表格输出，否则降级为段落
    if (rows.length >= 2 && rows[1].length && rows[1].every((c) => /^:?-{2,}:?$/.test(c))) {
      const head = rows[0];
      const body = rows.slice(2);
      let html = '<table class="md-table"><thead><tr>' + head.map((c) => `<th>${c}</th>`).join("") + "</tr></thead>";
      if (body.length) {
        html += "<tbody>" + body.map((r) => "<tr>" + r.map((c) => `<td>${c}</td>`).join("") + "</tr>").join("") + "</tbody>";
      }
      out.push(html + "</table>");
    } else {
      out.push(rows.map((r) => `<p>${r.join(" | ")}</p>`).join(""));
    }
  };
  for (let i = 0; i < escapedLines.length; i++) {
    const line = escapedLines[i];
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      if (inCode) {
        out.push(mdCodeBlock(codeBuf.join("\n"), codeLang, highlight));
        codeBuf = [];
        inCode = false;
        codeLang = "";
      } else {
        closeList();
        flushTable();
        inCode = true;
        codeLang = fence[1] || "";
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(rawLines[i]);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      closeList();
      tableBuf.push(line);
      continue;
    }
    flushTable();
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) {
      closeList();
      const tag = "h" + Math.min(h[1].length + 2, 6); // # -> h3，避免撑爆卡片
      out.push(`<${tag}>${mdInline(h[2])}</${tag}>`);
      continue;
    }
    if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) {
      closeList();
      out.push("<hr>");
      continue;
    }
    const ul = line.match(/^\s*[-*]\s+(.+)$/);
    if (ul) {
      openList("ul");
      out.push(`<li>${mdInline(ul[1])}</li>`);
      continue;
    }
    const ol = line.match(/^\s*\d+[.\u3001)]\s+(.+)$/);
    if (ol) {
      openList("ol");
      out.push(`<li>${mdInline(ol[1])}</li>`);
      continue;
    }
    const bq = line.match(/^\s*&gt;\s?(.*)$/);
    if (bq) {
      closeList();
      out.push(`<blockquote>${mdInline(bq[1])}</blockquote>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${mdInline(line)}</p>`);
  }
  if (inCode && codeBuf.length) out.push(mdCodeBlock(codeBuf.join("\n"), codeLang, highlight));
  flushTable();
  closeList();
  return out.join("");
}
