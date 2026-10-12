//! 原生截图遮罩的纯逻辑层：选区几何、标注 op、撤销栈、工具栏布局与命中测试。
//!
//! 这里全部是纯数据/纯函数，坐标一律是**本屏物理像素**（原生遮罩里鼠标坐标、绘制坐标、
//! 裁剪坐标天然是同一个空间，不再有 WebView 版那套「逻辑像素 × 缩放比」的换算）。
//! 窗口、消息与绘制分别在 mod.rs / paint.rs。

pub const MIN_SELECTION: i32 = 4;
/// 八个调整手柄：四角 + 四边
pub const HANDLES: [&str; 8] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

#[derive(Clone, Copy, PartialEq, Debug)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn contains(&self, p: (i32, i32)) -> bool {
        p.0 >= self.x && p.0 <= self.right() && p.1 >= self.y && p.1 <= self.bottom()
    }
    pub fn inset(&self, n: i32) -> Self {
        Self::new(self.x + n, self.y + n, (self.w - 2 * n).max(0), (self.h - 2 * n).max(0))
    }
}

/// 两点归一化（支持任意方向拖拽）
pub fn rect_from_points(a: (i32, i32), b: (i32, i32)) -> Rect {
    Rect::new(a.0.min(b.0), a.1.min(b.1), (a.0 - b.0).abs(), (a.1 - b.1).abs())
}

/// 钳进边界：过大则压缩，越界则挪回
pub fn clamp_rect(r: Rect, bounds: (i32, i32)) -> Rect {
    let w = r.w.min(bounds.0);
    let h = r.h.min(bounds.1);
    Rect::new(r.x.clamp(0, (bounds.0 - w).max(0)), r.y.clamp(0, (bounds.1 - h).max(0)), w, h)
}

/// 命中哪个手柄（判定半径 tol），未命中返回 None
pub fn hit_handle(sel: Rect, p: (i32, i32), tol: i32) -> Option<&'static str> {
    if p.0 < sel.x - tol || p.0 > sel.right() + tol || p.1 < sel.y - tol || p.1 > sel.bottom() + tol {
        return None;
    }
    let near = |v: i32, t: i32| (v - t).abs() <= tol;
    let (l, r, t, b) = (near(p.0, sel.x), near(p.0, sel.right()), near(p.1, sel.y), near(p.1, sel.bottom()));
    Some(match (t, b, l, r) {
        (true, _, true, _) => "nw",
        (true, _, _, true) => "ne",
        (_, true, true, _) => "sw",
        (_, true, _, true) => "se",
        (true, _, _, _) => "n",
        (_, true, _, _) => "s",
        (_, _, true, _) => "w",
        (_, _, _, true) => "e",
        _ => return None,
    })
}

/// 拖手柄调整大小：被拖的一侧跟着走，对侧为锚点；钳进边界并保底最小尺寸
pub fn resize_rect(r: Rect, handle: &str, p: (i32, i32), bounds: (i32, i32), min: i32) -> Rect {
    let (mut l, mut t, mut right, mut b) = (r.x, r.y, r.right(), r.bottom());
    if handle.contains('w') {
        l = p.0.min(right - min);
    }
    if handle.contains('e') {
        right = p.0.max(l + min);
    }
    if handle.contains('n') {
        t = p.1.min(b - min);
    }
    if handle.contains('s') {
        b = p.1.max(t + min);
    }
    l = l.max(0);
    t = t.max(0);
    right = right.min(bounds.0);
    b = b.min(bounds.1);
    Rect::new(l, t, (right - l).max(min.min(bounds.0)), (b - t).max(min.min(bounds.1)))
}

pub fn move_rect(r: Rect, dx: i32, dy: i32, bounds: (i32, i32)) -> Rect {
    clamp_rect(Rect::new(r.x + dx, r.y + dy, r.w, r.h), bounds)
}

/// 方向键微调：返回新选区
pub fn nudge_rect(r: Rect, vk: i32, step: i32, bounds: (i32, i32)) -> Rect {
    let (dx, dy) = match vk {
        VK_LEFT => (-step, 0),
        VK_RIGHT => (step, 0),
        VK_UP => (0, -step),
        VK_DOWN => (0, step),
        _ => return r,
    };
    move_rect(r, dx, dy, bounds)
}

pub const VK_LEFT: i32 = 0x25;
pub const VK_UP: i32 = 0x26;
pub const VK_RIGHT: i32 = 0x27;
pub const VK_DOWN: i32 = 0x28;
// windows-sys 里这些是 u16，这里统一成 i32（消息参数本来就是 i32 空间）
pub const VK_ESCAPE: i32 = 0x1B;
pub const VK_RETURN: i32 = 0x0D;
pub const VK_F3: i32 = 0x72;
pub const VK_CONTROL: i32 = 0x11;
pub const VK_SHIFT: i32 = 0x10;
pub const VK_C: i32 = 0x43;
pub const VK_S: i32 = 0x53;
pub const VK_Z: i32 = 0x5A;
pub const VK_Y: i32 = 0x59;

/// 标注工具
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Tool {
    Rect,
    Ellipse,
    Arrow,
    Pen,
    Marker,
    Text,
    Mosaic,
}

pub const TOOLS: [Tool; 7] = [Tool::Rect, Tool::Ellipse, Tool::Arrow, Tool::Pen, Tool::Marker, Tool::Text, Tool::Mosaic];

/// i18n 键后缀（拼 "/screenshot/toolXxx"，与 WebView 版工具栏共享同一批文案）
impl Tool {
    pub fn name_key(&self) -> &'static str {
        match self {
            Tool::Rect => "toolRect",
            Tool::Ellipse => "toolEllipse",
            Tool::Arrow => "toolArrow",
            Tool::Pen => "toolPen",
            Tool::Marker => "toolMarker",
            Tool::Text => "toolText",
            Tool::Mosaic => "toolMosaic",
        }
    }
}

pub const PALETTE: [u32; 8] = [0xe5484d, 0xf5a623, 0xf8e71c, 0x2ecc71, 0x0ea5e9, 0x8b5cf6, 0x111111, 0xffffff];
pub const LINE_WIDTHS: [i32; 3] = [2, 4, 7];
pub const TEXT_SIZES: [i32; 3] = [16, 22, 30];

/// 一条标注（坐标：本屏物理像素；颜色 0xRRGGBB）
#[derive(Clone, Debug, PartialEq)]
pub enum Op {
    Rect { rect: Rect, color: u32, width: i32 },
    Ellipse { rect: Rect, color: u32, width: i32 },
    Arrow { from: (i32, i32), to: (i32, i32), color: u32, width: i32 },
    Stroke { points: Vec<(i32, i32)>, color: u32, width: i32, marker: bool },
    Text { at: (i32, i32), size: i32, text: String, color: u32 },
    Mosaic { rect: Rect },
}

impl Op {
    /// 误触过滤：一像素的框、没动过的箭头不算操作（画笔单击留点是有效的）
    pub fn is_meaningful(&self) -> bool {
        match self {
            Op::Rect { rect, .. } | Op::Ellipse { rect, .. } | Op::Mosaic { rect } => rect.w >= 2 && rect.h >= 2,
            Op::Arrow { from, to, .. } => (to.0 - from.0).abs() + (to.1 - from.1).abs() >= 3,
            Op::Stroke { points, .. } => !points.is_empty(),
            Op::Text { .. } => true,
        }
    }
}

/// 撤销栈：undo/redo 只挪游标，push 截断重做分支
pub struct History {
    ops: Vec<Op>,
    cursor: usize,
    limit: usize,
}

impl History {
    pub fn new(limit: usize) -> Self {
        Self { ops: Vec::new(), cursor: 0, limit }
    }
    pub fn active(&self) -> &[Op] {
        &self.ops[..self.cursor]
    }
    pub fn can_undo(&self) -> bool {
        self.cursor > 0
    }
    pub fn can_redo(&self) -> bool {
        self.cursor < self.ops.len()
    }
    pub fn push(&mut self, op: Op) {
        self.ops.truncate(self.cursor);
        self.ops.push(op);
        if self.ops.len() > self.limit {
            self.ops.remove(0);
        }
        self.cursor = self.ops.len();
    }
    pub fn undo(&mut self) -> bool {
        if self.cursor == 0 {
            return false;
        }
        self.cursor -= 1;
        true
    }
    pub fn redo(&mut self) -> bool {
        if self.cursor >= self.ops.len() {
            return false;
        }
        self.cursor += 1;
        true
    }
}

/// 工具栏上的可点项
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum ToolbarItem {
    Undo,
    Redo,
    Tool(Tool),
    Color(u32),
    Width(usize),
    Copy,
    Save,
    Pin,
    Cancel,
}

pub struct ToolbarLayout {
    pub bar: Rect,
    pub items: Vec<(ToolbarItem, Rect)>,
}

/// 工具栏布局：**绘制与命中共用这一份**，位置绝不漂移。
/// 优先放在选区下方，放不下翻到上方；水平方向贴住选区并钳进窗口。
pub fn toolbar_layout(sel: Rect, window: (i32, i32), item_widths: &[(ToolbarItem, i32)]) -> ToolbarLayout {
    const PAD: i32 = 6;
    const GAP: i32 = 2;
    const SEP: i32 = 9;
    const H: i32 = 34;
    let mut width = PAD;
    for (i, (_, w)) in item_widths.iter().enumerate() {
        if i > 0 && is_sep_before(&item_widths[i].0, &item_widths[i - 1].0) {
            width += SEP;
        }
        width += w + GAP;
    }
    width += PAD - GAP;
    let below = sel.bottom() + 10;
    let y = if below + H + 8 <= window.1 { below } else { (sel.y - H - 10).max(8) };
    let x = (sel.x + sel.w / 2 - width / 2).clamp(8, (window.0 - width - 8).max(8));
    let bar = Rect::new(x, y, width, H);
    let mut items = Vec::new();
    let mut cx = x + PAD;
    for (i, (item, w)) in item_widths.iter().enumerate() {
        if i > 0 && is_sep_before(&item_widths[i].0, &item_widths[i - 1].0) {
            cx += SEP;
        }
        items.push((*item, Rect::new(cx, y + PAD, *w, H - PAD * 2)));
        cx += w + GAP;
    }
    ToolbarLayout { bar, items }
}

/// 分组之间画分隔线（工具组、颜色组、粗细组、动作组之间）
fn is_sep_before(cur: &ToolbarItem, prev: &ToolbarItem) -> bool {
    let group = |it: &ToolbarItem| match it {
        ToolbarItem::Undo | ToolbarItem::Redo => 0,
        ToolbarItem::Tool(_) => 1,
        ToolbarItem::Color(_) => 2,
        ToolbarItem::Width(_) => 3,
        _ => 4,
    };
    group(cur) != group(prev)
}

pub fn hit_toolbar(layout: &ToolbarLayout, p: (i32, i32)) -> Option<ToolbarItem> {
    layout.items.iter().find(|(_, r)| r.contains(p)).map(|(it, _)| *it)
}

/// 放大镜面板：跟随光标，贴边翻转
pub fn magnifier_rect(cursor: (i32, i32), window: (i32, i32)) -> Rect {
    const SIZE: i32 = 116;
    const META: i32 = 26;
    let flip_x = cursor.0 + 24 + SIZE > window.0;
    let flip_y = cursor.1 + 24 + SIZE + META > window.1;
    let x = if flip_x { cursor.0 - 24 - SIZE } else { cursor.0 + 24 };
    let y = if flip_y { cursor.1 - 24 - SIZE - META } else { cursor.1 + 24 };
    Rect::new(x, y, SIZE, SIZE + META)
}

/// 工具栏项的固定宽度（布局与命中都用它）
pub fn toolbar_item_widths() -> Vec<(ToolbarItem, i32)> {
    let mut v = vec![(ToolbarItem::Undo, 30), (ToolbarItem::Redo, 30)];
    for t in TOOLS {
        v.push((ToolbarItem::Tool(t), 36));
    }
    for c in PALETTE {
        v.push((ToolbarItem::Color(c), 22));
    }
    for i in 0..LINE_WIDTHS.len() {
        v.push((ToolbarItem::Width(i), 26));
    }
    v.push((ToolbarItem::Copy, 56));
    v.push((ToolbarItem::Save, 52));
    v.push((ToolbarItem::Pin, 52));
    v.push((ToolbarItem::Cancel, 30));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_from_points_normalizes() {
        assert_eq!(rect_from_points((10, 20), (60, 90)), Rect::new(10, 20, 50, 70));
        assert_eq!(rect_from_points((60, 90), (10, 20)), Rect::new(10, 20, 50, 70));
    }

    #[test]
    fn clamp_rect_keeps_inside() {
        let b = (1000, 800);
        assert_eq!(clamp_rect(Rect::new(950, 780, 100, 60), b), Rect::new(900, 740, 100, 60));
        assert_eq!(clamp_rect(Rect::new(-20, -30, 2000, 900), b), Rect::new(0, 0, 1000, 800));
    }

    #[test]
    fn hit_handle_corners_edges_and_miss() {
        let r = Rect::new(100, 100, 200, 150);
        assert_eq!(hit_handle(r, (100, 100), 6), Some("nw"));
        assert_eq!(hit_handle(r, (300, 100), 6), Some("ne"));
        assert_eq!(hit_handle(r, (100, 250), 6), Some("sw"));
        assert_eq!(hit_handle(r, (300, 250), 6), Some("se"));
        assert_eq!(hit_handle(r, (200, 100), 6), Some("n"));
        assert_eq!(hit_handle(r, (300, 175), 6), Some("e"));
        assert_eq!(hit_handle(r, (200, 175), 6), None);
        assert_eq!(hit_handle(r, (500, 500), 6), None);
    }

    #[test]
    fn resize_moves_only_dragged_side() {
        let r = Rect::new(100, 100, 200, 150);
        assert_eq!(resize_rect(r, "se", (400, 400), (1000, 800), 4), Rect::new(100, 100, 300, 300));
        assert_eq!(resize_rect(r, "nw", (50, 60), (1000, 800), 4), Rect::new(50, 60, 250, 190));
        let shrunk = resize_rect(r, "e", (90, 175), (1000, 800), 4);
        assert_eq!(shrunk.w, 4);
        assert_eq!(shrunk.x, 100);
    }

    #[test]
    fn move_and_nudge() {
        let r = Rect::new(100, 100, 200, 150);
        assert_eq!(move_rect(r, 50, 30, (1000, 800)), Rect::new(150, 130, 200, 150));
        assert_eq!(move_rect(r, 5000, 0, (1000, 800)), Rect::new(800, 100, 200, 150));
        assert_eq!(nudge_rect(r, VK_RIGHT, 1, (1000, 800)), Rect::new(101, 100, 200, 150));
        assert_eq!(nudge_rect(r, VK_UP, 10, (1000, 800)), Rect::new(100, 90, 200, 150));
        assert_eq!(nudge_rect(r, 0x0d, 1, (1000, 800)), r);
    }

    #[test]
    fn history_undo_redo_and_truncate() {
        let mut h = History::new(300);
        h.push(Op::Mosaic { rect: Rect::new(0, 0, 5, 5) });
        h.push(Op::Text { at: (1, 1), size: 16, text: "a".into(), color: 0 });
        assert_eq!(h.active().len(), 2);
        assert!(h.undo());
        assert_eq!(h.active().len(), 1);
        assert!(h.can_redo());
        h.push(Op::Mosaic { rect: Rect::new(0, 0, 9, 9) });
        assert!(!h.can_redo(), "撤销后再画应截断重做分支");
        assert_eq!(h.active().len(), 2);
    }

    #[test]
    fn toolbar_layout_stays_inside_and_hits() {
        let sel = Rect::new(100, 100, 400, 300);
        let widths = toolbar_item_widths();
        let layout = toolbar_layout(sel, (1280, 800), &widths);
        assert!(layout.bar.x >= 8 && layout.bar.right() <= 1272);
        assert_eq!(layout.items.len(), widths.len());
        // 每个按钮中心都能命中自己
        for (item, r) in &layout.items {
            let center = (r.x + r.w / 2, r.y + r.h / 2);
            assert_eq!(hit_toolbar(&layout, center), Some(*item));
        }
        // 选区贴底时工具栏翻到上方
        let low = Rect::new(100, 700, 400, 90);
        let layout2 = toolbar_layout(low, (1280, 800), &widths);
        assert!(layout2.bar.bottom() <= low.y, "贴底时应翻到选区上方");
    }

    #[test]
    fn magnifier_flips_near_edges() {
        let m = magnifier_rect((100, 100), (1280, 800));
        assert!(m.x > 100 && m.y > 100, "默认在光标右下");
        let m2 = magnifier_rect((1270, 790), (1280, 800));
        assert!(m2.right() <= 1280 && m2.bottom() <= 800, "贴边时翻到左上");
    }

    #[test]
    fn meaningful_filter() {
        assert!(!Op::Rect { rect: Rect::new(0, 0, 1, 0), color: 0, width: 2 }.is_meaningful());
        assert!(Op::Rect { rect: Rect::new(0, 0, 5, 5), color: 0, width: 2 }.is_meaningful());
        assert!(!Op::Arrow { from: (0, 0), to: (1, 0), color: 0, width: 2 }.is_meaningful());
        assert!(Op::Stroke { points: vec![(0, 0)], color: 0, width: 2, marker: false }.is_meaningful());
    }
}
