// 磁盘分析助手的纯逻辑：treemap 布局、列表合并排序、百分比与时长格式化。
// 与视图解耦（不 import Vue/Tauri），node 环境可直接单测。
// 体积格式化复用「文件处理」的 formatFileSize（同一套 B/KB/MB/GB 口径，避免两处漂移）。
import { formatFileSize } from "./fileTool.js";

export { formatFileSize as formatBytes };

/** 占比 [0,1]；总量为 0 时返回 0（避免除零把条形宽度算成 NaN）。 */
export function share(part, whole) {
  const total = Number(whole);
  if (!Number.isFinite(total) || total <= 0) return 0;
  const value = Number(part);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value / total);
}

/** 占比文案：1 位小数；总量为 0 时退化为 "0%" 而不是 "NaN%"。 */
export function formatPercent(part, whole, digits = 1) {
  const value = share(part, whole) * 100;
  return `${value.toFixed(digits).replace(/\.0$/, "")}%`;
}

/**
 * 时长的结构化表示：{ value, unit }，unit ∈ ms/s/min。
 * 文案（"毫秒"/"秒"/"分"）交给 i18n，纯逻辑只做切换单位与取整。
 */
export function durationParts(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return { value: Math.round(value), unit: "ms" };
  if (value < 60_000) return { value: Math.round(value / 100) / 10, unit: "s" };
  return { value: Math.round(value / 60_000 * 10) / 10, unit: "min" };
}

/**
 * 目录页的合并列表：目录（树里有 id，可下钻）+ 文件（实时读盘，可定位）。
 * 按体积降序（同体积按名称），超 `limit` 截断——一个目录可能有十万个文件，
 * 列表只展示头部，调用方用 `truncated` 如实提示。
 */
export function mergeEntries(dirs, files, limit = 500) {
  const rows = [
    ...(Array.isArray(dirs) ? dirs : []).map((dir) => ({
      kind: "dir",
      id: dir.id,
      name: String(dir.name ?? ""),
      size: Number(dir.size) || 0,
      files: Number(dir.files) || 0,
      dirs: Number(dir.dirs) || 0,
      errors: Number(dir.errors) || 0,
    })),
    ...(Array.isArray(files) ? files : []).map((file) => ({
      kind: "file",
      path: String(file.path ?? ""),
      name: String(file.name ?? ""),
      size: Number(file.size) || 0,
      modifiedAt: Number(file.modifiedAt) || 0,
    })),
  ].sort((a, b) => b.size - a.size || a.name.localeCompare(b.name));

  const total = rows.length;
  return { rows: rows.slice(0, Math.max(0, limit)), total, truncated: total > limit };
}

/** treemap 矩形（含 padding 时用于命中测试/绘制都在原始坐标）。 */
function clampTiles(tiles, rect) {
  const minX = rect.x;
  const minY = rect.y;
  const maxX = rect.x + rect.width;
  const maxY = rect.y + rect.height;
  for (const tile of tiles) {
    tile.x = Math.min(Math.max(tile.x, minX), maxX);
    tile.y = Math.min(Math.max(tile.y, minY), maxY);
    tile.w = Math.max(0, Math.min(tile.w, maxX - tile.x));
    tile.h = Math.max(0, Math.min(tile.h, maxY - tile.y));
  }
  return tiles;
}

/** 一行的最差长宽比：面积和 sum、可用边长 side 时，行内矩形越接近正方形越好。 */
function worstAspect(row, sum, scale, side) {
  if (row.length === 0 || sum <= 0 || side <= 0) return Infinity;
  const thickness = sum / side;
  if (!Number.isFinite(thickness) || thickness <= 0) return Infinity;
  let worst = 0;
  for (const item of row) {
    const length = (item.size * scale) / thickness;
    if (!Number.isFinite(length) || length <= 0) return Infinity;
    worst = Math.max(worst, thickness / length, length / thickness);
  }
  return worst;
}

/**
 * Squarified treemap：把 [{key, size}] 铺进 rect ≈ {x,y,width,height}，返回
 * [{key, size, x, y, w, h}]（面积与 size 成正比，越大的排在越前面/越靠左上）。
 * 经典 Bruls 算法：行式填充 + 用最差长宽比决定一行装几个，尽量让每块接近正方形。
 */
export function squarify(items, rect) {
  const bounds = {
    x: Math.max(0, Number(rect?.x) || 0),
    y: Math.max(0, Number(rect?.y) || 0),
    width: Math.max(0, Number(rect?.width) || 0),
    height: Math.max(0, Number(rect?.height) || 0),
  };
  const list = (Array.isArray(items) ? items : [])
    .map((item) => ({ key: String(item?.key ?? ""), size: Math.max(0, Number(item?.size) || 0) }))
    .filter((item) => item.size > 0)
    .sort((a, b) => b.size - a.size);

  const total = list.reduce((sum, item) => sum + item.size, 0);
  const area = bounds.width * bounds.height;
  if (total <= 0 || area <= 0) return [];
  const scale = area / total;

  const tiles = [];
  let x = bounds.x;
  let y = bounds.y;
  let width = bounds.width;
  let height = bounds.height;
  let index = 0;
  while (index < list.length) {
    if (width <= 1e-6 || height <= 1e-6) {
      // 浮点残差吃掉了剩余空间：剩下的塞成 0 尺寸块（不可见但不丢条目）
      for (const item of list.slice(index)) {
        tiles.push({ key: item.key, size: item.size, x, y, w: 0, h: 0 });
      }
      break;
    }
    const shorter = Math.min(width, height);
    let rowSum = list[index].size * scale;
    let rowEnd = index + 1;
    while (rowEnd < list.length) {
      const nextSum = rowSum + list[rowEnd].size * scale;
      const current = worstAspect(list.slice(index, rowEnd), rowSum, scale, shorter);
      const grown = worstAspect(list.slice(index, rowEnd + 1), nextSum, scale, shorter);
      if (grown > current) break;
      rowSum = nextSum;
      rowEnd += 1;
    }
    const row = list.slice(index, rowEnd);
    if (width >= height) {
      // 竖向列：沿着高度方向铺满，整列的宽 = 行面积 / 高度
      const thickness = Math.min(rowSum / height, width);
      let cursor = y;
      for (const item of row) {
        const tileHeight = (item.size * scale) / thickness;
        tiles.push({ key: item.key, size: item.size, x, y: cursor, w: thickness, h: tileHeight });
        cursor += tileHeight;
      }
      x += thickness;
      width -= thickness;
    } else {
      const thickness = Math.min(rowSum / width, height);
      let cursor = x;
      for (const item of row) {
        const tileWidth = (item.size * scale) / thickness;
        tiles.push({ key: item.key, size: item.size, x: cursor, y, w: tileWidth, h: thickness });
        cursor += tileWidth;
      }
      y += thickness;
      height -= thickness;
    }
    index = rowEnd;
  }
  return clampTiles(tiles, bounds);
}

/** 命中测试：treemap 的点击/悬停都靠它（后画的块在上层，逆序找）。 */
export function tileAt(tiles, pointX, pointY) {
  const px = Number(pointX);
  const py = Number(pointY);
  if (!Number.isFinite(px) || !Number.isFinite(py)) return null;
  for (let index = tiles.length - 1; index >= 0; index -= 1) {
    const tile = tiles[index];
    if (px >= tile.x && px <= tile.x + tile.w && py >= tile.y && py <= tile.y + tile.h) {
      return tile;
    }
  }
  return null;
}

/** 选中集合的合计：项数 + 体积（选择栏与删除确认都用它）。 */
export function selectionTotals(entries) {
  const list = Array.isArray(entries) ? entries : [];
  return {
    count: list.length,
    size: list.reduce((sum, entry) => sum + Math.max(0, Number(entry?.size) || 0), 0),
  };
}

/**
 * path 是否恰为 parent 的直接子项。
 * 用来判断「这次删除能不能就地扣减当前节点」：只有直接子项的体积清清楚楚记在当前节点上，
 * 更深的路径（如从最大文件榜单里删掉别处的文件）扣不动中间层目录，只能提示重新扫描。
 */
export function isDirectChild(parent, child) {
  const base = String(parent ?? "");
  const target = String(child ?? "");
  if (!base || !target) return false;
  const separator = base.includes("\\") ? "\\" : "/";
  const prefix = base.endsWith(separator) ? base : base + separator;
  if (!target.toLowerCase().startsWith(prefix.toLowerCase())) return false;
  const rest = target.slice(prefix.length);
  return rest.length > 0 && !/[\\/]/.test(rest);
}

/**
 * 删除成功后就地扣减节点统计。
 * 目录体积来自扫描快照，单项重算做不到（要重扫子树）；按已知的删除量扣是这里最诚实的做法，
 * 界面会同时提示「重新扫描可完全刷新」。所有值钳到 0 以上，避免并发变化把数字干成负数。
 */
export function applyDeletions(nodes, removed) {
  const list = (Array.isArray(nodes) ? nodes : []).map((node) => ({ ...node }));
  const currentIndex = list.length - 1;
  for (const entry of Array.isArray(removed) ? removed : []) {
    const size = Math.max(0, Number(entry?.size) || 0);
    const isFile = entry?.kind === "file";
    const files = isFile ? 1 : Math.max(0, Number(entry?.files) || 0);
    const dirs = isFile ? 0 : Math.max(0, Number(entry?.dirs) || 0);
    list.forEach((node, index) => {
      node.size = Math.max(0, (Number(node.size) || 0) - size);
      node.files = Math.max(0, (Number(node.files) || 0) - files);
      node.dirs = Math.max(0, (Number(node.dirs) || 0) - dirs);
      // ownBytes 只统计当前目录的直属文件，祖先层的直属文件不含被删项
      if (isFile && index === currentIndex) {
        node.ownBytes = Math.max(0, (Number(node.ownBytes) || 0) - size);
      }
    });
  }
  return list;
}
