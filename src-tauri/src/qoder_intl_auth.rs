// Qoder **国际版**（Qoder IDE，qoder.com / qoder.ai）本地登录态读取。
//
// 与 Qoder CN 的关系：**加密格式完全一样**（Chromium OSCrypt v10 + DPAPI 保护密钥），
// 差的是「东西放在哪儿」与「打给哪个域」。所以这里刻意复用 CN 那套解密，
// 而不是写第二份实现——两份几乎一样的密码学代码迟早会各自漂移。
//
// 为什么不与 CN 合并成一个函数：CN 与国际版是两个应用、两套登录态。
// 共用一个候选目录列表会把两边的 token 混在一起，拿错的表现只是一句 401，
// 而排查方向会被带到「凭据过期」这个错误答案上。所以宁可分成两个来源、各自白名单。
//
// 目录名取自国际版自己的启动参数：Qoder.exe 带
// `--user-data-dir=%APPDATA%\com.qoder.app.stable` 启动，凭据就在这个目录下。
//
// 实测踩过的坑（这里有两个都像的地方）：
//   %APPDATA%\com.qoder.app.stable\auth.v1.dat ← 真身，token 是 dt- 前缀
//   %APPDATA%\QoderWork\auth.dat              ← **占位文件**：解出来 token 是
//     "placeholder-token…" 字面量，refreshToken 同理，expiresAt 却是 2027 年。
//     它是 3 月安装时留下的，从没被真正登录更新过。读到这个文件会拿到一个
//     看起来合法、实际必然 401 的 token——排查方向会被带到「凭据过期」上去。
// 所以候选只认 com.qoder.app.stable；Qoder / QoderWork 一概不碰。
//
// 只读不写：不刷新、不回写、不落盘、不进日志。

use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_BLOB: u64 = 1 << 20;
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderIntlAuth {
    pub token: String,
    pub expires_at: String,
    /// 实际命中的目录名，出问题时用来区分装了好几个 Qoder。
    pub source: String,
    /// umid 机器身份三件套（MachineToken / MachineCode / MachineType）。
    ///
    /// 为什么国际版**必须**带它们：国际版的 `GET /sash/api/v1/me/campaigns` 按机器身份
    /// 下发每日 `CLAIM_BENEFIT` 轮次。缺这组头时，接口不是报错，而是**只回常驻的
    /// VIEW_DETAILS 横幅**（实测：本机加上这组头才出现当轮的 CLAIMABLE 活动）。
    /// 于是缺它的时候工具会看到「今天没有活动」，并如实这么显示——但那是假的，
    /// 而用户只会以为今天没有活动可领，不会想到是工具少发了头。
    ///
    /// 三项都读不到时返回空数组：让请求照发，行为退回到「只看到横幅」，
    /// 而不是把整个签到站点报成不可用。
    pub machine_token: String,
    pub machine_code: String,
    pub machine_type: String,
}

fn appdata() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

/// 国际版候选目录。**只含** com.qoder.app.stable（见文件头关于占位文件的说明）。
fn candidate_dirs(root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for name in ["com.qoder.app.stable"] {
        let dir = root.join(name);
        let auth = dir.join("auth.v1.dat");
        let state = dir.join("Local State");
        if !(auth.is_file() && state.is_file()) {
            continue;
        }
        let mtime = std::fs::metadata(&auth).and_then(|m| m.modified()).unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        found.push((mtime, dir));
    }
    found.sort_by(|a, b| b.0.cmp(&a.0));
    found.into_iter().map(|(_, dir)| dir).collect()
}

fn read_oscrypt_key(dir: &Path) -> Result<Vec<u8>, String> {
    let text = std::fs::read_to_string(dir.join("Local State")).map_err(|e| format!("读取 Local State 失败: {e}"))?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Local State 不是合法 JSON: {e}"))?;
    let encoded = json
        .get("os_crypt")
        .and_then(|o| o.get("encrypted_key"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Local State 里没有 os_crypt.encrypted_key".to_string())?;
    let blob = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("encrypted_key 不是合法 base64: {e}"))?;
    let prefix = blob.strip_prefix(b"DPAPI".as_slice()).ok_or_else(|| "encrypted_key 缺少 DPAPI 前缀（可能不是 Windows 上生成的）".to_string())?;
    crate::secure::dpapi_unprotect(prefix)
}

fn is_safe_token(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 512
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

/// umid 的值要进 HTTP 头，字符同样必须收口（一个 \r\n 就是一条注入出去的响应头）。
fn is_safe_header_value(text: &str) -> bool {
    !text.is_empty() && text.len() <= 1024 && text.bytes().all(|b| b.is_ascii_graphic() || b == b' ')
}

/// 定位 umid 助手 `runtime-info.exe`：环境变量 → 默认安装目录 → 卸载注册表。
///
/// 顺序与凭据目录的思路一致：国际版允许自定义安装目录（实测就有装在 E 盘的），
/// 只探默认路径会把「装在别处」误报成「拿不到机器身份」。
fn candidate_umid_bins() -> Vec<PathBuf> {
    let mut raw: Vec<PathBuf> = Vec::new();
    if let Some(value) = std::env::var_os("QODER_UMID_BIN") {
        raw.push(PathBuf::from(value));
    }
    for key in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)"] {
        if let Some(root) = std::env::var_os(key) {
            let root = PathBuf::from(root);
            raw.push(root.join("Programs").join("Qoder").join("resources").join("umid").join("runtime-info.exe"));
            raw.push(root.join("Programs").join("Qoder IDE").join("resources").join("umid").join("runtime-info.exe"));
        }
    }
    raw.extend(registry_umid_bins());

    let mut out: Vec<PathBuf> = Vec::new();
    for path in raw {
        if path.is_file() && !out.contains(&path) {
            out.push(path);
        }
    }
    out
}

/// 从卸载注册表里找 Qoder 的安装目录（DisplayIcon 形如 `"E:\...\Qoder.exe",0`）。
#[cfg(windows)]
fn registry_umid_bins() -> Vec<PathBuf> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
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
            _ => continue,
        };
        let text = decode_console(&output.stdout);
        let mut block_name = String::new();
        let mut block_icon = String::new();
        let flush = |name: &str, icon: &str, out: &mut Vec<PathBuf>| {
            if !name.contains("Qoder") {
                return;
            }
            // 国际版与 CN 版在注册表里都叫 Qoder，靠 umid 是否存在再区分。
            let exe = PathBuf::from(icon.trim_matches('"'));
            if let Some(dir) = exe.parent() {
                out.push(dir.join("resources").join("umid").join("runtime-info.exe"));
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
                block_name = value_after_reg_type(rest);
            } else if let Some(rest) = trimmed.strip_prefix("DisplayIcon") {
                block_icon = value_after_reg_type(rest);
            }
        }
        flush(&block_name, &block_icon, &mut out);
    }
    out
}

#[cfg(not(windows))]
fn registry_umid_bins() -> Vec<PathBuf> {
    Vec::new()
}

/// reg.exe 的输出按控制台代码页编码，中文 Windows 上是 GBK。
fn decode_console(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        Err(_) => {
            let (text, _, _) = encoding_rs::GBK.decode(bytes);
            text.into_owned()
        }
    }
}

/// 从 `    REG_SZ    E:\...\Qoder.exe,0` 里取出路径（DisplayIcon 的逗号后是图标序号）。
#[cfg(windows)]
fn value_after_reg_type(rest: &str) -> String {
    let text = match rest.find("REG_SZ") {
        Some(at) => &rest[at + "REG_SZ".len()..],
        None => rest,
    };
    let value = text.trim().trim_matches('"');
    value.split(',').next().unwrap_or("").trim().trim_matches('"').to_string()
}

/// 跑 umid 助手，取出机器身份三件套。任何一步失败都返回空数组（见字段注释）。
fn read_machine_identity() -> (String, String, String) {
    for bin in candidate_umid_bins() {
        let output = match std::process::Command::new(&bin).output() {
            Ok(o) if o.status.success() => o,
            _ => continue,
        };
        let parsed: serde_json::Value = match serde_json::from_slice(&output.stdout) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let get = |key: &str| {
            parsed
                .get(key)
                .and_then(|v| v.as_str())
                .filter(|s| is_safe_header_value(s))
                .unwrap_or("")
                .to_string()
        };
        let token = get("machineToken");
        let code = get("machineCode");
        let kind = get("machineType");
        if !token.is_empty() && !code.is_empty() && !kind.is_empty() {
            return (token, code, kind);
        }
    }
    (String::new(), String::new(), String::new())
}

fn decrypt_v10(key: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    if blob.len() < 3 + NONCE_LEN {
        return Err("凭据文件长度不对".into());
    }
    if &blob[..3] != b"v10" {
        return Err(format!("不支持的凭据格式（前缀 {:?}，只支持 v10）", &blob[..3]));
    }
    if key.len() != KEY_LEN {
        return Err(format!("OSCrypt 密钥长度应为 {KEY_LEN} 字节，实际 {}", key.len()));
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| "OSCrypt 密钥长度非法".to_string())?;
    cipher
        .decrypt(Nonce::from_slice(&blob[3..3 + NONCE_LEN]), &blob[3 + NONCE_LEN..])
        .map_err(|_| "解密失败（Qoder 可能改用了别的加密方案，或该文件不属于当前 Windows 用户）".into())
}

#[tauri::command]
pub fn qoder_intl_auth_token() -> Result<QoderIntlAuth, String> {
    #[cfg(not(windows))]
    {
        Err("读取 Qoder 本地登录态仅在 Windows 桌面端支持".into())
    }
    #[cfg(windows)]
    {
        let root = appdata().ok_or_else(|| "找不到 %APPDATA% 目录".to_string())?;
        let dirs = candidate_dirs(&root);
        if dirs.is_empty() {
            return Err("没有找到 Qoder 国际版的登录态文件（com.qoder.app.stable\\auth.v1.dat）。请确认已安装并登录 Qoder IDE。".into());
        }
        let mut last_error = String::new();
        for dir in dirs {
            let result = (|| -> Result<QoderIntlAuth, String> {
                let key = read_oscrypt_key(&dir)?;
                let auth_path = dir.join("auth.v1.dat");
                let size = std::fs::metadata(&auth_path).map_err(|e| format!("读取凭据文件失败: {e}"))?.len();
                if size > MAX_BLOB {
                    return Err("凭据文件异常偏大，拒绝解析".into());
                }
                let blob = std::fs::read(&auth_path).map_err(|e| format!("读取凭据文件失败: {e}"))?;
                let plain = decrypt_v10(&key, &blob)?;
                let json: serde_json::Value = serde_json::from_slice(&plain).map_err(|_| "登录态内容不是合法 JSON".to_string())?;
                let token = json.get("token").and_then(|v| v.as_str()).unwrap_or("");
                if !is_safe_token(token) {
                    return Err("登录态里没有可用的 token 字段".into());
                }
                let (machine_token, machine_code, machine_type) = read_machine_identity();
                Ok(QoderIntlAuth {
                    token: token.to_string(),
                    expires_at: json.get("expiresAt").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    source: dir.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string(),
                    machine_token,
                    machine_code,
                    machine_type,
                })
            })();
            match result {
                Ok(auth) => return Ok(auth),
                Err(e) => last_error = e,
            }
        }
        Err(last_error)
    }
}

#[cfg(test)]
mod tests {
    use super::{decrypt_v10, is_safe_token};

    #[test]
    fn token_whitelist_blocks_newlines_and_whitespace() {
        assert!(is_safe_token("dt-01a0f1cc_d06c.7d4c-8ea0"));
        assert!(!is_safe_token(""));
        assert!(!is_safe_token("Bearer dt-a\r\nX-Evil: 1"));
        assert!(!is_safe_token("dt a"));
        let long = format!("dt-{}", "x".repeat(600));
        assert!(!is_safe_token(&long));
    }

    #[test]
    fn rejects_non_v10_prefix_without_panicking() {
        assert!(decrypt_v10(&[0u8; 32], b"v11abcdefghijklmnop").unwrap_err().contains("v10"));
        assert!(decrypt_v10(&[0u8; 32], b"v10abc").unwrap_err().contains("长度"));
        assert!(decrypt_v10(&[0u8; 16], b"v10abcdefghijklmnop").unwrap_err().contains("密钥长度"));
    }
}

#[cfg(all(test, windows))]
mod windows_live_tests {
    /// 真机验证：读的是本机当前登录用户自己的 Qoder 国际版登录态，
    /// 需要这台机器装过并登录过 Qoder IDE。未登录时必然失败，所以默认跳过。
    /// 用法：cargo test qoder_intl_auth -- --ignored --nocapture
    #[test]
    #[ignore]
    fn reads_live_qoder_intl_credential_on_this_machine() {
        let auth = super::qoder_intl_auth_token().expect("本机应能读到 Qoder 国际版登录态");
        assert!(auth.token.starts_with("dt-"), "token 前缀不是 dt-，可能读到了别的东西");
        println!("命中目录={} token长度={}", auth.source, auth.token.len());
    }
}