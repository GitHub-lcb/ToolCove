// WorkBuddy **CN** 本地登录态读取：和 Qoder CN / TRAE CN 同一套思路——运行时读当场要用的
// 那一份，不让用户抓包抄一个会轮换的 token。
//
// 但它比另两个多一道坎，这道坎决定了整个模块的形状：
// WorkBuddy 5.6 起把 `auth.accessToken` **静态加密**（`{$wbEncrypted:1, envelope}`，AES-256-GCM），
// 而解开它的主密钥不落盘——只存在于 WorkBuddy 自己那份 Electron 的私有 binding 里。
// 所以「读一个文件」不够，必须**借它自己的可执行文件当纯 Node 跑一次**，把密钥种子取出来。
// 这一步是必须的：不这么做就只能让用户手工抄 token，而 token 会轮换，
// 于是一个标称「无人值守」的签到工具退化成每天要人喂一次。
//
// 关于越权边界，本模块刻意守住三条：
// 1. 只读：不刷新、不回写、不落盘、不进日志。token 只在内存里活到请求发完。
// 2. 只借它自己的解密能力，不复制密钥材料到任何持久位置。
// 3. 换机器必然解不开（keyId 由本机安装实例派生），所以这不是一个可搬运的窃取通道。
//
// 定位可执行文件：环境变量 → 默认安装位置 → 卸载注册表。WorkBuddy 允许自定义安装目录，
// 只认默认路径会把「装在 D 盘」的用户误报成「没装」。

use base64::Engine;
use serde::Serialize;
use sha2::Digest;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

// 凭据文件正常只有几 KB；读到异常大的东西说明路径不对，不能继续解。
const MAX_BLOB: u64 = 1 << 20;
// 借用 WorkBuddy 的 Electron 跑这条脚本，它会把静态密钥种子打到 stdout。
// 脚本是固定的、不含任何用户输入，所以不存在「拼命令」风险。
const HELPER_SCRIPT: &str =
    "process.stdout.write(String(process._linkedBinding(\"electron_browser_workbuddy_storage\").loggerGet()))";
const ENV_ELECTRON_BIN: &str = "WORKBUDDY_ELECTRON_BIN";
// 子进程只输出几百字节，正常瞬间返回；给足余量但仍然设上限，避免它卡住整轮签到。
const HELPER_TIMEOUT: Duration = Duration::from_secs(15);

// 凭据相对路径。CN 版与 WorkBuddy AI（国际版）共用 CodeBuddyExtension 目录，
// 只靠文件名区分；本模块只认 CN 那一个，不做「扫到哪个算哪个」。
const AUTH_RELATIVE: [&str; 5] = ["CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkBuddyAuth {
    /// 裸 JWT，调用方自己拼 `Bearer `。
    pub token: String,
    pub uid: String,
    /// 服务端下发的域（实测 copilot.tencent.com）。只用于判断区域，不是请求目标。
    pub domain: String,
    pub enterprise_id: String,
    /// 毫秒时间戳；0 表示没读到。
    pub expires_at: i64,
    /// 命中的凭据文件位置，排查时用来区分 Local / Roaming。
    pub source: String,
}

// ---------------- 信封解密 ----------------

struct Envelope {
    suite: u32,
    key_id: String,
    nonce: Vec<u8>,
    auth_tag: Vec<u8>,
    ciphertext: Vec<u8>,
}

/// 严格 base64：必须能原样编码回去，长度也必须对得上。
/// 不做这层检查的话，截断的 base64 会被宽容解码成一段短字节，然后在 GCM 校验那里
/// 报成一个和真实原因（文件坏了）无关的错。
fn parse_b64(value: &str, exact_len: Option<usize>) -> Option<Vec<u8>> {
    if value.is_empty() {
        return None;
    }
    let decoded = base64::engine::general_purpose::STANDARD.decode(value).ok()?;
    if decoded.is_empty() {
        return None;
    }
    let reencoded = base64::engine::general_purpose::STANDARD.encode(&decoded);
    if reencoded.trim_end_matches('=') != value.trim_end_matches('=') {
        return None;
    }
    match exact_len {
        Some(n) if decoded.len() != n => None,
        _ => Some(decoded),
    }
}

/// 解出 `{$wbEncrypted:1, envelope}` 里那层 base64 JSON 信封。
///
/// 只接受 suite 1（app 的 field 框架）：future 的 suite 属于别的文档类型，
/// 猜格式不是这条链路该做的事——解不开就如实报错，别去试别的框架。
fn parse_envelope(wrapped: &serde_json::Value) -> Option<Envelope> {
    // 明文 token（5.6 以前）不带 $wbEncrypted，调用方会先判掉；这里只处理信封。
    let inner_b64 = wrapped.get("envelope")?.as_str()?;
    let raw = base64::engine::general_purpose::STANDARD.decode(inner_b64.trim()).ok()?;
    let parts: serde_json::Value = serde_json::from_slice(&raw).ok()?;

    let suite = parts.get("suite")?.as_u64()?;
    if suite != 1 {
        return None;
    }
    let key_id = parts.get("keyId")?.as_str()?.to_string();
    // keyId 恒为 16 个十六进制字符；形状不对说明这不是凭据信封。
    if key_id.len() != 16 || !key_id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    let nonce = parse_b64(parts.get("nonce")?.as_str()?, Some(12))?;
    let auth_tag = parse_b64(parts.get("authTag")?.as_str()?, Some(16))?;
    let ciphertext = parse_b64(parts.get("ciphertext")?.as_str()?, None)?;
    Some(Envelope { suite: suite as u32, key_id, nonce, auth_tag, ciphertext })
}

/// app 自己的 `buildAuthenticatedContextAad` 的逐字节转写。
/// AAD 不匹配时 GCM 一定解不开，所以这几段常量、顺序、长度前缀一个都不能错。
fn build_aad(key_id: &str, suite: u32) -> Vec<u8> {
    fn length_prefixed(out: &mut Vec<u8>, value: &str) {
        let bytes = value.as_bytes();
        out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
        out.extend_from_slice(bytes);
    }
    let mut out = Vec::new();
    out.extend_from_slice(b"WB-AAD\0");
    out.push(1);
    length_prefixed(&mut out, "WBEV1");
    length_prefixed(&mut out, "sym-v1");
    out.extend_from_slice(&suite.to_be_bytes());
    length_prefixed(&mut out, key_id);
    out.push(2);
    out.push(0);
    out.push(0);
    out
}

/// AES-256-GCM 解密。密钥由 `atRestSecretKey` 派生（见 `derive_protector_key`）。
fn open_envelope(key: &[u8], envelope: &Envelope) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit, Payload};
    use aes_gcm::{Aes256Gcm, Nonce};
    if key.len() != 32 {
        return Err(format!("保护密钥长度应为 32 字节，实际 {}", key.len()));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "保护密钥长度非法".to_string())?;
    let aad = build_aad(&envelope.key_id, envelope.suite);
    // 信封把 tag 单独存一个字段，而 aes-gcm 的 `decrypt` 要求 `msg` 是
    // **密文 ‖ tag**。少拼这一段不会报参数错误，只会表现为「解密失败」，
    // 与「密钥不对」 indistinguishable——所以这里必须显式拼上。
    let mut sealed = Vec::with_capacity(envelope.ciphertext.len() + envelope.auth_tag.len());
    sealed.extend_from_slice(&envelope.ciphertext);
    sealed.extend_from_slice(&envelope.auth_tag);
    let plain = cipher
        .decrypt(Nonce::from_slice(&envelope.nonce), Payload { msg: &sealed, aad: &aad })
        .map_err(|_| {
            format!(
                "凭据解密失败（信封 keyId {}；通常意味着这份凭据由另一个 WorkBuddy 安装实例或另一个 Windows 用户加密的）",
                envelope.key_id
            )
        })?;
    String::from_utf8(plain).map_err(|_| "解密结果不是 UTF-8".to_string())
}

/// 保护密钥 = sha256(**base64 字符串本身**的 UTF-8 字节)，不是解码后的 32 字节。
/// 这一点极易写错，而且错了只表现为「GCM 校验失败」，看不出是派生方式的问题。
fn derive_protector_key(secret_b64: &str) -> Vec<u8> {
    sha2::Sha256::digest(secret_b64.as_bytes()).to_vec()
}

// ---------------- 定位 WorkBuddy 可执行文件 ----------------

fn decode_console(bytes: &[u8]) -> String {
    // 控制台程序按 OEM 代码页输出，中文 Windows 上是 GBK。
    // 只关心路径（通常是 ASCII），但安装路径带中文时按 GBK 解才对得上。
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let (text, _, _) = encoding_rs::GBK.decode(bytes);
            text.into_owned()
        }
    }
}

/// 从卸载注册表里找 WorkBuddy 的安装位置。
///
/// 为什么必须做这件事：WorkBuddy 允许自定义安装目录（实测有装在 E:\...\apps\workbuddy 的），
/// 只探测默认路径会把这类用户误报成「没装 WorkBuddy」，而错误信息会把人引向
/// 「去装一个」这种完全错的方向。
#[cfg(windows)]
fn registry_bins() -> Vec<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    // CREATE_NO_WINDOW：reg.exe 会闪一个黑框，签到是后台任务，不该有窗口。
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const ROOTS: [&str; 3] = [
        r"HKLM\Software\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    let mut out = Vec::new();
    for root in ROOTS {
        let output = match Command::new("reg.exe")
            .args(["query", root, "/s"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            Ok(o) if o.status.success() => o,
            // 某个根不存在是正常的（HKCU 与 HKLM 的键不一定都在），跳过即可。
            _ => continue,
        };
        // reg query /s 的输出是「键头 + 缩进的 值名 类型 数据」分块，按块判断，
        // 避免把另一个产品（同样引用 WorkBuddy.exe）的记录也算进来。
        let text = decode_console(&output.stdout);
        let mut block_name = String::new();
        let mut block_icon = String::new();
        let flush = |name: &str, icon: &str, out: &mut Vec<PathBuf>| {
            if name.contains("WorkBuddy") && icon.to_ascii_lowercase().contains("workbuddy.exe") {
                out.push(PathBuf::from(icon));
            }
        };
        for line in text.lines() {
            if line.starts_with("HKEY") {
                flush(&block_name, &block_icon, &mut out);
                block_name.clear();
                block_icon.clear();
                continue;
            }
            let trimmed = line.trim_start();
            if let Some(rest) = trimmed.strip_prefix("DisplayName") {
                block_name = value_after_type(rest);
            } else if let Some(rest) = trimmed.strip_prefix("DisplayIcon") {
                block_icon = value_after_type(rest);
            }
        }
        flush(&block_name, &block_icon, &mut out);
    }
    out
}

/// 从 `    REG_SZ    E:\...\WorkBuddy.exe,0` 里取出路径部分。
/// DisplayIcon 的惯例是「路径,图标序号」，逗号后面那段必须丢掉。
#[cfg(windows)]
fn value_after_type(rest: &str) -> String {
    let text = match rest.find("REG_SZ") {
        Some(at) => &rest[at + "REG_SZ".len()..],
        None => rest,
    };
    let value = text.trim().trim_matches('"');
    let path = value.split(',').next().unwrap_or("").trim().trim_matches('"');
    path.to_string()
}

#[cfg(not(windows))]
fn registry_bins() -> Vec<PathBuf> {
    Vec::new()
}

/// 候选可执行文件，按可信度排序并去重；只返回真实存在的。
fn candidate_bins() -> Vec<PathBuf> {
    let mut raw: Vec<PathBuf> = Vec::new();
    // 1. 显式指定的优先：装在非常规位置、或装了多个版本时，这是唯一的确定手段。
    if let Some(value) = std::env::var_os(ENV_ELECTRON_BIN) {
        raw.push(PathBuf::from(value));
    }
    // 2. 默认安装位置。CN 版官方安装器落在 %LOCALAPPDATA%\Programs\WorkBuddy。
    for key in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Some(root) = std::env::var_os(key) {
            let root = PathBuf::from(root);
            raw.push(root.join("Programs").join("WorkBuddy").join("WorkBuddy.exe"));
            raw.push(root.join("WorkBuddy").join("WorkBuddy.exe"));
        }
    }
    // 3. 注册表：自定义安装目录只能从这里知道。
    raw.extend(registry_bins());

    let mut out: Vec<PathBuf> = Vec::new();
    for path in raw {
        if !path.is_file() {
            continue;
        }
        if out.iter().any(|seen| seen == &path) {
            continue;
        }
        out.push(path);
    }
    out
}

// ---------------- 借用 WorkBuddy 自己的解密能力 ----------------

/// 跑一次 `WorkBuddy.exe -e <helper>`，拿回静态密钥种子。
///
/// 这里刻意**不走 shell**：直接 spawn 可执行文件、参数以数组传入，脚本内容是常量。
/// 走 shell 拼字符串等于把命令注入面打开，而这条链路处理的是凭据。
fn read_at_rest_secret(bin: &Path) -> Result<String, String> {
    use std::process::{Command, Stdio};

    let mut command = Command::new(bin);
    command
        .arg("-e")
        .arg(HELPER_SCRIPT)
        // 这一条是全部关键：没有它启动的是完整 Electron 界面，而不是纯 Node。
        .env("ELECTRON_RUN_AS_NODE", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = command.spawn().map_err(|e| format!("启动 {} 失败: {e}", bin.display()))?;

    // 有上限地等：子进程若卡住（被杀软拦、被占用），签到不该一起卡死。
    let deadline = Instant::now() + HELPER_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("读取 WorkBuddy 静态密钥超时".to_string());
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(e) => return Err(format!("等待 WorkBuddy 子进程失败: {e}")),
        }
    }

    // 输出只有几百字节，远小于管道缓冲，所以可以安全地在 wait 之后统一读。
    let output = child.wait_with_output().map_err(|e| format!("读取 WorkBuddy 输出失败: {e}"))?;
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Err("WorkBuddy 没有返回静态密钥（它可能拒绝以 Node 模式运行）".to_string());
    }

    // 正常情况整段就是 JSON；万一前面混了别的输出，退一步从第一个 `{"version"` 开始截。
    let candidate = match text.find("{\"version\"") {
        Some(at) => &text[at..],
        None => text,
    };
    let parsed: serde_json::Value =
        serde_json::from_str(candidate).map_err(|_| "WorkBuddy 返回的静态密钥不是合法 JSON".to_string())?;
    if parsed.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err("WorkBuddy 静态密钥版本不受支持（只支持 version 1）".to_string());
    }
    let secret = parsed
        .get("atRestSecretKey")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "WorkBuddy 返回里没有 atRestSecretKey".to_string())?
        .to_string();
    // 形状校验照抄 app 自己的规则：规范 base64、解码后 32 字节、不全零。
    let decoded = parse_b64(&secret, Some(32)).ok_or_else(|| "atRestSecretKey 形状不对".to_string())?;
    if decoded.iter().all(|b| *b == 0) {
        return Err("atRestSecretKey 全零，拒绝使用".to_string());
    }
    Ok(secret)
}

// ---------------- 凭据文件 ----------------

fn local_app_data() -> Option<PathBuf> {
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
}

fn roaming_app_data() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

/// 凭据文件候选。新版写 Local，旧版写 Roaming，两个都要探——
/// 只探一个会把「已登录」读成「未登录」，而用户看到的是「登录态失效，请重新登录」。
fn candidate_auth_files() -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in [local_app_data(), roaming_app_data()].into_iter().flatten() {
        let path = AUTH_RELATIVE.iter().fold(root.clone(), |acc, seg| acc.join(seg));
        if path.is_file() && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// token 会直接进 HTTP 头，字符必须收口：一个 \r\n 就是一条注入出去的响应头。
fn is_safe_header_value(text: &str) -> bool {
    !text.is_empty() && text.len() <= 8192 && text.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
}

fn value_str(value: Option<&serde_json::Value>) -> String {
    value.and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// 从一份 auth 文档里取出 accessToken，必要时先解信封。
///
/// `open` 是「拿 keyId 换明文」的回调：只有真的遇到加密字段才会被调用，
/// 于是明文的老版本凭据不需要去启动 WorkBuddy。
fn extract_token<F>(document: &serde_json::Value, mut open: F) -> Result<(String, String), String>
where
    F: FnMut(&Envelope) -> Result<String, String>,
{
    // 文档有两种形态：插件式嵌套 {"auth":{...}}，以及扁平式。
    let auth = document.get("auth").filter(|v| v.is_object()).unwrap_or(document);

    let field = auth.get("accessToken").ok_or_else(|| "凭据里没有 accessToken 字段".to_string())?;
    if let Some(text) = field.as_str() {
        if !is_safe_header_value(text) {
            return Err("凭据里的 accessToken 形状不对".to_string());
        }
        return Ok((text.to_string(), "plaintext".to_string()));
    }
    let envelope = parse_envelope(field).ok_or_else(|| {
        "凭据里的 accessToken 既不是明文也不是可识别的加密信封（WorkBuddy 可能改用了新的加密方案）".to_string()
    })?;
    let plain = open(&envelope)?;
    if !is_safe_header_value(&plain) {
        return Err("解密出来的 accessToken 形状不对".to_string());
    }
    Ok((plain, "encrypted".to_string()))
}

fn read_json(path: &Path) -> Result<serde_json::Value, String> {
    let size = std::fs::metadata(path).map_err(|e| format!("读取凭据文件失败: {e}"))?.len();
    if size == 0 {
        return Err("凭据文件是空的（WorkBuddy 未登录）".to_string());
    }
    if size > MAX_BLOB {
        return Err("凭据文件异常偏大，拒绝解析".to_string());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("凭据不是 UTF-8 文本: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("凭据不是合法 JSON: {e}"))
}

#[tauri::command]
pub fn workbuddy_cn_auth_token() -> Result<WorkBuddyAuth, String> {
    #[cfg(not(windows))]
    {
        Err("读取 WorkBuddy 本地登录态仅在 Windows 桌面端支持".into())
    }
    #[cfg(windows)]
    {
        let files = candidate_auth_files();
        if files.is_empty() {
            return Err(
                "没有找到 WorkBuddy 的登录凭据（CodeBuddyExtension\\Data\\Public\\auth\\workbuddy-desktop.info）。请先安装并登录 WorkBuddy CN 桌面端。"
                    .into(),
            );
        }

        let mut last_error = String::new();
        for path in files {
            let attempt = (|| -> Result<WorkBuddyAuth, String> {
                let document = read_json(&path)?;

                // 密钥只在真的遇到信封时才去解析（要启动一次 WorkBuddy，不该白付这个代价），
                // 且在同一次调用内缓存：document 里可能有多个加密字段。
                let mut cached: Option<Vec<u8>> = None;
                let mut open = |envelope: &Envelope| -> Result<String, String> {
                    if cached.is_none() {
                        let bins = candidate_bins();
                        if bins.is_empty() {
                            return Err(format!(
                                "WorkBuddy 的登录态是加密的，但没找到 WorkBuddy 可执行文件。若它装在非默认目录，请把 {ENV_ELECTRON_BIN} 指向 WorkBuddy.exe。"
                            ));
                        }
                        let mut bin_error = String::new();
                        for bin in bins {
                            match read_at_rest_secret(&bin) {
                                Ok(secret) => {
                                    cached = Some(derive_protector_key(&secret));
                                    break;
                                }
                                Err(e) => bin_error = format!("{}: {e}", bin.display()),
                            }
                        }
                        if cached.is_none() {
                            return Err(format!("无法取得 WorkBuddy 静态密钥（{bin_error}）"));
                        }
                    }
                    open_envelope(cached.as_ref().expect("刚写入"), envelope)
                };

                let (token, format) = extract_token(&document, &mut open)?;

                // 账号与域：都只是随请求附带的元信息，读不到不拦——
                // 让请求发出去，由服务端给准确错误，比在这里猜一个值强。
                let account = document.get("account").filter(|v| v.is_object());
                let auth = document.get("auth").filter(|v| v.is_object());
                let uid = account.map(|a| value_str(a.get("uid"))).unwrap_or_default();
                let enterprise_id = account.map(|a| value_str(a.get("enterpriseId"))).unwrap_or_default();
                let domain = auth.map(|a| value_str(a.get("domain"))).unwrap_or_default();
                let expires_at = auth
                    .and_then(|a| a.get("expiresAt"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);

                Ok(WorkBuddyAuth {
                    token,
                    uid,
                    domain,
                    enterprise_id,
                    expires_at,
                    source: format!("{} ({format})", path.display()),
                })
            })();
            match attempt {
                Ok(auth) => return Ok(auth),
                Err(e) => last_error = e,
            }
        }
        Err(last_error)
    }
}

#[cfg(test)]
mod tests {
    use super::{build_aad, derive_protector_key, extract_token, is_safe_header_value, parse_b64, parse_envelope};
    use base64::Engine;
    // digest() 来自 trait，不是在类型的固有实现里；不引进来会报「找不到 digest」。
    use sha2::Digest as _;

    /// 测试专用的假 atRestSecretKey：32 个递增值的规范 base64。
    ///
    /// **绝不要把它换成真机探测到的那个值。** 真的 atRestSecretKey 能解开同机所有
    /// `$wbEncrypted` 字段（accessToken / refreshToken / 手机号），而且要进公开仓库——
    /// 曾经差点这么干过：调试时把真实密钥当「示例」粘进断言，虽然只在测试模块里，
    /// 但它同样是凭据。测试需要的只是「形状合法的密钥」，不是「本机那把钥匙」。
    fn fixed_test_secret() -> String {
        base64::engine::general_purpose::STANDARD.encode((0u8..32).collect::<Vec<u8>>())
    }

    #[test]
    fn aad_layout_is_exact() {
        // AAD 错一个字节，GCM 就解不开，而错误表现只是「解密失败」——看不出是 AAD 的问题。
        // 所以这里逐字节钉住：前缀 + 0x01 + 两个长度前缀串 + suite + 长度前缀 keyId + 0x02 0x00 0x00。
        let mut expected: Vec<u8> = Vec::new();
        expected.extend_from_slice(&[0x57, 0x42, 0x2D, 0x41, 0x41, 0x44, 0x00]); // "WB-AAD\0"
        expected.push(0x01);
        expected.extend_from_slice(&[0, 0, 0, 5]);
        expected.extend_from_slice(b"WBEV1");
        expected.extend_from_slice(&[0, 0, 0, 6]);
        expected.extend_from_slice(b"sym-v1");
        expected.extend_from_slice(&[0, 0, 0, 1]);
        expected.extend_from_slice(&[0, 0, 0, 16]);
        expected.extend_from_slice(b"9127dea1b44020a7");
        expected.extend_from_slice(&[0x02, 0x00, 0x00]);

        assert_eq!(build_aad("9127dea1b44020a7", 1), expected);
        // suite 参与 AAD，换一个必须整体不同。
        assert_ne!(build_aad("9127dea1b44020a7", 2), expected);
    }

    #[test]
    fn protector_key_hashes_the_base64_string_not_the_decoded_bytes() {
        // 这两个值差一个数量级的语义：哈希解码后的 32 字节是一种很自然的写法，
        // 但 app 哈希的是字符串本身。钉住它，避免以后被「顺手优化」掉。
        //
        // 用构造出来的假密钥，**不要**把本机探测到的真实 atRestSecretKey 抄进来：
        // 它能解开同机所有 $wbEncrypted 字段（accessToken / refreshToken / 手机号），
        // 一旦进仓库等于把凭据交出去。测试只要求「规范 base64 + 解码后 32 字节 + 非全零」。
        let secret = fixed_test_secret();
        let from_string = derive_protector_key(&secret);
        let decoded = base64::engine::general_purpose::STANDARD.decode(&secret).unwrap();
        let from_bytes = sha2::Sha256::digest(&decoded).to_vec();
        assert_eq!(from_string.len(), 32);
        assert_ne!(from_string, from_bytes);
    }

    #[test]
    fn parse_b64_rejects_non_canonical_and_wrong_length() {
        let twelve = base64::engine::general_purpose::STANDARD.encode([7u8; 12]);
        assert!(parse_b64(&twelve, Some(12)).is_some());
        assert!(parse_b64(&twelve, Some(16)).is_none());
        assert!(parse_b64("", None).is_none());
        assert!(parse_b64("!!!not base64!!!", None).is_none());
        // 尾部多出未编码进 base64 的字符：宽容解码会成功，严格重编码会不等，必须拒掉。
        assert!(parse_b64("AAAA*", None).is_none());
    }

    fn envelope_json(suite: u64, key_id: &str) -> serde_json::Value {
        let inner = serde_json::json!({
            "suite": suite,
            "keyId": key_id,
            "nonce": base64::engine::general_purpose::STANDARD.encode([1u8; 12]),
            "authTag": base64::engine::general_purpose::STANDARD.encode([2u8; 16]),
            "ciphertext": base64::engine::general_purpose::STANDARD.encode([3u8; 24]),
        });
        serde_json::json!({
            "$wbEncrypted": 1,
            "envelope": base64::engine::general_purpose::STANDARD.encode(inner.to_string()),
        })
    }

    #[test]
    fn envelope_only_accepts_suite_one_and_hex_key_id() {
        assert!(parse_envelope(&envelope_json(1, "9127dea1b44020a7")).is_some());
        // 别的 suite 属于别的文档类型，猜格式不是这条链路该做的事。
        assert!(parse_envelope(&envelope_json(2, "9127dea1b44020a7")).is_none());
        assert!(parse_envelope(&envelope_json(1, "not-a-key-id")).is_none());
        assert!(parse_envelope(&serde_json::json!({ "$wbEncrypted": 1 })).is_none());
    }

    /// 真的加密一次再解回来。
    ///
    /// 这个测试是为了钉住一个**已经犯过的错**：信封把 authTag 单独存一个字段，
    /// 而 aes-gcm 的 decrypt 要的是「密文 ‖ tag」。只传密文不会报参数错，
    /// 只会表现为「解密失败」，和「密钥不对」完全分不出来——
    /// 而字段上有值却在解密时没被读到，编译器只在 dead_code 层面给个提示。
    #[test]
    fn sealed_envelope_round_trips_and_rejects_a_tampered_tag() {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};

        let key = derive_protector_key(&fixed_test_secret());
        let key_id = "9127dea1b44020a7";
        let suite = 1u32;
        let nonce_bytes = [9u8; 12];
        let aad = build_aad(key_id, suite);
        let plaintext = "eyJhbGciOiJSUzI1NiJ9.aGVhZGVy.c2ln";

        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let sealed = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), Payload { msg: plaintext.as_bytes(), aad: &aad })
            .expect("加密应当成功");
        // GCM 的封装输出就是「密文 ‖ tag」，最后 16 字节是 tag——与信封字段的切分一致。
        let split = sealed.len() - 16;
        let envelope = super::Envelope {
            suite,
            key_id: key_id.to_string(),
            nonce: nonce_bytes.to_vec(),
            auth_tag: sealed[split..].to_vec(),
            ciphertext: sealed[..split].to_vec(),
        };

        assert_eq!(super::open_envelope(&key, &envelope).expect("应当解回明文"), plaintext);

        // tag 被改一个字节就必须失败，而不是「碰巧还能解」。
        let mut tampered = envelope;
        tampered.auth_tag[0] ^= 0x01;
        assert!(super::open_envelope(&key, &tampered).is_err());
    }

    #[test]
    fn token_header_value_whitelist_blocks_newlines() {
        assert!(is_safe_header_value("eyJhbGciOiJSUzI1NiJ9.payload.sig"));
        assert!(!is_safe_header_value(""));
        assert!(!is_safe_header_value("Bearer x\r\nX-Evil: 1"));
        assert!(!is_safe_header_value("has space ok but tab\tno"));
    }

    #[test]
    fn plaintext_token_never_starts_workbuddy() {
        // 5.6 以前的凭据是明文；这种情况必须完全不去碰可执行文件——
        // 否则每次签到都会白启动一个进程。
        let document = serde_json::json!({ "auth": { "accessToken": "plain-token-value" } });
        let mut called = false;
        let got = extract_token(&document, |_| {
            called = true;
            Err("不该被调用".to_string())
        })
        .expect("明文凭据应当直接读出");
        assert_eq!(got.0, "plain-token-value");
        assert_eq!(got.1, "plaintext");
        assert!(!called);
    }

    #[test]
    fn encrypted_token_reports_unreadable_without_leaking_ciphertext() {
        let document = serde_json::json!({ "auth": { "accessToken": envelope_json(1, "9127dea1b44020a7") } });
        let err = extract_token(&document, |_| Err("解不开".to_string())).unwrap_err();
        assert!(err.contains("解不开"));
        // 错误信息里不能出现密文本身。
        assert!(!err.contains("AwMDAw"));
    }

    #[test]
    fn missing_or_malformed_token_is_an_error_not_a_panic() {
        assert!(extract_token(&serde_json::json!({}), |_| Ok("x".into())).is_err());
        assert!(extract_token(&serde_json::json!({ "auth": { "accessToken": 42 } }), |_| Ok("x".into())).is_err());
    }
}

#[cfg(all(test, windows))]
mod windows_live_tests {
    /// 真机验证：读的是本机当前登录用户自己的 WorkBuddy 登录态，需要这台机器装过并登录过 WorkBuddy CN。
    /// CI 与别人的机器上必然失败，所以默认跳过。
    /// 用法：cargo test workbuddy_cn_auth -- --ignored --nocapture
    #[test]
    #[ignore]
    fn reads_live_workbuddy_credential_on_this_machine() {
        let auth = super::workbuddy_cn_auth_token().expect("本机应能读到 WorkBuddy 登录态");
        // 断言与输出里都不出现 token 本身，只验形状与元信息。
        assert!(auth.token.starts_with("eyJ"), "token 不像 JWT");
        assert!(!auth.uid.is_empty(), "没读到账号 uid");
        assert!(auth.expires_at > 1_600_000_000_000, "expiresAt 不像毫秒时间戳");
        println!(
            "uid={} domain={} expiresAt={} token长度={} 来源={}",
            auth.uid,
            auth.domain,
            auth.expires_at,
            auth.token.len(),
            auth.source
        );
    }
}
