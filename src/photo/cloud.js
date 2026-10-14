// 云端对象管理：列出 / 预览 / 删除 / 移动（改目录）——手机端「云端」页用的那一层。
//
// 为什么走 platform/invoke 的 http_request 而不是 fetch：
//   · 七牛的管理接口**不给浏览器 CORS**：rsf 的 list 放行简单请求，而 rs.qiniuapi.com 的删/移
//     连 Access-Control-Allow-Origin 都没有——用 fetch 发出去也读不到结果；
//   · 安卓里 http_request 走原生桥（HttpURLConnection）、桌面走 Rust 代理，两者都不受 CORS 约束，
//     凭证放 Authorization 头最稳；
//   · 网页版只能退化成「把凭证放进 access_token 查询参数」（七牛允许这种传法）的简单请求。
//     删/移即使真的执行了也读不到响应，所以**统一用「操作后重新列举」判定成败**——
//     列表用的是放行 CORS 的 rsf，它的结果才是可信的。
import { invoke } from "../platform/invoke.js";
import { hasNativeBridge, isDesktop, isNativeMobile } from "../platform/env.js";
import { normalizePhotoConfig, photoHost, photoObjectPath, webdavObjectUrl } from "./config.js";
import { hmacSha1, resolveQiniuUploadHostDetailed, urlsafeBase64 } from "./qiniu.js";
import { listObjects, s3Request } from "./upload.js";
import { EMPTY_SHA256, signS3Request, uriEncode } from "./sigv4.js";

const encoder = new TextEncoder();

/** 七牛管理接口的默认域名（区域解析失败时的兜底；新机房空间不认它）。 */
export const QINIU_DEFAULT_RSF_HOST = "rsf.qbox.me";

/**
 * 本机转发器的默认地址（server/photo-relay.mjs 的默认监听）。
 *
 * 为什么默认就去试它：网页版最常见的用法就是"在跑转发器的这台电脑上打开"，
 * 而浏览器把回环地址视为可信来源（https 页面请求它不算混合内容）——于是**一条命令、零配置**
 * 就能让网页版跑通。连不上只是"没起"，不算错误，会退回带指引的提示。
 */
export const LOCAL_RELAY_URL = "http://127.0.0.1:8127/";

/** 这一端能不能用 Authorization 头（否则只能走简单请求 + access_token 查询参数）。 */
export function canSendAuthHeader() {
  return isDesktop || isNativeMobile;
}

/** 管理凭证：`QBox AK:sign`，签名串是「METHOD path?query\nHost: host\nContent-Type: ct\n\n」。
 *  与桌面端 Rust 的 qiniu_management_auth 逐字一致——两边必须能互相验证。 */
export async function qiniuManagementAuth({ config, method, host, pathAndQuery, contentType = "application/x-www-form-urlencoded" }) {
  const cfg = normalizePhotoConfig(config);
  const signing = `${method} ${pathAndQuery}\nHost: ${host}\nContent-Type: ${contentType}\n\n`;
  // 两处都不能照抄旧文档（各栽过一次）：
  //  1) 前缀是 **`Qiniu `**（V2 形态），不是 `QBox `——旧 QBox 形态已被服务端拒绝，
  //     实测对 rsf.qbox.me 一律 401 BadToken（见 src-tauri/src/photo.rs 的 qiniu_management_auth 注释）；
  //  2) base64 **带填充**（Rust 的 urlsafe_b64 就是带填充的：urlsafe_b64("hello") == "aGVsbG8="）。
  const sign = urlsafeBase64(await hmacSha1(cfg.secretKey, signing), true);
  return `Qiniu ${cfg.accessKey}:${sign}`;
}

/**
 * 发一次管理接口请求。返回 { ok, status, body }；网络层异常原样抛出（调用方要能看见原因）。
 *
 * 网页版把凭证放查询参数是**唯一**能让浏览器发出去的形式（自定义头会触发预检，而七牛不放行预检）。
 */
/**
 * 网页版（没有原生桥）只能把凭证塞进 access_token 查询参数发简单请求。
 * 但七牛文档写得很明确：**管理请求必须在 HTTP 头里带 Authorization**，
 * 而 rs/rsf 域名对浏览器预检不放行这个头——所以网页版这条路基本走不通，
 * 失败时要给出可执行的指引，而不是把服务端的 "bad token" 原样甩给用户。
 */
/**
 * 网页版（没有原生桥）的现状，写成一句话而不是一句服务端报错：
 *  · 七牛管理接口**只认 Authorization 头**（官方 Go SDK 的 AddToken 只有这一种传法）；
 *  · 七牛的数据域名对浏览器预检不放行这个头（实测 rsf/rs-z2 系列 OPTIONS 均无 Allow-Headers）；
 *  · 所以网页版要么经用户自建的转发补头（relayUrl），要么用 App。
 */
const WEB_HINT_NO_RELAY =
  "网页版无法直接调七牛管理接口：它要求 Authorization 头，而七牛的域名对浏览器预检不放行。" +
  "两个办法：① 用安卓 App 的「云端」页查看/管理；② 在存储配置里填「网页转发地址」——自建一个十几行的转发" +
  "（部署方式见 docs/photo-relay.md），密钥仍只留在本机浏览器里。";

/**
 * 发一次管理接口请求（七牛的 rs/rsf）。
 *
 * 三个形态三条路：
 *   · 安卓 App / 桌面 App：原生请求不受 CORS 约束，凭证直接放 Authorization 头（官方 SDK 的唯一传法）；
 *   · 浏览器：七牛的数据域名对预检不放行 Authorization 头，所以要经「补头转发」——
 *     优先用配置里的 relayUrl；没配就试本机默认端口（网页常常就跑在起了转发器的同一台电脑上，
 *     浏览器把回环视为可信来源，https 页面请求它不算混合内容）；
 *   · 连不上转发就**不硬发**：七牛不认查询参数凭证（真机上验证过），发出去只会得到一句
 *     没法定位的 BadToken，不如直接给可执行的指引。
 *
 * 页面本地签名后才交给转发器，转发器不接触 SK（见 docs/photo-relay.md）。
 */
export async function qiniuManagementRequest({ config, method, host, pathAndQuery, contentType = "application/x-www-form-urlencoded", http }) {
  const auth = await qiniuManagementAuth({ config, method, host, pathAndQuery, contentType });
  const send = http || ((args) => invoke("http_request", args));

  if (canSendAuthHeader()) {
    const result = await send({
      method,
      url: `https://${host}${pathAndQuery}`,
      // ⚠️ `http_request` 的 headers 约定是**键值对数组**（Rust / 安卓桥 / 浏览器适配层三边一致），
      // 传对象会被静默丢掉——安卓上表现为"凭证没发出去 → 401"，而是被丢掉还是发错
      // 在界面上完全看不出来（这个坑真机上踩过一次）。
      headers: [["Authorization", auth], ["Content-Type", contentType]],
      timeoutMs: 20000,
    });
    const status = Number(result?.status || 0);
    return { ok: status >= 200 && status < 300, status, body: String(result?.body ?? "") };
  }

  const cfg = normalizePhotoConfig(config);
  const relayUrl = cfg.relayUrl || LOCAL_RELAY_URL;
  let payload = null;
  try {
    payload = await send({
      method: "POST",
      url: relayUrl,
      headers: [["Content-Type", "application/json"]],
      body: JSON.stringify({
        url: `https://${host}${pathAndQuery}`,
        method,
        headers: { Authorization: auth, "Content-Type": contentType },
      }),
      timeoutMs: 20000,
    });
  } catch (error) {
    // 本机没起转发器时 fetch 直接抛（Connection refused）——这不是"出错"，是"还没配"
    const where = cfg.relayUrl ? `转发地址 ${relayUrl} 连不上` : "本机 127.0.0.1:8127 没有转发器在听";
    return { ok: false, status: 0, body: `${WEB_HINT_NO_RELAY}（${where}：${error?.message || error}）` };
  }

  let status = Number(payload?.status || 0);
  let body = String(payload?.body ?? "");
  try {
    const parsed = JSON.parse(body);
    status = Number(parsed?.status || status);
    body = String(parsed?.body ?? body);
  } catch {
    // 转发器返回的不是 JSON（多半是部署页的 HTML）：原样透出，用户一眼能看出配错了地址
  }
  return { ok: status >= 200 && status < 300, status, body };
}

/**
 * 组织成管理接口要的 entry：`bucket:key` 再做 URL-safe base64。
 * 同样**带填充**——七牛文档里的示例就是 `delete/cWluaXU6dGVzdC5qcGc=`（末尾那个 = 就是填充）。
 */
export function qiniuEntry(bucket, key) {
  return urlsafeBase64(encoder.encode(`${bucket}:${key}`), true);
}

/**
 * 目录占位对象：七牛（以及 S3 的「文件夹」）会写一个 key 以 `/` 结尾的 0 字节对象，
 * 例如 `photos/`。它不是照片，列出来只会让人以为多了一个空文件（真机上就这么被问过），
 * 所以一律过滤——注意只按"结尾斜杠"判定：真正的 0 字节文件（key 不以 / 结尾）仍然显示。
 */
export function isFolderMarker(key) {
  return String(key || "").endsWith("/");
}

/** 该后端能不能在手机上浏览云端。WebDAV 的列举要 PROPFIND 且各家 CORS 不一，暂不提供。 */
export function cloudProviderOf(config) {
  const provider = normalizePhotoConfig(config).provider;
  return provider === "qiniu" || provider === "s3" ? provider : "";
}

/**
 * 把七牛配置投影成 S3 兼容配置（端点与 region_alias 都来自区域接口的响应）。
 *
 * 为什么需要它：七牛自有的管理接口（rs/rsf）**永远不给浏览器跨域**（预检不放行 Authorization），
 * 而它的 S3 兼容层是**标准的桶级 CORS**（文档确认 PUT/GET/DELETE Bucket cors 均兼容，
 * 控制台 空间设置 → 跨域资源共享 也能配）——配好之后浏览器（含手机网页版）就能直连，
 * 不需要任何转发器。
 */
export function qiniuAsS3Config(cfg, resolved = {}) {
  if (!resolved?.s3Host) return null;
  return normalizePhotoConfig({
    provider: "s3",
    endpoint: resolved.s3Host,
    region: resolved.regionAlias || "",
    bucket: cfg.bucket,
    accessKey: cfg.accessKey,
    secretKey: cfg.secretKey,
    pathStyle: true, // 七牛的 S3 端点走路径风格（实测 /<bucket>/<key> 可用）
    prefix: cfg.prefix,
  });
}

/** 浏览器端可用时返回 S3 兼容配置，否则 null（原生端继续走 rs/rsf，无需任何配置）。 */
function browserS3Config(cfg, resolved) {
  return canSendAuthHeader() ? null : qiniuAsS3Config(cfg, resolved);
}

/**
 * 浏览器直连 S3 失败时最可能的原因就是桶没配跨域（或来源填得和页面的 Origin 不一致）——
 * 把**浏览器实际使用的 Origin** 写进提示里：跨域规则要比对的正是它，
 * 而它取决于你从哪个地址打开页面（github.io、本地 dev 服务器、还是别的域名），
 * 让人对着一个猜出来的地址改规则，是我们上一轮多花时间的原因之一。
 */
function corsHint() {
  const origin = typeof location !== "undefined" && location.origin ? location.origin : "https://github-lcb.github.io";
  return (
    "（浏览器直连七牛 S3 端点需要给桶配跨域：七牛控制台 → 空间设置 → 跨域资源共享；" +
    `来源填 ${origin} —— 这是本页实际的 Origin，必须与规则里的完全一致（不带路径、不带结尾斜杠）；` +
    "方法勾 GET/PUT/POST/DELETE/HEAD，允许头填 * ）"
  );
}

/**
 * 列出云端对象（按 key 升序）。
 * 返回 { objects: [{ key, name, size, lastModified, etag }], nextMarker, truncated }。
 */
export async function listCloudObjects({ config, prefix = "", marker = "", limit = 50, http, fetchImpl } = {}) {
  const cfg = normalizePhotoConfig(config);
  const provider = cloudProviderOf(cfg);
  if (!provider) throw new Error("unavailable");

  if (provider === "s3") {
    const page = await listObjects({ config: cfg, prefix, maxKeys: limit, continuationToken: marker, fetchImpl });
    return {
      objects: page.objects.map((item) => ({
        key: item.key,
        name: item.key.split("/").pop() || item.key,
        size: Number(item.size) || 0,
        lastModified: String(item.lastModified || "").slice(0, 10),
        etag: String(item.etag || "").replace(/"/g, ""),
      })),
      nextMarker: page.nextToken || "",
      truncated: !!page.truncated,
    };
  }

  const resolved = await resolveQiniuUploadHostDetailed({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl });

  // 浏览器（手机网页版也算）：优先走 S3 兼容端点——它的 CORS 是桶级可配的，
  // 而 rs/rsf 那套无论怎么配都进不来。原生端继续用 rs/rsf（不用配任何东西）。
  const s3cfg = browserS3Config(cfg, resolved);
  if (s3cfg) {
    try {
      const page = await listObjects({ config: s3cfg, prefix, maxKeys: limit, continuationToken: marker, fetchImpl });
      return {
        objects: page.objects.filter((item) => !isFolderMarker(item.key)).map((item) => ({
          key: item.key,
          name: item.key.split("/").pop() || item.key,
          size: Number(item.size) || 0,
          lastModified: String(item.lastModified || "").slice(0, 10),
          etag: String(item.etag || "").replace(/"/g, ""),
        })),
        nextMarker: page.nextToken || "",
        truncated: !!page.truncated,
      };
    } catch (error) {
      throw new Error(`${error?.message || error}${corsHint()}`, { cause: error });
    }
  }

  // 七牛自有管理接口：列表域名同样要区域解析（新机房空间的 rsf 在老域名上会 401）
  const host = resolved.rsfHost || QINIU_DEFAULT_RSF_HOST;
  const pairs = [["bucket", cfg.bucket], ["limit", String(limit)]];
  if (prefix) pairs.push(["prefix", prefix]);
  if (marker) pairs.push(["marker", marker]);
  const pathAndQuery = `/list?${pairs.map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(String(v), true)}`).join("&")}`;
  const res = await qiniuManagementRequest({ config: cfg, method: "POST", host, pathAndQuery, http });
  if (!res.ok) {
    // 把"用的哪台主机、怎么传的凭证、什么编码"一并报出来：这三种是排障的全部变量，
    // 排一次就能定位，不必再来回问（这条链路已经因为看不到上下文多花了两轮）。
    const how = canSendAuthHeader() ? "Authorization 头（原生）" : normalizePhotoConfig(cfg).relayUrl ? "自建转发" : "未配置转发";
    throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}（host=${host} · ${how} · 签名编码=padded）`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(res.body);
  } catch {
    throw new Error("响应不是合法 JSON");
  }
  const objects = (Array.isArray(parsed?.items) ? parsed.items : [])
    .map((item) => {
      const key = String(item?.key || "");
      const putTime = Number(item?.putTime) || 0;
      return {
        key,
        name: key.split("/").pop() || key,
        size: Number(item?.fsize) || 0,
        // putTime 是 100 纳秒单位
        lastModified: putTime > 0 ? new Date(putTime / 10_000).toISOString().slice(0, 10) : "",
        etag: String(item?.hash || ""),
      };
    })
    .filter((item) => item.key && !isFolderMarker(item.key));
  const nextMarker = String(parsed?.marker || "");
  return { objects, nextMarker, truncated: !!nextMarker };
}

/** 删除一个对象。网页版可能读不到响应，成败由调用方「重新列举」判定。 */
export async function deleteCloudObject({ config, key, http, fetchImpl } = {}) {
  const cfg = normalizePhotoConfig(config);
  const provider = cloudProviderOf(cfg);
  if (!provider) throw new Error("unavailable");
  if (provider === "qiniu") {
    const resolved = await resolveQiniuUploadHostDetailed({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl });
    const s3cfg = browserS3Config(cfg, resolved);
    if (s3cfg) {
      try {
        await s3Request({ config: s3cfg, method: "DELETE", path: photoObjectPath(s3cfg, key), fetchImpl });
        return { ok: true, via: "s3" };
      } catch (error) {
        throw new Error(`${error?.message || error}${corsHint()}`, { cause: error });
      }
    }
    const host = resolved.rsfHost || QINIU_DEFAULT_RSF_HOST;
    const pathAndQuery = `/delete/${qiniuEntry(cfg.bucket, key)}`;
    const res = await qiniuManagementRequest({ config: cfg, method: "POST", host, pathAndQuery, http });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    return { ok: true };
  }
  // S3：DELETE 需要桶的 CORS 放行 DELETE 方法（文档里的示例只列了 PUT/GET/HEAD）
  return deleteS3Object({ config: cfg, key, fetchImpl });
}

/** 移动/改名（= 改目录）：七牛 POST /move/<src>/<dst>?force=true。 */
export async function moveCloudObject({ config, from, to, http, fetchImpl } = {}) {
  const cfg = normalizePhotoConfig(config);
  if (cloudProviderOf(cfg) !== "qiniu") throw new Error("unavailable");
  if (!to || to === from) return { ok: true, moved: false };
  const resolved = await resolveQiniuUploadHostDetailed({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl });
  const s3cfg = browserS3Config(cfg, resolved);
  if (s3cfg) {
    try {
      // S3 没有 move：先复制到新 key（x-amz-copy-source 参与签名，且要求 URL 编码），再删源。
      await s3Request({
        config: s3cfg,
        method: "PUT",
        path: photoObjectPath(s3cfg, to),
        headers: { "x-amz-copy-source": `/${s3cfg.bucket}/${uriEncode(String(from).replace(/^\/+/, ""), true)}` },
        fetchImpl,
      });
      await s3Request({ config: s3cfg, method: "DELETE", path: photoObjectPath(s3cfg, from), fetchImpl });
      return { ok: true, moved: true, via: "s3" };
    } catch (error) {
      throw new Error(`${error?.message || error}${corsHint()}`, { cause: error });
    }
  }
  const host = resolved.rsfHost || QINIU_DEFAULT_RSF_HOST;
  const pathAndQuery = `/move/${qiniuEntry(cfg.bucket, from)}/${qiniuEntry(cfg.bucket, to)}?force=true`;
  const res = await qiniuManagementRequest({ config: cfg, method: "POST", host, pathAndQuery, http });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  return { ok: true, moved: true };
}


/** Basic 认证头用的**标准** base64（不能复用 URL-safe 那份：+/ 会被换成 -_，服务端解不出来）。 */
function basicAuth(user, pass) {
  const raw = `${user}:${pass}`;
  if (typeof btoa === "function") {
    let binary = "";
    for (const byte of encoder.encode(raw)) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
  }
  return `Basic ${Buffer.from(raw, "utf8").toString("base64")}`;
}

/**
 * 下载一个云端对象的「目标」：URL + 需要的头（+ 落盘用的文件名）。
 *
 * 三种后端各一条路：
 *   · 七牛/ S3：**SigV4 签名的 GET**（七牛的 S3 兼容端点已配桶级跨域，浏览器里能直接取到字节；
 *     私有空间也不必再依赖 1 小时下载令牌）；
 *   · 七牛但没有 S3 端点（区域接口没答上来）：退回访问域名的直链（私有空间带下载令牌）；
 *   · WebDAV：直链 + Basic 认证头。
 *
 * 单独抽出来是因为**两种落地方式共用一个目标**：浏览器要自己 fetch 成 Blob，
 * 安卓 App 则把 url+headers 交给原生去下载（不经过 JS，2.7MB 的照片不必过一遍 base64）。
 */
export async function cloudDownloadTarget({ config, key, fetchImpl, now } = {}) {
  const cfg = normalizePhotoConfig(config);
  const fileName = String(key).split("/").pop() || "photo";
  if (cfg.provider === "webdav") {
    return { url: webdavObjectUrl(cfg, key), headers: { Authorization: basicAuth(cfg.username, cfg.password) }, fileName };
  }

  let s3cfg = cfg.provider === "s3" ? cfg : null;
  if (!s3cfg && cfg.provider === "qiniu") {
    const resolved = await resolveQiniuUploadHostDetailed({ accessKey: cfg.accessKey, bucket: cfg.bucket, fetchImpl });
    s3cfg = qiniuAsS3Config(cfg, resolved);
    if (!s3cfg) {
      // 区域接口没给出 S3 端点：退回访问域名（私有空间用下载令牌，1 小时有效）
      return { url: await objectPreviewUrl({ config: cfg, key }), headers: {}, fileName };
    }
  }
  if (!s3cfg) throw new Error("unavailable");

  const path = photoObjectPath(s3cfg, key);
  const signed = await signS3Request({
    method: "GET",
    host: photoHost(s3cfg),
    path,
    query: [],
    headers: { "x-amz-content-sha256": EMPTY_SHA256 },
    payloadHash: EMPTY_SHA256,
    region: s3cfg.region,
    accessKey: s3cfg.accessKey,
    secretKey: s3cfg.secretKey,
    sessionToken: s3cfg.sessionToken,
    now,
  });
  return {
    url: `https://${photoHost(s3cfg)}${uriEncode(path, false)}`,
    headers: { "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": signed.amzDate, Authorization: signed.authorization },
    fileName,
  };
}

/**
 * 下载一个云端对象。
 *
 *   · 安卓 App（有原生桥）：交给原生下载，直接落到系统的「下载」目录，返回保存位置；
 *   · 浏览器（手机网页版/桌面网页版）：取成 Blob 交回调用方落地（<a download> 或系统分享）。
 */
export async function downloadCloudObject({ config, key, fetchImpl, now } = {}) {
  const target = await cloudDownloadTarget({ config, key, fetchImpl, now });
  if (hasNativeBridge && typeof invoke === "function") {
    const result = await invoke("download_to_device", target);
    const location = String(result?.location || "");
    if (!result?.ok && !location) throw new Error(String(result?.message || "下载失败"));
    // kind/folder 交给界面拼"短文案"：原生那边知道图片进了相册还是下载目录，
    // 而界面需要的是本地化的一句话，不是一条长路径（真机上路径把提示挤爆过）。
    return {
      ok: true,
      native: true,
      fileName: String(result?.name || target.fileName),
      location,
      kind: String(result?.kind || ""),
      folder: String(result?.folder || ""),
    };
  }
  const fetchFn = fetchImpl || globalThis.fetch;
  if (!fetchFn) throw new Error("当前环境没有 fetch");
  const res = await fetchFn(target.url, { headers: target.headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { ok: true, native: false, fileName: target.fileName, blob: await res.blob() };
}
/**
 * 预览/下载用的 URL：公开空间直接裸链，私有空间带下载令牌。
 * 私有令牌的签名串是**完整 URL + ?e=deadline**（与桌面端 Rust 的 qiniu_download_token 一致）。
 */
export async function objectPreviewUrl({ config, key, deadlineSeconds = 3600 } = {}) {
  const cfg = normalizePhotoConfig(config);
  if (!cfg.domain) return "";
  const base = `https://${cfg.domain}/${uriEncode(key, false)}`;
  if (!cfg.privateBucket) return base;
  const deadline = Math.floor(Date.now() / 1000) + deadlineSeconds;
  const sign = urlsafeBase64(await hmacSha1(cfg.secretKey, `${base}?e=${deadline}`));
  return `${base}?e=${deadline}&token=${cfg.accessKey}:${sign}`;
}

/** S3 删除（SigV4，复用上传那套签名与 URL 组装，不另写第二份）。 */
async function deleteS3Object({ config, key, fetchImpl }) {
  const res = await s3Request({ config, method: "DELETE", path: photoObjectPath(config, key), fetchImpl });
  return { ok: true, status: res.status };
}
