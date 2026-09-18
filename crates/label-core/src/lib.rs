//! 标签打印（TSPL）：数据模型、排版引擎、体检提示、指令生成与 IPC 命令。
//!
//! 移植自 print-tool（佳博 GP-2120TF 标签打印工具）的 label.rs / tspl.rs / lib.rs，
//! 目标机型不变：203 DPI → 8 点/mm（50×30mm 标签 = 400×240 点）、TSPL 指令集、
//! 简体中文 GB18030（字体 `TSS24.BF2`）。
//!
//! 分层：
//!   * 模型与排版（[`layout`]）—— 纯计算，不碰界面也不碰 Windows API，可完整单测
//!   * 指令生成（[`build_source`] / [`encode_gb18030`]）—— 可读文本 + 真正下发的字节流
//!   * 体检（[`check`]）—— 打印前提示，避免「点了打印出来半张废纸」；返回错误码而非文案，
//!     由前端按语言渲染（ToolCove 是中英双语）
//!   * 命令层（[`label_layout`] / [`label_printers`] / [`label_print`] / [`label_export_prn`]）
//!
//! 排版与指令生成只有这一份实现：前端把表单发过来，拿回「元素 + 绝对坐标」的绘制模型
//! 画预览，打印时用的是同一份排版结果，所以预览和实打必然一致。
//!
//! TSPL 标签排版引擎（**纯计算，无平台依赖**）。
//! 
//! 这个文件由 src-tauri/src/label.rs 的纯逻辑部分搬移而来（逐字一致），目的是让
//! **桌面端（Tauri）与手机端（WASM）跑同一份排版实现**——「所见即所打」的前提就是
//! 两端算出来的布局、指令与预览完全一致，各写一份迟早会漂。
//! 
//! 约束：本 crate 不依赖 tauri / std::fs / 打印相关的东西，否则编译不到 wasm32。
//! 平台相关的部分（列打印机、发送到打印队列、导出 .prn）留在桌面端的 src/label.rs。

/// WASM 导出层：只在 wasm32 目标下编译（`extern "C"` 导出 + 手写内存协议，
/// 不引 wasm-bindgen 那一整套工具链）。
#[cfg(target_arch = "wasm32")]
pub mod wasm;

use serde::{Deserialize, Serialize};
use serde_json::json;
use unicode_width::UnicodeWidthChar;


/// 毫米换算成打印点。203dpi 下 1mm = 8 点。
pub fn mm_to_dots(mm: f32, dpi: u32) -> u32 {
    (mm * dpi as f32 / 25.4).round().max(0.0) as u32
}

/// GP-2120TF 在 TSPL 模式下的最大打印宽度（mm）。
pub const MAX_PRINTABLE_MM: f32 = 56.0;

// ---------------------------------------------------------------------------
// 纸张
// ---------------------------------------------------------------------------

/// 纸张定位方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Media {
    /// 间隙纸（标签纸），透射传感器定位
    Gap,
    /// 黑标纸
    BlackMark,
    /// 连续纸（小票纸），不做定位
    Continuous,
}

/// 纸张与打印参数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LabelSpec {
    /// 纸宽 mm（含底纸）
    pub width_mm: f32,
    /// 标签高度 mm
    pub height_mm: f32,
    pub media: Media,
    /// 间隙高度 mm（间隙纸）
    pub gap_mm: f32,
    /// 间隙偏移 mm，一般 0
    pub gap_offset_mm: f32,
    /// 黑标位置 mm
    pub black_mark_mm: f32,
    /// 打印机分辨率
    pub dpi: u32,
    /// 打印速度 1~6（越大越快、越浅）
    pub speed: u32,
    /// 打印浓度 0~15（越大越黑）
    pub density: u32,
    /// 打印方向 0/1
    pub direction: u32,
    /// 左右留白（点）
    pub margin_x: u32,
    /// 上下留白（点）
    pub margin_y: u32,
    /// 额外发送 `CODEPAGE 936`（中文乱码时可尝试打开）
    pub codepage_936: bool,
}

impl Default for LabelSpec {
    fn default() -> Self {
        Self {
            width_mm: 50.0,
            height_mm: 30.0,
            media: Media::Gap,
            gap_mm: 2.0,
            gap_offset_mm: 0.0,
            black_mark_mm: 0.0,
            dpi: 203,
            speed: 4,
            density: 8,
            direction: 1,
            margin_x: 8,
            margin_y: 8,
            codepage_936: false,
        }
    }
}

impl LabelSpec {
    pub fn dots_w(&self) -> u32 {
        mm_to_dots(self.width_mm, self.dpi)
    }

    pub fn dots_h(&self) -> u32 {
        mm_to_dots(self.height_mm, self.dpi)
    }
}

// ---------------------------------------------------------------------------
// 字体
// ---------------------------------------------------------------------------

/// 打印机内置点阵字体。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Font {
    /// 8×12 点阵，仅 ASCII
    Ascii1,
    /// 12×20 点阵，仅 ASCII
    Ascii2,
    /// 16×24 点阵，仅 ASCII
    Ascii3,
    /// 24×32 点阵，仅 ASCII
    Ascii4,
    /// 32×48 点阵，仅 ASCII
    Ascii5,
    /// 24×24 简体中文点阵（半角 12×24），支持汉字
    Chinese24,
}

impl Font {
    /// TSPL `TEXT` 指令里的字体名。
    pub fn tspl_name(self) -> &'static str {
        match self {
            Font::Ascii1 => "1",
            Font::Ascii2 => "2",
            Font::Ascii3 => "3",
            Font::Ascii4 => "4",
            Font::Ascii5 => "5",
            Font::Chinese24 => "TSS24.BF2",
        }
    }

    /// 半角字符宽度（点）
    pub fn ascii_w(self) -> u32 {
        match self {
            Font::Ascii1 => 8,
            Font::Ascii2 => 12,
            Font::Ascii3 => 16,
            Font::Ascii4 => 24,
            Font::Ascii5 => 32,
            Font::Chinese24 => 12,
        }
    }

    /// 全角字符宽度（点）
    pub fn full_w(self) -> u32 {
        match self {
            Font::Ascii1 => 8,
            Font::Ascii2 => 12,
            Font::Ascii3 => 16,
            Font::Ascii4 => 24,
            Font::Ascii5 => 32,
            Font::Chinese24 => 24,
        }
    }

    /// 字高（点）
    pub fn height(self) -> u32 {
        match self {
            Font::Ascii1 => 12,
            Font::Ascii2 => 20,
            Font::Ascii3 => 16,
            Font::Ascii4 => 24,
            Font::Ascii5 => 32,
            Font::Chinese24 => 24,
        }
    }

    /// 是否支持中文。ASCII 位图字体打中文会输出乱码。
    pub fn supports_chinese(self) -> bool {
        matches!(self, Font::Chinese24)
    }
}

// ---------------------------------------------------------------------------
// 对齐
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Align {
    Left,
    Center,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VAlign {
    Top,
    Center,
    Bottom,
}

// ---------------------------------------------------------------------------
// 条码 / 二维码
// ---------------------------------------------------------------------------

/// 一维码制（括号内是 TSPL 的码制名）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Symbology {
    Code128,
    Code39,
    Ean13,
    Ean8,
    UpcA,
    Itf14,
    Codabar,
}

impl Symbology {
    pub fn tspl(self) -> &'static str {
        match self {
            Symbology::Code128 => "128",
            Symbology::Code39 => "39",
            Symbology::Ean13 => "EAN13",
            Symbology::Ean8 => "EAN8",
            Symbology::UpcA => "UPCA",
            Symbology::Itf14 => "ITF14",
            Symbology::Codabar => "CODABAR",
        }
    }

    /// 用 barcoders 算出模块（窄条）的明暗序列，用于预览和居中排版。
    ///
    /// 返回 `None` 表示内容不符合码制规则，或该码制暂不支持本地预览
    /// （打印仍然交给打印机固件处理）。
    pub fn pattern(self, data: &str) -> Option<Vec<u8>> {
        use barcoders::sym;
        // 空内容直接判为不可编码：barcoders 拿一个起始字符也能编出条码，
        // 但那种「只有起始符」的条码没有意义。
        if data.is_empty() {
            return None;
        }
        let v = match self {
            Symbology::Code128 => code128_pattern(data)?,
            Symbology::Code39 => sym::code39::Code39::new(data).ok()?.encode(),
            Symbology::Ean13 => sym::ean13::EAN13::new(data).ok()?.encode(),
            Symbology::Ean8 => sym::ean8::EAN8::new(data).ok()?.encode(),
            // UPC-A 就是补了前导 0 的 EAN13
            Symbology::UpcA => sym::ean13::EAN13::new(format!("0{data}")).ok()?.encode(),
            Symbology::Codabar => sym::codabar::Codabar::new(data).ok()?.encode(),
            // ITF 在 barcoders 里的构造方式不稳定，预览退化为占位框
            Symbology::Itf14 => return None,
        };
        Some(v)
    }

    /// 模块（窄条）数量，用来算条码总宽。
    pub fn modules(self, data: &str) -> Option<usize> {
        self.pattern(data).map(|v| v.len())
    }
}

/// CODE128 的三个起始字符（barcoders 用它们指定字符集）。
///
/// TSPL 的 `BARCODE ...,"128",...` 只需要给裸数据，由打印机固件自己挑最优字符集；
/// 这里为了预览宽度准确，按同样的思路猜一个最省的字符集：
/// 偶数位纯数字用 C（两位一码，最短），含小写用 B，其余用 A。
const START_A: char = '\u{00C0}';
const START_B: char = '\u{0181}';
const START_C: char = '\u{0106}';

fn code128_pattern(data: &str) -> Option<Vec<u8>> {
    use barcoders::sym::code128::Code128;

    let all_digits = !data.is_empty() && data.chars().all(|c| c.is_ascii_digit());
    let mut candidates: Vec<char> = Vec::new();
    if all_digits && data.len() % 2 == 0 {
        candidates.push(START_C);
    }
    if data.chars().any(|c| c.is_ascii_lowercase()) {
        candidates.push(START_B);
    }
    candidates.extend([START_A, START_B, START_C]);

    for start in candidates {
        let text = format!("{start}{data}");
        if let Ok(code) = Code128::new(&text) {
            let encoded = code.encode();
            if !encoded.is_empty() {
                return Some(encoded);
            }
        }
    }
    None
}

/// 二维码纠错等级。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Ecc {
    L,
    M,
    Q,
    H,
}

impl Ecc {
    pub fn tspl(self) -> &'static str {
        match self {
            Ecc::L => "L",
            Ecc::M => "M",
            Ecc::Q => "Q",
            Ecc::H => "H",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct BarcodeSpec {
    pub enabled: bool,
    pub data: String,
    pub symbology: Symbology,
    /// 条码高度（点）
    pub height: u32,
    /// 窄条宽度（点）
    pub narrow: u32,
    /// 宽条宽度（点）
    pub wide: u32,
    /// 是否打印人眼可读文本
    pub readable: bool,
    pub align: Align,
}

impl Default for BarcodeSpec {
    fn default() -> Self {
        Self {
            enabled: false,
            data: String::new(),
            symbology: Symbology::Code128,
            height: 60,
            narrow: 2,
            wide: 4,
            readable: true,
            align: Align::Center,
        }
    }
}

impl BarcodeSpec {
    /// 条码总宽（点）。无法本地编码时返回 0 表示未知。
    pub fn width_dots(&self) -> u32 {
        match self.symbology.modules(self.data.trim()) {
            Some(m) => m as u32 * self.narrow.max(1),
            None => 0,
        }
    }

    /// 人眼可读文本占用的高度（点）
    pub fn readable_h(&self) -> u32 {
        if self.readable {
            24
        } else {
            0
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct QrSpec {
    pub enabled: bool,
    pub data: String,
    /// 单个模块边长（点），1~10
    pub cell: u32,
    pub ecc: Ecc,
    pub align: Align,
}

impl Default for QrSpec {
    fn default() -> Self {
        Self {
            enabled: false,
            data: String::new(),
            cell: 4,
            ecc: Ecc::M,
            align: Align::Center,
        }
    }
}

impl QrSpec {
    /// 二维码符号的模块数（不含静区）。
    ///
    /// 用 qrcode 真实编码得到，保证预览里的方块数量和实打一致。
    /// 打印机按 `QRCODE` 指令把这个 n×n 符号画在 (x,y)，所以按 n*cell 预留空间。
    pub fn modules(&self) -> u32 {
        match qrcode::QrCode::new(self.data.trim().as_bytes()) {
            Ok(code) => code.width() as u32,
            Err(_) => 25,
        }
    }

    /// 符号占用尺寸（点），不含静区。
    pub fn size_dots(&self) -> u32 {
        self.modules() * self.cell.clamp(1, 10)
    }

    /// 逐模块明暗序列（true = 黑），供前端画预览。
    pub fn bits(&self) -> Vec<bool> {
        match qrcode::QrCode::new(self.data.trim().as_bytes()) {
            Ok(code) => code
                .to_colors()
                .into_iter()
                .map(|c| matches!(c, qrcode::types::Color::Dark))
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// 打印任务
// ---------------------------------------------------------------------------

/// 一次打印的内容与排版参数。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobSpec {
    /// 多行文本，换行即分行
    pub text: String,
    pub font: Font,
    /// 横向放大倍数 1~10
    pub x_mult: u32,
    /// 纵向放大倍数 1~10
    pub y_mult: u32,
    /// 行间距（点）
    pub line_gap: u32,
    /// 段落间距（点）
    pub block_gap: u32,
    pub align: Align,
    pub valign: VAlign,
    pub barcode: BarcodeSpec,
    pub qr: QrSpec,
    /// 打印份数
    pub copies: u32,
}

impl Default for JobSpec {
    fn default() -> Self {
        Self {
            text: "测试标签\nTest Label".to_string(),
            font: Font::Chinese24,
            x_mult: 1,
            y_mult: 1,
            line_gap: 4,
            block_gap: 10,
            align: Align::Center,
            valign: VAlign::Center,
            barcode: BarcodeSpec::default(),
            qr: QrSpec::default(),
            copies: 1,
        }
    }
}

impl JobSpec {
    /// 自动换行后的实际文本行。
    pub fn wrapped_lines(&self, max_dots: u32) -> Vec<String> {
        wrap_text(&self.text, self.font, max_dots, self.x_mult.max(1))
    }
}

/// 排版后的一个绘制元素（坐标已换算成绝对打印点）。
#[derive(Debug, Clone, PartialEq)]
pub enum Element {
    Text {
        x: u32,
        y: u32,
        font: Font,
        x_mult: u32,
        y_mult: u32,
        text: String,
    },
    Barcode {
        x: u32,
        y: u32,
        code_type: String,
        height: u32,
        readable: u32,
        narrow: u32,
        wide: u32,
        data: String,
    },
    Qr {
        x: u32,
        y: u32,
        ecc: String,
        cell: u32,
        data: String,
    },
}

/// 排版结果。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Layout {
    pub elements: Vec<Element>,
    pub canvas_w: u32,
    pub canvas_h: u32,
}

/// 单个字符占用的宽度（点）。
pub fn char_dots(c: char, font: Font, x_mult: u32) -> u32 {
    let x_mult = x_mult.max(1);
    let wide = UnicodeWidthChar::width(c).unwrap_or(1) >= 2;
    if wide {
        font.full_w() * x_mult
    } else {
        font.ascii_w() * x_mult
    }
}

/// 一行文本的宽度（点）。
pub fn text_dots(text: &str, font: Font, x_mult: u32) -> u32 {
    text.chars().map(|c| char_dots(c, font, x_mult)).sum()
}

/// 按可用宽度自动换行。
///
/// 规则：中日韩等全角字符逐字断行；纯半角内容优先在空格/连字符处断词。
pub fn wrap_text(text: &str, font: Font, max_dots: u32, x_mult: u32) -> Vec<String> {
    let x_mult = x_mult.max(1);
    let max_dots = max_dots.max(font.ascii_w() * x_mult);
    let mut out = Vec::new();

    for logical in text.split('\n') {
        let logical = logical.trim_end_matches('\r');
        if logical.is_empty() {
            out.push(String::new());
            continue;
        }
        let chars: Vec<char> = logical.chars().collect();
        let mut start = 0usize;
        while start < chars.len() {
            let mut w = 0u32;
            let mut end = start;
            let mut last_break: Option<usize> = None;
            while end < chars.len() {
                let cw = char_dots(chars[end], font, x_mult);
                if w + cw > max_dots && end > start {
                    break;
                }
                w += cw;
                end += 1;
                if matches!(chars[end - 1], ' ' | '\t' | '-') {
                    last_break = Some(end);
                }
            }
            if end >= chars.len() {
                out.push(
                    chars[start..end]
                        .iter()
                        .collect::<String>()
                        .trim_end()
                        .to_string(),
                );
                break;
            }
            let segment: String = chars[start..end].iter().collect();
            let has_wide = segment
                .chars()
                .any(|c| char_dots(c, font, x_mult) > font.ascii_w() * x_mult);
            let cut = if has_wide {
                end
            } else {
                last_break.filter(|b| *b > start + 1).unwrap_or(end)
            };
            out.push(
                chars[start..cut]
                    .iter()
                    .collect::<String>()
                    .trim_end()
                    .to_string(),
            );
            start = cut;
            while start < chars.len() && matches!(chars[start], ' ' | '\t') {
                start += 1;
            }
        }
    }

    if out.is_empty() {
        out.push(String::new());
    }
    out
}

fn align_x(align: Align, x0: u32, content_w: u32, w: u32) -> u32 {
    let slack = content_w as i64 - w as i64;
    let x = match align {
        Align::Left => x0 as i64,
        Align::Center => x0 as i64 + slack / 2,
        Align::Right => x0 as i64 + slack,
    };
    x.max(0) as u32
}

/// 把「内容 + 纸张」排成一组绝对坐标元素。
pub fn layout(label: &LabelSpec, job: &JobSpec) -> Layout {
    let canvas_w = label.dots_w();
    let canvas_h = label.dots_h();
    let content_w = canvas_w.saturating_sub(label.margin_x.saturating_mul(2));
    let x0 = label.margin_x;

    // --- 文本块 ---
    let lines = job.wrapped_lines(content_w);
    let x_mult = job.x_mult.clamp(1, 10);
    let y_mult = job.y_mult.clamp(1, 10);
    let line_h = job.font.height() * y_mult;
    let has_text = !job.text.trim().is_empty();
    let text_h = if has_text {
        lines.len() as u32 * line_h + (lines.len() as u32).saturating_sub(1) * job.line_gap
    } else {
        0
    };

    // --- 条码块 ---
    let barcode_on = job.barcode.enabled && !job.barcode.data.trim().is_empty();
    let barcode_w = if barcode_on { job.barcode.width_dots() } else { 0 };
    let barcode_h = if barcode_on {
        job.barcode.height + job.barcode.readable_h()
    } else {
        0
    };

    // --- 二维码块 ---
    let qr_on = job.qr.enabled && !job.qr.data.trim().is_empty();
    let qr_w = if qr_on { job.qr.size_dots() } else { 0 };
    let qr_h = qr_w;

    // --- 垂直排版 ---
    let mut heights: Vec<u32> = Vec::new();
    if text_h > 0 {
        heights.push(text_h);
    }
    if barcode_h > 0 {
        heights.push(barcode_h);
    }
    if qr_h > 0 {
        heights.push(qr_h);
    }
    let total: u32 =
        heights.iter().sum::<u32>() + job.block_gap * (heights.len().saturating_sub(1)) as u32;
    let avail_h = canvas_h as i64 - label.margin_y as i64 * 2;
    let offset = match job.valign {
        VAlign::Top => 0,
        VAlign::Center => (avail_h - total as i64) / 2,
        VAlign::Bottom => avail_h - total as i64,
    }
    .max(0);
    let mut y = (label.margin_y as i64 + offset).max(0) as u32;

    // --- 生成元素 ---
    let mut elements = Vec::new();
    if text_h > 0 {
        for (i, line) in lines.iter().enumerate() {
            let w = text_dots(line, job.font, x_mult);
            elements.push(Element::Text {
                x: align_x(job.align, x0, content_w, w),
                y,
                font: job.font,
                x_mult,
                y_mult,
                text: line.clone(),
            });
            y += line_h;
            if i + 1 < lines.len() {
                y += job.line_gap;
            }
        }
        if barcode_h > 0 || qr_h > 0 {
            y += job.block_gap;
        }
    }

    if barcode_h > 0 {
        elements.push(Element::Barcode {
            x: align_x(
                job.barcode.align,
                x0,
                content_w,
                if barcode_w == 0 { content_w } else { barcode_w },
            ),
            y,
            code_type: job.barcode.symbology.tspl().to_string(),
            height: job.barcode.height,
            readable: u32::from(job.barcode.readable),
            narrow: job.barcode.narrow.clamp(1, 10),
            wide: job.barcode.wide.clamp(1, 10),
            data: job.barcode.data.trim().to_string(),
        });
        y += barcode_h;
        if qr_h > 0 {
            y += job.block_gap;
        }
    }

    if qr_h > 0 {
        elements.push(Element::Qr {
            x: align_x(job.qr.align, x0, content_w, qr_w),
            y,
            ecc: job.qr.ecc.tspl().to_string(),
            cell: job.qr.cell.clamp(1, 10),
            data: job.qr.data.trim().to_string(),
        });
    }

    Layout {
        elements,
        canvas_w,
        canvas_h,
    }
}

// ---------------------------------------------------------------------------
// 打印前体检
// ---------------------------------------------------------------------------

/// 一条体检结论：level + 错误码 + 插值参数（文案由前端按语言渲染）。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub level: &'static str,
    pub code: &'static str,
    pub params: serde_json::Value,
}

impl Issue {
    fn warn(code: &'static str, params: serde_json::Value) -> Self {
        Self {
            level: "warn",
            code,
            params,
        }
    }

    /// 构造一条 info 级提示（命令层的 printer_issue 也要用，故公开）。
    pub fn info(code: &'static str, params: serde_json::Value) -> Self {
        Self {
            level: "info",
            code,
            params,
        }
    }
}

/// 打印前提示，避免「点了打印结果打出半张废纸」。
pub fn check(label: &LabelSpec, job: &JobSpec, layout: &Layout) -> Vec<Issue> {
    let mut out = Vec::new();

    if label.width_mm > MAX_PRINTABLE_MM {
        out.push(Issue::warn(
            "paperTooWide",
            json!({
                "widthMm": format!("{:.1}", label.width_mm),
                "maxMm": format!("{:.0}", MAX_PRINTABLE_MM),
            }),
        ));
    }
    if label.width_mm < 25.0 || label.width_mm > 60.0 {
        out.push(Issue::warn("mediaRange", json!({})));
    }
    if !job.font.supports_chinese() && job.text.chars().any(|c| c as u32 > 0x7F) {
        out.push(Issue::warn("asciiFontChinese", json!({})));
    }
    if job.barcode.enabled && job.barcode.data.trim().is_empty() {
        out.push(Issue::info("barcodeEmpty", json!({})));
    }
    let content_w = layout.canvas_w.saturating_sub(label.margin_x * 2);
    if job.barcode.enabled {
        let bw = job.barcode.width_dots();
        if bw > content_w {
            out.push(Issue::warn(
                "barcodeTooWide",
                json!({ "width": bw.to_string(), "available": content_w.to_string() }),
            ));
        }
    }
    if job.qr.enabled {
        let qw = job.qr.size_dots();
        if qw > content_w {
            out.push(Issue::warn(
                "qrTooWide",
                json!({ "width": qw.to_string(), "available": content_w.to_string() }),
            ));
        }
    }

    let bottom = layout
        .elements
        .iter()
        .map(|e| match e {
            Element::Text {
                y,
                font,
                y_mult,
                ..
            } => *y + font.height() * y_mult,
            Element::Barcode {
                y,
                height,
                readable,
                ..
            } => *y + height + if *readable == 1 { 24 } else { 0 },
            Element::Qr { y, cell, .. } => *y + job.qr.modules() * cell,
        })
        .max()
        .unwrap_or(0);
    if bottom > layout.canvas_h {
        out.push(Issue::warn(
            "contentOverflow",
            json!({ "bottom": bottom.to_string(), "canvasH": layout.canvas_h.to_string() }),
        ));
    }

    out
}

// ---------------------------------------------------------------------------
// TSPL 指令生成
// ---------------------------------------------------------------------------

/// TSPL 的标准换行是 CRLF。
const EOL: &str = "\r\n";

/// 格式化毫米值：50.0 → "50"，2.5 → "2.5"。
/// 指令文本的格式化工具（命令层的测试也用它验证输出形态）。
pub fn fmt_mm(v: f32) -> String {
    if v.fract().abs() < f32::EPSILON {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

/// TSPL 字符串转义：反斜杠是转义符，双引号是结束符。
/// 指令文本的格式化工具（命令层的测试也用它验证输出形态）。
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\r' => {}
            '\n' => out.push(' '),
            _ => out.push(c),
        }
    }
    out
}

/// 生成可读的 TSPL 指令文本。
pub fn build_source(label: &LabelSpec, layout: &Layout, copies: u32) -> String {
    let mut s = String::with_capacity(512);

    // 1) 纸张尺寸与定位方式
    s.push_str(&format!(
        "SIZE {} mm,{} mm{}",
        fmt_mm(label.width_mm),
        fmt_mm(label.height_mm),
        EOL
    ));
    match label.media {
        Media::Gap => s.push_str(&format!(
            "GAP {} mm,{} mm{}",
            fmt_mm(label.gap_mm),
            fmt_mm(label.gap_offset_mm),
            EOL
        )),
        Media::BlackMark => s.push_str(&format!(
            "BLINE {} mm,0 mm{}",
            fmt_mm(label.black_mark_mm),
            EOL
        )),
        Media::Continuous => s.push_str(&format!("GAP 0 mm,0 mm{EOL}")),
    }

    // 2) 中文乱码时部分固件需要显式声明代码页
    if label.codepage_936 {
        s.push_str(&format!("CODEPAGE 936{EOL}"));
    }

    // 3) 方向与打印质量
    s.push_str(&format!("DIRECTION {}{EOL}", label.direction.min(1)));
    s.push_str(&format!("REFERENCE 0,0{EOL}"));
    s.push_str(&format!("DENSITY {}{EOL}", label.density.min(15)));
    s.push_str(&format!("SPEED {}{EOL}", label.speed.clamp(1, 6)));
    s.push_str(&format!("SET PEEL OFF{EOL}"));
    s.push_str(&format!("SET CUTTER OFF{EOL}"));
    s.push_str(&format!("SET TEAR ON{EOL}"));

    // 4) 清空图像缓冲，逐元素绘制
    s.push_str(&format!("CLS{EOL}"));
    for e in &layout.elements {
        match e {
            Element::Text {
                x,
                y,
                font,
                x_mult,
                y_mult,
                text,
            } => s.push_str(&format!(
                "TEXT {x},{y},\"{}\",0,{x_mult},{y_mult},\"{}\"{EOL}",
                font.tspl_name(),
                escape(text)
            )),
            Element::Barcode {
                x,
                y,
                code_type,
                height,
                readable,
                narrow,
                wide,
                data,
            } => s.push_str(&format!(
                "BARCODE {x},{y},\"{code_type}\",{height},{readable},0,{narrow},{wide},\"{}\"{EOL}",
                escape(data)
            )),
            Element::Qr {
                x,
                y,
                ecc,
                cell,
                data,
            } => s.push_str(&format!(
                "QRCODE {x},{y},{ecc},{cell},A,0,M2,S7,\"{}\"{EOL}",
                escape(data)
            )),
        }
    }

    // 5) 打印：1 组标签 × copies 份
    s.push_str(&format!("PRINT 1,{}{EOL}", copies.max(1)));
    s
}

/// GB18030 编码（GP-2120TF 的简体中文字符集，兼容 GBK 双字节）。
pub fn encode_gb18030(s: &str) -> Vec<u8> {
    let (bytes, _, _) = encoding_rs::GB18030.encode(s);
    bytes.into_owned()
}

/// 生成最终发送给打印机的字节流。
pub fn build_bytes(label: &LabelSpec, job: &JobSpec) -> Vec<u8> {
    let l = layout(label, job);
    encode_gb18030(&build_source(label, &l, job.copies))
}

// ---------------------------------------------------------------------------
// IPC 命令层
// ---------------------------------------------------------------------------

/// 前后端共享的全部设置（也是落盘配置的结构）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// 打印机队列名
    pub printer: String,
    pub label: LabelSpec,
    pub job: JobSpec,
}

/// 一个绘制元素。坐标与尺寸单位统一是「打印点」（203dpi 下 1mm = 8 点）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DrawItem {
    #[serde(rename_all = "camelCase")]
    Text {
        x: u32,
        y: u32,
        /// 字高（点）
        size: u32,
        /// 点阵字体下的估算宽度（点），前端据此做横向校准
        width: u32,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Barcode {
        x: u32,
        y: u32,
        height: u32,
        /// 窄条宽度（点）
        narrow: u32,
        /// 条码总宽（点）
        width: u32,
        /// 每个模块 0/1，1 为黑条
        modules: Vec<u8>,
        /// 可读文本，未开启时为空串
        label: String,
        label_size: u32,
    },
    #[serde(rename_all = "camelCase")]
    Qr {
        x: u32,
        y: u32,
        /// 模块边长（点）
        cell: u32,
        /// 每边模块数
        size: u32,
        bits: Vec<bool>,
    },
}

/// `label_layout` 命令的返回值：预览绘制模型 + 指令文本 + 体检结论。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Render {
    pub canvas_w: u32,
    pub canvas_h: u32,
    pub items: Vec<DrawItem>,
    /// 可读的 TSPL 指令文本
    pub source: String,
    pub issues: Vec<Issue>,
    /// GB18030 编码后的字节数
    pub bytes: usize,
    /// 条码内容能否本地编码（false 时预览画占位框）
    pub barcode_ok: bool,
    pub qr_ok: bool,
    /// 标签之间的间隙（打印点）。只有间隙纸才有，其余为 0
    pub gap_dots: u32,
    /// 当前选中的打印机看起来是不是标签打印机
    pub printer_ok: bool,
}


/// 打印回执（文案由前端按语言渲染）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintReceipt {
    pub printer: String,
    pub bytes: usize,
    pub elapsed_ms: u64,
    pub copies: u32,
}

/// 生成排版结果、预览绘制模型、TSPL 指令文本与体检提示（**纯计算，两端共用**）。
///
/// 桌面端经 `label_layout` 命令调用它，手机端经 wasm 的 `layout_json` 调用同一个函数——
/// 「所见即所打」的实现方式就是同一份代码，而不是两端各写一份看起来一样的。
pub fn build_render_payload(settings: &Settings) -> Render {
    build_render(settings)
}

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

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试助手：排版 + 生成 TSPL 指令文本（多条用例共用）。
    fn render(label: &LabelSpec, job: &JobSpec) -> String {
        let l = layout(label, job);
        let source = build_source(label, &l, job.copies);
        source
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

}
