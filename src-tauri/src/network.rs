#[cfg(windows)]
use std::os::windows::process::CommandExt;
/// 本机内网 IPv4 地址（用于拼接内网更新服务器等默认地址）
#[tauri::command]
pub fn local_ip() -> Result<String, String> {
    local_ip_address::local_ip()
        .map(|ip| ip.to_string())
        .map_err(|e| format!("获取本机 IP 失败：{e}"))
}

pub fn validate_network_target(target: &str) -> Result<String, String> {
    let value = target.trim().trim_matches(['[', ']']);
    if value.is_empty() || value.len() > 253 {
        return Err("请输入有效的主机名或 IP 地址".into());
    }
    if !value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | ':'))
    {
        return Err("主机名或 IP 地址包含非法字符".into());
    }
    Ok(value.to_string())
}

/// 使用系统解析器查询主机的 IPv4/IPv6 地址。
#[tauri::command]
pub async fn network_dns_lookup(host: String) -> Result<serde_json::Value, String> {
    let host = validate_network_target(&host)?;
    tauri::async_runtime::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        let started = std::time::Instant::now();
        let mut addresses: Vec<std::net::IpAddr> = (host.as_str(), 0)
            .to_socket_addrs()
            .map_err(|e| format!("DNS 查询失败：{e}"))?
            .map(|address| address.ip())
            .collect();
        addresses.sort_by_key(|address| address.to_string());
        addresses.dedup();
        if addresses.is_empty() {
            return Err("DNS 查询未返回地址".to_string());
        }
        Ok(serde_json::json!({
            "host": host,
            "durationMs": started.elapsed().as_millis() as u64,
            "addresses": addresses.into_iter().map(|address| serde_json::json!({
                "address": address.to_string(),
                "family": if address.is_ipv4() { "IPv4" } else { "IPv6" },
            })).collect::<Vec<_>>(),
        }))
    })
    .await
    .map_err(|e| format!("DNS 查询任务异常：{e}"))?
}

/// 解析主机后逐个尝试 TCP 连接；连接失败作为检测结果返回，不抛命令错误。
#[tauri::command]
pub async fn network_tcp_check(host: String, port: u16, timeout_ms: Option<u64>) -> Result<serde_json::Value, String> {
    let host = validate_network_target(&host)?;
    if port == 0 {
        return Err("端口必须在 1 到 65535 之间".into());
    }
    let timeout_ms = timeout_ms.unwrap_or(3_000).clamp(200, 30_000);
    tauri::async_runtime::spawn_blocking(move || {
        use std::net::{TcpStream, ToSocketAddrs};
        let addresses: Vec<_> = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| format!("主机解析失败：{e}"))?
            .collect();
        if addresses.is_empty() {
            return Err("主机解析未返回地址".to_string());
        }
        let timeout = std::time::Duration::from_millis(timeout_ms);
        let started = std::time::Instant::now();
        let mut last_error = String::new();
        for address in addresses {
            match TcpStream::connect_timeout(&address, timeout) {
                Ok(stream) => {
                    drop(stream);
                    return Ok(serde_json::json!({
                        "open": true,
                        "host": host,
                        "port": port,
                        "remoteAddress": address.ip().to_string(),
                        "durationMs": started.elapsed().as_millis() as u64,
                    }));
                }
                Err(error) => last_error = error.to_string(),
            }
        }
        Ok(serde_json::json!({
            "open": false,
            "host": host,
            "port": port,
            "durationMs": started.elapsed().as_millis() as u64,
            "error": last_error,
        }))
    })
    .await
    .map_err(|e| format!("端口检测任务异常：{e}"))?
}

pub fn decode_system_output(bytes: &[u8]) -> String {
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }
    #[cfg(windows)]
    {
        let (text, _, _) = encoding_rs::GBK.decode(bytes);
        return text.into_owned();
    }
    #[cfg(not(windows))]
    String::from_utf8_lossy(bytes).into_owned()
}

pub fn run_network_process(program: &str, args: &[String]) -> Result<serde_json::Value, String> {
    let started = std::time::Instant::now();
    let mut command = std::process::Command::new(program);
    command.args(args);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = command.output().map_err(|e| format!("无法启动 {program}：{e}"))?;
    let stdout = decode_system_output(&output.stdout);
    let stderr = decode_system_output(&output.stderr);
    let text = if stderr.trim().is_empty() {
        stdout
    } else if stdout.trim().is_empty() {
        stderr
    } else {
        format!("{}\n{}", stdout.trim_end(), stderr)
    };
    Ok(serde_json::json!({
        "success": output.status.success(),
        "exitCode": output.status.code(),
        "durationMs": started.elapsed().as_millis() as u64,
        "output": text.trim().to_string(),
    }))
}

/// 调用系统 Ping，目标经过白名单校验且始终作为独立参数传递。
#[tauri::command]
pub async fn network_ping(target: String, count: Option<u8>, timeout_ms: Option<u64>) -> Result<serde_json::Value, String> {
    let target = validate_network_target(&target)?;
    let count = count.unwrap_or(4).clamp(1, 10).to_string();
    let timeout = timeout_ms.unwrap_or(1_000).clamp(200, 10_000).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let args = vec!["-n".into(), count, "-w".into(), timeout, target];
        #[cfg(not(windows))]
        let args = vec!["-c".into(), count, "-W".into(), ((timeout.parse::<u64>().unwrap_or(1_000) + 999) / 1_000).to_string(), target];
        run_network_process("ping", &args)
    })
    .await
    .map_err(|e| format!("Ping 任务异常：{e}"))?
}

/// 调用系统路由跟踪，限制最大跳数与单跳等待时间。
#[tauri::command]
pub async fn network_trace(target: String, max_hops: Option<u8>, timeout_ms: Option<u64>) -> Result<serde_json::Value, String> {
    let target = validate_network_target(&target)?;
    let max_hops = max_hops.unwrap_or(15).clamp(1, 30).to_string();
    let timeout = timeout_ms.unwrap_or(1_000).clamp(200, 5_000).to_string();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(windows)]
        let (program, args) = ("tracert", vec!["-d".into(), "-h".into(), max_hops, "-w".into(), timeout, target]);
        #[cfg(not(windows))]
        let (program, args) = ("traceroute", vec!["-n".into(), "-m".into(), max_hops, "-w".into(), ((timeout.parse::<u64>().unwrap_or(1_000) + 999) / 1_000).to_string(), target]);
        run_network_process(program, &args)
    })
    .await
    .map_err(|e| format!("路由跟踪任务异常：{e}"))?
}

/// 返回本机所有可枚举的 IPv4/IPv6 网络接口地址。
#[tauri::command]
pub async fn network_interfaces() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut interfaces = local_ip_address::list_afinet_netifas()
            .map_err(|e| format!("获取网络接口失败：{e}"))?;
        interfaces.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.to_string().cmp(&b.1.to_string())));
        Ok(serde_json::json!({
            "hostname": std::env::var("COMPUTERNAME")
                .or_else(|_| std::env::var("HOSTNAME"))
                .unwrap_or_default(),
            "interfaces": interfaces.into_iter().map(|(name, address)| serde_json::json!({
                "name": name,
                "address": address.to_string(),
                "family": if address.is_ipv4() { "IPv4" } else { "IPv6" },
                "loopback": address.is_loopback(),
            })).collect::<Vec<_>>(),
        }))
    })
    .await
    .map_err(|e| format!("网络接口任务异常：{e}"))?
}


/// 请求工具通用 HTTP 代理：在原生侧发任意请求，规避浏览器 CORS。
/// 无论 HTTP 状态码是多少都返回 Ok（状态码交给前端展示），仅网络层失败返回 Err。
#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<String>,
    timeout_ms: Option<u64>,
) -> Result<serde_json::Value, String> {
    let u = url.trim();
    if u.is_empty() {
        return Err("请输入请求 URL".into());
    }
    if !u.starts_with("http://") && !u.starts_with("https://") {
        return Err("URL 需以 http:// 或 https:// 开头".into());
    }
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|_| format!("非法请求方法：{}", method))?;

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms.unwrap_or(30_000).clamp(1_000, 120_000)))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.request(m, u);
    for (k, v) in &headers {
        if !k.trim().is_empty() {
            req = req.header(k.trim(), v.as_str());
        }
    }
    if let Some(b) = body {
        if !b.is_empty() {
            req = req.body(b);
        }
    }

    let started = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| format!("请求失败：{}", e))?;
    let status = resp.status();
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
        .collect();
    let bytes = resp.bytes().await.map_err(|e| format!("读取响应失败：{}", e))?;
    let duration_ms = started.elapsed().as_millis() as u64;
    let size = bytes.len();
    // 响应体按 UTF-8 文本返回（非文本内容损失替换，请求工具以接口调试为主）；
    // 非 UTF-8（文件流等二进制）时附加 bodyBase64，供前端「保存为文件」原样落盘。
    let mut payload = serde_json::json!({
        "status": status.as_u16(),
        "statusText": status.canonical_reason().unwrap_or(""),
        "headers": resp_headers,
        "durationMs": duration_ms,
        "size": size,
    });
    if let Ok(text) = std::str::from_utf8(&bytes) {
        payload["body"] = serde_json::json!(text);
    } else {
        payload["body"] = serde_json::json!(String::from_utf8_lossy(&bytes));
        use base64::Engine;
        payload["bodyBase64"] = serde_json::json!(base64::engine::general_purpose::STANDARD.encode(bytes.as_ref()));
    }
    Ok(payload)
}
