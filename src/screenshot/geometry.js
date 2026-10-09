// 截选区几何：全部使用「遮罩页逻辑坐标」（CSS px）。
// 物理像素只在导出时出现一次（toPhysicalRect），其余交互全在逻辑坐标里算，
// 高 DPI 下由画布变换统一换算，避免每个函数都要考虑缩放比。

/** 小于这个尺寸的选择视作误触（点一下没拖动） */
export const MIN_SELECTION = 4;

/** 两点归一化为非负宽高的矩形（支持从任意方向拖） */
export function rectFromPoints(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

/** 矩形钳进边界：过大则压缩，越界则挪回 */
export function clampRect(rect, bounds) {
  const width = Math.min(rect.width, bounds.width);
  const height = Math.min(rect.height, bounds.height);
  return {
    x: Math.min(Math.max(rect.x, 0), Math.max(bounds.width - width, 0)),
    y: Math.min(Math.max(rect.y, 0), Math.max(bounds.height - height, 0)),
    width,
    height,
  };
}

/** 八向手柄名（四角 + 四边） */
export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

/** 命中测试：命中哪个手柄（判定半径 tolerance），未命中返回 null */
export function hitHandle(rect, point, tolerance = 6) {
  const near = (value, target) => Math.abs(value - target) <= tolerance;
  const withinX = point.x >= rect.x - tolerance && point.x <= rect.x + rect.width + tolerance;
  const withinY = point.y >= rect.y - tolerance && point.y <= rect.y + rect.height + tolerance;
  if (!withinX || !withinY) return null;
  const onLeft = near(point.x, rect.x);
  const onRight = near(point.x, rect.x + rect.width);
  const onTop = near(point.y, rect.y);
  const onBottom = near(point.y, rect.y + rect.height);
  if (onTop && onLeft) return "nw";
  if (onTop && onRight) return "ne";
  if (onBottom && onLeft) return "sw";
  if (onBottom && onRight) return "se";
  if (onTop) return "n";
  if (onBottom) return "s";
  if (onLeft) return "w";
  if (onRight) return "e";
  return null;
}

export function insideRect(rect, point) {
  return (
    point.x >= rect.x &&
    point.x <= rect.x + rect.width &&
    point.y >= rect.y &&
    point.y <= rect.y + rect.height
  );
}

/**
 * 拖手柄调整大小：被拖的一侧跟着走，对侧为锚点；结果钳进边界并保底最小尺寸。
 * 缩小到比 min 更小时停在 min，而不是翻转（翻转会让用户以为选区跳了）。
 */
export function resizeRect(rect, handle, point, bounds, min = MIN_SELECTION) {
  let left = rect.x;
  let top = rect.y;
  let right = rect.x + rect.width;
  let bottom = rect.y + rect.height;
  if (handle.includes("w")) left = Math.min(point.x, right - min);
  if (handle.includes("e")) right = Math.max(point.x, left + min);
  if (handle.includes("n")) top = Math.min(point.y, bottom - min);
  if (handle.includes("s")) bottom = Math.max(point.y, top + min);
  left = Math.max(left, 0);
  top = Math.max(top, 0);
  right = Math.min(right, bounds.width);
  bottom = Math.min(bottom, bounds.height);
  return {
    x: left,
    y: top,
    width: Math.max(right - left, Math.min(min, bounds.width)),
    height: Math.max(bottom - top, Math.min(min, bounds.height)),
  };
}

/** 整体移动：保持大小，钳进边界 */
export function moveRect(rect, dx, dy, bounds) {
  return clampRect({ ...rect, x: rect.x + dx, y: rect.y + dy }, bounds);
}

const NUDGE_DELTAS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };

/** 方向键微调选区位置；非方向键原样返回 */
export function nudgeRect(rect, key, step, bounds) {
  const delta = NUDGE_DELTAS[key];
  if (!delta) return rect;
  return moveRect(rect, delta[0] * step, delta[1] * step, bounds);
}

/** 逻辑矩形 → 物理像素矩形（导出裁切用）：四舍五入取样，不出画布边界 */
export function toPhysicalRect(rect, kx, ky, bounds) {
  const x = Math.min(Math.round(rect.x * kx), bounds.width - 1);
  const y = Math.min(Math.round(rect.y * ky), bounds.height - 1);
  const right = Math.min(Math.round((rect.x + rect.width) * kx), bounds.width);
  const bottom = Math.min(Math.round((rect.y + rect.height) * ky), bounds.height);
  return { x, y, width: Math.max(right - x, 1), height: Math.max(bottom - y, 1) };
}
