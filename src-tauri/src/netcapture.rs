// 抓包工具的桌面端能力。
//
// 为什么这两件事必须在 Rust 侧，而不是直接在前端 fetch：
//
// 1. **CORS**。CDP 的 HTTP 端点（/json/version、/json/list）不返回
//    `Access-Control-Allow-Origin`。工具窗口带 Origin 去请求会被浏览器直接拒掉
//    （实测 "TypeError: Failed to fetch"），即使目标应用启动时加了
//    --remote-allow-origins=* 也一样。那个开关只管 WebSocket。
//    而 WebSocket 加了该开关后是**通的**（实测可连且 Network.enable 成功），
//    所以抓包逻辑整个留在前端，Rust 只负责「把 target 的 ws 地址查出来递过去」。
//
// 2. **拉起被抓应用**。调试端口只能在进程启动时传入，已运行的进程无法附加。
//    这不是本实现的偷懒，是 Chromium 的设计：DevToolsActivePort 里那个端口
//    是运行时临时端口，不能事后拿它连。
use std::process::{Command, Stdio};

/// 端口号必须是真实可用的范围，否则拼出来的 URL 毫无意义
fn validate_port(port: u16) -> Result<u16, String> {
    if port == 0 {
        return Err("端口必须在 1 到 65535 之间".into());
    }
    Ok(port)
}

/// 只保留真正需要抓的 target。
///
/// **iframe 必须在这里**：Qoder 的「专属活动权益」签到弹窗就是一个 type=iframe 的
/// target（https://openapi.qoder.com.cn/growth-page/activity-iframe），签到与积分
/// 请求全从它发出。漏掉这一类时，主界面照样附加成功，但一条请求都抓不到——
/// 表现像工具坏了，实际是过滤条件写窄了。JS 侧 cdp.js 的 CAPTURED_TYPES 要同步。
///
/// service_worker / background_page / extension 不接：后台请求量太大且与用户操作无关。
fn wanted_target_types() -> Vec<&'static str> {
    vec!["page", "webview", "iframe"]
}

/// 探测调试端口：返回浏览器信息与可抓的 target 清单（含 ws 地址）。
///
/// 失败以「Err」返回而不是 Ok(false)：端口不通是个明确的诊断结论，
/// 前端要拿它去提示「应用没带 --remote-debugging-port 启动」。
#[tauri::command]
pub async fn netcapture_probe(port: u16, timeout_ms: Option<u64>) -> Result<serde_json::Value, String> {
    let port = validate_port(port)?;
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(2000).clamp(200, 15000));
    let base = format!("http://127.0.0.1:{port}");
    let client = reqwest::Client::builder()
        .timeout(timeout)
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败：{e}"))?;

    let version: serde_json::Value = client
        .get(format!("{base}/json/version"))
        .send()
        .await
        .map_err(|e| {
            format!("连不上 127.0.0.1:{port}（{e}）。应用必须带 --remote-debugging-port={port} 启动，且已经完成启动。")
        })?
        .json()
        .await
        .map_err(|e| format!("解析 /json/version 失败：{e}"))?;

    let list: serde_json::Value = client
        .get(format!("{base}/json/list"))
        .send()
        .await
        .map_err(|e| format!("读取 /json/list 失败：{e}"))?
        .json()
        .await
        .map_err(|e| format!("解析 /json/list 失败：{e}"))?;

    let wanted = wanted_target_types();
    let mut targets = Vec::new();
    if let Some(items) = list.as_array() {
        for item in items {
            let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if !wanted.contains(&kind) {
                continue;
            }
            let Some(id) = item.get("id").and_then(|v| v.as_str()) else { continue };
            let Some(ws) = item.get("webSocketDebuggerUrl").and_then(|v| v.as_str()) else { continue };
            targets.push(serde_json::json!({
                "id": id,
                "type": kind,
                "title": item.get("title").and_then(|v| v.as_str()).unwrap_or(""),
                "url": item.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                "wsUrl": ws,
            }));
        }
    }

    Ok(serde_json::json!({
        "browser": version.get("Browser").and_then(|v| v.as_str()).unwrap_or(""),
        "port": port,
        "targets": targets,
    }))
}

/// 找一个可用的本机端口（让用户不必自己挑，也避免和已占用的端口撞车）。
///
/// 做法是绑到 0 号端口让系统分配，拿到后立刻释放。这中间有极小的竞态窗口
/// （释放到目标应用真正去绑之间可能被别人抢走），但比起让用户自己猜一个没人用的端口，
/// 这个代价小得多，而且真撞上了「探测端口」也会如实报错。
#[tauri::command]
pub fn netcapture_pick_port() -> Result<u16, String> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| format!("找不到可用端口：{e}"))?;
    let port = listener.local_addr().map_err(|e| format!("读取端口失败：{e}"))?.port();
    drop(listener);
    // 9222 是调试端口的习惯用法，能选到就用它，免得用户看到陌生数字犯嘀咕
    if std::net::TcpListener::bind("127.0.0.1:9222").is_ok() {
        return Ok(9222);
    }
    Ok(port)
}

/// 带调试端口启动应用（用于「先退出再重启」这一步）。
///
/// args 由前端拼装（含 --remote-debugging-port 与 --remote-allow-origins）。
/// 用 CREATE_NO_WINDOW 免得每抓一次都闪一个黑框。
///
/// 安全边界：这是一条「按用户指定路径拉起进程」的能力，所以工具标记为桌面独占。
/// 它不做任何提权，也不碰除该进程外的任何东西。
#[tauri::command]
pub fn netcapture_launch(
    exe_path: String,
    args: Vec<String>,
    env: Option<std::collections::HashMap<String, String>>,
    node_hook: Option<String>,
) -> Result<serde_json::Value, String> {
    let path = exe_path.trim();
    if path.is_empty() {
        return Err("请填写要启动的程序路径".into());
    }
    if !std::path::Path::new(path).is_file() {
        return Err(format!("找不到这个程序：{path}"));
    }

    let mut command = Command::new(path);
    command.args(&args);

    // 有些应用不接受命令行参数，只认环境变量——这已经是实测到的第二种了：
    //   Qoder:     CDP_PORT（且只在 Linux 生效）
    //   WorkBuddy: WORKBUDDY_REMOTE_DEBUGGING_PORT
    // 后者还会自己补上 --remote-allow-origins，正好是本工具需要的。
    // 没有这条通道，这类应用在 Windows 上根本抓不了。
    for (key, value) in env.unwrap_or_default() {
        command.env(key, value);
    }

    // Node 侧挂钩：把请求捕获的范围从「渲染进程」扩到「主进程」。
    //
    // Electron 主进程是 Node，它发的请求 CDP 的页面级调试看不到（实测 WorkBuddy
    // 的积分接口就是这样）。做法是把一段脚本用 NODE_OPTIONS=--require 注进去，
    // 挂钩 http/https/fetch —— 这是 HTTP Toolkit 那一派的做法：
    // **进程级注入，而不是装系统根证书做中间人**。
    //
    // 代价只落在这一个进程上：不碰系统信任库、不碰系统代理、不影响别的程序。
    let mut capture_path = String::new();
    if let Some(source) = node_hook {
        let dir = std::env::temp_dir().join("toolcove-netcapture");
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建临时目录失败：{e}"))?;
        let hook_file = dir.join("node-hook.cjs");
        std::fs::write(&hook_file, source).map_err(|e| format!("写入挂钩脚本失败：{e}"))?;
        // 每次启动都把上一轮的记录清掉，免得新旧混在一起
        let out_file = dir.join("node-capture.ndjson");
        let _ = std::fs::write(&out_file, "");
        capture_path = out_file.to_string_lossy().to_string();

        command.env("NETCAPTURE_OUT", &capture_path);
        // 追加而不是覆盖：应用可能自己就设了 NODE_OPTIONS，直接盖掉会弄坏它
        let existing = std::env::var("NODE_OPTIONS").unwrap_or_default();
        let require_arg = format!("--require \"{}\"", hook_file.to_string_lossy());
        let merged = if existing.trim().is_empty() {
            require_arg
        } else {
            format!("{existing} {require_arg}")
        };
        command.env("NODE_OPTIONS", merged);
    }

    // 必须清掉这个环境变量，否则 Electron 应用会被"降级"成纯 Node 进程。
    //
    // 踩过的坑（实测）：环境里带着 ELECTRON_RUN_AS_NODE=1 时，Electron 会完全按 Node 运行，
    // 于是：
    //   - `--remote-debugging-port=9222` 被当成非法 Node 选项，进程直接退出（bad option，退出码 9）；
    //   - `--help` 打印的是 Node 自己的帮助而不是应用的；
    //   - 表现是「点了启动、进程表里也有东西，但界面不出来、端口也不开」——
    //     看起来完全像工具坏了，实际是继承了一个不该继承的变量。
    // 从资源管理器双击不会继承它，所以「用户自己双击能打开、工具启动打不开」这种
    // 极难自查的现象就是这么来的。
    command.env_remove("ELECTRON_RUN_AS_NODE");

    // NODE_OPTIONS 只在**没有**注入挂钩时才清掉：
    // 注了挂钩时它正是我们要用的通道，清了等于白干（这一条踩过——清理写在注入后面，
    // 顺序一反就把刚设好的挂钩删了，表现是「启动正常但一条主进程请求都没有」）。
    if capture_path.is_empty() {
        command.env_remove("NODE_OPTIONS");
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        command.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    let child = command
        .spawn()
        .map_err(|e| format!("启动失败：{e}"))?;
    let pid = child.id();

    Ok(serde_json::json!({
        "pid": pid,
        "exePath": path,
        "args": args,
        // 空串表示这次没注入 Node 挂钩（只靠 CDP 抓渲染进程）
        "nodeCapturePath": capture_path,
    }))
}

/// 读取 Node 侧挂钩写下的捕获文件。
///
/// 返回**原始文本**而不是解析后的数组：这是增量追加的 NDJSON，
/// 工具那边按行处理更简单，也不需要为「读到一半的行」单独设计协议。
/// 文件不存在就返回空串，不是错误——应用可能还没发出任何请求。
#[tauri::command]
pub fn netcapture_read_node_capture(path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Ok(String::new());
    }
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("读取捕获文件失败：{e}")),
    }
}

/// 查询正在运行的进程（按名称模糊匹配），只读不杀。
///
/// 存在的意义是给出可诊断的结论：应用**已经开着**但端口探不到时，
/// 界面要说的是「它没带调试端口启动，得先退出再用本工具重启」，
/// 而不是笼统的「连不上」。这两种情况的处置完全不同。
#[tauri::command]
pub fn netcapture_find_processes(name: String, limit: Option<usize>) -> Result<serde_json::Value, String> {
    let needle = name.trim().to_lowercase();
    if needle.is_empty() {
        return Err("请填写进程名关键字".into());
    }
    let cap = limit.unwrap_or(20).clamp(1, 200);

    // tasklist 比引入 sysinfo 划算：系统自带，且 CSV 输出稳定可解析。
    let mut command = Command::new("tasklist");
    command.args(["/FO", "CSV", "/NH"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command
        .output()
        .map_err(|e| format!("调用 tasklist 失败：{e}"))?;

    let text = String::from_utf8_lossy(&output.stdout);
    let mut found = Vec::new();
    for line in text.lines() {
        // CSV 行形如 "Qoder CN.exe","1234","Console","1","120,000 K"
        let cols: Vec<&str> = line.split(',').map(|s| s.trim().trim_matches('"')).collect();
        if cols.len() < 2 {
            continue;
        }
        if !cols[0].to_lowercase().contains(&needle) {
            continue;
        }
        let pid: u32 = cols[1].parse().unwrap_or(0);
        if pid == 0 {
            continue;
        }
        found.push(serde_json::json!({ "name": cols[0], "pid": pid }));
        if found.len() >= cap {
            break;
        }
    }
    Ok(serde_json::json!({ "processes": found }))
}
