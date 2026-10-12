//! 原生截图遮罩：纯 Win32 窗口 + GDI/GDI+ 绘制，不经过 WebView、不走 IPC。
//!
//! 为什么这么做：WebView 版 F1 → 遮罩出现的耗时几乎全在「建 WebView 窗 + 加载页面 +
//! 冻结帧编码/base64 往返/解码」上。原生版从捕获到画面只做一次 GDI 位图搬移——
//! 量级是「抓帧本身的耗时」，与 Snipaste 同级；代价是标注 UI 全在 Rust 里自绘。
//!
//! 线程模型：一个专属线程建全部遮罩窗（每屏一个）并跑自己的消息泵；状态放在线程局部，
//! 不做跨线程共享。捕获线程把 RGBA 交进来，绘制全在这里完成。

mod paint;
mod state;

use std::cell::RefCell;
use std::collections::HashMap;

use tauri::AppHandle;
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::HDC;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetKeyState, SetFocus};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CallWindowProcW, CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW, LoadCursorW,
    PostQuitMessage, RegisterClassW, SetForegroundWindow, SetWindowLongPtrW, ShowWindow, TranslateMessage, CS_DBLCLKS, ES_AUTOHSCROLL,
    ES_LEFT, GWLP_WNDPROC, IDC_CROSS, WM_SETFONT, IDC_SIZENESW, IDC_SIZENS, IDC_SIZENWSE, IDC_SIZEWE, MSG, SW_SHOW, WM_DESTROY, WM_ERASEBKGND,
    WM_KEYDOWN, WM_KILLFOCUS, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_MOUSEWHEEL, WM_PAINT, WM_RBUTTONUP, WM_SETCURSOR, WNDCLASSW,
    WS_CHILD, WS_EX_TOOLWINDOW, WS_EX_TOPMOST, WS_POPUP, WS_VISIBLE,
};
use windows_sys::Win32::Graphics::Gdi::{InvalidateRect, UpdateWindow};

use state::{
    clamp_rect, hit_handle, hit_toolbar, move_rect, nudge_rect, rect_from_points, resize_rect, toolbar_item_widths, toolbar_layout, History,
    Op, Rect, Tool, ToolbarItem, LINE_WIDTHS, MIN_SELECTION, PALETTE, TEXT_SIZES, TOOLS, VK_CONTROL, VK_DOWN, VK_ESCAPE, VK_F3, VK_LEFT,
    VK_RETURN, VK_RIGHT, VK_SHIFT, VK_UP,
};

use crate::screenshot::{self, ShotMonitor};

/// 会话是否在进行中（供 screenshot.rs 防重入）
static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn is_active() -> bool {
    ACTIVE.load(std::sync::atomic::Ordering::Relaxed)
}

const CLASS_NAME: &str = "ToolCoveShotOverlay";
/// 文本 EDIT 子控件的控件 id
const EDIT_ID: i32 = 0x5348;

struct UxText {
    copy: String,
    save: String,
    pin: String,
    tools: Vec<String>,
    hint: String,
}

struct WinState {
    monitor_index: usize,
    frame: paint::Dib,
    dim: paint::Dib,
    canvas: paint::Dib,
    sel: Option<Rect>,
    tool: Option<Tool>,
    color: u32,
    width_idx: usize,
    history: History,
    draft: Option<Op>,
    drag: Option<Drag>,
    cursor: (i32, i32),
    hover_handle: Option<&'static str>,
    hover_item: Option<ToolbarItem>,
    edit: HWND,
    edit_at: Option<(i32, i32)>,
    /// 进入文本输入前的原窗口过程（子类化时需要）
    edit_prev_proc: isize,
}

enum Drag {
    Select { start: (i32, i32) },
    Move { start: (i32, i32), origin: Rect },
    Resize { handle: &'static str },
    Draw { start: (i32, i32) },
}

struct Ctx {
    app: AppHandle,
    monitors: Vec<ShotMonitor>,
    text: UxText,
    font: String,
    windows: HashMap<isize, WinState>,
    finished: bool,
}

thread_local! {
    static CTX: RefCell<Option<Ctx>> = RefCell::new(None);
}

fn with_ctx<R>(f: impl FnOnce(&mut Ctx) -> R) -> Option<R> {
    CTX.with(|c| {
        let mut guard = c.borrow_mut();
        guard.as_mut().map(f)
    })
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

use windows_sys::core::PCWSTR;

fn pcw(s: &[u16]) -> PCWSTR {
    s.as_ptr()
}

/// 打开原生遮罩（在调用线程之外起专属 UI 线程）
pub fn open(app: AppHandle, monitors: Vec<ShotMonitor>, frames: Vec<(usize, image::RgbaImage)>) {
    if ACTIVE.swap(true, std::sync::atomic::Ordering::Relaxed) {
        return; // 已有会话
    }
    std::thread::spawn(move || {
        run_overlay(app, monitors, frames);
        ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
    });
}

fn run_overlay(app: AppHandle, monitors: Vec<ShotMonitor>, frames: Vec<(usize, image::RgbaImage)>) {
    paint::ensure_gdiplus();

    // i18n 文案（原生侧没有 WebView，直接读前端字典）
    let t = |key: &str, fallback: &str| -> String {
        crate::localized_text(&app, &format!("/screenshot/{key}")).unwrap_or_else(|| fallback.to_string())
    };
    let text = UxText {
        copy: t("copy", "复制"),
        save: t("save", "保存"),
        pin: t("pin", "贴图"),
        tools: TOOLS
            .iter()
            .enumerate()
            .map(|(i, tool)| t(tool.name_key(), ["矩形", "椭圆", "箭头", "画笔", "记号笔", "文字", "马赛克"][i]))
            .collect(),
        hint: t("hint", "Enter 复制 · Ctrl+S 另存为 · F3 贴图 · Ctrl+Z 撤销 · Esc 取消"),
    };

    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let class = wide(CLASS_NAME);
        let wc = WNDCLASSW {
            style: CS_DBLCLKS,
            lpfnWndProc: Some(wndproc),
            hInstance: hinstance,
            hCursor: LoadCursorW(std::ptr::null_mut(), IDC_CROSS),
            lpszClassName: pcw(&class),
            ..std::mem::zeroed()
        };
        RegisterClassW(&wc);

        // 组装状态（DIB 都在本线程创建与销毁；每屏一份，按顺序与窗口一一对应）
        let mut pending: Vec<WinState> = Vec::new();
        for monitor in &monitors {
            let Some((_, rgba)) = frames.iter().find(|(i, _)| *i == monitor.index) else {
                continue;
            };
            let (w, h) = (rgba.width() as i32, rgba.height() as i32);
            let bytes = rgba.as_raw();
            let frame_dib = paint::Dib::from_rgba(bytes, w, h);
            let mut dim_dib = paint::Dib::new(w, h);
            dim_dib.fill_dim_from_rgba(bytes, 0.45); // 暗化 55%
            let canvas_dib = paint::Dib::new(w, h);
            pending.push(WinState {
                monitor_index: monitor.index,
                frame: frame_dib,
                dim: dim_dib,
                canvas: canvas_dib,
                sel: None,
                tool: None,
                color: PALETTE[0],
                width_idx: 1,
                history: History::new(300),
                draft: None,
                drag: None,
                cursor: (0, 0),
                hover_handle: None,
                hover_item: None,
                edit: std::ptr::null_mut(),
                edit_at: None,
                edit_prev_proc: 0,
            });
        }
        let mut pending = pending.into_iter();

        CTX.with(|c| {
            *c.borrow_mut() = Some(Ctx { app: app.clone(), monitors: monitors.clone(), text, font: "Microsoft YaHei".into(), windows: HashMap::new(), finished: false });
        });

        // 建窗（真正入表：以 HWND 为键）
        for monitor in &monitors {
            let title = wide("");
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_TOOLWINDOW,
                pcw(&class),
                pcw(&title),
                WS_POPUP,
                monitor.x,
                monitor.y,
                monitor.width as i32,
                monitor.height as i32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                hinstance,
                std::ptr::null_mut(),
            );
            if hwnd.is_null() {
                continue;
            }
            // 把已备好的状态绑定到这个窗口
            if let Some(st) = pending.next() {
                with_ctx(|ctx| ctx.windows.insert(hwnd as isize, st));
            }
            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);
        }

        // 焦点给光标所在屏的那扇窗（光标不在任何遮罩窗上时给第一扇）
        let mut pt = POINT { x: 0, y: 0 };
        GetCursorPos(&mut pt);
        let target = with_ctx(|ctx| {
            let mut best: Option<HWND> = None;
            for (hwnd, st) in ctx.windows.iter() {
                let m = ctx.monitors.iter().find(|m| m.index == st.monitor_index);
                if let Some(m) = m {
                    if pt.x >= m.x && pt.x < m.x + m.width as i32 && pt.y >= m.y && pt.y < m.y + m.height as i32 {
                        best = Some(*hwnd as HWND);
                    }
                }
            }
            best.or_else(|| ctx.windows.keys().next().map(|k| *k as HWND))
        })
        .flatten();
        if let Some(hwnd) = target {
            SetForegroundWindow(hwnd);
            SetFocus(hwnd);
        }

        // 消息泵：所有遮罩窗销毁后退出
        let mut msg: MSG = std::mem::zeroed();
        while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }

        // 释放状态（DIB 随 Drop 回收）
        CTX.with(|c| *c.borrow_mut() = None);
    }
}

/// 结束整个会话：销毁所有遮罩窗（消息泵随之退出）
fn finish_session() {
    let hwnds: Vec<isize> = with_ctx(|ctx| {
        if ctx.finished {
            return Vec::new();
        }
        ctx.finished = true;
        ctx.windows.keys().copied().collect()
    })
    .unwrap_or_default();
    for hwnd in hwnds {
        unsafe {
            DestroyWindow(hwnd as HWND);
        }
    }
}

// ---------------- 窗口过程 ----------------

unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match msg {
        WM_PAINT => {
            paint_window(hwnd);
            0
        }
        WM_ERASEBKGND => 1, // 全部自绘，禁掉系统擦背景（防闪烁）
        WM_MOUSEMOVE => {
            on_mouse_move(hwnd, lparam);
            0
        }
        WM_LBUTTONDOWN => {
            on_lbutton_down(hwnd, lparam);
            0
        }
        WM_LBUTTONUP => {
            on_lbutton_up(hwnd, lparam);
            0
        }
        WM_RBUTTONUP => {
            on_right_up(hwnd);
            0
        }
        WM_MOUSEWHEEL => {
            let delta = ((wparam >> 16) as u16 as i16) as i32;
            with_ctx(|ctx| {
                if let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) {
                    let n = LINE_WIDTHS.len() as i32;
                    st.width_idx = ((st.width_idx as i32 + if delta > 0 { 1 } else { -1 }).clamp(0, n - 1)) as usize;
                }
            });
            repaint(hwnd);
            0
        }
        WM_SETCURSOR => {
            set_cursor(hwnd);
            1
        }
        // 文本输入框跟遮罩一个底色（原生 EDIT 默认白底在暗色遮罩上很突兀）
        windows_sys::Win32::UI::WindowsAndMessaging::WM_CTLCOLOREDIT => {
            let hdc = wparam as HDC;
            windows_sys::Win32::Graphics::Gdi::SetTextColor(hdc, 0x00F3EDE6);
            windows_sys::Win32::Graphics::Gdi::SetBkColor(hdc, 0x00121B16);
            let brush = windows_sys::Win32::Graphics::Gdi::CreateSolidBrush(0x00121B16);
            brush as LRESULT
        }
        WM_KEYDOWN => {
            on_keydown(hwnd, wparam as i32);
            0
        }
        WM_DESTROY => {
            let done = with_ctx(|ctx| {
                ctx.windows.remove(&(hwnd as isize));
                if ctx.windows.is_empty() {
                    PostQuitMessage(0);
                    true
                } else {
                    false
                }
            })
            .unwrap_or(true);
            if done {
                PostQuitMessage(0);
            }
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// ---------------- 输入 ----------------

fn cursor_of(lparam: LPARAM) -> (i32, i32) {
    let x = (lparam & 0xFFFF) as u16 as i16 as i32;
    let y = ((lparam >> 16) & 0xFFFF) as u16 as i16 as i32;
    (x, y)
}

fn bounds_of(st: &WinState) -> (i32, i32) {
    (st.frame.w, st.frame.h)
}

fn on_mouse_move(hwnd: HWND, lparam: LPARAM) {
    let (x, y) = cursor_of(lparam);
    with_ctx(|ctx| {
        let text_hint = ctx.text.hint.clone();
        let _ = text_hint;
        let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) else { return };
        st.cursor = (x, y);
        let bounds = bounds_of(st);
        match &st.drag {
            Some(Drag::Select { start }) => {
                st.sel = Some(clamp_rect(rect_from_points(*start, (x, y)), bounds));
            }
            Some(Drag::Move { start, origin }) => {
                st.sel = Some(move_rect(*origin, x - start.0, y - start.1, bounds));
            }
            Some(Drag::Resize { handle }) => {
                if let Some(sel) = st.sel {
                    st.sel = Some(resize_rect(sel, handle, (x, y), bounds, MIN_SELECTION));
                }
            }
            Some(Drag::Draw { start }) => {
                let p = clamp_to_selection(st, (x, y));
                let s = *start;
                if let Some(op) = st.draft.as_mut() {
                    update_op(op, s, p);
                }
            }
            None => {
                st.hover_item = st
                    .sel
                    .map(|sel| toolbar_layout(sel, bounds, &toolbar_item_widths()))
                    .and_then(|layout| hit_toolbar(&layout, (x, y)));
                st.hover_handle = if st.tool.is_none() {
                    st.sel.and_then(|sel| hit_handle(sel, (x, y), 7))
                } else {
                    None
                };
            }
        }
    });
    repaint(hwnd);
}

fn on_lbutton_down(hwnd: HWND, lparam: LPARAM) {
    let (x, y) = cursor_of(lparam);
    // 文本输入中：先落定
    if with_ctx(|ctx| ctx.windows.get(&(hwnd as isize)).map(|st| !st.edit.is_null())).flatten().unwrap_or(false) {
        commit_text(hwnd);
        return;
    }
    let mut action: Option<ToolbarItem> = None;
    with_ctx(|ctx| {
        let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) else { return };
        let bounds = bounds_of(st);
        st.cursor = (x, y);
        // 1) 工具栏
        if let Some(sel) = st.sel {
            let layout = toolbar_layout(sel, bounds, &toolbar_item_widths());
            if let Some(item) = hit_toolbar(&layout, (x, y)) {
                action = Some(item);
                return;
            }
        }
        // 2) 手柄 / 选区 / 新建选区
        if let Some(sel) = st.sel {
            if st.tool.is_none() {
                if let Some(h) = hit_handle(sel, (x, y), 7) {
                    st.drag = Some(Drag::Resize { handle: h });
                    return;
                }
                if sel.contains((x, y)) {
                    st.drag = Some(Drag::Move { start: (x, y), origin: sel });
                    return;
                }
            } else if sel.contains((x, y)) {
                if st.tool == Some(Tool::Text) {
                    open_text_edit(hwnd, (x, y));
                    return;
                }
                st.drag = Some(Drag::Draw { start: (x, y) });
                st.draft = Some(new_op(st.tool.unwrap(), (x, y), st.color, LINE_WIDTHS[st.width_idx]));
                return;
            }
        }
        st.sel = None;
        st.draft = None;
        st.drag = Some(Drag::Select { start: (x, y) });
    });
    if let Some(item) = action {
        apply_toolbar(hwnd, item);
    }
    repaint(hwnd);
}

fn on_lbutton_up(hwnd: HWND, lparam: LPARAM) {
    let (x, y) = cursor_of(lparam);
    with_ctx(|ctx| {
        let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) else { return };
        let bounds = bounds_of(st);
        let drag = st.drag.take();
        st.cursor = (x, y);
        match drag {
            Some(Drag::Select { start }) => {
                let r = clamp_rect(rect_from_points(start, (x, y)), bounds);
                st.sel = if r.w >= MIN_SELECTION && r.h >= MIN_SELECTION { Some(r) } else { None };
            }
            Some(Drag::Draw { .. }) => {
                let is_text = matches!(st.draft, Some(Op::Text { .. }));
                if let Some(op) = st.draft.take() {
                    if is_text {
                        // 文字工具的落点由 open_text_edit 处理
                    } else if op.is_meaningful() {
                        st.history.push(op);
                    }
                }
            }
            _ => {}
        }
    });
    repaint(hwnd);
}

fn on_right_up(hwnd: HWND) {
    let mut cancel_all = false;
    with_ctx(|ctx| {
        let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) else { return };
        if !st.edit.is_null() {
            commit_text(hwnd);
            return;
        }
        if st.tool.is_some() {
            st.tool = None;
            st.draft = None;
        } else if st.sel.is_some() {
            st.sel = None;
        } else {
            cancel_all = true;
        }
    });
    if cancel_all {
        finish_session();
    } else {
        repaint(hwnd);
    }
}

fn on_keydown(hwnd: HWND, vk: i32) {
    let ctrl = unsafe { GetKeyState(VK_CONTROL) } < 0;
    let shift = unsafe { GetKeyState(VK_SHIFT) } < 0;
    let mut cancel_all = false;
    let mut do_copy = false;
    let mut do_save = false;
    let mut do_pin = false;
    with_ctx(|ctx| {
        let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) else { return };
        if !st.edit.is_null() && vk != VK_ESCAPE {
            return; // 文本输入中：键盘交给 EDIT
        }
        match vk {
            x if x == VK_ESCAPE => {
                if !st.edit.is_null() {
                    close_text_edit(hwnd);
                } else if st.tool.is_some() {
                    st.tool = None;
                } else if st.sel.is_some() {
                    st.sel = None;
                } else {
                    cancel_all = true;
                }
            }
            x if x == VK_RETURN => do_copy = true,
            x if x == VK_F3 => do_pin = true,
            x if x == state::VK_C && ctrl => do_copy = true,
            x if x == state::VK_S && ctrl => do_save = true,
            x if x == state::VK_Z && ctrl => {
                if shift {
                    st.history.redo();
                } else {
                    st.history.undo();
                }
            }
            x if x == state::VK_Y && ctrl => {
                st.history.redo();
            }
            x if x == VK_LEFT || x == VK_RIGHT || x == VK_UP || x == VK_DOWN => {
                if let Some(sel) = st.sel {
                    let bounds = bounds_of(st);
                    st.sel = Some(nudge_rect(sel, vk, if shift { 10 } else { 1 }, bounds));
                }
            }
            _ => {}
        }
    });
    if cancel_all {
        finish_session();
        return;
    }
    if do_copy {
        confirm(hwnd, Action::Copy);
        return;
    }
    if do_save {
        confirm(hwnd, Action::Save);
        return;
    }
    if do_pin {
        confirm(hwnd, Action::Pin);
        return;
    }
    repaint(hwnd);
}

fn set_cursor(hwnd: HWND) {
    let cursor = with_ctx(|ctx| {
        let st = ctx.windows.get(&(hwnd as isize))?;
        let c = if st.tool.is_some() {
            IDC_CROSS
        } else if let Some(h) = st.hover_handle {
            match h {
                "nw" | "se" => IDC_SIZENWSE,
                "ne" | "sw" => IDC_SIZENESW,
                "n" | "s" => IDC_SIZENS,
                _ => IDC_SIZEWE,
            }
        } else {
            IDC_CROSS
        };
        Some(c)
    })
    .flatten();
    if let Some(c) = cursor {
        unsafe {
            let h = LoadCursorW(std::ptr::null_mut(), c);
            windows_sys::Win32::UI::WindowsAndMessaging::SetCursor(h);
        }
    }
}

// ---------------- 绘制 ----------------

fn repaint(hwnd: HWND) {
    unsafe {
        InvalidateRect(hwnd, std::ptr::null(), 0);
    }
}

fn paint_window(hwnd: HWND) {
    unsafe {
        let mut ps: windows_sys::Win32::Graphics::Gdi::PAINTSTRUCT = std::mem::zeroed();
        let hdc = windows_sys::Win32::Graphics::Gdi::BeginPaint(hwnd, &mut ps);
        let painted = with_ctx(|ctx| {
            let app_font = ctx.font.clone();
            let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) else { return false };
            let sel = st.sel;
            let layout = sel.map(|s| toolbar_layout(s, (st.frame.w, st.frame.h), &toolbar_item_widths()));
            let text = &ctx.text;
            let tool_labels: Vec<String> = text.tools.clone();
            let scene = paint::Scene {
                frame: &st.frame,
                dim: &st.dim,
                ops: st.history.active(),
                can_undo: st.history.can_undo(),
                can_redo: st.history.can_redo(),
                draft: st.draft.as_ref(),
                selection: sel,
                size_label: sel.map(|s| format!("{} × {}", s.w, s.h)).unwrap_or_default(),
                toolbar: layout.as_ref(),
                active_tool: st.tool,
                color: st.color,
                width_idx: st.width_idx,
                hint: &text.hint,
                magnifier: if st.tool.is_none() && st.drag.is_none() {
                    let (x, y) = st.cursor;
                    let px = (x).clamp(0, st.frame.w - 1) as usize;
                    let py = (y).clamp(0, st.frame.h - 1) as usize;
                    let c = *st.frame.bits.add(py * st.frame.w as usize + px);
                    Some((x, y, c & 0x00FF_FFFF, (px as i32, py as i32)))
                } else {
                    None
                },
                text_cursor: st.edit_at.map(|(x, y)| (x, y, st.color)),
                labels: paint::Labels { copy: &text.copy, save: &text.save, pin: &text.pin, tools: &tool_labels },
            };
            paint::paint(&mut st.canvas, &scene, &app_font);
            // 上屏
            windows_sys::Win32::Graphics::Gdi::BitBlt(
                hdc,
                0,
                0,
                st.frame.w,
                st.frame.h,
                st.canvas.hdc,
                0,
                0,
                windows_sys::Win32::Graphics::Gdi::SRCCOPY,
            );
            true
        })
        .unwrap_or(false);
        let _ = painted;
        windows_sys::Win32::Graphics::Gdi::EndPaint(hwnd, &ps);
    }
}

// ---------------- 工具栏动作 ----------------

fn apply_toolbar(hwnd: HWND, item: ToolbarItem) {
    match item {
        ToolbarItem::Undo => {
            with_ctx(|ctx| ctx.windows.get_mut(&(hwnd as isize)).map(|st| st.history.undo()));
        }
        ToolbarItem::Redo => {
            with_ctx(|ctx| ctx.windows.get_mut(&(hwnd as isize)).map(|st| st.history.redo()));
        }
        ToolbarItem::Tool(t) => {
            with_ctx(|ctx| {
                if let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) {
                    st.tool = Some(t);
                }
            });
        }
        ToolbarItem::Color(c) => {
            with_ctx(|ctx| {
                if let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) {
                    st.color = c;
                }
            });
        }
        ToolbarItem::Width(i) => {
            with_ctx(|ctx| {
                if let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) {
                    st.width_idx = i;
                }
            });
        }
        ToolbarItem::Copy => confirm(hwnd, Action::Copy),
        ToolbarItem::Save => confirm(hwnd, Action::Save),
        ToolbarItem::Pin => confirm(hwnd, Action::Pin),
        ToolbarItem::Cancel => finish_session(),
    }
}

// ---------------- 文本输入（原生 EDIT 子控件） ----------------

fn open_text_edit(hwnd: HWND, at: (i32, i32)) {
    unsafe {
        let hinstance = GetModuleHandleW(std::ptr::null());
        let cls = wide("EDIT");
        let empty = wide("");
        let (x, y) = at;
        let size = with_ctx(|ctx| ctx.windows.get(&(hwnd as isize)).map(|st| TEXT_SIZES[st.width_idx])).flatten().unwrap_or(20);
        let edit = CreateWindowExW(
            0,
            pcw(&cls),
            pcw(&empty),
            WS_CHILD | WS_VISIBLE | ES_LEFT as u32 | ES_AUTOHSCROLL as u32,
            x,
            y,
            260,
            size + 12,
            hwnd,
            EDIT_ID as *mut core::ffi::c_void,
            hinstance,
            std::ptr::null_mut(),
        );
        if edit.is_null() {
            return;
        }
        // 字体与标注字号一致（默认 EDIT 是 9pt 小字，输入时看到的大小要和落笔一致）
        let font = windows_sys::Win32::Graphics::Gdi::CreateFontW(
            size + 4,
            0,
            0,
            0,
            400,
            0,
            0,
            0,
            1, // DEFAULT_CHARSET
            0,
            0,
            5, // CLEARTYPE_QUALITY
            0,
            pcw(&wide("Microsoft YaHei")),
        );
        windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(edit, WM_SETFONT, font as usize, 1);
        SetFocus(edit);
        with_ctx(|ctx| {
            if let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) {
                st.edit = edit;
                st.edit_at = Some(at);
                let proc_ptr: unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT = edit_proc;
                st.edit_prev_proc = SetWindowLongPtrW(edit, GWLP_WNDPROC, proc_ptr as isize);
            }
        });
    }
}

fn edit_text(edit: HWND) -> String {
    unsafe {
        let len = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextLengthW(edit);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; len as usize + 1];
        windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW(edit, buf.as_mut_ptr(), len + 1);
        String::from_utf16_lossy(&buf[..len as usize]).trim().to_string()
    }
}

unsafe extern "system" fn edit_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let parent = windows_sys::Win32::UI::WindowsAndMessaging::GetParent(hwnd);
    match msg {
        WM_KEYDOWN => {
            let vk = wparam as i32;
            if vk == 0x0D {
                // Enter：落定
                let text = edit_text(hwnd);
                commit_text_value(parent, text);
                DestroyWindow(hwnd);
                repaint(parent);
                return 0;
            }
            if vk == VK_ESCAPE {
                close_text_edit(parent);
                repaint(parent);
                return 0;
            }
        }
        WM_KILLFOCUS => {
            // 已经提交过（destroy 路径会再触发一次 WM_KILLFOCUS）就别重复落一条
            let still_ours = with_ctx(|ctx| ctx.windows.get(&(parent as isize)).map(|st| st.edit == hwnd)).flatten().unwrap_or(false);
            if !still_ours {
                return 0;
            }
            // 失焦即落定（与 WebView 版一致）
            let text = edit_text(hwnd);
            commit_text_value(parent, text);
            DestroyWindow(hwnd);
            repaint(parent);
            return 0;
        }
        _ => {}
    }
    let prev = with_ctx(|ctx| ctx.windows.get(&(parent as isize)).map(|st| st.edit_prev_proc)).flatten().unwrap_or(0);
    if prev != 0 {
        let f: windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC = std::mem::transmute(prev);
        return CallWindowProcW(f, hwnd, msg, wparam, lparam);
    }
    DefWindowProcW(hwnd, msg, wparam, lparam)
}

fn commit_text(hwnd: HWND) {
    let edit = with_ctx(|ctx| ctx.windows.get(&(hwnd as isize)).map(|st| st.edit)).flatten();
    if let Some(edit) = edit {
        if !edit.is_null() {
            let text = edit_text(edit);
            unsafe {
                DestroyWindow(edit);
            }
            commit_text_value(hwnd, text);
        }
    }
}

fn commit_text_value(hwnd: HWND, text: String) {
    with_ctx(|ctx| {
        let Some(st) = ctx.windows.get_mut(&(hwnd as isize)) else { return };
        let at = st.edit_at.take();
        st.edit = std::ptr::null_mut();
        st.edit_prev_proc = 0;
        if text.is_empty() {
            return;
        }
        if let Some(at) = at {
            let size = TEXT_SIZES[st.width_idx];
            st.history.push(Op::Text { at, size, text, color: st.color });
        }
    });
}

fn close_text_edit(hwnd: HWND) {
    let edit = with_ctx(|ctx| {
        ctx.windows.get_mut(&(hwnd as isize)).map(|st| {
            let e = st.edit;
            st.edit = std::ptr::null_mut();
            st.edit_at = None;
            st.edit_prev_proc = 0;
            e
        })
    })
    .flatten();
    if let Some(edit) = edit {
        if !edit.is_null() {
            unsafe {
                DestroyWindow(edit);
            }
        }
    }
}

// ---------------- 标注草稿 ----------------

fn new_op(tool: Tool, at: (i32, i32), color: u32, width: i32) -> Op {
    match tool {
        Tool::Rect => Op::Rect { rect: Rect::new(at.0, at.1, 0, 0), color, width },
        Tool::Ellipse => Op::Ellipse { rect: Rect::new(at.0, at.1, 0, 0), color, width },
        Tool::Arrow => Op::Arrow { from: at, to: at, color, width },
        Tool::Pen => Op::Stroke { points: vec![at], color, width, marker: false },
        Tool::Marker => Op::Stroke { points: vec![at], color, width, marker: true },
        Tool::Mosaic => Op::Mosaic { rect: Rect::new(at.0, at.1, 0, 0) },
        Tool::Text => Op::Text { at, size: 20, text: String::new(), color },
    }
}

fn update_op(op: &mut Op, start: (i32, i32), p: (i32, i32)) {
    match op {
        Op::Rect { rect, .. } | Op::Ellipse { rect, .. } | Op::Mosaic { rect } => {
            *rect = rect_from_points(start, p);
        }
        Op::Arrow { to, .. } => *to = p,
        Op::Stroke { points, .. } => {
            if points.last().map(|l| (l.0 - p.0).abs() + (l.1 - p.1).abs() >= 2).unwrap_or(true) {
                points.push(p);
            }
        }
        Op::Text { .. } => {}
    }
}

fn clamp_to_selection(st: &WinState, p: (i32, i32)) -> (i32, i32) {
    match st.sel {
        Some(sel) => (p.0.clamp(sel.x, sel.right()), p.1.clamp(sel.y, sel.bottom())),
        None => p,
    }
}

// ---------------- 确认动作（复制 / 保存 / 贴图） ----------------

enum Action {
    Copy,
    Save,
    Pin,
}

fn confirm(hwnd: HWND, action: Action) {
    let prepared = with_ctx(|ctx| {
        let Some(st) = ctx.windows.get(&(hwnd as isize)) else { return None };
        let sel = st.sel?;
        let (rgba, w, h) = unsafe { paint::render_output(&st.frame, st.history.active(), sel) };
        let monitor = ctx.monitors.iter().find(|m| m.index == st.monitor_index).cloned()?;
        Some((ctx.app.clone(), rgba, w, h, sel, monitor))
    })
    .flatten();
    let Some((app, rgba, w, h, sel, monitor)) = prepared else {
        return;
    };

    // 先收遮罩：保存对话框/贴图窗都不该被置顶遮罩压着
    finish_session();

    let png = screenshot::encode_rgba_png(&rgba, w as u32, h as u32);
    match action {
        Action::Copy => {
            if let Err(e) = screenshot::clipboard_set_rgba(&rgba, w, h) {
                eprintln!("截图复制失败：{e}");
                screenshot::notify_capture_fail(&app, &e);
            }
        }
        Action::Save => {
            let Some(png) = png else {
                screenshot::notify_capture_fail(&app, "PNG 编码失败");
                return;
            };
            save_png(&app, png);
        }
        Action::Pin => {
            let Some(png) = png else {
                screenshot::notify_capture_fail(&app, "PNG 编码失败");
                return;
            };
            // 贴图落回截图原位（屏幕全局坐标 = 本屏原点 + 选区）
            let at = (monitor.x + sel.x, monitor.y + sel.y);
            if let Err(e) = screenshot::create_pin_bytes(&app, png, Some(at)) {
                eprintln!("贴图失败：{e}");
                screenshot::notify_capture_fail(&app, &e);
            }
        }
    }
}

fn save_png(app: &AppHandle, png: Vec<u8>) {
    use tauri_plugin_dialog::DialogExt;
    let stamp = chrono_like_stamp();
    app.dialog()
        .file()
        .set_file_name(format!("screenshot-{stamp}.png"))
        .add_filter("PNG", &["png"])
        .save_file(move |path| {
            let Some(path) = path else { return };
            let Some(path) = path.as_path() else { return };
            if let Err(e) = std::fs::write(path, &png) {
                eprintln!("截图保存失败：{e}");
            }
        });
}

fn chrono_like_stamp() -> String {
    // 只用于默认文件名：年月日时分秒（本地时区近似，不引入 chrono 依赖）
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let _ = secs;
    // Windows：用 GetLocalTime 拿本地时间
    unsafe {
        let mut st: windows_sys::Win32::Foundation::SYSTEMTIME = std::mem::zeroed();
        windows_sys::Win32::System::SystemInformation::GetLocalTime(&mut st);
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            st.wYear, st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond
        )
    }
}


