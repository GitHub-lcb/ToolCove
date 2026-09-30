//! 大文件多线程分片下载（下载器工具）。
//!
//! 为什么不能用既有的 `network::http_request`：它把整个响应体读进内存再 base64 返回，
//! 十几 GB 的模型文件会直接把内存打爆。这里走流式：每条连接把字节直接写进分片文件，
//! 全部就绪后再顺序合并成一个文件。
//!
//! 三件事是这类下载器真正会翻车的地方，本模块逐条处理：
//!
//! 1. **断点续传**：分片按固定布局切成 `p00.bin`…`pNN.bin`，续传时读各分片已有长度、
//!    从 `start + 已有长度` 继续要 Range。布局（线程数）变了旧分片就作废，所以分片目录里
//!    存 `meta.json` 记录 url/总长/线程数，对不上就整目录重来——宁可重下也不能拼出错文件。
//! 2. **卡死重连**：反向代理（hf-mirror 这类）会在大文件中途掐连接，或干脆停在 0 B/s。
//!    每个分片带"停滞看门狗"：N 秒内一个字节都没进来就主动断开，换新偏移量重连。
//! 3. **不信任服务器的 Content-Type**：拿到的字节数只跟分片区间比，不跟类型比。
//!    服务器忽略 Range 回 200（整文件）时必须拒绝写入，否则会把整个文件重复追加进分片。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use tauri::Emitter;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// 单文件上限 200 GB：够覆盖模型权重，又给"地址填错导致超大下载"留一道闸。
pub const DOWNLOAD_MAX_BYTES: u64 = 200 * 1024 * 1024 * 1024;
/// 停滞判定：连续这么久没收到任何字节就认为连接死了。
const STALL_TIMEOUT: Duration = Duration::from_secs(20);
/// 看门狗自检间隔。
const STALL_TICK: Duration = Duration::from_secs(4);
/// 单个分片的最大重连次数，超过仍不完成即判定该分片失败。
const MAX_RETRIES: u32 = 60;
/// 进度事件节流间隔：8 条连接下按字节发会把 IPC 打满，UI 也重绘不过来。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(400);

const EVENT_PROGRESS: &str = "downloader:progress";
const EVENT_FINISHED: &str = "downloader:finished";

/// 允许的线程数范围。1 走单流直写（服务器不支持 Range 时的天然降级路径）。
fn clamp_conns(conns: Option<u16>) -> u16 {
    conns.unwrap_or(8).clamp(1, 32)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .user_agent("ToolCove/1.0 (downloader)")
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))
}

fn validate_url(url: &str) -> Result<String, String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("请输入下载地址".into());
    }
    if !u.starts_with("http://") && !u.starts_with("https://") {
        return Err("下载地址需以 http:// 或 https:// 开头".into());
    }
    Ok(u.to_string())
}

/// 分片区间：闭区间 [start, end]，`want` 为该分片应有的字节数。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PartRange {    pub start: u64,
    pub end: u64,
}

impl PartRange {
    pub fn want(&self) -> u64 {
        self.end - self.start + 1
    }
}

/// 把总长按 `conns` 条连接均分。末片可能短一些；conns 大于总长时按总长截断。
pub fn plan_parts(total: u64, conns: u16) -> Vec<PartRange> {
    if total == 0 {
        return Vec::new();
    }
    let n = conns.max(1) as u64;
    let base = total / n;
    let extra = total % n;
    let mut out = Vec::with_capacity(n as usize);
    let mut cursor = 0u64;
    for i in 0..n {
        let len = base + if i < extra { 1 } else { 0 };
        if len == 0 {
            continue;
        }
        out.push(PartRange { start: cursor, end: cursor + len - 1 });
        cursor += len;
    }
    out
}

/// 探测结果：文件总长、是否支持 Range、真实文件名。
#[derive(Debug, Clone)]
pub struct Probe {
    pub total: u64,
    pub ranges: bool,
    pub file_name: String,
}

fn file_name_from_disposition(value: &str) -> Option<String> {
    // Content-Disposition: attachment; filename*=UTF-8''qwen-image.gguf
    let star = value.split("filename*=").nth(1)?;
    let (_, tail) = star.split_once("''")?;
    let name = tail.split(';').next()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(
        percent_decode(name)
            .chars()
            .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
            .collect::<String>()
            .trim()
            .to_string(),
    )
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            match u8::from_str_radix(hex, 16) {
                Ok(byte) => {
                    out.push(byte);
                    i += 3;
                    continue;
                }
                Err(_) => {}
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn file_name_from_url(url: &str) -> String {
    // 先去掉 query/fragment，再去掉 scheme 与主机段——剩下的最后一段路径才是文件名。
    // 少了剥主机这步，"https://a.com/" 会把域名当成文件名。
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let after_scheme = without_scheme_split(without_query);
    let path = match after_scheme.find('/') {
        Some(index) => &after_scheme[index..],
        None => "",
    };
    let last = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or("");
    let name = percent_decode(last);
    let name = name
        .chars()
        .filter(|c| !matches!(c, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect::<String>();
    if name.trim().is_empty() {
        "download.bin".to_string()
    } else {
        name
    }
}

fn without_scheme_split(url: &str) -> &str {
    match url.split_once("://") {
        Some((_, rest)) => rest,
        None => url,
    }
}

/// 响应是不是一张网页而不是文件。
///
/// 必须判：HuggingFace 的 `/blob/` 地址（用户从浏览器地址栏复制的就是它）返回的是
/// **HTML 预览页**，HTTP 200、可能还带 Content-Length。只看状态码和长度的话，
/// 这一页 HTML 会被当成"不支持 Range 的文件"整页下下来，最后得到一个几百 KB 的
/// 假 safetensors——比直接报错难查得多。
fn is_html(headers: &reqwest::header::HeaderMap) -> bool {
    headers
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| {
            let lower = v.to_ascii_lowercase();
            lower.starts_with("text/html") || lower.contains("application/xhtml")
        })
        .unwrap_or(false)
}

fn html_page_hint(url: &str) -> String {
    // HuggingFace 系的地址能直接给出可用的改法，别只丢一句"下不了"
    if without_scheme_split(url).contains("/blob/") {
        return "这个地址返回的是网页而不是文件：HuggingFace 的 /blob/ 是预览页，\
                请把 /blob/ 换成 /resolve/（或在文件页点「下载」复制真实地址）"
            .to_string();
    }
    if without_scheme_split(url).contains("/tree/") {
        return "这个地址是一个目录列表而不是文件，请粘贴具体文件的下载地址".to_string();
    }
    "服务器返回的是网页（Content-Type: text/html）而不是文件，请确认地址指向文件本体而不是预览页".to_string()
}

/// 探测文件大小与 Range 支持。
///
/// 先 HEAD；HEAD 不可靠或没给 Content-Length 时退回 `Range: bytes=0-0`，
/// 从 `Content-Range: bytes 0-0/12345` 里取总长。这一步是分片的前提——
/// 拿不到总长就没法切区间，只能退化成单流，所以两种方式都试。
pub async fn probe(client: &reqwest::Client, url: &str) -> Result<Probe, String> {
    let mut file_name = String::new();

    if let Ok(resp) = client.head(url).send().await {
        if resp.status().is_success() {
            if is_html(resp.headers()) {
                return Err(html_page_hint(url));
            }
            if let Some(cd) = resp.headers().get(reqwest::header::CONTENT_DISPOSITION) {
                file_name = file_name_from_disposition(cd.to_str().unwrap_or("")).unwrap_or_default();
            }
            let supports_ranges = resp
                .headers()
                .get(reqwest::header::ACCEPT_RANGES)
                .and_then(|v| v.to_str().ok())
                .map(|v| v.to_ascii_lowercase().contains("bytes"))
                .unwrap_or(false);
            if let Some(len) = resp.content_length() {
                if len > 0 {
                    return finish_probe(len, supports_ranges, file_name, url);
                }
            }
        }
    }

    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, "bytes=0-0")
        .send()
        .await
        .map_err(|e| format!("探测文件大小失败：{e}"))?;
    if is_html(resp.headers()) {
        return Err(html_page_hint(url));
    }
    if let Some(cd) = resp.headers().get(reqwest::header::CONTENT_DISPOSITION) {
        if file_name.is_empty() {
            file_name = file_name_from_disposition(cd.to_str().unwrap_or("")).unwrap_or_default();
        }
    }
    // 服务端回了 Content-Range，说明 Range 被受理：既拿到了总长，也确认支持分片。
    if let Some(cr) = resp.headers().get(reqwest::header::CONTENT_RANGE) {
        let text = cr.to_str().unwrap_or("").to_string();
        if let Some(total) = text.rsplit('/').next().and_then(|s| s.trim().parse::<u64>().ok()) {
            if total > 0 {
                return finish_probe(total, true, file_name, url);
            }
        }
    }
    if resp.status().is_success() {
        if let Some(len) = resp.content_length() {
            if len > 0 {
                // 只能整文件下（且拿到的可能已经是完整响应体），不算支持 Range。
                return finish_probe(len, false, file_name, url);
            }
        }
    }
    Err("无法确定文件大小：服务器既未返回 Content-Length，也不支持 Range 请求".into())
}

fn finish_probe(total: u64, ranges: bool, file_name: String, url: &str) -> Result<Probe, String> {
    if total > DOWNLOAD_MAX_BYTES {
        return Err(format!(
            "文件大小 {:.1} GB 超过 {} GB 上限，请确认地址是否正确",
            total as f64 / 1e9,
            DOWNLOAD_MAX_BYTES / 1024 / 1024 / 1024
        ));
    }
    let name = if file_name.trim().is_empty() { file_name_from_url(url) } else { file_name };
    Ok(Probe { total, ranges, file_name: name })
}

/// 分片目录：`<目标文件名>.parts`。放在目标文件旁边，删目标文件不会连带丢进度。
fn parts_dir(dest: &Path) -> PathBuf {
    let mut name = dest.as_os_str().to_os_string();
    name.push(".parts");
    PathBuf::from(name)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct PartMeta {
    url: String,
    total: u64,
    conns: u16,
}

fn read_part_meta(dir: &Path) -> Option<PartMeta> {
    let raw = std::fs::read_to_string(dir.join("meta.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some(PartMeta {
        url: value.get("url")?.as_str()?.to_string(),
        total: value.get("total")?.as_u64()?,
        conns: value.get("conns")?.as_u64()? as u16,
    })
}

fn write_part_meta(dir: &Path, url: &str, total: u64, conns: u16) -> std::io::Result<()> {
    let value = serde_json::json!({ "url": url, "total": total, "conns": conns });
    std::fs::write(dir.join("meta.json"), serde_json::to_string_pretty(&value).unwrap_or_default())
}

async fn file_len(path: &Path) -> u64 {
    tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0)
}

struct TaskEntry {
    cancel: Arc<AtomicBool>,
    handle: tauri::async_runtime::JoinHandle<()>,
}

fn registry() -> &'static Mutex<HashMap<String, TaskEntry>> {
    static REG: OnceLock<Mutex<HashMap<String, TaskEntry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn emit_progress(app: &tauri::AppHandle, id: &str, downloaded: u64, total: u64, speed: u64, conns: u16, status: &str) {
    let _ = app.emit(
        EVENT_PROGRESS,
        serde_json::json!({
            "id": id,
            "downloaded": downloaded,
            "total": total,
            "speed": speed,
            "conns": conns,
            "status": status,
        }),
    );
}

/// 拉取一个字节区间并追加写盘。返回 Err 表示本次尝试失败（调用方决定是否重连）。
///
/// 关键点：请求区间 [from, end] 后要确认服务端真的只给了这段。
/// 服务端若忽略 Range 回 200 并把整文件发过来，追加进去会让分片凭空多出一整份文件，
/// 而总长校验只在最后才兜底——那时已经白下了几十 GB。所以这里当场拒绝。
async fn fetch_range(
    client: &reqwest::Client,
    url: &str,
    path: &Path,
    from: u64,
    end: u64,
    progress: &Arc<AtomicU64>,
    cancel: &Arc<AtomicBool>,
) -> Result<(), String> {
    let range = format!("{from}-{end}");
    let resp = client
        .get(url)
        .header(reqwest::header::RANGE, &range)
        .send()
        .await
        .map_err(|e| format!("连接失败：{e}"))?;
    let status = resp.status();
    if status == reqwest::StatusCode::PARTIAL_CONTENT {
        // 正常路径。
    } else if status.is_success() {
        if from > 0 {
            return Err("服务器忽略了 Range 请求（续传被拒绝），已中止以免写入重复数据".into());
        }
        // from == 0 且 200：整文件就是这一段，允许。
    } else {
        return Err(format!("HTTP {status}"));
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .await
        .map_err(|e| format!("打开分片文件失败：{e}"))?;

    let mut stream = resp.bytes_stream();
    let mut last_progress = Instant::now();
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        tokio::select! {
            item = stream.next() => match item {
                Some(Ok(bytes)) => {
                    if bytes.is_empty() {
                        continue;
                    }
                    file.write_all(&bytes).await.map_err(|e| format!("写入分片失败：{e}"))?;
                    progress.fetch_add(bytes.len() as u64, Ordering::Relaxed);
                    last_progress = Instant::now();
                }
                Some(Err(e)) => return Err(format!("传输中断：{e}")),
                None => return Ok(()),
            },
            _ = tokio::time::sleep(STALL_TICK) => {
                if last_progress.elapsed() > STALL_TIMEOUT {
                    return Err(format!("连接停滞超过 {} 秒，已断开准备重连", STALL_TIMEOUT.as_secs()));
                }
            }
        }
    }
}

/// 一个分片的完整生命周期：反复检查已下载量、从新偏移重连，直到补齐或放弃。
async fn run_part(
    client: reqwest::Client,
    url: String,
    path: PathBuf,
    range: PartRange,
    progress: Arc<AtomicU64>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    for _ in 0..MAX_RETRIES {
        if cancel.load(Ordering::Relaxed) {
            return Err("已取消".into());
        }
        let have = file_len(&path).await;
        if have >= range.want() {
            return Ok(());
        }
        let from = range.start + have;
        let err = match fetch_range(&client, &url, &path, from, range.end, &progress, &cancel).await {
            Ok(()) => {
                let now = file_len(&path).await;
                if now >= range.want() {
                    return Ok(());
                }
                format!("分片 {from}-{} 少收了 {} 字节", range.end, range.want() - now)
            }
            Err(e) => e,
        };
        eprintln!("分片 {} 重连：{err}", path.display());
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
    Err(format!("分片 {}–{} 重连 {} 次仍未完成", range.start, range.end, MAX_RETRIES))
}

/// 把所有分片按顺序拼成目标文件，边拼边清分片——中途被打断时剩余分片仍在，可续。
async fn merge_parts(dir: &Path, dest: &Path, ranges: &[PartRange]) -> Result<u64, String> {
    let mut out = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("创建目标文件失败：{e}"))?;
    let mut written = 0u64;
    for index in 0..ranges.len() {
        let part = dir.join(format!("p{index:02}.bin"));
        let mut src = tokio::fs::File::open(&part)
            .await
            .map_err(|e| format!("打开分片 {index} 失败：{e}"))?;
        let mut buf = vec![0u8; 1 << 20];
        loop {
            let n = src.read(&mut buf).await.map_err(|e| format!("读取分片失败：{e}"))?;
            if n == 0 {
                break;
            }
            out.write_all(&buf[..n]).await.map_err(|e| format!("写入目标文件失败：{e}"))?;
            written += n as u64;
        }
        let _ = tokio::fs::remove_file(&part).await;
    }
    out.flush().await.map_err(|e| format!("刷新目标文件失败：{e}"))?;
    out.sync_all().await.ok();
    let _ = std::fs::remove_dir_all(dir);
    Ok(written)
}

fn setup_parts(dir: &Path, url: &str, total: u64, conns: u16, ranges: &[PartRange]) -> bool {
    // 只有 (url, total, conns) 三者全同才能复用旧分片：任一不同都意味着区间布局变了，
    // 混着拼会得到错乱的文件，这时宁可重下。
    //
    // 这里**不能**去数目录里已有几个分片文件再要求等于 ranges.len()——续传时后续分片
    // 还没建出来（只有下载到的那几个存在），一数就对不上，会把已下好的部分全清掉。
    let reusable = read_part_meta(dir)
        .map(|m| m.total == total && m.conns == conns && m.url == url)
        .unwrap_or(false);
    if !reusable {
        let _ = std::fs::remove_dir_all(dir);
    }
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let _ = write_part_meta(dir, url, total, conns);
    for (index, range) in ranges.iter().enumerate() {
        let part = dir.join(format!("p{index:02}.bin"));
        // 续传：已有长度不能超过分片应得长度（超过说明布局对不上，已在上面整目录重来）。
        if let Ok(meta) = std::fs::metadata(&part) {
            if meta.len() > range.want() {
                let _ = std::fs::remove_file(&part);
            }
        }
    }
    true
}

fn remove_task(id: &str) {
    if let Ok(mut map) = registry().lock() {
        if let Some(entry) = map.remove(id) {
            entry.handle.abort();
        }
    }
}

fn finish(app: &tauri::AppHandle, id: &str, payload: serde_json::Value) {
    remove_task(id);
    let _ = app.emit(EVENT_FINISHED, payload);
}

async fn run_download(
    app: tauri::AppHandle,
    id: String,
    url: String,
    dest: PathBuf,
    conns: u16,
    cancel: Arc<AtomicBool>,
) {
    let client = match http_client() {
        Ok(client) => client,
        Err(err) => {
            finish(&app, &id, serde_json::json!({ "id": id, "ok": false, "error": err }));
            return;
        }
    };
    let probe = match probe(&client, &url).await {
        Ok(probe) => probe,
        Err(err) => {
            finish(&app, &id, serde_json::json!({ "id": id, "ok": false, "error": err }));
            return;
        }
    };
    let total = probe.total;
    // 不支持 Range 就只能单流直写目标文件。
    let conns = if probe.ranges { conns } else { 1 };
    let ranges = plan_parts(total, conns);
    let dir = parts_dir(&dest);

    if ranges.len() > 1 {
        if !setup_parts(&dir, &url, total, conns, &ranges) {
            finish(
                &app,
                &id,
                serde_json::json!({ "id": id, "ok": false, "error": "无法创建分片目录，请检查目标路径是否可写".to_string() }),
            );
            return;
        }
        // 已完成字节从分片现状起算，进度条一上来就是真实续传量而不是 0。
        let mut resumed = 0u64;
        for (index, range) in ranges.iter().enumerate() {
            resumed += file_len(&dir.join(format!("p{index:02}.bin"))).await.min(range.want());
        }
        let progress = Arc::new(AtomicU64::new(resumed));
        let reporter = {
            let app = app.clone();
            let id = id.clone();
            let progress = progress.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                let mut last = 0u64;
                while !cancel.load(Ordering::Relaxed) {
                    tokio::time::sleep(PROGRESS_INTERVAL).await;
                    let now = progress.load(Ordering::Relaxed);
                    let speed = now.saturating_sub(last) * 1000 / PROGRESS_INTERVAL.as_millis() as u64;
                    last = now;
                    emit_progress(&app, &id, now, total, speed, conns, "running");
                }
            })
        };

        let mut handles = Vec::with_capacity(ranges.len());
        for (index, range) in ranges.iter().enumerate() {
            let part = dir.join(format!("p{index:02}.bin"));
            handles.push(tokio::spawn(run_part(
                client.clone(),
                url.clone(),
                part,
                *range,
                progress.clone(),
                cancel.clone(),
            )));
        }
        let mut failed: Option<String> = None;
        for handle in handles {
            match handle.await {
                Ok(Ok(())) => {}
                Ok(Err(err)) => {
                    if err != "已取消" && failed.is_none() {
                        failed = Some(err);
                    }
                }
                Err(e) => {
                    if failed.is_none() {
                        failed = Some(format!("下载任务异常：{e}"));
                    }
                }
            }
        }
        cancel.store(true, Ordering::Relaxed);
        let _ = reporter.await;

        if cancel.load(Ordering::Relaxed) {
            finish(&app, &id, serde_json::json!({ "id": id, "ok": false, "canceled": true }));
            return;
        }
        if let Some(err) = failed {
            finish(&app, &id, serde_json::json!({ "id": id, "ok": false, "error": err, "resumable": true }));
            return;
        }
        match merge_parts(&dir, &dest, &ranges).await {
            Ok(written) => {
                let _ = total;
                finish(
                    &app,
                    &id,
                    serde_json::json!({ "id": id, "ok": true, "downloaded": written, "total": total }),
                );
            }
            Err(err) => {
                finish(&app, &id, serde_json::json!({ "id": id, "ok": false, "error": err, "resumable": true }));
            }
        }
        return;
    }

    // 单流：直接写目标文件（没有分片，也就无所谓续传）
    let part = dir.join("p00.bin");
    let _ = std::fs::remove_file(&part);
    if std::fs::create_dir_all(&dir).is_err() {
        finish(
            &app,
            &id,
            serde_json::json!({ "id": id, "ok": false, "error": "无法创建临时目录，请检查目标路径是否可写".to_string() }),
        );
        return;
    }
    let progress = Arc::new(AtomicU64::new(0));
    let reporter = {
        let app = app.clone();
        let id = id.clone();
        let progress = progress.clone();
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let mut last = 0u64;
            while !cancel.load(Ordering::Relaxed) {
                tokio::time::sleep(PROGRESS_INTERVAL).await;
                let now = progress.load(Ordering::Relaxed);
                let speed = now.saturating_sub(last) * 1000 / PROGRESS_INTERVAL.as_millis() as u64;
                last = now;
                emit_progress(&app, &id, now, total, speed, 1, "running");
            }
        })
    };
    let result = run_part(client.clone(), url, part, ranges[0], progress.clone(), cancel.clone()).await;
    cancel.store(true, Ordering::Relaxed);
    let _ = reporter.await;
    if cancel.load(Ordering::Relaxed) {
        finish(&app, &id, serde_json::json!({ "id": id, "ok": false, "canceled": true }));
        return;
    }
    let merged = match result {
        Ok(()) => merge_parts(&dir, &dest, &ranges).await,
        Err(err) => Err(err),
    };
    match merged {
        Ok(written) => {
            let _ = std::fs::remove_dir_all(&dir);
            finish(
                &app,
                &id,
                serde_json::json!({ "id": id, "ok": true, "downloaded": written, "total": total }),
            );
        }
        Err(err) => {
            let _ = std::fs::remove_dir_all(&dir);
            finish(&app, &id, serde_json::json!({ "id": id, "ok": false, "error": err }));
        }
    }
}

/// 探测下载地址：拿到文件名、总大小、是否可分片。UI 用它在开始前就显示体积。
#[tauri::command]
pub async fn downloader_probe(url: String) -> Result<serde_json::Value, String> {
    let url = validate_url(&url)?;
    let client = http_client()?;
    let probe = probe(&client, &url).await?;
    Ok(serde_json::json!({
        "fileName": probe.file_name,
        "total": probe.total,
        "ranges": probe.ranges,
    }))
}

/// 开始（或续传）一个下载。立即返回，进度经 `downloader:progress` 事件推送。
#[tauri::command]
pub async fn downloader_start(
    app: tauri::AppHandle,
    id: String,
    url: String,
    dest: String,
    conns: Option<u16>,
) -> Result<(), String> {
    let id = id.trim().to_string();
    if id.is_empty() {
        return Err("缺少下载任务标识".into());
    }
    let url = validate_url(&url)?;
    let dest = dest.trim().to_string();
    if dest.is_empty() {
        return Err("请选择保存位置".into());
    }
    let dest = PathBuf::from(dest);
    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err("保存目录不存在，请先创建".into());
        }
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("无法创建保存目录：{e}"))?;
    }
    // 同一 id 重复 start：先取消旧的，避免两个任务写同一个分片目录。
    remove_task(&id);

    let conns = clamp_conns(conns);
    let cancel = Arc::new(AtomicBool::new(false));
    let handle = tauri::async_runtime::spawn(run_download(
        app.clone(),
        id.clone(),
        url,
        dest,
        conns,
        cancel.clone(),
    ));
    if let Ok(mut map) = registry().lock() {
        map.insert(id, TaskEntry { cancel, handle });
    }
    Ok(())
}

/// 取消下载。分片保留在原处，下次 start 会从断点继续。
#[tauri::command]
pub fn downloader_cancel(id: String) -> Result<(), String> {
    if let Ok(map) = registry().lock() {
        if let Some(entry) = map.get(&id) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }
    remove_task(&id);
    Ok(())
}

/// 删除任务残留的分片目录（用户不想续传时用）。
#[tauri::command]
pub fn downloader_discard(dest: String) -> Result<(), String> {
    let dest = PathBuf::from(dest.trim());
    if dest.as_os_str().is_empty() {
        return Err("缺少文件路径".into());
    }
    let dir = parts_dir(&dest);
    std::fs::remove_dir_all(&dir).map_err(|e| format!("清理分片失败：{e}"))
}

/// 读取断点信息：已下载字节数与分片数，用于「继续」按钮展示已下多少。
#[tauri::command]
pub fn downloader_progress_of(dest: String) -> Result<serde_json::Value, String> {
    let dest = PathBuf::from(dest.trim());
    let dir = parts_dir(&dest);
    let meta = read_part_meta(&dir);
    let mut downloaded = 0u64;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with('p') && name.ends_with(".bin") {
                downloaded += entry.metadata().map(|m| m.len()).unwrap_or(0);
            }
        }
    }
    let resumable = meta.is_some() && downloaded > 0;
    let total = meta.map(|m| m.total).unwrap_or(0);
    Ok(serde_json::json!({
        "downloaded": downloaded,
        "total": total,
        "resumable": resumable,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_parts_covers_exactly() {
        let parts = plan_parts(1000, 8);
        assert_eq!(parts.len(), 8);
        assert_eq!(parts[0], PartRange { start: 0, end: 124 });
        assert_eq!(parts[7], PartRange { start: 875, end: 999 });
        let sum: u64 = parts.iter().map(|p| p.want()).sum();
        assert_eq!(sum, 1000);
        // 区间必须首尾相接，中间不能有缝或重叠
        for pair in parts.windows(2) {
            assert_eq!(pair[0].end + 1, pair[1].start);
        }
    }

    #[test]
    fn plan_parts_handles_remainder_and_tiny_files() {
        // 不能整除：前 3 片各多 1 字节
        let parts = plan_parts(10, 3);
        assert_eq!(parts.len(), 3);
        assert_eq!(parts.iter().map(|p| p.want()).sum::<u64>(), 10);
        // 线程数多于字节数：不该出现长度为 0 的分片
        let parts = plan_parts(2, 8);
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|p| p.want() > 0));
        assert_eq!(parts.iter().map(|p| p.want()).sum::<u64>(), 2);
        assert!(plan_parts(0, 4).is_empty());
    }

    #[test]
    fn clamp_conns_stays_in_range() {
        assert_eq!(clamp_conns(None), 8);
        assert_eq!(clamp_conns(Some(0)), 1);
        assert_eq!(clamp_conns(Some(999)), 32);
    }

    #[test]
    fn file_name_from_url_strips_query_and_unsafe_chars() {
        assert_eq!(file_name_from_url("https://a.com/x/y/model.safetensors?download=1"), "model.safetensors");
        assert_eq!(file_name_from_url("https://a.com/x/y/%E6%A8%A1%E5%9E%8B.gguf"), "模型.gguf");
        assert_eq!(file_name_from_url("https://a.com/"), "download.bin");
        assert_eq!(file_name_from_url("https://a.com/a/b/"), "b");
    }

    #[test]
    fn file_name_from_disposition_reads_rfc5987() {
        let cd = "attachment; filename*=UTF-8''qwen-image-2.1-UC-Q4_K_M.gguf";
        assert_eq!(file_name_from_disposition(cd).as_deref(), Some("qwen-image-2.1-UC-Q4_K_M.gguf"));
        assert_eq!(file_name_from_disposition("attachment; filename=\"a/b.gguf\""), None);
    }

    #[test]
    fn probe_rejects_oversized_file() {
        let err = finish_probe(DOWNLOAD_MAX_BYTES + 1, true, String::new(), "https://a.com/x").unwrap_err();
        assert!(err.contains("超过"), "实际：{err}");
        assert!(finish_probe(1024, true, String::new(), "https://a.com/x").is_ok());
    }

    #[test]
    fn probe_falls_back_to_url_when_disposition_absent() {
        let probe = finish_probe(10, true, "  ".into(), "https://a.com/dir/f.bin").unwrap();
        assert_eq!(probe.file_name, "f.bin");
        assert!(probe.ranges);
    }

    #[test]
    fn is_html_catches_preview_pages() {
        use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
        let mut headers = HeaderMap::new();
        // 缺 Content-Type 时不能误判成网页（不少小服务器不发这个头）
        assert!(!is_html(&headers));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/octet-stream"));
        assert!(!is_html(&headers));
        // HF 的 /blob/ 预览页：200 + text/html + Content-Length，是最危险的一种
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("text/html; charset=utf-8"));
        assert!(is_html(&headers));
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("TEXT/HTML"));
        assert!(is_html(&headers));
    }

    #[test]
    fn html_page_hint_names_the_actual_fix() {
        let hint = html_page_hint("https://hf-mirror.com/a/b/blob/main/f.safetensors");
        assert!(hint.contains("/resolve/"), "实际：{hint}");
        let tree = html_page_hint("https://huggingface.co/a/b/tree/main");
        assert!(tree.contains("目录"), "实际：{tree}");
        let other = html_page_hint("https://example.com/page");
        assert!(other.contains("text/html"), "实际：{other}");
    }

    #[test]
    fn validate_url_requires_http_scheme() {
        assert!(validate_url("https://a.com/x").is_ok());
        assert!(validate_url("http://a.com/x").is_ok());
        assert!(validate_url("").is_err());
        assert!(validate_url("ftp://a.com/x").is_err());
        assert!(validate_url("  https://a.com/x  ").is_ok());
    }

    #[test]
    fn part_meta_mismatch_forces_restart() {
        let dir = std::env::temp_dir().join(format!("tc-parts-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let ranges = plan_parts(100, 4);
        assert!(setup_parts(&dir, "https://a.com/f", 100, 4, &ranges));
        // 写满第 0 片，模拟已下 25 字节
        std::fs::write(dir.join("p00.bin"), vec![0u8; 25]).unwrap();
        // 同样布局：分片应被保留
        assert!(setup_parts(&dir, "https://a.com/f", 100, 4, &ranges));
        assert_eq!(std::fs::metadata(dir.join("p00.bin")).unwrap().len(), 25);
        // 换线程数：布局变了必须清空
        let ranges2 = plan_parts(100, 8);
        assert!(setup_parts(&dir, "https://a.com/f", 100, 8, &ranges2));
        assert!(!dir.join("p00.bin").exists());
        // 只建了部分分片时也必须视为可复用（续传的常态）
        let ranges3 = plan_parts(100, 4);
        assert!(setup_parts(&dir, "https://a.com/f", 100, 4, &ranges3));
        std::fs::write(dir.join("p01.bin"), vec![0u8; 10]).unwrap();
        assert!(setup_parts(&dir, "https://a.com/f", 100, 4, &ranges3));
        assert_eq!(std::fs::metadata(dir.join("p01.bin")).unwrap().len(), 10);
        // 但换源地址必须重来
        assert!(setup_parts(&dir, "https://a.com/other", 100, 4, &ranges3));
        assert!(!dir.join("p01.bin").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn oversized_part_is_discarded_on_resume() {
        let dir = std::env::temp_dir().join(format!("tc-parts-over-{}_{}", std::process::id(), line!()));
        let _ = std::fs::remove_dir_all(&dir);
        let ranges = plan_parts(100, 4);
        assert!(setup_parts(&dir, "https://a.com/f", 100, 4, &ranges));
        // 模拟上次异常留下超长分片（应被丢弃重建，而不是拼出坏文件）
        std::fs::write(dir.join("p00.bin"), vec![0u8; 999]).unwrap();
        assert!(setup_parts(&dir, "https://a.com/f", 100, 4, &ranges));
        assert!(!dir.join("p00.bin").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
