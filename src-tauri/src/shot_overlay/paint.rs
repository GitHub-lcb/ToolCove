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
    GdipAddPathArcI, GdipClosePathFigure, GdipCreatePath, GdipDeletePath, GdipDrawPath, GdipFillPath,
    GdipCreateFont, GdipCreateFontFamilyFromName, GdipCreateFromHDC, GdipCreatePen1, GdipCreateSolidFill, GdipCreateStringFormat,
    GdipDeleteBrush, GdipDeleteFont, GdipDeleteFontFamily, GdipDeleteGraphics, GdipDeletePen, GdipDeleteStringFormat, GdipDrawEllipseI,
    GdipDrawLineI, GdipDrawLinesI, GdipDrawRectangleI, GdipDrawString, GdipFillEllipseI, GdipFillPolygonI, GdipFillRectangleI,
    GdipSetPageUnit, GdipSetSmoothingMode, GdipSetStringFormatAlign, GdipSetStringFormatFlags, GdipSetStringFormatLineAlign,
    GdipSetTextRenderingHint, GdiplusStartup, FillModeAlternate, GpBrush, GpFont, GpFontFamily, GpGraphics, GpPath, GpPen,
    GpStringFormat, Point, RectF, SmoothingModeAntiAlias, StringAlignmentCenter, StringFormatFlagsNoClip, StringFormatFlagsNoWrap,
    TextRenderingHintAntiAliasGridFit, UnitPixel, GdiplusStartupInput,
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

    /// 从 RGBA 字节建 DIB。注意 DIB 内存是 BGRA（GDI 的 32bpp BI_RGB），
    /// 逐像素换 R/B 后再写，否则屏幕上显示的画面会 R/B 互换（偏色）。
    pub fn from_rgba(rgba: &[u8], w: i32, h: i32) -> Self {
        let dib = Self::new(w, h);
        unsafe {
            let n = (w as usize) * (h as usize);
            let dst = dib.bits as *mut u8;
            for i in 0..n {
                *dst.add(i * 4) = rgba[i * 4 + 2];
                *dst.add(i * 4 + 1) = rgba[i * 4 + 1];
                *dst.add(i * 4 + 2) = rgba[i * 4];
                *dst.add(i * 4 + 3) = rgba[i * 4 + 3];
            }
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

    /// 返回真正的 RGBA 字节供导出（DIB 内存是 BGRA，返回前换回 R/B）
    pub fn rgba(&self) -> Vec<u8> {
        unsafe {
            let n = (self.w as usize) * (self.h as usize);
            let mut out = vec![0u8; n * 4];
            let src = self.bits as *const u8;
            for i in 0..n {
                out[i * 4] = *src.add(i * 4 + 2);
                out[i * 4 + 1] = *src.add(i * 4 + 1);
                out[i * 4 + 2] = *src.add(i * 4);
                out[i * 4 + 3] = *src.add(i * 4 + 3);
            }
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

    /// 在给定矩形内水平 + 垂直居中画一段文字（按钮标签用；靠 GDI+ 自己算排版，不手调偏移）
    pub unsafe fn text_centered(&self, text: &str, r: Rect, size: f32, rgb: u32, alpha: u32, family: &str) {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        let fam_wide: Vec<u16> = family.encode_utf16().chain(std::iter::once(0)).collect();
        let mut fam: *mut GpFontFamily = std::ptr::null_mut();
        GdipCreateFontFamilyFromName(fam_wide.as_ptr(), std::ptr::null_mut(), &mut fam);
        if fam.is_null() {
            return;
        }
        let mut font: *mut GpFont = std::ptr::null_mut();
        GdipCreateFont(fam, size, 0, UnitPixel as i32, &mut font);
        let mut fmt: *mut GpStringFormat = std::ptr::null_mut();
        GdipCreateStringFormat(0, 0, &mut fmt);
        GdipSetStringFormatFlags(fmt, (StringFormatFlagsNoWrap | StringFormatFlagsNoClip) as i32);
        GdipSetStringFormatAlign(fmt, StringAlignmentCenter);
        GdipSetStringFormatLineAlign(fmt, StringAlignmentCenter);
        let layout = RectF { X: r.x as f32, Y: r.y as f32, Width: r.w as f32, Height: r.h as f32 };
        let brush = self.brush(rgb, alpha);
        GdipDrawString(self.g, wide.as_ptr(), -1, font, &layout, fmt, brush);
        GdipDeleteBrush(brush);
        GdipDeleteStringFormat(fmt);
        GdipDeleteFont(font);
        GdipDeleteFontFamily(fam);
    }

    /// 圆角矩形路径（四角圆弧 + 四边直线）
    unsafe fn round_path(&self, r: Rect, radius: i32) -> *mut GpPath {
        let rad = radius.max(0).min(r.w / 2).min(r.h / 2);
        let d = rad * 2;
        let mut path: *mut GpPath = std::ptr::null_mut();
        GdipCreatePath(FillModeAlternate as i32, &mut path);
        GdipAddPathArcI(path, r.x, r.y, d, d, 180.0, 90.0);
        GdipAddPathArcI(path, r.right() - d, r.y, d, d, 270.0, 90.0);
        GdipAddPathArcI(path, r.right() - d, r.bottom() - d, d, d, 0.0, 90.0);
        GdipAddPathArcI(path, r.x, r.bottom() - d, d, d, 90.0, 90.0);
        GdipClosePathFigure(path);
        path
    }

    pub unsafe fn fill_round(&self, r: Rect, radius: i32, rgb: u32, alpha: u32) {
        let path = self.round_path(r, radius);
        let b = self.brush(rgb, alpha);
        GdipFillPath(self.g, b, path);
        GdipDeleteBrush(b);
        GdipDeletePath(path);
    }

    pub unsafe fn stroke_round(&self, r: Rect, radius: i32, rgb: u32, width: i32, alpha: u32) {
        let path = self.round_path(r, radius);
        let p = self.pen(rgb, width, alpha);
        GdipDrawPath(self.g, p, path);
        GdipDeletePen(p);
        GdipDeletePath(path);
    }

    /// 悬浮阴影：两层低透明黑、向下偏移（比真阴影便宜一档，观感够用）
    unsafe fn drop_shadow(&self, r: Rect, radius: i32) {
        self.fill_round(Rect::new(r.x - 2, r.y + 2, r.w + 4, r.h + 4), radius + 2, 0x000000, 42);
        self.fill_round(Rect::new(r.x - 1, r.y + 4, r.w + 2, r.h + 4), radius + 1, 0x000000, 26);
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
    pub hover: Option<super::state::ToolbarItem>,
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
        // 4) 尺寸标签：贴在选区内右下角，避免与选区外的工具栏/放大镜抢位
        if !scene.size_label.is_empty() {
            let w = scene.size_label.chars().count() as i32 * 8 + 18;
            const INSET: i32 = 8;
            if sel.w >= w + INSET * 2 && sel.h >= 24 + INSET * 2 {
                let lx = sel.right() - w - INSET;
                let ly = sel.bottom() - 24 - INSET;
                g.fill_round(Rect::new(lx, ly, w, 24), 7, 0x161b22, 242);
                g.stroke_round(Rect::new(lx, ly, w, 24), 7, 0x30363d, 1, 220);
                g.text(&scene.size_label, (lx + 10, ly + 4), 13.0, 0xe6edf3, 255, font_family);
            }
        }
    }
    // 5) 工具栏：圆角 + 悬浮阴影 + 半透明深底（压在画面上也读得清）
    if let Some(layout) = scene.toolbar {
        g.drop_shadow(layout.bar, 12);
        g.fill_round(layout.bar, 12, 0x161b22, 246);
        g.stroke_round(layout.bar, 12, 0x30363d, 1, 255);
        for (i, (item, r)) in layout.items.iter().enumerate() {
            // 分组之间的细竖线（布局留的 SEP 空档里居中）
            if i > 0 && super::state::is_sep_before(item, &layout.items[i - 1].0) {
                g.line((r.x - 6, layout.bar.y + 9), (r.x - 6, layout.bar.y + layout.bar.h - 9), 0x30363d, 1, 255);
            }
            paint_toolbar_item(&g, scene, item, *r, font_family);
        }
    }
    // 5.5) 悬停工具名气泡：图标按钮的可读性兜底（顺带把 i18n 工具名用上）
    if let Some(layout) = scene.toolbar {
        if let Some(super::state::ToolbarItem::Tool(t)) = scene.hover {
            if let Some((_, r)) = layout.items.iter().find(|(it, _)| *it == super::state::ToolbarItem::Tool(t)) {
                let name = scene.labels.tools.get(tool_index(t)).map(|s| s.as_str()).unwrap_or("");
                if !name.is_empty() {
                    let w = name.chars().map(|c| if (c as u32) > 0x2E80 { 13.5 } else { 7.5 }).sum::<f32>() as i32 + 20;
                    let tx = (r.x + r.w / 2 - w / 2).clamp(6, (canvas.w - w - 6).max(6));
                    let ty = (layout.bar.y - 32).max(6);
                    g.fill_round(Rect::new(tx, ty, w, 24), 7, 0x161b22, 240);
                    g.stroke_round(Rect::new(tx, ty, w, 24), 7, 0x30363d, 1, 220);
                    g.text(name, (tx + 10, ty + 4), 12.5, 0xe6edf3, 255, font_family);
                }
            }
        }
    }
    // 6) 放大镜（与工具栏相交时自动让位）
    if let Some((mx, my, color, (px, py))) = scene.magnifier {
        let m = magnifier_rect((mx, my), (canvas.w, canvas.h), scene.toolbar.map(|l| l.bar));
        let zoom = 6;
        let src = ((m.w / zoom) as f32 * 0.5) as i32;
        canvas.stretch_from(scene.frame, px - src, py - src, src * 2, src * 2, Rect::new(m.x, m.y, m.w, m.w));
        // 十字线
        g.line((m.x + m.w / 2, m.y), (m.x + m.w / 2, m.y + m.w), BLUE, 1, 200);
        g.line((m.x, m.y + m.w / 2), (m.x + m.w, m.y + m.w / 2), BLUE, 1, 200);
        g.fill_round(Rect::new(m.x, m.y + m.w, m.w, m.h - m.w), 8, 0x161b22, 242);
        g.fill_round(Rect::new(m.x + 5, m.y + m.w + 7, 11, 11), 3, color, 255);
        g.stroke_round(Rect::new(m.x + 5, m.y + m.w + 7, 11, 11), 3, 0x8b949e, 1, 255);
        let hex = format!("#{color:06x}");
        g.text(&hex, (m.x + 21, m.y + m.w + 5), 12.0, 0xc9d1d9, 255, font_family);
        let pos = format!("{px}, {py}");
        g.text(&pos, (m.x + 70, m.y + m.w + 5), 12.0, 0x8b949e, 255, font_family);
    }
    // 7) 文本输入框位置提示（真实输入由原生 EDIT 控件承载）
    if let Some((tx, ty, color)) = scene.text_cursor {
        g.stroke_rect(Rect::new(tx - 2, ty - 2, 3, TEXT_SIZES[0] + 4), color, 1, 200);
    }
    // 8) 底部快捷键提示（alpha 对齐其他 chip；文字用 app 深色主题的 de-emphasized 档，最坏背景也能过 AA）
    if !scene.hint.is_empty() {
        let w = scene.hint.chars().map(|c| if (c as u32) > 0x2E80 { 12.5 } else { 7.0 }).sum::<f32>() as i32 + 22;
        g.fill_round(Rect::new(12, canvas.h - 34, w, 26), 8, 0x161b22, 246);
        g.stroke_round(Rect::new(12, canvas.h - 34, w, 26), 8, 0x30363d, 1, 220);
        g.text(scene.hint, (23, canvas.h - 30), 12.5, 0x9aa4b2, 255, font_family);
    }
}

fn handle_point(sel: Rect, h: &str) -> (i32, i32) {
    let x = if h.contains('w') { sel.x } else if h.contains('e') { sel.right() } else { sel.x + sel.w / 2 };
    let y = if h.contains('n') { sel.y } else if h.contains('s') { sel.bottom() } else { sel.y + sel.h / 2 };
    (x, y)
}

unsafe fn paint_toolbar_item(g: &Gp, scene: &Scene, item: &super::state::ToolbarItem, r: Rect, family: &str) {
    use super::state::ToolbarItem as T;
    let hovered = scene.hover == Some(*item);
    let icon_rect = r.inset(8);
    match item {
        T::Tool(t) => {
            let active = scene.active_tool == Some(*t);
            if active {
                g.fill_round(r, 8, 0x1a3352, 255);
                g.stroke_round(r, 8, BLUE, 1, 255);
            } else if hovered {
                g.fill_round(r, 8, 0x21262d, 255);
            }
            let fg = if active { 0x79c0ff } else if hovered { 0xffffff } else { 0xc9d1d9 };
            draw_tool_icon(g, *t, icon_rect, fg, 255);
        }
        T::Color(c) => {
            let on = scene.color == *c;
            let inner = r.inset(4);
            if on {
                g.stroke_round(Rect::new(inner.x - 2, inner.y - 2, inner.w + 4, inner.h + 4), 6, BLUE, 2, 255);
            } else if hovered {
                g.stroke_round(Rect::new(inner.x - 2, inner.y - 2, inner.w + 4, inner.h + 4), 6, 0x8b949e, 1, 200);
            }
            g.fill_round(inner, 4, *c, 255);
            g.stroke_round(inner, 4, 0x000000, 1, 60);
        }
        T::Width(i) => {
            let on = scene.width_idx == *i;
            if on {
                g.fill_round(r, 8, 0x1a3352, 255);
                g.stroke_round(r, 8, BLUE, 1, 255);
            } else if hovered {
                g.fill_round(r, 8, 0x21262d, 255);
            }
            let d = 4 + (*i as i32) * 4;
            let c = (r.x + r.w / 2, r.y + r.h / 2);
            let fg = if on { 0x79c0ff } else if hovered { 0xffffff } else { 0xc9d1d9 };
            g.fill_ellipse(Rect::new(c.0 - d / 2, c.1 - d / 2, d, d), fg, 255);
        }
        T::Undo | T::Redo => {
            let lit = if matches!(item, T::Undo) { scene.can_undo } else { scene.can_redo };
            if hovered && lit {
                g.fill_round(r, 8, 0x21262d, 255);
            }
            let fg = if !lit { 0x4a525c } else if hovered { 0xffffff } else { 0xc9d1d9 };
            let glyph = if matches!(item, T::Undo) { "↶" } else { "↷" };
            // 字形墨迹在行框里偏上，矩形下移 2px 补正（与动作按钮标签同理）
            g.text_centered(glyph, Rect::new(r.x, r.y + 2, r.w, r.h), 16.0, fg, 255, family);
        }
        T::Copy | T::Save | T::Pin | T::Cancel => {
            let primary = matches!(item, T::Copy);
            if primary {
                // hover 只轻微提亮（#2e6fd6 对白字仍 4.8:1，过 AA；再亮就不达标了）
                g.fill_round(r, 8, if hovered { 0x2e6fd6 } else { 0x2b6ad0 }, 255);
            } else if hovered {
                g.fill_round(r, 8, 0x21262d, 255);
            }
            let fg = if primary { 0xffffff } else if hovered { 0xffffff } else { 0xc9d1d9 };
            let (label, icon): (&str, Option<&str>) = match item {
                T::Copy => (scene.labels.copy, Some("copy")),
                T::Save => (scene.labels.save, Some("save")),
                T::Pin => (scene.labels.pin, Some("pin")),
                _ => ("", Some("x")),
            };
            // 图标 + 标签作为一个整体在按钮内居中：水平按内容总宽算起点，垂直交给 rect 居中排版
            const ICON: i32 = 16;
            let label_w = if label.is_empty() {
                0
            } else {
                label.chars().map(|c| if (c as u32) > 0x2E80 { 12.5 } else { 6.9 }).sum::<f32>() as i32
            };
            let icon_w = if icon.is_some() { ICON } else { 0 };
            let gap = if icon_w > 0 && label_w > 0 { 5 } else { 0 };
            let mut cx = r.x + (r.w - icon_w - gap - label_w) / 2;
            if let Some(kind) = icon {
                draw_action_icon(g, kind, Rect::new(cx, r.y + (r.h - ICON) / 2, ICON, ICON), fg, 255);
                cx += icon_w + gap;
            }
            if !label.is_empty() {
                // 排版矩形向两侧扩 8px（中心不变）：预估宽度略小于实际时也不会被裁字；
                // 下移 2px：CJK 字符墨迹在行框里天然偏上，GDI+ 行居中后视觉仍略高
                g.text_centered(label, Rect::new(cx - 8, r.y + 2, label_w + 16, r.h), 12.5, fg, 255, family);
            }
        }
    }
}

/// 工具按钮的矢量图标（画笔风格：2px 描边、圆角端点，跟 Snipaste 一类工具对齐）
unsafe fn draw_tool_icon(g: &Gp, tool: Tool, box_: Rect, color: u32, alpha: u32) {
    let c = (box_.x + box_.w / 2, box_.y + box_.h / 2);
    let s = 7;
    match tool {
        Tool::Rect => g.stroke_round(Rect::new(c.0 - s, c.1 - s, s * 2, s * 2), 2, color, 2, alpha),
        Tool::Ellipse => g.stroke_ellipse(Rect::new(c.0 - s, c.1 - s, s * 2, s * 2), color, 2, alpha),
        Tool::Arrow => {
            g.line((c.0 - s, c.1 + s), (c.0 + s, c.1 - s), color, 2, alpha);
            g.line((c.0 + s, c.1 - s), (c.0 + s - 5, c.1 - s + 1), color, 2, alpha);
            g.line((c.0 + s, c.1 - s), (c.0 + s - 1, c.1 - s + 5), color, 2, alpha);
        }
        Tool::Pen => {
            g.line((c.0 - s + 1, c.1 + s - 1), (c.0 + s - 2, c.1 - s + 2), color, 2, alpha);
            g.fill_rect(Rect::new(c.0 - s - 1, c.1 + s - 3, 3, 3), color, alpha);
        }
        Tool::Marker => {
            g.line((c.0 - s, c.1 + s), (c.0 + s, c.1 - s), color, 7, 120);
            g.line((c.0 - s, c.1 + s), (c.0 + s, c.1 - s), color, 2, alpha);
        }
        Tool::Text => {
            g.line((c.0 - s + 1, c.1 - s + 2), (c.0 + s - 1, c.1 - s + 2), color, 2, alpha);
            g.line((c.0, c.1 - s + 2), (c.0, c.1 + s), color, 2, alpha);
        }
        Tool::Mosaic => {
            for (dx, dy, filled) in [(-s, -s, true), (-s + 5, -s, false), (-s, -s + 5, false), (-s + 10, -s + 5, true), (-s + 5, -s + 10, true), (-s + 10, -s + 10, false)] {
                if filled {
                    g.fill_round(Rect::new(c.0 + dx, c.1 + dy, 4, 4), 1, color, alpha);
                } else {
                    g.stroke_round(Rect::new(c.0 + dx, c.1 + dy, 4, 4), 1, color, 1, alpha);
                }
            }
        }
    }
}

/// 动作按钮的小图标
unsafe fn draw_action_icon(g: &Gp, kind: &str, box_: Rect, color: u32, alpha: u32) {
    let (x, y) = (box_.x, box_.y);
    // 每个图形的墨迹（而非外框）在 16px 里居中：否则视觉上整体偏左上
    match kind {
        "copy" => {
            g.stroke_round(Rect::new(x + 1, y + 5, 9, 9), 2, color, 2, alpha);
            g.stroke_round(Rect::new(x + 5, y + 2, 9, 9), 2, color, 2, alpha);
        }
        "save" => {
            g.line((x + 8, y + 4), (x + 8, y + 12), color, 2, alpha);
            g.line((x + 8, y + 12), (x + 5, y + 9), color, 2, alpha);
            g.line((x + 8, y + 12), (x + 11, y + 9), color, 2, alpha);
        }
        "pin" => {
            g.line((x + 6, y + 5), (x + 11, y + 10), color, 2, alpha);
            g.stroke_round(Rect::new(x + 4, y + 3, 6, 6), 2, color, 2, alpha);
            g.line((x + 4, y + 12), (x + 7, y + 9), color, 2, alpha);
        }
        _ => {
            g.line((x + 4, y + 4), (x + 11, y + 11), color, 2, alpha);
            g.line((x + 11, y + 4), (x + 4, y + 11), color, 2, alpha);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 锁住颜色约定：DIB 内存是 BGRA（GDI），导出字节是 RGBA——任一方向漏换都会偏色
    #[test]
    fn dib_memory_is_bgra_rgba_roundtrip() {
        let src = vec![10u8, 20, 30, 255, 200, 100, 50, 255];
        let d = Dib::from_rgba(&src, 2, 1);
        let mem = unsafe { std::slice::from_raw_parts(d.bits as *const u8, 8) };
        assert_eq!(mem, &[30, 20, 10, 255, 50, 100, 200, 255], "DIB 内存应为 BGRA");
        assert_eq!(d.rgba(), src, "导出应换回 RGBA");
    }
}
