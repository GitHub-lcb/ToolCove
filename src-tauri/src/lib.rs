mod ai;
mod db;
mod file_tool;
mod network;
mod secure;
mod storage;

use tauri::Emitter;
use tauri::Manager;

/// 发送系统通知：走原生通知插件
#[tauri::command]
fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| e.to_string())
}

/// window-state 兜底校正：插件还原路径不走 conf 的 minWidth/minHeight 约束，
/// 且最小化/还原瞬间系统可能上报极小矩形被插件持久化。数值须与 tauri.conf.json 同步（min 720×520 / 默认 1200×760）
fn sanitize_main_window(app: &tauri::AppHandle, remaximize: bool) {
    let Some(win) = app.get_webview_window("main") else {
        return;
    };
    if win.is_minimized().unwrap_or(false) {
        return;
    }
    let Ok(size) = win.outer_size() else {
        return;
    };
    if size.width < 720 || size.height < 520 {
        let _ = win.set_size(tauri::LogicalSize::new(1200.0, 760.0));
        if remaximize {
            let _ = win.maximize();
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // 全局快捷键 Ctrl+Alt+Q：唤起「快速记问题」（M2 问题视图迁入后前端生效）；
        // 被占用时仅降级该快捷键，不让启动失败
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, _event| {
                    if let Some(win) = app.get_webview_window("main") {
                        let _ = win.show();
                        let _ = win.unminimize();
                        let _ = win.set_focus();
                    }
                    let _ = app.emit("tray-action", "quick-note");
                })
                .build(),
        )
        .setup(|app| {
            db::init();
            setup_tray(app.handle())?;
            register_quick_note_shortcut(app.handle());
            sanitize_main_window(app.handle(), true);
            Ok(())
        })
        .on_window_event(|window, event| {
            // 主窗口关闭=隐藏到托盘；工具子窗口（tool-*）关闭直接退出
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
                return;
            }
            // window-state 极小矩形污染兜底（防抖 400ms）
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Resized(_)) {
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    sanitize_main_window(&app, false);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![
            storage::load_data,
            storage::save_data,
            storage::load_data_versioned,
            storage::save_data_versioned,
            storage::export_file,
            storage::export_file_b64,
            storage::save_image,
            storage::load_image,
            storage::delete_image,
            storage::backup_data,
            storage::restore_data,
            storage::auto_backup,
            notify,
            // HTTP 通用代理（请求工具；源仓挂在 coding 模块，ToolCove 归入 network）
            network::http_request,
            // 网络诊断（网络工具）
            network::local_ip,
            network::network_dns_lookup,
            network::network_tcp_check,
            network::network_ping,
            network::network_trace,
            network::network_interfaces,
            // 数据库工具
            db::db_test,
            db::db_connect,
            db::db_query,
            db::db_tables,
            db::db_columns,
            db::db_indexes,
            db::db_ddl,
            db::db_close,
            db::db_drivers,
            db::db_install_oracle_driver,
            // 文件工具
            file_tool::read_text_file,
            file_tool::file_tool_inspect,
            file_tool::file_tool_read_text,
            file_tool::file_tool_write_text,
            file_tool::file_tool_read_base64,
            file_tool::file_tool_write_base64,
            file_tool::file_tool_calculate_md5,
            file_tool::file_tool_modify_md5,
            file_tool::file_tool_list_directory,
            file_tool::file_tool_batch_rename,
            // AI 对话
            ai::ai_chat,
            ai::ai_chat_stream,
            // 加密安全存储
            secure::encrypt_text,
            secure::decrypt_text
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 尽力注册全局快捷键 Ctrl+Alt+Q，失败仅跳过
fn register_quick_note_shortcut(app: &tauri::AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Err(e) = app.global_shortcut().register("Ctrl+Alt+Q") {
        eprintln!("全局快捷键 Ctrl+Alt+Q 注册失败（可能被其它程序占用），跳过该快捷键: {e}");
    }
}

/// 系统托盘：快速记问题/检查更新（M3 生效）/显示/退出；左键单击恢复窗口
fn setup_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let quick_note = MenuItem::with_id(app, "quick_note", "快速记问题", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check_update", "检查更新", true, None::<&str>)?;
    let show = MenuItem::with_id(app, "show", "显示主窗口", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&quick_note, &check_update, &show, &quit])?;

    fn show_main(app: &tauri::AppHandle) {
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.show();
            let _ = win.unminimize();
            let _ = win.set_focus();
        }
    }
    fn tray_action(app: &tauri::AppHandle, action: &str) {
        show_main(app);
        let _ = app.emit("tray-action", action);
    }

    TrayIconBuilder::with_id("main-tray")
        .icon(app.default_window_icon().cloned().expect("missing app icon"))
        .tooltip("ToolCove")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quick_note" => tray_action(app, "quick-note"),
            "check_update" => tray_action(app, "check-update"),
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

#[cfg(test)]
mod lib_tests {
    // storage 纯函数单测：从源仓 lib_tests 中保留 storage 相关用例
    use std::fs;
    use std::path::PathBuf;
    use crate::storage::*;

    fn temp_case(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("toolcove-{name}-{stamp}"))
    }

    #[test]
    fn json_revision_changes_with_content() {
        assert_eq!(content_revision(b"[]"), content_revision(b"[]"));
        assert_ne!(content_revision(b"[]"), content_revision(b"[1]"));
    }

    #[test]
    fn damaged_json_is_rejected_and_copied() {
        let dir = temp_case("corrupt-json");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("iterations.json");
        let original = b"[{broken";
        fs::write(&path, original).unwrap();

        let err = read_json_file(&path, "iterations").unwrap_err();
        assert!(err.contains("拒绝按空数据加载"), "实际错误：{err}");
        assert_eq!(fs::read(&path).unwrap(), original, "原损坏文件不得改写");
        let copies: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("iterations.corrupt-"))
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(fs::read(copies[0].path()).unwrap(), original);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn damaged_json_cannot_be_overwritten_by_normal_save() {
        let dir = temp_case("corrupt-save");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        let original = b"{broken";
        fs::write(&path, original).unwrap();
        assert!(replace_json_file(&path, "settings", &serde_json::json!({ "ok": true })).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn stale_revision_cannot_overwrite_newer_json() {
        let dir = temp_case("revision-conflict");
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("iterations.json");
        let old_revision = write_json_file(&path, &serde_json::json!([{ "id": 1 }])).unwrap();
        let new_revision = replace_json_file_versioned(
            &path,
            "iterations",
            &serde_json::json!([{ "id": 2 }]),
            &old_revision,
        )
        .unwrap();
        let err = replace_json_file_versioned(
            &path,
            "iterations",
            &serde_json::json!([{ "id": 3 }]),
            &old_revision,
        )
        .unwrap_err();
        assert!(err.contains("保存已拒绝"));
        let (data, revision) = read_json_file(&path, "iterations").unwrap();
        assert_eq!(data, serde_json::json!([{ "id": 2 }]));
        assert_eq!(revision, new_revision);
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_test_zip(path: &std::path::Path, entries: &[(&str, &[u8])]) {
        use std::io::Write;
        use zip::write::SimpleFileOptions;

        let file = fs::File::create(path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, content) in entries {
            zip.start_file(*name, opts).unwrap();
            zip.write_all(content).unwrap();
        }
        zip.finish().unwrap();
    }

    #[test]
    fn restore_archive_rejects_path_traversal_and_invalid_json() {
        let dir = temp_case("restore-invalid");
        fs::create_dir_all(&dir).unwrap();
        let traversal = dir.join("traversal.zip");
        write_test_zip(&traversal, &[("../settings.json", b"{}")]);
        assert!(read_restore_archive(&traversal).unwrap_err().contains("不支持"));

        let invalid = dir.join("invalid.zip");
        write_test_zip(&invalid, &[("settings.json", b"{broken")]);
        assert!(read_restore_archive(&invalid).unwrap_err().contains("不是有效 JSON"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_replaces_managed_data_and_creates_safety_backup() {
        let dir = temp_case("restore-ok");
        fs::create_dir_all(dir.join("images")).unwrap();
        fs::write(dir.join("settings.json"), br#"{"old":true}"#).unwrap();
        fs::write(dir.join("obsolete.json"), br#"[1]"#).unwrap();
        fs::write(dir.join("images").join("old.png"), b"old-image").unwrap();
        let source = dir.join("source.zip");
        write_test_zip(
            &source,
            &[
                ("settings.json", br#"{"new":true}"#),
                ("items.json", br#"[{"id":1}]"#),
                ("images/new.png", b"new-image"),
            ],
        );

        let summary = run_restore(&dir, &source).unwrap();
        assert!(summary.contains("2 个数据文件、1 张图片"));
        assert_eq!(fs::read(dir.join("settings.json")).unwrap(), br#"{"new":true}"#);
        assert_eq!(fs::read(dir.join("items.json")).unwrap(), br#"[{"id":1}]"#);
        assert!(!dir.join("obsolete.json").exists());
        assert_eq!(fs::read(dir.join("images").join("new.png")).unwrap(), b"new-image");
        assert!(!dir.join("images").join("old.png").exists());
        let backups: Vec<_> = fs::read_dir(dir.join("backups"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("pre-restore-"))
            .collect();
        assert_eq!(backups.len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }
}
