// 发请求：把 invoke("http_request") 包成「永不抛、只返回结果」的形状。
//
// 与 ai.js / sync 的差异：这里**不让异常穿透到界面**，而是把它变成 { error }。
// 签到是后台定时任务，调用方是调度器不是用户，异常一旦抛出去就没人接——
// 而「失败原因」本身就是要在界面上显示的东西，不该以异常形式存在。
import { invoke } from "../platform/invoke.js";
import { validateDescriptor } from "./descriptor.js";

// Tauri 命令按 camelCase 取参：写 timeout_ms 会被静默忽略并回落 30s（踩过）。
const MAX_TIMEOUT = 120000;

/**
 * @returns {{ok: boolean, status: number, text: string, error: string, retryAfterMs: number}}
 */
export async function requestOnce({ method, url, headers, body, timeoutMs = 20000 }) {
  const limit = Math.min(Math.max(Number(timeoutMs) || 20000, 1000), MAX_TIMEOUT);
  try {
    const res = await invoke("http_request", {
      method: String(method || "GET").toUpperCase(),
      url,
      headers: (headers || []).map(([name, value]) => [name, value]),
      body: body || "",
      timeoutMs: limit,
    });
    return {
      ok: Number(res?.status) >= 200 && Number(res?.status) < 300,
      status: Number(res?.status) || 0,
      text: String(res?.body ?? ""),
      error: "",
      // Retry-After 是服务端给的权威退避时长，比本地猜的 30 分钟准。
      retryAfterMs: parseRetryAfter(res?.headers, limit),
    };
  } catch (error) {
    return { ok: false, status: 0, text: "", error: String(error?.message || error), retryAfterMs: 0 };
  }
}

function parseRetryAfter(headers, fallbackMs) {
  const list = Array.isArray(headers) ? headers : [];
  for (const item of list) {
    const [name, value] = Array.isArray(item) ? item : [item?.name, item?.value];
    if (String(name).toLowerCase() !== "retry-after") continue;
    const seconds = Number(String(value).trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_TIMEOUT);
    const date = Date.parse(String(value));
    if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), MAX_TIMEOUT);
  }
  return fallbackMs;
}

/** baseUrl + path。path 已在校验层保证以 / 开头且不以 // 开头。 */
export function joinUrl(baseUrl, path) {
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const tail = String(path || "");
  return `${base}${tail.startsWith("/") ? tail : `/${tail}`}`;
}

/** 校验一个站点描述并跑一次动作；校验不过直接返回 bad-descriptor，绝不发请求。 */
export async function runAction(descriptorInput, actionName, deps = {}) {
  const request = deps.request || requestOnce;
  const { ok, errors, value } = validateDescriptor(descriptorInput);
  if (!ok) {
    return { response: { ok: false, status: 0, text: "", error: "bad-descriptor", retryAfterMs: 0 }, descriptor: null, errors };
  }
  const action = value[actionName];
  if (!action) {
    return { response: { ok: false, status: 0, text: "", error: `no-${actionName}`, retryAfterMs: 0 }, descriptor: value, errors: [] };
  }
  const response = await request({
    method: action.method,
    url: joinUrl(value.baseUrl, action.path),
    headers: action.headers,
    body: action.body || "",
    timeoutMs: value.timeoutMs,
  });
  return { response, descriptor: value, errors: [] };
}
