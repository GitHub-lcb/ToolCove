// WebDAV 上传侧（浏览器）：Basic 认证 + 逐级 MKCOL + PUT。
//
// 现实约束（不隐瞒）：跨域 PUT 带 Authorization 头会触发预检，服务端必须放行 CORS。
// 坚果云等公共网盘的 WebDAV 默认**不放行**，浏览器直传基本只对能自配 CORS 的服务器
// （自建 Nextcloud / 群晖反代 / Caddy 反代）可用；桌面端与安卓 App 走各自的 HTTP 通道，
// 不受这条限制。界面在选中 WebDAV 时会如实标注。
import { normalizePhotoConfig, webdavObjectUrl } from "./config.js";
import { PhotoError } from "./errors.js";

const encoder = new TextEncoder();

function toBase64(text) {
  const bytes = encoder.encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function webdavAuthHeader(config) {
  const cfg = normalizePhotoConfig(config);
  return `Basic ${toBase64(`${cfg.username}:${cfg.password}`)}`;
}

/** 会话内已确认存在的目录（按"基地址|目录"记；换配置/换桶不会串）。 */
const ensuredDirs = new Set();

/** 测试用：清空目录缓存。 */
export function resetWebdavDirCache() {
  ensuredDirs.clear();
}

/** 上传一个对象：先保证父目录链存在（405 = 已存在，计成功），再 PUT。 */
export async function putWebdavObject({ config, key, body, contentType = "", fetchImpl }) {
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw new PhotoError("noFetch", "当前环境没有 fetch");
  const cfg = normalizePhotoConfig(config);
  const headers = { Authorization: webdavAuthHeader(cfg) };

  const segments = String(key).split("/");
  for (let depth = 1; depth < segments.length; depth += 1) {
    const dir = segments.slice(0, depth).join("/");
    const cacheKey = `${cfg.endpoint}|${dir}`;
    if (ensuredDirs.has(cacheKey)) continue;
    const res = await fetchFn(`${cfg.endpoint}/${dir}`, { method: "MKCOL", headers });
    // 405 Method Not Allowed = 目录已存在；409 在递归建目录的服务器上也可能表示"父级刚建好"
    if (!res.ok && res.status !== 405 && res.status !== 409) {
      throw new PhotoError(`MKCOL HTTP ${res.status}`, dir);
    }
    ensuredDirs.add(cacheKey);
  }

  const putHeaders = contentType ? { ...headers, "Content-Type": contentType } : headers;
  const res = await fetchFn(webdavObjectUrl(cfg, key), { method: "PUT", headers: putHeaders, body });
  if (!res.ok) throw new PhotoError(`HTTP ${res.status}`, "");
  return { status: res.status, etag: (res.headers?.get?.("etag") || "").replace(/"/g, "") };
}
