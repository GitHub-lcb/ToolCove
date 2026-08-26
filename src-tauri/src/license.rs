//! Pro 授权：离线 Ed25519 签名 license key 的解析、验签与状态命令。
//!
//! - key 格式：TCV1-<base64url(payload_json)>.<base64url(sig64)>
//!   验签对象 = payload 原文 UTF-8 字节（防 JSON 重排攻击）。
//! - payload 键序固定：plan, name, email, issued, expires, features。
//! - expires 空串 = 永久有效；非空为 yyyy-mm-dd（UTC），早于今天即过期。
//! - 授权文件 license.json 存 {"key": "<原始 key 文本>"}；
//!   备份/恢复三处排除点（run_backup / read_restore_archive / managed_json_files）
//!   统一引用本模块的 is_license_json 判定。
//!
//! 错误码（前端 i18n 一一对应）：
//!   malformed（前缀/分段/base64/JSON 结构错误）、bad-signature（验签失败）、
//!   expired、unsupported-plan（plan 非 pro）。

use std::fs;

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde_json::{json, Value};
use tauri::Emitter;

use crate::storage;

/// 应用公钥（base64url，32 字节 ed25519 原始公钥）。
/// 开发期占位密钥——发布前用 node scripts/license-keygen.js 重新生成并替换，私钥绝不入库。
const PUBLIC_KEY_B64: &str = "fDmmuq9-u7Gyg0GXrVxoZRck22I8W7HU48q5VSssoOk";

const KEY_PREFIX: &str = "TCV1-";
pub const LICENSE_KEY: &str = "license";

/// 判定文件名是否为 license 授权文件（备份/恢复三处排除点统一收口）
pub fn is_license_json(name: &str) -> bool {
    name.eq_ignore_ascii_case("license.json")
}

/// 无符号 payload 结构（字段全 Optional 容错，缺失字段按免费/空处理）
#[derive(serde::Deserialize)]
struct LicensePayload {
    plan: Option<String>,
    name: Option<String>,
    email: Option<String>,
    issued: Option<String>,
    expires: Option<String>,
    #[serde(default)]
    features: Option<Vec<String>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum LicenseError {
    Malformed,      // 结构错误：前缀/分段/base64/json
    BadSignature,   // 验签失败（payload 或签名被篡改）
    Expired,        // 已过期
    UnsupportedPlan, // plan 非 pro
}

impl LicenseError {
    fn code(&self) -> &'static str {
        match self {
            LicenseError::Malformed => "malformed",
            LicenseError::BadSignature => "bad-signature",
            LicenseError::Expired => "expired",
            LicenseError::UnsupportedPlan => "unsupported-plan",
        }
    }
}

fn b64_decode_url(input: &str) -> Result<Vec<u8>, ()> {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(input).map_err(|_| ())
}

/// 解析 key 文本：前缀 + 两段 base64url（payload / 签名）
fn parse_key(text: &str) -> Result<(Vec<u8>, Signature), LicenseError> {
    let text = text.trim();
    let rest = text
        .strip_prefix(KEY_PREFIX)
        .ok_or(LicenseError::Malformed)?;
    let (payload_b64, sig_b64) = rest
        .split_once('.')
        .ok_or(LicenseError::Malformed)?;
    if payload_b64.is_empty() || sig_b64.is_empty() {
        return Err(LicenseError::Malformed);
    }
    let payload = b64_decode_url(payload_b64).map_err(|_| LicenseError::Malformed)?;
    let sig_bytes = b64_decode_url(sig_b64).map_err(|_| LicenseError::Malformed)?;
    let sig = Signature::from_slice(&sig_bytes).map_err(|_| LicenseError::Malformed)?;
    Ok((payload, sig))
}

/// 今天 UTC 日期（Howard Hinnant civil_from_days 算法，避免引入 chrono 依赖）
fn today_utc_ymd() -> (i64, u32, u32) {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let z = (secs / 86400) as i64 + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// 解析 yyyy-mm-dd 为 (y,m,d)（UTC），格式非法返回 None
fn parse_date(s: &str) -> Option<(i64, u32, u32)> {
    let mut parts = s.split('-');
    let y = parts.next()?.parse::<i64>().ok()?;
    let m = parts.next()?.parse::<u32>().ok()?;
    let d = parts.next()?.parse::<u32>().ok()?;
    if parts.next().is_some() || !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

/// 用内嵌公钥对原始 key 文本做完整校验（解析 + 验签 + 过期 + plan）
fn verify_key(text: &str) -> Result<LicensePayload, LicenseError> {
    let (payload_bytes, sig) = parse_key(text)?;
    let pub_b64_decoded = b64_decode_url(PUBLIC_KEY_B64).map_err(|_| LicenseError::Malformed)?;
    let verifying = VerifyingKey::from_bytes(
        (&pub_b64_decoded[..]).try_into().map_err(|_| LicenseError::Malformed)?,
    )
    .map_err(|_| LicenseError::Malformed)?;
    verifying
        .verify(&payload_bytes, &sig)
        .map_err(|_| LicenseError::BadSignature)?;
    let payload: LicensePayload = serde_json::from_slice(&payload_bytes)
        .map_err(|_| LicenseError::Malformed)?;
    if payload.plan.as_deref() != Some("pro") {
        return Err(LicenseError::UnsupportedPlan);
    }
    if let Some(exp) = payload.expires.as_deref() {
        if !exp.is_empty() {
            match parse_date(exp) {
                Some((y, m, d)) => {
                    let (ty, tm, td) = today_utc_ymd();
                    if (y, m, d) < (ty, tm, td) {
                        return Err(LicenseError::Expired);
                    }
                }
                None => return Err(LicenseError::Malformed),
            }
        }
    }
    Ok(payload)
}

/// 构造对外状态对象
fn status_json(payload: Option<&LicensePayload>, error: Option<&LicenseError>) -> Value {
    match payload {
        Some(p) => json!({
            "pro": true,
            "plan": p.plan.as_deref().unwrap_or("pro"),
            "name": p.name.as_deref().unwrap_or(""),
            "email": p.email.as_deref().unwrap_or(""),
            "issuedAt": p.issued.as_deref().unwrap_or(""),
            "expiresAt": p.expires.as_deref().unwrap_or(""),
            "features": p.features.clone().unwrap_or_default(),
            "error": null
        }),
        None => json!({
            "pro": false,
            "error": error.map(|e| e.code())
        }),
    }
}

/// 读取当前授权状态（缺文件/空数组 = 免费版）
fn read_license_value(app: &tauri::AppHandle) -> Result<Value, String> {
    if let Ok(path) = storage::data_path(app, LICENSE_KEY) {
        let (val, _rev) = storage::read_json_file(&path, LICENSE_KEY).map_err(|e| e.to_string())?;
        if !val.is_array() && !val.is_null() {
            return Ok(val);
        }
    }
    Ok(json!({}))
}

fn current_status(app: &tauri::AppHandle) -> Result<Value, String> {
    let val = read_license_value(app)?;
    let key_text = val.get("key").and_then(|v| v.as_str()).unwrap_or("");
    if key_text.is_empty() {
        return Ok(status_json(None, None));
    }
    match verify_key(key_text) {
        Ok(p) => Ok(status_json(Some(&p), None)),
        Err(e) => Ok(status_json(None, Some(&e))),
    }
}

/// 查询当前授权状态
#[tauri::command]
pub fn license_status(app: tauri::AppHandle) -> Result<Value, String> {
    current_status(&app)
}

/// 激活：验签通过则写入 license.json 并广播 license-changed
#[tauri::command]
pub fn license_activate(app: tauri::AppHandle, key: String) -> Result<Value, String> {
    match verify_key(&key) {
        Ok(payload) => {
            let _guard = storage::data_io_lock().map_err(|e| e.to_string())?;
            storage::ensure_data_writable()?;
            let path = storage::data_path(&app, LICENSE_KEY)?;
            storage::replace_json_file(&path, LICENSE_KEY, &json!({ "key": key.trim() }))?;
            let status = status_json(Some(&payload), None);
            let _ = app.emit("license-changed", status.clone());
            Ok(status)
        }
        Err(e) => Ok(status_json(None, Some(&e))),
    }
}

/// 停用：删除授权文件，回到免费版（备份/恢复均不包含授权，无需额外清理）
#[tauri::command]
pub fn license_deactivate(app: tauri::AppHandle) -> Result<Value, String> {
    let _guard = storage::data_io_lock().map_err(|e| e.to_string())?;
    storage::ensure_data_writable()?;
    if let Ok(path) = storage::data_path(&app, LICENSE_KEY) {
        if path.exists() {
            fs::remove_file(&path).map_err(|e| format!("删除授权文件失败：{e}"))?;
        }
    }
    let status = status_json(None, None);
    let _ = app.emit("license-changed", status.clone());
    Ok(status)
}

/// 在线激活（预留）：后续接入激活服务器，当前返回 coming-soon
#[tauri::command]
pub fn license_activate_online(_app: tauri::AppHandle, _email: String) -> Result<Value, String> {
    Ok(json!({ "pro": false, "error": "coming-soon" }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    // 固定 seed 的测试密钥对（不依赖随机源）
    fn test_keypair() -> (SigningKey, VerifyingKey) {
        let seed = [42u8; 32];
        let sk = SigningKey::from_bytes(&seed);
        let vk = sk.verifying_key();
        (sk, vk)
    }

    fn make_key(sk: &SigningKey, payload: &str) -> String {
        use base64::Engine;
        let sig = sk.sign(payload.as_bytes());
        let payload_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(payload.as_bytes());
        let sig_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(sig.to_bytes());
        format!("{KEY_PREFIX}{payload_b64}.{sig_b64}")
    }

    fn payload_json(expires: &str) -> String {
        format!(
            r#"{{"plan":"pro","name":"测试用户","email":"t@example.com","issued":"2026-01-01","expires":"{expires}","features":["db-export-xlsx","theme-custom"]}}"#
        )
    }

    #[test]
    fn verify_accepts_valid_key() {
        let (sk, vk) = test_keypair();
        let key = make_key(&sk, &payload_json(""));
        // 用签名密钥核对：验签函数与测试公钥一致
        let text = key;
        // 直接验证 verify_strict 层面（不复用全局公钥）
        let (payload, sig) = parse_key(&text).expect("parse ok");
        assert!(vk.verify(&payload, &sig).is_ok());
    }

    #[test]
    fn parse_rejects_bad_prefix_and_shape() {
        assert_eq!(parse_key("XYZ-abc.def"), Err(LicenseError::Malformed));
        assert_eq!(parse_key("TCV1-abc"), Err(LicenseError::Malformed));
        assert_eq!(parse_key("TCV1-.."), Err(LicenseError::Malformed));
        assert_eq!(parse_key("TCV1-aGVsbG8."), Err(LicenseError::Malformed));
        assert_eq!(parse_key(""), Err(LicenseError::Malformed));
    }

    #[test]
    fn tampered_payload_is_bad_signature() {
        let (sk, _vk) = test_keypair();
        let mut key = make_key(&sk, &payload_json(""));
        // 篡改 payload 段最后一个字符
        let dot = key.rfind('.').unwrap();
        let idx = dot - 1;
        let c = key.as_bytes()[idx];
        let new_c = if c == b'A' { b'B' } else { b'A' };
        key.replace_range(idx..idx + 1, &(new_c as char).to_string());
        let (payload, sig) = parse_key(&key).expect("still parses");
        let (_, vk) = test_keypair();
        assert!(vk.verify(&payload, &sig).is_err());
    }

    #[test]
    fn tampered_signature_is_rejected() {
        let (sk, _vk) = test_keypair();
        let mut key = make_key(&sk, &payload_json(""));
        let last = key.len() - 1;
        let c = key.as_bytes()[last];
        let new_c = if c == b'A' { b'B' } else { b'A' };
        key.replace_range(last..last + 1, &(new_c as char).to_string());
        let (payload, sig) = parse_key(&key).expect("parses");
        let (_, vk) = test_keypair();
        assert!(vk.verify(&payload, &sig).is_err());
    }

    #[test]
    fn date_helpers() {
        assert_eq!(parse_date("2026-08-26"), Some((2026, 8, 26)));
        assert_eq!(parse_date(""), None);
        assert_eq!(parse_date("2026-13-01"), None);
        assert_eq!(parse_date("2026-08-32"), None);
        assert_eq!(parse_date("abc"), None);
        let (y, m, d) = today_utc_ymd();
        assert!(y >= 2026 && (1..=12).contains(&m) && (1..=31).contains(&d));
    }

    #[test]
    fn is_license_json_matches_exact_name() {
        assert!(is_license_json("license.json"));
        assert!(is_license_json("LICENSE.JSON"));
        assert!(!is_license_json("license.json.tmp"));
        assert!(!is_license_json("settings.json"));
        assert!(!is_license_json("license"));
    }
}
