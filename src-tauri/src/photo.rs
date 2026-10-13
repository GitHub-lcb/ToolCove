//! 照片存档（桌面端）：列出云端照片并批量下载归档。
//!
//! 分工：手机端负责拍与传（`src/photo/*.js`，浏览器 fetch 直发），桌面端负责取。
//! 这里用 Rust 而不是 WebView，理由与下载器相同：流式落盘、进度事件、不受 CORS 限制。
//!
//! 对象命名与手机端逐字一致（`src/photo/keys.js`）：`<prefix>/YYYY/MM/DD/时间戳_设备_随机.后缀`。
//! 归档目录直接按 key 里的日期分文件夹（拍摄日期），不反查任何元数据。
//!
//! 归档的三条不变量：
//!   1. **只新增**：目标文件已存在且大小与云端一致 → 跳过，绝不覆盖；
//!   2. **先写 .part 再改名**：中断不会留下半张照片冒充成品；
//!   3. **archive-manifest.json 记账**：下载时同步算 sha256 落进去，日后可整体校验。
//!
//! 签名是 AWS SigV4 的手写实现，与 JS 侧（src/photo/sigv4.js）同一套规范，
//! 正确性同样由官方测试向量守住（见本文件底部 tests）。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE};
use base64::Engine as _;
use futures_util::StreamExt;
use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::io::Cursor;
use tauri::Emitter;
use tauri::Manager as _;
use tokio::io::AsyncWriteExt;

const EVENT_PROGRESS: &str = "photo:progress";
const EVENT_FINISHED: &str = "photo:finished";
const MANIFEST_NAME: &str = "archive-manifest.json";
/// 单张照片的重试次数（网络抖动重连，不重试 4xx）。
const MAX_FILE_RETRIES: u32 = 2;
/// 进度节流：照片是毫秒级的小文件，不节流会把 IPC 与界面重绘打满。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/// 单张照片上限 2 GiB：手机照片远小于此，留一道"对象被换成了大视频"的闸。
const MAX_OBJECT_BYTES: u64 = 2 * 1024 * 1024 * 1024;

// ---------- 配置 ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PhotoConfig {
    pub provider: String,
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
    pub session_token: String,
    pub path_style: bool,
    /// 七牛：文件访问域名（绑定在桶上的 CDN/自有域名）。
    pub domain: String,
    /// 七牛：表单上传域名（默认全球入口）。
    pub upload_host: String,
    /// 七牛：私有桶下载要带 token；公开桶直接裸链。
    pub private_bucket: bool,
    /// WebDAV：Basic 认证。
    pub username: String,
    pub password: String,
    pub prefix: String,
}

impl Default for PhotoConfig {
    fn default() -> Self {
        Self {
            provider: "s3".into(),
            endpoint: String::new(),
            region: String::new(),
            bucket: String::new(),
            access_key: String::new(),
            secret_key: String::new(),
            session_token: String::new(),
            path_style: false,
            domain: String::new(),
            upload_host: "upload.qiniup.com".into(),
            private_bucket: true,
            username: String::new(),
            password: String::new(),
            prefix: "photos".into(),
        }
    }
}

fn normalize_prefix(prefix: &str) -> String {
    let trimmed = prefix.trim().trim_matches('/');
    if trimmed.is_empty() {
        "photos".to_string()
    } else {
        trimmed.to_string()
    }
}

fn validate_config(config: &PhotoConfig) -> Result<(), String> {
    match config.provider.trim() {
        "qiniu" => {
            if config.bucket.trim().is_empty() {
                return Err("请先完成存储配置（缺少空间 bucket）".into());
            }
            if config.access_key.trim().is_empty() || config.secret_key.trim().is_empty() {
                return Err("请先完成存储配置（缺少 AccessKey / SecretKey）".into());
            }
            if config.domain.trim().is_empty() {
                return Err("请先完成存储配置（缺少访问域名）".into());
            }
            Ok(())
        }
        "webdav" => {
            let base = config.endpoint.trim();
            if base.is_empty() {
                return Err("请先完成存储配置（缺少 WebDAV 地址）".into());
            }
            if !base.starts_with("https://") && !base.starts_with("http://") {
                return Err("WebDAV 地址需要以 http:// 或 https:// 开头".into());
            }
            if config.username.trim().is_empty() || config.password.is_empty() {
                return Err("请先完成存储配置（缺少用户名 / 密码）".into());
            }
            Ok(())
        }
        _ => {
            if config.endpoint.trim().is_empty() {
                return Err("请先完成存储配置（缺少服务地址）".into());
            }
            if config.endpoint.contains('/') || config.endpoint.contains(char::is_whitespace) {
                return Err("服务地址只填域名（可带端口），不要带 https:// 或路径".into());
            }
            if config.region.trim().is_empty() {
                return Err("请先完成存储配置（缺少区域）".into());
            }
            if config.bucket.trim().is_empty() {
                return Err("请先完成存储配置（缺少存储桶）".into());
            }
            if config.access_key.trim().is_empty() || config.secret_key.trim().is_empty() {
                return Err("请先完成存储配置（缺少密钥）".into());
            }
            Ok(())
        }
    }
}

fn host_of(config: &PhotoConfig) -> String {
    if config.path_style {
        config.endpoint.trim().to_string()
    } else {
        format!("{}.{}", config.bucket.trim(), config.endpoint.trim())
    }
}

/// 未编码的原始路径。签名与 URL 组装共用同一份（canonical URI 与实际请求不许分叉）。
fn object_path(config: &PhotoConfig, key: &str) -> String {
    let clean = key.trim_start_matches('/');
    if config.path_style {
        format!("/{}/{}", config.bucket.trim(), clean)
    } else {
        format!("/{clean}")
    }
}

// ---------- 签名（AWS SigV4） ----------

type HmacSha256 = Hmac<Sha256>;

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC 接受任意长度密钥");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// RFC3986 编码：只放过 A-Za-z0-9-_.~（key 的字符集保证这里几乎不发生替换）。
fn uri_encode(input: &str, encode_slash: bool) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        let ch = byte as char;
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | '~') {
            out.push(ch);
        } else if ch == '/' && !encode_slash {
            out.push('/');
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// 公历换算（Howard Hinnant 算法）：不引 chrono，只为把"现在"格式化成 UTC 时间戳。
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `20250830T123600Z`（UTC；签名必须用 UTC，与拍摄日期用的本地时间无关）。
fn amz_date(now: SystemTime) -> String {
    let secs = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_secs() as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}{:02}{:02}T{:02}{:02}{:02}Z", y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

struct SignedKit {
    authorization: String,
    amz_date: String,
}

/// 签一次请求。`extra` 是参与签名的附加头（如 x-amz-content-sha256；host 与 x-amz-date 自动加入）。
/// `service` 固定为 "s3"，只为官方测试向量（service 段不同）留出复现口。
fn sign_request(
    method: &str,
    host: &str,
    path: &str,
    query: &[(String, String)],
    extra: &[(String, String)],
    payload_hash: &str,
    config: &PhotoConfig,
    now: SystemTime,
    service: &str,
) -> SignedKit {
    let amz = amz_date(now);
    let date = &amz[..8];

    let mut headers: Vec<(String, String)> = vec![
        ("host".into(), host.to_string()),
        ("x-amz-date".into(), amz.clone()),
    ];
    for (name, value) in extra {
        headers.push((name.to_lowercase(), value.clone()));
    }
    if !config.session_token.trim().is_empty() {
        headers.push(("x-amz-security-token".into(), config.session_token.trim().to_string()));
    }
    headers.sort_by(|a, b| a.0.cmp(&b.0));

    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| {
            let collapsed = value.split_whitespace().collect::<Vec<_>>().join(" ");
            format!("{name}:{collapsed}\n")
        })
        .collect();
    let signed_headers = headers.iter().map(|(name, _)| name.clone()).collect::<Vec<_>>().join(";");

    let mut query_pairs: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| (uri_encode(k, true), uri_encode(v, true)))
        .collect();
    query_pairs.sort();
    let canonical_query = query_pairs
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");

    let canonical_request = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        method.to_uppercase(),
        uri_encode(path, false),
        canonical_query,
        canonical_headers,
        signed_headers,
        payload_hash
    );
    let scope = format!("{date}/{}/{service}/aws4_request", config.region.trim());
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz,
        scope,
        sha256_hex(canonical_request.as_bytes())
    );

    let mut key = hmac_sha256(format!("AWS4{}", config.secret_key.trim()).as_bytes(), date.as_bytes());
    key = hmac_sha256(&key, config.region.trim().as_bytes());
    key = hmac_sha256(&key, service.as_bytes());
    key = hmac_sha256(&key, b"aws4_request");
    let signature = hex(&hmac_sha256(&key, string_to_sign.as_bytes()));

    SignedKit {
        authorization: format!(
            "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
            config.access_key.trim(),
            scope,
            signed_headers,
            signature
        ),
        amz_date: amz,
    }
}

// ---------- 七牛 / WebDAV 的签名与解析 ----------

type HmacSha1 = Hmac<Sha1>;

fn hmac_sha1(secret: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha1::new_from_slice(secret).expect("HMAC 接受任意长度密钥");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn urlsafe_b64(bytes: &[u8]) -> String {
    // 与官方 Go SDK（base64.URLEncoding）一致：**带填充**。
    // 旧 QBox 凭证时代 Python SDK 发不带填充的形态也能通过，但 V2 凭证以官方文档示例为准（带 =）。
    URL_SAFE.encode(bytes)
}

/// 七牛管理凭证（Qiniu V2 签名）——rsf 列举等管理接口用。
///
/// 签名串（官方 Go SDK collectDataV2 的实现）：
///   `<METHOD> <path?query>\nHost: <host>\nContent-Type: <ct>\n\n` （+ body，如有）
/// 旧版 QBox 格式（只签 `path?query\n`）**已被服务端拒绝**：实测对 rsf.qbox.me 返回 401 BadToken，
/// 而当前官方 SDK 对 `/list` 走的就是这里这套 TokenQiniu/V2 形态（见 storage/bucket_list.go）。
fn qiniu_management_auth(config: &PhotoConfig, method: &str, host: &str, path_and_query: &str, content_type: &str) -> String {
    // 我们没有 X-Qiniu-* 头，也没有请求体：签完头域直接跟空行收尾
    let signing = format!("{method} {path_and_query}\nHost: {host}\nContent-Type: {content_type}\n\n");
    let sign = urlsafe_b64(&hmac_sha1(config.secret_key.trim().as_bytes(), signing.as_bytes()));
    format!("Qiniu {}:{sign}", config.access_key.trim())
}

/// 七牛对象的裸地址（未带下载凭证）：签名与请求共用同一份，避免两侧编码分叉。
fn qiniu_base_url(config: &PhotoConfig, key: &str) -> String {
    format!(
        "https://{}/{}",
        config.domain.trim().trim_end_matches('/'),
        uri_encode(key.trim_start_matches('/'), false)
    )
}

/// 七牛私有资源下载令牌。签名串是**完整 URL**（含 `https://` 与域名）+ `?e=<deadline>`——
/// 官方 Python / Go SDK 都是这么签的（`Auth.private_download_url` / `MakePrivateURL`）。
/// 只签 path 会被服务端判 401 BadToken（实测）。
fn qiniu_download_token(config: &PhotoConfig, key: &str, deadline: i64) -> String {
    let signed = format!("{}?e={deadline}", qiniu_base_url(config, key));
    let sign = urlsafe_b64(&hmac_sha1(config.secret_key.trim().as_bytes(), signed.as_bytes()));
    format!("{}:{sign}", config.access_key.trim())
}

/// UNIX 秒 → `YYYY-MM-DDTHH:MM:SS.000Z`（与 S3 的 LastModified 形状一致，前端只用前 10 位取日期）。
fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z", y, m, d, rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// RFC1123（WebDAV 的 getlastmodified，如 `Tue, 13 Oct 2026 08:30:00 GMT`）→ `YYYY-MM-DD`。
fn rfc1123_date(value: &str) -> Option<String> {
    let mut parts = value.split_whitespace();
    let _weekday = parts.next()?;
    let day: u32 = parts.next()?.parse().ok()?;
    let month = match parts.next()? {
        "Jan" => 1,
        "Feb" => 2,
        "Mar" => 3,
        "Apr" => 4,
        "May" => 5,
        "Jun" => 6,
        "Jul" => 7,
        "Aug" => 8,
        "Sep" => 9,
        "Oct" => 10,
        "Nov" => 11,
        "Dec" => 12,
        _ => return None,
    };
    let year: u32 = parts.next()?.parse().ok()?;
    Some(format!("{year:04}-{month:02}-{day:02}"))
}

/// 百分号解码（WebDAV 的 href 是编码过的；中文文件名要还原）。
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            if let Some(value) = hex {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// 从 XML 里取同名标签（容忍命名空间前缀：<d:href> / <D:href> / <href> 都认）。
fn tag_text<'a>(block: &'a str, local_name: &str) -> Option<&'a str> {
    let open = format!("<{local_name}>");
    if let Some(found) = between(block, &open, &format!("</{local_name}>")) {
        return Some(found);
    }
    // 带前缀：扫描所有 `<xxx:local>` 开标签
    let needle = format!(":{local_name}>");
    let mut rest = block;
    while let Some(pos) = rest.find(&needle) {
        let tag_start = rest[..pos].rfind('<')?;
        let tag = &rest[tag_start + 1..pos + needle.len() - 1]; // 去尾部 '>'
        let close = format!("</{tag}>");
        let after = &rest[pos + needle.len()..];
        if let Some(end) = after.find(&close) {
            return Some(&after[..end]);
        }
        rest = &after[..];
    }
    None
}

// ---------- XML（只认我们自己列出来的这张形状） ----------

fn unescape_xml(text: &str) -> String {
    text.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn between<'a>(text: &'a str, open: &str, close: &str) -> Option<&'a str> {
    let start = text.find(open)? + open.len();
    let end = text[start..].find(close)? + start;
    Some(&text[start..end])
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhotoObject {
    pub key: String,
    #[serde(default)]
    pub size: u64,
    #[serde(default)]
    pub etag: String,
    #[serde(default, rename = "lastModified")]
    pub last_modified: String,
}

fn parse_objects(xml: &str) -> Vec<PhotoObject> {
    let mut objects = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Contents>") {
        let Some(end_rel) = rest[start..].find("</Contents>") else { break };
        let block = &rest[start..start + end_rel];
        let pick = |tag: &str| between(block, &format!("<{tag}>"), &format!("</{tag}>")).map(unescape_xml).unwrap_or_default();
        objects.push(PhotoObject {
            key: pick("Key"),
            size: pick("Size").parse().unwrap_or(0),
            etag: pick("ETag").trim_matches('"').to_string(),
            last_modified: pick("LastModified"),
        });
        rest = &rest[start + end_rel + "</Contents>".len()..];
    }
    objects
}

/// 从 S3 错误响应里取 `<Code>`；取不到退回 HTTP 状态。
fn describe_error(status: u16, body: &str) -> String {
    let code = between(body, "<Code>", "</Code>").map(unescape_xml).unwrap_or_default();
    let message = between(body, "<Message>", "</Message>").map(unescape_xml).unwrap_or_default();
    if code.is_empty() {
        format!("HTTP {status}")
    } else if message.is_empty() {
        code
    } else {
        format!("{code}: {message}")
    }
}

// ---------- 请求 ----------

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent("ToolCove/1.0 (photo)")
        .build()
        .map_err(|e| format!("创建网络客户端失败：{e}"))
}

async fn list_s3(
    config: &PhotoConfig,
    prefix: &str,
    continuation_token: Option<&str>,
    max_keys: u32,
) -> Result<(Vec<PhotoObject>, bool, String), String> {
    validate_config(config)?;
    let client = http_client()?;
    let host = host_of(config);
    let path = if config.path_style {
        format!("/{}", config.bucket.trim())
    } else {
        "/".to_string()
    };

    let mut query: Vec<(String, String)> = vec![
        ("list-type".into(), "2".into()),
        ("max-keys".into(), max_keys.to_string()),
    ];
    if !prefix.is_empty() {
        query.push(("prefix".into(), prefix.to_string()));
    }
    if let Some(token) = continuation_token {
        if !token.is_empty() {
            query.push(("continuation-token".into(), token.to_string()));
        }
    }

    let extra = vec![("x-amz-content-sha256".to_string(), EMPTY_SHA256.to_string())];
    let signed = sign_request("GET", &host, &path, &query, &extra, EMPTY_SHA256, config, SystemTime::now(), "s3");

    let mut url = format!("https://{host}{}", uri_encode(&path, false));
    // 排序口径与签名一致（先比 key 再比 value，不是字符串整体排序）
    let mut sorted: Vec<(String, String)> = query
        .iter()
        .map(|(k, v)| (uri_encode(k, true), uri_encode(v, true)))
        .collect();
    sorted.sort();
    url.push('?');
    url.push_str(&sorted.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join("&"));

    let response = client
        .get(&url)
        .header("Authorization", &signed.authorization)
        .header("x-amz-date", &signed.amz_date)
        .header("x-amz-content-sha256", EMPTY_SHA256)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;

    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(describe_error(status, &body));
    }
    let objects = parse_objects(&body);
    let truncated = body.contains("<IsTruncated>true</IsTruncated>");
    let next_token = between(&body, "<NextContinuationToken>", "</NextContinuationToken>")
        .map(unescape_xml)
        .unwrap_or_default();
    Ok((objects, truncated, next_token))
}

// ---------- 列举（按 provider 分派） ----------

fn ok_result(objects: Vec<PhotoObject>, truncated: bool, next: String) -> Result<(Vec<PhotoObject>, bool, String), String> {
    Ok((objects, truncated, next))
}

/// 目录占位对象：控制台里"新建文件夹"会生成一个 0 字节、key 以 `/` 结尾的对象。
/// 它不是照片——列表里显示成空白行、归档会试着下载它，所以从源头就跳过。
fn is_dir_marker(key: &str) -> bool {
    let trimmed = key.trim_end();
    trimmed.ends_with('/') || trimmed.ends_with('\\')
}

async fn list_objects(
    config: &PhotoConfig,
    prefix: &str,
    continuation_token: Option<&str>,
    max_keys: u32,
) -> Result<(Vec<PhotoObject>, bool, String), String> {
    let (objects, truncated, next) = match config.provider.trim() {
        "qiniu" => list_qiniu(config, prefix, continuation_token, max_keys).await?,
        "webdav" => list_webdav(config, prefix).await?,
        _ => list_s3(config, prefix, continuation_token, max_keys).await?,
    };
    Ok((
        objects.into_iter().filter(|object| !is_dir_marker(&object.key)).collect(),
        truncated,
        next,
    ))
}

/// 七牛 rsf 列举：POST /list?bucket=&prefix=&marker=&limit=，Mark 分页。
async fn list_qiniu(
    config: &PhotoConfig,
    prefix: &str,
    marker: Option<&str>,
    max_keys: u32,
) -> Result<(Vec<PhotoObject>, bool, String), String> {
    validate_config(config)?;
    let client = http_client()?;

    let mut pairs: Vec<(String, String)> = vec![
        ("bucket".into(), config.bucket.trim().into()),
        ("limit".into(), max_keys.to_string()),
    ];
    if !prefix.is_empty() {
        pairs.push(("prefix".into(), prefix.into()));
    }
    if let Some(token) = marker {
        if !token.is_empty() {
            pairs.push(("marker".into(), token.into()));
        }
    }
    let query_pairs: Vec<String> = pairs
        .iter()
        .map(|(k, v)| format!("{}={}", uri_encode(k, true), uri_encode(v, true)))
        .collect();
    let path_and_query = format!("/list?{}", query_pairs.join("&"));

    // 签名串必须覆盖 method / Host / Content-Type（V2 格式），三处与实际请求逐字一致
    const HOST: &str = "rsf.qbox.me";
    const CONTENT_TYPE: &str = "application/x-www-form-urlencoded";
    let auth = qiniu_management_auth(config, "POST", HOST, &path_and_query, CONTENT_TYPE);

    let response = client
        .post(format!("https://{HOST}{path_and_query}"))
        .header("Authorization", auth)
        .header("Content-Type", CONTENT_TYPE)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        let brief = body.chars().take(200).collect::<String>();
        // 401 基本都是密钥被拒：给出可执行的排查方向，而不是只甩一串服务端 JSON
        let hint = if status == 401 {
            "（密钥被拒：确认 AccessKey/SecretKey 是该账号的密钥，且空间名填写无误）"
        } else {
            ""
        };
        return Err(format!("HTTP {status}: {brief}{hint}"));
    }

    let parsed: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("响应不是合法 JSON：{e}"))?;
    let mut objects = Vec::new();
    for item in parsed.get("items").and_then(|v| v.as_array()).cloned().unwrap_or_default() {
        let key = item.get("key").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if key.is_empty() {
            continue;
        }
        let size = item.get("fsize").and_then(|v| v.as_u64()).unwrap_or(0);
        // putTime 是七牛时间（100 纳秒单位）；换算成 UNIX 秒再格式化成 ISO
        let put_time = item.get("putTime").and_then(|v| v.as_i64()).unwrap_or(0);
        objects.push(PhotoObject {
            key,
            size,
            etag: item.get("hash").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            last_modified: if put_time > 0 { iso_from_unix(put_time / 10_000_000) } else { String::new() },
        });
    }
    let next = parsed.get("marker").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let truncated = !next.is_empty();
    ok_result(objects, truncated, next)
}

/// WebDAV 列举：按 年/月/日 三层 PROPFIND Depth:1 走下去，最后并发抓每个日目录的文件。
/// 目录层数由本工具的命名规则决定（<prefix>/YYYY/MM/DD/file），不做无限递归。
async fn list_webdav(config: &PhotoConfig, prefix: &str) -> Result<(Vec<PhotoObject>, bool, String), String> {
    validate_config(config)?;
    let client = http_client()?;
    let base = config.endpoint.trim().trim_end_matches('/').to_string();
    let root = format!("{base}/{prefix}");
    let auth = format!(
        "Basic {}",
        STANDARD.encode(format!("{}:{}", config.username.trim(), config.password).as_bytes())
    );

    // 前缀目录还不存在（还没传过照片）按空列表处理，而不是把 404 当失败弹给用户
    if let Err(error) = propfind(&client, &auth, &root, "0").await {
        if error.contains("404") {
            return ok_result(Vec::new(), false, String::new());
        }
        return Err(error);
    }

    let years = propfind_dirs(&client, &auth, &root).await?;
    let mut months: Vec<String> = Vec::new();
    for year in &years {
        months.extend(propfind_dirs(&client, &auth, year).await?);
    }
    let mut days: Vec<String> = Vec::new();
    for month in &months {
        days.extend(propfind_dirs(&client, &auth, month).await?);
    }

    // 日目录并发抓（每天一个请求，5 年也就几百个；并发 8 足够）
    let mut objects: Vec<PhotoObject> = Vec::new();
    let results = futures_util::stream::iter(days.into_iter().map(|day| {
        let client = client.clone();
        let auth = auth.clone();
        let config = config.clone();
        async move { propfind_files(&client, &config, &auth, &day).await }
    }))
    .buffer_unordered(8)
    .collect::<Vec<_>>()
    .await;
    for result in results {
        objects.extend(result?);
    }
    objects.sort_by(|a, b| a.key.cmp(&b.key));
    ok_result(objects, false, String::new())
}

/// PROPFIND Depth:1，返回其中的**目录** href 列表（完整 URL），排除自身。
async fn propfind_dirs(client: &reqwest::Client, auth: &str, dir_url: &str) -> Result<Vec<String>, String> {
    let responses = propfind(client, auth, dir_url, "1").await?;
    let mut dirs = Vec::new();
    for block in responses {
        let Some(href_raw) = tag_text(&block, "href") else { continue };
        let href = unescape_xml(href_raw);
        if !href.ends_with('/') {
            continue;
        }
        let full = absolute_href(dir_url, &href);
        // 排除自身（服务器可能不带尾斜杠差异）
        if full.trim_end_matches('/') == dir_url.trim_end_matches('/') {
            continue;
        }
        dirs.push(full);
    }
    Ok(dirs)
}

/// PROPFIND Depth:1，返回其中的**文件**对象。
async fn propfind_files(client: &reqwest::Client, config: &PhotoConfig, auth: &str, dir_url: &str) -> Result<Vec<PhotoObject>, String> {
    let responses = propfind(client, auth, dir_url, "1").await?;
    let mut files = Vec::new();
    for block in responses {
        let Some(href_raw) = tag_text(&block, "href") else { continue };
        let href = unescape_xml(href_raw);
        if href.ends_with('/') {
            continue;
        }
        let full = absolute_href(dir_url, &href);
        if full.trim_end_matches('/') == dir_url.trim_end_matches('/') {
            continue;
        }
        let size = tag_text(&block, "getcontentlength").and_then(|v| v.trim().parse().ok()).unwrap_or(0);
        let last_modified = tag_text(&block, "getlastmodified").and_then(rfc1123_date).unwrap_or_default();
        files.push(PhotoObject {
            key: webdav_key_of(config, &full),
            size,
            etag: tag_text(&block, "getetag").map(unescape_xml).unwrap_or_default().trim_matches('"').to_string(),
            last_modified,
        });
    }
    Ok(files)
}

/// 发一次 PROPFIND，把 <response> 块切出来。207 是成功状态（Multi-Status）。
async fn propfind(client: &reqwest::Client, auth: &str, url: &str, depth: &str) -> Result<Vec<String>, String> {
    let response = client
        .request(reqwest::Method::from_bytes(b"PROPFIND").expect("静态方法名"), url)
        .header("Authorization", auth)
        .header("Depth", depth)
        .header("Content-Type", "application/xml")
        .body(r#"<?xml version="1.0" encoding="utf-8"?><propfind xmlns="DAV:"><prop><resourcetype/><getcontentlength/><getlastmodified/><getetag/></prop></propfind>"#)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    if status != 207 && !(200..300).contains(&status) {
        return Err(describe_webdav(status, &body));
    }
    Ok(split_blocks(&body, "response"))
}

fn describe_webdav(status: u16, body: &str) -> String {
    let text = body.chars().take(200).collect::<String>();
    if text.trim().is_empty() {
        format!("HTTP {status}")
    } else {
        format!("HTTP {status}: {text}")
    }
}

/// 切出 `<xxx:name>...</xxx:name>` 块。服务端的命名空间前缀在整篇文档里一致，
/// 取第一个命中的常见形态即可（d: / D: / lp1: 之外的前缀会让块为空 → 上层报"没有内容"，不会静默错解）。
fn split_blocks(xml: &str, local_name: &str) -> Vec<String> {
    let candidates = [
        format!("<{local_name}>"),
        format!("<d:{local_name}>"),
        format!("<D:{local_name}>"),
        format!("<lp1:{local_name}>"),
    ];
    for open in candidates {
        if !xml.contains(&open) {
            continue;
        }
        let close = format!("</{}", &open[1..]);
        let mut blocks = Vec::new();
        let mut rest = xml;
        while let Some(start) = rest.find(&open) {
            let after = &rest[start + open.len()..];
            let Some(end) = after.find(&close) else { break };
            blocks.push(after[..end].to_string());
            rest = &after[end + close.len()..];
        }
        return blocks;
    }
    Vec::new()
}

/// 把 PROPFIND 返回的 href（可能是绝对路径或完整 URL）还原成完整 URL。
fn absolute_href(base_url: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    // href 是 URL 编码的绝对路径：以 host 为界拼回完整 URL
    let scheme_end = base_url.find("://").map(|i| i + 3).unwrap_or(0);
    let host_end = base_url[scheme_end..].find('/').map(|i| scheme_end + i).unwrap_or(base_url.len());
    format!("{}{}", &base_url[..host_end], href)
}

/// 完整 URL → 对象 key（剥掉基地址与开头的斜杠；也解码百分号）。
fn webdav_key_of(config: &PhotoConfig, full_url: &str) -> String {
    let base = config.endpoint.trim().trim_end_matches('/');
    let path = full_url.strip_prefix(base).unwrap_or(full_url);
    percent_decode(path.trim_start_matches('/'))
}

// ---------- 命令 ----------

#[tauri::command]
pub async fn photo_test(config: PhotoConfig) -> Result<serde_json::Value, String> {
    let prefix = format!("{}/", normalize_prefix(&config.prefix));
    let (objects, _, _) = list_objects(&config, &prefix, None, 1).await?;
    Ok(serde_json::json!({ "sampleCount": objects.len() }))
}

#[tauri::command]
pub async fn photo_list(
    config: PhotoConfig,
    continuation_token: Option<String>,
    max_keys: Option<u32>,
) -> Result<serde_json::Value, String> {
    let prefix = format!("{}/", normalize_prefix(&config.prefix));
    let (objects, truncated, next_token) = list_objects(
        &config,
        &prefix,
        continuation_token.as_deref(),
        max_keys.unwrap_or(1000).clamp(1, 1000),
    )
    .await?;
    Ok(serde_json::json!({
        "objects": objects,
        "truncated": truncated,
        "nextToken": next_token,
    }))
}

/// 归档任务表：只存取消旗标（进度经事件推送）。
fn registry() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

#[tauri::command]
pub async fn photo_download(
    app: tauri::AppHandle,
    id: String,
    config: PhotoConfig,
    items: Vec<PhotoObject>,
    dest_dir: String,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("缺少归档任务标识".into());
    }
    validate_config(&config)?;
    let dest = PathBuf::from(dest_dir.trim());
    if dest.as_os_str().is_empty() {
        return Err("请选择归档目录".into());
    }
    std::fs::create_dir_all(&dest).map_err(|e| format!("无法创建归档目录：{e}"))?;

    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = registry().lock() {
        map.insert(id.clone(), cancel.clone());
    }
    tauri::async_runtime::spawn(run_archive(app, id, config, items, dest, cancel));
    Ok(())
}

#[tauri::command]
pub fn photo_cancel(id: String) -> Result<(), String> {
    if let Ok(map) = registry().lock() {
        if let Some(flag) = map.get(&id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// 读取归档账本（界面用它标「已存档」）。文件不存在返回空账本，不是错误。
#[tauri::command]
pub fn photo_manifest(dest_dir: String) -> Result<serde_json::Value, String> {
    let dest = PathBuf::from(dest_dir.trim());
    if dest.as_os_str().is_empty() {
        return Err("缺少归档目录".into());
    }
    let manifest = load_manifest(&dest);
    serde_json::to_value(manifest).map_err(|e| format!("账本序列化失败：{e}"))
}

// ---------- 列表缩略图 ----------

/// 缩略图最大边长：列表里只占 40px，96 足够清晰，解码后内存也小。
const THUMB_MAX_EDGE: u32 = 96;
/// 只为"像照片"的体积出缩略图：更大的对象直接给占位，不白拉一遍。
const THUMB_MAX_BYTES: usize = 12 * 1024 * 1024;

fn thumb_cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("无缓存目录：{e}"))?
        .join("photo-thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建缩略图缓存：{e}"))?;
    Ok(dir)
}

/// 缓存文件名：把「哪个后端 + 哪个桶/域名 + 哪个 key」一起哈希——同名 key 换桶不会串图。
fn thumb_cache_name(config: &PhotoConfig, key: &str) -> String {
    let scope = format!(
        "{}|{}|{}|{}|{}",
        config.provider.trim(),
        config.endpoint.trim(),
        config.domain.trim(),
        config.bucket.trim(),
        key
    );
    format!("{}.png", sha256_hex(scope.as_bytes()))
}

/// 解码并按最长边缩放成 PNG。解码失败（HEIC 之类不支持的格式）返回 None——
/// 界面显示占位图标而不是报错。抽成纯函数以便单测（不碰网络与文件系统）。
fn make_thumbnail_png(bytes: &[u8], max_edge: u32) -> Option<Vec<u8>> {
    let image = image::load_from_memory(bytes).ok()?;
    let thumb = image.thumbnail(max_edge, max_edge);
    let mut out = Vec::new();
    thumb
        .write_to(&mut Cursor::new(&mut out), image::ImageFormat::Png)
        .ok()?;
    Some(out)
}

fn to_data_url(png: &[u8]) -> String {
    format!("data:image/png;base64,{}", STANDARD.encode(png))
}

/// 列表缩略图：下载对象 → 缩到最长边 96 → 以 dataUrl 返回，并在磁盘留缓存。
/// 全程 best-effort——任何一步失败都返回空 dataUrl（界面显示占位图形）：
/// 列表里几十行并发取图，逐行弹错误只会把界面变成报警墙。
#[tauri::command]
pub async fn photo_thumb(
    app: tauri::AppHandle,
    config: PhotoConfig,
    key: String,
) -> Result<serde_json::Value, String> {
    let empty = serde_json::json!({ "dataUrl": "" });
    if is_dir_marker(&key) || validate_config(&config).is_err() {
        return Ok(empty);
    }
    let cache = thumb_cache_dir(&app)?.join(thumb_cache_name(&config, &key));
    if let Ok(existing) = std::fs::read(&cache) {
        if !existing.is_empty() {
            return Ok(serde_json::json!({ "dataUrl": to_data_url(&existing) }));
        }
    }

    let Ok(client) = http_client() else {
        return Ok(empty);
    };
    let (url, headers) = download_target(&config, &key);
    let mut request = client.get(&url);
    for (name, value) in &headers {
        request = request.header(name.as_str(), value.as_str());
    }
    let Ok(response) = request.send().await else {
        return Ok(empty);
    };
    if !response.status().is_success() {
        return Ok(empty);
    }
    if response.content_length().map(|len| len as usize).unwrap_or(0) > THUMB_MAX_BYTES {
        return Ok(empty);
    }
    let Ok(bytes) = response.bytes().await else {
        return Ok(empty);
    };
    if bytes.len() > THUMB_MAX_BYTES {
        return Ok(empty);
    }

    let Some(png) = make_thumbnail_png(&bytes, THUMB_MAX_EDGE) else {
        return Ok(empty);
    };
    let _ = std::fs::write(&cache, &png); // 缓存写失败不影响本次返回
    Ok(serde_json::json!({ "dataUrl": to_data_url(&png) }))
}

// ---------- 归档任务 ----------

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    key: String,
    size: u64,
    sha256: String,
    /// 归档时刻（UNIX 秒）；字符串时间在跨时区显示上各说各话，秒数两端都能格式化。
    archived_at: u64,
    /// 相对于归档根目录的路径（正斜杠）。
    path: String,
}

#[derive(Debug, Clone, serde::Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    entries: Vec<ManifestEntry>,
}

impl Default for Manifest {
    fn default() -> Self {
        Self { version: 1, entries: Vec::new() }
    }
}

fn load_manifest(dest: &Path) -> Manifest {
    std::fs::read_to_string(dest.join(MANIFEST_NAME))
        .ok()
        .and_then(|text| serde_json::from_str::<Manifest>(&text).ok())
        .unwrap_or_default()
}

/// 原子写：tmp + 改名。Windows 上 rename 到已存在文件会失败，先移除旧的。
fn flush_manifest(dest: &Path, manifest: &Manifest) -> Result<(), String> {
    let tmp = dest.join(format!("{MANIFEST_NAME}.tmp"));
    let target = dest.join(MANIFEST_NAME);
    let text = serde_json::to_string_pretty(manifest).map_err(|e| format!("账本序列化失败：{e}"))?;
    std::fs::write(&tmp, text).map_err(|e| format!("账本写入失败：{e}"))?;
    if target.exists() {
        std::fs::remove_file(&target).map_err(|e| format!("替换账本失败：{e}"))?;
    }
    std::fs::rename(&tmp, &target).map_err(|e| format!("账本落位失败：{e}"))
}

/// 归档子目录：以 key 里的日期段为准（拍摄日期）；不认识的命名退到 LastModified，再退到 other/。
fn archive_folder(item: &PhotoObject) -> String {
    let segments: Vec<&str> = item.key.split('/').collect();
    if segments.len() >= 4 {
        let (y, m, d) = (segments[segments.len() - 4], segments[segments.len() - 3], segments[segments.len() - 2]);
        if y.len() == 4 && m.len() == 2 && d.len() == 2 && [y, m, d].iter().all(|s| s.bytes().all(|b| b.is_ascii_digit())) {
            return format!("{y}-{m}-{d}");
        }
    }
    if item.last_modified.len() >= 10 {
        let day = &item.last_modified[..10];
        let bytes = day.as_bytes();
        if bytes.len() == 10 && bytes[4] == b'-' && bytes[7] == b'-' {
            return day.to_string();
        }
    }
    "other".to_string()
}

/// 文件名清洗：只取最后一段并剔除 Windows 非法字符（对象名是我们生成的，这里是防手改）。
fn sanitize_file_name(key: &str, fallback_dir: &str) -> String {
    let last = key.rsplit('/').next().unwrap_or("").trim();
    let cleaned: String = last
        .chars()
        .map(|c| if matches!(c, '<' | '>' | ':' | '"' | '|' | '?' | '*' | '\\') { '_' } else { c })
        .filter(|c| !c.is_control())
        .collect();
    let cleaned = cleaned.trim_matches('.').to_string();
    if cleaned.is_empty() {
        format!("object-{}", fallback_dir.replace('-', ""))
    } else if cleaned.len() > 120 {
        cleaned.chars().take(120).collect()
    } else {
        cleaned
    }
}

struct ProgressSink<'a> {
    app: &'a tauri::AppHandle,
    id: &'a str,
    total: usize,
    done: usize,
    current_key: String,
    skipped: usize,
    failed: usize,
    last_emit: Option<Instant>,
}

impl<'a> ProgressSink<'a> {
    fn new(app: &'a tauri::AppHandle, id: &'a str, total: usize) -> Self {
        Self {
            app,
            id,
            total,
            done: 0,
            current_key: String::new(),
            skipped: 0,
            failed: 0,
            last_emit: None,
        }
    }

    fn emit(&mut self, file_done: u64, file_total: u64, force: bool) {
        if !force {
            if let Some(last) = self.last_emit {
                if last.elapsed() < PROGRESS_INTERVAL {
                    return;
                }
            }
        }
        self.last_emit = Some(Instant::now());
        let _ = self.app.emit(
            EVENT_PROGRESS,
            serde_json::json!({
                "id": self.id,
                "done": self.done,
                "total": self.total,
                "skipped": self.skipped,
                "failed": self.failed,
                "currentKey": self.current_key,
                "fileDone": file_done,
                "fileTotal": file_total,
            }),
        );
    }
}

/// 按 provider 组装下载请求：返回 (url, 需要带的头)。每次重试都重新组装——
/// S3/七牛的签名带时间戳，复用旧签名在慢网络上会 403。
fn download_target(config: &PhotoConfig, key: &str) -> (String, Vec<(String, String)>) {
    match config.provider.trim() {
        "qiniu" => {
            let base = qiniu_base_url(config, key);
            if config.private_bucket {
                let deadline = unix_now() as i64 + 3600;
                let token = qiniu_download_token(config, key, deadline);
                (format!("{base}?e={deadline}&token={token}"), Vec::new())
            } else {
                (base, Vec::new())
            }
        }
        "webdav" => {
            let url = format!(
                "{}/{}",
                config.endpoint.trim().trim_end_matches('/'),
                uri_encode(key.trim_start_matches('/'), false)
            );
            let auth = format!(
                "Basic {}",
                STANDARD.encode(format!("{}:{}", config.username.trim(), config.password).as_bytes())
            );
            (url, vec![("Authorization".to_string(), auth)])
        }
        _ => {
            let host = host_of(config);
            let path = object_path(config, key);
            let url = format!("https://{host}{}", uri_encode(&path, false));
            let extra = vec![("x-amz-content-sha256".to_string(), EMPTY_SHA256.to_string())];
            let signed = sign_request("GET", &host, &path, &[], &extra, EMPTY_SHA256, config, SystemTime::now(), "s3");
            let mut headers = vec![
                ("Authorization".to_string(), signed.authorization),
                ("x-amz-date".to_string(), signed.amz_date),
                ("x-amz-content-sha256".to_string(), EMPTY_SHA256.to_string()),
            ];
            if !config.session_token.trim().is_empty() {
                headers.push(("x-amz-security-token".to_string(), config.session_token.trim().to_string()));
            }
            (url, headers)
        }
    }
}

/// 下载单个对象到 .part 文件，返回 (字节数, sha256)。网络类错误重试，HTTP 4xx 不重试。
async fn download_object(
    client: &reqwest::Client,
    config: &PhotoConfig,
    key: &str,
    part_path: &Path,
    on_progress: &mut (dyn FnMut(u64, u64) + Send),
) -> Result<(u64, String), String> {
    let mut last_error = String::new();
    for _attempt in 0..=MAX_FILE_RETRIES {
        let (url, headers) = download_target(config, key);
        let mut request = client.get(&url);
        for (name, value) in &headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let response = request.send().await;

        let response = match response {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("请求失败：{e}");
                continue;
            }
        };
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            let body = response.text().await.unwrap_or_default();
            return Err(describe_error(status, &body)); // 4xx/5xx 重试无意义或对象有问题，如实返回
        }

        let total = response.content_length().unwrap_or(0);
        if total > MAX_OBJECT_BYTES {
            return Err(format!("对象超过 2 GiB 上限（{total} 字节），已跳过"));
        }

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(part_path)
            .await
            .map_err(|e| format!("无法写入 .part 文件：{e}"))?;

        let mut hasher = Sha256::new();
        let mut written: u64 = 0;
        let mut stream = response.bytes_stream();
        let mut stream_error: Option<String> = None;
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(bytes) => {
                    if let Err(e) = file.write_all(&bytes).await {
                        return Err(format!("写盘失败：{e}"));
                    }
                    hasher.update(&bytes);
                    written += bytes.len() as u64;
                    on_progress(written, total);
                }
                Err(e) => {
                    stream_error = Some(format!("传输中断：{e}"));
                    break;
                }
            }
        }
        let _ = file.flush().await;
        drop(file);

        if let Some(err) = stream_error {
            last_error = err;
            let _ = tokio::fs::remove_file(part_path).await;
            continue;
        }
        on_progress(written, written.max(total));
        return Ok((written, hex(&hasher.finalize())));
    }
    let _ = tokio::fs::remove_file(part_path).await;
    Err(last_error)
}

async fn run_archive(
    app: tauri::AppHandle,
    id: String,
    config: PhotoConfig,
    items: Vec<PhotoObject>,
    dest: PathBuf,
    cancel: Arc<AtomicBool>,
) {
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => {
            emit_finished(&app, &id, false, true, 0, 0, 0, vec![], Some(error));
            clear_task(&id);
            return;
        }
    };

    let mut manifest = load_manifest(&dest);
    let total = items.len();
    let mut sink = ProgressSink::new(&app, &id, total);
    let mut failed: Vec<serde_json::Value> = Vec::new();
    let mut flushed_at = 0usize;

    for item in &items {
        if cancel.load(Ordering::Relaxed) {
            let _ = flush_manifest(&dest, &manifest);
            emit_finished(&app, &id, true, true, sink.done, sink.skipped, sink.failed, failed, None);
            clear_task(&id);
            return;
        }
        // 目录占位对象在列举时已被滤掉；这里是防陈旧界面把旧列表带进来的二次防护
        if is_dir_marker(&item.key) {
            sink.skipped += 1;
            sink.done += 1;
            sink.emit(0, 0, true);
            continue;
        }

        let folder = archive_folder(item);
        let file_name = sanitize_file_name(&item.key, &folder);
        let rel = format!("{folder}/{file_name}");
        let full = dest.join(&rel);

        if let Some(parent) = full.parent() {
            if let Err(e) = tokio::fs::create_dir_all(parent).await {
                sink.failed += 1;
                failed.push(serde_json::json!({ "key": item.key, "error": format!("建目录失败：{e}") }));
                sink.done += 1;
                sink.emit(0, 0, true);
                continue;
            }
        }

        // 已归档判定：文件在、大小一致 → 跳过（绝不覆盖），账本缺条目时补记（补算 sha256）。
        if let Ok(meta) = tokio::fs::metadata(&full).await {
            if meta.is_file() && (item.size == 0 || meta.len() == item.size) {
                let known = manifest.entries.iter().any(|entry| entry.key == item.key);
                if !known {
                    let sha = sha256_file(&full).await.unwrap_or_default();
                    manifest.entries.push(ManifestEntry {
                        key: item.key.clone(),
                        size: meta.len(),
                        sha256: sha,
                        archived_at: unix_now(),
                        path: rel.clone(),
                    });
                    flushed_at += 1;
                }
                sink.skipped += 1;
                sink.done += 1;
                sink.current_key = item.key.clone();
                sink.emit(meta.len(), meta.len(), true);
                if flushed_at >= 10 {
                    let _ = flush_manifest(&dest, &manifest);
                    flushed_at = 0;
                }
                continue;
            }
        }

        sink.current_key = item.key.clone();
        sink.emit(0, item.size, true);

        let part = dest.join(format!("{folder}/.part-{file_name}"));
        let app_ref = &app;
        let id_ref = &id;
        let total_now = total;
        let done_now = sink.done;
        let skipped_now = sink.skipped;
        let failed_now = sink.failed;
        let key_now = item.key.clone();
        // 节流状态由闭包自己持有（move 进闭包）：Cell 不是 Sync，作为共享引用跨 await 会把整条链路变成非 Send
        let last_emit = std::cell::Cell::new(None::<Instant>);
        let mut on_progress = move |written: u64, file_total: u64| {
            let should = match last_emit.get() {
                None => true,
                Some(last) => last.elapsed() >= PROGRESS_INTERVAL,
            };
            if should {
                last_emit.set(Some(Instant::now()));
                let _ = app_ref.emit(
                    EVENT_PROGRESS,
                    serde_json::json!({
                        "id": id_ref,
                        "done": done_now,
                        "total": total_now,
                        "skipped": skipped_now,
                        "failed": failed_now,
                        "currentKey": key_now,
                        "fileDone": written,
                        "fileTotal": file_total,
                    }),
                );
            }
        };

        match download_object(&client, &config, &item.key, &part, &mut on_progress).await {
            Ok((written, sha)) => {
                if item.size > 0 && written != item.size {
                    sink.failed += 1;
                    failed.push(serde_json::json!({ "key": item.key, "error": format!("大小不一致（云端 {claimed} 字节，实收 {written} 字节）", claimed = item.size) }));
                    let _ = tokio::fs::remove_file(&part).await;
                } else {
                    // 先删旧文件再改名：Windows 的 rename 不覆盖已存在目标
                    let _ = tokio::fs::remove_file(&full).await;
                    if let Err(e) = tokio::fs::rename(&part, &full).await {
                        sink.failed += 1;
                        failed.push(serde_json::json!({ "key": item.key, "error": format!("落位失败：{e}") }));
                        let _ = tokio::fs::remove_file(&part).await;
                    } else {
                        manifest.entries.retain(|entry| entry.key != item.key);
                        manifest.entries.push(ManifestEntry {
                            key: item.key.clone(),
                            size: written,
                            sha256: sha,
                            archived_at: unix_now(),
                            path: rel.clone(),
                        });
                        flushed_at += 1;
                    }
                }
            }
            Err(error) => {
                sink.failed += 1;
                failed.push(serde_json::json!({ "key": item.key, "error": error }));
            }
        }

        sink.done += 1;
        sink.emit(0, 0, true);
        if flushed_at >= 10 {
            let _ = flush_manifest(&dest, &manifest);
            flushed_at = 0;
        }
    }

    let mut flush_error: Option<String> = None;
    if let Err(e) = flush_manifest(&dest, &manifest) {
        flush_error = Some(e);
    }
    emit_finished(
        &app,
        &id,
        sink.failed == 0 && flush_error.is_none(),
        false,
        sink.done,
        sink.skipped,
        sink.failed,
        failed,
        flush_error,
    );
    clear_task(&id);
}

async fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = tokio::fs::read(path).await.map_err(|e| e.to_string())?;
    Ok(sha256_hex(&bytes))
}

fn unix_now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs()
}

fn clear_task(id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.remove(id);
    }
}

#[allow(clippy::too_many_arguments)]
fn emit_finished(
    app: &tauri::AppHandle,
    id: &str,
    ok: bool,
    canceled: bool,
    processed: usize,
    skipped: usize,
    failed_count: usize,
    failed: Vec<serde_json::Value>,
    error: Option<String>,
) {
    let _ = app.emit(
        EVENT_FINISHED,
        serde_json::json!({
            "id": id,
            "ok": ok,
            "canceled": canceled,
            "processed": processed,
            "skipped": skipped,
            "failedCount": failed_count,
            "failed": failed,
            "error": error.unwrap_or_default(),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> PhotoConfig {
        PhotoConfig {
            endpoint: "cos.ap-guangzhou.myqcloud.com".into(),
            region: "ap-guangzhou".into(),
            bucket: "b-1250000000".into(),
            access_key: "AKID".into(),
            secret_key: "SECRET".into(),
            ..Default::default()
        }
    }

    // ---- 官方 SigV4 向量（与 JS 侧同一组，见 src/photo/sigv4.test.js） ----

    #[test]
    fn sigv4_get_vanilla_matches_official_vector() {
        let config = PhotoConfig {
            region: "us-east-1".into(),
            access_key: "AKIDEXAMPLE".into(),
            secret_key: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY".into(),
            ..Default::default()
        };
        let now = UNIX_EPOCH + Duration::from_secs(1_440_938_160); // 2015-08-30T12:36:00Z
        // service 段用官方向量里的 "service"，其余与线上调用一致
        let signed = sign_request("GET", "example.amazonaws.com", "/", &[], &[], EMPTY_SHA256, &config, now, "service");
        assert_eq!(signed.amz_date, "20150830T123600Z");
        assert_eq!(
            signed.authorization,
            "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, \
             SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31"
        );
    }

    #[test]
    fn sigv4_query_pairs_sorted_before_signing() {
        let config = test_config();
        let now = SystemTime::now();
        let a = sign_request(
            "GET",
            "example.amazonaws.com",
            "/",
            &[("Param2".into(), "value2".into()), ("Param1".into(), "value1".into())],
            &[],
            EMPTY_SHA256,
            &config,
            now,
            "s3",
        );
        let b = sign_request(
            "GET",
            "example.amazonaws.com",
            "/",
            &[("Param1".into(), "value1".into()), ("Param2".into(), "value2".into())],
            &[],
            EMPTY_SHA256,
            &config,
            now,
            "s3",
        );
        assert_eq!(a.authorization, b.authorization);
    }

    // ---- 时间换算 ----

    #[test]
    fn amz_date_utc_formatting() {
        assert_eq!(amz_date(UNIX_EPOCH), "19700101T000000Z");
        assert_eq!(amz_date(UNIX_EPOCH + Duration::from_secs(1_440_938_160)), "20150830T123600Z");
        assert_eq!(amz_date(UNIX_EPOCH + Duration::from_secs(1_767_225_600)), "20260101T000000Z");
    }

    // ---- URL 组装 ----

    #[test]
    fn host_and_path_variants() {
        let config = test_config();
        assert_eq!(host_of(&config), "b-1250000000.cos.ap-guangzhou.myqcloud.com");
        assert_eq!(object_path(&config, "photos/2026/10/13/a.jpg"), "/photos/2026/10/13/a.jpg");

        let mut path_style = test_config();
        path_style.path_style = true;
        path_style.endpoint = "127.0.0.1:9000".into();
        assert_eq!(host_of(&path_style), "127.0.0.1:9000");
        assert_eq!(object_path(&path_style, "photos/a.jpg"), "/b-1250000000/photos/a.jpg");
    }

    #[test]
    fn uri_encode_keeps_key_charset_verbatim() {
        assert_eq!(uri_encode("photos/2026/10/13/20261013T163000_ab12cd_9f3e.jpg", false), "photos/2026/10/13/20261013T163000_ab12cd_9f3e.jpg");
        assert_eq!(uri_encode("a b", true), "a%20b");
        assert_eq!(uri_encode("a/b", true), "a%2Fb");
    }

    // ---- 列出与错误解析 ----

    #[test]
    fn parse_listing_extracts_objects() {
        let xml = r#"<ListBucketResult>
            <IsTruncated>true</IsTruncated>
            <NextContinuationToken>tok+1/2=</NextContinuationToken>
            <Contents><Key>photos/2026/10/13/a.jpg</Key><Size>123</Size><ETag>&quot;abc&quot;</ETag><LastModified>2026-10-13T08:30:00.000Z</LastModified></Contents>
            <Contents><Key>photos/2026/10/13/b&amp;c.jpg</Key><Size>456</Size><ETag>&quot;d&quot;</ETag><LastModified>2026-10-13T08:31:00.000Z</LastModified></Contents>
        </ListBucketResult>"#;
        let objects = parse_objects(xml);
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].key, "photos/2026/10/13/a.jpg");
        assert_eq!(objects[0].size, 123);
        assert_eq!(objects[0].etag, "abc");
        assert_eq!(objects[1].key, "photos/2026/10/13/b&c.jpg");
        assert!(xml.contains("<IsTruncated>true</IsTruncated>"));
        assert_eq!(between(xml, "<NextContinuationToken>", "</NextContinuationToken>").unwrap(), "tok+1/2=");
    }

    #[test]
    fn describe_error_prefers_code_and_message() {
        assert_eq!(
            describe_error(403, "<Error><Code>SignatureDoesNotMatch</Code><Message>bad sig</Message></Error>"),
            "SignatureDoesNotMatch: bad sig"
        );
        assert_eq!(describe_error(500, "oops"), "HTTP 500");
    }

    // ---- 归档目录与文件名 ----

    #[test]
    fn dir_markers_are_recognized() {
        // 七牛/S3 控制台建"文件夹"会生成 0 字节、key 以 / 结尾的对象——列表里会变成空白行
        assert!(is_dir_marker("photos/"));
        assert!(is_dir_marker("photos/2026/10/13/"));
        assert!(is_dir_marker("photos\\2026\\"));
        assert!(!is_dir_marker("photos/2026/10/13/a.jpg"));
        assert!(!is_dir_marker("photos/a/b.jpg"));
        assert!(!is_dir_marker(""));
    }

    #[test]
    fn thumb_cache_name_scopes_by_backend_and_key() {
        let base = PhotoConfig {
            provider: "qiniu".into(),
            bucket: "b1".into(),
            domain: "cdn.example.com".into(),
            ..Default::default()
        };
        let other_bucket = PhotoConfig {
            bucket: "b2".into(),
            ..base.clone()
        };
        let first = thumb_cache_name(&base, "photos/a.jpg");
        assert_eq!(first, thumb_cache_name(&base, "photos/a.jpg"));
        assert_ne!(first, thumb_cache_name(&base, "photos/b.jpg"));
        assert_ne!(first, thumb_cache_name(&other_bucket, "photos/a.jpg"));
        assert!(first.ends_with(".png"));
        assert_eq!(first.len(), 64 + 4);
    }

    #[test]
    fn thumbnail_pipeline_handles_png_jpeg_and_garbage() {
        let img = image::RgbImage::from_fn(200, 100, |x, _| image::Rgb([(x % 255) as u8, 10, 20]));
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(img.clone())
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();
        let thumb = make_thumbnail_png(&png, 96).expect("png 应能出缩略图");
        let decoded = image::load_from_memory(&thumb).unwrap();
        assert_eq!(decoded.width(), 96);
        assert!(decoded.height() <= 96);

        // jpeg 路径依赖 image 的 "jpeg" feature——这条断掉说明 feature 被移除
        let mut jpeg = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut Cursor::new(&mut jpeg), image::ImageFormat::Jpeg)
            .unwrap();
        assert!(make_thumbnail_png(&jpeg, 96).is_some(), "jpeg 应能解码");

        assert!(make_thumbnail_png(b"not an image", 96).is_none());
        assert!(make_thumbnail_png(&[], 96).is_none());
    }

    #[test]
    fn archive_folder_from_key_date_segments() {
        let item = PhotoObject {
            key: "photos/2026/10/13/20261013T163000_ab12cd_9f3e.jpg".into(),
            size: 1,
            etag: String::new(),
            last_modified: "2026-10-13T08:30:00.000Z".into(),
        };
        assert_eq!(archive_folder(&item), "2026-10-13");
    }

    #[test]
    fn archive_folder_supports_nested_prefix() {
        let item = PhotoObject {
            key: "trip/2026/2025/12/31/20251231T235900_ab12cd_0000.jpg".into(),
            size: 1,
            etag: String::new(),
            last_modified: String::new(),
        };
        assert_eq!(archive_folder(&item), "2025-12-31");
    }

    #[test]
    fn archive_folder_falls_back_to_last_modified_then_other() {
        let with_time = PhotoObject {
            key: "photos/manual.jpg".into(),
            size: 1,
            etag: String::new(),
            last_modified: "2026-01-02T03:04:05.000Z".into(),
        };
        assert_eq!(archive_folder(&with_time), "2026-01-02");
        let none = PhotoObject { key: "photos/manual.jpg".into(), size: 1, etag: String::new(), last_modified: String::new() };
        assert_eq!(archive_folder(&none), "other");
    }

    #[test]
    fn sanitize_file_name_removes_dangerous_chars() {
        assert_eq!(sanitize_file_name("photos/2026/a.jpg", "2026"), "a.jpg");
        assert_eq!(sanitize_file_name("photos/we?ird:name.jpg", "2026"), "we_ird_name.jpg");
        assert_eq!(sanitize_file_name("photos/..", "other"), "object-other");
        assert_eq!(sanitize_file_name("photos/", "other"), "object-other");
    }

    // ---- 账本 ----

    #[test]
    fn manifest_roundtrip() {
        let dir = std::env::temp_dir().join(format!("toolcove-photo-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut manifest = load_manifest(&dir);
        assert_eq!(manifest.version, 1);
        assert!(manifest.entries.is_empty());
        manifest.entries.push(ManifestEntry {
            key: "photos/2026/10/13/a.jpg".into(),
            size: 3,
            sha256: "abc".into(),
            archived_at: 1,
            path: "2026-10-13/a.jpg".into(),
        });
        flush_manifest(&dir, &manifest).unwrap();
        let loaded = load_manifest(&dir);
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(loaded.entries[0].key, "photos/2026/10/13/a.jpg");
        let _ = std::fs::remove_dir_all(&dir);
    }

    // ---- 七牛 ----

    #[test]
    fn hmac_sha1_matches_known_vector() {
        // 公开测试向量（RFC 2202 风格）：key="key"，消息是那句经典的 fox
        let mac = hmac_sha1(b"key", b"The quick brown fox jumps over the lazy dog");
        assert_eq!(hex(&mac), "de7c9b85b8b78aa6bc8a7a36f70a90701c9db4d9");
    }

    #[test]
    fn urlsafe_b64_is_url_safe_with_padding() {
        // 与官方 Go SDK（base64.URLEncoding）一致：带填充、不出 +/（出则 URL 里要二次转义）
        assert_eq!(urlsafe_b64(b"hello"), "aGVsbG8=");
        let mac = hmac_sha1(b"sk", b"policy");
        let encoded = urlsafe_b64(&mac);
        assert!(!encoded.contains('+') && !encoded.contains('/'));
    }

    /// 官方 Go SDK 自带的签名向量（auth/credentials_test.go）：ak/sk 对 "hello" 的签名。
    /// 这一条锁死 HMAC-SHA1 + URL-safe Base64 两个原语，其余签名都只是"往签名串里拼什么"的问题。
    #[test]
    fn qiniu_sign_matches_official_vector() {
        assert_eq!(urlsafe_b64(&hmac_sha1(b"sk", b"hello")), "NDN8cM0rwosxhHJ6QAcI7ialr0g=");
        assert_eq!(urlsafe_b64(&hmac_sha1(b"sk", b"world")), "wZ-sw41ayh3PFDmQA-D3o7eBJIY=");
    }

    /// 固定请求的管理凭证（Qiniu V2 格式）。期望值由参考实现生成，
    /// 参考实现先通过官方向量自检（见上一条），再用官方 Go SDK collectDataV2 的签名串构造算出。
    /// 旧版 QBox 格式（只签 `path?query\n`）会被服务端 401——这正是用户实测踩到的坑。
    #[test]
    fn qiniu_v2_management_token_matches_reference() {
        let config = PhotoConfig {
            provider: "qiniu".into(),
            access_key: "ak".into(),
            secret_key: "sk".into(),
            ..Default::default()
        };
        let token = qiniu_management_auth(
            &config,
            "POST",
            "rsf.qbox.me",
            "/list?bucket=my-photos&limit=1&prefix=photos%2F",
            "application/x-www-form-urlencoded",
        );
        assert_eq!(token, "Qiniu ak:sh8UrSiLi24oTFUJboMETBwGm9c=");
    }

    /// 私有下载令牌：签名串是**完整 URL** + `?e=`（官方 Python/Go SDK 同款）。
    #[test]
    fn qiniu_download_token_signs_full_url() {
        let config = PhotoConfig {
            provider: "qiniu".into(),
            access_key: "ak".into(),
            secret_key: "sk".into(),
            domain: "cdn.example.com".into(),
            ..Default::default()
        };
        let token = qiniu_download_token(&config, "photos/2026/10/13/a.jpg", 1_700_000_000);
        assert_eq!(token, "ak:9Gm2yMtKUO768DQ8teYIWaLApY4=");
        // 负数保护：只签 path 的旧写法会得到完全不同的值——这个断言是行为差异的哨兵
        let path_only = urlsafe_b64(&hmac_sha1(b"sk", b"/photos/2026/10/13/a.jpg?e=1700000000"));
        assert_ne!(token.split(':').nth(1).unwrap(), path_only);
    }

    #[test]
    fn qiniu_put_time_converts_to_iso() {
        // putTime 单位是 100ns；2026-10-13T08:30:00Z 的 UNIX 秒已知
        let iso = iso_from_unix(1_760_872_200);
        assert_eq!(iso.len(), 24);
        assert!(iso.starts_with("20"));
        assert!(iso.ends_with(".000Z"));
    }

    #[test]
    fn iso_from_unix_formats_known_instant() {
        assert_eq!(iso_from_unix(1_440_938_160), "2015-08-30T12:36:00.000Z");
    }

    // ---- WebDAV ----

    #[test]
    fn rfc1123_date_parses_webdav_timestamps() {
        assert_eq!(rfc1123_date("Tue, 13 Oct 2026 08:30:00 GMT").as_deref(), Some("2026-10-13"));
        assert_eq!(rfc1123_date("Mon, 01 Jan 2024 00:00:00 GMT").as_deref(), Some("2024-01-01"));
        assert_eq!(rfc1123_date("garbage"), None);
    }

    #[test]
    fn percent_decode_handles_chinese_names() {
        assert_eq!(percent_decode("%E7%85%A7%E7%89%87.jpg"), "照片.jpg");
        assert_eq!(percent_decode("plain.jpg"), "plain.jpg");
        assert_eq!(percent_decode("%ZZ"), "%ZZ"); // 非法序列原样保留，不吞字符
    }

    #[test]
    fn split_blocks_supports_namespaced_responses() {
        let xml = r#"<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response><d:href>/dav/photos/</d:href></d:response>
          <d:response><d:href>/dav/photos/2026/</d:href></d:response>
        </d:multistatus>"#;
        let blocks = split_blocks(xml, "response");
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].contains("/dav/photos/"));
        assert_eq!(split_blocks("<multistatus><response>x</response></multistatus>", "response").len(), 1);
    }

    #[test]
    fn tag_text_reads_prefixed_and_plain_tags() {
        assert_eq!(tag_text("<d:href>/a/b</d:href>", "href"), Some("/a/b"));
        assert_eq!(tag_text("<href>/plain</href>", "href"), Some("/plain"));
        assert_eq!(tag_text("<d:getcontentlength>123</d:getcontentlength>", "getcontentlength"), Some("123"));
        assert_eq!(tag_text("<d:href>/a</d:href>", "getetag"), None);
    }

    #[test]
    fn webdav_key_of_strips_base_and_decodes() {
        let config = PhotoConfig {
            provider: "webdav".into(),
            endpoint: "https://dav.example.com/dav".into(),
            ..Default::default()
        };
        assert_eq!(webdav_key_of(&config, "https://dav.example.com/dav/photos/2026/10/13/a.jpg"), "photos/2026/10/13/a.jpg");
        assert_eq!(webdav_key_of(&config, "https://dav.example.com/dav/photos/2026/10/13/%E7%85%A7.jpg"), "photos/2026/10/13/照.jpg");
    }

    #[test]
    fn download_target_per_provider() {
        let qiniu_private = PhotoConfig {
            provider: "qiniu".into(),
            access_key: "AK".into(),
            secret_key: "SK".into(),
            domain: "cdn.example.com".into(),
            private_bucket: true,
            ..Default::default()
        };
        let (url, headers) = download_target(&qiniu_private, "photos/a.jpg");
        assert!(url.starts_with("https://cdn.example.com/photos/a.jpg?e="), "{url}");
        assert!(url.contains("&token=AK:"));
        assert!(headers.is_empty());

        let qiniu_public = PhotoConfig { private_bucket: false, ..qiniu_private.clone() };
        let (url, _) = download_target(&qiniu_public, "photos/a.jpg");
        assert_eq!(url, "https://cdn.example.com/photos/a.jpg");

        let webdav = PhotoConfig {
            provider: "webdav".into(),
            endpoint: "https://dav.example.com/dav".into(),
            username: "u".into(),
            password: "p".into(),
            ..Default::default()
        };
        let (url, headers) = download_target(&webdav, "photos/a.jpg");
        assert_eq!(url, "https://dav.example.com/dav/photos/a.jpg");
        assert_eq!(headers[0].0, "Authorization");
        assert!(headers[0].1.starts_with("Basic "));

        let s3 = test_config();
        let (url, headers) = download_target(&s3, "photos/2026/10/13/a.jpg");
        assert_eq!(url, "https://b-1250000000.cos.ap-guangzhou.myqcloud.com/photos/2026/10/13/a.jpg");
        assert!(headers.iter().any(|(name, value)| name == "Authorization" && value.starts_with("AWS4-HMAC-SHA256")));
    }
}
