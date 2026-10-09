//! 截图工具（桌面独占）：F1 冻结式截屏 + 标注 + F3 贴图。
//!
//! 分工：捕获、会话与窗口管理全在 Rust；遮罩页（index.html?shot=overlay）只负责
//! 显示冻结帧、选区与标注，把合成后的 PNG(base64) 回传，由这里落剪贴板 / 文件 /
//! 贴图窗口。窗口统一「先隐藏创建 → 页面就绪后自显」，避免加载期间的白屏全屏闪烁。
//!
//! 原生捕获只做 Windows（xcap = Windows Graphics Capture；arboard 取/写剪贴板图片），
//! 依赖按 target 条件引入；非 Windows 平台编译为空实现，接口照常提供、调用返回「不支持」。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

/// 遮罩窗口标签前缀（完整形态：shot-overlay-<会话号>-<屏号>）
pub const OVERLAY_PREFIX: &str = "shot-overlay-";
/// 贴图窗口标签前缀（完整形态：tool-pin-<序号>）
pub const PIN_PREFIX: &str = "tool-pin-";
const SETTINGS_FILE: &str = "screenshot.json";
/// 页面就绪兜底：超时未取帧，说明遮罩/贴图页没加载出来，销毁窗口并清理注册表，
/// 否则会留下「看不见但一直占着会话」的幽灵窗口，把后续 F1 全挡在门外
const PAGE_READY_TIMEOUT: Duration = Duration::from_millis(8000);
const PIN_MIN_EDGE: u32 = 24;
const PIN_MAX_ZOOM: f64 = 8.0;
const PIN_MARGIN: i32 = 8;
/// 多张贴图叠在同一位置时的级联步长
const PIN_CASCADE_STEP: i32 = 24;

#[allow(dead_code)] // 仅非 Windows 的桩函数用到（Windows 构建下这些桩不参与编译）
const NOT_WINDOWS: &str = "截图工具仅支持 Windows 桌面端";

// ---------------- 会话注册表（冻结帧） ----------------

#[derive(Clone)]
struct ShotFrame {
    index: usize,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    scale: f64,
    png: Vec<u8>,
}

struct ShotSession {
    frames: Vec<ShotFrame>,
    /// 遮罩页是否已取到帧（watchdog 只清理「从未就绪」的会话）
    ready: bool,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, ShotSession>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, ShotSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------- 贴图注册表 ----------------

struct PinEntry {
    png: Vec<u8>,
    width: u32,
    height: u32,
    /// 页面是否已取到图（watchdog 用，理由同 ShotSession.ready）
    loaded: bool,
}

static PINS: OnceLock<Mutex<HashMap<String, PinEntry>>> = OnceLock::new();

fn pins() -> &'static Mutex<HashMap<String, PinEntry>> {
    PINS.get_or_init(|| Mutex::new(HashMap::new()))
}

static SEQ: AtomicU64 = AtomicU64::new(1);

fn next_seq() -> u64 {
    SEQ.fetch_add(1, Ordering::Relaxed)
}

// ---------------- 设置与热键 ----------------

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ShotSettings {
    pub capture_hotkey: String,
    pub pin_hotkey: String,
}

impl Default for ShotSettings {
    fn default() -> Self {
        Self {
            capture_hotkey: "F1".to_string(),
            pin_hotkey: "F3".to_string(),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HotkeyInfo {
    pub capture_hotkey: String,
    pub pin_hotkey: String,
    pub capture_registered: bool,
    pub pin_registered: bool,
}

struct HotkeyRuntime {
    settings: ShotSettings,
    capture_registered: bool,
    pin_registered: bool,
}

static HOTKEYS: OnceLock<Mutex<HotkeyRuntime>> = OnceLock::new();

fn hotkeys() -> &'static Mutex<HotkeyRuntime> {
    HOTKEYS.get_or_init(|| {
        Mutex::new(HotkeyRuntime {
            settings: ShotSettings::default(),
            capture_registered: false,
            pin_registered: false,
        })
    })
}

fn settings_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE))
        .map_err(|e| format!("定位配置目录失败：{e}"))
}

fn load_settings(app: &AppHandle) -> ShotSettings {
    settings_path(app)
        .ok()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, settings: &ShotSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("写入 {SETTINGS_FILE} 失败：{e}"))
}

/// 启动时注册热键：读配置（缺省 F1/F3），逐个尽力注册，被占用只记状态不阻断启动。
pub fn init(app: &AppHandle) {
    let settings = load_settings(app);
    let capture_ok = register_capture_hotkey(app, &settings.capture_hotkey);
    let pin_ok = register_pin_hotkey(app, &settings.pin_hotkey);
    let mut rt = hotkeys().lock().unwrap();
    rt.settings = settings;
    rt.capture_registered = capture_ok;
    rt.pin_registered = pin_ok;
}

fn register_capture_hotkey(app: &AppHandle, accelerator: &str) -> bool {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let accel = accelerator.trim();
    if accel.is_empty() {
        return false;
    }
    let result = app
        .global_shortcut()
        .on_shortcut(accel, |app, _shortcut, event| {
            // Windows 的热键事件按按下/抬起成对到达，只在按下时动作，避免截两次
            if event.state == ShortcutState::Pressed {
                begin_capture(app);
            }
        });
    match result {
        Ok(()) => true,
        Err(e) => {
            eprintln!("截图热键 {accel} 注册失败（可能被其它程序占用）：{e}");
            false
        }
    }
}

fn register_pin_hotkey(app: &AppHandle, accelerator: &str) -> bool {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let accel = accelerator.trim();
    if accel.is_empty() {
        return false;
    }
    let result = app
        .global_shortcut()
        .on_shortcut(accel, |app, _shortcut, event| {
            if event.state == ShortcutState::Pressed {
                if let Err(e) = pin_from_clipboard(app) {
                    eprintln!("F3 贴图未执行：{e}");
                }
            }
        });
    match result {
        Ok(()) => true,
        Err(e) => {
            eprintln!("贴图热键 {accel} 注册失败（可能被其它程序占用）：{e}");
            false
        }
    }
}

fn unregister_quiet(app: &AppHandle, accelerator: &str) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let accel = accelerator.trim();
    if accel.is_empty() {
        return;
    }
    let _ = app.global_shortcut().unregister(accel);
}

fn validate_accelerator(accelerator: &str) -> Result<(), String> {
    use std::str::FromStr;
    let accel = accelerator.trim();
    if accel.is_empty() {
        return Ok(()); // 空串 = 关闭该热键
    }
    tauri_plugin_global_shortcut::Shortcut::from_str(accel)
        .map(|_| ())
        .map_err(|e| format!("「{accelerator}」不是有效的快捷键：{e}"))
}

#[tauri::command]
pub fn screenshot_settings_get() -> HotkeyInfo {
    let rt = hotkeys().lock().unwrap();
    HotkeyInfo {
        capture_hotkey: rt.settings.capture_hotkey.clone(),
        pin_hotkey: rt.settings.pin_hotkey.clone(),
        capture_registered: rt.capture_registered,
        pin_registered: rt.pin_registered,
    }
}

/// 修改热键：先校验 → 卸旧 → 注新；任何一步失败都回滚到原状态并说明原因，
/// 避免「设置里显示 F1，实际没注册」这种两处漂移。
#[tauri::command]
pub fn screenshot_settings_set(
    app: AppHandle,
    capture_hotkey: String,
    pin_hotkey: String,
) -> Result<HotkeyInfo, String> {
    let capture = capture_hotkey.trim().to_string();
    let pin = pin_hotkey.trim().to_string();
    validate_accelerator(&capture)?;
    validate_accelerator(&pin)?;
    if !capture.is_empty() && capture.eq_ignore_ascii_case(&pin) {
        return Err("截图与贴图不能绑定同一个快捷键".to_string());
    }

    let (old_settings, old_flags) = {
        let rt = hotkeys().lock().unwrap();
        (rt.settings.clone(), (rt.capture_registered, rt.pin_registered))
    };

    unregister_quiet(&app, &old_settings.capture_hotkey);
    unregister_quiet(&app, &old_settings.pin_hotkey);
    let capture_ok = register_capture_hotkey(&app, &capture);
    let pin_ok = register_pin_hotkey(&app, &pin);

    let capture_failed = !capture.is_empty() && !capture_ok;
    let pin_failed = !pin.is_empty() && !pin_ok;
    let mut persist_error: Option<String> = None;
    if !capture_failed && !pin_failed {
        persist_error = save_settings(
            &app,
            &ShotSettings { capture_hotkey: capture.clone(), pin_hotkey: pin.clone() },
        )
        .err();
    }

    if capture_failed || pin_failed || persist_error.is_some() {
        // 回滚：卸掉刚注册的，按原配置重建
        unregister_quiet(&app, &capture);
        unregister_quiet(&app, &pin);
        let back_capture = old_flags.0 && register_capture_hotkey(&app, &old_settings.capture_hotkey);
        let back_pin = old_flags.1 && register_pin_hotkey(&app, &old_settings.pin_hotkey);
        let mut rt = hotkeys().lock().unwrap();
        rt.capture_registered = back_capture;
        rt.pin_registered = back_pin;
        let shown = if capture_failed { &capture } else { &pin };
        return Err(match persist_error {
            Some(e) => format!("{e}（快捷键未改动）"),
            None => format!("「{shown}」注册失败（可能被其它程序占用），已恢复原快捷键"),
        });
    }

    let mut rt = hotkeys().lock().unwrap();
    rt.settings = ShotSettings { capture_hotkey: capture.clone(), pin_hotkey: pin.clone() };
    rt.capture_registered = capture_ok && !capture.is_empty();
    rt.pin_registered = pin_ok && !pin.is_empty();
    Ok(HotkeyInfo {
        capture_hotkey: rt.settings.capture_hotkey.clone(),
        pin_hotkey: rt.settings.pin_hotkey.clone(),
        capture_registered: rt.capture_registered,
        pin_registered: rt.pin_registered,
    })
}

// ---------------- 截屏会话 ----------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct FrameInfo {
    pub index: usize,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub count: usize,
    pub png_b64: String,
}

/// 发起一次截屏（F1 与工具页按钮共用入口）。
/// 捕获在工作线程完成（大屏 PNG 编码可达数百毫秒，不能卡事件循环），
/// 窗口创建回主线程执行——热键回调本身跑在 global-hotkey 的事件线程上。
pub fn begin_capture(app: &AppHandle) {
    // 已有存活会话则忽略本次（按住热键的系统重复、或用户重复按键都不会叠窗）；
    // 窗口已消失的残留会话先清掉，避免幽灵会话把 F1 永久挡在门外
    {
        let stale: Vec<String> = sessions()
            .lock()
            .unwrap()
            .keys()
            .filter(|sid| !session_still_live(app, sid))
            .cloned()
            .collect();
        if !stale.is_empty() {
            for sid in stale {
                finish_session(app, &sid);
            }
        }
        if !sessions().lock().unwrap().is_empty() {
            return;
        }
    }

    let app = app.clone();
    std::thread::spawn(move || match capture_all_monitors() {
        Ok(frames) => {
            let session_id = next_seq().to_string();
            let geometry: Vec<(usize, i32, i32, u32, u32)> = frames
                .iter()
                .map(|f| (f.index, f.x, f.y, f.width, f.height))
                .collect();
            sessions().lock().unwrap().insert(
                session_id.clone(),
                ShotSession { frames, ready: false },
            );

            // 主线程建窗；从后台线程 run_on_main_thread 是异步投递，这里等一下结果
            let (tx, rx) = std::sync::mpsc::channel();
            let app_build = app.clone();
            let sid = session_id.clone();
            let scheduled = app.run_on_main_thread(move || {
                let _ = tx.send(create_overlay_windows(&app_build, &sid, &geometry));
            });
            let created = match scheduled {
                Ok(()) => rx.recv_timeout(Duration::from_secs(10)).unwrap_or(0),
                Err(e) => {
                    eprintln!("调度遮罩窗口创建失败：{e}");
                    0
                }
            };
            if created == 0 {
                finish_session(&app, &session_id);
                notify_user(&app, "captureFail", Some("无法创建全屏遮罩窗口"));
                return;
            }
            start_session_watchdog(app, session_id);
        }
        Err(e) => notify_user(&app, "captureFail", Some(&e)),
    });
}

/// 工具页「立即截图」按钮：与 F1 热键同一入口
#[tauri::command]
pub fn screenshot_begin(app: AppHandle) {
    begin_capture(&app);
}

/// 遮罩页取帧：顺带把该会话标记为「已就绪」，页面就绪后由页面 show 自己
#[tauri::command]
pub fn screenshot_frame(session_id: String, monitor: usize) -> Result<FrameInfo, String> {
    let mut guard = sessions().lock().unwrap();
    let session = guard
        .get_mut(&session_id)
        .ok_or_else(|| "截图会话已结束".to_string())?;
    session.ready = true;
    let count = session.frames.len();
    let frame = session
        .frames
        .iter()
        .find(|f| f.index == monitor)
        .ok_or_else(|| "显示器不存在".to_string())?;
    Ok(FrameInfo {
        index: frame.index,
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        scale: frame.scale,
        count,
        png_b64: B64.encode(&frame.png),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 确认本次截图：把遮罩页合成好的 PNG 落剪贴板 / 文件 / 贴图窗口，随后收掉所有遮罩。
/// 动作失败时**不**收遮罩——用户还在选区内，可以改存为文件或重试。
#[tauri::command]
pub fn screenshot_commit(
    app: AppHandle,
    session_id: String,
    action: String,
    data_b64: String,
    path: Option<String>,
    pin_rect: Option<PinRect>,
) -> Result<(), String> {
    let png = B64
        .decode(data_b64.trim())
        .map_err(|e| format!("结果图片数据无效：{e}"))?;
    match action.as_str() {
        "copy" => clipboard_set_png(&png)?,
        "save" => {
            let target = path.ok_or_else(|| "缺少保存路径".to_string())?;
            std::fs::write(&target, &png).map_err(|e| format!("保存失败：{e}"))?;
        }
        "pin" => {
            let at = pin_rect.and_then(|r| {
                // 宽高只作合法性守卫（0 / NaN 说明前端算错），异常时退回光标落点
                (r.width.is_finite() && r.width > 1.0 && r.height.is_finite() && r.height > 1.0)
                    .then_some((r.x.round() as i32, r.y.round() as i32))
            });
            create_pin(&app, png, at)?;
        }
        other => return Err(format!("未知的截图操作：{other}")),
    }
    finish_session(&app, &session_id);
    Ok(())
}

/// 取消本次截图（Esc / 右键退出）：收掉遮罩与冻结帧
#[tauri::command]
pub fn screenshot_cancel(app: AppHandle, session_id: String) {
    finish_session(&app, &session_id);
}

fn finish_session(app: &AppHandle, session_id: &str) {
    sessions().lock().unwrap().remove(session_id);
    destroy_overlay_windows(app, session_id);
}

fn destroy_overlay_windows(app: &AppHandle, session_id: &str) {
    let prefix = format!("{OVERLAY_PREFIX}{session_id}-");
    let app_task = app.clone();
    let _ = app.run_on_main_thread(move || {
        for (label, win) in app_task.webview_windows() {
            if label.starts_with(&prefix) {
                let _ = win.destroy();
            }
        }
    });
}

/// 会话的遮罩窗是否至少有一扇可见在屏
fn session_still_live(app: &AppHandle, session_id: &str) -> bool {
    let prefix = format!("{OVERLAY_PREFIX}{session_id}-");
    app.webview_windows()
        .values()
        .any(|win| win.label().starts_with(&prefix) && win.is_visible().unwrap_or(false))
}

fn start_session_watchdog(app: AppHandle, session_id: String) {
    std::thread::spawn(move || {
        std::thread::sleep(PAGE_READY_TIMEOUT);
        let stale = {
            let mut guard = sessions().lock().unwrap();
            match guard.get(&session_id) {
                Some(session) if !session.ready => {
                    guard.remove(&session_id);
                    true
                }
                _ => false,
            }
        };
        if stale {
            destroy_overlay_windows(&app, &session_id);
            notify_user(&app, "captureFail", Some("遮罩页加载超时"));
        }
    });
}

fn create_overlay_windows(
    app: &AppHandle,
    session_id: &str,
    geometry: &[(usize, i32, i32, u32, u32)],
) -> usize {
    let mut created = 0;
    for (index, x, y, width, height) in geometry {
        let label = format!("{OVERLAY_PREFIX}{session_id}-{index}");
        let url = format!("index.html?shot=overlay&session={session_id}&monitor={index}");
        let built = WebviewWindowBuilder::new(app, &label, WebviewUrl::App(url.into()))
            .title("")
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .maximizable(false)
            .minimizable(false)
            .shadow(false)
            .visible(false)
            .focused(false)
            .build();
        match built {
            Ok(win) => {
                // 位置与尺寸用物理像素精确摆放：builder 的 position/inner_size 是逻辑像素，
                // 多屏混合 DPI 下会算歪；隐藏状态下搬窗用户不可见
                let _ = win.set_position(tauri::PhysicalPosition::new(*x, *y));
                let _ = win.set_size(tauri::PhysicalSize::new(*width, *height));
                created += 1;
            }
            Err(e) => eprintln!("创建遮罩窗口 {label} 失败：{e}"),
        }
    }
    created
}

// ---------------- 贴图 ----------------

fn pin_from_clipboard(app: &AppHandle) -> Result<String, String> {
    match clipboard_image_png()? {
        Some(png) => create_pin(app, png, None),
        None => {
            notify_user(app, "noClipboardImage", None);
            Err("剪贴板里没有图片".to_string())
        }
    }
}

/// F3：把剪贴板里的图片贴到屏幕上
#[tauri::command]
pub fn pin_create_from_clipboard(app: AppHandle) -> Result<String, String> {
    pin_from_clipboard(&app)
}

#[tauri::command]
pub fn pin_image(label: String) -> Result<String, String> {
    let mut guard = pins().lock().unwrap();
    let entry = guard.get_mut(&label).ok_or_else(|| "贴图已关闭".to_string())?;
    entry.loaded = true;
    Ok(B64.encode(&entry.png))
}

#[tauri::command]
pub fn pin_copy(label: String) -> Result<(), String> {
    let png = {
        let guard = pins().lock().unwrap();
        guard
            .get(&label)
            .map(|entry| entry.png.clone())
            .ok_or_else(|| "贴图已关闭".to_string())?
    };
    clipboard_set_png(&png)
}

/// 滚轮缩放：以光标为锚点（光标下的图像点在缩放前后保持不动）；
/// factor <= 0 意为「重置为原始尺寸」，此时保持窗口中心不动。
#[tauri::command]
pub fn pin_zoom(app: AppHandle, label: String, factor: f64) -> Result<(), String> {
    let (orig_w, orig_h) = {
        let guard = pins().lock().unwrap();
        let entry = guard.get(&label).ok_or_else(|| "贴图已关闭".to_string())?;
        (entry.width, entry.height)
    };
    let win = app
        .get_webview_window(&label)
        .ok_or_else(|| "贴图已关闭".to_string())?;
    let size = win.outer_size().map_err(|e| e.to_string())?;
    let pos = win.outer_position().map_err(|e| e.to_string())?;
    let cursor = cursor_position().unwrap_or((
        pos.x + size.width as i32 / 2,
        pos.y + size.height as i32 / 2,
    ));
    let (new_w, new_h, new_x, new_y) = if factor <= 0.0 {
        // 重置：回原始尺寸（超出显示器时按创建时的同一规则缩放），窗口中心保持不动
        let (_, _, fit_w, fit_h) =
            pin_geometry(orig_w, orig_h, (pos.x, pos.y), monitor_bounds_at(Some((pos.x, pos.y))));
        let center_x = pos.x + size.width as i32 / 2;
        let center_y = pos.y + size.height as i32 / 2;
        (fit_w, fit_h, center_x - fit_w as i32 / 2, center_y - fit_h as i32 / 2)
    } else {
        let (w, h) = zoomed_size(size.width, size.height, orig_w, factor);
        let (x, y) = zoom_anchor_position(
            pos.x, pos.y, size.width, size.height, w, h, cursor.0, cursor.1,
        );
        (w, h, x, y)
    };
    let win_apply = win.clone();
    let _ = app.run_on_main_thread(move || {
        let _ = win_apply.set_size(tauri::PhysicalSize::new(new_w, new_h));
        let _ = win_apply.set_position(tauri::PhysicalPosition::new(new_x, new_y));
    });
    Ok(())
}

#[tauri::command]
pub fn pin_close(app: AppHandle, label: String) {
    pins().lock().unwrap().remove(&label);
    let app_task = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(win) = app_task.get_webview_window(&label) {
            let _ = win.destroy();
        }
    });
}

/// 创建贴图窗口：`at` 为期望的屏幕物理坐标（截图原位）；None 时贴着光标级联。
fn create_pin(app: &AppHandle, png: Vec<u8>, at: Option<(i32, i32)>) -> Result<String, String> {
    let (width, height) = png_dimensions(&png).ok_or_else(|| "图片数据不是有效 PNG".to_string())?;
    let seq = next_seq();
    let label = format!("{PIN_PREFIX}{seq}");

    let cursor = cursor_position();
    let preferred = match at {
        Some(point) => point,
        None => {
            let (cx, cy) = cursor.unwrap_or((120, 120));
            let offset = (seq % 8) as i32 * PIN_CASCADE_STEP;
            (cx - PIN_CASCADE_STEP + offset, cy - PIN_CASCADE_STEP + offset)
        }
    };
    let monitor = monitor_bounds_at(at.or(cursor));
    let (x, y, win_w, win_h) = pin_geometry(width, height, preferred, monitor);

    pins().lock().unwrap().insert(
        label.clone(),
        PinEntry { png, width, height, loaded: false },
    );

    let (tx, rx) = std::sync::mpsc::channel();
    let app_build = app.clone();
    let label_build = label.clone();
    let scheduled = app.run_on_main_thread(move || {
        let url = "index.html?shot=pin".to_string();
        let result = WebviewWindowBuilder::new(
            &app_build,
            &label_build,
            WebviewUrl::App(url.into()),
        )
        .title("")
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .shadow(false)
        .visible(false)
        // 贴图不该抢焦点：在别处打字时按 F3，输入焦点要留在原处
        .focused(false)
        .build()
        .map_err(|e| format!("创建贴图窗口失败：{e}"))
        .and_then(|win| {
            win.set_position(tauri::PhysicalPosition::new(x, y))
                .map_err(|e| e.to_string())?;
            win.set_size(tauri::PhysicalSize::new(win_w, win_h))
                .map_err(|e| e.to_string())
        });
        let _ = tx.send(result);
    });
    let outcome = match scheduled {
        Ok(()) => rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| "创建贴图窗口超时".to_string())?,
        Err(e) => Err(format!("调度贴图窗口创建失败：{e}")),
    };
    if let Err(e) = outcome {
        pins().lock().unwrap().remove(&label);
        return Err(e);
    }
    start_pin_watchdog(app.clone(), label.clone());
    Ok(label)
}

fn start_pin_watchdog(app: AppHandle, label: String) {
    std::thread::spawn(move || {
        std::thread::sleep(PAGE_READY_TIMEOUT);
        let stale = {
            let mut guard = pins().lock().unwrap();
            match guard.get(&label) {
                Some(entry) if !entry.loaded => {
                    guard.remove(&label);
                    true
                }
                _ => false,
            }
        };
        if stale {
            let app_task = app.clone();
            let _ = app.run_on_main_thread(move || {
                if let Some(win) = app_task.get_webview_window(&label) {
                    let _ = win.destroy();
                }
            });
        }
    });
}

/// 窗口销毁兜底（lib.rs 的 on_window_event 转发）：
/// 贴图清注册表；遮罩在该会话的最后一扇窗销毁时清会话，防冻结帧常驻内存。
pub fn on_window_destroyed(app: &AppHandle, label: &str) {
    if label.starts_with(PIN_PREFIX) {
        pins().lock().unwrap().remove(label);
        return;
    }
    if let Some(rest) = label.strip_prefix(OVERLAY_PREFIX) {
        if let Some((session_id, _index)) = rest.rsplit_once('-') {
            let prefix = format!("{OVERLAY_PREFIX}{session_id}-");
            let remaining = app
                .webview_windows()
                .keys()
                .any(|other| other != label && other.starts_with(&prefix));
            if !remaining {
                sessions().lock().unwrap().remove(session_id);
            }
        }
    }
}

// ---------------- 纯函数（可单测） ----------------

/// 从 PNG 的 IHDR 读尺寸：只需前 24 字节，避免整图解码
fn png_dimensions(png: &[u8]) -> Option<(u32, u32)> {
    const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
    if png.len() < 24 || png[..8] != SIGNATURE || &png[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes(png[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(png[20..24].try_into().ok()?);
    (width > 0 && height > 0).then_some((width, height))
}

/// 贴图窗口几何：图像大于显示器先等比缩到显示器内（内留 8px 边距），
/// 再把窗口整体钳进显示器，保证任何显示器配置下贴图都完整可见
fn pin_geometry(
    image_w: u32,
    image_h: u32,
    preferred: (i32, i32),
    monitor: (i32, i32, u32, u32),
) -> (i32, i32, u32, u32) {
    let (mx, my, mw, mh) = monitor;
    let avail_w = (mw as i32 - PIN_MARGIN * 2).max(PIN_MIN_EDGE as i32) as u32;
    let avail_h = (mh as i32 - PIN_MARGIN * 2).max(PIN_MIN_EDGE as i32) as u32;
    let (win_w, win_h) = if image_w > avail_w || image_h > avail_h {
        let k = (avail_w as f64 / image_w as f64).min(avail_h as f64 / image_h as f64);
        (
            ((image_w as f64 * k).round() as u32).max(PIN_MIN_EDGE),
            ((image_h as f64 * k).round() as u32).max(PIN_MIN_EDGE),
        )
    } else {
        (image_w, image_h)
    };
    let min_x = mx + PIN_MARGIN;
    let min_y = my + PIN_MARGIN;
    let max_x = (mx + mw as i32 - win_w as i32 - PIN_MARGIN).max(min_x);
    let max_y = (my + mh as i32 - win_h as i32 - PIN_MARGIN).max(min_y);
    let x = preferred.0.clamp(min_x, max_x);
    let y = preferred.1.clamp(min_y, max_y);
    (x, y, win_w, win_h)
}

/// 缩放后的窗口尺寸：保持当前长宽比，限制在最小边与「原图 8 倍」之间
fn zoomed_size(current_w: u32, current_h: u32, orig_w: u32, factor: f64) -> (u32, u32) {
    let factor = factor.clamp(0.2, 5.0);
    let aspect = current_w.max(1) as f64 / current_h.max(1) as f64;
    let max_w = (orig_w as f64 * PIN_MAX_ZOOM).max(PIN_MIN_EDGE as f64);
    let target_w = (current_w.max(1) as f64 * factor).clamp(PIN_MIN_EDGE as f64, max_w);
    let target_h = (target_w / aspect).max(PIN_MIN_EDGE as f64);
    (target_w.round() as u32, target_h.round() as u32)
}

/// 以光标为锚点缩放：重排窗口位置，使光标下的图像点在缩放前后保持不动
#[allow(clippy::too_many_arguments)]
fn zoom_anchor_position(
    pos_x: i32,
    pos_y: i32,
    old_w: u32,
    old_h: u32,
    new_w: u32,
    new_h: u32,
    cursor_x: i32,
    cursor_y: i32,
) -> (i32, i32) {
    let kx = new_w as f64 / old_w.max(1) as f64;
    let ky = new_h as f64 / old_h.max(1) as f64;
    let dx = (cursor_x - pos_x) as f64;
    let dy = (cursor_y - pos_y) as f64;
    (
        (cursor_x as f64 - dx * kx).round() as i32,
        (cursor_y as f64 - dy * ky).round() as i32,
    )
}

// ---------------- 平台能力（Windows 实现 / 其他平台桩） ----------------

#[cfg(windows)]
fn capture_all_monitors() -> Result<Vec<ShotFrame>, String> {
    use xcap::Monitor;
    let mut monitors = Monitor::all().map_err(|e| format!("枚举显示器失败：{e}"))?;
    if monitors.is_empty() {
        return Err("没有检测到显示器".to_string());
    }
    // 按 (x, y) 排序保证索引稳定：会话帧序、遮罩窗标签、页面参数三者一致
    monitors.sort_by_key(|m| (m.x().unwrap_or(0), m.y().unwrap_or(0)));
    let mut frames = Vec::new();
    for (index, monitor) in monitors.iter().enumerate() {
        let image = monitor
            .capture_image()
            .map_err(|e| format!("捕获显示器失败：{e}"))?;
        let (width, height) = (image.width(), image.height());
        frames.push(ShotFrame {
            index,
            x: monitor.x().unwrap_or(0),
            y: monitor.y().unwrap_or(0),
            width,
            height,
            scale: monitor.scale_factor().unwrap_or(1.0) as f64,
            png: encode_png(&image)?,
        });
    }
    Ok(frames)
}

#[cfg(not(windows))]
fn capture_all_monitors() -> Result<Vec<ShotFrame>, String> {
    Err(NOT_WINDOWS.to_string())
}

#[cfg(windows)]
fn encode_png(image: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    image
        .write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png)
        .map_err(|e| format!("编码 PNG 失败：{e}"))?;
    Ok(bytes)
}

#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut point = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

#[cfg(not(windows))]
fn cursor_position() -> Option<(i32, i32)> {
    None
}

/// 点在哪个显示器（用于把贴图钳进正确的屏幕）；取不到时假设主屏 1080p
#[cfg(windows)]
fn monitor_bounds_at(at: Option<(i32, i32)>) -> (i32, i32, u32, u32) {
    if let Some((x, y)) = at.or_else(cursor_position) {
        if let Ok(monitor) = xcap::Monitor::from_point(x, y) {
            return (
                monitor.x().unwrap_or(0),
                monitor.y().unwrap_or(0),
                monitor.width().unwrap_or(1920),
                monitor.height().unwrap_or(1080),
            );
        }
    }
    (0, 0, 1920, 1080)
}

#[cfg(not(windows))]
fn monitor_bounds_at(_at: Option<(i32, i32)>) -> (i32, i32, u32, u32) {
    (0, 0, 1920, 1080)
}

#[cfg(windows)]
fn clipboard_set_png(png: &[u8]) -> Result<(), String> {
    let image = image::load_from_memory_with_format(png, image::ImageFormat::Png)
        .map_err(|e| format!("解析图片失败：{e}"))?;
    let rgba = image.to_rgba8();
    let (width, height) = (rgba.width() as usize, rgba.height() as usize);
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败：{e}"))?;
    clipboard
        .set_image(arboard::ImageData {
            width,
            height,
            bytes: std::borrow::Cow::Owned(rgba.into_raw()),
        })
        .map_err(|e| format!("写入剪贴板失败：{e}"))
}

#[cfg(not(windows))]
fn clipboard_set_png(_png: &[u8]) -> Result<(), String> {
    Err(NOT_WINDOWS.to_string())
}

/// 读剪贴板图片并转成 PNG；剪贴板里没有图片时返回 None（区别于真错误）
#[cfg(windows)]
fn clipboard_image_png() -> Result<Option<Vec<u8>>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("打开剪贴板失败：{e}"))?;
    match clipboard.get_image() {
        Ok(data) => {
            let rgba = image::RgbaImage::from_raw(
                data.width as u32,
                data.height as u32,
                data.bytes.into_owned(),
            )
            .ok_or_else(|| "剪贴板图像数据无效".to_string())?;
            Ok(Some(encode_png(&rgba)?))
        }
        Err(arboard::Error::ContentNotAvailable) => Ok(None),
        Err(e) => Err(format!("读取剪贴板图片失败：{e}")),
    }
}

#[cfg(not(windows))]
fn clipboard_image_png() -> Result<Option<Vec<u8>>, String> {
    Err(NOT_WINDOWS.to_string())
}

fn notify_user(app: &AppHandle, key: &str, err: Option<&str>) {
    use tauri_plugin_notification::NotificationExt;
    let title = crate::localized_text(app, "/screenshot/notifyTitle")
        .unwrap_or_else(|| "截图".to_string());
    let mut body = crate::localized_text(app, &format!("/screenshot/{key}")).unwrap_or_default();
    if let Some(err) = err {
        body = body.replace("{err}", err);
    }
    if body.is_empty() {
        body = err.unwrap_or_default().to_string();
    }
    let _ = app.notification().builder().title(title).body(body).show();
}

// ---------------- 单测 ----------------

#[cfg(test)]
mod tests {
    use super::*;

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    #[test]
    fn png_dimensions_reads_ihdr_only() {
        assert_eq!(png_dimensions(&png_header(1280, 720)), Some((1280, 720)));
    }

    #[test]
    fn png_dimensions_rejects_broken_data() {
        assert_eq!(png_dimensions(b""), None);
        assert_eq!(png_dimensions(b"not a png at all, but 24 bytes long"), None);
        let mut wrong_chunk = png_header(10, 10);
        wrong_chunk[12..16].copy_from_slice(b"IDAT");
        assert_eq!(png_dimensions(&wrong_chunk), None);
        assert_eq!(png_dimensions(&png_header(0, 10)), None);
    }

    #[test]
    fn pin_geometry_keeps_image_size_when_it_fits() {
        let (x, y, w, h) = pin_geometry(400, 300, (500, 400), (0, 0, 1920, 1080));
        assert_eq!((x, y, w, h), (500, 400, 400, 300));
    }

    #[test]
    fn pin_geometry_scales_down_oversized_image() {
        let (_, _, w, h) = pin_geometry(4000, 2000, (0, 0), (0, 0, 1920, 1080));
        assert!(w <= (1920 - PIN_MARGIN * 2) as u32, "宽 {w} 应缩进显示器");
        assert!(h <= (1080 - PIN_MARGIN * 2) as u32, "高 {h} 应缩进显示器");
        let ratio = w as f64 / h as f64;
        assert!((ratio - 2.0).abs() < 0.05, "长宽比应保持，实际 {ratio}");
    }

    #[test]
    fn pin_geometry_clamps_into_monitor() {
        let (x, y, w, h) = pin_geometry(400, 300, (1900, 1070), (0, 0, 1920, 1080));
        assert_eq!((x, y), (1920 - 400 - PIN_MARGIN, 1080 - 300 - PIN_MARGIN));
        assert_eq!((w, h), (400, 300));
        // 第二块显示器（右侧）
        let (x2, y2, _, _) = pin_geometry(400, 300, (-100, -50), (1920, 0, 1920, 1080));
        assert_eq!((x2, y2), (1920 + PIN_MARGIN, PIN_MARGIN));
    }

    #[test]
    fn zoomed_size_is_bounded_and_keeps_aspect() {
        let (w, h) = zoomed_size(400, 300, 400, 1.1);
        assert_eq!((w, h), (440, 330));
        let (min_w, min_h) = zoomed_size(30, 20, 400, 0.01);
        assert_eq!(min_w, PIN_MIN_EDGE);
        assert_eq!(min_h, PIN_MIN_EDGE);
        // 单次滚轮步进被夹在 5 倍内；累计放大由「原图 8 倍」的绝对上限兜住
        let (step_w, _) = zoomed_size(400, 300, 400, 100.0);
        assert_eq!(step_w, 2000);
        let (max_w, _) = zoomed_size(3000, 2250, 400, 5.0);
        assert_eq!(max_w, (400.0 * PIN_MAX_ZOOM) as u32, "不应超过原图 8 倍");
    }

    #[test]
    fn zoom_anchor_keeps_cursor_point_fixed() {
        // 窗口 (1000,500) 400x300，光标在窗口内 (120, 90) 处；放大 2 倍后
        // 该图像点应仍在屏幕 (1120, 590)
        let (x, y) = zoom_anchor_position(1000, 500, 400, 300, 800, 600, 1120, 590);
        assert_eq!((x, y), (1120 - 240, 590 - 180));
    }

    #[test]
    fn settings_default_to_f1_f3_and_tolerate_missing_fields() {
        let partial: ShotSettings = serde_json::from_str(r#"{"captureHotkey":"Ctrl+Alt+A"}"#).unwrap();
        assert_eq!(partial.capture_hotkey, "Ctrl+Alt+A");
        assert_eq!(partial.pin_hotkey, "F3");
        let empty: ShotSettings = serde_json::from_str("{}").unwrap();
        assert_eq!(empty, ShotSettings::default());
    }

    #[test]
    fn accelerator_validation_accepts_bare_function_keys_and_rejects_junk() {
        assert!(validate_accelerator("F1").is_ok());
        assert!(validate_accelerator("Ctrl+Shift+S").is_ok());
        assert!(validate_accelerator("").is_ok());
        assert!(validate_accelerator("NotAKey").is_err());
    }
}
