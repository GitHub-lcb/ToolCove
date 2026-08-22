// 代码高亮：highlight.js 常用语言子集 + LRU 缓存（shared.js renderMarkdown 的 highlight 选项使用）。
// 只注册 8 种常用语言控制体积；输入为原始代码文本（highlight.js 内部负责 HTML 转义）。
import hljs from "highlight.js/lib/core";
import javascript from "highlight.js/lib/languages/javascript";
import typescript from "highlight.js/lib/languages/typescript";
import json from "highlight.js/lib/languages/json";
import sql from "highlight.js/lib/languages/sql";
import java from "highlight.js/lib/languages/java";
import python from "highlight.js/lib/languages/python";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import xml from "highlight.js/lib/languages/xml";

hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("java", java);
hljs.registerLanguage("python", python);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("xml", xml);

const ALIASES = { js: "javascript", ts: "typescript", py: "python", sh: "bash", shell: "bash", yml: "yaml", html: "xml" };

const cache = new Map();
const MAX_CACHE = 200;

// 高亮代码，返回带 <span class="hljs-..."> 的 HTML 片段；语言未知时自动识别；失败回退转义原文
export function highlightCode(code, lang) {
  const language = ALIASES[lang] || lang || "";
  const key = language + "\u0000" + code;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  let html;
  try {
    html =
      language && hljs.getLanguage(language)
        ? hljs.highlight(code, { language, ignoreIllegals: true }).value
        : hljs.highlightAuto(code).value;
  } catch {
    html = code.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(key, html);
  return html;
}
