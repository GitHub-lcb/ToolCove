//! 磁盘迁移（磁盘分析助手的「不删就搬」）：把目录搬到另一块盘，并在原位置留一个目录联接（junction）。
//!
//! 为什么是 junction 而不是符号链接：junction 创建免管理员权限（符号链接需要开发者模式或提权），
//! 代价是只能指向本地卷——正好覆盖「搬到本机另一块盘」这个唯一场景。
//!
//! **顺序设计是本模块最重要的部分：任何中途失败都不能留下「源没了、链接没建」的状态。**
//!   1. 勘察：真实字节数/文件数 + 链接检测（含链接的目录整单拒绝——半搬半留比不搬更糟）
//!   2. 复制 + 逐项校验（大小不符重试一次）：此阶段源目录完好无损，程序照常可用；
//!      复制失败只删掉我们自己的那份半成品，源目录一个字节都不动
//!   3. 原子切换：源目录改名暂存（同卷 rename，瞬间完成）→ 原位置创建 junction；
//!      建链接失败就把暂存目录改回原名——撤回到「源完好」状态
//!   4. 清理暂存目录：删不掉的（被占用）如实计为残留并报出路径——此时链接已生效，功能不受影响
//!
//! 回滚是同一套动作反过来：先删链接（只删链接，不动数据）→ 把数据整体搬回 → 搬回失败必须把链接恢复，
//! 否则按原路径访问的程序当场就断了。回滚不建链接，所以复用同一条流水线（link_back = false）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::Emitter;
use tauri::Manager;

use crate::disk::volume_key;

pub const EVENT_PROGRESS: &str = "disk:migrate-progress";
/// 进度事件节流。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(200);
/// 目标卷空间余量：数据本身之外再留 5% 或 2GB（取大者）——元数据、文件系统开销与写入抖动。
const FREE_MARGIN_RATIO: f64 = 0.05;
const FREE_MARGIN_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// 暂存目录名后缀：带时间戳，同一目录多次迁移不会撞名。
const STAGING_SUFFIX: &str = ".toolcove-migrating-";
const LEFTOVER_REPORT_LIMIT: usize = 5;
const LINK_REPORT_LIMIT: usize = 3;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeStats {
    pub bytes: u64,
    pub files: u64,
    /// 目录树里发现的链接（最多报几条，够用户定位问题）。
    pub links: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationPlan {
    pub source: String,
    pub target_parent: String,
    pub target_path: String,
    pub name: String,
    pub bytes: u64,
    pub files: u64,
    pub free_bytes: u64,
    pub needed_bytes: u64,
    /// 可以搬、但值得先读一眼的风险提示（UWP / 系统组件 / Temp 等）
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrateReport {
    pub source: String,
    pub target_parent: String,
    pub target_path: String,
    pub moved_bytes: u64,
    pub moved_files: u64,
    pub leftovers: u64,
    pub leftover_paths: Vec<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug)]
pub struct MigrateFailure {
    pub canceled: bool,
    pub message: String,
}

impl MigrateFailure {
    fn canceled() -> Self {
        Self { canceled: true, message: "迁移已取消".into() }
    }
    fn failed(message: impl Into<String>) -> Self {
        Self { canceled: false, message: message.into() }
    }
}

#[derive(Debug, Clone)]
pub struct Progress {
    pub phase: &'static str,
    pub copied_bytes: u64,
    pub total_bytes: u64,
    pub files: u64,
    pub total_files: u64,
    pub current: String,
}

fn margin_for(bytes: u64) -> u64 {
    ((bytes as f64 * FREE_MARGIN_RATIO) as u64).max(FREE_MARGIN_BYTES)
}

/// 规范化的绝对路径（解析链接与大小写）；不存在就退回原路径，比较失败宁可放过也不误伤。
fn normalize(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_inside(child: &Path, parent: &Path) -> bool {
    let child = normalize(child);
    let parent = normalize(parent);
    child != parent && child.starts_with(&parent)
}

/// 系统目录黑名单：这些地方搬了会把系统或本应用自己弄坏，宁可拒绝也不「试试看」。
fn blocked_reason(source: &Path, app_data_dir: Option<&Path>) -> Option<String> {
    if source.parent().is_none() {
        return Some("不能迁移磁盘根目录".into());
    }
    let normalized = normalize(source);
    if let Ok(profile) = std::env::var("USERPROFILE") {
        if !profile.trim().is_empty() && normalized == normalize(Path::new(&profile)) {
            return Some("不能迁移用户目录本身（只能迁移它里面的具体子目录）".into());
        }
    }
    let mut subtrees: Vec<(PathBuf, &str)> = Vec::new();
    for (var, label) in [
        ("SystemRoot", "系统目录（Windows）"),
        ("ProgramFiles", "程序目录（Program Files）"),
        ("ProgramFiles(x86)", "程序目录（Program Files x86）"),
        ("ProgramData", "系统共享数据目录（ProgramData）"),
    ] {
        if let Ok(value) = std::env::var(var) {
            if !value.trim().is_empty() {
                subtrees.push((normalize(Path::new(&value)), label));
            }
        }
    }
    for (root, label) in subtrees {
        if normalized == root || is_inside(&normalized, &root) {
            return Some(format!("不能迁移{label}内的内容（{}）", root.display()));
        }
    }
    if let Some(app_data) = app_data_dir {
        let app_data = normalize(app_data);
        // 在应用数据目录内：搬它就是在搬自己脚下的地板
        if normalized == app_data || is_inside(&normalized, &app_data) {
            return Some(format!("不能迁移本应用的数据目录内的内容（{}）", app_data.display()));
        }
        // **包含**应用数据目录（典型：整个 AppData\Roaming / AppData）：搬到一半会把本应用正在写的文件
        // 一起搬走，而且这套数据在应用运行期间一直有打开的文件——复制校验必失败、白搬几十 GB。
        // 真机就有人问「AppData 能不能整个搬」，所以这条要在开搬前挡住并给出替代做法。
        if is_inside(&app_data, &normalized) {
            return Some(format!(
                "这个目录包含本应用正在使用的数据目录（{}）：整目录迁移会把它一起搬走，应用边写边搬必然失败。请改迁更小的子目录（例如 {} 下的具体应用目录），或退出本应用后用文件管理器手工搬",
                app_data.display(),
                normalized.display()
            ));
        }
    }
    None
}

/// 需要提醒但不必拒绝的地方：搬得动，但这些目录有更大概率让**某个应用**不高兴。
/// `local_appdata` 由调用方注入（单测传临时路径即可，不碰真机目录）。
fn warnings_for(source: &Path, local_appdata: Option<&Path>) -> Vec<String> {
    let Some(local_appdata) = local_appdata else { return Vec::new() };
    let normalized = normalize(source);
    let local = normalize(local_appdata);
    let mut warnings: Vec<String> = Vec::new();
    if is_inside(&normalized, &local.join("Packages")) {
        warnings.push("这是商店应用（UWP）的数据目录：个别应用对目录联接敏感，迁移后若某个应用异常，可以直接回滚".into());
    }
    if is_inside(&normalized, &local.join("Microsoft")) {
        warnings.push("这里包含系统组件数据（Windows 搜索、凭据、部分运行时）：迁移前请确认没有依赖它的系统功能，出问题及时回滚".into());
    }
    if is_inside(&normalized, &local.join("Temp")) {
        warnings.push("Temp 是被所有程序高频读写的目录：文件被占用时迁移会整单失败，且个别安装程序不喜欢 Temp 是链接".into());
    }
    if normalized == local {
        warnings.push("整个 AppData\\Local 装着所有应用的缓存与商店应用数据：建议改迁其中具体的子目录（如某个缓存目录），范围越小越安全".into());
    }
    warnings
}

/// 目标卷可用空间。
#[cfg(windows)]
pub fn volume_free_bytes(path: &Path) -> Option<u64> {
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let first = path.components().next()?;
    let mut root = first.as_os_str().to_string_lossy().into_owned();
    if !root.ends_with('\\') && !root.ends_with('/') {
        root.push('\\');
    }
    let mut wide: Vec<u16> = root.encode_utf16().collect();
    wide.push(0);
    let mut available_to_caller = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available_to_caller, &mut total, &mut free) };
    if ok == 0 {
        return None;
    }
    Some(free)
}

#[cfg(not(windows))]
pub fn volume_free_bytes(_path: &Path) -> Option<u64> {
    None
}

fn merge_stats(into: &mut TreeStats, from: TreeStats) {
    into.bytes += from.bytes;
    into.files += from.files;
    for link in from.links {
        if into.links.len() < LINK_REPORT_LIMIT && !into.links.contains(&link) {
            into.links.push(link);
        }
    }
}

/// 并行勘察：真实字节数、文件数与链接清单（迁移按真实数据算空间，不信界面上的快照数字）。
pub fn inspect_tree(root: &Path) -> Result<TreeStats, String> {
    let entries = std::fs::read_dir(root).map_err(|error| format!("无法读取 {}：{error}", root.display()))?;
    let mut totals = TreeStats { bytes: 0, files: 0, links: Vec::new() };
    let mut subdirs: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("无法读取 {} 的目录项：{error}", root.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取 {} 的类型：{error}", entry.path().display()))?;
        if file_type.is_symlink() {
            if totals.links.len() < LINK_REPORT_LIMIT {
                totals.links.push(entry.path().to_string_lossy().into_owned());
            }
            continue;
        }
        if file_type.is_dir() {
            subdirs.push(entry.path());
        } else if file_type.is_file() {
            let metadata = entry
                .metadata()
                .map_err(|error| format!("无法读取 {} 的信息：{error}", entry.path().display()))?;
            totals.bytes += metadata.len();
            totals.files += 1;
        }
    }
    match subdirs.len() {
        0 => {}
        1 => merge_stats(&mut totals, inspect_tree(&subdirs[0])?),
        _ => {
            use rayon::prelude::*;
            let results: Vec<Result<TreeStats, String>> = subdirs.par_iter().map(|subdir| inspect_tree(subdir)).collect();
            for result in results {
                merge_stats(&mut totals, result?);
            }
        }
    }
    Ok(totals)
}

/// 迁移计划（检查命令与启动前都会跑一遍）：所有拒绝理由都在这里给出，且**不做任何写操作**。
pub fn plan_migration(source: &Path, target_parent: &Path, app_data_dir: Option<&Path>) -> Result<MigrationPlan, String> {
    if !source.is_dir() {
        return Err(format!("源目录不存在或不可访问：{}", source.display()));
    }
    if std::fs::symlink_metadata(source)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err("该目录本身是链接（junction / 符号链接），无需再迁移".into());
    }
    if let Some(reason) = blocked_reason(source, app_data_dir) {
        return Err(reason);
    }
    if !target_parent.is_dir() {
        return Err(format!("目标位置不存在或不可访问：{}", target_parent.display()));
    }
    if is_inside(target_parent, source) {
        return Err("目标位置在源目录内部，这会把数据搬进它自己".into());
    }
    let name = source
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or("源目录名无效")?;
    let target_path = target_parent.join(&name);
    if target_path.exists() {
        return Err(format!("目标位置已存在同名目录：{}", target_path.display()));
    }
    // 按**物理卷**比较（canonicalize）：源路径可能穿过 junction 指向另一块盘，
    // 只比字面盘符会让「其实在同一块盘上倒腾」的搬迁混过去——那既不释放空间，还平白多一个链接。
    if volume_key(&normalize(source)) == volume_key(&normalize(target_parent)) {
        return Err("同一磁盘内搬迁不会释放空间（原地留链接只解决跨盘）；只是想换个位置的话，用文件管理器移过去即可".into());
    }
    let stats = inspect_tree(source)?;
    if !stats.links.is_empty() {
        return Err(format!(
            "源目录里包含链接（junction / 符号链接）：{}。整单拒绝——链接指向的数据搬不进来，半搬半留比不搬更糟",
            stats.links.join("、")
        ));
    }
    let needed_bytes = stats.bytes + margin_for(stats.bytes);
    let free_bytes = volume_free_bytes(target_parent)
        .ok_or_else(|| format!("无法读取目标磁盘的可用空间：{}", target_parent.display()))?;
    if free_bytes < needed_bytes {
        return Err(format!(
            "目标磁盘空间不足：需要 {}（含余量），可用 {}",
            human(needed_bytes),
            human(free_bytes)
        ));
    }
    Ok(MigrationPlan {
        source: source.to_string_lossy().into_owned(),
        target_parent: target_parent.to_string_lossy().into_owned(),
        target_path: target_path.to_string_lossy().into_owned(),
        name,
        bytes: stats.bytes,
        files: stats.files,
        free_bytes,
        needed_bytes,
        warnings: warnings_for(
            source,
            std::env::var("LOCALAPPDATA")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .map(PathBuf::from)
                .as_deref(),
        ),
    })
}

fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

struct MigrateCtx {
    cancel: Arc<AtomicBool>,
    abort: AtomicBool,
    error: Mutex<Option<String>>,
    copied_bytes: AtomicU64,
    copied_files: AtomicU64,
    total_bytes: u64,
    total_files: u64,
    last_emit: Mutex<Instant>,
    progress: Option<Box<dyn Fn(Progress) + Send + Sync>>,
}

impl MigrateCtx {
    fn should_stop(&self) -> bool {
        self.cancel.load(Ordering::Relaxed) || self.abort.load(Ordering::Relaxed)
    }

    fn record_error(&self, message: String) {
        if let Ok(mut slot) = self.error.lock() {
            if slot.is_none() {
                *slot = Some(message);
            }
        }
        self.abort.store(true, Ordering::Relaxed);
    }

    fn tick(&self, phase: &'static str, current: &Path, force: bool) {
        let Some(callback) = self.progress.as_ref() else { return };
        if !force {
            let Ok(mut last) = self.last_emit.lock() else { return };
            if last.elapsed() < PROGRESS_INTERVAL {
                return;
            }
            *last = Instant::now();
        }
        callback(Progress {
            phase,
            copied_bytes: self.copied_bytes.load(Ordering::Relaxed),
            total_bytes: self.total_bytes,
            files: self.copied_files.load(Ordering::Relaxed),
            total_files: self.total_files,
            current: current.to_string_lossy().into_owned(),
        });
    }

    fn failure(&self) -> MigrateFailure {
        if let Ok(slot) = self.error.lock() {
            if let Some(message) = slot.as_ref() {
                return MigrateFailure::failed(message.clone());
            }
        }
        if self.cancel.load(Ordering::Relaxed) {
            return MigrateFailure::canceled();
        }
        MigrateFailure::failed("迁移中断")
    }
}

/// 单文件复制 + 大小校验。
///
/// 两类失败都退避重试：
///  - **共享冲突（os error 32/33）**：真机最常见的失败——杀毒实时扫描、Search 索引、
///    应用残留后台进程（真机实测：WPS 的常驻 `wps.exe` 一直开着 addons 资源，关掉文档窗口也不释放；
///    37,507 个文件里就卡在 1 个 `.svg` 上，整单白搬 2.4 GB）。这类占用大多几百毫秒内消失。
///  - **大小不符**：源文件正在被写（复制到一半变长/变短）。
/// 其它错误（找不到、权限、磁盘满）立即失败，不浪费时间重试。
fn copy_file_verified(source: &Path, target: &Path, ctx: &MigrateCtx) -> Result<(), String> {
    const RETRY_DELAYS_MS: [u64; 4] = [0, 400, 1200, 2500];
    let expected = std::fs::metadata(source)
        .map_err(|error| format!("无法读取 {}：{error}", source.display()))?
        .len();
    let mut last_error = String::new();
    for (attempt, delay) in RETRY_DELAYS_MS.iter().enumerate() {
        if *delay > 0 {
            std::thread::sleep(Duration::from_millis(*delay));
        }
        if attempt > 0 {
            let _ = std::fs::remove_file(target);
        }
        match std::fs::copy(source, target) {
            Ok(_) => {
                let copied = std::fs::metadata(target)
                    .map_err(|error| format!("无法校验 {}：{error}", target.display()))?
                    .len();
                if copied == expected {
                    ctx.copied_bytes.fetch_add(copied, Ordering::Relaxed);
                    ctx.copied_files.fetch_add(1, Ordering::Relaxed);
                    return Ok(());
                }
                last_error = format!("文件在复制过程中发生变化（可能正被写入）：{}", source.display());
            }
            Err(error) => {
                if ctx.should_stop() {
                    return Err("已中止".into());
                }
                let raw = error.raw_os_error().unwrap_or(0);
                if raw == 32 || raw == 33 {
                    last_error = format!(
                        "复制失败 {}：{error}（另一个程序正占用它——常见于杀毒实时扫描、搜索索引、\
                         或该应用的残留后台进程；请关掉相关应用（含托盘/后台进程）后重试）",
                        source.display()
                    );
                    continue;
                }
                return Err(format!("复制失败 {}：{error}", source.display()));
            }
        }
    }
    Err(last_error)
}

fn copy_dir(source: &Path, target: &Path, ctx: &MigrateCtx) -> Result<(), String> {
    if ctx.should_stop() {
        return Err("已中止".into());
    }
    std::fs::create_dir_all(target).map_err(|error| format!("无法创建 {}：{error}", target.display()))?;
    let entries = std::fs::read_dir(source).map_err(|error| format!("无法读取 {}：{error}", source.display()))?;
    let mut subdirs: Vec<(PathBuf, PathBuf)> = Vec::new();
    for entry in entries {
        if ctx.should_stop() {
            return Err("已中止".into());
        }
        let entry = entry.map_err(|error| format!("无法读取 {} 的目录项：{error}", source.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("无法读取 {} 的类型：{error}", entry.path().display()))?;
        if file_type.is_symlink() {
            // 勘察阶段已拒绝含链接的目录；这里再兜一层（勘察与复制之间可能被塞进链接）
            return Err(format!("复制过程中发现链接：{}", entry.path().display()));
        }
        let target_path = target.join(entry.file_name());
        if file_type.is_dir() {
            subdirs.push((entry.path(), target_path));
        } else if file_type.is_file() {
            copy_file_verified(&entry.path(), &target_path, ctx)?;
            ctx.tick("copy", &entry.path(), false);
        }
    }
    match subdirs.len() {
        0 => Ok(()),
        1 => {
            let (source_dir, target_dir) = &subdirs[0];
            copy_dir(source_dir, target_dir, ctx)
        }
        _ => {
            use rayon::prelude::*;
            let results: Vec<Result<(), String>> = subdirs
                .par_iter()
                .map(|(source_dir, target_dir)| copy_dir(source_dir, target_dir, ctx))
                .collect();
            for result in results {
                result?;
            }
            Ok(())
        }
    }
}

/// 尽力删除整棵树：删不掉的（被占用/权限）只记录，不中断——清理阶段链接已生效，残留只是垃圾。
fn remove_tree_collect(root: &Path, leftovers: &mut u64, leftover_paths: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        *leftovers += 1;
        if leftover_paths.len() < LEFTOVER_REPORT_LIMIT {
            leftover_paths.push(root.to_string_lossy().into_owned());
        }
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_dir = entry.file_type().map(|file_type| file_type.is_dir()).unwrap_or(false);
        if is_dir {
            remove_tree_collect(&path, leftovers, leftover_paths);
        } else if std::fs::remove_file(&path).is_err() {
            *leftovers += 1;
            if leftover_paths.len() < LEFTOVER_REPORT_LIMIT {
                leftover_paths.push(path.to_string_lossy().into_owned());
            }
        }
    }
    if std::fs::remove_dir(root).is_err() {
        *leftovers += 1;
        if leftover_paths.len() < LEFTOVER_REPORT_LIMIT {
            leftover_paths.push(root.to_string_lossy().into_owned());
        }
    }
}

fn staging_path(source: &Path) -> Result<PathBuf, String> {
    let parent = source.parent().ok_or("源目录没有上级目录")?;
    let name = source.file_name().ok_or("源目录名无效")?.to_string_lossy().into_owned();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    Ok(parent.join(format!("{name}{STAGING_SUFFIX}{stamp}")))
}

/// 删掉我们自己的半成品副本（复制阶段失败时的回滚）：只删我们刚创建的目录，安全。
fn discard_target_copy(target_path: &Path) {
    let _ = std::fs::remove_dir_all(target_path);
}

#[cfg(windows)]
fn create_junction(target: &Path, junction: &Path) -> Result<(), String> {
    junction::create(target, junction).map_err(|error| format!("创建目录联接失败：{error}"))
}

#[cfg(not(windows))]
fn create_junction(_target: &Path, _junction: &Path) -> Result<(), String> {
    Err("当前平台不支持目录联接（仅 Windows）".into())
}

/// 源路径是否是一个指向 `target` 的链接（回滚前的校验：只认我们的迁移结果，防止误删真实目录）。
#[cfg(windows)]
fn junction_targets(source: &Path, target: &Path) -> bool {
    let Ok(link) = std::fs::read_link(source) else { return false };
    normalize(&link) == normalize(target)
}

#[cfg(not(windows))]
fn junction_targets(_source: &Path, _target: &Path) -> bool {
    false
}

/// 执行一次迁移（复制 → 原子切换 → 清理）。
/// `link_back = true`：搬到 target 并在原位置留 junction；`false`：回滚——搬回原位置但不建链接。
pub fn run_migration(
    source: &Path,
    target_parent: &Path,
    link_back: bool,
    cancel: Arc<AtomicBool>,
    progress: Option<Box<dyn Fn(Progress) + Send + Sync>>,
) -> Result<MigrateReport, MigrateFailure> {
    let started = Instant::now();
    let stats = match inspect_tree(source) {
        Ok(stats) => stats,
        Err(error) => return Err(MigrateFailure::failed(error)),
    };
    if !stats.links.is_empty() {
        return Err(MigrateFailure::failed(format!("源目录里包含链接：{}", stats.links.join("、"))));
    }
    let name = match source.file_name() {
        Some(name) => name.to_string_lossy().into_owned(),
        None => return Err(MigrateFailure::failed("源目录名无效")),
    };
    let target_path = target_parent.join(&name);
    if target_path.exists() {
        return Err(MigrateFailure::failed(format!(
            "目标位置已存在同名目录：{}",
            target_path.display()
        )));
    }

    let ctx = MigrateCtx {
        cancel,
        abort: AtomicBool::new(false),
        error: Mutex::new(None),
        copied_bytes: AtomicU64::new(0),
        copied_files: AtomicU64::new(0),
        total_bytes: stats.bytes,
        total_files: stats.files,
        last_emit: Mutex::new(Instant::now() - PROGRESS_INTERVAL),
        progress,
    };

    // 阶段 1：复制 + 逐项校验。此阶段源目录完好无损，失败只需删掉我们自己的半成品。
    ctx.tick("copy", source, true);
    if let Err(error) = copy_dir(source, &target_path, &ctx) {
        discard_target_copy(&target_path);
        if error == "已中止" {
            return Err(ctx.failure());
        }
        return Err(MigrateFailure::failed(error));
    }
    if ctx.cancel.load(Ordering::Relaxed) {
        discard_target_copy(&target_path);
        return Err(MigrateFailure::canceled());
    }
    ctx.tick("copy", source, true);

    // 阶段 2：原子切换——源目录改名暂存（同卷 rename，瞬间完成），再决定是否建链接
    ctx.tick("switch", source, true);
    let staged_path = match staging_path(source) {
        Ok(path) => path,
        Err(error) => {
            discard_target_copy(&target_path);
            return Err(MigrateFailure::failed(error));
        }
    };
    if let Err(error) = std::fs::rename(source, &staged_path) {
        discard_target_copy(&target_path);
        return Err(MigrateFailure::failed(format!(
            "复制已完成，但源目录无法暂存（可能被占用）：{error}。已撤回：目标副本已删除，源目录未动"
        )));
    }
    if link_back {
        if let Err(error) = create_junction(&target_path, source) {
            // 撤回：暂存目录改回原名、目标副本删除——回到「源完好」状态
            let _ = std::fs::rename(&staged_path, source);
            discard_target_copy(&target_path);
            return Err(MigrateFailure::failed(format!(
                "{error}；已撤回：源目录已恢复原名，目标副本已删除"
            )));
        }
    }

    // 阶段 3：清理暂存目录（删不掉的如实计残留；链接已生效，功能不受影响）
    ctx.tick("cleanup", &staged_path, true);
    let mut leftovers = 0u64;
    let mut leftover_paths: Vec<String> = Vec::new();
    remove_tree_collect(&staged_path, &mut leftovers, &mut leftover_paths);
    leftover_paths.truncate(LEFTOVER_REPORT_LIMIT);

    ctx.tick("done", &target_path, true);
    Ok(MigrateReport {
        source: source.to_string_lossy().into_owned(),
        target_parent: target_parent.to_string_lossy().into_owned(),
        target_path: target_path.to_string_lossy().into_owned(),
        moved_bytes: ctx.copied_bytes.load(Ordering::Relaxed),
        moved_files: ctx.copied_files.load(Ordering::Relaxed),
        leftovers,
        leftover_paths,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

/// 回滚：删链接 → 搬回 → 失败时把链接恢复（否则按原路径访问的程序当场断掉）。
pub fn run_rollback(
    source: &Path,
    target: &Path,
    cancel: Arc<AtomicBool>,
    progress: Option<Box<dyn Fn(Progress) + Send + Sync>>,
) -> Result<MigrateReport, MigrateFailure> {
    if !target.is_dir() {
        return Err(MigrateFailure::failed(format!("迁移目标不存在：{}", target.display())));
    }
    if !source.is_dir() {
        return Err(MigrateFailure::failed(format!("原路径不存在：{}", source.display())));
    }
    if !junction_targets(source, target) {
        return Err(MigrateFailure::failed(format!(
            "原路径不是指向 {} 的目录联接，已拒绝回滚（防止误删真实目录）",
            target.display()
        )));
    }
    let parent = source
        .parent()
        .ok_or_else(|| MigrateFailure::failed("原路径没有上级目录"))?
        .to_path_buf();
    // 只删链接本身：RemoveDirectoryW 对 junction 只摘链接，不动目标数据
    if let Err(error) = std::fs::remove_dir(source) {
        return Err(MigrateFailure::failed(format!("无法移除原路径的目录联接：{error}")));
    }
    match run_migration(target, &parent, false, cancel, progress) {
        Ok(report) => Ok(report),
        Err(failure) => {
            // 搬回失败：恢复链接，让原路径至少可用（数据仍在目标盘）
            let restored = create_junction(target, source).is_ok();
            Err(MigrateFailure {
                canceled: failure.canceled,
                message: if restored {
                    format!("{}；原路径的目录联接已恢复（数据仍在目标盘）", failure.message)
                } else {
                    format!(
                        "{}；且原路径的目录联接恢复失败，请手工确认 {} 的状态",
                        failure.message,
                        source.display()
                    )
                },
            })
        }
    }
}

fn registry() -> &'static Mutex<std::collections::HashMap<String, Arc<AtomicBool>>> {
    static REG: std::sync::OnceLock<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>> = std::sync::OnceLock::new();
    REG.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}

fn emit_progress(app: &tauri::AppHandle, session_id: &str, status: &str, progress: Option<&Progress>, extra: serde_json::Value) {
    let mut payload = serde_json::json!({ "sessionId": session_id, "status": status });
    if let Some(progress) = progress {
        payload["phase"] = serde_json::json!(progress.phase);
        payload["copiedBytes"] = serde_json::json!(progress.copied_bytes);
        payload["totalBytes"] = serde_json::json!(progress.total_bytes);
        payload["files"] = serde_json::json!(progress.files);
        payload["totalFiles"] = serde_json::json!(progress.total_files);
        payload["current"] = serde_json::json!(progress.current);
    }
    if let Some(object) = payload.as_object_mut() {
        if let Some(extra_object) = extra.as_object() {
            for (key, value) in extra_object {
                object.insert(key.clone(), value.clone());
            }
        }
    }
    let _ = app.emit(EVENT_PROGRESS, payload);
}

fn register_session(session_id: &str) -> Arc<AtomicBool> {
    let cancel = Arc::new(AtomicBool::new(false));
    if let Ok(mut map) = registry().lock() {
        if let Some(old) = map.remove(session_id) {
            old.store(true, Ordering::Relaxed);
        }
        map.insert(session_id.to_string(), cancel.clone());
    }
    cancel
}

fn unregister_session(session_id: &str) {
    if let Ok(mut map) = registry().lock() {
        map.remove(session_id);
    }
}

/// 迁移前检查：真实体积/文件数/链接/目标空间，UI 用它把「要搬多少、目标够不够」如实显示出来。
#[tauri::command]
pub async fn disk_migrate_check(
    app: tauri::AppHandle,
    source: String,
    target_parent: String,
) -> Result<MigrationPlan, String> {
    let app_data_dir = app.path().app_data_dir().ok();
    tauri::async_runtime::spawn_blocking(move || {
        plan_migration(Path::new(source.trim()), Path::new(target_parent.trim()), app_data_dir.as_deref())
    })
    .await
    .map_err(|error| format!("迁移检查任务异常：{error}"))?
}

/// 开始迁移。立即返回；进度与结果经 `disk:migrate-progress` 事件推送。
#[tauri::command]
pub async fn disk_migrate_start(
    app: tauri::AppHandle,
    session_id: String,
    source: String,
    target_parent: String,
) -> Result<(), String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("缺少迁移会话标识".into());
    }
    let source_path = PathBuf::from(source.trim());
    let target_parent_path = PathBuf::from(target_parent.trim());
    if source_path.as_os_str().is_empty() || target_parent_path.as_os_str().is_empty() {
        return Err("缺少源目录或目标位置".into());
    }
    let app_data_dir = app.path().app_data_dir().ok();
    let cancel = register_session(&session_id);

    let app_handle = app.clone();
    let emitter_app = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        // 启动前再校验一遍：检查与真正开搬之间，状态可能已经变了
        if let Err(error) = plan_migration(&source_path, &target_parent_path, app_data_dir.as_deref()) {
            unregister_session(&sid);
            emit_progress(&app_handle, &sid, "error", None, serde_json::json!({ "error": error }));
            return;
        }
        let progress_app = emitter_app.clone();
        let progress_sid = sid.clone();
        let progress = Box::new(move |snapshot: Progress| {
            emit_progress(&progress_app, &progress_sid, "running", Some(&snapshot), serde_json::json!({}));
        });
        let outcome = run_migration(&source_path, &target_parent_path, true, cancel, Some(progress));
        unregister_session(&sid);
        finish_session(&app_handle, &sid, outcome);
    });
    Ok(())
}

fn finish_session(app: &tauri::AppHandle, session_id: &str, outcome: Result<MigrateReport, MigrateFailure>) {
    match outcome {
        Ok(report) => emit_progress(app, session_id, "done", None, serde_json::json!({ "report": report })),
        Err(failure) => {
            let status = if failure.canceled { "canceled" } else { "error" };
            let error = if failure.canceled { String::new() } else { failure.message };
            emit_progress(app, session_id, status, None, serde_json::json!({ "error": error }));
        }
    }
}

/// 回滚一次迁移：把数据搬回原路径（先删链接、后搬回，搬回失败会恢复链接）。
#[tauri::command]
pub async fn disk_migrate_rollback(
    app: tauri::AppHandle,
    session_id: String,
    source: String,
    target: String,
) -> Result<(), String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("缺少迁移会话标识".into());
    }
    let source_path = PathBuf::from(source.trim());
    let target_path = PathBuf::from(target.trim());
    if source_path.as_os_str().is_empty() || target_path.as_os_str().is_empty() {
        return Err("缺少原路径或目标路径".into());
    }
    let cancel = register_session(&session_id);

    let app_handle = app.clone();
    let emitter_app = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress_app = emitter_app.clone();
        let progress_sid = sid.clone();
        let progress = Box::new(move |snapshot: Progress| {
            emit_progress(&progress_app, &progress_sid, "running", Some(&snapshot), serde_json::json!({}));
        });
        let outcome = run_rollback(&source_path, &target_path, cancel, Some(progress));
        unregister_session(&sid);
        finish_session(&app_handle, &sid, outcome);
    });
    Ok(())
}

/// 取消迁移：复制阶段立即停下；切换之后不再回滚（链接已生效），清理阶段取消＝停止删除并报残留。
#[tauri::command]
pub fn disk_migrate_cancel(session_id: String) -> Result<(), String> {
    if let Ok(map) = registry().lock() {
        if let Some(cancel) = map.get(&session_id) {
            cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_case(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("toolcove-migrate-{name}-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, content: &[u8]) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    fn no_cancel() -> Arc<AtomicBool> {
        Arc::new(AtomicBool::new(false))
    }

    #[test]
    fn plan_rejects_same_volume_target() {
        let root = temp_case("same-volume");
        let source = root.join("data");
        write_file(&source.join("a.txt"), b"hello");
        let other_parent = root.join("other");
        std::fs::create_dir_all(&other_parent).unwrap();
        // 同卷（都在临时目录所在盘）：搬迁不释放空间，必须在开搬前拒绝
        let error = plan_migration(&source, &other_parent, None).unwrap_err();
        assert!(error.contains("同一磁盘"), "实际：{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 回归：源路径**穿过 junction** 指向另一块盘时，字面盘符（C: → E:）会骗过同卷判定。
    /// 按物理卷比较后必须拒绝——否则数据在同一块盘上白倒一遍，还平白多一个链接（真机踩过）。
    #[cfg(windows)]
    #[test]
    fn plan_compares_physical_volumes_not_literal_drives() {
        let root = temp_case("physical-volume");
        let real = root.join("real");
        write_file(&real.join("sub").join("a.txt"), b"hello");
        let link = root.join("link");
        junction::create(&real, &link).unwrap();
        let other = root.join("other");
        std::fs::create_dir_all(&other).unwrap();
        // link\sub 物理上就是 real\sub（同一块盘），目标 other 也在同一块盘上
        let error = plan_migration(&link.join("sub"), &other, None).unwrap_err();
        assert!(error.contains("同一磁盘"), "实际：{error}");
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn plan_rejects_nested_and_existing_targets() {
        let root = temp_case("plan-rules");
        let source = root.join("data");
        write_file(&source.join("a.txt"), b"hello");
        std::fs::create_dir_all(source.join("inner")).unwrap();
        let error = plan_migration(&source, &source.join("inner"), None).unwrap_err();
        assert!(error.contains("内部"), "实际：{error}");
        let outside = root.join("outside");
        std::fs::create_dir_all(outside.join("data")).unwrap();
        let error = plan_migration(&source, &outside, None).unwrap_err();
        assert!(error.contains("已存在同名目录"), "实际：{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn plan_rejects_source_that_is_itself_a_link() {        let root = temp_case("link-source");
        let real = root.join("real");
        write_file(&real.join("a.txt"), b"hello");
        let link = root.join("link");
        junction::create(&real, &link).unwrap();
        let error = plan_migration(&link, &root.join("target"), None).unwrap_err();
        assert!(error.contains("本身是链接"), "实际：{error}");
        let _ = std::fs::remove_dir_all(&real);
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn inspect_counts_bytes_files_and_links() {
        let root = temp_case("inspect");
        write_file(&root.join("a.txt"), b"12345");
        write_file(&root.join("sub").join("b.txt"), b"1234567890");
        let link = root.join("linked");
        junction::create(&root.join("sub"), &link).unwrap();
        let stats = inspect_tree(&root).unwrap();
        assert_eq!(stats.bytes, 15);
        assert_eq!(stats.files, 2);
        assert_eq!(stats.links.len(), 1, "链接要被识别出来（迁移会整单拒绝）");
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 用临时目录跑一次完整的「搬 + 原地留链接」：junction 免管理员，这条链路能真跑。
    #[cfg(windows)]
    #[test]
    fn migration_moves_data_and_leaves_a_working_junction() {
        let root = temp_case("move");
        let source = root.join("data");
        write_file(&source.join("a.txt"), b"hello");
        write_file(&source.join("sub").join("b.bin"), &vec![7u8; 4096]);
        let target_parent = root.join("dest");
        std::fs::create_dir_all(&target_parent).unwrap();

        let report = run_migration(&source, &target_parent, true, no_cancel(), None).unwrap();
        assert_eq!(report.moved_files, 2);
        assert_eq!(report.moved_bytes, 5 + 4096);
        assert_eq!(report.leftovers, 0);

        // 原路径成了链接，仍能读到数据（程序按原路径访问不受影响）
        assert!(source.is_dir());
        assert!(std::fs::symlink_metadata(&source).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(source.join("a.txt")).unwrap(), b"hello");
        // 数据真身在目标盘；暂存目录已清理干净
        let target_path = PathBuf::from(&report.target_path);
        assert_eq!(std::fs::read(target_path.join("a.txt")).unwrap(), b"hello");
        let staged: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().contains(STAGING_SUFFIX))
            .collect();
        assert!(staged.is_empty(), "暂存目录应已清理");

        // 删链接（只删链接）→ 数据仍在目标盘
        std::fs::remove_dir(&source).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(target_path.join("a.txt")).unwrap(), b"hello");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn rollback_moves_data_back_and_removes_the_junction() {
        let root = temp_case("rollback");
        let source = root.join("data");
        write_file(&source.join("a.txt"), b"hello");
        let target_parent = root.join("dest");
        std::fs::create_dir_all(&target_parent).unwrap();
        let report = run_migration(&source, &target_parent, true, no_cancel(), None).unwrap();
        let target_path = PathBuf::from(&report.target_path);

        let rolled = run_rollback(&source, &target_path, no_cancel(), None).unwrap();
        assert_eq!(rolled.moved_files, 1);
        // 原路径恢复成真实目录，数据回来了；目标盘的副本被搬走
        assert!(source.is_dir());
        assert!(!std::fs::symlink_metadata(&source).unwrap().file_type().is_symlink());
        assert_eq!(std::fs::read(source.join("a.txt")).unwrap(), b"hello");
        assert!(!target_path.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    #[test]
    fn rollback_refuses_when_source_is_not_our_junction() {
        let root = temp_case("rollback-guard");
        let source = root.join("data");
        write_file(&source.join("a.txt"), b"hello");
        let target = root.join("elsewhere");
        std::fs::create_dir_all(&target).unwrap();
        let failure = run_rollback(&source, &target, no_cancel(), None).unwrap_err();
        assert!(failure.message.contains("已拒绝回滚"), "实际：{}", failure.message);
        assert_eq!(std::fs::read(source.join("a.txt")).unwrap(), b"hello");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn copy_failure_keeps_the_source_untouched() {
        let root = temp_case("copy-fail");
        let source = root.join("data");
        write_file(&source.join("a.txt"), b"hello");
        let target_parent = root.join("dest");
        std::fs::create_dir_all(target_parent.join("data")).unwrap(); // 同名已存在 → 复制前就拒绝
        let failure = run_migration(&source, &target_parent, true, no_cancel(), None).unwrap_err();
        assert!(failure.message.contains("已存在同名目录"), "实际：{}", failure.message);
        assert_eq!(std::fs::read(source.join("a.txt")).unwrap(), b"hello");
        assert!(!std::fs::symlink_metadata(&source).unwrap().file_type().is_symlink());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn canceled_migration_cleans_up_and_keeps_source() {
        let root = temp_case("cancel");
        let source = root.join("data");
        write_file(&source.join("a.txt"), b"hello");
        let target_parent = root.join("dest");
        std::fs::create_dir_all(&target_parent).unwrap();
        let cancel = Arc::new(AtomicBool::new(true));
        let failure = run_migration(&source, &target_parent, true, cancel, None).unwrap_err();
        assert!(failure.canceled, "应为取消：{}", failure.message);
        // 源完好、目标没有半成品
        assert_eq!(std::fs::read(source.join("a.txt")).unwrap(), b"hello");
        assert!(!std::fs::symlink_metadata(&source).unwrap().file_type().is_symlink());
        assert!(!target_parent.join("data").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 回归（真机问过「AppData 能不能整个搬」）：源目录**包含**本应用数据目录时必须拒绝——
    /// 否则会连着应用正在写的文件一起搬，白搬几十 GB 还必然失败。
    #[test]
    fn plan_refuses_ancestors_of_app_data_dir() {
        let root = temp_case("app-data-ancestor");
        let roaming = root.join("Roaming");
        let app_data = roaming.join("com.github-lcb.toolcove");
        std::fs::create_dir_all(&app_data).unwrap();
        std::fs::write(app_data.join("settings.json"), b"{}").unwrap();
        write_file(&roaming.join("OtherApp").join("cache.bin"), b"hello");
        let target = root.join("dest");
        std::fs::create_dir_all(&target).unwrap();

        let error = plan_migration(&roaming, &target, Some(&app_data)).unwrap_err();
        assert!(error.contains("包含本应用正在使用的数据目录"), "实际：{error}");
        // 同级的具体子目录不受影响（这才是指引用户去的方向）
        let sibling = roaming.join("OtherApp");
        let error = plan_migration(&sibling, &target, Some(&app_data)).unwrap_err();
        assert!(error.contains("同一磁盘"), "应只被同卷规则拦下而不是祖先规则：{error}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn warnings_flag_uwp_system_and_temp_paths() {
        let root = temp_case("warnings");
        let local = root.join("Local");
        let packages = local.join("Packages");
        let temp = local.join("Temp");
        let plain = local.join("SomeApp");
        for dir in [&packages, &temp, &plain] {
            std::fs::create_dir_all(dir).unwrap();
        }
        // 提示规则走的是 canonicalize 比较，被检查的路径必须真实存在（否则退回字面路径、前缀对不上）
        std::fs::create_dir_all(packages.join("Some.Package_abc")).unwrap();
        std::fs::create_dir_all(temp.join("x")).unwrap();
        let local_path = local.clone();
        let uwp = warnings_for(&packages.join("Some.Package_abc"), Some(&local_path));
        assert_eq!(uwp.len(), 1);
        assert!(uwp[0].contains("商店应用"), "实际：{uwp:?}");
        let tmp = warnings_for(&temp.join("x"), Some(&local_path));
        assert!(tmp[0].contains("Temp"), "实际：{tmp:?}");
        let whole = warnings_for(&local_path, Some(&local_path));
        assert!(whole[0].contains("AppData\\Local"), "实际：{whole:?}");
        assert!(warnings_for(&plain, Some(&local_path)).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }
}
