// JSON 工具纯逻辑层（无 Vue、无 IO，便于单测）。
// 统一返回结构：成功 { ok:true, output, error:null }；失败 { ok:false, output:"", error }。
// error 形如 { line, column, message }（无法定位时 line/column 为 0）。

import { i18n } from "./i18n/index.js";

// 从 JSON.parse 抛出的错误里尽量解析出行列号。
// 兼容两种引擎信息：Chromium/WebView2 的 "... in JSON at position N (line L column C)"
// 与旧式 "at position N"（此时用原文按 position 反算行列）。
export function locateJsonError(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    // 1) 直接带 line/column
    const lc = msg.match(/line\s+(\d+)\s+column\s+(\d+)/i);
    if (lc) {
      return { line: Number(lc[1]), column: Number(lc[2]), message: msg };
    }
    // 2) 只有 position N：按原文反算行列
    const pos = msg.match(/position\s+(\d+)/i);
    if (pos) {
      const idx = Number(pos[1]);
      const before = String(text).slice(0, idx);
      const line = before.split("\n").length;
      const column = idx - before.lastIndexOf("\n"); // lastIndexOf 无换行时为 -1，正好从 1 起算
      return { line, column, message: msg };
    }
    // 3) 兜底：无位置信息
    return { line: 0, column: 0, message: msg };
  }
}

export function formatJson(text, indent = 2) {
  const err = locateJsonError(text);
  if (err) return { ok: false, output: "", error: err };
  const obj = JSON.parse(text);
  return { ok: true, output: JSON.stringify(obj, null, indent), error: null };
}

// 解析为 JS 值（供树视图使用）。成功 { ok:true, value, error:null }；失败 { ok:false, value:null, error }。
export function parseJson(text) {
  const err = locateJsonError(text);
  if (err) return { ok: false, value: null, error: err };
  return { ok: true, value: JSON.parse(text), error: null };
}

export function minifyJson(text) {
  const err = locateJsonError(text);
  if (err) return { ok: false, output: "", error: err };
  const obj = JSON.parse(text);
  return { ok: true, output: JSON.stringify(obj), error: null };
}

// 把任意文本转成可嵌入代码的字符串字面量内容（不含首尾引号）。永不失败。
export function escapeJson(text) {
  const s = JSON.stringify(String(text)); // 带首尾引号
  return { ok: true, output: s.slice(1, -1), error: null };
}

// 数据统计（基于已解析值）：最大容器嵌套深度、对象/数组数量、键值对总数。
// 标量根返回全 0；根容器深度记 1。
export function jsonStats(value) {
  const s = { depth: 0, objects: 0, arrays: 0, keys: 0 };
  walk(value, 1);
  return s;

  function walk(v, d) {
    if (Array.isArray(v)) {
      s.arrays++;
      if (d > s.depth) s.depth = d;
      for (const x of v) walk(x, d + 1);
    } else if (v !== null && typeof v === "object") {
      s.objects++;
      if (d > s.depth) s.depth = d;
      const ks = Object.keys(v);
      s.keys += ks.length;
      for (const k of ks) walk(v[k], d + 1);
    }
  }
}

// 反向还原：把字面量内容当作 JSON 字符串解析。
export function unescapeJson(text) {
  try {
    const output = JSON.parse('"' + String(text) + '"');
    return { ok: true, output, error: null };
  } catch (e) {
    return { ok: false, output: "", error: { line: 0, column: 0, message: String(e && e.message ? e.message : e) } };
  }
}

// ---------- 一键脱敏（纯本地，隐私数据不出机器） ----------
// 双重识别：①键名命中敏感词 → 字符串/数字值整体脱敏；②键名未命中但值形态像手机/身份证/邮箱/银行卡/IP → 按形态脱敏。
// 脱敏保留形状（长度/首尾特征），方便脱敏后仍能看出字段含义、交给 AI mock。
// 中文敏感词表来自字典 json.sensitiveKeyWords（功能数据，中英字典同值，保证行为一致）。
const SENSITIVE_KEY = new RegExp(
  `(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth|session|cookie|phone|mobile|tel\\b|telephone|id[_-]?card|idcard|identity|ssn|passport|bank|card[_-]?no|account|email|mail\\b|address|addr\\b|salary|${i18n.global.t("json.sensitiveKeyWords")})`,
  "i",
);

// 值形态规则（键名未命中时兼顾）
const RE_PHONE = /^1[3-9]\d{9}$/; // 大陆手机号
const RE_IDCARD = /^\d{17}[\dXx]$|^\d{15}$/; // 身份证
const RE_EMAIL = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const RE_BANKCARD = /^\d{14,19}$/;
const RE_IP = /^(\d{1,3}\.){3}\d{1,3}$/;

// 保留首尾、中间打星；短字符串全星
function maskStr(s, keep = 2) {
  const str = String(s);
  if (str.length <= keep * 2) return "*".repeat(Math.max(3, str.length));
  return str.slice(0, keep) + "*".repeat(Math.min(8, str.length - keep * 2)) + str.slice(-keep);
}
function maskEmail(s) {
  const [name, ...rest] = String(s).split("@");
  return maskStr(name, 1) + "@" + rest.join("@");
}
function maskByShape(s) {
  if (RE_EMAIL.test(s)) return maskEmail(s);
  if (RE_PHONE.test(s)) return s.slice(0, 3) + "****" + s.slice(-4);
  if (RE_IDCARD.test(s)) return s.slice(0, 4) + "*".repeat(s.length - 8) + s.slice(-4);
  if (RE_BANKCARD.test(s)) return s.slice(0, 4) + " **** **** " + s.slice(-4);
  if (RE_IP.test(s)) return s.split(".").slice(0, 2).join(".") + ".*.*";
  return null; // 形态未命中
}

// 脱敏任意 JSON 值（递归）。返回 { value, count }。
export function maskJson(value) {
  let count = 0;
  const walk = (v, keyHit) => {
    if (Array.isArray(v)) return v.map((x) => walk(x, keyHit));
    if (v !== null && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v)) out[k] = walk(v[k], SENSITIVE_KEY.test(k));
      return out;
    }
    if (typeof v === "string" && v) {
      if (keyHit) { count++; return maskByShape(v) || maskStr(v); }
      const shaped = maskByShape(v);
      if (shaped !== null) { count++; return shaped; }
      return v;
    }
    if (typeof v === "number" && keyHit) { count++; return 0; }
    return v;
  };
  const masked = walk(value, false);
  return { value: masked, count };
}

// 便捷：对 JSON 文本脱敏，保持与其他工具函数一致的返回结构（额外带 count）。
export function maskJsonText(text, indent = 2) {
  const err = locateJsonError(text);
  if (err) return { ok: false, output: "", error: err, count: 0 };
  const { value, count } = maskJson(JSON.parse(text));
  return { ok: true, output: JSON.stringify(value, null, indent), error: null, count };
}
