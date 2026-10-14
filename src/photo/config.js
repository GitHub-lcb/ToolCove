// 照片存储的配置模型：字段、校验、URL 组装。
//
// 三个后端各自一套凭据形状，但共享同一份配置对象（平铺字段，不做嵌套）：
//   s3      —— 腾讯 COS / MinIO / Cloudflare R2 / AWS S3（SigV4）
//   qiniu   —— 七牛云 Kodo（上传 token = HMAC-SHA1 策略签名）
//   webdav  —— 坚果云 / 群晖 / Nextcloud（Basic 认证）
// 字段的可见性由 PHOTO_PROVIDERS[].fields 决定，视图按它渲染，校验按 provider 分支。
import { DEFAULT_PREFIX, isValidPrefix, normalizePrefix } from "./keys.js";
import { uriEncode } from "./sigv4.js";

export const PHOTO_PROVIDERS = Object.freeze([
  {
    key: "s3",
    labelKey: "toolbox.photo.providerS3",
    hintKey: "toolbox.photo.providerS3Hint",
    fields: ["endpoint", "region", "bucket", "accessKey", "secretKey", "sessionToken", "pathStyle", "prefix"],
  },
  {
    key: "qiniu",
    labelKey: "toolbox.photo.providerQiniu",
    hintKey: "toolbox.photo.providerQiniuHint",
    fields: ["bucket", "accessKey", "secretKey", "domain", "uploadHost", "privateBucket", "relayUrl", "prefix"],
  },
  {
    key: "webdav",
    labelKey: "toolbox.photo.providerWebdav",
    hintKey: "toolbox.photo.providerWebdavHint",
    fields: ["endpoint", "username", "password", "prefix"],
  },
]);

/** 七牛表单上传的默认域名；但**新机房的空间不认这个全局域名**——上传前要用
 * api.qiniu.com/v2/query 做区域解析（见 qiniu.js resolveQiniuUploadHost），它只是兜底。 */
export const QINIU_DEFAULT_UPLOAD_HOST = "upload.qiniup.com";

export function defaultPhotoConfig() {
  return {
    provider: "s3",
    endpoint: "",
    region: "",
    bucket: "",
    accessKey: "",
    secretKey: "",
    sessionToken: "",
    pathStyle: false,
    // 七牛专有
    domain: "",
    uploadHost: QINIU_DEFAULT_UPLOAD_HOST,
    privateBucket: true,
    // 网页版的"补头转发"地址（可选）：七牛管理接口必须带 Authorization 头，
    // 而它的域名对浏览器预检不放行——网页版只能经一个自建的转发补头。
    // App 与桌面端走原生请求，永远不需要它。部署方式见 docs/photo-relay.md。
    relayUrl: "",
    // WebDAV 专有
    username: "",
    password: "",
    prefix: DEFAULT_PREFIX,
    deviceId: "",
  };
}

/** 去掉协议头与末尾斜杠（用户常把完整 URL 粘进来）。 */
function bareHost(value) {
  return String(value ?? "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/g, "");
}

/** WebDAV 基地址反过来：必须有协议头，且去掉末尾斜杠。 */
function davBase(value) {
  const raw = String(value ?? "").trim().replace(/\/+$/g, "");
  if (!raw) return "";
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

export function normalizePhotoConfig(input) {
  const base = { ...defaultPhotoConfig(), ...(input && typeof input === "object" ? input : {}) };
  return {
    ...base,
    provider: String(base.provider || "s3").trim(),
    endpoint: base.provider === "webdav" ? davBase(base.endpoint) : bareHost(base.endpoint),
    region: String(base.region ?? "").trim(),
    bucket: String(base.bucket ?? "").trim(),
    accessKey: String(base.accessKey ?? "").trim(),
    secretKey: String(base.secretKey ?? "").trim(),
    sessionToken: String(base.sessionToken ?? "").trim(),
    pathStyle: Boolean(base.pathStyle),
    domain: bareHost(base.domain),
    uploadHost: bareHost(base.uploadHost) || QINIU_DEFAULT_UPLOAD_HOST,
    privateBucket: base.privateBucket !== false,
    relayUrl: String(base.relayUrl ?? "").trim(),
    // 转发地址保留完整 URL（含路径），只做协议校验；空串 = 未配置
    username: String(base.username ?? "").trim(),
    password: String(base.password ?? ""),
    prefix: normalizePrefix(base.prefix),
    deviceId: String(base.deviceId ?? "").trim().toLowerCase(),
  };
}

/**
 * 转发地址是否合法。
 *
 * 规则：`https://` 任意主机；`http://` **只允许回环**（127.0.0.1 / localhost / [::1]）。
 * 为什么要放行 http 回环：网页版很可能就在**运行转发器的同一台电脑**上打开，而浏览器把回环地址
 * 视为可信来源——从 https 页面请求它不算混合内容，于是"本机一条命令"就能把网页版跑通，
 * 不需要域名、证书、账号。公网地址仍然必须 https（否则页面会被混合内容拦掉）。
 */
export function isValidRelayUrl(value) {
  const text = String(value ?? "").trim();
  if (/^https:\/\/[^\s/"']+(?:\/[^\s]*)?$/.test(text)) return true;
  return /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?(?:\/[^\s]*)?$/.test(text);
}

const HOST_RE = /^[A-Za-z0-9.\-:]+$/;

/**
 * 校验。返回的 errors 是**原因码**而不是文案——与 downloader.validateDest 同一约定，
 * 文案由视图的 i18n 层决定（同一份配置要在中英两个界面里说清楚）。
 */
export function validatePhotoConfig(input) {
  const cfg = normalizePhotoConfig(input);
  const errors = {};

  if (!isValidPrefix(cfg.prefix)) errors.prefix = "prefixBad";

  if (cfg.provider === "qiniu") {
    if (!cfg.bucket) errors.bucket = "bucketEmpty";
    else if (!/^[A-Za-z0-9._-]+$/.test(cfg.bucket)) errors.bucket = "bucketBad";
    if (!cfg.accessKey) errors.accessKey = "keyEmpty";
    if (!cfg.secretKey) errors.secretKey = "secretEmpty";
    if (!cfg.domain) errors.domain = "domainEmpty";
    else if (!HOST_RE.test(cfg.domain)) errors.domain = "domainBad";
    if (!cfg.uploadHost) errors.uploadHost = "uploadHostEmpty";
    else if (!HOST_RE.test(cfg.uploadHost)) errors.uploadHost = "uploadHostBad";
    if (cfg.relayUrl && !isValidRelayUrl(cfg.relayUrl)) errors.relayUrl = "relayUrlBad";
  } else if (cfg.provider === "webdav") {
    if (!cfg.endpoint) errors.endpoint = "endpointEmpty";
    else if (!/^https?:\/\/[A-Za-z0-9.\-:]+(?:\/[^\s]*)?$/.test(cfg.endpoint)) errors.endpoint = "endpointBad";
    if (!cfg.username) errors.username = "userEmpty";
    if (!cfg.password) errors.password = "passEmpty";
  } else {
    if (!cfg.endpoint) errors.endpoint = "endpointEmpty";
    else if (!HOST_RE.test(cfg.endpoint)) errors.endpoint = "endpointBad";
    if (!cfg.region) errors.region = "regionEmpty";
    if (!cfg.bucket) errors.bucket = "bucketEmpty";
    else if (!/^[A-Za-z0-9._-]+$/.test(cfg.bucket)) errors.bucket = "bucketBad";
    if (!cfg.accessKey) errors.accessKey = "keyEmpty";
    if (!cfg.secretKey) errors.secretKey = "secretEmpty";
  }

  return { ok: Object.keys(errors).length === 0, errors, config: cfg };
}

// ---------- S3 ----------

/** 请求真正落到哪个主机：虚拟主机风格是 bucket 前缀域名（COS/R2/AWS 默认），路径风格是裸域名（MinIO 常用）。 */
export function photoHost(cfg) {
  const c = normalizePhotoConfig(cfg);
  return c.pathStyle ? c.endpoint : `${c.bucket}.${c.endpoint}`;
}

/** 未编码的原始路径（签名内部与 URL 组装共用同一份，保证 canonical URI 与实际请求一致）。 */
export function photoObjectPath(cfg, key) {
  const c = normalizePhotoConfig(cfg);
  const cleanKey = String(key ?? "").replace(/^\/+/, "");
  return c.pathStyle ? `/${c.bucket}/${cleanKey}` : `/${cleanKey}`;
}

export function photoObjectUrl(cfg, key) {
  return `https://${photoHost(cfg)}${uriEncode(photoObjectPath(cfg, key), false)}`;
}

// ---------- 七牛 ----------

/** 七牛的文件访问地址：<访问域名>/<key>（私有桶由下载方在 query 里带 token）。 */
export function qiniuObjectUrl(cfg, key) {
  const c = normalizePhotoConfig(cfg);
  const cleanKey = String(key ?? "").replace(/^\/+/, "");
  return `https://${c.domain}/${cleanKey}`;
}

/** 表单上传地址（七牛的区域上传域名，全球统一入口 upload.qiniup.com 会重定向）。 */
export function qiniuUploadUrl(cfg) {
  const c = normalizePhotoConfig(cfg);
  return `https://${c.uploadHost}/`;
}

// ---------- WebDAV ----------

/** 对象完整地址：<基地址>/<key>（基地址在 normalize 时已保证有协议头、无尾斜杠）。 */
export function webdavObjectUrl(cfg, key) {
  const c = normalizePhotoConfig(cfg);
  const cleanKey = String(key ?? "").replace(/^\/+/, "");
  return `${c.endpoint}/${cleanKey}`;
}

// ---------- 导出 / 导入 ----------
//
// 用途：同一套存储要在手机、桌面、备用设备上重复填写，逐字段敲一遍又慢又容易错。
// 导出成一段文本，另一台设备粘贴即可。
//
// 两条硬约定：
//   1. 导出的是**明文**密钥（否则另一边没法用）——界面必须提示"只发给自己"；
//   2. deviceId 不随导出走——它是"这台设备"的身份（照片 key 的设备段），
//      带过去会让两台设备共用一个标识，失去区分意义。

export const PHOTO_CONFIG_EXPORT_KIND = "toolcove-photo-storage";
export const PHOTO_CONFIG_EXPORT_VERSION = 1;

/** 生成可粘贴的导出文本（pretty JSON，人工可读、出问题能直接看出来）。 */
export function exportPhotoConfig(input) {
  const cfg = normalizePhotoConfig(input);
  const { deviceId: _ignored, ...portable } = cfg;
  return JSON.stringify({ kind: PHOTO_CONFIG_EXPORT_KIND, version: PHOTO_CONFIG_EXPORT_VERSION, config: portable }, null, 2);
}

/**
 * 解析导入文本。容错两件事：允许粘贴裸配置对象（用户可能只复制了 config 段），
 * 允许版本号缺省。provider 必须是我们认识的——拼错一个字母就静默按 S3 走，比报错糟得多。
 * 失败返回原因码（badJson / badKind / badVersion / badProvider / invalid+errors）。
 */
export function parsePhotoConfigExport(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? "").trim());
  } catch {
    return { ok: false, error: "badJson" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ok: false, error: "badJson" };

  let raw = data;
  if ("kind" in data || "config" in data) {
    if (data.kind && data.kind !== PHOTO_CONFIG_EXPORT_KIND) return { ok: false, error: "badKind" };
    if (Number(data.version || 0) > PHOTO_CONFIG_EXPORT_VERSION) return { ok: false, error: "badVersion" };
    raw = data.config;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "badJson" };
  }

  const check = validatePhotoConfig(raw);
  if (!PHOTO_PROVIDERS.some((p) => p.key === check.config.provider)) return { ok: false, error: "badProvider" };
  if (!check.ok) return { ok: false, error: "invalid", errors: check.errors };
  // 设备 id 留空交给调用方：导入只换存储配置，不换这台设备的身份
  return { ok: true, config: normalizePhotoConfig({ ...check.config, deviceId: "" }) };
}
