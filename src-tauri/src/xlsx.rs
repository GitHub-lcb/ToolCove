//! .xlsx 导出：rust_xlsxwriter 直接写目标路径——数据不过 base64、前端不加载 exceljs。
//! 目前服务「数据库结果集导出」（表头 + 数据行 + 列宽 + 可选冻结首行）；
//! 上线包 / 工时表这类带合并标题与多段样式的导出仍走 exceljs（见 src/shared.js）。
//!
//! Excel 单元格不允许 XML 控制字符：写入前统一剥掉（保留 \t \n \r），
//! 否则打开文件时 Excel 会弹「发现不可读取的内容」。

use rust_xlsxwriter::{Color, Format, FormatAlign, Workbook};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XlsxSheet {
    pub name: String,
    /// 每列宽度（字符数）：与 exceljs 版一致，由前端按表头长度算好
    pub columns: Vec<f64>,
    pub header: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    #[serde(default)]
    pub freeze_header: bool,
}

fn sanitize(text: &str) -> String {
    text.chars()
        .filter(|c| !(*c < ' ' && *c != '\t' && *c != '\n' && *c != '\r'))
        .collect()
}

fn cell_text(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn write_xlsx(path: &str, sheet: &XlsxSheet) -> Result<(), String> {
    let mut workbook = Workbook::new();
    let worksheet = workbook.add_worksheet();
    if !sheet.name.trim().is_empty() {
        // Excel 工作表名不能含 : \ / ? * [ ] 且不超过 31 字符
        let name: String = sheet
            .name
            .chars()
            .filter(|c| !matches!(c, ':' | '\\' | '/' | '?' | '*' | '[' | ']'))
            .take(31)
            .collect();
        worksheet
            .set_name(&name)
            .map_err(|e| format!("工作表名无效：{e}"))?;
    }
    for (index, width) in sheet.columns.iter().enumerate() {
        worksheet
            .set_column_width(index as u16, *width)
            .map_err(|e| e.to_string())?;
    }
    let header_format = Format::new()
        .set_bold()
        .set_font_name("Microsoft YaHei")
        .set_font_color(Color::White)
        .set_background_color(Color::RGB(0x0A6E65))
        .set_align(FormatAlign::VerticalCenter);
    for (index, text) in sheet.header.iter().enumerate() {
        worksheet
            .write_string_with_format(0, index as u16, sanitize(text), &header_format)
            .map_err(|e| e.to_string())?;
    }
    for (row_index, row) in sheet.rows.iter().enumerate() {
        let excel_row = row_index as u32 + 1;
        for (col_index, value) in row.iter().enumerate() {
            let col = col_index as u16;
            match value {
                serde_json::Value::Null => {}
                serde_json::Value::Number(number) => match number.as_f64() {
                    Some(number) => {
                        worksheet
                            .write_number(excel_row, col, number)
                            .map_err(|e| e.to_string())?;
                    }
                    None => {
                        worksheet
                            .write_string(excel_row, col, sanitize(&number.to_string()))
                            .map_err(|e| e.to_string())?;
                    }
                },
                other => {
                    worksheet
                        .write_string(excel_row, col, sanitize(&cell_text(other)))
                        .map_err(|e| e.to_string())?;
                }
            }
        }
    }
    if sheet.freeze_header {
        worksheet
            .set_freeze_panes(1, 0)
            .map_err(|e| e.to_string())?;
    }
    workbook.save(path).map_err(|e| format!("保存 xlsx 失败：{e}"))?;
    Ok(())
}

/// 生成 .xlsx 写盘（桌面端 DB 结果集导出用；浏览器端该功能本来就不可用，见 DbTool.vue）。
#[tauri::command]
pub async fn export_xlsx(path: String, sheet: XlsxSheet) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || write_xlsx(&path, &sheet))
        .await
        .map_err(|e| format!("Excel 导出任务异常：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    fn temp_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("toolcove-xlsx-{name}-{}.xlsx", std::process::id()))
    }

    /// 拼接 xlsx（zip）内所有 XML 文本，用于内容断言（不依赖 inlineStr / sharedStrings 的实现差异）
    fn archive_text(path: &std::path::Path) -> String {
        let file = std::fs::File::open(path).unwrap();
        let mut archive = zip::ZipArchive::new(file).unwrap();
        let mut text = String::new();
        for index in 0..archive.len() {
            let mut entry = archive.by_index(index).unwrap();
            if entry.name().ends_with(".xml") {
                let mut content = String::new();
                if entry.read_to_string(&mut content).is_ok() {
                    text.push_str(&content);
                }
            }
        }
        text
    }

    fn sample_sheet() -> XlsxSheet {
        XlsxSheet {
            name: "查询结果".into(),
            columns: vec![12.0, 20.0],
            header: vec!["id".into(), "name".into()],
            rows: vec![
                vec![serde_json::json!("1"), serde_json::json!("张三")],
                vec![serde_json::json!(2), serde_json::Value::Null],
            ],
            freeze_header: true,
        }
    }

    #[test]
    fn write_xlsx_contains_header_and_rows() {
        let path = temp_path("roundtrip");
        write_xlsx(path.to_str().unwrap(), &sample_sheet()).unwrap();
        let text = archive_text(&path);
        assert!(text.contains("查询结果"), "工作表名应写入");
        assert!(text.contains("id") && text.contains("name"), "表头应写入");
        assert!(text.contains("张三"), "字符串单元格应写入");
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn write_xlsx_reports_invalid_path() {
        let path = temp_path("missing-dir").join("nested").join("out.xlsx");
        let error = write_xlsx(path.to_str().unwrap(), &sample_sheet()).unwrap_err();
        assert!(error.contains("保存 xlsx 失败"), "实际：{error}");
    }

    #[test]
    fn sanitize_strips_control_characters_only() {
        assert_eq!(sanitize("a\u{0}b\u{1f}c"), "abc");
        assert_eq!(sanitize("keep\ttab\nline\rend"), "keep\ttab\nline\rend");
    }
}
