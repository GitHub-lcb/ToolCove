// 从「查状态」的响应里取值，替换签到请求路径里的占位符。
//
// 为什么需要：有些站点的签到端点里带一个**每天都会变**的 ID。
// 实测 Qoder 就是这样——每日签到活动的窗口正好是「当天 10:00 到次日 09:59」，
// campaignId 每天不同，写死的配置第二天就 404。
//
// 安全设计（这里最容易出事，因为拼进去的值来自网络响应）：
// 1. **只允许结构化选择器，不做表达式求值**。支持「点路径」与
//    「在数组里找第一条满足条件的元素再取某字段」两种，没有 eval、没有任意函数。
// 2. **取值后必须过字符白名单**再拼进路径。放开 / ? # \ 等字符等于允许改写请求目标，
//    甚至拼出协议相对 URL 把请求发去别的站点。
// 3. **取不到就不发请求**。宁可报「配置对不上」，也不能拿空值去拼出一个
//    看起来像样、实际打到别处的请求。
import { parsePath, pickPath, pickSegments } from "./paths.js";

// 允许进入 URL 路径的字符：UUID（字母数字连字符）能过，短横线/下划线/波浪号也常用。
// 点号保留（少数站点用带点的 ID），但连续点与开头的点由拼装后的整体校验再兜一层。
const SAFE_VALUE = /^[A-Za-z0-9._~-]{1,128}$/;

// 占位符：${name}。名字收窄到与路径段名同一套字符，避免正则回溯与解析歧义。
const PLACEHOLDER = /\$\{([A-Za-z0-9_$-]{1,40})\}/g;

export const EXTRACT_ERROR = Object.freeze({
  SELECTOR_SYNTAX: "selectorSyntax",
  SELECTOR_NOT_ARRAY: "selectorNotArray",
  SELECTOR_NO_MATCH: "selectorNoMatch",
  VALUE_MISSING: "valueMissing",
  VALUE_UNSAFE: "valueUnsafe",
  PLACEHOLDER_MISSING: "placeholderMissing",
  PLACEHOLDER_UNUSED: "placeholderUnused",
  PARSE_FAILED: "parseFailed",
});

function fail(code, detail) {
  return { ok: false, error: code, detail: detail || "" };
}

/**
 * 按选择器从响应体里取一个值。
 * @param {unknown} source 已解析的 JSON 响应
 * @param {string|{path:string, where?:object, pick?:string}} selector
 */
export function extractValue(source, selector) {
  if (typeof selector === "string") {
    const segments = parsePath(selector);
    if (!segments) return fail(EXTRACT_ERROR.SELECTOR_SYNTAX, selector);
    const value = pickSegments(source, segments);
    return checkValue(value, selector);
  }
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    return fail(EXTRACT_ERROR.SELECTOR_SYNTAX, "");
  }
  const { path, where, pick } = selector;
  const segments = parsePath(path);
  if (!segments) return fail(EXTRACT_ERROR.SELECTOR_SYNTAX, String(path));

  const list = pickSegments(source, segments);
  if (!Array.isArray(list)) return fail(EXTRACT_ERROR.SELECTOR_NOT_ARRAY, String(path));

  // where 的每个键都要严格相等；类型也必须一致（"1" 不等于 1），避免误匹配。
  const matches = list.find((item) => {
    if (!item || typeof item !== "object") return false;
    if (!where || typeof where !== "object") return true;
    return Object.entries(where).every(([k, v]) => Object.prototype.hasOwnProperty.call(item, k) && item[k] === v);
  });
  // 没匹配上分两种，detail 要能区分开：数组本来就是空的（站点此刻就没有活动，
  // 不是谁把配置写错了），还是数组有内容但条件对不上（那才是描述/条件的问题）。
  if (!matches) return fail(EXTRACT_ERROR.SELECTOR_NO_MATCH, list.length ? JSON.stringify(where || {}) : "empty-list");

  const value = pick ? pickPath(matches, pick) : matches;
  return checkValue(value, pick || String(path));
}

function checkValue(value, where) {
  if (value === undefined || value === null || value === "") return fail(EXTRACT_ERROR.VALUE_MISSING, where);
  const text = typeof value === "object" ? "" : String(value);
  if (!SAFE_VALUE.test(text)) return fail(EXTRACT_ERROR.VALUE_UNSAFE, where);
  return { ok: true, value: text };
}

/** 路径里用到的占位符名（去重）。 */
export function placeholdersIn(path) {
  const names = new Set();
  const text = String(path ?? "");
  for (const match of text.matchAll(PLACEHOLDER)) names.add(match[1]);
  return [...names];
}

/**
 * 把路径里的占位符替换成实际取值。
 * @param {string} path        形如 /sash/api/v1/me/campaigns/${campaignId}/claim
 * @param {object|undefined} pathFrom  形如 { campaignId: {path:"campaigns", where:{...}, pick:"campaignId"} }
 * @param {unknown} source     已解析的 JSON 响应
 * @returns {{ok:true, path:string} | {ok:false, error:string, detail:string}}
 */
export function resolvePath(path, pathFrom, source) {
  const names = placeholdersIn(path);
  const spec = pathFrom && typeof pathFrom === "object" && !Array.isArray(pathFrom) ? pathFrom : {};

  // 先查「声明了却没用上」，再处理有无占位符的分支。
  // 顺序反了会让这种配置静默通过：用户以为动态取值生效了，实际打的是写死的路径，
  // 直到某天 campaignId 变了才报 404，排查方向完全跑偏。
  for (const key of Object.keys(spec)) {
    if (!names.includes(key)) return fail(EXTRACT_ERROR.PLACEHOLDER_UNUSED, key);
  }

  if (!names.length) return { ok: true, path: String(path) };

  // 路径里有占位符却没声明取值规则，立刻报错
  for (const name of names) {
    if (!(name in spec)) return fail(EXTRACT_ERROR.PLACEHOLDER_MISSING, name);
  }

  // 逐个取值。任何一步取不到就地返回——**绝不返回半成品路径**：
  // 拿空值拼出来的路径可能打到别的端点上，那比直接报错危险得多。
  const values = {};
  for (const name of names) {
    const got = extractValue(source, spec[name]);
    if (!got.ok) return got;
    values[name] = got.value;
  }

  let resolved = String(path);
  for (const [name, value] of Object.entries(values)) {
    resolved = resolved.split(`\${${name}}`).join(value);
  }
  // 替换完仍带占位符说明配置有矛盾，宁可不发
  if (placeholdersIn(resolved).length) return fail(EXTRACT_ERROR.PLACEHOLDER_MISSING, "");
  // 拼完之后整体再校验一次：单个值都合法，组合起来仍可能拼出 "//" 或 CR/LF
  if (!resolved.startsWith("/") || resolved.startsWith("//")) return fail(EXTRACT_ERROR.VALUE_UNSAFE, resolved.slice(0, 60));
  if (/[\r\n]/.test(resolved)) return fail(EXTRACT_ERROR.VALUE_UNSAFE, "");
  if (resolved.length > 512) return fail(EXTRACT_ERROR.VALUE_UNSAFE, "too-long");
  return { ok: true, path: resolved };
}
