// 请求工具纯逻辑层（无 Vue、无 IO，便于单测）。
// 负责：URL ↔ 查询参数双向同步、cURL 解析、请求头/体处理、响应体格式化与类型探测。

import { i18n } from "../i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

// 拆分 URL 为 { base, query[] }。base 不含查询串；query 为 [{ key, value, on }]。
// 解析失败（非法 URL）时按纯文本处理，query 为空。
export function splitUrl(url) {
  const raw = String(url || "").trim();
  const hashIdx = raw.indexOf("#");
  const noHash = hashIdx >= 0 ? raw.slice(0, hashIdx) : raw;
  const qIdx = noHash.indexOf("?");
  if (qIdx < 0) return { base: noHash, query: [] };
  const base = noHash.slice(0, qIdx);
  const search = noHash.slice(qIdx + 1);
  const query = [];
  for (const pair of search.split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const v = eq >= 0 ? pair.slice(eq + 1) : "";
    query.push({ key: safeDecode(k), value: safeDecode(v), on: true });
  }
  return { base, query };
}

// 由 base + query[] 拼回完整 URL；仅拼 on!==false 且 key 非空的参数。
export function buildUrl(base, query) {
  const b = String(base || "").trim();
  const parts = (query || [])
    .filter((p) => p && p.on !== false && String(p.key).trim() !== "")
    .map((p) => `${encodeURIComponent(p.key)}=${encodeURIComponent(p.value ?? "")}`);
  if (!parts.length) return b;
  const sep = b.includes("?") ? "&" : "?";
  return b + sep + parts.join("&");
}

function safeDecode(s) {
  try {
    return decodeURIComponent(String(s).replace(/\+/g, " "));
  } catch {
    return String(s);
  }
}

// 把 headers 数组 [{key,value,on}] 规整为发送用的 [[k,v]]（过滤关闭项与空键）。
export function headersToPairs(headers) {
  return (headers || [])
    .filter((h) => h && h.on !== false && String(h.key).trim() !== "")
    .map((h) => [String(h.key).trim(), String(h.value ?? "")]);
}

// 从响应头数组 [[k,v]] 中忽略大小写取值。
export function findHeader(pairs, name) {
  const lower = String(name).toLowerCase();
  const hit = (pairs || []).find(([k]) => String(k).toLowerCase() === lower);
  return hit ? hit[1] : "";
}

// 从 Content-Disposition 解析下载文件名：优先 filename*（RFC 5987 百分号编码），其次 filename。
export function dispositionName(contentDisposition) {
  const cd = String(contentDisposition || "");
  const star = /filename\*\s*=\s*(?:UTF-8''|utf-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try { return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, "")); } catch { /* 编码异常走普通 filename */ }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(cd);
  return plain ? (plain[1] || plain[2] || "").trim() : "";
}

// 清洗文件名：去掉路径分隔与非法字符，避免保存时越权目录或非法路径。
function sanitizeFileName(name) {
  const clean = String(name || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim();
  return clean || "download";
}

// 由响应头 + 请求 URL 推导建议的保存文件名：Content-Disposition > URL 末段 > download。
export function suggestFileName(headers, url) {
  const name = dispositionName(findHeader(headers, "content-disposition"));
  if (name) return sanitizeFileName(name);
  const seg = splitUrl(url).base.split("/").filter(Boolean).pop() || "";
  if (seg) {
    try { return sanitizeFileName(decodeURIComponent(seg)); } catch { return sanitizeFileName(seg); }
  }
  return "download";
}

// 依据 content-type 给出响应类型的友好描述（文件流提示用）。
export function describeContentType(contentType) {
  const ct = String(contentType || "").toLowerCase().split(";")[0].trim();
  const keyByType = {
    "image/png": "ctPng", "image/jpeg": "ctJpeg", "image/gif": "ctGif",
    "image/webp": "ctWebp", "image/svg+xml": "ctSvg",
    "application/pdf": "ctPdf",
    "application/zip": "ctZip", "application/x-zip-compressed": "ctZip",
    "application/gzip": "ctGzip", "application/x-gzip": "ctGzip",
    "application/x-tar": "ctTar",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "ctExcel",
    "application/vnd.ms-excel": "ctExcel",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "ctWord",
    "application/msword": "ctWord",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": "ctPpt",
    "application/vnd.ms-powerpoint": "ctPpt",
    "application/octet-stream": "ctBinary",
    "application/x-msdownload": "ctExecutable",
  };
  if (keyByType[ct]) return t("toolbox.request." + keyByType[ct]);
  if (ct.startsWith("image/")) return t("toolbox.request.ctImage");
  if (ct.startsWith("audio/")) return t("toolbox.request.ctAudio");
  if (ct.startsWith("video/")) return t("toolbox.request.ctVideo");
  if (ct.startsWith("font/")) return t("toolbox.request.ctFont");
  if (ct.includes("json")) return t("toolbox.request.ctJson");
  if (ct.includes("xml")) return t("toolbox.request.ctXml");
  if (ct.includes("csv")) return t("toolbox.request.ctCsv");
  return t("toolbox.request.ctFile");
}

// 依据 content-type + 内容猜测响应体语言：json | html | xml | text
export function detectBodyLang(contentType, body) {
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("json")) return "json";
  if (ct.includes("html")) return "html";
  if (ct.includes("xml")) return "xml";
  const t = String(body || "").trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try { JSON.parse(t); return "json"; } catch { /* not json */ }
  }
  if (t.startsWith("<")) return t.toLowerCase().startsWith("<?xml") ? "xml" : "html";
  return "text";
}

// 尝试美化响应体：JSON 缩进 2 空格；非 JSON 原样返回。
export function prettyBody(body, lang) {
  const t = String(body ?? "");
  if (lang === "json") {
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; }
  }
  return t;
}

// 字节数转可读文本
export function sizeText(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(2) + " KB";
  return (n / 1024 / 1024).toFixed(2) + " MB";
}

// 状态码归类，用于着色：ok(2xx) | redirect(3xx) | client(4xx) | server(5xx) | other
export function statusClass(status) {
  const s = Number(status) || 0;
  if (s >= 200 && s < 300) return "ok";
  if (s >= 300 && s < 400) return "redirect";
  if (s >= 400 && s < 500) return "client";
  if (s >= 500) return "server";
  return "other";
}

// 把环境变量数组 [{key,value,on}] 规整为 { key: value } 映射（过滤关闭项与空键）。
export function envVarsToMap(vars) {
  const map = {};
  for (const v of vars || []) {
    if (!v || v.on === false) continue;
    const k = String(v.key || "").trim();
    if (!k) continue;
    map[k] = String(v.value ?? "");
  }
  return map;
}

// 用变量映射替换文本中的 {{name}} 占位符；未知变量原样保留。
export function substituteVars(text, map) {
  const s = String(text ?? "");
  if (!map || !s.includes("{{")) return s;
  return s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(map, name) ? map[name] : whole
  );
}

// 提取文本中引用到的 {{name}} 变量名（去重）。
export function extractVars(text) {
  const out = [];
  const re = /\{\{\s*([\w.-]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

// 从 x-www-form-urlencoded 键值对数组构造请求体字符串（过滤关闭项与空键）。
export function formEncode(pairs) {
  return (pairs || [])
    .filter((p) => p && p.on !== false && String(p.key).trim() !== "")
    .map((p) => `${encodeURIComponent(String(p.key).trim())}=${encodeURIComponent(p.value ?? "")}`)
    .join("&");
}

// 解析 x-www-form-urlencoded 文本为 [{key,value,on}]（用于文本↔表格互转）。
export function parseFormText(text) {
  const out = [];
  for (const pair of String(text || "").split("&")) {
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const k = eq >= 0 ? pair.slice(0, eq) : pair;
    const v = eq >= 0 ? pair.slice(eq + 1) : "";
    out.push({ key: safeDecode(k), value: safeDecode(v), on: true });
  }
  return out;
}

// 解析 cURL 命令为 { method, url, headers[], body }。
// 支持：-X/--request、-H/--header、-d/--data/--data-raw/--data-binary/--data-urlencode、
// --url、-u/--user（转 Basic Auth 提示）、跨行续行符 \、单/双引号。
// 无 -X 但有 data 时方法默认为 POST。
export function parseCurl(text) {
  const src = String(text || "").trim();
  if (!/^\s*curl\b/i.test(src)) {
    throw new Error(t("toolbox.request.curlInvalid"));
  }
  const tokens = tokenizeCurl(src.replace(/\\\r?\n/g, " "));
  // 丢弃开头的 "curl"
  if (tokens[0] && tokens[0].toLowerCase() === "curl") tokens.shift();

  let method = "";
  let url = "";
  const headers = [];
  const dataParts = [];
  let dataUrlencode = false;

  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    const next = () => tokens[++i];
    if (tk === "-X" || tk === "--request") {
      method = (next() || "").toUpperCase();
    } else if (tk === "-H" || tk === "--header") {
      const h = next() || "";
      const idx = h.indexOf(":");
      if (idx > 0) headers.push({ key: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim(), on: true });
    } else if (tk === "-d" || tk === "--data" || tk === "--data-raw" || tk === "--data-binary" || tk === "--data-ascii") {
      dataParts.push(next() || "");
    } else if (tk === "--data-urlencode") {
      dataParts.push(next() || "");
      dataUrlencode = true;
    } else if (tk === "-u" || tk === "--user") {
      const cred = next() || "";
      headers.push({ key: "Authorization", value: "Basic " + base64(cred), on: true });
    } else if (tk === "--url") {
      url = next() || "";
    } else if (tk === "-A" || tk === "--user-agent") {
      headers.push({ key: "User-Agent", value: next() || "", on: true });
    } else if (tk === "-e" || tk === "--referer") {
      headers.push({ key: "Referer", value: next() || "", on: true });
    } else if (tk === "-b" || tk === "--cookie") {
      headers.push({ key: "Cookie", value: next() || "", on: true });
    } else if (tk === "--compressed" || tk === "-L" || tk === "--location" || tk === "-s" || tk === "--silent" || tk === "-k" || tk === "--insecure" || tk === "-i" || tk === "--include" || tk === "-v" || tk === "--verbose" || tk === "-g" || tk === "--globoff") {
      // 无值开关，忽略
    } else if (tk.startsWith("-")) {
      // 未知带值选项：跳过其值，避免把值误当 URL
      if (!tk.includes("=") && tokens[i + 1] && !tokens[i + 1].startsWith("-")) i++;
    } else if (!url) {
      url = tk;
    }
  }

  const body = dataParts.join(dataUrlencode ? "&" : "");
  if (!method) method = body ? "POST" : "GET";
  if (!url) throw new Error(t("toolbox.request.curlNoUrl"));
  return { method, url, headers, body };
}

// 按 shell 规则分词：处理单引号、双引号、转义，未闭合引号按到行尾处理。
function tokenizeCurl(s) {
  const out = [];
  let cur = "";
  let quote = ""; // '\'' | '"' | ""
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = ""; }
      else if (c === "\\" && quote === '"' && i + 1 < s.length) { cur += s[++i]; }
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c; has = true;
    } else if (c === "\\" && i + 1 < s.length) {
      cur += s[++i]; has = true;
    } else if (/\s/.test(c)) {
      if (has) { out.push(cur); cur = ""; has = false; }
    } else {
      cur += c; has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

function base64(str) {
  try {
    if (typeof btoa === "function") return btoa(unescape(encodeURIComponent(str)));
  } catch { /* fall through */ }
  // Node / 无 btoa 环境
  if (typeof Buffer !== "undefined") return Buffer.from(str, "utf-8").toString("base64");
  return str;
}
