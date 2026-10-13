// 照片对象 key 的生成与解析：手机上传与桌面归档唯一的命名口径。
//
// 格式：<prefix>/YYYY/MM/DD/YYYYMMDDTHHmmss_<设备6位>_<随机4位>.<ext>
//   · 目录段是拍摄日期（本地时间）——桌面按目录直接分日期归档，不必反查元数据；
//   · 文件名以同一时刻开头——同一天内字典序 = 时间序，云端列表天然按时间排列；
//   · 设备短 id + 随机段保证不重名：两台手机在同一秒拍照也不会互相覆盖；
//   · 字符集限定 [a-z0-9]（目录段 / 时间 / 后缀），从源头保证 key 无需 URL/XML 转义——
//     签名与列举解析因此可以保持简单（这个前提被测试守住，见 keys.test.js）。
export const DEFAULT_PREFIX = "photos";

const DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2})$/;
const FILE_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})_([0-9a-f]{6})_([0-9a-f]{4})\.([a-z0-9]{1,5})$/;

const MIME_EXT = Object.freeze({
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heic",
  "image/avif": "avif",
  "image/bmp": "bmp",
});

const NAME_EXT_RE = /\.([A-Za-z0-9]{1,5})$/;

/** 前缀规范化：去空白与首尾斜杠；不合法字符原样保留，交由校验器报错（不静默改写用户输入）。 */
export function normalizePrefix(prefix) {
  const raw = String(prefix ?? "").trim().replace(/^\/+|\/+$/g, "");
  return raw || DEFAULT_PREFIX;
}

export function isValidPrefix(prefix) {
  return /^[A-Za-z0-9][A-Za-z0-9/._-]*$/.test(prefix) && !prefix.includes("//");
}

/** 后缀：优先原文件名，其次 MIME，最后兜底 jpg（不认识的视频/文档也按现状存，能打开就行）。 */
export function extensionFor(name, mime) {
  const nameMatch = NAME_EXT_RE.exec(String(name ?? ""));
  if (nameMatch) return nameMatch[1].toLowerCase();
  const type = String(mime ?? "").toLowerCase().split(";")[0].trim();
  return MIME_EXT[type] || "jpg";
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

/** 本地时间戳（不是 UTC）：照片的"哪一天"应以拍摄者所在时区为准。 */
export function formatStamp(date) {
  return (
    `${pad(date.getFullYear(), 4)}${pad(date.getMonth() + 1, 2)}${pad(date.getDate(), 2)}` +
    `T${pad(date.getHours(), 2)}${pad(date.getMinutes(), 2)}${pad(date.getSeconds(), 2)}`
  );
}

export function dateParts(date) {
  return { y: pad(date.getFullYear(), 4), m: pad(date.getMonth() + 1, 2), d: pad(date.getDate(), 2) };
}

/** 设备短 id：6 位十六进制，落一次配置长期不变（不同手机的 key 一眼可分）。 */
export function generateDeviceId(bytes) {
  const source = bytes || (typeof crypto !== "undefined" && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(3)) : null);
  const arr = source || new Uint8Array([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)]);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomSuffix(bytes) {
  const source = bytes || (typeof crypto !== "undefined" && crypto.getRandomValues ? crypto.getRandomValues(new Uint8Array(2)) : null);
  const arr = source || new Uint8Array([Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)]);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function buildObjectKey({ capturedAt, deviceId, ext, prefix, rnd }) {
  const at = capturedAt instanceof Date ? capturedAt : new Date(Number(capturedAt) || Date.now());
  const { y, m, d } = dateParts(at);
  const device = /^[0-9a-f]{6}$/.test(String(deviceId)) ? String(deviceId) : generateDeviceId();
  const suffix = String(ext || "jpg").toLowerCase();
  const base = normalizePrefix(prefix);
  return `${base}/${y}/${m}/${d}/${formatStamp(at)}_${device}_${randomSuffix(rnd)}.${suffix}`;
}

/**
 * 解析 key。返回 null 表示不是本工具生成的命名——
 * 桌面归档遇到这类对象（例如用户通过其它工具放进同一目录）应如实跳过，而不是硬猜日期。
 */
export function parseObjectKey(key, prefix = DEFAULT_PREFIX) {
  const text = String(key ?? "");
  const base = normalizePrefix(prefix);
  const rest = text.slice(base.length + 1);
  if (!text.startsWith(base + "/")) return null;
  const slash = rest.lastIndexOf("/");
  if (slash === -1) return null;
  const dir = rest.slice(0, slash);
  const file = rest.slice(slash + 1);

  const dirMatch = DATE_RE.exec(dir);
  const fileMatch = FILE_RE.exec(file);
  if (!dirMatch || !fileMatch) return null;
  // 目录段日期与文件名日期必须一致：不一致说明 key 被人改过，宁可跳过也不猜
  if (dirMatch[1] !== fileMatch[1] || dirMatch[2] !== fileMatch[2] || dirMatch[3] !== fileMatch[3]) return null;

  return {
    date: `${dirMatch[1]}-${dirMatch[2]}-${dirMatch[3]}`,
    stamp: `${fileMatch[1]}${fileMatch[2]}${fileMatch[3]}T${fileMatch[4]}${fileMatch[5]}${fileMatch[6]}`,
    device: fileMatch[7],
    ext: fileMatch[9],
    file,
  };
}
