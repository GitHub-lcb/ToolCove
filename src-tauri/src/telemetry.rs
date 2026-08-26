//! 可选遥测上报：前端聚合后的匿名使用计数在此发送。
//!
//! 隐私承诺（与前端声明一致）：只上传功能使用次数与客户端元数据（installId/
//! 版本/平台/locale/时区），不包含任何内容数据、文件路径或 IP。
//! 端点常量默认留空 = 只聚合本地、实际不发送任何数据；真实服务器上线后填写地址。
//! 任何网络失败静默返回 Ok（不打扰用户），前端侧有单日重试上限与退避。

use serde_json::Value;

/// 遥测端点。上线服务器前保持空字符串（此时 telemetry_submit 直接返回，不发请求）。
const TELEMETRY_ENDPOINT: &str = "";

/// 是否应发送（端点已配置）。纯函数：便于单测，且避免在测试中构造 async 运行时。
fn should_send(endpoint: &str) -> bool {
    !endpoint.is_empty()
}

/// 上报一批计数事件：events = [{ "key": "view.toolbox", "count": 12, "ts": 1700000000000 }]
/// async 命令（复用 reqwest 异步客户端，无需开启 blocking feature）
#[tauri::command]
pub async fn telemetry_submit(events: Vec<Value>) -> Result<(), String> {
    if !should_send(TELEMETRY_ENDPOINT) {
        return Ok(()); // 机制就绪但未配置端点：静默丢弃
    }
    let body = serde_json::json!({ "events": events });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    match client.post(TELEMETRY_ENDPOINT).json(&body).send().await {
        Ok(_) => Ok(()),
        Err(_) => Ok(()), // 静默：网络错误不打扰用户
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_endpoint_means_no_send() {
        // 端点为空的默认配置：should_send 为 false（命令体直接返回，不发请求、无副作用）
        assert!(!should_send(TELEMETRY_ENDPOINT));
        assert!(should_send("https://telemetry.example.com/v1/events"));
    }

    #[test]
    fn events_shape_is_structural_only() {
        // 结构约定：key/count/ts，供前端 flush 组装时对齐（纯结构断言，不真发请求）
        let e = serde_json::json!({ "key": "tool.json", "count": 3, "ts": 1700000000000i64 });
        assert_eq!(e["key"].as_str(), Some("tool.json"));
        assert_eq!(e["count"].as_u64(), Some(3));
        assert!(e["ts"].as_i64().is_some());
    }
}