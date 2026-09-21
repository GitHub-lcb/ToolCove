// TypeSafe（System One）原生侧代理
//
// 与 ai.rs 同一动机：桌面端由原生发请求，规避浏览器 CORS，且 API Key 不经过 webview 的网络栈。
// 差别只在端点与请求体——TypeSafe 是 POST /v1/systemone，body 原样透传（{ model, state, questions }），
// 响应原样回传（{ answers, usage }）。前端只认形状，不认语义，所以这里不做任何 body 加工。
//
// 为什么这里必须有超时（ai.rs 的超时在 runtime 的 planner 守卫里，这里不能照抄那套）：
// System One 调用是 Agent 主链路上的一次额外等待，挂住的请求会让整次运行等到 planner 的 120s 守卫
// 才失败；而技能匹配的结果是 memoize 的，那个 promise 永不 settle，重试路径拿到的还是同一个挂念。
// 只有传输层自己超时，失败才能变成「退回关键词匹配」这条看得见的路。
use crate::ai::{build_headers, client_user_agent, normalize_session_id};
use std::time::Duration;

/// 官方端点（base_url 含版本段，与 settings.ai 的约定一致）。
pub const TYPESAFE_DEFAULT_BASE: &str = "https://api.typesafe.ai/v1";
/// 评估路径。
const TYPESAFE_PATH: &str = "/systemone";
/// 默认超时：Jev 通常在几百毫秒内返回，8s 已经覆盖了限流排队；再长就不如退回关键词。
pub const TYPESAFE_DEFAULT_TIMEOUT_MS: u64 = 8000;
/// 超时可配区间：下限防止用户填 0 变成「永不超时」，上限防止它拖垮整次运行。
const TYPESAFE_TIMEOUT_MIN_MS: u64 = 1000;
const TYPESAFE_TIMEOUT_MAX_MS: u64 = 30000;

/// 超时取值：非法/缺失用默认值，其余夹进区间。
/// 名字刻意不叫 `timeout_ms`——命令参数就叫 `timeout_ms`，同名会把函数遮蔽掉（调用处变成
/// 对 `Option<u64>` 的函数调用，编译不过）。
pub fn effective_timeout(value: Option<u64>) -> u64 {
    match value {
        Some(v) => v.clamp(TYPESAFE_TIMEOUT_MIN_MS, TYPESAFE_TIMEOUT_MAX_MS),
        None => TYPESAFE_DEFAULT_TIMEOUT_MS,
    }
}

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
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    if api_key.trim().is_empty() {
        return Err("未配置 TypeSafe API Key".into());
    }
    let limit = effective_timeout(timeout_ms);
    let url = typesafe_url(&base_url);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(limit))
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
        .map_err(|e| send_error(&e, limit))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| send_error(&e, limit))?;
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

/// 传输层错误的文案：超时单独成句，调用方（和看时间线的用户）才能分清「没配好」与「太慢」。
fn send_error(e: &reqwest::Error, limit: u64) -> String {
    if e.is_timeout() {
        return format!("请求超时：{}ms", limit);
    }
    format!("请求失败：{}", e)
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
    fn timeout_defaults_and_clamps() {
        assert_eq!(effective_timeout(None), TYPESAFE_DEFAULT_TIMEOUT_MS);
        // 0 会被 reqwest 解释成「不限超时」，正是这里最糟的取值，必须抬到下限
        assert_eq!(effective_timeout(Some(0)), 1000);
        assert_eq!(effective_timeout(Some(1234)), 1234);
        assert_eq!(effective_timeout(Some(999999)), 30000);
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
