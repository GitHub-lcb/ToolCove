// 企业服务器数据桥（二期）：invoke 的 load_data/save_data 在企业配置存在时改走这里。
//
// ──────────────────────────────── API 契约 ────────────────────────────────
// 服务端实现见 server/enterprise-server.js，以下为客户端与服务端的约定（契约即本注释）：
//
//   POST {baseUrl}/v1/auth/ping
//     Header: Authorization: Bearer <token>
//     → 200 { ok: true, name?, role? }   name 为当前成员名，role 为 "admin" | "member"
//     → 401                        token 无效或已过期
//     → 网络错误/超时              按「不可达」处理
//
//   GET {baseUrl}/v1/kv/{encodeURIComponent(key)}
//     Header: Authorization: Bearer <token>
//     → 200 { data: any }
//     → 404                        键不存在（调用方按 load_data 的空值约定映射为 []）
//     → 401                        token 无效或已过期
//
//   PUT {baseUrl}/v1/kv/{encodeURIComponent(key)}
//     Header: Authorization: Bearer <token>，Content-Type: application/json
//     Body: { data: any }
//     → 200 { ok: true }
//     → 401                        token 无效或已过期
//     → 413                        数据过大（服务端应配有可调的体积上限）
//
//   GET {baseUrl}/v1/members
//     Header: Authorization: Bearer <token>
//     → 200 { members: [{ id, name, role, createdAt }] }
//     → 401                        token 无效或已过期
//     → 403                        当前令牌不是管理员（403）
//
//   POST {baseUrl}/v1/members
//     Header: Authorization: Bearer <token>，Content-Type: application/json
//     Body: { name: string, role?: "admin" | "member" }   role 省略时服务端取默认（member）
//     → 201 { member: { id, name, role, createdAt }, token: "tc_…" }   令牌只返回这一次
//     → 400                        缺少 name
//     → 401 / 403
//     → 409 { error: "seat_limit" } 席位已超上限
//
//   DELETE {baseUrl}/v1/members/{id}
//     Header: Authorization: Bearer <token>
//     → 200 { ok: true }
//     → 400 { error: "cannot_revoke_self" } 删除自己
//     → 401 / 403
//     → 404                        成员不存在
//
// ──────────────────────────────── 设计要点 ────────────────────────────────
// - 配置（baseUrl/token）存**本地**（见 app/enterpriseServer.js），数据走远端——
//   配置若也走远端就是自举悖论：要读配置得先连服务器，要连服务器得先读配置。
// - 失败**不自动降级写本地**：本地写一半、远端写一半就是数据分裂，错误必须抛给调用方，
//   由界面如实呈现「企业服务器连不上」，而不是悄悄写去另一个存储。
// - 带修订号的 load/save_data_versioned 暂不接远端：契约还没有修订号/CAS 语义，
//   等契约扩展后再路由（见 invoke.js 的路由注释）。
import { setRuntimeEdition } from "./env.js";

// fetch 可注入：单测用 _setFetch 替换，生产用全局 fetch。
// 用包装函数而不是直接持有 fetch 引用：某些环境下全局 fetch 是后补的，求值期固化会拿到 undefined。
let fetchImpl = (...args) => fetch(...args);

/** 测试钩子：注入 mock fetch；传 null 恢复全局 fetch。 */
export function _setFetch(impl) {
  fetchImpl = impl || ((...args) => fetch(...args));
}

// 模块级配置状态：{ baseUrl, token }；baseUrl 已去尾斜杠。null = 未配置（走本地通道）。
let remoteConfig = null;

/**
 * 配置/清空企业服务器。有效配置（baseUrl 与 token 均非空）会把运行时版本派生为
 * enterprise（env.js 的 __TOOLCOVE_EDITION__ 测试钩子始终优先，不受影响）；
 * 清空或无效输入则回落 personal。
 */
export function configureRemote(config) {
  const baseUrl = String(config?.baseUrl || "").trim().replace(/\/+$/, "");
  const token = String(config?.token || "").trim();
  remoteConfig = baseUrl && token ? { baseUrl, token } : null;
  setRuntimeEdition(remoteConfig ? "enterprise" : null);
}

export function remoteConfigured() {
  return remoteConfig !== null;
}

/** 当前配置的只读副本（设置页「连接测试」需要先暂存旧配置、失败再恢复）。 */
export function getRemoteConfig() {
  return remoteConfig ? { ...remoteConfig } : null;
}

/** 带 code 的错误：调用方按 code 分流文案/重试策略，不解析 message。 */
function remoteError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const PING_TIMEOUT_MS = 8000;
const DATA_TIMEOUT_MS = 10000;
const MEMBER_TIMEOUT_MS = 10000;

/**
 * fetch + 超时。网络层的一切失败（DNS/拒连/超时/中断）统一归一为 REMOTE_UNREACHABLE：
 * 对调用方而言它们没有区别——都是「这台机器现在够不到企业服务器」。
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } catch (error) {
    const isAbort = error && error.name === "AbortError";
    throw remoteError("REMOTE_UNREACHABLE", isAbort ? `请求超时（${timeoutMs}ms）` : `网络错误：${error?.message || error}`);
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders() {
  return { Authorization: `Bearer ${remoteConfig.token}` };
}

/** 解析 JSON 响应体；非 JSON 视为服务端契约破坏，归一 REMOTE_ERROR。 */
async function readJson(res) {
  try {
    return await res.json();
  } catch {
    throw remoteError("REMOTE_ERROR", `响应不是合法 JSON（HTTP ${res.status}）`);
  }
}

/**
 * 连接测试：不抛异常，结果形状 { ok, name?, error? }，error 为错误码——
 * 设置页要把它当「状态」展示，而不是当异常处理。
 */
export async function remotePing({ timeoutMs = PING_TIMEOUT_MS } = {}) {
  if (!remoteConfig) return { ok: false, error: "REMOTE_NOT_CONFIGURED" };
  try {
    const res = await fetchWithTimeout(`${remoteConfig.baseUrl}/v1/auth/ping`, { method: "POST", headers: authHeaders() }, timeoutMs);
    if (res.status === 401) return { ok: false, error: "REMOTE_UNAUTHORIZED" };
    if (!res.ok) return { ok: false, error: "REMOTE_ERROR" };
    const body = await readJson(res);
    return {
      ok: true,
      name: typeof body?.name === "string" ? body.name : undefined,
      role: typeof body?.role === "string" ? body.role : undefined,
    };
  } catch (error) {
    return { ok: false, error: error?.code || "REMOTE_UNREACHABLE" };
  }
}

/**
 * 读数据。404 映射为空数组——对齐 load_data 的既有空值约定
 * （桌面端文件缺失返回 []，浏览器端键缺失返回 []，见 backends/browser.js）。
 */
export async function remoteLoad(key, { timeoutMs = DATA_TIMEOUT_MS } = {}) {
  if (!remoteConfig) throw remoteError("REMOTE_NOT_CONFIGURED", "企业服务器未配置");
  const res = await fetchWithTimeout(`${remoteConfig.baseUrl}/v1/kv/${encodeURIComponent(key)}`, { method: "GET", headers: authHeaders() }, timeoutMs);
  if (res.status === 404) return [];
  if (res.status === 401) throw remoteError("REMOTE_UNAUTHORIZED", "令牌无效或已过期（401）");
  if (!res.ok) throw remoteError("REMOTE_ERROR", `服务器返回 HTTP ${res.status}`);
  const body = await readJson(res);
  return body?.data === undefined ? [] : body.data;
}

/** 写数据。失败抛带 code 的错误，由调用方决定重试/报错——绝不静默降级写本地（数据分裂）。 */
export async function remoteSave(key, data, { timeoutMs = DATA_TIMEOUT_MS } = {}) {
  if (!remoteConfig) throw remoteError("REMOTE_NOT_CONFIGURED", "企业服务器未配置");
  const res = await fetchWithTimeout(
    `${remoteConfig.baseUrl}/v1/kv/${encodeURIComponent(key)}`,
    { method: "PUT", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ data: data ?? null }) },
    timeoutMs
  );
  if (res.status === 401) throw remoteError("REMOTE_UNAUTHORIZED", "令牌无效或已过期（401）");
  if (res.status === 413) throw remoteError("REMOTE_TOO_LARGE", "数据超过服务器体积上限（413）");
  if (!res.ok) throw remoteError("REMOTE_ERROR", `服务器返回 HTTP ${res.status}`);
}

/**
 * 成员名册（管理员）。403 → REMOTE_FORBIDDEN：调用方据此展示「当前令牌不是管理员」，
 * 而不是当成一般错误。契约：200 { members: [{ id, name, role, createdAt }] }。
 */
export async function remoteMembers({ timeoutMs = MEMBER_TIMEOUT_MS } = {}) {
  if (!remoteConfig) throw remoteError("REMOTE_NOT_CONFIGURED", "企业服务器未配置");
  const res = await fetchWithTimeout(`${remoteConfig.baseUrl}/v1/members`, { method: "GET", headers: authHeaders() }, timeoutMs);
  if (res.status === 401) throw remoteError("REMOTE_UNAUTHORIZED", "令牌无效或已过期（401）");
  if (res.status === 403) throw remoteError("REMOTE_FORBIDDEN", "当前令牌不是管理员（403）");
  if (!res.ok) throw remoteError("REMOTE_ERROR", `服务器返回 HTTP ${res.status}`);
  const body = await readJson(res);
  return { members: Array.isArray(body?.members) ? body.members : [] };
}

/**
 * 新建成员并签发令牌（管理员）。返回的 token **只出现这一次**，调用方必须当场交给用户。
 * 409 → REMOTE_SEAT_LIMIT（席位超限），400 → REMOTE_ERROR（缺 name）。
 * role 省略时**不带该字段**，交给服务端取默认角色。
 */
export async function remoteCreateMember({ name, role } = {}, { timeoutMs = MEMBER_TIMEOUT_MS } = {}) {
  if (!remoteConfig) throw remoteError("REMOTE_NOT_CONFIGURED", "企业服务器未配置");
  const payload = { name };
  if (role) payload.role = role;
  const res = await fetchWithTimeout(
    `${remoteConfig.baseUrl}/v1/members`,
    { method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify(payload) },
    timeoutMs
  );
  if (res.status === 401) throw remoteError("REMOTE_UNAUTHORIZED", "令牌无效或已过期（401）");
  if (res.status === 403) throw remoteError("REMOTE_FORBIDDEN", "当前令牌不是管理员（403）");
  if (res.status === 400) throw remoteError("REMOTE_ERROR", "缺少成员名称（400）");
  if (res.status === 409) throw remoteError("REMOTE_SEAT_LIMIT", "席位已超上限（409）");
  if (!res.ok) throw remoteError("REMOTE_ERROR", `服务器返回 HTTP ${res.status}`);
  const body = await readJson(res);
  return { member: body?.member, token: body?.token };
}

/**
 * 撤销成员（管理员）。400 → 带 code "CANNOT_REVOKE_SELF" 的错误（删自己），404 → REMOTE_ERROR（不存在）。
 */
export async function remoteRevokeMember(id, { timeoutMs = MEMBER_TIMEOUT_MS } = {}) {
  if (!remoteConfig) throw remoteError("REMOTE_NOT_CONFIGURED", "企业服务器未配置");
  const res = await fetchWithTimeout(`${remoteConfig.baseUrl}/v1/members/${encodeURIComponent(id)}`, { method: "DELETE", headers: authHeaders() }, timeoutMs);
  if (res.status === 401) throw remoteError("REMOTE_UNAUTHORIZED", "令牌无效或已过期（401）");
  if (res.status === 403) throw remoteError("REMOTE_FORBIDDEN", "当前令牌不是管理员（403）");
  if (res.status === 400) throw remoteError("CANNOT_REVOKE_SELF", "不能撤销自己（400）");
  if (res.status === 404) throw remoteError("REMOTE_ERROR", "成员不存在（404）");
  if (!res.ok) throw remoteError("REMOTE_ERROR", `服务器返回 HTTP ${res.status}`);
  return { ok: true };
}
