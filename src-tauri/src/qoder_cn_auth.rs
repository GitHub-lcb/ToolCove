// Qoder **CN** 本地登录态读取：让自动签到不必每次重新抓包。
//
// 只管 CN 版。国际版 Qoder 是另一个应用：域名不同（qoder.sh / qoder.com vs qoder.com.cn）、
// 应用数据目录不同、登录态互不通用。所以候选目录是写死的白名单，不做「扫到哪个算哪个」——
// 拿错版本的 token 打过来，表现只是一句 401，但排查方向会被带到「凭据过期」上去。
//
// Qoder 把 device token 存在自己的应用数据目录里（auth.v1.dat），格式是 Chromium
// OSCrypt 的 v10：AES-256-GCM，密钥放在同目录 Local State 的 os_crypt.encrypted_key
// 里、外面再套一层 Windows DPAPI（当前用户作用域）。也就是说同一登录用户的本地进程
// 本来就能解开——这里没有新增任何权限，只是把「人工抓包抄一次 token、过期再抄一次」
// 换成「运行时读当场要用的那一个」。
//
// 刻意只读不写：不刷新、不回写、不落盘、不进日志。
// 刷新接口会**轮换 refresh_token**，一旦把 Qoder 手里那份作废，它下次自己刷新就会被
// 服务端拒掉并 expireSession，直接把用户踢下线。这个代价比「多读一次文件」大得多。

use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};

// 凭据文件正常只有几百字节；读到异常大的东西说明路径不对，不能继续解。
const MAX_BLOB: u64 = 1 << 20;
// Chromium OSCrypt 的 AES-256-GCM 密钥长度与 nonce 长度。
const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QoderAuth {
    pub token: String,
    pub expires_at: String,
    /// 实际命中的目录名，出问题时用来区分「装了好几个 Qoder」。
    pub source: String,
}

fn appdata() -> Option<PathBuf> {
    std::env::var_os("APPDATA").map(PathBuf::from)
}

/// CN 版可能的数据目录，按 mtime 取最新的那个（机器上可能装过历史版本的目录名）。
/// 这里**不含** `%APPDATA%\Qoder`：那是国际版/CLI 的地盘，凭据不通用。
fn candidate_dirs(root: &Path) -> Vec<PathBuf> {
    let mut found: Vec<(std::time::SystemTime, PathBuf)> = Vec::new();
    for name in ["com.qodercn.app.stable", "QoderCN"] {
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
    // 约定：base64 解出来的前 5 个字节是字面量 "DPAPI"，剩下才是 DPAPI blob。
    let prefix = blob.strip_prefix(b"DPAPI".as_slice()).ok_or_else(|| "encrypted_key 缺少 DPAPI 前缀（可能不是 Windows 上生成的）".to_string())?;
    crate::secure::dpapi_unprotect(prefix)
}

fn is_safe_token(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 512
        && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b':'))
}

fn decrypt_v10(key: &[u8], blob: &[u8]) -> Result<Vec<u8>, String> {
    use aes_gcm::{aead::Aead, KeyInit, Nonce, Aes256Gcm};
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
        .map_err(|_| "解密失败（Qoder 版本可能改用了别的加密方案，或该文件不属于当前 Windows 用户）".into())
}

#[tauri::command]
pub fn qoder_cn_auth_token() -> Result<QoderAuth, String> {
    #[cfg(not(windows))]
    {
        Err("读取 Qoder 本地登录态仅在 Windows 桌面端支持".into())
    }
    #[cfg(windows)]
    {
        let root = appdata().ok_or_else(|| "找不到 %APPDATA% 目录".to_string())?;
        let dirs = candidate_dirs(&root);
        if dirs.is_empty() {
            return Err("没有找到 Qoder 的登录态文件（auth.v1.dat）".into());
        }
        let mut last_error = String::new();
        for dir in dirs {
            let result = (|| -> Result<QoderAuth, String> {
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
                Ok(QoderAuth {
                    token: token.to_string(),
                    expires_at: json.get("expiresAt").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    source: dir.file_name().and_then(|n| n.to_str()).unwrap_or("unknown").to_string(),
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
        // 这个值会直接进 HTTP 头，一个 \r\n 就是一条注入出去的响应头
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
        // 密钥长度不对也不能解
        assert!(decrypt_v10(&[0u8; 16], b"v10abcdefghijklmnop").unwrap_err().contains("密钥长度"));
    }
}

#[cfg(all(test, windows))]
mod windows_live_tests {
    /// 真机验证：读的是本机当前登录用户自己的 Qoder 登录态，需要这台机器装过并登录过 Qoder。
    /// CI 与别人的机器上必然失败，所以默认跳过。
    /// 用法：cargo test qoder_auth -- --ignored --nocapture
    #[test]
    #[ignore]
    fn reads_live_qoder_credential_on_this_machine() {
        let auth = super::qoder_cn_auth_token().expect("本机应能读到 Qoder 登录态");
        // 断言与输出里都不出现 token 本身，只验形状与元信息。
        assert!(auth.token.starts_with("dt-"), "token 前缀不是 dt-，可能读到了别的东西");
        assert!(!auth.expires_at.is_empty(), "响应里没有 expiresAt");
        println!("命中目录={} expiresAt={} token长度={}", auth.source, auth.expires_at, auth.token.len());
    }
}
