//! PDF 页面操作（桌面端）：lopdf 直读直写文件路径——字节不经过前端 / JS / WASM。
//! 覆盖：摘要、合并、提取、删除、旋转、拆分。打开加密文件时自动尝试空口令
//! （电子发票 / 银行回单那类权限加密无需用户输入），需要口令时返回结构化错误由 UI 收口令；
//! 解密用 lopdf 内置的加密模块（RC4 / AES-128 / AES-256），写出即为未加密文档。
//! 浏览器 / 手机端没有本地路径，保留 pdf-lib + qpdf-wasm（见 src/pdfTool.js / pdfDecrypt.js）。

use std::collections::{HashMap, HashSet};
use std::path::Path;

use lopdf::{Dictionary, Document, Object, ObjectId};

/// 结构化错误：前端按 code 映射 i18n 文案（对齐 src/tools/PdfTool.vue 的 ERROR_KEYS）
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfError {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl PdfError {
    fn new(code: &str) -> Self {
        Self {
            code: code.to_string(),
            detail: None,
        }
    }

    fn detail(code: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_string(),
            detail: Some(detail.into()),
        }
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfInput {
    pub path: String,
    #[serde(default)]
    pub password: Option<String>,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSizeEntry {
    pub label: String,
    pub count: u32,
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSummary {
    pub page_count: u32,
    /// 每页旋转角（0 / 90 / 180 / 270，0 基页序）
    pub page_rotations: Vec<i32>,
    pub sizes: Vec<PdfSizeEntry>,
    pub title: String,
    pub author: String,
    pub subject: String,
    pub creator: String,
    pub producer: String,
    pub size_bytes: u64,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfSplitPlan {
    pub name: String,
    pub indices: Vec<u32>,
}

// ---------- 载入与解密 ----------

/// 解析失败时的归因：尾部 8KB 带 /Encrypt 就按「已加密」报，否则才说文件损坏。
/// 与前端 pdfTool.js 的 looksEncryptedPdf 同一策略（宁可把损坏说成加密，不可反向误判）。
fn looks_encrypted(bytes: &[u8]) -> bool {
    if bytes.len() < 16 || !bytes.starts_with(b"%PDF-") {
        return false;
    }
    let tail = &bytes[bytes.len().saturating_sub(8192)..];
    tail.windows(b"/Encrypt".len()).any(|window| window == b"/Encrypt")
}

fn encrypted_error(input: &PdfInput) -> PdfError {
    match input.password.as_deref() {
        Some(password) if !password.is_empty() => PdfError::new("decryptionWrongPassword"),
        _ => PdfError::new("decryptionPasswordRequired"),
    }
}

/// 读盘 → 带口令解析 → 仍带加密标记时显式补一次解密。
/// 口令必须传给解析阶段（LoadOptions::with_password）：对象流在解析时就要解，等到
/// load 完再 decrypt 只能得到「只剩骨架」的文档（实测 pages=0、objects=1）。
fn load_document(input: &PdfInput) -> Result<Document, PdfError> {
    let bytes = std::fs::read(&input.path)
        .map_err(|e| PdfError::detail("invalid", format!("无法读取文件：{e}")))?;
    let password = input.password.clone().unwrap_or_default();
    let mut doc = match Document::load_mem_with_options(
        &bytes,
        lopdf::LoadOptions::with_password(&password),
    ) {
        Ok(doc) => doc,
        Err(error) => {
            return Err(if looks_encrypted(&bytes) {
                encrypted_error(input)
            } else {
                PdfError::detail("invalid", error.to_string())
            });
        }
    };
    // 口令未提供 / 不对时 reader 返回「仍加密」的骨架：这里显式解密以拿到准确归因
    if doc.is_encrypted() {
        doc.decrypt(&password).map_err(|_| encrypted_error(input))?;
    }
    Ok(doc)
}

fn save_document(mut doc: Document, dest: &str) -> Result<(), PdfError> {
    if doc.get_pages().is_empty() {
        return Err(PdfError::new("emptyResult"));
    }
    doc.save(dest)
        .map_err(|e| PdfError::detail("invalid", format!("保存失败：{e}")))?;
    Ok(())
}

// ---------- 页面属性 ----------

fn object_f64(value: &Object) -> Option<f64> {
    match value {
        Object::Integer(v) => Some(*v as f64),
        Object::Real(v) => Some(*v as f64),
        _ => None,
    }
}

fn normalize_angle(angle: i32) -> i32 {
    ((angle % 360) + 360) % 360
}

/// 沿 /Parent 链向上找某键（MediaBox / Rotate 都允许由祖先 Pages 节点继承）
fn inherited<'a>(doc: &'a Document, dict: &'a Dictionary, key: &[u8]) -> Option<&'a Object> {
    let mut node = dict;
    loop {
        if let Ok(value) = node.get(key) {
            return Some(value);
        }
        let parent_id = node.get(b"Parent").ok().and_then(|p| p.as_reference().ok())?;
        node = doc.get_dictionary(parent_id).ok()?;
    }
}

fn page_rotation(doc: &Document, page_id: ObjectId) -> i32 {
    doc.get_dictionary(page_id)
        .ok()
        .and_then(|dict| inherited(doc, dict, b"Rotate"))
        .and_then(|value| value.as_i64().ok())
        .map(|value| normalize_angle(value as i32))
        .unwrap_or(0)
}

fn page_size(doc: &Document, page_id: ObjectId) -> Option<(f64, f64)> {
    let dict = doc.get_dictionary(page_id).ok()?;
    let media_box = inherited(doc, dict, b"MediaBox")?.as_array().ok()?;
    if media_box.len() != 4 {
        return None;
    }
    let x0 = object_f64(&media_box[0])?;
    let y0 = object_f64(&media_box[1])?;
    let x1 = object_f64(&media_box[2])?;
    let y1 = object_f64(&media_box[3])?;
    Some(((x1 - x0).abs(), (y1 - y0).abs()))
}

/// 叠加旋转：写页级 /Rotate（0 也显式写入，避免被祖先节点的继承值盖回来）
fn rotate_page(doc: &mut Document, page_id: ObjectId, delta: i32) -> Result<(), PdfError> {
    let current = page_rotation(doc, page_id);
    let next = normalize_angle(current + delta);
    let dict = doc
        .get_dictionary_mut(page_id)
        .map_err(|e| PdfError::detail("invalid", e.to_string()))?;
    dict.set("Rotate", next as i64);
    Ok(())
}

/// 按「输出页索引 → 增量角度」应用旋转（与前端 rotationForOrder 的键语义一致）
fn apply_angles(doc: &mut Document, angles: &HashMap<u32, i32>) -> Result<(), PdfError> {
    if angles.is_empty() {
        return Ok(());
    }
    let pages: Vec<ObjectId> = doc.get_pages().values().cloned().collect();
    for (index, delta) in angles {
        if normalize_angle(*delta) == 0 {
            continue;
        }
        let Some(page_id) = pages.get(*index as usize) else {
            continue;
        };
        rotate_page(doc, *page_id, *delta)?;
    }
    Ok(())
}

/// 提取（保留 keep、按原页序）：删除未选中的页。前端 UI 已把选中项按文档序排列，
/// 因此不需要支持任意重排（与 pdf-lib 版 UI 行为一致）。
fn extract(input: &PdfInput, dest: &str, keep: &[u32], angles: &HashMap<u32, i32>) -> Result<(), PdfError> {
    let mut doc = load_document(input)?;
    let total = doc.get_pages().len() as u32;
    let keep_set: HashSet<u32> = keep.iter().copied().filter(|index| *index < total).collect();
    if keep_set.is_empty() {
        return Err(PdfError::new("emptySelection"));
    }
    let dropped: Vec<u32> = (1..=total)
        .filter(|number| !keep_set.contains(&(number - 1)))
        .collect();
    doc.delete_pages(&dropped);
    apply_angles(&mut doc, angles)?;
    save_document(doc, dest)
}

fn remove(input: &PdfInput, dest: &str, remove: &[u32], angles: &HashMap<u32, i32>) -> Result<(), PdfError> {
    let mut doc = load_document(input)?;
    let total = doc.get_pages().len() as u32;
    let dropped: Vec<u32> = remove
        .iter()
        .copied()
        .filter(|index| *index < total)
        .map(|index| index + 1)
        .collect();
    if dropped.is_empty() {
        return Err(PdfError::new("emptySelection"));
    }
    if dropped.len() as u32 >= total {
        return Err(PdfError::new("emptyResult"));
    }
    doc.delete_pages(&dropped);
    apply_angles(&mut doc, angles)?;
    save_document(doc, dest)
}

fn rotate(input: &PdfInput, dest: &str, angles: &HashMap<u32, i32>) -> Result<(), PdfError> {
    if angles.values().all(|delta| normalize_angle(*delta) == 0) {
        return Err(PdfError::new("emptySelection"));
    }
    let mut doc = load_document(input)?;
    apply_angles(&mut doc, angles)?;
    save_document(doc, dest)
}

// ---------- 合并 ----------

/// 把 other 的全部页面与对象并入 base：
/// other 先整体重编号（内部引用同步重映射），对象池直接合并，页面挂到 base 的 /Pages。
/// other 侧的 Pages 中间节点会变成不可达冗余对象（无害，不做 prune 以免误删）。
fn append_document(base: &mut Document, mut other: Document) -> Result<(), PdfError> {
    other.renumber_objects_with(base.max_id + 1);
    let other_pages: Vec<ObjectId> = other.get_pages().values().cloned().collect();
    if other_pages.is_empty() {
        return Ok(());
    }
    let pages_id = base
        .catalog()
        .ok()
        .and_then(|catalog| catalog.get(b"Pages").ok())
        .and_then(|pages| pages.as_reference().ok())
        .ok_or_else(|| PdfError::new("invalid"))?;
    let other_max = other.objects.keys().map(|(id, _)| *id).max().unwrap_or(0);
    base.max_id = base.max_id.max(other_max);
    for (id, object) in other.objects {
        base.objects.insert(id, object);
    }
    {
        let pages_dict = base
            .get_dictionary_mut(pages_id)
            .map_err(|e| PdfError::detail("invalid", e.to_string()))?;
        let count = pages_dict.get(b"Count").and_then(Object::as_i64).unwrap_or(0);
        pages_dict.set("Count", count + other_pages.len() as i64);
        let kids = pages_dict
            .get_mut(b"Kids")
            .and_then(Object::as_array_mut)
            .map_err(|_| PdfError::new("invalid"))?;
        for page_id in &other_pages {
            kids.push(Object::Reference(*page_id));
        }
    }
    for page_id in &other_pages {
        if let Ok(dict) = base.get_dictionary_mut(*page_id) {
            dict.set("Parent", Object::Reference(pages_id));
        }
    }
    Ok(())
}

fn merge(items: &[PdfInput], dest: &str) -> Result<(), PdfError> {
    if items.is_empty() {
        return Err(PdfError::new("emptyInput"));
    }
    let mut base = load_document(&items[0])?;
    if base.get_pages().is_empty() {
        return Err(PdfError::new("emptyInput"));
    }
    for item in &items[1..] {
        let other = load_document(item)?;
        append_document(&mut base, other)?;
    }
    save_document(base, dest)
}

// ---------- 拆分 ----------

fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (c as u32) < 0x20 {
                '_'
            } else {
                c
            }
        })
        .collect();
    if cleaned.trim().is_empty() {
        "document.pdf".to_string()
    } else {
        cleaned
    }
}

fn split(input: &PdfInput, dest_dir: &str, plans: &[PdfSplitPlan]) -> Result<usize, PdfError> {
    if plans.is_empty() {
        return Err(PdfError::new("emptySelection"));
    }
    let doc = load_document(input)?;
    let total = doc.get_pages().len() as u32;
    let mut written = 0usize;
    for plan in plans {
        let keep_set: HashSet<u32> = plan
            .indices
            .iter()
            .copied()
            .filter(|index| *index < total)
            .collect();
        if keep_set.is_empty() {
            continue;
        }
        let mut part = doc.clone();
        let dropped: Vec<u32> = (1..=total)
            .filter(|number| !keep_set.contains(&(number - 1)))
            .collect();
        part.delete_pages(&dropped);
        let dest = Path::new(dest_dir).join(sanitize_file_name(&plan.name));
        save_document(part, &dest.to_string_lossy())?;
        written += 1;
    }
    if written == 0 {
        return Err(PdfError::new("emptySelection"));
    }
    Ok(written)
}

// ---------- 摘要 ----------

fn pdf_text(value: &Object) -> String {
    match value {
        Object::String(bytes, _) => {
            if bytes.starts_with(&[0xFE, 0xFF]) {
                let utf16: Vec<u16> = bytes[2..]
                    .chunks_exact(2)
                    .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
                    .collect();
                String::from_utf16_lossy(&utf16)
            } else {
                String::from_utf8_lossy(bytes).into_owned()
            }
        }
        other => other
            .as_str()
            .map(|text| String::from_utf8_lossy(text).into_owned())
            .unwrap_or_default(),
    }
}

fn info_text(doc: &Document, key: &[u8]) -> String {
    doc.trailer
        .get(b"Info")
        .ok()
        .and_then(|info| info.as_reference().ok())
        .and_then(|id| doc.get_dictionary(id).ok())
        .and_then(|dict| dict.get(key).ok())
        .map(pdf_text)
        .unwrap_or_default()
}

fn summarize(doc: &Document, size_bytes: u64) -> PdfSummary {
    let pages = doc.get_pages();
    let mut sizes: Vec<PdfSizeEntry> = Vec::new();
    let mut page_rotations = Vec::with_capacity(pages.len());
    for page_id in pages.values() {
        if let Some((width, height)) = page_size(doc, *page_id) {
            let label = format!("{} × {} pt", width.round(), height.round());
            match sizes.iter_mut().find(|entry| entry.label == label) {
                Some(entry) => entry.count += 1,
                None => sizes.push(PdfSizeEntry { label, count: 1 }),
            }
        }
        page_rotations.push(page_rotation(doc, *page_id));
    }
    PdfSummary {
        page_count: pages.len() as u32,
        page_rotations,
        sizes,
        title: info_text(doc, b"Title"),
        author: info_text(doc, b"Author"),
        subject: info_text(doc, b"Subject"),
        creator: info_text(doc, b"Creator"),
        producer: info_text(doc, b"Producer"),
        size_bytes,
    }
}

// ---------- 命令 ----------

/// 读取 PDF 概要（页数 / 每页旋转 / 尺寸分布 / 元数据）；加密文件自动尝试空口令。
#[tauri::command]
pub async fn pdf_summary(path: String, password: Option<String>) -> Result<PdfSummary, PdfError> {
    tauri::async_runtime::spawn_blocking(move || {
        let input = PdfInput {
            path: path.clone(),
            password,
        };
        let doc = load_document(&input)?;
        let size_bytes = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
        Ok(summarize(&doc, size_bytes))
    })
    .await
    .map_err(|e| PdfError::detail("invalid", format!("PDF 任务异常：{e}")))?
}

/// 按给定顺序合并多个 PDF，写出到 dest（元数据沿用第一个文件）。
#[tauri::command]
pub async fn pdf_merge(items: Vec<PdfInput>, dest: String) -> Result<(), PdfError> {
    tauri::async_runtime::spawn_blocking(move || merge(&items, &dest))
        .await
        .map_err(|e| PdfError::detail("invalid", format!("PDF 任务异常：{e}")))?
}

/// 提取指定页（0 基，保持原页序输出）；angles 为「输出页索引 → 增量角度」。
#[tauri::command]
pub async fn pdf_extract(
    input: PdfInput,
    dest: String,
    keep: Vec<u32>,
    angles: HashMap<u32, i32>,
) -> Result<(), PdfError> {
    tauri::async_runtime::spawn_blocking(move || extract(&input, &dest, &keep, &angles))
        .await
        .map_err(|e| PdfError::detail("invalid", format!("PDF 任务异常：{e}")))?
}

/// 删除指定页（0 基，其余保持原序）；angles 为「输出页索引 → 增量角度」。
#[tauri::command]
pub async fn pdf_remove(
    input: PdfInput,
    dest: String,
    remove: Vec<u32>,
    angles: HashMap<u32, i32>,
) -> Result<(), PdfError> {
    tauri::async_runtime::spawn_blocking(move || self::remove(&input, &dest, &remove, &angles))
        .await
        .map_err(|e| PdfError::detail("invalid", format!("PDF 任务异常：{e}")))?
}

/// 旋转：angles 为 { 页码(0 基): 增量角度 }，增量叠加在页面原有旋转上。
#[tauri::command]
pub async fn pdf_rotate(
    input: PdfInput,
    dest: String,
    angles: HashMap<u32, i32>,
) -> Result<(), PdfError> {
    tauri::async_runtime::spawn_blocking(move || rotate(&input, &dest, &angles))
        .await
        .map_err(|e| PdfError::detail("invalid", format!("PDF 任务异常：{e}")))?
}

/// 拆分：每个 plan 产出一个文件写到 dest_dir，返回实际写出的文件数。
#[tauri::command]
pub async fn pdf_split(
    input: PdfInput,
    dest_dir: String,
    plans: Vec<PdfSplitPlan>,
) -> Result<usize, PdfError> {
    tauri::async_runtime::spawn_blocking(move || split(&input, &dest_dir, &plans))
        .await
        .map_err(|e| PdfError::detail("invalid", format!("PDF 任务异常：{e}")))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> String {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("src")
            .join("fixtures")
            .join("pdf")
            .join(name)
            .to_string_lossy()
            .into_owned()
    }

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("toolcove-pdf-{name}-{}.pdf", std::process::id()))
    }

    fn input(path: &str) -> PdfInput {
        PdfInput {
            path: path.to_string(),
            password: None,
        }
    }

    fn load_summary(path: &str, password: Option<&str>) -> Result<PdfSummary, PdfError> {
        let doc = load_document(&PdfInput {
            path: path.to_string(),
            password: password.map(String::from),
        })?;
        Ok(summarize(&doc, 0))
    }

    #[test]
    fn summary_reads_pages_and_metadata() {
        let summary = load_summary(&fixture("base.pdf"), None).unwrap();
        assert_eq!(summary.page_count, 2);
        assert_eq!(summary.title, "ToolCove encrypted fixture");
        assert_eq!(summary.page_rotations.len(), 2);
    }

    #[test]
    fn owner_only_encryption_opens_with_empty_password() {
        for name in ["owner-only.pdf", "owner-only-rc4.pdf"] {
            let summary = load_summary(&fixture(name), None)
                .unwrap_or_else(|e| panic!("{name} 应能用空口令打开：{e:?}"));
            assert_eq!(summary.page_count, 2, "{name}");
        }
    }

    #[test]
    fn user_password_requires_correct_password() {
        let error = load_summary(&fixture("user-password.pdf"), None).unwrap_err();
        assert_eq!(error.code, "decryptionPasswordRequired");
        let error = load_summary(&fixture("user-password.pdf"), Some("wrong")).unwrap_err();
        assert_eq!(error.code, "decryptionWrongPassword");
        let summary = load_summary(&fixture("user-password.pdf"), Some("open123")).unwrap();
        assert_eq!(summary.page_count, 2);
    }

    #[test]
    fn merge_concatenates_pages_and_keeps_metadata() {
        let dest = temp_path("merge");
        merge(&[input(&fixture("base.pdf")), input(&fixture("base.pdf"))], dest.to_str().unwrap())
            .unwrap();
        let summary = load_summary(dest.to_str().unwrap(), None).unwrap();
        assert_eq!(summary.page_count, 4);
        assert_eq!(summary.title, "ToolCove encrypted fixture");
        let _ = std::fs::remove_file(dest);
    }

    #[test]
    fn merge_decrypts_encrypted_inputs_transparently() {
        let dest = temp_path("merge-encrypted");
        merge(
            &[input(&fixture("owner-only.pdf")), input(&fixture("base.pdf"))],
            dest.to_str().unwrap(),
        )
        .unwrap();
        let summary = load_summary(dest.to_str().unwrap(), None).unwrap();
        assert_eq!(summary.page_count, 4);
        let _ = std::fs::remove_file(dest);
    }

    #[test]
    fn extract_keeps_selected_pages_in_document_order() {
        let dest = temp_path("extract");
        extract(
            &input(&fixture("base.pdf")),
            dest.to_str().unwrap(),
            &[0],
            &HashMap::new(),
        )
        .unwrap();
        let summary = load_summary(dest.to_str().unwrap(), None).unwrap();
        assert_eq!(summary.page_count, 1);
        let _ = std::fs::remove_file(dest);
    }

    #[test]
    fn extract_with_angles_rotates_output_pages() {
        let dest = temp_path("extract-rotated");
        let mut angles = HashMap::new();
        angles.insert(0u32, 90i32);
        extract(
            &input(&fixture("base.pdf")),
            dest.to_str().unwrap(),
            &[0],
            &angles,
        )
        .unwrap();
        let summary = load_summary(dest.to_str().unwrap(), None).unwrap();
        assert_eq!(summary.page_rotations, vec![90]);
        let _ = std::fs::remove_file(dest);
    }

    #[test]
    fn remove_drops_selected_pages() {
        let dest = temp_path("remove");
        remove(
            &input(&fixture("base.pdf")),
            dest.to_str().unwrap(),
            &[0],
            &HashMap::new(),
        )
        .unwrap();
        let summary = load_summary(dest.to_str().unwrap(), None).unwrap();
        assert_eq!(summary.page_count, 1);
        let _ = std::fs::remove_file(dest);
    }

    #[test]
    fn remove_all_pages_reports_empty_result() {
        let dest = temp_path("remove-all");
        let error = remove(
            &input(&fixture("base.pdf")),
            dest.to_str().unwrap(),
            &[0, 1],
            &HashMap::new(),
        )
        .unwrap_err();
        assert_eq!(error.code, "emptyResult");
    }

    #[test]
    fn split_writes_one_file_per_plan() {
        let dir = std::env::temp_dir().join(format!("toolcove-pdf-split-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let plans = vec![
            PdfSplitPlan { name: "part-1.pdf".into(), indices: vec![0] },
            PdfSplitPlan { name: "part-2.pdf".into(), indices: vec![1] },
        ];
        let written = split(&input(&fixture("base.pdf")), dir.to_str().unwrap(), &plans).unwrap();
        assert_eq!(written, 2);
        for name in ["part-1.pdf", "part-2.pdf"] {
            let summary = load_summary(dir.join(name).to_str().unwrap(), None).unwrap();
            assert_eq!(summary.page_count, 1);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn invalid_input_reports_invalid_not_encrypted() {
        let path = temp_path("garbage");
        std::fs::write(&path, b"this is not a pdf at all").unwrap();
        let error = load_summary(path.to_str().unwrap(), None).unwrap_err();
        assert_eq!(error.code, "invalid");
        let _ = std::fs::remove_file(path);
    }
}
