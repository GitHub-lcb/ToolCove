use std::fs;
/// 读取文本文件内容（用于导入 .sql 脚本；超过 2MB 拒绝）
#[tauri::command]
pub fn read_text_file(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 2 * 1024 * 1024 {
        return Err("文件超过 2MB，请直接粘贴 SQL 内容".to_string());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

pub const FILE_TOOL_MAX_TEXT_BYTES: u64 = 10 * 1024 * 1024;
pub const FILE_TOOL_MAX_BINARY_BYTES: u64 = 20 * 1024 * 1024;
pub const FILE_TOOL_MAX_RENAME_ITEMS: usize = 500;
pub const FILE_TOOL_MD5_TRAILER_BYTES: usize = 16;

pub fn system_time_millis(value: Result<std::time::SystemTime, std::io::Error>) -> Option<u64> {
    value
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_millis() as u64)
}

pub fn file_tool_metadata(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let metadata = fs::metadata(path).map_err(|e| format!("无法读取 {}：{e}", path.display()))?;
    let canonical = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    Ok(serde_json::json!({
        "path": canonical.to_string_lossy(),
        "name": path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
        "extension": path.extension().map(|extension| extension.to_string_lossy().into_owned()).unwrap_or_default(),
        "size": metadata.len(),
        "isFile": metadata.is_file(),
        "isDirectory": metadata.is_dir(),
        "readonly": metadata.permissions().readonly(),
        "createdAt": system_time_millis(metadata.created()),
        "modifiedAt": system_time_millis(metadata.modified()),
        "accessedAt": system_time_millis(metadata.accessed()),
    }))
}

/// 读取多个文件或目录的基础信息。
#[tauri::command]
pub async fn file_tool_inspect(paths: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    if paths.is_empty() || paths.len() > 200 {
        return Err("请选择 1 到 200 个文件或目录".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        paths
            .iter()
            .map(|path| file_tool_metadata(std::path::Path::new(path)))
            .collect()
    })
    .await
    .map_err(|e| format!("文件信息任务异常：{e}"))?
}

pub fn decode_file_text(bytes: &[u8], requested: &str) -> Result<(String, String, bool, bool), String> {
    let normalized = requested.trim().to_ascii_uppercase();
    let (encoding, bom_len) = if normalized == "AUTO" || normalized.is_empty() {
        if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
            ("UTF-8", 3)
        } else if bytes.starts_with(&[0xFF, 0xFE]) {
            ("UTF-16LE", 2)
        } else if bytes.starts_with(&[0xFE, 0xFF]) {
            ("UTF-16BE", 2)
        } else if std::str::from_utf8(bytes).is_ok() {
            ("UTF-8", 0)
        } else {
            let sample = &bytes[..bytes.len().min(4096)];
            let pairs = sample.len() / 2;
            let even_zeros = sample.iter().step_by(2).filter(|byte| **byte == 0).count();
            let odd_zeros = sample.iter().skip(1).step_by(2).filter(|byte| **byte == 0).count();
            if pairs > 2 && odd_zeros * 3 > pairs * 2 {
                ("UTF-16LE", 0)
            } else if pairs > 2 && even_zeros * 3 > pairs * 2 {
                ("UTF-16BE", 0)
            } else {
                ("GBK", 0)
            }
        }
    } else {
        match normalized.as_str() {
            "UTF-8" | "UTF-16LE" | "UTF-16BE" | "GBK" => (normalized.as_str(), 0),
            _ => return Err("不支持的文本编码".into()),
        }
    };
    let content = &bytes[bom_len..];
    let (text, lossy) = match encoding {
        "UTF-8" => match String::from_utf8(content.to_vec()) {
            Ok(text) => (text, false),
            Err(error) => (String::from_utf8_lossy(error.as_bytes()).into_owned(), true),
        },
        "UTF-16LE" => {
            let (text, _, had_errors) = encoding_rs::UTF_16LE.decode(content);
            (text.into_owned(), had_errors)
        }
        "UTF-16BE" => {
            let (text, _, had_errors) = encoding_rs::UTF_16BE.decode(content);
            (text.into_owned(), had_errors)
        }
        _ => {
            let (text, _, had_errors) = encoding_rs::GBK.decode(content);
            (text.into_owned(), had_errors)
        }
    };
    Ok((text, encoding.to_string(), bom_len > 0, lossy))
}

/// 按指定编码读取文本；AUTO 会识别 BOM、UTF-8、UTF-16 和 GBK。
#[tauri::command]
pub async fn file_tool_read_text(path: String, encoding: Option<String>) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::Path::new(&path);
        let metadata = fs::metadata(path).map_err(|e| format!("无法读取文件：{e}"))?;
        if !metadata.is_file() {
            return Err("请选择普通文件".into());
        }
        if metadata.len() > FILE_TOOL_MAX_TEXT_BYTES {
            return Err("文本文件超过 10 MB 限制".into());
        }
        let bytes = fs::read(path).map_err(|e| format!("无法读取文件：{e}"))?;
        let (text, detected, has_bom, lossy) = decode_file_text(&bytes, encoding.as_deref().unwrap_or("AUTO"))?;
        Ok(serde_json::json!({
            "path": path.to_string_lossy(),
            "name": path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
            "size": metadata.len(),
            "text": text,
            "encoding": detected,
            "hasBom": has_bom,
            "lossy": lossy,
        }))
    })
    .await
    .map_err(|e| format!("文本读取任务异常：{e}"))?
}

pub fn encode_file_text(text: &str, encoding: &str, bom: bool) -> Result<Vec<u8>, String> {
    let normalized = encoding.trim().to_ascii_uppercase();
    match normalized.as_str() {
        "UTF-8" => {
            let mut output = Vec::with_capacity(text.len() + if bom { 3 } else { 0 });
            if bom {
                output.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            output.extend_from_slice(text.as_bytes());
            Ok(output)
        }
        "UTF-16LE" | "UTF-16BE" => {
            let little_endian = normalized == "UTF-16LE";
            let mut output = Vec::with_capacity(text.len() * 2 + if bom { 2 } else { 0 });
            if bom {
                output.extend_from_slice(if little_endian { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
            }
            for unit in text.encode_utf16() {
                let bytes = if little_endian { unit.to_le_bytes() } else { unit.to_be_bytes() };
                output.extend_from_slice(&bytes);
            }
            Ok(output)
        }
        "GBK" => {
            let (bytes, _, had_errors) = encoding_rs::GBK.encode(text);
            if had_errors {
                return Err("文本包含 GBK 无法表示的字符".into());
            }
            Ok(bytes.into_owned())
        }
        _ => Err("不支持的文本编码".into()),
    }
}

/// 将文本按指定编码写入用户选定的新路径。
#[tauri::command]
pub async fn file_tool_write_text(path: String, text: String, encoding: String, bom: Option<bool>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = encode_file_text(&text, &encoding, bom.unwrap_or(false))?;
        if bytes.len() as u64 > FILE_TOOL_MAX_TEXT_BYTES {
            return Err("输出文本超过 10 MB 限制".into());
        }
        fs::write(&path, bytes).map_err(|e| format!("无法写入文件：{e}"))
    })
    .await
    .map_err(|e| format!("文本写入任务异常：{e}"))?
}

/// 读取二进制文件并返回 Base64，不把任意文件权限暴露给 WebView。
#[tauri::command]
pub async fn file_tool_read_base64(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let path = std::path::Path::new(&path);
        let metadata = fs::metadata(path).map_err(|e| format!("无法读取文件：{e}"))?;
        if !metadata.is_file() {
            return Err("请选择普通文件".into());
        }
        if metadata.len() > FILE_TOOL_MAX_BINARY_BYTES {
            return Err("源文件超过 20 MB 限制".into());
        }
        let content = fs::read(path).map_err(|e| format!("无法读取文件：{e}"))?;
        Ok(serde_json::json!({
            "path": path.to_string_lossy(),
            "name": path.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default(),
            "size": metadata.len(),
            "base64": base64::engine::general_purpose::STANDARD.encode(content),
        }))
    })
    .await
    .map_err(|e| format!("Base64 读取任务异常：{e}"))?
}

/// 解码 Base64 并写入新文件，支持粘贴 data URL。
#[tauri::command]
pub async fn file_tool_write_base64(path: String, content: String) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::Engine;
        let payload = content
            .trim()
            .strip_prefix("data:")
            .and_then(|value| value.split_once(',').map(|(_, data)| data))
            .unwrap_or(content.trim());
        let compact: String = payload.chars().filter(|char| !char.is_whitespace()).collect();
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(compact)
            .map_err(|e| format!("Base64 格式无效：{e}"))?;
        if bytes.len() as u64 > FILE_TOOL_MAX_BINARY_BYTES {
            return Err("解码结果超过 20 MB 限制".into());
        }
        fs::write(&path, &bytes).map_err(|e| format!("无法写入文件：{e}"))?;
        Ok(bytes.len() as u64)
    })
    .await
    .map_err(|e| format!("Base64 写入任务异常：{e}"))?
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Md5FileInfo {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub md5: String,
}

pub fn open_md5_source(path: &std::path::Path) -> Result<fs::File, String> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
        options.share_mode(FILE_SHARE_READ);
    }
    options.open(path).map_err(|e| format!("无法打开文件：{e}"))
}

pub fn source_metadata_unchanged(before: &fs::Metadata, after: &fs::Metadata, bytes_read: u64) -> bool {
    before.len() == bytes_read
        && after.len() == before.len()
        && before.modified().ok() == after.modified().ok()
}

pub fn path_matches_file(path: &std::path::Path, source: &same_file::Handle) -> Result<bool, String> {
    match same_file::Handle::from_path(path) {
        Ok(target) => Ok(source == &target),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(format!("无法检查输出文件：{error}")),
    }
}

pub fn replace_file_with_rollback(
    temp_path: &std::path::Path,
    target: &std::path::Path,
    backup_path: &std::path::Path,
    source_identity: &same_file::Handle,
) -> Result<(), String> {
    if !target.exists() {
        return fs::rename(temp_path, target).map_err(|e| format!("无法保存副本：{e}"));
    }
    if backup_path.exists() {
        return Err(format!("目标备份路径已存在：{}", backup_path.display()));
    }
    fs::rename(target, backup_path).map_err(|e| format!("无法暂存原目标文件：{e}"))?;
    let restore = |reason: String| match fs::rename(backup_path, target) {
        Ok(()) => Err(format!("{reason}；原目标文件已恢复")),
        Err(restore_error) => Err(format!(
            "{reason}；原目标文件保留在 {}，自动恢复失败：{restore_error}",
            backup_path.display()
        )),
    };
    match path_matches_file(backup_path, source_identity) {
        Ok(true) => return restore("输出文件与源文件指向同一文件，已取消操作".into()),
        Ok(false) => {}
        Err(error) => return restore(error),
    }
    if let Err(commit_error) = fs::rename(temp_path, target) {
        return restore(format!("无法保存副本：{commit_error}"));
    }
    let _ = fs::remove_file(backup_path);
    Ok(())
}

pub fn calculate_file_md5(path: &std::path::Path) -> Result<Md5FileInfo, String> {
    use md5::{Digest, Md5};
    use std::io::Read;

    let mut file = open_md5_source(path)?;
    let metadata = file
        .metadata()
        .map_err(|e| format!("无法读取文件信息：{e}"))?;
    if !metadata.is_file() {
        return Err("请选择普通文件".into());
    }
    let mut hasher = Md5::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut bytes_read = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|e| format!("读取文件失败：{e}"))?;
        if read == 0 {
            break;
        }
        bytes_read += read as u64;
        hasher.update(&buffer[..read]);
    }
    let final_metadata = file
        .metadata()
        .map_err(|e| format!("无法复核文件信息：{e}"))?;
    if !source_metadata_unchanged(&metadata, &final_metadata, bytes_read) {
        return Err("读取期间源文件发生变化，请重试".into());
    }
    let md5 = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(Md5FileInfo {
        path: path.to_string_lossy().into_owned(),
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        size: bytes_read,
        md5,
    })
}

/// 流式计算用户选定文件的 MD5。
#[tauri::command]
pub async fn file_tool_calculate_md5(path: String) -> Result<Md5FileInfo, String> {
    tauri::async_runtime::spawn_blocking(move || calculate_file_md5(std::path::Path::new(&path)))
        .await
        .map_err(|e| format!("MD5 计算任务异常：{e}"))?
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Md5CopyResult {
    pub source_path: String,
    pub output_path: String,
    pub source_size: u64,
    pub output_size: u64,
    pub appended_bytes: usize,
    pub original_md5: String,
    pub new_md5: String,
}

pub fn run_md5_copy(
    source_path: &std::path::Path,
    output_path: &std::path::Path,
    trailer: &[u8],
) -> Result<Md5CopyResult, String> {
    use md5::{Digest, Md5};
    use std::io::{Read, Write};

    if trailer.is_empty() {
        return Err("随机数据不能为空".into());
    }
    let source = fs::canonicalize(source_path).map_err(|e| format!("无法读取源文件：{e}"))?;
    let mut input = open_md5_source(&source)?;
    let source_metadata = input
        .metadata()
        .map_err(|e| format!("无法读取源文件信息：{e}"))?;
    let source_identity = same_file::Handle::from_file(
        input
            .try_clone()
            .map_err(|e| format!("无法复制源文件句柄：{e}"))?,
    )
    .map_err(|e| format!("无法识别源文件：{e}"))?;
    if !source_metadata.is_file() {
        return Err("请选择普通文件".into());
    }
    let output_parent = output_path.parent().ok_or("无法确定输出目录")?;
    let output_name = output_path.file_name().ok_or("输出文件名无效")?;
    let canonical_parent =
        fs::canonicalize(output_parent).map_err(|e| format!("无法读取输出目录：{e}"))?;
    let target = canonical_parent.join(output_name);
    if target == source {
        return Err("源文件和输出文件不能相同".into());
    }
    if path_matches_file(&target, &source_identity)? {
        return Err("源文件和输出文件指向同一文件".into());
    }
    let suffix = trailer
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temp_name = format!(".{}.md5-{suffix}.tmp", output_name.to_string_lossy());
    let backup_name = format!(".{}.md5-{suffix}.bak", output_name.to_string_lossy());
    let temp_path = canonical_parent.join(temp_name);
    let backup_path = canonical_parent.join(backup_name);
    let result = (|| -> Result<Md5CopyResult, String> {
        let mut output = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)
            .map_err(|e| format!("无法创建临时文件：{e}"))?;
        let mut original_hasher = Md5::new();
        let mut output_hasher = Md5::new();
        let mut buffer = vec![0u8; 1024 * 1024];
        let mut bytes_read = 0u64;
        loop {
            let read = input
                .read(&mut buffer)
                .map_err(|e| format!("读取源文件失败：{e}"))?;
            if read == 0 {
                break;
            }
            bytes_read += read as u64;
            let chunk = &buffer[..read];
            original_hasher.update(chunk);
            output_hasher.update(chunk);
            output
                .write_all(chunk)
                .map_err(|e| format!("写入副本失败：{e}"))?;
        }
        output_hasher.update(trailer);
        output
            .write_all(trailer)
            .map_err(|e| format!("写入随机数据失败：{e}"))?;
        output.flush().map_err(|e| format!("刷新副本失败：{e}"))?;
        drop(output);
        let final_source_metadata = input
            .metadata()
            .map_err(|e| format!("无法复核源文件信息：{e}"))?;
        if !source_metadata_unchanged(&source_metadata, &final_source_metadata, bytes_read) {
            return Err("复制期间源文件发生变化，请重试".into());
        }

        let original_md5 = original_hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let new_md5 = output_hasher
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        if original_md5 == new_md5 {
            return Err("随机数据未改变 MD5，请重试".into());
        }
        if path_matches_file(&target, &source_identity)? {
            return Err("提交前发现输出文件指向源文件，已取消操作".into());
        }
        replace_file_with_rollback(&temp_path, &target, &backup_path, &source_identity)?;
        Ok(Md5CopyResult {
            source_path: source_path.to_string_lossy().into_owned(),
            output_path: output_path.to_string_lossy().into_owned(),
            source_size: bytes_read,
            output_size: bytes_read + trailer.len() as u64,
            appended_bytes: trailer.len(),
            original_md5,
            new_md5,
        })
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

/// 复制源文件并追加系统随机字节，生成 MD5 不同的新文件。
#[tauri::command]
pub async fn file_tool_modify_md5(
    source_path: String,
    output_path: String,
) -> Result<Md5CopyResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut trailer = [0u8; FILE_TOOL_MD5_TRAILER_BYTES];
        getrandom::fill(&mut trailer).map_err(|e| format!("生成随机数据失败：{e}"))?;
        run_md5_copy(
            std::path::Path::new(&source_path),
            std::path::Path::new(&output_path),
            &trailer,
        )
    })
    .await
    .map_err(|e| format!("MD5 修改任务异常：{e}"))?
}

/// 列出目录第一层的普通文件，供批量重命名生成预览。
#[tauri::command]
pub async fn file_tool_list_directory(path: String) -> Result<Vec<serde_json::Value>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = std::path::Path::new(&path);
        if !directory.is_dir() {
            return Err("请选择有效文件夹".into());
        }
        let mut files = Vec::new();
        for entry in fs::read_dir(directory).map_err(|e| format!("无法读取文件夹：{e}"))? {
            let entry = entry.map_err(|e| format!("无法读取目录项：{e}"))?;
            let metadata = entry.metadata().map_err(|e| format!("无法读取文件信息：{e}"))?;
            if !metadata.is_file() {
                continue;
            }
            if files.len() >= 1000 {
                return Err("文件夹超过 1000 个文件，请缩小处理范围".into());
            }
            files.push(serde_json::json!({
                "path": entry.path().to_string_lossy(),
                "name": entry.file_name().to_string_lossy(),
                "size": metadata.len(),
                "modifiedAt": system_time_millis(metadata.modified()),
            }));
        }
        files.sort_by_key(|item| item.get("name").and_then(|name| name.as_str()).unwrap_or("").to_lowercase());
        Ok(files)
    })
    .await
    .map_err(|e| format!("目录读取任务异常：{e}"))?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRenameItem {
    pub path: String,
    pub target_name: String,
}

pub fn validate_rename_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name == "." || name == ".." {
        return Err("目标文件名不能为空".into());
    }
    if name.ends_with([' ', '.']) || name.chars().any(|character| {
        character < '\u{20}' || matches!(character, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    }) {
        return Err(format!("目标文件名包含非法字符：{name}"));
    }
    if std::path::Path::new(name).file_name().and_then(|value| value.to_str()) != Some(name) {
        return Err("目标名称只能是文件名，不能包含路径".into());
    }
    let stem = name.split('.').next().unwrap_or("");
    let reserved = matches!(stem.to_ascii_uppercase().as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "COM1" | "COM2" | "COM3" | "COM4" | "COM5" |
        "COM6" | "COM7" | "COM8" | "COM9" | "LPT1" | "LPT2" | "LPT3" | "LPT4" | "LPT5" |
        "LPT6" | "LPT7" | "LPT8" | "LPT9");
    if reserved {
        return Err(format!("目标文件名是 Windows 保留名称：{name}"));
    }
    Ok(())
}

pub fn rename_path_key(path: &std::path::Path) -> String {
    path.to_string_lossy().to_lowercase()
}

pub fn run_batch_rename(items: Vec<FileRenameItem>) -> Result<u32, String> {
    use std::collections::HashSet;
    if items.is_empty() || items.len() > FILE_TOOL_MAX_RENAME_ITEMS {
        return Err(format!("单次请选择 1 到 {FILE_TOOL_MAX_RENAME_ITEMS} 个文件"));
    }
    let mut operations = Vec::new();
    let mut source_keys = HashSet::new();
    let mut moving_source_keys = HashSet::new();
    let mut target_keys = HashSet::new();
    for item in items {
        validate_rename_name(&item.target_name)?;
        let source = std::path::PathBuf::from(item.path);
        if !source.is_file() {
            return Err(format!("源文件不存在：{}", source.display()));
        }
        let parent = source.parent().ok_or("无法确定源文件目录")?;
        let target = parent.join(&item.target_name);
        let source_key = rename_path_key(&source);
        let target_key = rename_path_key(&target);
        if !source_keys.insert(source_key.clone()) {
            return Err("重命名清单包含重复源文件".into());
        }
        if !target_keys.insert(target_key) {
            return Err(format!("存在重复目标文件名：{}", item.target_name));
        }
        if source.file_name().and_then(|name| name.to_str()) == Some(item.target_name.as_str()) {
            continue;
        }
        moving_source_keys.insert(source_key);
        operations.push((source, target));
    }
    if operations.is_empty() {
        return Ok(0);
    }
    for (_, target) in &operations {
        if target.exists() && !moving_source_keys.contains(&rename_path_key(target)) {
            return Err(format!("目标文件已存在：{}", target.display()));
        }
    }

    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let mut staged: Vec<(std::path::PathBuf, std::path::PathBuf, std::path::PathBuf)> = Vec::new();
    for (index, (source, target)) in operations.into_iter().enumerate() {
        let parent = source.parent().ok_or("无法确定源文件目录")?;
        let mut temporary = parent.join(format!(".zg-work-rename-{stamp}-{index}.tmp"));
        let mut attempt = 0u32;
        while temporary.exists() {
            attempt += 1;
            temporary = parent.join(format!(".zg-work-rename-{stamp}-{index}-{attempt}.tmp"));
        }
        if let Err(error) = fs::rename(&source, &temporary) {
            for (original, _, staged_path) in staged.iter().rev() {
                let _ = fs::rename(staged_path, original);
            }
            return Err(format!("暂存 {} 失败：{error}", source.display()));
        }
        staged.push((source, target, temporary));
    }

    for index in 0..staged.len() {
        let (_, target, temporary) = &staged[index];
        if let Err(error) = fs::rename(temporary, target) {
            for committed in (0..index).rev() {
                let (_, committed_target, committed_temp) = &staged[committed];
                let _ = fs::rename(committed_target, committed_temp);
            }
            for (original, _, staged_path) in staged.iter().rev() {
                let _ = fs::rename(staged_path, original);
            }
            return Err(format!("写入目标文件名 {} 失败：{error}", target.display()));
        }
    }
    Ok(staged.len() as u32)
}

/// 执行已预览的批量重命名；使用临时名分两阶段提交以支持文件名互换和大小写变更。
#[tauri::command]
pub async fn file_tool_batch_rename(items: Vec<FileRenameItem>) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || run_batch_rename(items))
        .await
        .map_err(|e| format!("批量重命名任务异常：{e}"))?
}
