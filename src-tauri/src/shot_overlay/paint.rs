//! 原生遮罩的绘制层：GDI 做位图搬移（冻结帧/暗化/马赛克），GDI+ 做矢量与文字（抗锯齿）。
//!
//! 性能要点：冻结帧、暗化版、当前画面三张 32bpp DIB 常驻，每帧只做 1~2 次全屏 BitBlt
//! + 少量矢量绘制——几毫秒级，跟手性由它保证。

use std::sync::Once;

use windows_sys::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, COLORONCOLOR, DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, SRCCOPY,
};
use windows_sys::Win32::Graphics::GdiPlus::{
    GdipCreateFont, GdipCreateFontFamilyFromName, GdipCreateFromHDC, GdipCreatePen1, GdipCreateSolidFill, GdipCreateStringFormat,
    GdipDeleteBrush, GdipDeleteFont, GdipDeleteFontFamily, GdipDeleteGraphics, GdipDeletePen, GdipDeleteStringFormat, GdipDrawEllipseI,
    GdipDrawLineI, GdipDrawLinesI, GdipDrawRectangleI, GdipDrawString, GdipFillEllipseI, GdipFillPolygonI, GdipFillRectangleI,
    GdipSetPageUnit, GdipSetSmoothingMode, GdipSetStringFormatFlags, GdipSetTextRenderingHint,
    GdiplusStartup, FillModeAlternate, GpBrush, GpFont, GpFontFamily, GpGraphics, GpPen, GpStringFormat, Point, RectF,
    SmoothingModeAntiAlias, StringFormatFlagsNoWrap, TextRenderingHintAntiAliasGridFit, UnitPixel, GdiplusStartupInput,
};


use super::state::{magnifier_rect, Op, Rect, Tool, TEXT_SIZES};

// ---------------- GDI+ 生命周期 ----------------

static GDIPLUS: Once = Once::new();
static mut GDIPLUS_TOKEN: usize = 0;

/// 进程内启动一次 GDI+（不关闭：进程退出时由系统回收；中途 Shutdown 会作废已创建的 Gp* 对象）
pub fn ensure_gdiplus() {
    GDIPLUS.call_once(|| unsafe {
        let mut input: GdiplusStartupInput = std::mem::zeroed();
        input.GdiplusVersion = 1;
        let mut token: usize = 0;
        let _ = GdiplusStartup(&mut token, &input, std::ptr::null_mut());
        GDIPLUS_TOKEN = token;
    });
}

// ---------------- DIB（32bpp 顶朝下，1:1 物理像素） ----------------

pub struct Dib {
    pub hdc: HDC,
    hbm: HBITMAP,
    old: HGDIOBJ,
    pub w: i32,
    pub h: i32,
    pub bits: *mut u32,
}

impl Dib {
    pub fn new(w: i32, h: i32) -> Self {
        unsafe {
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: w,
                    biHeight: -h, // 顶朝下
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB,
                    ..std::mem::zeroed()
                },
                ..std::mem::zeroed()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let hbm = CreateDIBSection(std::ptr::null_mut(), &info, DIB_RGB_COLORS, &mut bits, std::ptr::null_mut(), 0);
            let hdc = CreateCompatibleDC(std::ptr::null_mut());
            let old = SelectObject(hdc, hbm as HGDIOBJ);
            Self { hdc, hbm, old, w, h, bits: bits as *mut u32 }
        }
    }

    /// 从 RGBA 字节建 DIB（每行 dst 宽度 = w*4）
    pub fn from_rgba(rgba: &[u8], w: i32, h: i32) -> Self {
        let dib = Self::new(w, h);
        unsafe {
            std::ptr::copy_nonoverlapping(rgba.as_ptr(), dib.bits as *mut u8, (w as usize) * (h as usize) * 4);
        }
        dib
    }

    /// 把源 RGBA 压暗一份写进自己（暗化预计算：每帧省掉逐像素混合）
    pub fn fill_dim_from_rgba(&mut self, rgba: &[u8], keep: f32) {
        unsafe {
            let n = (self.w as usize) * (self.h as usize);
            let dst = self.bits;
            for i in 0..n {
                let r = (rgba[i * 4] as f32 * keep) as u32;
                let g = (rgba[i * 4 + 1] as f32 * keep) as u32;
                let b = (rgba[i * 4 + 2] as f32 * keep) as u32;
                let a = rgba[i * 4 + 3] as u32;
                *dst.add(i) = (a << 24) | (r << 16) | (g << 8) | b;
            }
        }
    }

    pub fn rgba(&self) -> Vec<u8> {
        unsafe {
            let n = (self.w as usize) * (self.h as usize) * 4;
            let mut out = vec![0u8; n];
            std::ptr::copy_nonoverlapping(self.bits as *const u8, out.as_mut_ptr(), n);
            out
        }
    }

    /// 把 src 的 (sx, sy, sw, sh) 拷到自己 (dx, dy)
    pub fn blit_from(&self, src: &Dib, sx: i32, sy: i32, sw: i32, sh: i32, dx: i32, dy: i32) {
        unsafe {
            BitBlt(self.hdc, dx, dy, sw, sh, src.hdc, sx, sy, SRCCOPY);
        }
    }

    /// 放大绘制（最近邻：放大镜要看清像素）
    pub fn stretch_from(&self, src: &Dib, sx: i32, sy: i32, sw: i32, sh: i32, d: Rect) {
        unsafe {
            SetStretchBltMode(self.hdc, COLORONCOLOR);
            StretchBlt(self.hdc, d.x, d.y, d.w, d.h, src.hdc, sx, sy, sw, sh, SRCCOPY);
        }
    }

    /// 把一块区域画成马赛克：**取样矩形与落笔矩形分开**（导出时源帧是整屏、
    /// 目标是裁剪图，两者坐标差一个选区原点——合成一个参数会把取样取歪）。
    pub fn mosaic(&mut self, src_bits: *const u32, src_w: i32, src_h: i32, src_rect: Rect, dst_rect: Rect) {
        const BLOCK: i32 = 8;
        unsafe {
            let x0 = dst_rect.x.max(0);
            let y0 = dst_rect.y.max(0);
            let x1 = dst_rect.right().min(self.w);
            let y1 = dst_rect.bottom().min(self.h);
            let mut by = y0;
            while by < y1 {
                let mut bx = x0;
                while bx < x1 {
                    // 取样点 = 落笔点平移到源帧坐标（同一块左上角像素）
                    let sxi = (bx - dst_rect.x + src_rect.x).clamp(0, src_w - 1);
                    let syi = (by - dst_rect.y + src_rect.y).clamp(0, src_h - 1);
                    let c = *src_bits.add((syi * src_w + sxi) as usize);
                    let xe = (bx + BLOCK).min(x1);
                    let ye = (by + BLOCK).min(y1);
                    for yy in by..ye {
                        let row = self.bits.add((yy * self.w) as usize);
                        for xx in bx..xe {
                            *row.add(xx as usize) = c;
                        }
                    }
                    bx += BLOCK;
                }
                by += BLOCK;
            }
        }
    }
}

impl Drop for Dib {
    fn drop(&mut self) {
        unsafe {
            SelectObject(self.hdc, self.old);
            DeleteObject(self.hbm as HGDIOBJ);
            DeleteDC(self.hdc);
        }
    }
}

// ---------------- GDI+ 小工具 ----------------

pub struct Gp {
    pub g: *mut GpGraphics,
}

impl Gp {
    pub unsafe fn from_hdc(hdc: HDC) -> Self {
        ensure_gdiplus();
        let mut g: *mut GpGraphics = std::ptr::null_mut();
        GdipCreateFromHDC(hdc, &mut g);
        GdipSetPageUnit(g, UnitPixel as i32);
        GdipSetSmoothingMode(g, SmoothingModeAntiAlias as i32);
        GdipSetTextRenderingHint(g, TextRenderingHintAntiAliasGridFit as i32);
        Self { g }
    }

    unsafe fn pen(&self, rgb: u32, width: i32, alpha: u32) -> *mut GpPen {
        let mut p: *mut GpPen = std::ptr::null_mut();
        GdipCreatePen1((alpha << 24) | (rgb & 0x00FF_FFFF), width as f32, UnitPixel as i32, &mut p);
        p
    }

    unsafe fn brush(&self, rgb: u32, alpha: u32) -> *mut GpBrush {
        // GDI+ 的实心刷具体类型是 GpSolidFill，基类接口按 GpBrush 传参
        let mut b: *mut windows_sys::Win32::Graphics::GdiPlus::GpSolidFill = std::ptr::null_mut();
        GdipCreateSolidFill((alpha << 24) | (rgb & 0x00FF_FFFF), &mut b);
        b as *mut GpBrush
    }

    pub unsafe fn stroke_rect(&self, r: Rect, rgb: u32, width: i32, alpha: u32) {
        let p = self.pen(rgb, width, alpha);
        GdipDrawRectangleI(self.g, p, r.x, r.y, r.w, r.h);
        GdipDeletePen(p);
    }

    pub unsafe fn fill_rect(&self, r: Rect, rgb: u32, alpha: u32) {
        let b = self.brush(rgb, alpha);
        GdipFillRectangleI(self.g, b, r.x, r.y, r.w, r.h);
        GdipDeleteBrush(b);
    }

    pub unsafe fn stroke_ellipse(&self, r: Rect, rgb: u32, width: i32, alpha: u32) {
        let p = self.pen(rgb, width, alpha);
        GdipDrawEllipseI(self.g, p, r.x, r.y, r.w, r.h);
        GdipDeletePen(p);
    }

    pub unsafe fn fill_ellipse(&self, r: Rect, rgb: u32, alpha: u32) {
        let b = self.brush(rgb, alpha);
        GdipFillEllipseI(self.g, b, r.x, r.y, r.w, r.h);
        GdipDeleteBrush(b);
    }

    pub unsafe fn line(&self, a: (i32, i32), b: (i32, i32), rgb: u32, width: i32, alpha: u32) {
        let p = self.pen(rgb, width, alpha);
        GdipDrawLineI(self.g, p, a.0, a.1, b.0, b.1);
        GdipDeletePen(p);
    }

    pub unsafe fn polyline(&self, pts: &[Point], rgb: u32, width: i32, alpha: u32) {
        if pts.len() < 2 {
            return;
        }
        let p = self.pen(rgb, width, alpha);
        GdipDrawLinesI(self.g, p, pts.as_ptr(), pts.len() as i32);
        GdipDeletePen(p);
    }

    pub unsafe fn fill_polygon(&self, pts: &[Point], rgb: u32, alpha: u32) {
        let b = self.brush(rgb, alpha);
        GdipFillPolygonI(self.g, b, pts.as_ptr(), pts.len() as i32, FillModeAlternate as i32);
        GdipDeleteBrush(b);
    }

    /// 画一段文字；返回实际渲染宽度（用于气泡宽度自适应）
    pub unsafe fn text(&self, text: &str, at: (i32, i32), size: f32, rgb: u32, alpha: u32, family: &str) -> i32 {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let fam_wide: Vec<u16> = family.encode_utf16().chain(std::iter::once(0)).collect();
        let mut fam: *mut GpFontFamily = std::ptr::null_mut();
        GdipCreateFontFamilyFromName(fam_wide.as_ptr(), std::ptr::null_mut(), &mut fam);
        if fam.is_null() {
            return 0;
        }
        let mut font: *mut GpFont = std::ptr::null_mut();
        GdipCreateFont(fam, size, 0, UnitPixel as i32, &mut font);
        let mut fmt: *mut GpStringFormat = std::ptr::null_mut();
        GdipCreateStringFormat(0, 0, &mut fmt);
        GdipSetStringFormatFlags(fmt, StringFormatFlagsNoWrap as i32);
        let layout = RectF { X: at.0 as f32, Y: at.1 as f32, Width: (self.width() as f32), Height: (size * 1.8) };
        let brush = self.brush(rgb, alpha);
        GdipDrawString(self.g, wide.as_ptr(), -1, font, &layout, fmt, brush);
        GdipDeleteBrush(brush);
        GdipDeleteStringFormat(fmt);
        GdipDeleteFont(font);
        GdipDeleteFontFamily(fam);
        // 粗略宽度（CJK 按全宽、ASCII 按半宽）——只用于气泡自适应，不必精确
        text.chars().map(|c| if (c as u32) > 0x2E80 { size } else { size * 0.55 }).sum::<f32>() as i32
    }

    fn width(&self) -> i32 {
        // GDI+ 的布局矩形给足宽度即可（NoWrap 下不会换行）
        100_000
    }

}

impl Drop for Gp {
    fn drop(&mut self) {
        unsafe {
            GdipDeleteGraphics(self.g);
        }
    }
}

// ---------------- 画标注 op ----------------

/// 把一条 op 画到当前 Graphics 上；target 用于马赛克写像素，frame/源位图用于取样
pub unsafe fn draw_op(g: &Gp, op: &Op, target: &mut Dib, frame: &Dib, off: (i32, i32), font_family: &str) {
    let dx = |p: (i32, i32)| (p.0 + off.0, p.1 + off.1);
    match op {
        Op::Rect { rect, color, width } => {
            let r = Rect::new(rect.x + off.0, rect.y + off.1, rect.w, rect.h);
            g.stroke_rect(r, *color, *width, 255);
        }
        Op::Ellipse { rect, color, width } => {
            let r = Rect::new(rect.x + off.0, rect.y + off.1, rect.w, rect.h);
            g.stroke_ellipse(r, *color, *width, 255);
        }
        Op::Arrow { from, to, color, width } => {
            let (a, b) = (dx(*from), dx(*to));
            g.line(a, b, *color, *width, 255);
            let angle = ((b.1 - a.1) as f32).atan2((b.0 - a.0) as f32);
            let head = (*width as f32 * 3.5).max(10.0);
            let p1 = (b.0 - (head * (angle - std::f32::consts::PI / 7.0).cos()) as i32, b.1 - (head * (angle - std::f32::consts::PI / 7.0).sin()) as i32);
            let p2 = (b.0 - (head * (angle + std::f32::consts::PI / 7.0).cos()) as i32, b.1 - (head * (angle + std::f32::consts::PI / 7.0).sin()) as i32);
            let pts = [Point { X: b.0, Y: b.1 }, Point { X: p1.0, Y: p1.1 }, Point { X: p2.0, Y: p2.1 }];
            g.fill_polygon(&pts, *color, 255);
        }
        Op::Stroke { points, color, width, marker } => {
            let alpha = if *marker { 90 } else { 255 };
            let pts: Vec<Point> = points.iter().map(|p| Point { X: p.0 + off.0, Y: p.1 + off.1 }).collect();
            if pts.len() == 1 {
                let r = Rect::new(pts[0].X - width / 2, pts[0].Y - width / 2, *width, *width);
                g.fill_ellipse(r, *color, alpha);
            } else {
                g.polyline(&pts, *color, *width, alpha);
            }
        }
        Op::Text { at, size, text, color } => {
            g.text(text, (at.0 + off.0, at.1 + off.1), *size as f32, *color, 255, font_family);
        }
        Op::Mosaic { rect } => {
            let dst = Rect::new(rect.x + off.0, rect.y + off.1, rect.w, rect.h);
            // 源矩形始终是「op 在整屏坐标里的原位」，落笔矩形才带偏移
            target.mosaic(frame.bits as *const u32, frame.w, frame.h, *rect, dst);
        }
    }
}

// ---------------- 遮罩窗口的一帧 ----------------

/// 一次会话里一个遮罩窗要画的所有东西（都由 mod.rs 准备好）
/// 工具栏文案（i18n 在 mod.rs 侧解析一次）
pub struct Labels<'a> {
    pub copy: &'a str,
    pub save: &'a str,
    pub pin: &'a str,
    pub tools: &'a [String],
}

pub struct Scene<'a> {
    pub frame: &'a Dib,
    pub dim: &'a Dib,
    pub ops: &'a [Op],
    pub can_undo: bool,
    pub can_redo: bool,
    pub draft: Option<&'a Op>,
    pub selection: Option<Rect>,
    pub labels: Labels<'a>,
    pub size_label: String,
    pub toolbar: Option<&'a super::state::ToolbarLayout>,
    pub active_tool: Option<Tool>,
    pub color: u32,
    pub width_idx: usize,
    pub hint: &'a str,
    pub magnifier: Option<(i32, i32, u32, (i32, i32))>, // 光标、像素色、像素坐标
    pub text_cursor: Option<(i32, i32, u32)>,           // 文本输入框位置与颜色
}

const BLUE: u32 = 0x4c9aff;
const BLUE_DARK: u32 = 0x2b6ad0;

pub unsafe fn paint(canvas: &mut Dib, scene: &Scene, font_family: &str) {
    // 1) 暗化底 + 选区回亮（两次全屏/局部 BitBlt）
    canvas.blit_from(scene.dim, 0, 0, canvas.w, canvas.h, 0, 0);
    if let Some(sel) = scene.selection {
        canvas.blit_from(scene.frame, sel.x, sel.y, sel.w, sel.h, sel.x, sel.y);
    }
    // 2) 标注（裁剪在选区内）+ 草稿
    let g = Gp::from_hdc(canvas.hdc);
    if scene.selection.is_some() && !scene.ops.is_empty() {
        // GDI+ 没有直接的裁剪栈：用 SetClip? 简化处理——标注本来就钳在选区内，
        // 越界部分由「画完后把选区外重刷一遍」兜住
        for op in scene.ops {
            draw_op(&g, op, canvas, scene.frame, (0, 0), font_family);
        }
    }
    if let Some(op) = scene.draft {
        draw_op(&g, op, canvas, scene.frame, (0, 0), font_family);
    }
    if let Some(sel) = scene.selection {
        // 标注越界兜底：把选区外重刷成暗化版
        let full = Rect::new(0, 0, canvas.w, canvas.h);
        let strips = [
            Rect::new(full.x, full.y, full.w, sel.y),
            Rect::new(full.x, sel.bottom(), full.w, full.h - sel.bottom()),
            Rect::new(full.x, sel.y, sel.x, sel.h),
            Rect::new(sel.right(), sel.y, full.w - sel.right(), sel.h),
        ];
        for strip in strips {
            if strip.w > 0 && strip.h > 0 {
                canvas.blit_from(scene.dim, strip.x, strip.y, strip.w, strip.h, strip.x, strip.y);
            }
        }
        // 3) 选区边框 + 手柄
        g.stroke_rect(Rect::new(sel.x, sel.y, sel.w - 1, sel.h - 1), BLUE, 1, 255);
        for h in super::state::HANDLES {
            let p = handle_point(sel, h);
            g.fill_rect(Rect::new(p.0 - 3, p.1 - 3, 7, 7), 0xffffff, 255);
            g.stroke_rect(Rect::new(p.0 - 3, p.1 - 3, 7, 7), BLUE_DARK, 1, 255);
        }
        // 4) 尺寸标签
        if !scene.size_label.is_empty() {
            let w = scene.size_label.chars().count() as i32 * 8 + 18;
            let lx = sel.right() - w;
            let ly = if sel.bottom() + 30 < canvas.h { sel.bottom() + 4 } else { (sel.y - 30).max(4) };
            g.fill_rect(Rect::new(lx, ly, w, 22), 0x161b22, 242);
            g.text(&scene.size_label, (lx + 9, ly + 4), 13.0, 0xe6edf3, 255, font_family);
        }
    }
    // 5) 工具栏
    if let Some(layout) = scene.toolbar {
        g.fill_rect(layout.bar, 0x161b22, 246);
        g.stroke_rect(layout.bar, 0x30363d, 1, 255);
        for (item, r) in &layout.items {
            paint_toolbar_item(&g, scene, item, *r, font_family);
        }
    }
    // 6) 放大镜
    if let Some((mx, my, color, (px, py))) = scene.magnifier {
        let m = magnifier_rect((mx, my), (canvas.w, canvas.h));
        let zoom = 6;
        let src = ((m.w / zoom) as f32 * 0.5) as i32;
        canvas.stretch_from(scene.frame, px - src, py - src, src * 2, src * 2, Rect::new(m.x, m.y, m.w, m.w));
        // 十字线
        g.line((m.x + m.w / 2, m.y), (m.x + m.w / 2, m.y + m.w), BLUE, 1, 200);
        g.line((m.x, m.y + m.w / 2), (m.x + m.w, m.y + m.w / 2), BLUE, 1, 200);
        g.fill_rect(Rect::new(m.x, m.y + m.w, m.w, m.h - m.w), 0x161b22, 242);
        g.fill_rect(Rect::new(m.x + 5, m.y + m.w + 7, 11, 11), color, 255);
        g.stroke_rect(Rect::new(m.x + 5, m.y + m.w + 7, 11, 11), 0x8b949e, 1, 255);
        let hex = format!("#{color:06x}");
        g.text(&hex, (m.x + 21, m.y + m.w + 5), 12.0, 0xc9d1d9, 255, font_family);
        let pos = format!("{px}, {py}");
        g.text(&pos, (m.x + 70, m.y + m.w + 5), 12.0, 0x8b949e, 255, font_family);
    }
    // 7) 文本输入框位置提示（真实输入由原生 EDIT 控件承载）
    if let Some((tx, ty, color)) = scene.text_cursor {
        g.stroke_rect(Rect::new(tx - 2, ty - 2, 3, TEXT_SIZES[0] + 4), color, 1, 200);
    }
    // 8) 底部快捷键提示
    if !scene.hint.is_empty() {
        g.fill_rect(Rect::new(12, canvas.h - 30, scene.hint.chars().count() as i32 * 8 + 20, 24), 0x161b22, 216);
        g.text(scene.hint, (22, canvas.h - 26), 12.5, 0x8b949e, 255, font_family);
    }
}

fn handle_point(sel: Rect, h: &str) -> (i32, i32) {
    let x = if h.contains('w') { sel.x } else if h.contains('e') { sel.right() } else { sel.x + sel.w / 2 };
    let y = if h.contains('n') { sel.y } else if h.contains('s') { sel.bottom() } else { sel.y + sel.h / 2 };
    (x, y)
}

unsafe fn paint_toolbar_item(g: &Gp, scene: &Scene, item: &super::state::ToolbarItem, r: Rect, family: &str) {
    use super::state::ToolbarItem as T;
    let hovered = false; // 原生版先不做 hover 高亮（后续可加）
    match item {
        T::Tool(t) => {
            let active = scene.active_tool == Some(*t);
            if active {
                g.fill_rect(r, 0x1a3352, 255);
                g.stroke_rect(r, BLUE_DARK, 1, 255);
            }
            let label = scene.labels.tools.get(tool_index(*t)).map(|s| s.as_str()).unwrap_or("");
            g.text(label, (r.x + 5, r.y + 7), 12.5, if active { 0x79c0ff } else { 0xc9d1d9 }, 255, family);
            let _ = hovered;
        }
        T::Color(c) => {
            let on = scene.color == *c;
            let inner = r.inset(3);
            g.fill_rect(Rect::new(inner.x - 1, inner.y - 1, inner.w + 2, inner.h + 2), if on { BLUE } else { 0x30363d }, 255);
            g.fill_rect(inner, *c, 255);
        }
        T::Width(i) => {
            let on = scene.width_idx == *i;
            if on {
                g.fill_rect(r, 0x1a3352, 255);
            }
            let d = 4 + (*i as i32) * 4;
            let c = (r.x + r.w / 2, r.y + r.h / 2);
            g.fill_ellipse(Rect::new(c.0 - d / 2, c.1 - d / 2, d, d), if on { 0x79c0ff } else { 0xc9d1d9 }, 255);
        }
        T::Undo => {
            let lit = scene.can_undo;
            g.text("↶", (r.x + 8, r.y + 6), 15.0, if lit { 0xc9d1d9 } else { 0x555c66 }, 255, family);
        }
        T::Redo => {
            let lit = scene.can_redo;
            g.text("↷", (r.x + 8, r.y + 6), 15.0, if lit { 0xc9d1d9 } else { 0x555c66 }, 255, family);
        }
        T::Copy | T::Save | T::Pin | T::Cancel => {
            let (label, fg) = match item {
                T::Copy => (scene.labels.copy, 0xffffff),
                T::Save => (scene.labels.save, 0xc9d1d9),
                T::Pin => (scene.labels.pin, 0xc9d1d9),
                _ => ("✕", 0xc9d1d9),
            };
            if matches!(item, T::Copy) {
                g.fill_rect(r, 0x2b6ad0, 255);
            }
            g.text(label, (r.x + 9, r.y + 7), 12.5, fg, 255, family);
        }
    }
}

fn tool_index(t: Tool) -> usize {
    match t {
        Tool::Rect => 0,
        Tool::Ellipse => 1,
        Tool::Arrow => 2,
        Tool::Pen => 3,
        Tool::Marker => 4,
        Tool::Text => 5,
        Tool::Mosaic => 6,
    }
}

/// 导出：裁切选区 + 重放标注，返回 RGBA 与尺寸（原生版没有 IPC/编码往返，
/// 需要 PNG 时再编码——复制走剪贴板只需要 RGBA）
pub unsafe fn render_output(frame: &Dib, ops: &[Op], sel: Rect) -> (Vec<u8>, i32, i32) {
    let w = sel.w.max(1);
    let h = sel.h.max(1);
    let mut out = Dib::new(w, h);
    out.blit_from(frame, sel.x, sel.y, w, h, 0, 0);
    let g = Gp::from_hdc(out.hdc);
    for op in ops {
        draw_op(&g, op, &mut out, frame, (-sel.x, -sel.y), "Microsoft YaHei");
    }
    drop(g);
    (out.rgba(), w, h)
}
