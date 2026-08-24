use futures_util::StreamExt;
/// OpenAI 兼容的 Chat Completions 代理：原生侧发请求，规避浏览器 CORS。
/// base_url 形如 https://api.openai.com/v1，自动拼接 /chat/completions。
#[tauri::command]
pub async fn ai_chat(
    base_url: String,
    api_key: String,
    model: String,
    messages: serde_json::Value,
    temperature: Option<f64>,
    reasoning_effort: Option<String>,
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
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&serde_json::Value::Object(body))
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
    base_url: String,
    api_key: String,
    model: String,
    messages: serde_json::Value,
    temperature: Option<f64>,
    reasoning_effort: Option<String>,
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
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", api_key.trim()))
        .header("Content-Type", "application/json")
        .json(&serde_json::Value::Object(body))
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
