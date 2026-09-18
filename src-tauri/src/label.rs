//! 标签打印（TSPL）的**桌面端命令层**。
//!
//! 排版引擎已搬到 `crates/label-core`（纯计算、无平台依赖），桌面端与手机端共用同一份实现：
//! 手机端把它编译成 WASM 加载，桌面端在这里以普通依赖引用。「所见即所打」靠的就是这一点——
//! 两端不是"看起来一样"，而是同一份代码算出来的。
//!
//! 本文件只保留**平台相关**的部分：
//!   * `label_layout`  排版（转调 label-core 的 `build_render_payload`，与手机端 wasm 的
//!     `layout_json` 调的是同一个函数）
//!   * `label_printers` / `pick_printer` —— 枚举本机打印队列（Windows 打印系统）
//!   * `label_print` —— 发送到打印队列（RAW）
//!   * `label_export_prn` —— 导出 .prn 文件
//!   * `PrinterList` —— 打印机列表类型（依赖 `printer::PrinterInfo`，所以留在这一层）
//!
//! 纯逻辑（数据模型、排版、体检、指令生成）全部从 label-core 转出，
//! 因此 `crate::label::layout` 这类调用点与前端契约都不变。

// 纯逻辑：原样从 label-core 转出（类型、常量、函数都包含在内）
pub use label_core::*;

use crate::printer;
use serde::Serialize;
use serde_json::json;

/// 打印机列表（含建议选择）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrinterList {
    pub printers: Vec<printer::PrinterInfo>,
    /// 建议选择的打印机：系统默认优先，其次名字像标签机的
    pub suggested: String,
}

/// 生成排版结果、预览绘制模型、TSPL 指令文本和体检提示。
#[tauri::command]
pub fn label_layout(settings: Settings) -> Result<Render, String> {
    Ok(build_render(&settings))
}

/// 枚举已安装的打印机，并给出建议选择（优先系统默认，其次名字像 GP-2120TF 的）。
#[tauri::command(async)]
pub fn label_printers() -> Result<PrinterList, String> {
    let printers = printer::list_printers()?;
    let suggested = pick_printer(&printers);
    Ok(PrinterList {
        printers,
        suggested,
    })
}

/// 打印：把原始 TSPL 字节流交给打印队列。
#[tauri::command(async)]
pub fn label_print(settings: Settings) -> Result<PrintReceipt, String> {
    let name = settings.printer.trim();
    if name.is_empty() {
        return Err("请先选择打印机".to_string());
    }
    let bytes = build_bytes(&settings.label, &settings.job);
    let doc = format!(
        "Label {}x{}mm",
        settings.label.width_mm, settings.label.height_mm
    );

    let started = std::time::Instant::now();
    printer::print_raw(name, &bytes, &doc)?;
    Ok(PrintReceipt {
        printer: name.to_string(),
        bytes: bytes.len(),
        elapsed_ms: started.elapsed().as_millis() as u64,
        copies: settings.job.copies.max(1),
    })
}

/// 导出 GB18030 编码的原始 TSPL 指令（.prn），返回落盘路径。
#[tauri::command(async)]
pub fn label_export_prn(settings: Settings, path: String) -> Result<String, String> {
    if path.trim().is_empty() {
        return Err("没有选择保存位置".to_string());
    }
    let bytes = build_bytes(&settings.label, &settings.job);
    std::fs::write(&path, &bytes).map_err(|e| format!("写入文件失败：{e}"))?;
    Ok(path)
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

fn build_render(settings: &Settings) -> Render {
    let layout = layout(&settings.label, &settings.job);
    let source = build_source(&settings.label, &layout, settings.job.copies);
    let bytes = encode_gb18030(&source);

    let items = layout
        .elements
        .iter()
        .map(|e| match e {
            Element::Text {
                x,
                y,
                font,
                x_mult,
                y_mult,
                text,
            } => DrawItem::Text {
                x: *x,
                y: *y,
                size: font.height() * y_mult,
                width: text_dots(text, *font, *x_mult),
                text: text.clone(),
            },
            Element::Barcode {
                x,
                y,
                height,
                narrow,
                readable,
                data,
                ..
            } => DrawItem::Barcode {
                x: *x,
                y: *y,
                height: *height,
                narrow: *narrow,
                width: settings.job.barcode.width_dots(),
                modules: settings
                    .job
                    .barcode
                    .symbology
                    .pattern(data)
                    .unwrap_or_default(),
                label: if *readable == 1 {
                    data.clone()
                } else {
                    String::new()
                },
                label_size: 20,
            },
            Element::Qr { x, y, cell, .. } => DrawItem::Qr {
                x: *x,
                y: *y,
                cell: *cell,
                size: settings.job.qr.modules(),
                bits: settings.job.qr.bits(),
            },
        })
        .collect();

    let mut issues: Vec<Issue> = check(&settings.label, &settings.job, &layout);
    let printer_hint = printer_issue(&settings.printer);
    let printer_ok = printer_hint.is_none();
    if let Some(hint) = printer_hint {
        issues.push(hint);
    }

    // 只有间隙纸才画间隙条带：黑标在背面，连续纸根本没有间隙
    let gap_dots = match settings.label.media {
        Media::Gap => mm_to_dots(settings.label.gap_mm, settings.label.dpi),
        Media::BlackMark | Media::Continuous => 0,
    };

    Render {
        canvas_w: layout.canvas_w,
        canvas_h: layout.canvas_h,
        items,
        source,
        issues,
        bytes: bytes.len(),
        barcode_ok: settings
            .job
            .barcode
            .symbology
            .pattern(settings.job.barcode.data.trim())
            .is_some(),
        qr_ok: !settings.job.qr.bits().is_empty(),
        gap_dots,
        printer_ok,
    }
}

/// 优先系统默认打印机，其次挑名字里带 2120 / Gprinter / 佳博 的。
fn pick_printer(list: &[printer::PrinterInfo]) -> String {
    if let Some(hit) = list.iter().find(|p| p.is_default) {
        return hit.name.clone();
    }
    for key in PRINTER_HINTS {
        if let Some(hit) = list.iter().find(|p| p.name.to_lowercase().contains(key)) {
            return hit.name.clone();
        }
    }
    list.first().map(|p| p.name.clone()).unwrap_or_default()
}

/// 队列名里出现这些关键字，基本可以认定是标签机。
const PRINTER_HINTS: [&str; 8] = [
    "2120", "gprinter", "佳博", "gainscha", "gp-", "label", "标签", "tspl",
];

/// 选中了激光/喷墨机时提醒一句 —— 把标签指令丢给普通打印机会打出一堆乱码纸。
fn printer_issue(printer: &str) -> Option<Issue> {
    let name = printer.trim();
    if name.is_empty() {
        return Some(Issue::info("printerMissing", json!({})));
    }
    let lower = name.to_lowercase();
    if PRINTER_HINTS.iter().any(|k| lower.contains(k)) {
        return None;
    }
    Some(Issue::info(
        "printerNotLabel",
        json!({ "name": name.to_string() }),
    ))
}

// ---------------------------------------------------------------------------
// 单元测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn render(label: &LabelSpec, job: &JobSpec) -> String {
        let l = layout(label, job);
        build_source(label, &l, job.copies)
    }

    #[test]
    fn mm_to_dots_203dpi() {
        assert_eq!(mm_to_dots(50.0, 203), 400);
        assert_eq!(mm_to_dots(30.0, 203), 240);
        assert_eq!(mm_to_dots(1.0, 203), 8);
    }

    #[test]
    fn canvas_for_5x3cm_is_400x240() {
        let l = LabelSpec::default();
        assert_eq!(l.dots_w(), 400);
        assert_eq!(l.dots_h(), 240);
    }

    #[test]
    fn chinese_is_full_width_ascii_half() {
        assert_eq!(text_dots("中", Font::Chinese24, 1), 24);
        assert_eq!(text_dots("A", Font::Chinese24, 1), 12);
        assert_eq!(text_dots("中文AB", Font::Chinese24, 1), 24 * 2 + 12 * 2);
        assert_eq!(text_dots("中文", Font::Chinese24, 2), 96);
    }

    #[test]
    fn wrap_breaks_chinese_per_char() {
        let lines = wrap_text("一二三四五六七八九", Font::Chinese24, 96, 1);
        assert_eq!(lines, vec!["一二三四", "五六七八", "九"]);
    }

    #[test]
    fn wrap_breaks_ascii_on_space() {
        // Ascii3 每字符 16 点，可用 64 点 → 每行 4 个半角字符，优先在空格处断行
        let lines = wrap_text("ab cd ef", Font::Ascii3, 64, 1);
        assert_eq!(lines, vec!["ab", "cd", "ef"]);
    }

    #[test]
    fn wrap_keeps_explicit_newlines() {
        let lines = wrap_text("a\n\nb", Font::Chinese24, 400, 1);
        assert_eq!(lines, vec!["a", "", "b"]);
    }

    #[test]
    fn code128_preview_handles_common_input() {
        // 字母数字：barcoders 需要我们自己补起始字符集
        let p = Symbology::Code128.pattern("ABC123").expect("字母数字应可编码");
        assert!(p.len() > 50, "模块数异常: {}", p.len());
        // 纯数字走字符集 C，比字符集 A/B 更短
        let digits = Symbology::Code128.pattern("2024051700").expect("数字应可编码");
        let as_text = Symbology::Code128.pattern("2024A").expect("混合应可编码");
        assert!(digits.len() < as_text.len() + 50);
        // 非法内容返回 None 而不是 panic
        assert!(Symbology::Code128.pattern("").is_none());
        assert!(Symbology::Ean13.pattern("不是数字").is_none());
    }

    #[test]
    fn layout_centers_text_horizontally() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = "中".into();
        job.align = Align::Center;
        job.valign = VAlign::Top;
        let l = layout(&label, &job);
        // (400 - 2*8 - 24) / 2 + 8 = 188
        match &l.elements[0] {
            Element::Text { x, y, .. } => {
                assert_eq!(*x, 188);
                assert_eq!(*y, 8);
            }
            other => panic!("期望文本元素，得到 {other:?}"),
        }
    }

    #[test]
    fn layout_vertically_centers_two_lines() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = "第一行\n第二行".into();
        job.line_gap = 4;
        job.valign = VAlign::Center;
        let l = layout(&label, &job);
        assert_eq!(l.elements.len(), 2);
        // 总高 52，可用高 224，偏移 86
        let expect_y = 8 + 86;
        match (&l.elements[0], &l.elements[1]) {
            (Element::Text { y: y0, .. }, Element::Text { y: y1, .. }) => {
                assert_eq!(*y0, expect_y);
                assert_eq!(*y1, expect_y + 28);
            }
            _ => panic!("期望两个文本元素"),
        }
    }

    #[test]
    fn barcode_and_qr_stack_after_text() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = "订单".into();
        job.valign = VAlign::Top;
        job.barcode.enabled = true;
        job.barcode.data = "123456789012".into();
        job.qr.enabled = true;
        job.qr.data = "https://example.com".into();
        let l = layout(&label, &job);
        assert_eq!(l.elements.len(), 3);
        assert!(matches!(l.elements[0], Element::Text { .. }));
        assert!(matches!(l.elements[1], Element::Barcode { .. }));
        assert!(matches!(l.elements[2], Element::Qr { .. }));
        let ys: Vec<u32> = l
            .elements
            .iter()
            .map(|e| match e {
                Element::Text { y, .. } | Element::Barcode { y, .. } | Element::Qr { y, .. } => *y,
            })
            .collect();
        assert!(ys[0] < ys[1] && ys[1] < ys[2], "y 坐标应递增: {ys:?}");
    }

    #[test]
    fn check_warns_paper_too_wide() {
        let mut label = LabelSpec::default();
        label.width_mm = 80.0;
        let job = JobSpec::default();
        let l = layout(&label, &job);
        let issues = check(&label, &job, &l);
        assert!(issues
            .iter()
            .any(|i| i.level == "warn" && i.code == "paperTooWide"));
    }

    #[test]
    fn check_warns_ascii_font_with_chinese() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.font = Font::Ascii3;
        job.text = "中文".into();
        let l = layout(&label, &job);
        let issues = check(&label, &job, &l);
        assert!(issues.iter().any(|i| i.code == "asciiFontChinese"));
    }

    #[test]
    fn check_flags_overflow_height() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = (0..20)
            .map(|i| format!("行{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        job.valign = VAlign::Top;
        let l = layout(&label, &job);
        let issues = check(&label, &job, &l);
        assert!(issues.iter().any(|i| i.code == "contentOverflow"));
    }

    #[test]
    fn qr_bits_match_module_count() {
        let qr = QrSpec {
            data: "https://example.com".into(),
            cell: 4,
            ..Default::default()
        };
        let n = qr.modules() as usize;
        assert_eq!(qr.bits().len(), n * n);
        assert_eq!(qr.size_dots(), qr.modules() * 4);
    }

    #[test]
    fn serde_uses_camel_case() {
        let j = JobSpec::default();
        let json = serde_json::to_string(&j).unwrap();
        assert!(json.contains("\"xMult\""), "{json}");
        assert!(json.contains("\"lineGap\""), "{json}");
        assert!(json.contains("\"chinese24\""), "{json}");
        let back: JobSpec = serde_json::from_str(&json).unwrap();
        assert_eq!(back, j);
    }

    #[test]
    fn partial_settings_json_falls_back_to_defaults() {
        // 缺字段的旧配置也要能读
        let s: Settings = serde_json::from_str(r#"{"printer":"X"}"#).unwrap();
        assert_eq!(s.printer, "X");
        assert_eq!(s.label.height_mm, 30.0);
        assert_eq!(s.job.copies, 1);
    }

    // --- TSPL ---

    #[test]
    fn header_matches_gp2120tf_5x3cm() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = "测试".into();
        let src = render(&label, &job);
        assert!(src.starts_with("SIZE 50 mm,30 mm\r\n"), "实际: {src}");
        assert!(src.contains("GAP 2 mm,0 mm\r\n"));
        assert!(src.contains("DIRECTION 1\r\n"));
        assert!(src.contains("DENSITY 8\r\n"));
        assert!(src.contains("SPEED 4\r\n"));
        assert!(src.contains("CLS\r\n"));
        assert!(src.ends_with("PRINT 1,1\r\n"));
    }

    #[test]
    fn text_uses_absolute_dots_and_chinese_font() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = "订单号".into();
        job.align = Align::Center;
        job.valign = VAlign::Top;
        let src = render(&label, &job);
        // 3 个全角字 = 72 点，(400-16-72)/2 + 8 = 164
        assert!(
            src.contains("TEXT 164,8,\"TSS24.BF2\",0,1,1,\"订单号\"\r\n"),
            "实际: {src}"
        );
    }

    #[test]
    fn print_count_uses_requested_copies() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.copies = 5;
        assert!(render(&label, &job).ends_with("PRINT 1,5\r\n"));
    }

    #[test]
    fn barcode_command_shape() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = String::new();
        job.valign = VAlign::Top;
        job.barcode.enabled = true;
        job.barcode.data = "ABC123".into();
        job.barcode.height = 60;
        job.barcode.narrow = 2;
        job.barcode.wide = 4;
        job.barcode.readable = true;
        let src = render(&label, &job);
        let line = src
            .lines()
            .find(|l| l.starts_with("BARCODE"))
            .expect("应生成 BARCODE 指令");
        assert!(line.ends_with("\"ABC123\""), "实际: {line}");
        assert!(line.contains(",\"128\",60,1,0,2,4,"), "实际: {line}");
    }

    #[test]
    fn qrcode_command_shape() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = String::new();
        job.qr.enabled = true;
        job.qr.data = "https://example.com".into();
        job.qr.cell = 3;
        let src = render(&label, &job);
        let line = src.lines().find(|l| l.starts_with("QRCODE")).unwrap();
        assert!(line.contains(",M,3,A,0,M2,S7,"), "实际: {line}");
        assert!(line.ends_with("\"https://example.com\""), "实际: {line}");
    }

    #[test]
    fn escapes_quotes_and_backslashes() {
        assert_eq!(escape("a\"b\\c"), "a\\\"b\\\\c");
    }

    #[test]
    fn multiline_text_becomes_multiple_text_commands() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = "第一行\n第二行".into();
        let src = render(&label, &job);
        assert_eq!(src.matches("TEXT ").count(), 2, "实际: {src}");
    }

    #[test]
    fn gb18030_bytes_for_chinese() {
        assert_eq!(encode_gb18030("中"), vec![0xD6, 0xD0]); // GBK 双字节
        assert_eq!(encode_gb18030("A"), vec![0x41]);
    }

    #[test]
    fn encoded_command_is_valid_gb18030_stream() {
        let label = LabelSpec::default();
        let mut job = JobSpec::default();
        job.text = "中文ABC".into();
        let bytes = build_bytes(&label, &job);
        // 中文正文应出现 GBK 双字节
        assert!(bytes
            .windows(2)
            .any(|w| (0xB0..=0xF7).contains(&w[0]) && (0xA1..=0xFE).contains(&w[1])));
        assert!(bytes.ends_with(b"PRINT 1,1\r\n"));
    }

    #[test]
    fn continuous_media_uses_zero_gap() {
        let mut label = LabelSpec::default();
        label.media = Media::Continuous;
        let job = JobSpec::default();
        assert!(render(&label, &job).contains("GAP 0 mm,0 mm\r\n"));
    }

    #[test]
    fn black_mark_media_uses_bline() {
        let mut label = LabelSpec::default();
        label.media = Media::BlackMark;
        label.black_mark_mm = 2.0;
        let job = JobSpec::default();
        assert!(render(&label, &job).contains("BLINE 2 mm,0 mm\r\n"));
    }

    #[test]
    fn mm_formatting_drops_trailing_zero() {
        assert_eq!(fmt_mm(50.0), "50");
        assert_eq!(fmt_mm(2.5), "2.5");
    }

    #[test]
    fn codepage_only_when_enabled() {
        let mut label = LabelSpec::default();
        let job = JobSpec::default();
        assert!(!render(&label, &job).contains("CODEPAGE"));
        label.codepage_936 = true;
        assert!(render(&label, &job).contains("CODEPAGE 936\r\n"));
    }

    // --- 命令层 ---

    #[test]
    fn render_produces_text_item_for_5x3cm_label() {
        let s = Settings::default();
        let r = build_render(&s);
        assert_eq!(r.canvas_w, 400);
        assert_eq!(r.canvas_h, 240);
        assert!(!r.items.is_empty());
        assert!(r.source.starts_with("SIZE 50 mm,30 mm"));
        assert!(r.bytes > 100);
    }

    #[test]
    fn barcode_item_carries_modules_and_readable_text() {
        let mut s = Settings::default();
        s.job.text = String::new();
        s.job.barcode.enabled = true;
        s.job.barcode.data = "ABC123".into();
        s.job.barcode.readable = true;
        let r = build_render(&s);
        assert!(r.barcode_ok);
        let item = r
            .items
            .iter()
            .find(|i| matches!(i, DrawItem::Barcode { .. }))
            .expect("应有条码元素");
        match item {
            DrawItem::Barcode {
                modules, label, width, ..
            } => {
                assert!(!modules.is_empty());
                assert_eq!(label, "ABC123");
                assert_eq!(*width as usize, modules.len() * s.job.barcode.narrow as usize);
            }
            _ => unreachable!(),
        }
    }

    #[test]
    fn qr_item_carries_square_bitmap() {
        let mut s = Settings::default();
        s.job.qr.enabled = true;
        s.job.qr.data = "https://example.com".into();
        let r = build_render(&s);
        assert!(r.qr_ok);
        match r.items.iter().find(|i| matches!(i, DrawItem::Qr { .. })) {
            Some(DrawItem::Qr { size, bits, .. }) => {
                assert_eq!(bits.len(), (*size as usize) * (*size as usize));
            }
            _ => panic!("应有二维码元素"),
        }
    }

    #[test]
    fn draw_item_json_is_camel_case() {
        let r = build_render(&Settings::default());
        let json = serde_json::to_string(&r).unwrap();
        assert!(json.contains("\"canvasW\""), "{json}");
        assert!(json.contains("\"kind\":\"text\""), "{json}");
        assert!(json.contains("\"barcodeOk\""), "{json}");
    }

    #[test]
    fn invalid_barcode_content_is_reported_not_panicking() {
        let mut s = Settings::default();
        s.job.barcode.enabled = true;
        s.job.barcode.symbology = Symbology::Ean13;
        s.job.barcode.data = "不是数字".into();
        let r = build_render(&s);
        assert!(!r.barcode_ok);
        // 仍然会生成指令，交给打印机判断
        assert!(r.source.contains("BARCODE"));
    }

    #[test]
    fn pick_printer_prefers_default_then_label_printer() {
        let list = vec![
            printer::PrinterInfo {
                name: "Microsoft Print to PDF".to_string(),
                is_default: false,
            },
            printer::PrinterInfo {
                name: "Gprinter GP-2120TF".to_string(),
                is_default: false,
            },
        ];
        assert_eq!(pick_printer(&list), "Gprinter GP-2120TF");

        let with_default = vec![
            printer::PrinterInfo {
                name: "Microsoft Print to PDF".to_string(),
                is_default: true,
            },
            printer::PrinterInfo {
                name: "Gprinter GP-2120TF".to_string(),
                is_default: false,
            },
        ];
        assert_eq!(pick_printer(&with_default), "Microsoft Print to PDF");
        assert_eq!(pick_printer(&[]), "");
    }

    #[test]
    fn warns_when_printer_is_not_a_label_printer() {
        assert!(printer_issue("Brother HL-2250DN series Printer")
            .map(|i| i.code == "printerNotLabel")
            .unwrap_or(false));
        assert!(printer_issue("")
            .map(|i| i.code == "printerMissing")
            .unwrap_or(false));
        assert!(printer_issue("Gprinter GP-2120TF").is_none());
        assert!(printer_issue("GP-2120TF (副本 1)").is_none());
    }

    #[test]
    fn render_includes_printer_hint_in_issues() {
        let mut s = Settings::default();
        s.printer = "Microsoft Print to PDF".into();
        let r = build_render(&s);
        assert!(r.issues.iter().any(|i| i.code == "printerNotLabel"));
        assert!(!r.printer_ok);
    }

    #[test]
    fn printer_ok_true_for_label_printer() {
        let mut s = Settings::default();
        s.printer = "Gprinter GP-2120TF".into();
        let r = build_render(&s);
        assert!(r.printer_ok);
        assert!(!r.issues.iter().any(|i| i.code == "printerNotLabel"));
    }

    #[test]
    fn gap_dots_only_for_gap_media() {
        let mut s = Settings::default();
        s.label.media = Media::Gap;
        s.label.gap_mm = 2.0;
        assert_eq!(build_render(&s).gap_dots, 16); // 2mm × 8 点/mm

        s.label.media = Media::Continuous;
        assert_eq!(build_render(&s).gap_dots, 0);

        s.label.media = Media::BlackMark;
        assert_eq!(build_render(&s).gap_dots, 0);
    }

    #[test]
    fn export_prn_writes_gb18030_bytes() {
        let mut s = Settings::default();
        s.job.text = "中文".into();
        let path = std::env::temp_dir().join(format!(
            "toolcove-label-{}.prn",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let written = label_export_prn(s, path.display().to_string()).unwrap();
        let bytes = std::fs::read(&written).unwrap();
        assert!(bytes.windows(2).any(|w| w == [0xD6, 0xD0]));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn export_prn_rejects_empty_path() {
        assert!(label_export_prn(Settings::default(), "  ".into()).is_err());
    }

    #[test]
    fn print_rejects_missing_printer_before_touching_spooler() {
        let mut s = Settings::default();
        s.printer = String::new();
        assert!(label_print(s).unwrap_err().contains("打印机"));
    }

    /// 命令层直接调用（#[tauri::command] 只额外生成包装函数）：确认 IPC 边界可用。
    #[test]
    fn layout_command_returns_payload_for_defaults() {
        let r = label_layout(Settings::default()).unwrap();
        assert_eq!((r.canvas_w, r.canvas_h), (400, 240));
        assert_eq!(r.gap_dots, 16);
        assert!(!r.printer_ok); // 默认没有选打印机
        assert!(r.issues.iter().any(|i| i.code == "printerMissing"));
        assert!(r.source.contains("SIZE 50 mm,30 mm"));
    }

    /// 建议值必须真的在列表里，否则前端下拉会出现「选中了不存在的项」。
    #[test]
    fn printers_command_suggestion_belongs_to_list() {
        match label_printers() {
            Ok(list) => {
                assert!(list.suggested.is_empty() || list.printers.iter().any(|p| p.name == list.suggested));
                assert!(list.printers.iter().filter(|p| p.is_default).count() <= 1);
            }
            Err(e) => println!("枚举失败(环境相关): {e}"),
        }
    }

    /// 回包字段名是前端唯一能依赖的契约（前端有对应用例逐个读取）：
    /// 这里用真实序列化结果钉住名字，改名必须同步改 LabelTool.vue / labelTool.js。
    #[test]
    fn render_json_key_contract() {
        let v = serde_json::to_value(label_layout(Settings::default()).unwrap()).unwrap();
        let mut keys: Vec<&str> = v.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            [
                "barcodeOk", "bytes", "canvasH", "canvasW", "gapDots", "issues", "items", "printerOk",
                "qrOk", "source"
            ]
        );

        let mut issue_keys: Vec<&str> = v["issues"][0]
            .as_object()
            .unwrap()
            .keys()
            .map(|k| k.as_str())
            .collect();
        issue_keys.sort_unstable();
        assert_eq!(issue_keys, ["code", "level", "params"]);

        // 文本元素字段（前端按 kind 分支绘制）
        let item = &v["items"][0];
        assert_eq!(item["kind"], "text");
        let mut item_keys: Vec<&str> = item.as_object().unwrap().keys().map(|k| k.as_str()).collect();
        item_keys.sort_unstable();
        assert_eq!(item_keys, ["kind", "size", "text", "width", "x", "y"]);
    }
}
