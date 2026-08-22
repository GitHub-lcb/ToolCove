use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::Manager;
/// 数据文件路径：<应用数据目录>/<key>.json（key 仅保留安全字符）
pub fn data_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
    let safe: String = key
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if safe.is_empty() {
        return Err("invalid data key".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{}.json", safe)))
}

pub static DATA_IO_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
pub static DATA_RESTORE_COMPLETE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn data_io_lock() -> Result<std::sync::MutexGuard<'static, ()>, String> {
    DATA_IO_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "数据文件锁已损坏，请重启应用".to_string())
}

pub fn ensure_data_writable() -> Result<(), String> {
    use std::sync::atomic::Ordering;
    if DATA_RESTORE_COMPLETE.load(Ordering::SeqCst) {
        Err("数据已从备份恢复，应用重启前禁止继续写入".into())
    } else {
        Ok(())
    }
}

pub fn content_revision(content: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    format!("{:x}", Sha256::digest(content))
}

pub fn read_json_file(path: &std::path::Path, _key: &str) -> Result<(serde_json::Value, String), String> {
    if !path.exists() {
        return Ok((serde_json::json!([]), String::new()));
    }
    let safe_key = path
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.is_empty())
        .unwrap_or("data");
    let content = fs::read(path).map_err(|e| format!("读取 {safe_key}.json 失败：{e}"))?;
    match serde_json::from_slice(&content) {
        Ok(value) => Ok((value, content_revision(&content))),
        Err(e) => {
            let stamp = fs::metadata(path)
                .and_then(|m| m.modified())
                .unwrap_or_else(|_| std::time::SystemTime::now())
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            let backup = path.with_file_name(format!("{safe_key}.corrupt-{stamp}.json"));
            let backup_note = match fs::copy(path, &backup) {
                Ok(_) => format!("，已保留副本：{}", backup.display()),
                Err(copy_err) => format!("，创建损坏副本失败：{copy_err}"),
            };
            Err(format!("{safe_key}.json 已损坏，拒绝按空数据加载：{e}{backup_note}"))
        }
    }
}

pub fn write_json_file(path: &std::path::Path, data: &serde_json::Value) -> Result<String, String> {
    let content = serde_json::to_vec_pretty(data).map_err(|e| e.to_string())?;
    let revision = content_revision(&content);
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &content).map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(revision)
}

pub fn replace_json_file(path: &std::path::Path, key: &str, data: &serde_json::Value) -> Result<String, String> {
    if path.exists() {
        read_json_file(path, key)?;
    }
    write_json_file(path, data)
}

pub fn replace_json_file_versioned(
    path: &std::path::Path,
    key: &str,
    data: &serde_json::Value,
    expected_revision: &str,
) -> Result<String, String> {
    let (_, current_revision) = read_json_file(path, key)?;
    if current_revision != expected_revision {
        return Err("数据已被其他页面或后台任务更新，本次保存已拒绝；请重新进入页面后再修改".to_string());
    }
    write_json_file(path, data)
}

/// 按 key 读取数据，文件不存在时返回空数组（async：避免磁盘 IO 占用主线程）
#[tauri::command]
pub async fn load_data(app: tauri::AppHandle, key: String) -> Result<serde_json::Value, String> {
    let path = data_path(&app, &key)?;
    let _guard = data_io_lock()?;
    read_json_file(&path, &key).map(|(data, _)| data)
}

/// 按 key 覆盖保存数据（async：避免磁盘 IO 占用主线程）。
/// 原子写入：先写临时文件再 rename 替换，避免写一半崩溃/断电损坏原数据。
#[tauri::command]
pub async fn save_data(app: tauri::AppHandle, key: String, data: serde_json::Value) -> Result<(), String> {
    let path = data_path(&app, &key)?;
    let _guard = data_io_lock()?;
    ensure_data_writable()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    replace_json_file(&path, &key, &data)?;
    Ok(())
}

/// 读取数据及内容修订号，供需要并发写保护的数据使用。
#[tauri::command]
pub async fn load_data_versioned(app: tauri::AppHandle, key: String) -> Result<serde_json::Value, String> {
    let path = data_path(&app, &key)?;
    let _guard = data_io_lock()?;
    let (data, revision) = read_json_file(&path, &key)?;
    Ok(serde_json::json!({ "data": data, "revision": revision }))
}

/// 仅当磁盘修订号与读取时一致才写入，避免旧页面快照覆盖较新的数据。
#[tauri::command]
pub async fn save_data_versioned(
    app: tauri::AppHandle,
    key: String,
    data: serde_json::Value,
    expected_revision: String,
) -> Result<String, String> {
    let path = data_path(&app, &key)?;
    let _guard = data_io_lock()?;
    ensure_data_writable()?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    replace_json_file_versioned(&path, &key, &data, &expected_revision)
}

/// 导出：把文本内容写入用户选择的路径（用于 Excel / CSV 导出）
#[tauri::command]
pub async fn export_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(())
}

/// 导出二进制文件：base64 解码后写入目标路径（用于 .xlsx 等二进制导出）。
/// 解码 + 写盘可能较重，走 spawn_blocking 避免卡 UI。
#[tauri::command]
pub async fn export_file_b64(path: String, content_b64: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(content_b64.trim())
            .map_err(|e| format!("base64 解码失败：{}", e))?;
        fs::write(&path, bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 图片附件路径：<应用数据目录>/images/<name>（name 仅保留安全字符）
pub fn image_path(app: &tauri::AppHandle, name: &str) -> Result<PathBuf, String> {
    let safe: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
        .collect();
    if safe.is_empty() || safe.contains("..") {
        return Err("invalid image name".into());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("images");
    Ok(dir.join(safe))
}

/// 保存图片附件：base64 解码后写入 images 目录。
/// 截图可能几 MB，解码 + 写盘走 spawn_blocking，不卡主线程。
#[tauri::command]
pub async fn save_image(app: tauri::AppHandle, name: String, data_b64: String) -> Result<(), String> {
    let path = image_path(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = data_io_lock()?;
        ensure_data_writable()?;
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64.trim())
            .map_err(|e| format!("base64 解码失败：{}", e))?;
        fs::write(&path, bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 读取图片附件：返回 base64 内容（读盘 + 编码走 spawn_blocking）
#[tauri::command]
pub async fn load_image(app: tauri::AppHandle, name: String) -> Result<String, String> {
    let path = image_path(&app, &name)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = data_io_lock()?;
        use base64::Engine;
        if !path.exists() {
            return Err("图片不存在".to_string());
        }
        let bytes = fs::read(&path).map_err(|e| e.to_string())?;
        Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 删除图片附件（文件不存在视为成功）
#[tauri::command]
pub async fn delete_image(app: tauri::AppHandle, name: String) -> Result<(), String> {
    let path = image_path(&app, &name)?;
    let _guard = data_io_lock()?;
    ensure_data_writable()?;
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 一键备份：把全部 JSON 数据与图片附件打包成 zip 写到目标路径，返回备份摘要
#[tauri::command]
pub async fn backup_data(app: tauri::AppHandle, dest: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = data_io_lock()?;
        run_backup(&dir, &dest)
    })
        .await
        .map_err(|e| e.to_string())?
}

pub fn run_backup(dir: &std::path::Path, dest: &str) -> Result<String, String> {
    use std::io::Write;
    use zip::write::SimpleFileOptions;
    if dest.trim().is_empty() {
        return Err("未选择保存路径".into());
    }
    if !dir.is_dir() {
        return Err("还没有任何数据可备份".into());
    }
    let file = fs::File::create(dest).map_err(|e| format!("无法创建备份文件：{}", e))?;
    let mut zip = zip::ZipWriter::new(file);
    let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut json_count = 0u32;
    let mut img_count = 0u32;
    // 根目录下的 *.json 数据文件
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if path.is_file()
            && matches!(
                classify_restore_entry(&entry.file_name().to_string_lossy(), false),
                Ok(RestoreEntry::Json(_))
            )
        {
            let name = entry.file_name().to_string_lossy().to_string();
            zip.start_file(&name, opts).map_err(|e| e.to_string())?;
            zip.write_all(&fs::read(&path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
            json_count += 1;
        }
    }
    // images 子目录（问题截图等附件）
    let img_dir = dir.join("images");
    if img_dir.is_dir() {
        for entry in fs::read_dir(&img_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            let name = format!("images/{}", entry.file_name().to_string_lossy());
            if path.is_file() && matches!(classify_restore_entry(&name, false), Ok(RestoreEntry::Image(_))) {
                zip.start_file(&name, opts).map_err(|e| e.to_string())?;
                zip.write_all(&fs::read(&path).map_err(|e| e.to_string())?)
                    .map_err(|e| e.to_string())?;
                img_count += 1;
            }
        }
    }
    zip.finish().map_err(|e| e.to_string())?;
    if json_count == 0 && img_count == 0 {
        return Err("还没有任何数据可备份".into());
    }
    Ok(format!("{} 个数据文件、{} 张图片", json_count, img_count))
}

pub const RESTORE_MAX_ENTRIES: usize = 2_000;
pub const RESTORE_MAX_FILE_BYTES: u64 = 50 * 1024 * 1024;
pub const RESTORE_MAX_TOTAL_BYTES: u64 = 250 * 1024 * 1024;

#[derive(Debug, PartialEq)]
pub enum RestoreEntry {
    Json(String),
    Image(String),
    Directory,
}

pub fn safe_restore_name(name: &str, allow_dot: bool) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || c == '_' || c == '-' || (allow_dot && c == '.')
        })
}

pub fn classify_restore_entry(name: &str, is_dir: bool) -> Result<RestoreEntry, String> {
    if name.contains('\\') || name.starts_with('/') {
        return Err(format!("备份包含不安全路径：{name}"));
    }
    let trimmed = name.trim_end_matches('/');
    if is_dir {
        return if trimmed == "images" {
            Ok(RestoreEntry::Directory)
        } else {
            Err(format!("备份包含不支持的目录：{name}"))
        };
    }
    let parts: Vec<&str> = trimmed.split('/').collect();
    match parts.as_slice() {
        [file] if file.ends_with(".json") => {
            let stem = file.strip_suffix(".json").unwrap_or_default();
            if !safe_restore_name(stem, false) {
                return Err(format!("备份包含不安全的数据文件名：{name}"));
            }
            Ok(RestoreEntry::Json((*file).to_string()))
        }
        ["images", file] if safe_restore_name(file, true) && !file.contains("..") => {
            Ok(RestoreEntry::Image((*file).to_string()))
        }
        _ => Err(format!("备份包含不支持的文件：{name}")),
    }
}

pub fn read_restore_archive(source: &std::path::Path) -> Result<(Vec<(String, Vec<u8>)>, Vec<(String, Vec<u8>)>), String> {
    use std::collections::HashSet;
    use std::io::Read;

    let file = fs::File::open(source).map_err(|e| format!("无法打开备份文件：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("备份文件不是有效 ZIP：{e}"))?;
    if archive.len() > RESTORE_MAX_ENTRIES {
        return Err(format!("备份条目过多，最多允许 {RESTORE_MAX_ENTRIES} 项"));
    }
    let mut json_files = Vec::new();
    let mut images = Vec::new();
    let mut seen = HashSet::new();
    let mut total = 0u64;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|e| format!("读取备份条目失败：{e}"))?;
        let kind = classify_restore_entry(entry.name(), entry.is_dir())?;
        if kind == RestoreEntry::Directory {
            continue;
        }
        if entry.size() > RESTORE_MAX_FILE_BYTES {
            return Err(format!("备份条目过大：{}", entry.name()));
        }
        let identity = entry.name().to_ascii_lowercase();
        if !seen.insert(identity) {
            return Err(format!("备份包含重复文件：{}", entry.name()));
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .by_ref()
            .take(RESTORE_MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("解压 {} 失败：{e}", entry.name()))?;
        if bytes.len() as u64 > RESTORE_MAX_FILE_BYTES {
            return Err(format!("备份条目解压后过大：{}", entry.name()));
        }
        total = total
            .checked_add(bytes.len() as u64)
            .ok_or("备份解压大小溢出")?;
        if total > RESTORE_MAX_TOTAL_BYTES {
            return Err("备份解压后总大小超过 250 MB".into());
        }
        match kind {
            RestoreEntry::Json(name) => {
                serde_json::from_slice::<serde_json::Value>(&bytes)
                    .map_err(|e| format!("{name} 不是有效 JSON：{e}"))?;
                json_files.push((name, bytes));
            }
            RestoreEntry::Image(name) => images.push((name, bytes)),
            RestoreEntry::Directory => {}
        }
    }
    if json_files.is_empty() {
        return Err("备份中没有可恢复的 JSON 数据文件".into());
    }
    Ok((json_files, images))
}

pub fn managed_json_files(dir: &std::path::Path) -> Result<Vec<PathBuf>, String> {
    let mut files = Vec::new();
    if !dir.is_dir() {
        return Ok(files);
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let Some(file) = path.file_name().and_then(|n| n.to_str()) else { continue };
        if path.is_file() && matches!(classify_restore_entry(file, false), Ok(RestoreEntry::Json(_))) {
            files.push(path);
        }
    }
    Ok(files)
}

pub fn rollback_restore(
    dir: &std::path::Path,
    rollback: &std::path::Path,
    installed: &[String],
    installed_images: bool,
) -> Result<(), String> {
    for name in installed {
        let path = dir.join(name);
        if path.is_file() {
            fs::remove_file(path).map_err(|e| format!("移除已恢复文件失败：{e}"))?;
        }
    }
    if installed_images {
        let images = dir.join("images");
        if images.exists() {
            fs::remove_dir_all(&images).map_err(|e| format!("移除已恢复图片失败：{e}"))?;
        }
    }
    for entry in fs::read_dir(rollback).map_err(|e| format!("读取回滚目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取回滚条目失败：{e}"))?;
        let target = dir.join(entry.file_name());
        if target.exists() {
            return Err(format!("回滚目标已存在：{}", target.display()));
        }
        fs::rename(entry.path(), &target).map_err(|e| format!("恢复 {} 失败：{e}", target.display()))?;
    }
    Ok(())
}

pub fn run_restore(dir: &std::path::Path, source: &std::path::Path) -> Result<String, String> {
    let (json_files, images) = read_restore_archive(source)?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let stage = dir.join(format!(".restore-stage-{stamp}"));
    let rollback = dir.join(format!(".restore-rollback-{stamp}"));
    fs::create_dir(&stage).map_err(|e| format!("创建恢复暂存目录失败：{e}"))?;
    fs::create_dir(&rollback).map_err(|e| {
        let _ = fs::remove_dir_all(&stage);
        format!("创建恢复回滚目录失败：{e}")
    })?;
    let prepared = (|| -> Result<(), String> {
        for (name, bytes) in &json_files {
            fs::write(stage.join(name), bytes).map_err(|e| format!("暂存 {name} 失败：{e}"))?;
        }
        if !images.is_empty() {
            fs::create_dir(stage.join("images")).map_err(|e| e.to_string())?;
            for (name, bytes) in &images {
                fs::write(stage.join("images").join(name), bytes)
                    .map_err(|e| format!("暂存图片 {name} 失败：{e}"))?;
            }
        }
        Ok(())
    })();
    if let Err(e) = prepared {
        let _ = fs::remove_dir_all(&stage);
        let _ = fs::remove_dir_all(&rollback);
        return Err(e);
    }

    let current_json = managed_json_files(dir)?;
    let current_images = dir.join("images");
    let has_current_images = current_images.is_dir()
        && fs::read_dir(&current_images).map(|mut i| i.next().is_some()).unwrap_or(false);
    let safety_backup = if !current_json.is_empty() || has_current_images {
        let backups = dir.join("backups");
        fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
        let path = backups.join(format!("pre-restore-{stamp}.zip"));
        run_backup(dir, &path.to_string_lossy())?;
        Some(path)
    } else {
        None
    };

    let desired: Vec<String> = json_files.iter().map(|(name, _)| name.clone()).collect();
    let mut installed = Vec::new();
    let mut installed_images = false;
    let exchange = (|| -> Result<(), String> {
        for path in &current_json {
            let name = path.file_name().ok_or("当前数据文件名无效")?;
            fs::rename(path, rollback.join(name)).map_err(|e| format!("暂存当前数据失败：{e}"))?;
        }
        if current_images.exists() {
            fs::rename(&current_images, rollback.join("images"))
                .map_err(|e| format!("暂存当前图片失败：{e}"))?;
        }
        for name in &desired {
            fs::rename(stage.join(name), dir.join(name))
                .map_err(|e| format!("替换 {name} 失败：{e}"))?;
            installed.push(name.clone());
        }
        let staged_images = stage.join("images");
        if staged_images.exists() {
            fs::rename(staged_images, dir.join("images"))
                .map_err(|e| format!("替换图片目录失败：{e}"))?;
            installed_images = true;
        }
        Ok(())
    })();
    if let Err(e) = exchange {
        let _ = fs::remove_dir_all(&stage);
        return match rollback_restore(dir, &rollback, &installed, installed_images) {
            Ok(()) => {
                let _ = fs::remove_dir_all(&rollback);
                Err(format!("恢复失败，已回滚到原数据：{e}"))
            }
            Err(rollback_err) => Err(format!(
                "恢复失败且自动回滚未完成：{e}；{rollback_err}；原数据仍保留在 {}",
                rollback.display()
            )),
        };
    }
    let _ = fs::remove_dir_all(&stage);
    let _ = fs::remove_dir_all(&rollback);
    let backup_note = safety_backup
        .map(|p| format!("；恢复前备份：{}", p.display()))
        .unwrap_or_default();
    Ok(format!("{} 个数据文件、{} 张图片{}", json_files.len(), images.len(), backup_note))
}

/// 从本应用生成的 ZIP 恢复数据；完成全量校验与恢复前备份后才交换现有文件。
#[tauri::command]
pub async fn restore_data(app: tauri::AppHandle, source: String) -> Result<String, String> {
    use std::sync::atomic::Ordering;
    ensure_data_writable()?;
    if source.trim().is_empty() {
        return Err("未选择备份文件".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let source = PathBuf::from(source);
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = data_io_lock()?;
        ensure_data_writable()?;
        let summary = run_restore(&dir, &source)?;
        DATA_RESTORE_COMPLETE.store(true, Ordering::SeqCst);
        Ok(summary)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 启动自动备份：每天首次启动时把数据打包到 <应用数据目录>/backups/，保留最近 7 份。
/// stamp 由前端传入当天日期（YYYY-MM-DD），已备份过则跳过；返回摘要或空串（跳过）。
#[tauri::command]
pub async fn auto_backup(app: tauri::AppHandle, stamp: String) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = data_io_lock()?;
        run_auto_backup(&dir, &stamp)
    })
        .await
        .map_err(|e| e.to_string())?
}

pub fn run_auto_backup(dir: &std::path::Path, stamp: &str) -> Result<String, String> {
    const KEEP: usize = 7;
    let safe: String = stamp
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    if safe.is_empty() {
        return Err("日期戳无效".into());
    }
    if !dir.is_dir() {
        return Ok(String::new()); // 还没有任何数据，无需备份
    }
    let backups = dir.join("backups");
    fs::create_dir_all(&backups).map_err(|e| e.to_string())?;
    let dest = backups.join(format!("auto-{}.zip", safe));
    if dest.exists() {
        return Ok(String::new()); // 今天已经备份过
    }
    let summary = run_backup(dir, &dest.to_string_lossy())?;
    // 轮换清理：按文件名（含日期）排序，仅保留最近 KEEP 份
    let mut olds: Vec<PathBuf> = fs::read_dir(&backups)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.is_file()
                && p.file_name()
                    .map_or(false, |n| {
                        let n = n.to_string_lossy();
                        n.starts_with("auto-") && n.ends_with(".zip")
                    })
        })
        .collect();
    olds.sort();
    while olds.len() > KEEP {
        let _ = fs::remove_file(olds.remove(0));
    }
    Ok(summary)
}
