//! 电脑磁盘分析（磁盘分析助手）：扫描整棵目录树、聚合体积、定位大文件。
//!
//! 与「文件处理」工具的分工：那些命令面向单个/少量文件，这里面向**百万级条目**，
//! 数据结构和预算都按这个量级设计：
//!
//! - **并行递归扫描**（rayon）：元数据读取是 I/O 密集，单线程扫整盘要分钟级；
//!   每个目录自底向上聚合，父目录体积 = 直属文件 + 各子目录之和。
//! - **只把目录存进内存**（一个盘通常几十万），文件不进树——否则文件名会把内存撑爆。
//!   下钻时的文件列表按当前目录**实时读盘**（单个目录毫秒级），目录体积用扫描快照。
//! - **大文件榜是精确的**：扫描时用容量 200 的最小堆全局收集，不走「每目录只留前 N」的近似
//!   （近似会漏掉「一个目录里有 150 个大文件」这种最常见的情形）。
//! - 不跟随符号链接/联结点：防环，也防把同一份数据算两遍。
//! - 读不动的目录计入 errors 而不是整体失败；取消后**整棵树丢弃**——
//!   半棵树的体积全是缺的，比不给更误导。

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::Emitter;

pub const EVENT_PROGRESS: &str = "disk:progress";
/// 单次扫描的目录上限：给「扫描整盘」留一道内存闸，普通盘远达不到。
pub const DISK_MAX_DIRS: u64 = 1_500_000;
/// 递归深度上限（正常目录不会超过几十层；超过说明多半是链接环或有异常结构）。
pub const DISK_MAX_DEPTH: u32 = 128;
/// 全局最大文件榜容量。
pub const DISK_TOP_FILES: usize = 200;
/// 单次下钻返回的子目录上限。
pub const DISK_CHILDREN_LIMIT: usize = 500;
/// 单次目录文件列表的默认上限。
pub const DISK_DIR_FILES_LIMIT: usize = 500;
/// 目录文件列表的硬上限：界面「显示更多」逐步放开到它——一个目录十万个文件全塞进 IPC 会打爆前端。
pub const DISK_DIR_FILES_MAX: usize = 5000;
/// 进度事件节流：扫描时每秒可访问数十万条目，不节流会把 IPC 和 UI 一起打满。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

/// 树中的一个目录：体积为「直属文件 + 子树」的聚合值。
#[derive(Debug)]
struct DirNode {
    name: String,
    parent: Option<u32>,
    size: u64,
    own_bytes: u64,
    files: u64,
    dirs: u64,
    errors: u32,
    children: Vec<u32>,
    /// 直属的链接（junction / 符号链接）：不跟随、不计体积，但要列出来
    links: Vec<LinkInfo>,
}

/// 目录里的一个链接（junction / 符号链接）。
///
/// 为什么要单独列出来：迁移过的目录在原位置就长这样。扫描若把它整个跳过，
/// 用户会看到「我明明有个 Downloads，扫出来却没有它」——像数据丢了。列出来并标注目标，
/// 既不重复计数，又让「它搬去哪了」一眼可见。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkInfo {
    pub name: String,
    pub target: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopFile {
    pub path: String,
    pub size: u64,
}

#[derive(Debug)]
pub struct ScanResult {
    nodes: Vec<DirNode>,
    root_path: String,
    pub top_files: Vec<TopFile>,
    pub total_bytes: u64,
    pub total_files: u64,
    pub total_dirs: u64,
    /// 树里跳过的链接总数（junction / 符号链接；不计体积，只报个数）
    pub links: u64,
    pub errors: u64,
    pub truncated: bool,
    pub canceled: bool,
    pub elapsed_ms: u64,
}

impl ScanResult {
    /// 节点对应的完整路径：从根逐段拼（根节点的 name 就是根路径本身）。
    fn node_path(&self, node_id: u32) -> String {
        let mut names: Vec<&str> = Vec::new();
        let mut cursor = Some(node_id);
        while let Some(id) = cursor {
            let Some(node) = self.nodes.get(id as usize) else { break };
            names.push(node.name.as_str());
            cursor = node.parent;
        }
        names.reverse();
        let mut path = PathBuf::from(names.first().copied().unwrap_or_default());
        for name in names.iter().skip(1) {
            path.push(name);
        }
        path.to_string_lossy().into_owned()
    }
}

/// 扫描中的一份进度快照（节流后经事件推送）。
pub struct ProgressSnapshot {
    pub entries: u64,
    pub bytes: u64,
    pub dirs: u64,
    pub errors: u64,
    pub path: String,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct HeapFile {
    size: u64,
    path: String,
}

/// 构建期的目录（自底向上聚合后转成扁平节点表）。
#[derive(Debug)]
struct BuiltDir {
    name: String,
    size: u64,
    own_bytes: u64,
    files: u64,
    dirs: u64,
    errors: u32,
    children: Vec<BuiltDir>,
    links: Vec<LinkInfo>,
}

impl BuiltDir {
    fn empty(name: String) -> Self {
        Self { name, size: 0, own_bytes: 0, files: 0, dirs: 0, errors: 0, children: Vec::new(), links: Vec::new() }
    }
}

struct ScanState<'a> {
    cancel: &'a AtomicBool,
    entries: AtomicU64,
    bytes: AtomicU64,
    dirs: AtomicU64,
    errors: AtomicU64,
    truncated: AtomicBool,
    top: Mutex<BinaryHeap<Reverse<HeapFile>>>,
    last_emit: Mutex<Instant>,
    progress: Option<Box<dyn Fn(ProgressSnapshot) + Send + Sync>>,
}

impl<'a> ScanState<'a> {
    fn new(cancel: &'a AtomicBool, progress: Option<Box<dyn Fn(ProgressSnapshot) + Send + Sync>>) -> Self {
        Self {
            cancel,
            entries: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            dirs: AtomicU64::new(0),
            errors: AtomicU64::new(0),
            truncated: AtomicBool::new(false),
            top: Mutex::new(BinaryHeap::new()),
            last_emit: Mutex::new(Instant::now() - PROGRESS_INTERVAL),
            progress,
        }
    }

    fn note_error(&self) {
        self.errors.fetch_add(1, Ordering::Relaxed);
    }

    fn push_top(&self, path: PathBuf, size: u64) {
        let Ok(mut heap) = self.top.lock() else { return };
        heap.push(Reverse(HeapFile { size, path: path.to_string_lossy().into_owned() }));
        if heap.len() > DISK_TOP_FILES {
            heap.pop();
        }
    }

    fn maybe_tick(&self, path: &Path) {
        let Some(callback) = self.progress.as_ref() else { return };
        {
            let Ok(mut last) = self.last_emit.lock() else { return };
            if last.elapsed() < PROGRESS_INTERVAL {
                return;
            }
            *last = Instant::now();
        }
        callback(ProgressSnapshot {
            entries: self.entries.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
            dirs: self.dirs.load(Ordering::Relaxed),
            errors: self.errors.load(Ordering::Relaxed),
            path: path.to_string_lossy().into_owned(),
        });
    }
}

/// 递归扫描一个目录。子目录走 rayon 并行（>=2 个才有收益）。
fn build_dir(path: &Path, name: String, depth: u32, state: &ScanState) -> BuiltDir {
    state.entries.fetch_add(1, Ordering::Relaxed);
    state.dirs.fetch_add(1, Ordering::Relaxed);
    let mut node = BuiltDir::empty(name);
    if state.cancel.load(Ordering::Relaxed) {
        return node;
    }
    let mut subdirs: Vec<(PathBuf, String)> = Vec::new();
    match std::fs::read_dir(path) {
        Ok(entries) => {
            for entry in entries {
                state.entries.fetch_add(1, Ordering::Relaxed);
                let Ok(entry) = entry else {
                    node.errors += 1;
                    state.note_error();
                    continue;
                };
                let Ok(file_type) = entry.file_type() else {
                    node.errors += 1;
                    state.note_error();
                    continue;
                };
                if file_type.is_symlink() {
                    // 链接（junction / 符号链接）：不跟随、不计体积，但记下来让它在列表里可见
                    let target = std::fs::read_link(entry.path())
                        .map(|value| value.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    node.links.push(LinkInfo {
                        name: entry.file_name().to_string_lossy().into_owned(),
                        target,
                    });
                    continue;
                }
                if file_type.is_dir() {
                    // 配额/深度闸：命中就不再登记子目录，如实标记「已截断」
                    if depth >= DISK_MAX_DEPTH
                        || state.truncated.load(Ordering::Relaxed)
                        || state.dirs.load(Ordering::Relaxed) >= DISK_MAX_DIRS
                    {
                        state.truncated.store(true, Ordering::Relaxed);
                        continue;
                    }
                    subdirs.push((entry.path(), entry.file_name().to_string_lossy().into_owned()));
                } else if file_type.is_file() {
                    match entry.metadata() {
                        Ok(metadata) => {
                            let size = metadata.len();
                            node.own_bytes += size;
                            node.files += 1;
                            state.bytes.fetch_add(size, Ordering::Relaxed);
                            state.push_top(entry.path(), size);
                        }
                        Err(_) => {
                            node.errors += 1;
                            state.note_error();
                        }
                    }
                }
                // 符号链接/联结点：既不是 file 也不是 dir，直接跳过（不跟随，防环）
            }
        }
        Err(_) => {
            node.errors += 1;
            state.note_error();
        }
    }
    state.maybe_tick(path);

    let children: Vec<BuiltDir> = match subdirs.len() {
        0 => Vec::new(),
        1 => {
            let (child_path, child_name) = subdirs.into_iter().next().expect("len=1");
            vec![build_dir(&child_path, child_name, depth + 1, state)]
        }
        _ => {
            use rayon::prelude::*;
            subdirs
                .into_par_iter()
                .map(|(child_path, child_name)| build_dir(&child_path, child_name, depth + 1, state))
                .collect()
        }
    };

    node.size = node.own_bytes;
    for child in &children {
        node.size += child.size;
        node.files += child.files;
        node.dirs += 1 + child.dirs;
        node.errors += child.errors;
    }
    node.children = children;
    node
}

/// 把构建树压成节点表（父节点先入表，子节点引用下标）。
fn flatten(built: BuiltDir, parent: Option<u32>, nodes: &mut Vec<DirNode>) -> u32 {
    let index = nodes.len() as u32;
    nodes.push(DirNode {
        name: built.name,
        parent,
        size: built.size,
        own_bytes: built.own_bytes,
        files: built.files,
        dirs: built.dirs,
        errors: built.errors,
        children: Vec::with_capacity(built.children.len()),
        links: built.links,
    });
    for child in built.children {
        let child_index = flatten(child, Some(index), nodes);
        nodes[index as usize].children.push(child_index);
    }
    index
}

/// 扫描的纯核心：不碰 Tauri，进度经回调上报（单测传 None）。
pub fn scan_tree(
    root: &Path,
    cancel: &AtomicBool,
    progress: Option<Box<dyn Fn(ProgressSnapshot) + Send + Sync>>,
) -> ScanResult {
    let started = Instant::now();
    let state = ScanState::new(cancel, progress);
    let built = if cancel.load(Ordering::Relaxed) {
        None
    } else {
        Some(build_dir(root, root.to_string_lossy().into_owned(), 0, &state))
    };
    let canceled = cancel.load(Ordering::Relaxed) || built.is_none();

    let mut top_files: Vec<TopFile> = state
        .top
        .lock()
        .map(|heap| {
            heap.iter()
                .map(|entry| TopFile { path: entry.0.path.clone(), size: entry.0.size })
                .collect()
        })
        .unwrap_or_default();
    top_files.sort_by(|a, b| b.size.cmp(&a.size).then_with(|| a.path.cmp(&b.path)));

    let mut nodes = Vec::new();
    let (total_bytes, total_files, total_dirs, errors) = match &built {
        Some(built) => (built.size, built.files, built.dirs, built.errors as u64),
        None => (0, 0, 0, 0),
    };
    if let Some(built) = built {
        flatten(built, None, &mut nodes);
    }
    let links = nodes.iter().map(|node| node.links.len() as u64).sum();

    ScanResult {
        nodes,
        root_path: root.to_string_lossy().into_owned(),
        top_files,
        total_bytes,
        total_files,
        total_dirs,
        links,
        errors,
        truncated: state.truncated.load(Ordering::Relaxed),
        canceled,
        elapsed_ms: started.elapsed().as_millis() as u64,
    }
}

/// 某个目录节点的一页子目录（按体积降序，超上限截断）。
pub fn children_page(result: &ScanResult, node_id: u32, limit: usize) -> Result<serde_json::Value, String> {
    let node = result.nodes.get(node_id as usize).ok_or("节点不存在")?;
    let mut children: Vec<(u32, &DirNode)> = node
        .children
        .iter()
        .filter_map(|id| result.nodes.get(*id as usize).map(|child| (*id, child)))
        .collect();
    children.sort_by(|a, b| b.1.size.cmp(&a.1.size).then_with(|| a.1.name.cmp(&b.1.name)));
    let child_count = children.len();
    let list: Vec<serde_json::Value> = children
        .iter()
        .take(limit)
        .map(|(id, child)| {
            serde_json::json!({
                "id": id,
                "name": child.name,
                "size": child.size,
                "ownBytes": child.own_bytes,
                "files": child.files,
                "dirs": child.dirs,
                "errors": child.errors,
                "childCount": child.children.len(),
            })
        })
        .collect();
    Ok(serde_json::json!({
        "node": {
            "id": node_id,
            "name": node.name,
            "path": result.node_path(node_id),
            "size": node.size,
            "ownBytes": node.own_bytes,
            "files": node.files,
            "dirs": node.dirs,
            "errors": node.errors,
        },
        "children": list,
        "links": node.links,
        "childCount": child_count,
        "truncated": child_count > limit,
    }))
}

struct SessionEntry {
    cancel: Arc<AtomicBool>,
    result: Arc<Mutex<Option<Arc<ScanResult>>>>,
}

fn sessions() -> &'static Mutex<HashMap<String, SessionEntry>> {
    static REG: OnceLock<Mutex<HashMap<String, SessionEntry>>> = OnceLock::new();
    REG.get_or_init(|| Mutex::new(HashMap::new()))
}

fn progress_payload(session_id: &str, status: &str, snapshot: &ProgressSnapshot, elapsed_ms: u64) -> serde_json::Value {
    serde_json::json!({
        "sessionId": session_id,
        "status": status,
        "entries": snapshot.entries,
        "bytes": snapshot.bytes,
        "dirs": snapshot.dirs,
        "errors": snapshot.errors,
        "path": snapshot.path,
        "elapsedMs": elapsed_ms,
    })
}

/// 列出本机磁盘（Windows：盘符 + 卷标 + 容量；其它平台：根目录、容量未知）。
#[tauri::command]
pub fn disk_list_drives() -> Result<Vec<serde_json::Value>, String> {
    Ok(list_drives())
}

#[cfg(windows)]
fn list_drives() -> Vec<serde_json::Value> {
    use windows_sys::Win32::Storage::FileSystem::{
        GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDriveStringsW, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        DRIVE_CDROM, DRIVE_FIXED, DRIVE_RAMDISK, DRIVE_REMOTE, DRIVE_REMOVABLE,
    };

    let length = unsafe { GetLogicalDriveStringsW(0, std::ptr::null_mut()) };
    if length == 0 {
        return Vec::new();
    }
    let mut buffer = vec![0u16; length as usize];
    let written = unsafe { GetLogicalDriveStringsW(length, buffer.as_mut_ptr()) };
    if written == 0 {
        return Vec::new();
    }
    let mut drives = Vec::new();
    for part in buffer.split(|unit| *unit == 0).filter(|part| !part.is_empty()) {
        let mut root: Vec<u16> = part.to_vec();
        root.push(0);
        let mut available_to_caller = 0u64;
        let mut total = 0u64;
        let mut free = 0u64;
        // 空光驱 / 未就绪的移动盘拿不到容量——跳过，而不是显示一块 0 B 的「磁盘」
        let ok = unsafe { GetDiskFreeSpaceExW(root.as_ptr(), &mut available_to_caller, &mut total, &mut free) };
        if ok == 0 || total == 0 {
            continue;
        }
        let kind = match unsafe { GetDriveTypeW(root.as_ptr()) } {
            DRIVE_FIXED => "fixed",
            DRIVE_REMOVABLE => "removable",
            DRIVE_REMOTE => "remote",
            DRIVE_CDROM => "cdrom",
            DRIVE_RAMDISK => "ramdisk",
            _ => "unknown",
        };
        let mut label_buffer = [0u16; 261];
        let label_ok = unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                label_buffer.as_mut_ptr(),
                label_buffer.len() as u32,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                0,
            )
        };
        let label = if label_ok != 0 {
            let end = label_buffer.iter().position(|unit| *unit == 0).unwrap_or(0);
            String::from_utf16_lossy(&label_buffer[..end])
        } else {
            String::new()
        };
        drives.push(serde_json::json!({
            "root": String::from_utf16_lossy(part),
            "kind": kind,
            "label": label,
            "total": total,
            "free": free,
        }));
    }
    drives
}

#[cfg(not(windows))]
fn list_drives() -> Vec<serde_json::Value> {
    // 非 Windows 桌面构建（CI 只做编译检查、开发时才跑）：只给根目录，容量未知（0 = 未知，界面隐藏容量条）。
    vec![serde_json::json!({
        "root": "/",
        "kind": "unknown",
        "label": "",
        "total": 0,
        "free": 0,
    })]
}

/// 开始一次扫描。立即返回，进度与结果经 `disk:progress` 事件推送（done 事件带 summary 与 topFiles）。
#[tauri::command]
pub async fn disk_scan_start(app: tauri::AppHandle, session_id: String, root: String) -> Result<(), String> {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return Err("缺少扫描会话标识".into());
    }
    let root = root.trim().to_string();
    if root.is_empty() {
        return Err("请选择要扫描的磁盘或文件夹".into());
    }
    let root_path = PathBuf::from(&root);
    if !root_path.is_dir() {
        return Err(format!("目录不存在或不可访问：{root}"));
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let slot: Arc<Mutex<Option<Arc<ScanResult>>>> = Arc::new(Mutex::new(None));
    if let Ok(mut map) = sessions().lock() {
        // 同一会话重复 start：先取消旧的，避免两个任务写同一个槽位
        if let Some(old) = map.remove(&session_id) {
            old.cancel.store(true, Ordering::Relaxed);
        }
        map.insert(
            session_id.clone(),
            SessionEntry { cancel: cancel.clone(), result: slot.clone() },
        );
    }

    let app_handle = app.clone();
    let emitter_app = app.clone();
    let sid = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let progress = Box::new(move |snapshot: ProgressSnapshot| {
            let _ = emitter_app.emit(EVENT_PROGRESS, progress_payload(&sid, "running", &snapshot, 0));
        });
        let result = scan_tree(&root_path, &cancel, Some(progress));
        if result.canceled {
            // 取消：整棵树丢弃，会话一并移除
            if let Ok(mut map) = sessions().lock() {
                map.remove(&session_id);
            }
            let _ = app_handle.emit(
                EVENT_PROGRESS,
                serde_json::json!({
                    "sessionId": session_id,
                    "status": "canceled",
                    "entries": 0,
                    "bytes": 0,
                    "dirs": 0,
                    "errors": 0,
                    "path": "",
                    "elapsedMs": result.elapsed_ms,
                }),
            );
            return;
        }
        let summary = serde_json::json!({
            "root": result.root_path,
            "totalBytes": result.total_bytes,
            "files": result.total_files,
            "dirs": result.total_dirs,
            "links": result.links,
            "errors": result.errors,
            "truncated": result.truncated,
            "elapsedMs": result.elapsed_ms,
        });
        let top_files = serde_json::to_value(&result.top_files).unwrap_or(serde_json::Value::Array(Vec::new()));
        if let Ok(mut guard) = slot.lock() {
            *guard = Some(Arc::new(result));
        }
        let _ = app_handle.emit(
            EVENT_PROGRESS,
            serde_json::json!({
                "sessionId": session_id,
                "status": "done",
                "summary": summary,
                "topFiles": top_files,
            }),
        );
    });
    Ok(())
}

/// 取消扫描：标志位在目录粒度被检查，很快停下；结果整棵丢弃。
#[tauri::command]
pub fn disk_scan_cancel(session_id: String) -> Result<(), String> {
    if let Ok(map) = sessions().lock() {
        if let Some(entry) = map.get(&session_id) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// 释放会话（工具窗关闭 / 重新扫描前调用），释放整棵树占用的内存。
#[tauri::command]
pub fn disk_scan_release(session_id: String) -> Result<(), String> {
    if let Ok(mut map) = sessions().lock() {
        if let Some(entry) = map.remove(&session_id) {
            entry.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// 查询某个目录节点的子目录一页（下钻与 treemap 共用；node_id 缺省为根）。
#[tauri::command]
pub fn disk_scan_children(session_id: String, node_id: Option<u32>) -> Result<serde_json::Value, String> {
    let result_slot = {
        let map = sessions().lock().map_err(|_| "扫描会话状态异常".to_string())?;
        map.get(&session_id)
            .map(|entry| entry.result.clone())
            .ok_or("扫描会话不存在，请重新扫描")?
    };
    let result = {
        let guard = result_slot.lock().map_err(|_| "扫描结果状态异常".to_string())?;
        guard.as_ref().cloned().ok_or("扫描尚未完成")?
    };
    children_page(&result, node_id.unwrap_or(0), DISK_CHILDREN_LIMIT)
}

/// 卷标识（Windows：`c:` 这样的前缀；非 Windows：`/`）。
/// 用于「同卷」判断与「链接指向别的盘」提示；canonicalize 产出的 `\\?\` verbatim 前缀要先剥掉，
/// 否则同一块盘的两种写法会被判成两个卷。
pub(crate) fn volume_key(path: &Path) -> Option<String> {
    let first = path.components().next()?;
    let text = first.as_os_str().to_string_lossy().to_lowercase();
    let stripped = text.strip_prefix("\\\\?\\").unwrap_or(&text);
    let stripped = stripped.strip_prefix("unc\\").unwrap_or(stripped);
    Some(stripped.to_string())
}

/// 判定一个路径的「实体位置」：本身是不是链接、实际落在哪个卷。
///
/// 真机反馈的反面教材：用户扫 `C:\...\Downloads`（已被迁移成指向 E: 的目录联接），
/// 看到的是 E: 上的真身内容，以为「C 盘里还有这些数据」。列表里链接有标签，
/// 但如果链接正好是**扫描根**（或根的上级），就没有任何地方提醒——这个命令就是给那种情况用的。
#[tauri::command]
pub async fn disk_resolve_path(path: String) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let value = path.trim().to_string();
        if value.is_empty() {
            return Err("缺少路径".into());
        }
        let literal = std::path::PathBuf::from(&value);
        let metadata = std::fs::symlink_metadata(&literal).map_err(|error| format!("无法读取 {value}：{error}"))?;
        let is_link = metadata.file_type().is_symlink();
        let real = std::fs::canonicalize(&literal).unwrap_or_else(|_| literal.clone());
        let cross_drive = volume_key(&literal) != volume_key(&real);
        Ok(serde_json::json!({
            "path": value,
            "realPath": real.to_string_lossy(),
            "isLink": is_link,
            "crossDrive": cross_drive,
        }))
    })
    .await
    .map_err(|error| format!("路径解析任务异常：{error}"))?
}

/// 当前目录的文件列表（实时读盘；单个目录的读取是毫秒级，不进扫描快照）。
/// `limit` 由界面控制（「显示更多」会逐级放大），钳在 [1, DISK_DIR_FILES_MAX]。
#[tauri::command]
pub async fn disk_dir_files(path: String, limit: Option<u32>) -> Result<serde_json::Value, String> {
    let limit = limit
        .map(|value| (value as usize).clamp(1, DISK_DIR_FILES_MAX))
        .unwrap_or(DISK_DIR_FILES_LIMIT);
    tauri::async_runtime::spawn_blocking(move || {
        let path = path.trim().to_string();
        if path.is_empty() {
            return Err("缺少目录路径".into());
        }
        let dir = PathBuf::from(&path);
        if !dir.is_dir() {
            return Err(format!("目录不存在或不可访问：{path}"));
        }
        let mut files: Vec<(String, String, u64, Option<u64>)> = Vec::new();
        let mut total_bytes = 0u64;
        let mut file_count = 0u64;
        let mut errors = 0u64;
        for entry in std::fs::read_dir(&dir).map_err(|e| format!("无法读取目录：{e}"))? {
            let Ok(entry) = entry else {
                errors += 1;
                continue;
            };
            let Ok(file_type) = entry.file_type() else {
                errors += 1;
                continue;
            };
            if !file_type.is_file() {
                continue;
            }
            match entry.metadata() {
                Ok(metadata) => {
                    let size = metadata.len();
                    total_bytes += size;
                    file_count += 1;
                    files.push((
                        entry.file_name().to_string_lossy().into_owned(),
                        entry.path().to_string_lossy().into_owned(),
                        size,
                        crate::file_tool::system_time_millis(metadata.modified()),
                    ));
                }
                Err(_) => errors += 1,
            }
        }
        files.sort_by(|a, b| b.2.cmp(&a.2).then_with(|| a.0.cmp(&b.0)));
        let truncated = files.len() > limit;
        let list: Vec<serde_json::Value> = files
            .into_iter()
            .take(limit)
            .map(|(name, file_path, size, modified_at)| {
                serde_json::json!({ "name": name, "path": file_path, "size": size, "modifiedAt": modified_at })
            })
            .collect();
        Ok(serde_json::json!({
            "files": list,
            "fileCount": file_count,
            "totalBytes": total_bytes,
            "truncated": truncated,
            "errors": errors,
        }))
    })
    .await
    .map_err(|e| format!("目录读取任务异常：{e}"))?
}

/// 单次删除的项数上限：一次删几百个已远超「手工清理」的规模，再多应该分批核对。
pub const DISK_DELETE_MAX_ITEMS: usize = 500;

/// 删除前的校验与整理（纯函数，单测直接打它）：
/// - 只接受绝对路径，且**拒绝磁盘根目录**（回收站对根目录没有意义，真执行也只会失败）；
/// - 去掉重复项，并剔除「父目录已在清单里」的子路径——父目录进了回收站后子路径已不存在，
///   留着只会报一串假失败；
/// - 按路径深度从浅到深处理，保证嵌套判断与执行顺序一致。
pub fn plan_trash_paths(paths: &[String]) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("没有要删除的项目".into());
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for raw in paths {
        let value = raw.trim();
        if value.is_empty() {
            continue;
        }
        let path = PathBuf::from(value);
        if !path.is_absolute() {
            return Err(format!("拒绝删除非绝对路径：{value}"));
        }
        if path.parent().is_none() {
            return Err(format!("拒绝删除磁盘根目录：{value}"));
        }
        if seen.insert(path.to_string_lossy().into_owned()) {
            candidates.push(path);
        }
    }
    if candidates.is_empty() {
        return Err("没有要删除的项目".into());
    }
    if candidates.len() > DISK_DELETE_MAX_ITEMS {
        return Err(format!("一次最多删除 {DISK_DELETE_MAX_ITEMS} 项，请分批操作"));
    }
    candidates.sort_by_key(|path| path.components().count());
    let mut accepted: Vec<PathBuf> = Vec::new();
    for candidate in candidates {
        // starts_with 按「路径段」比较，C:\a\bc 不会被 C:\a\b 误判为子路径
        if accepted.iter().any(|parent| candidate.starts_with(parent)) {
            continue;
        }
        accepted.push(candidate);
    }
    Ok(accepted
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

/// 把清单里的项移入系统回收站（可恢复）。
///
/// 只做回收站删除：永久删除没有「误点」的退路，本工具不提供——这是有意为之，不是没做完。
/// 返回逐项结果：批里某一项失败（被占用、权限、网络盘没有回收站）不该让整批静默作废。
#[tauri::command]
pub async fn disk_delete_to_trash(paths: Vec<String>) -> Result<Vec<serde_json::Value>, String> {
    let plan = plan_trash_paths(&paths)?;
    tauri::async_runtime::spawn_blocking(move || {
        plan.into_iter()
            .map(|path| match trash::delete(std::path::Path::new(&path)) {
                Ok(()) => serde_json::json!({ "path": path, "ok": true }),
                Err(error) => serde_json::json!({ "path": path, "ok": false, "error": error.to_string() }),
            })
            .collect::<Vec<serde_json::Value>>()
    })
    .await
    .map_err(|e| format!("删除任务异常：{e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_case(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("toolcove-disk-{name}-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_file(path: &Path, size: usize) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, vec![7u8; size]).unwrap();
    }

    fn scan(root: &Path) -> ScanResult {
        scan_tree(root, &AtomicBool::new(false), None)
    }

    #[test]
    fn aggregates_sizes_and_counts_bottom_up() {
        let root = temp_case("aggregate");
        write_file(&root.join("a.txt"), 100);
        write_file(&root.join("b").join("c.txt"), 200);
        write_file(&root.join("b").join("d").join("e.txt"), 300);

        let result = scan(&root);
        assert!(!result.canceled);
        assert!(!result.truncated);
        assert_eq!(result.total_bytes, 600);
        assert_eq!(result.total_files, 3);
        assert_eq!(result.total_dirs, 2);
        assert_eq!(result.errors, 0);

        // 根的直接子目录只有 b，且 b 的聚合体积 = 200 + 300
        let page = children_page(&result, 0, 100).unwrap();
        let children = page["children"].as_array().unwrap();
        assert_eq!(children.len(), 1);
        assert_eq!(children[0]["name"], "b");
        assert_eq!(children[0]["size"], 500);
        assert_eq!(children[0]["files"], 2);

        // 下钻 b：子目录 d 的聚合体积 = 300
        let d_id = children[0]["id"].as_u64().unwrap() as u32;
        let page = children_page(&result, d_id, 100).unwrap();
        let d_children = page["children"].as_array().unwrap();
        assert_eq!(d_children.len(), 1);
        assert_eq!(d_children[0]["name"], "d");
        assert_eq!(d_children[0]["size"], 300);
        assert_eq!(page["node"]["ownBytes"], 200);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn children_are_sorted_by_size_and_limited() {
        let root = temp_case("children");
        write_file(&root.join("small").join("s.txt"), 10);
        write_file(&root.join("large").join("l.txt"), 1000);
        write_file(&root.join("medium").join("m.txt"), 100);

        let result = scan(&root);
        let page = children_page(&result, 0, 2).unwrap();
        let names: Vec<_> = page["children"].as_array().unwrap().iter().map(|c| c["name"].clone()).collect();
        assert_eq!(names, vec![serde_json::json!("large"), serde_json::json!("medium")]);
        assert_eq!(page["childCount"], 3);
        assert_eq!(page["truncated"], true);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn node_path_joins_from_root() {
        let root = temp_case("path");
        write_file(&root.join("x").join("y").join("f.txt"), 5);
        let result = scan(&root);
        let page = children_page(&result, 0, 10).unwrap();
        let x_id = page["children"].as_array().unwrap()[0]["id"].as_u64().unwrap() as u32;
        let page_x = children_page(&result, x_id, 10).unwrap();
        let y_id = page_x["children"].as_array().unwrap()[0]["id"].as_u64().unwrap() as u32;
        let page_y = children_page(&result, y_id, 10).unwrap();
        let path = page_y["node"]["path"].as_str().unwrap();
        assert!(path.ends_with("x\\y") || path.ends_with("x/y"), "实际：{path}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn top_files_keep_the_largest_and_stay_sorted() {
        let root = temp_case("top");
        for size in 1..=250usize {
            write_file(&root.join(format!("f{:03}.bin", size)), size);
        }
        let result = scan(&root);
        assert_eq!(result.top_files.len(), DISK_TOP_FILES);
        // 降序排列，且第 1 名确实是最大的那个（250 字节）
        assert!(result.top_files.windows(2).all(|pair| pair[0].size >= pair[1].size));
        assert_eq!(result.top_files[0].size, 250);
        // 容量 200 / 共 250 个文件：榜单里最小的一条是第 200 大 = 51 字节
        assert_eq!(result.top_files[DISK_TOP_FILES - 1].size, 51);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn canceled_scan_discards_everything() {
        let root = temp_case("cancel");
        write_file(&root.join("a").join("f.txt"), 42);
        let cancel = AtomicBool::new(true);
        let result = scan_tree(&root, &cancel, None);
        assert!(result.canceled);
        assert!(result.nodes.is_empty());
        assert_eq!(result.total_bytes, 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn empty_dir_scans_clean() {
        let root = temp_case("empty");
        let result = scan(&root);
        assert_eq!(result.total_bytes, 0);
        assert_eq!(result.total_files, 0);
        assert_eq!(result.total_dirs, 0);
        let page = children_page(&result, 0, 10).unwrap();
        assert_eq!(page["children"].as_array().unwrap().len(), 0);
        assert_eq!(page["childCount"], 0);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_node_is_rejected() {
        let root = temp_case("missing");
        let result = scan(&root);
        assert!(children_page(&result, 99, 10).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trash_plan_rejects_empty_and_relative() {
        assert!(plan_trash_paths(&[]).is_err());
        assert!(plan_trash_paths(&["   ".into()]).is_err());
        assert!(plan_trash_paths(&["relative\\file.txt".into()]).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn trash_plan_rejects_drive_root() {
        assert!(plan_trash_paths(&["C:\\".into()]).is_err());
    }

    #[test]
    fn trash_plan_dedupes_and_drops_nested_children() {
        let root = temp_case("trash-plan");
        let parent = root.join("dir");
        let child = parent.join("inner.txt");
        let sibling = root.join("other.txt");
        // 子路径排在前、父目录排在后：无论顺序，父目录收下后子路径都要被剔除
        let plan = plan_trash_paths(&[
            child.to_string_lossy().into_owned(),
            parent.to_string_lossy().into_owned(),
            sibling.to_string_lossy().into_owned(),
            sibling.to_string_lossy().into_owned(),
        ])
        .unwrap();
        assert_eq!(plan.len(), 2);
        assert!(plan.iter().any(|path| path == &parent.to_string_lossy()));
        assert!(plan.iter().any(|path| path == &sibling.to_string_lossy()));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn trash_plan_caps_batch_size() {
        let dir = std::env::temp_dir();
        let many: Vec<String> = (0..DISK_DELETE_MAX_ITEMS + 1)
            .map(|index| dir.join(format!("toolcove-trash-{index}")).to_string_lossy().into_owned())
            .collect();
        assert!(plan_trash_paths(&many).is_err());
        assert!(plan_trash_paths(&many[..DISK_DELETE_MAX_ITEMS]).is_ok());
    }
}

#[cfg(all(test, windows))]
mod junction_tests {
    use super::*;

    fn temp_case(name: &str) -> PathBuf {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("toolcove-junction-{name}-{stamp}"));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// 锁定扫描依赖的不变量：Rust 对联结点报「既不是 dir 也不是 file、而是 symlink」。
    /// 正因如此 build_dir 的 `if is_dir {} else if is_file {}` 天然会跳过它们。
    /// 哪天 std 改了行为，这条会先红——而不是让整盘统计悄悄把别的盘的数据算进来。
    #[test]
    fn junctions_are_symlinks_not_dirs() {
        let root = temp_case("probe");
        let real = root.join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = root.join("link");
        junction::create(&real, &link).unwrap();
        let entry = std::fs::read_dir(&root)
            .unwrap()
            .flatten()
            .find(|entry| entry.file_name().to_string_lossy() == "link")
            .unwrap();
        let file_type = entry.file_type().unwrap();
        assert!(!file_type.is_dir(), "junction 不能被当成普通目录（否则扫描会跟进去）");
        assert!(!file_type.is_file());
        assert!(file_type.is_symlink());
        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&root);
    }

    /// 扫一个含 junction 的目录：目标内容不计入统计（不跟随、不重复计数），
    /// 而链接本身要**列出来**——迁移过的目录在原位置就长这样，凭空消失会让人以为数据没了。
    #[test]
    fn scan_skips_junction_content_but_lists_the_link() {
        let root = temp_case("follow");
        let outside = root.join("outside");
        let real = root.join("real");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("inner.bin"), vec![3u8; 1024]).unwrap();
        std::fs::write(outside.join("plain.bin"), vec![4u8; 2048]).unwrap();
        let link = outside.join("linked");
        junction::create(&real, &link).unwrap();

        let result = scan_tree(&outside, &AtomicBool::new(false), None);
        // 目标盘上的 inner.bin（1024 B）不能计入
        assert_eq!(result.total_bytes, 2048);
        assert_eq!(result.total_files, 1);
        assert_eq!(result.links, 1, "链接要计入链接数");
        // 链接出现在根节点的一页里，带上目标路径
        let page = children_page(&result, 0, 50).unwrap();
        let links = page["links"].as_array().unwrap();
        assert_eq!(links.len(), 1);
        assert_eq!(links[0]["name"], "linked");
        assert_eq!(links[0]["target"].as_str().unwrap(), real.to_string_lossy());

        let _ = std::fs::remove_dir(&link);
        let _ = std::fs::remove_dir_all(&root);
    }
}
