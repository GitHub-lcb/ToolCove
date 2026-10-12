//! 提示词工具：云端生图与 ComfyUI 生成结果的媒体存取。
//!
//! 生成媒体统一落 `<app_data_dir>/media/`，**刻意不进数据备份**：
//! `storage::run_backup` 只打包根级 *.json 与 images/，恢复上限是 50MB/文件、250MB/总量——
//! 生图/生视频动辄几百 MB，进备份会把自动备份体积与恢复功能一起打爆。
//! 代价是恢复旧备份后 media/ 里可能留孤儿文件，UI 用「媒体文件不存在」占位兜底。
//!
//! 为什么结果不走 network::http_request：它把整个响应体读进内存再 base64 过 IPC，
//! 几百 MB 的 mp4 会打爆内存；这里流式边收边写盘（带停滞看门狗），与下载器同一纪律。

use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use tauri::Manager;
use tokio::io::AsyncWriteExt;

/// 单次流式拉取上限 2 GiB：覆盖本地 ComfyUI 视频，又给"地址填错"留闸。
const FETCH_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 预览读图上限（base64 过 IPC）：视频不走这条路，交给系统播放器/asset 协议。
const MEDIA_READ_MAX_BYTES: u64 = 32 * 1024 * 1024;
/// 长时间收不到任何字节即判定连接死亡。
const STALL_TIMEOUT: Duration = Duration::from_secs(30);
const STALL_TICK: Duration = Duration::from_secs(4);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 云端生图总超时：大模型/高分辨率生图 1-2 分钟是常态，给足余量。
const GENERATE_TIMEOUT: Duration = Duration::from_secs(300);

/// 媒体文件名白名单校验：由调用方生成（JS 的 mediaName / Rust 的 gen_media_name），
/// 这里严格拒绝而不是静默清洗——静默清洗会把坏名字变成另一个看起来正常的文件。
fn safe_media_name(name: &str) -> Result<String, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() || trimmed.len() > 128 || trimmed.contains("..") {
        return Err("非法的媒体文件名".into());
    }
    if !trimmed
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err("媒体文件名只能包含字母、数字、下划线、短横线与点".into());
    }
    Ok(trimmed.to_string())
}

fn media_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("media");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建媒体目录失败：{e}"))?;
    Ok(dir)
}

fn ext_of(name: &str) -> String {
    std::path::Path::new(name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn is_image_ext(ext: &str) -> bool {
    matches!(ext, "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp")
}

/// 生成媒体文件名：p<unix 秒>-<6 位十六进制随机>[-(第 i+1 张)].<ext>。
fn gen_media_name(ext: &str, index: usize, now_secs: u64, rand: u32) -> String {
    let suffix = if index == 0 {
        String::new()
    } else {
        format!("-{}", index + 1)
    };
    format!("p{}-{:06x}{}.{}", now_secs, rand & 0x00ff_ffff, suffix, ext)
}

/// 图片字节嗅探（b64 响应没有扩展名；服务端 Content-Type 不可信，看魔数最稳）。
fn sniff_image_ext(bytes: &[u8]) -> &'static str {
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a] {
        return "png";
    }
    if bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff] {
        return "jpg";
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return "webp";
    }
    if bytes.len() >= 5 && (&bytes[..5] == b"GIF87" || &bytes[..5] == b"GIF89") {
        return "gif";
    }
    "png"
}

/// /images/generations 请求体。negative_prompt 仅非空时携带——
/// 严格实现会因未知字段 400；response_format 在重试变体里去掉（见命令内注释）。
fn build_image_body(
    model: &str,
    prompt: &str,
    negative: Option<&str>,
    size: Option<&str>,
    n: Option<u32>,
    with_response_format: bool,
) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    body.insert("model".into(), serde_json::json!(model));
    body.insert("prompt".into(), serde_json::json!(prompt));
    body.insert("n".into(), serde_json::json!(n.unwrap_or(1).clamp(1, 4)));
    let size = size.map(str::trim).filter(|s| !s.is_empty()).unwrap_or("1024x1024");
    body.insert("size".into(), serde_json::json!(size));
    if with_response_format {
        body.insert("response_format".into(), serde_json::json!("b64_json"));
    }
    if let Some(neg) = negative {
        let neg = neg.trim();
        if !neg.is_empty() {
            body.insert("negative_prompt".into(), serde_json::json!(neg));
        }
    }
    serde_json::Value::Object(body)
}

#[derive(Debug, PartialEq)]
enum ImageSource {
    B64(String),
    Url(String),
}

fn data_url_b64(value: &str) -> Option<String> {
    let s = value.trim();
    if !s.starts_with("data:image/") {
        return None;
    }
    let idx = s.find(";base64,")?;
    let payload = s[idx + 8..].trim();
    if payload.is_empty() {
        None
    } else {
        Some(payload.to_string())
    }
}

/// 容错解析生图响应：标准 data[].b64_json / data[].url，另兜底 data:image 内联串与纯 URL 字符串。
fn collect_image_sources(value: &serde_json::Value) -> Vec<ImageSource> {
    let mut out = Vec::new();
    let items: Vec<&serde_json::Value> = match value.get("data").and_then(|d| d.as_array()) {
        Some(list) => list.iter().collect(),
        None => vec![value],
    };
    for item in items {
        if let Some(obj) = item.as_object() {
            if let Some(b64) = obj.get("b64_json").and_then(|v| v.as_str()) {
                let b64 = b64.trim();
                if !b64.is_empty() {
                    out.push(ImageSource::B64(b64.to_string()));
                    continue;
                }
            }
            if let Some(url) = obj.get("url").and_then(|v| v.as_str()) {
                if url.starts_with("http://") || url.starts_with("https://") {
                    out.push(ImageSource::Url(url.to_string()));
                    continue;
                }
                if let Some(b64) = data_url_b64(url) {
                    out.push(ImageSource::B64(b64));
                    continue;
                }
            }
            for v in obj.values() {
                if let Some(s) = v.as_str() {
                    if let Some(b64) = data_url_b64(s) {
                        out.push(ImageSource::B64(b64));
                        break;
                    }
                }
            }
        } else if let Some(s) = item.as_str() {
            if let Some(b64) = data_url_b64(s) {
                out.push(ImageSource::B64(b64));
            } else if s.starts_with("http://") || s.starts_with("https://") {
                out.push(ImageSource::Url(s.to_string()));
            }
        }
    }
    out
}

/// 流式下载到 dest：先写 `<dest>.part` 再改名，失败不留半截文件。
/// 停滞看门狗与总上限是必须的——没有它们，一次断流会让命令永远挂着。
async fn stream_to_file(
    client: &reqwest::Client,
    url: &str,
    dest: &std::path::Path,
    max_bytes: u64,
) -> Result<u64, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("连接失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("HTTP {}", status.as_u16()));
    }
    let part = PathBuf::from(format!("{}.part", dest.to_string_lossy()));
    let mut file = tokio::fs::File::create(&part)
        .await
        .map_err(|e| format!("创建文件失败：{e}"))?;
    let mut stream = resp.bytes_stream();
    let mut total: u64 = 0;
    let mut last_progress = Instant::now();
    let outcome: Result<(), String> = loop {
        tokio::select! {
            item = stream.next() => match item {
                Some(Ok(bytes)) => {
                    if bytes.is_empty() {
                        continue;
                    }
                    total += bytes.len() as u64;
                    if total > max_bytes {
                        break Err("文件超过大小上限，已中止".into());
                    }
                    if let Err(e) = file.write_all(&bytes).await {
                        break Err(format!("写入文件失败：{e}"));
                    }
                    last_progress = Instant::now();
                }
                Some(Err(e)) => break Err(format!("传输中断：{e}")),
                None => break Ok(()),
            },
            _ = tokio::time::sleep(STALL_TICK) => {
                if last_progress.elapsed() > STALL_TIMEOUT {
                    break Err(format!("连接停滞超过 {} 秒，已中止", STALL_TIMEOUT.as_secs()));
                }
            }
        }
    };
    let _ = file.flush().await;
    drop(file);
    if let Err(error) = outcome {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(error);
    }
    if total == 0 {
        let _ = tokio::fs::remove_file(&part).await;
        return Err("响应为空，未写入文件".into());
    }
    tokio::fs::rename(&part, dest).await.map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("保存文件失败：{e}")
    })?;
    Ok(total)
}

fn build_client(app: &tauri::AppHandle, total_timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .user_agent(format!("ToolCove/{}", app.package_info().version));
    if let Some(timeout) = total_timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|e| format!("创建客户端失败：{e}"))
}

/// 云端生图：OpenAI 兼容 `POST {base}/images/generations`。
/// 结果在 Rust 侧直接解码写 media/（bytes 不过 IPC），返回文件名清单。
#[tauri::command]
pub async fn prompt_image_generate(
    app: tauri::AppHandle,
    base_url: String,
    api_key: String,
    model: String,
    prompt: String,
    negative_prompt: Option<String>,
    size: Option<String>,
    n: Option<u32>,
) -> Result<serde_json::Value, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置生图接口地址".into());
    }
    if api_key.trim().is_empty() {
        return Err("未配置生图 API Key".into());
    }
    if model.trim().is_empty() {
        return Err("未配置生图模型名称".into());
    }
    if prompt.trim().is_empty() {
        return Err("提示词为空".into());
    }
    crate::storage::ensure_data_writable()?;
    let started = Instant::now();
    let client = build_client(&app, Some(GENERATE_TIMEOUT))?;
    let url = format!("{base}/images/generations");
    let negative = negative_prompt.as_deref();
    let size = size.as_deref();

    let mut body = build_image_body(&model, &prompt, negative, size, n, true);
    let mut resp = send_generate(&client, &url, api_key.trim(), &body).await?;
    let mut status = resp.status();
    let mut text = resp.text().await.map_err(|e| e.to_string())?;
    // 严格实现不认识 response_format：去掉后重试一次（返回不带 b64 时由 url 分支兜底）
    if status.as_u16() == 400 && text.contains("response_format") {
        body = build_image_body(&model, &prompt, negative, size, n, false);
        resp = send_generate(&client, &url, api_key.trim(), &body).await?;
        status = resp.status();
        text = resp.text().await.map_err(|e| e.to_string())?;
    }
    let value: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "raw": text }));
    if !status.is_success() {
        let msg = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| text.chars().take(300).collect());
        return Err(format!("HTTP {}：{}", status.as_u16(), msg));
    }
    let sources = collect_image_sources(&value);
    if sources.is_empty() {
        return Err("服务未返回图片".into());
    }

    let dir = media_dir(&app)?;
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let mut rand_bytes = [0u8; 4];
    let _ = getrandom::fill(&mut rand_bytes);
    let seed = u32::from_le_bytes(rand_bytes);

    let mut files = Vec::new();
    for (index, source) in sources.into_iter().enumerate() {
        match source {
            ImageSource::B64(b64) => {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64.trim())
                    .map_err(|e| format!("base64 解码失败：{e}"))?;
                let name = gen_media_name(sniff_image_ext(&bytes), index, now_secs, seed);
                let path = dir.join(&name);
                tokio::fs::write(&path, &bytes)
                    .await
                    .map_err(|e| format!("写入文件失败：{e}"))?;
                files.push(serde_json::json!({ "name": name, "bytes": bytes.len() }));
            }
            ImageSource::Url(source_url) => {
                let raw_ext = ext_of(source_url.split('?').next().unwrap_or(""));
                let ext = if is_image_ext(&raw_ext) { raw_ext } else { "png".to_string() };
                let name = gen_media_name(&ext, index, now_secs, seed);
                let path = dir.join(&name);
                let bytes = stream_to_file(&client, &source_url, &path, MEDIA_READ_MAX_BYTES).await?;
                files.push(serde_json::json!({ "name": name, "bytes": bytes }));
            }
        }
    }
    Ok(serde_json::json!({
        "files": files,
        "count": files.len(),
        "durationMs": started.elapsed().as_millis() as u64,
    }))
}

async fn send_generate(
    client: &reqwest::Client,
    url: &str,
    api_key: &str,
    body: &serde_json::Value,
) -> Result<reqwest::Response, String> {
    client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(body)
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))
}

/// 流式下载任意结果文件到 media/（ComfyUI /view 的图片与视频都走这里）。
/// 名字由前端生成（mediaName），Rust 严格校验。
#[tauri::command]
pub async fn media_fetch_stream(
    app: tauri::AppHandle,
    url: String,
    name: String,
) -> Result<serde_json::Value, String> {
    let target = url.trim();
    if !target.starts_with("http://") && !target.starts_with("https://") {
        return Err("地址需以 http:// 或 https:// 开头".into());
    }
    let safe = safe_media_name(&name)?;
    crate::storage::ensure_data_writable()?;
    let dir = media_dir(&app)?;
    let dest = dir.join(&safe);
    let client = build_client(&app, None)?;
    let bytes = stream_to_file(&client, target, &dest, FETCH_MAX_BYTES).await?;
    Ok(serde_json::json!({ "name": safe, "path": dest.to_string_lossy(), "bytes": bytes }))
}

/// 预览读图：仅图片扩展名且 ≤32MB（视频交给系统播放器 / asset 协议）。
#[tauri::command]
pub async fn media_read_b64(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let safe = safe_media_name(&name)?;
    if !is_image_ext(&ext_of(&safe)) {
        return Err("仅支持读取图片预览".into());
    }
    let path = media_dir(&app)?.join(&safe);
    tauri::async_runtime::spawn_blocking(move || {
        if !path.exists() {
            return Err("媒体文件不存在".to_string());
        }
        let size = std::fs::metadata(&path).map_err(|e| e.to_string())?.len();
        if size > MEDIA_READ_MAX_BYTES {
            return Err("图片过大，请用系统打开".to_string());
        }
        use base64::Engine;
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除媒体文件（不存在视为成功）。
#[tauri::command]
pub async fn media_delete(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let safe = safe_media_name(&name)?;
    crate::storage::ensure_data_writable()?;
    let path = media_dir(&app)?.join(&safe);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 媒体文件的绝对路径（供 openPath / revealPath / convertFileSrc）。
/// 名字为空时返回媒体目录本身（「打开媒体目录」按钮用），并确保目录存在。
#[tauri::command]
pub async fn media_path(app: tauri::AppHandle, name: Option<String>) -> Result<String, String> {
    let dir = media_dir(&app)?;
    let raw = name.unwrap_or_default();
    if raw.trim().is_empty() {
        return Ok(dir.to_string_lossy().to_string());
    }
    let safe = safe_media_name(&raw)?;
    let path = dir.join(&safe);
    if !path.exists() {
        return Err("媒体文件不存在".into());
    }
    Ok(path.to_string_lossy().to_string())
}

/// 「另存为」：把 media/ 里的文件拷到用户所选路径（视频几百 MB，不能走 base64 回传）。
#[tauri::command]
pub async fn media_export(app: tauri::AppHandle, name: String, dest: String) -> Result<(), String> {
    let safe = safe_media_name(&name)?;
    let target = dest.trim();
    if target.is_empty() {
        return Err("未选择保存路径".into());
    }
    let source = media_dir(&app)?.join(&safe);
    if !source.exists() {
        return Err("媒体文件不存在".into());
    }
    let source_for_task = source.clone();
    let target_for_task = target.to_string();
    tauri::async_runtime::spawn_blocking(move || std::fs::copy(&source_for_task, &target_for_task).map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
        .map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_names_reject_traversal_and_weird_chars() {
        assert!(safe_media_name("p20261010-120000-ab12.png").is_ok());
        assert!(safe_media_name("ToolCove_00001_.png").is_ok());
        assert!(safe_media_name("../x.png").is_err());
        assert!(safe_media_name("a/b.png").is_err());
        assert!(safe_media_name("中文.png").is_err());
        assert!(safe_media_name("").is_err());
        assert!(safe_media_name("   ").is_err());
        assert!(safe_media_name(&format!("{}.png", "x".repeat(200))).is_err());
    }

    #[test]
    fn sniff_detects_png_jpeg_webp_gif_and_defaults_png() {
        assert_eq!(sniff_image_ext(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1]), "png");
        assert_eq!(sniff_image_ext(&[0xff, 0xd8, 0xff, 0xe0]), "jpg");
        assert_eq!(sniff_image_ext(b"RIFF____WEBPVP8 "), "webp");
        assert_eq!(sniff_image_ext(b"GIF89a..."), "gif");
        assert_eq!(sniff_image_ext(b"unknown bytes"), "png");
    }

    #[test]
    fn gen_name_has_stable_pattern() {
        assert_eq!(gen_media_name("png", 0, 1_760_000_000, 0x0000ab), "p1760000000-0000ab.png");
        assert_eq!(gen_media_name("mp4", 2, 1_760_000_000, 0xffffff), "p1760000000-ffffff-3.mp4");
    }

    #[test]
    fn image_body_defaults_and_negative_gating() {
        let body = build_image_body("m", "p", None, None, None, true);
        assert_eq!(body["model"], "m");
        assert_eq!(body["n"], 1);
        assert_eq!(body["size"], "1024x1024");
        assert_eq!(body["response_format"], "b64_json");
        assert!(body.get("negative_prompt").is_none());

        let body = build_image_body("m", "p", Some("  糊 "), Some("512x512"), Some(9), false);
        assert_eq!(body["negative_prompt"], "糊");
        assert_eq!(body["size"], "512x512");
        assert_eq!(body["n"], 4);
        assert!(body.get("response_format").is_none());

        let body = build_image_body("m", "p", Some("   "), Some("  "), Some(0), true);
        assert!(body.get("negative_prompt").is_none());
        assert_eq!(body["size"], "1024x1024");
        assert_eq!(body["n"], 1);
    }

    #[test]
    fn collect_sources_handles_standard_and_tolerant_shapes() {
        let standard = serde_json::json!({
            "data": [
                { "b64_json": "AAAA" },
                { "url": "https://x/a.png" }
            ]
        });
        assert_eq!(
            collect_image_sources(&standard),
            vec![ImageSource::B64("AAAA".into()), ImageSource::Url("https://x/a.png".into())]
        );

        let tolerant = serde_json::json!({ "data": ["data:image/png;base64,BBBB", "https://x/b.webp", 42] });
        assert_eq!(
            collect_image_sources(&tolerant),
            vec![ImageSource::B64("BBBB".into()), ImageSource::Url("https://x/b.webp".into())]
        );

        let top_level = serde_json::json!({ "url": "https://x/c.png" });
        assert_eq!(collect_image_sources(&top_level), vec![ImageSource::Url("https://x/c.png".into())]);

        assert!(collect_image_sources(&serde_json::json!({ "data": [] })).is_empty());
        assert!(collect_image_sources(&serde_json::json!({ "data": [{ "b64_json": "  " }] })).is_empty());
        assert!(collect_image_sources(&serde_json::json!({ "raw": "oops" })).is_empty());
    }
}
