// TypeSafe（System One）原生侧代理
//
// 与 ai.rs 同一动机：桌面端由原生发请求，规避浏览器 CORS，且 API Key 不经过 webview 的网络栈。
// 差别只在端点与请求体——TypeSafe 是 POST /v1/systemone，body 原样透传（{ model, state, questions }），
// 响应原样回传（{ answers, usage }）。前端只认形状，不认语义，所以这里不做任何 body 加工。
use crate::ai::{build_headers, client_user_agent, normalize_session_id};

/// 官方端点（base_url 含版本段，与 settings.ai 的约定一致）。
pub const TYPESAFE_DEFAULT_BASE: &str = "https://api.typesafe.ai/v1";
/// 评估路径。
const TYPESAFE_PATH: &str = "/systemone";

/// 评估端点地址：base_url 为空时落到官方端点；结尾斜杠与「用户直接粘了完整端点」都容错，
/// 否则会拼出 /v1/systemone/systemone 这种 404 地址。
pub fn typesafe_url(base_url: &str) -> String {
    let base = base_url.trim().trim_end_matches('/');
    let base = base.strip_suffix(TYPESAFE_PATH).unwrap_or(base);
    let base = base.trim_end_matches('/');
    let base = if base.is_empty() { TYPESAFE_DEFAULT_BASE } else { base };
    format!("{}{}", base, TYPESAFE_PATH)
}

/// 从错误体里挖出人能看懂的那句话：优先 error.message，其次 message，再退回原文。
/// TypeSafe 的错误体没有强制 schema（文档只承诺「JSON body describing what went wrong」），
/// 所以三种常见形状都要认。
pub fn error_text(value: &serde_json::Value, fallback: &str) -> String {
    value
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(|m| m.as_str())
        .or_else(|| value.get("message").and_then(|m| m.as_str()))
        .or_else(|| value.get("detail").and_then(|m| m.as_str()))
        .map(|s| s.to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// System One 评估代理：body 原样透传，响应原样回传。
/// 与 ai_chat 一致地复用 build_headers（Authorization / Content-Type / User-Agent；
/// 会话头只对 opencode.ai 追加，TypeSafe 端点不受影响）。
#[tauri::command]
pub async fn typesafe_eval(
    app: tauri::AppHandle,
    base_url: String,
    api_key: String,
    body: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if api_key.trim().is_empty() {
        return Err("未配置 TypeSafe API Key".into());
    }
    let url = typesafe_url(&base_url);
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let session = normalize_session_id(None);
    let mut request = client.post(&url).json(&body);
    for (name, value) in build_headers(&url, &api_key, &client_user_agent(&app), &session) {
        request = request.header(name, value);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    let value: serde_json::Value =
        serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "raw": text }));
    if !status.is_success() {
        return Err(format!(
            "HTTP {}：{}",
            status.as_u16(),
            error_text(&value, &text)
        ));
    }
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn url_falls_back_to_official_endpoint() {
        assert_eq!(typesafe_url(""), format!("{}/systemone", TYPESAFE_DEFAULT_BASE));
        assert_eq!(typesafe_url("   "), format!("{}/systemone", TYPESAFE_DEFAULT_BASE));
    }

    #[test]
    fn url_keeps_custom_base_and_tolerates_trailing_slash() {
        assert_eq!(typesafe_url("https://proxy.example.com/v1"), "https://proxy.example.com/v1/systemone");
        assert_eq!(typesafe_url("https://proxy.example.com/v1/"), "https://proxy.example.com/v1/systemone");
        assert_eq!(typesafe_url("  https://proxy.example.com/v1  "), "https://proxy.example.com/v1/systemone");
    }

    #[test]
    fn url_does_not_double_the_path_when_pasted_whole() {
        // 用户把控制台里的完整端点粘进来是常见误操作，不能拼成 /systemone/systemone
        assert_eq!(
            typesafe_url("https://api.typesafe.ai/v1/systemone"),
            "https://api.typesafe.ai/v1/systemone"
        );
        assert_eq!(
            typesafe_url("https://api.typesafe.ai/v1/systemone/"),
            "https://api.typesafe.ai/v1/systemone"
        );
    }

    #[test]
    fn error_text_prefers_the_nested_message() {
        let nested = serde_json::json!({ "error": { "message": "rate limited" } });
        assert_eq!(error_text(&nested, "raw body"), "rate limited");
        let flat = serde_json::json!({ "message": "bad request" });
        assert_eq!(error_text(&flat, "raw body"), "bad request");
        let detail = serde_json::json!({ "detail": "validation failed" });
        assert_eq!(error_text(&detail, "raw body"), "validation failed");
        // 非 JSON 错误体：保留原文（502 网关回的常常是 HTML）
        let none = serde_json::json!({ "raw": "<html>bad gateway</html>" });
        assert_eq!(error_text(&none, "<html>bad gateway</html>"), "<html>bad gateway</html>");
    }
}
