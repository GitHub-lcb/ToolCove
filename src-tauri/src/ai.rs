use futures_util::StreamExt;

/// OpenCode 网关（Zen / Go 订阅）要求客户端为每个会话提供稳定会话 ID，缺失会被直接拒绝：
/// `HTTP 400 Request is missing x-opencode-session and cannot be routed efficiently`。
/// 该头只对指向 opencode.ai 的地址追加，其他 OpenAI 兼容服务不受影响。
const OPENCODE_HOST: &str = "opencode.ai";
const OPENCODE_HOST_SUFFIX: &str = ".opencode.ai";
/// 兜底会话 ID 前缀（正常情况下前端每次请求都会带上稳定的 sessionId）
const SESSION_ID_PREFIX: &str = "toolcove";

/// 取 URL 主机名（去 scheme / 用户信息 / 端口 / 路径），非法输入返回空串。
pub fn host_of(url: &str) -> String {
    let s = url.trim();
    let after_scheme = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => s,
    };
    let end = after_scheme
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..end];
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let host = match host_port.rfind(':') {
        Some(i) => &host_port[..i],
        None => host_port,
    };
    host.to_ascii_lowercase()
}

/// 是否指向 OpenCode 网关（opencode.ai 及其子域）。
pub fn is_opencode_endpoint(base_url: &str) -> bool {
    let host = host_of(base_url);
    host == OPENCODE_HOST || host.ends_with(OPENCODE_HOST_SUFFIX)
}

/// 会话 ID 归一：前端传入的稳定 ID 优先；缺失或空白时随机生成，避免请求被网关拒绝。
pub fn normalize_session_id(session_id: Option<&str>) -> String {
    if let Some(v) = session_id {
        let v = v.trim();
        if !v.is_empty() {
            return v.to_string();
        }
    }
    let mut bytes = [0u8; 16];
    if getrandom::fill(&mut bytes).is_ok() {
        let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
        return format!("{}-{}", SESSION_ID_PREFIX, hex);
    }
    // 随机源不可用的极端情况：退化为时间戳，仍保证非空
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{}-{:x}", SESSION_ID_PREFIX, nanos)
}

/// 组装请求头（纯函数，便于单测）：
/// - Authorization / Content-Type：与其他 OpenAI 兼容服务一致
/// - User-Agent：网关按 UA 识别调用方，reqwest 默认不带 UA
/// - x-opencode-session：仅 OpenCode 网关需要（按会话做路由与提示词缓存）
pub fn build_headers(
    base_url: &str,
    api_key: &str,
    user_agent: &str,
    session_id: &str,
) -> Vec<(String, String)> {
    let mut headers = vec![
        ("Authorization".to_string(), format!("Bearer {}", api_key.trim())),
        ("Content-Type".to_string(), "application/json".to_string()),
        ("User-Agent".to_string(), user_agent.to_string()),
    ];
    if is_opencode_endpoint(base_url) {
        headers.push(("x-opencode-session".to_string(), session_id.to_string()));
    }
    headers
}

/// 自有 UA（网关据此识别调用方）：ToolCove/<版本>
fn client_user_agent(app: &tauri::AppHandle) -> String {
    format!("ToolCove/{}", app.package_info().version)
}

/// OpenAI 兼容的 Chat Completions 代理：原生侧发请求，规避浏览器 CORS。
/// base_url 形如 https://api.openai.com/v1，自动拼接 /chat/completions。
#[tauri::command]
pub async fn ai_chat(
    app: tauri::AppHandle,
    base_url: String,
    api_key: String,
    model: String,
    messages: serde_json::Value,
    temperature: Option<f64>,
    reasoning_effort: Option<String>,
    session_id: Option<String>,
) -> Result<serde_json::Value, String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 AI 接口地址".into());
    }
    if api_key.trim().is_empty() {
        return Err("未配置 AI API Key".into());
    }
    if model.trim().is_empty() {
        return Err("未配置 AI 模型名称".into());
    }
    let url = format!("{}/chat/completions", base);
    let mut body = serde_json::Map::new();
    body.insert("model".into(), serde_json::Value::String(model));
    body.insert("messages".into(), messages);
    if let Some(t) = temperature {
        body.insert("temperature".into(), serde_json::json!(t));
    }
    if let Some(effort) = reasoning_effort {
        let effort = effort.trim();
        if !effort.is_empty() {
            body.insert("reasoning_effort".into(), serde_json::json!(effort));
        }
    }
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let session = normalize_session_id(session_id.as_deref());
    let mut request = client
        .post(&url)
        .json(&serde_json::Value::Object(body));
    for (name, value) in build_headers(&base, &api_key, &client_user_agent(&app), &session) {
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
        let msg = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| text.clone());
        return Err(format!("HTTP {}：{}", status.as_u16(), msg));
    }
    Ok(value)
}

/// 解析一行 SSE（`data: ` 前缀），返回增量文本；非增量行（空 data、[DONE]、非 JSON、无 content）返回 None。
/// 只做单行解析，chunk 边界截断由调用方按 `\n` 缓冲后传入完整行。
pub fn parse_sse_line(line: &str) -> Option<String> {
    let data = line.trim_end_matches('\r').strip_prefix("data:")?.trim();
    if data.is_empty() || data == "[DONE]" {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(data).ok()?;
    let content = value.get("choices")?.as_array()?.first()?.get("delta")?.get("content")?;
    match content {
        serde_json::Value::String(s) if !s.is_empty() => Some(s.clone()),
        _ => None,
    }
}

/// OpenAI 兼容 Chat Completions 流式代理：SSE 增量经 Channel 推送前端。
/// 前端 `channel.close()` 后 `channel.send` 失败即视为停止生成，退出循环。
#[tauri::command]
pub async fn ai_chat_stream(
    app: tauri::AppHandle,
    base_url: String,
    api_key: String,
    model: String,
    messages: serde_json::Value,
    temperature: Option<f64>,
    reasoning_effort: Option<String>,
    session_id: Option<String>,
    channel: tauri::ipc::Channel<serde_json::Value>,
) -> Result<(), String> {
    let base = base_url.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("未配置 AI 接口地址".into());
    }
    if api_key.trim().is_empty() {
        return Err("未配置 AI API Key".into());
    }
    if model.trim().is_empty() {
        return Err("未配置 AI 模型名称".into());
    }
    let url = format!("{}/chat/completions", base);
    let mut body = serde_json::Map::new();
    body.insert("model".into(), serde_json::Value::String(model));
    body.insert("messages".into(), messages);
    body.insert("stream".into(), serde_json::json!(true));
    if let Some(t) = temperature {
        body.insert("temperature".into(), serde_json::json!(t));
    }
    if let Some(effort) = reasoning_effort {
        let effort = effort.trim();
        if !effort.is_empty() {
            body.insert("reasoning_effort".into(), serde_json::json!(effort));
        }
    }
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let session = normalize_session_id(session_id.as_deref());
    let mut request = client
        .post(&url)
        .json(&serde_json::Value::Object(body));
    for (name, value) in build_headers(&base, &api_key, &client_user_agent(&app), &session) {
        request = request.header(name, value);
    }
    let resp = request
        .send()
        .await
        .map_err(|e| format!("请求失败：{e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.map_err(|e| e.to_string())?;
        let value: serde_json::Value =
            serde_json::from_str(&text).unwrap_or_else(|_| serde_json::json!({ "raw": text }));
        let msg = value
            .get("error")
            .and_then(|e| e.get("message"))
            .and_then(|m| m.as_str())
            .map(|s| s.to_string())
            .unwrap_or(text);
        let _ = channel.send(serde_json::json!({ "error": format!("HTTP {}：{}", status.as_u16(), msg) }));
        return Ok(());
    }
    // 流式读取：字节级缓冲 + UTF-8 感知切行（from_utf8_lossy 会在 chunk 边界
    // 截断多字节字符时产生替换符，损坏 JSON 内容，故必须用 split_sse_chunks）
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let _ = channel.send(serde_json::json!({ "error": format!("读取流失败：{e}") }));
                return Ok(());
            }
        };
        for line in split_sse_chunks(&mut buf, &chunk) {
            if let Some(text) = parse_sse_line(&line) {
                if channel.send(serde_json::json!({ "delta": text })).is_err() {
                    return Ok(()); // 前端已关闭 Channel（停止生成）
                }
            }
        }
    }
    let _ = channel.send(serde_json::json!({ "done": true }));
    Ok(())
}

/// 把 chunk 字节追加进 buf，按 \n 切出完整行；行 UTF-8 校验失败（多字节字符被
/// chunk 边界截断）则整行留在 buf 等后续字节。返回切出的完整行。
/// 防御：buf 超过 1MB 仍无合法行时清空（服务端发非法字节时避免永久卡死）。
pub fn split_sse_chunks(buf: &mut Vec<u8>, chunk: &[u8]) -> Vec<String> {
    buf.extend_from_slice(chunk);
    if buf.len() > 1024 * 1024 {
        buf.clear();
        return Vec::new();
    }
    let mut lines = Vec::new();
    let mut consumed = 0;
    while let Some(rel) = buf[consumed..].iter().position(|&b| b == b'\n') {
        let end = consumed + rel;
        match String::from_utf8(buf[consumed..end].to_vec()) {
            Ok(line) => lines.push(line),
            Err(_) => break, // 坏行（截断）：保留，等后续 chunk
        }
        consumed = end + 1;
    }
    buf.drain(..consumed);
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> Option<&'a str> {
        headers
            .iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }

    #[test]
    fn host_of_strips_scheme_port_path_and_userinfo() {
        assert_eq!(host_of("https://api.openai.com/v1"), "api.openai.com");
        assert_eq!(host_of("https://opencode.ai/zen/go/v1"), "opencode.ai");
        assert_eq!(host_of("HTTP://OpenCode.AI:443/zen/v1"), "opencode.ai");
        assert_eq!(host_of("http://user:pw@localhost:11434/v1"), "localhost");
        assert_eq!(host_of("https://api.example.com"), "api.example.com");
    }

    #[test]
    fn opencode_endpoint_detection_only_matches_opencode_hosts() {
        // Go 订阅端点（用户配置 https://opencode.ai/zen/go/v1 时必须命中）
        assert!(is_opencode_endpoint("https://opencode.ai/zen/go/v1"));
        assert!(is_opencode_endpoint("https://opencode.ai/zen/v1/"));
        assert!(is_opencode_endpoint("https://zen.opencode.ai/v1"));
        // 其他服务商不应被加上该头
        assert!(!is_opencode_endpoint("https://api.openai.com/v1"));
        assert!(!is_opencode_endpoint("https://api.deepseek.com/v1"));
        assert!(!is_opencode_endpoint("http://localhost:11434/v1"));
        // 相似但不同域（防后缀误判）
        assert!(!is_opencode_endpoint("https://notopencode.ai/v1"));
        assert!(!is_opencode_endpoint("https://opencode.ai.evil.com/v1"));
    }

    #[test]
    fn headers_always_carry_bearer_and_user_agent() {
        let headers = build_headers("https://api.deepseek.com/v1", " sk-1 ", "ToolCove/0.3.0", "s1");
        assert_eq!(header(&headers, "Authorization"), Some("Bearer sk-1"));
        assert_eq!(header(&headers, "Content-Type"), Some("application/json"));
        assert_eq!(header(&headers, "User-Agent"), Some("ToolCove/0.3.0"));
        // 非 OpenCode 端点不追加会话头
        assert_eq!(header(&headers, "x-opencode-session"), None);
    }

    #[test]
    fn headers_add_session_for_opencode_only() {
        let headers = build_headers("https://opencode.ai/zen/go/v1", "sk-1", "ToolCove/0.3.0", "sess-42");
        assert_eq!(header(&headers, "x-opencode-session"), Some("sess-42"));
    }

    #[test]
    fn session_id_prefers_client_value_and_falls_back_to_random() {
        assert_eq!(normalize_session_id(Some("  sess-1  ")), "sess-1");
        let generated = normalize_session_id(None);
        assert!(generated.starts_with("toolcove-"));
        assert!(generated.len() > "toolcove-".len());
        // 空白等同于缺失，不能下发空头（网关会继续 400）
        let blank = normalize_session_id(Some("   "));
        assert!(blank.starts_with("toolcove-"));
    }

    #[test]
    fn generated_session_ids_differ_per_call() {
        // 每次兜底生成都不同：避免所有请求共用一个会话 ID 影响路由与缓存
        assert_ne!(normalize_session_id(None), normalize_session_id(None));
    }
}
