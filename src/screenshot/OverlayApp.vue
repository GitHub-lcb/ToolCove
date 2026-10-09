<script setup>
// 截图遮罩页（?shot=overlay&session=..&monitor=..）：显示 Rust 捕获的冻结帧，
// 完成框选、八向调整、标注，导出合成 PNG 交回 Rust 落剪贴板 / 文件 / 贴图窗口。
//
// 坐标约定：选区与标注全部用**逻辑像素**（CSS px），画布按 kx/ky 变换到物理分辨率，
// 导出时一次性换算——高 DPI 下交互代码不需要处处乘缩放比。
//
// 窗口由 Rust 隐藏创建，本页取到帧并完成首帧渲染后才 show：加载期间屏幕上是桌面本身，
// 而不是一块白屏。
import { computed, onBeforeUnmount, onMounted, reactive, ref, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../platform/invoke.js";
import { getCurrentWindow } from "../platform/window.js";
import { save } from "../platform/dialog.js";
import Icon from "../Icon.vue";
import { MIN_SELECTION, HANDLES, rectFromPoints, clampRect, hitHandle, insideRect, resizeRect, moveRect, nudgeRect, toPhysicalRect } from "./geometry.js";
import { createHistory } from "./history.js";
import { base64ToBytes, bytesToBlobUrl, canvasToBase64 } from "./png.js";

const { t } = useI18n();

// 渲染冒烟测试跑在 Node（无 window）：参数取空即可，组件只做首屏渲染
const params = typeof window === "undefined" ? new URLSearchParams() : new URLSearchParams(window.location.search);
const sessionId = params.get("session") || "";
const monitorIndex = Number(params.get("monitor") || 0);

const phase = ref("loading"); // loading | ready | closing
const busy = ref(false);
const rootRef = ref(null);
const canvasRef = ref(null);
const magRef = ref(null);
const textInputRef = ref(null);

// 视图尺寸（逻辑像素）与帧信息
const view = reactive({ width: 0, height: 0, kx: 1, ky: 1, frameWidth: 0, frameHeight: 0 });
let baseBitmap = null; // 冻结帧（物理分辨率），放大镜与取色从它采样
let baseCanvas = null; // 冻结帧的画布副本（物理分辨率）：导出裁切与马赛克采样用
let baseCtx = null; // willReadFrequently：取色每帧都读像素，别让 GPU 回读拖慢鼠标
let blobUrl = "";

// 选区与标注
const selection = ref(null);
const tool = ref(null); // rect | ellipse | arrow | pen | marker | text | mosaic
const color = ref("#e5484d");
const widthIndex = ref(1);
const history = createHistory();

const PALETTE = ["#e5484d", "#f5a623", "#f8e71c", "#2ecc71", "#0ea5e9", "#8b5cf6", "#111111", "#ffffff"];
const LINE_WIDTHS = [2, 4, 7];
const TEXT_SIZES = [16, 22, 30];
const TOOLS = [
  { key: "rect", icon: "square", labelKey: "screenshot.toolRect" },
  { key: "ellipse", icon: "circle", labelKey: "screenshot.toolEllipse" },
  { key: "arrow", icon: "arrow-up-right", labelKey: "screenshot.toolArrow" },
  { key: "pen", icon: "pen-line", labelKey: "screenshot.toolPen" },
  { key: "marker", icon: "highlighter", labelKey: "screenshot.toolMarker" },
  { key: "text", icon: "text", labelKey: "screenshot.toolText" },
  { key: "mosaic", icon: "mosaic", labelKey: "screenshot.toolMosaic" },
];

const opsVersion = ref(0); // 历史栈变化时触发重绘
const canUndo = ref(false);
const canRedo = ref(false);

// 进行中的交互（不写入历史，松手才 push）
const draft = ref(null); // { type: 'select'|'move'|'resize'|'draw', handle?, start, lastPoint, op? }
const textEditing = ref(null); // { x, y, value }
const magnifier = reactive({ visible: false, x: 0, y: 0, color: "#000000", px: 0, py: 0 });
const notice = ref("");

let needRender = false;

// ---------------- 渲染 ----------------

function redraw() {
  const canvas = canvasRef.value;
  if (!canvas || !baseBitmap || phase.value === "loading") return;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(view.kx, 0, 0, view.ky, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.drawImage(baseBitmap, 0, 0, view.width, view.height);

  const sel = selection.value;
  const ops = history.active();
  if (sel) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(sel.x, sel.y, sel.width, sel.height);
    ctx.clip();
    for (const op of ops) drawOp(ctx, op);
    if (draft.value && draft.value.op) drawOp(ctx, draft.value.op);
    ctx.restore();
  } else if (draft.value && draft.value.op) {
    drawOp(ctx, draft.value.op);
  }

  drawMask(ctx, sel);
  if (sel) drawSelectionUi(ctx, sel);
}

/** 等两帧：第一帧把画布的栅格化结果提交给合成器，第二帧确认它已排入上屏队列 */
function nextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
}

function scheduleRender() {
  if (needRender) return;
  needRender = true;
  requestAnimationFrame(() => {
    needRender = false;
    redraw();
  });
}

function drawMask(ctx, sel) {
  ctx.save();
  ctx.fillStyle = sel ? "rgba(0, 0, 0, 0.45)" : "rgba(0, 0, 0, 0.25)";
  if (!sel) {
    ctx.fillRect(0, 0, view.width, view.height);
  } else {
    // 只暗化选区之外，且留出一条 1px 的缝避免盖住选区边框
    const { x, y, width, height } = sel;
    ctx.fillRect(0, 0, view.width, y);
    ctx.fillRect(0, y + height, view.width, view.height - y - height);
    ctx.fillRect(0, y, x, height);
    ctx.fillRect(x + width, y, view.width - x - width, height);
  }
  ctx.restore();
}

function drawSelectionUi(ctx, sel) {
  ctx.save();
  ctx.strokeStyle = "#4c9aff";
  ctx.lineWidth = 1;
  ctx.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.width - 1, sel.height - 1);
  // 手柄：白底蓝边的小方块，位置即命中区中心
  const size = 7;
  for (const handle of HANDLES) {
    const point = handlePoint(sel, handle);
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#2b6ad0";
    ctx.beginPath();
    ctx.rect(point.x - size / 2, point.y - size / 2, size, size);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function handlePoint(sel, handle) {
  return {
    x: sel.x + (handle.includes("w") ? 0 : handle.includes("e") ? sel.width : sel.width / 2),
    y: sel.y + (handle.includes("n") ? 0 : handle.includes("s") ? sel.height : sel.height / 2),
  };
}

/** 单个标注操作的绘制（屏幕预览与导出共用） */
function drawOp(ctx, op) {
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = op.color;
  ctx.fillStyle = op.color;
  ctx.lineWidth = op.width;
  if (op.kind === "marker") ctx.globalAlpha = 0.35;
  if (op.kind === "rect") {
    ctx.strokeRect(op.rect.x, op.rect.y, op.rect.width, op.rect.height);
  } else if (op.kind === "ellipse") {
    ctx.beginPath();
    ctx.ellipse(
      op.rect.x + op.rect.width / 2,
      op.rect.y + op.rect.height / 2,
      Math.max(op.rect.width / 2, 0.5),
      Math.max(op.rect.height / 2, 0.5),
      0,
      0,
      Math.PI * 2
    );
    ctx.stroke();
  } else if (op.kind === "arrow") {
    drawArrow(ctx, op.from, op.to, op.width);
  } else if (op.kind === "pen" || op.kind === "marker") {
    if (op.points.length === 1) {
      ctx.beginPath();
      ctx.arc(op.points[0].x, op.points[0].y, Math.max(op.width / 2, 0.5), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(op.points[0].x, op.points[0].y);
      for (const point of op.points.slice(1)) ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
  } else if (op.kind === "text") {
    ctx.font = `${op.size}px "Segoe UI", "Microsoft YaHei", sans-serif`;
    ctx.textBaseline = "top";
    ctx.fillText(op.text, op.x, op.y);
  } else if (op.kind === "mosaic") {
    drawMosaic(ctx, op);
  }
  ctx.restore();
}

function drawArrow(ctx, from, to, width) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const head = Math.max(10, width * 3.5);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(angle - Math.PI / 7), to.y - head * Math.sin(angle - Math.PI / 7));
  ctx.lineTo(to.x - head * Math.cos(angle + Math.PI / 7), to.y - head * Math.sin(angle + Math.PI / 7));
  ctx.closePath();
  ctx.fill();
}

/** 马赛克：从冻结帧采样到小画布再放大（预览与导出用同一份源，图案一致） */
function drawMosaic(ctx, op) {
  if (!baseCanvas) return;
  const block = 8;
  const w = Math.max(1, Math.round(op.rect.width / block));
  const h = Math.max(1, Math.round(op.rect.height / block));
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  tctx.drawImage(
    baseCanvas,
    op.rect.x * view.kx,
    op.rect.y * view.ky,
    Math.max(op.rect.width * view.kx, 1),
    Math.max(op.rect.height * view.ky, 1),
    0,
    0,
    w,
    h
  );
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, w, h, op.rect.x, op.rect.y, op.rect.width, op.rect.height);
  ctx.restore();
}

// ---------------- 交互 ----------------

function pointFromEvent(event) {
  const rect = canvasRef.value.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * view.width,
    y: ((event.clientY - rect.top) / rect.height) * view.height,
  };
}

function bounds() {
  return { width: view.width, height: view.height };
}

/** 标注坐标钳进选区（预览与导出因此完全一致：看得见的部分就是会导出的部分） */
function clampToSelection(point) {
  const sel = selection.value;
  if (!sel) return point;
  return {
    x: Math.min(Math.max(point.x, sel.x), sel.x + sel.width),
    y: Math.min(Math.max(point.y, sel.y), sel.y + sel.height),
  };
}

function onPointerDown(event) {
  if (phase.value !== "ready" || busy.value) return;
  if (event.button === 2) return; // 右键在 up 里单独处理
  getCurrentWindow().setFocus().catch(() => {});
  try {
    rootRef.value?.setPointerCapture(event.pointerId);
  } catch {
    /* 指针已失效（合成事件）：不捕获也能继续，拖动落到 root 的处理器上 */
  }
  const point = pointFromEvent(event);
  const sel = selection.value;

  if (textEditing.value) {
    commitText();
    return;
  }

  if (sel && tool.value === null) {
    const handle = hitHandle(sel, point, 7);
    if (handle) {
      draft.value = { type: "resize", handle, start: point };
      return;
    }
    if (insideRect(sel, point)) {
      draft.value = { type: "move", start: point, origin: { ...sel } };
      return;
    }
  }

  if (sel && tool.value && insideRect(sel, point)) {
    // 标注工具：按下即起笔（点一下也要能留下一个点，画笔靠这个画圆点）
    draft.value = { type: "draw", start: point, op: beginOp(tool.value, point) };
    return;
  }

  // 其余情况（含选区外、无选区、重新框选）都从这里开始一次新框选；
  // tool 保留选择，方便框选后立刻标注——Snipaste 同款手感
  selection.value = null;
  draft.value = { type: "select", start: point };
  scheduleRender();
}

function beginOp(kind, point) {
  const base = { kind, color: color.value, width: LINE_WIDTHS[widthIndex.value] };
  if (kind === "rect" || kind === "ellipse" || kind === "mosaic") {
    return { ...base, rect: { x: point.x, y: point.y, width: 0, height: 0 } };
  }
  if (kind === "arrow") return { ...base, from: { ...point }, to: { ...point } };
  return { ...base, points: [{ ...point }] };
}

function updateOp(op, start, current) {
  if (op.kind === "rect" || op.kind === "ellipse" || op.kind === "mosaic") {
    op.rect = rectFromPoints(start, current);
  } else if (op.kind === "arrow") {
    op.to = { ...current };
  } else if (op.kind === "pen" || op.kind === "marker") {
    const last = op.points[op.points.length - 1];
    if (!last || Math.hypot(current.x - last.x, current.y - last.y) >= 2) op.points.push({ ...current });
  }
}

function onPointerMove(event) {
  if (phase.value !== "ready") return;
  const point = pointFromEvent(event);
  updateMagnifier(point);

  const active = draft.value;
  if (!active) {
    updateCursor(point);
    return;
  }
  if (active.type === "select") {
    active.lastPoint = point;
    selection.value = clampRect(rectFromPoints(active.start, point), bounds());
  } else if (active.type === "move") {
    const dx = point.x - active.start.x;
    const dy = point.y - active.start.y;
    selection.value = moveRect(active.origin, dx, dy, bounds());
  } else if (active.type === "resize") {
    selection.value = resizeRect(selection.value, active.handle, point, bounds(), MIN_SELECTION);
  } else if (active.type === "draw") {
    updateOp(active.op, active.start, clampToSelection(point));
  }
  scheduleRender();
}

function onPointerUp(event) {
  if (phase.value !== "ready") return;
  if (event.button === 2) {
    // 右键：先撤当前工具 / 选区，两级都没得撤才退出截图（Esc 同款语义）
    if (textEditing.value) commitText();
    else if (tool.value) {
      tool.value = null;
      scheduleRender();
    } else if (selection.value) {
      selection.value = null;
      scheduleRender();
    } else {
      cancelSession();
    }
    return;
  }
  const active = draft.value;
  draft.value = null;
  if (!active) return;

  if (active.type === "select") {
    const points = active.lastPoint || active.start;
    const rect = clampRect(rectFromPoints(active.start, points), bounds());
    selection.value = rect.width >= MIN_SELECTION && rect.height >= MIN_SELECTION ? rect : null;
  } else if (active.type === "draw") {
    const op = active.op;
    if (op.kind === "text") {
      // 文字工具：点一下开输入框，内容确认时才入历史
      startTextInput(active.start);
      scheduleRender();
      return;
    }
    if (isMeaningfulOp(op)) {
      history.push(op);
      syncHistoryFlags();
    }
  }
  scheduleRender();
}

/** 过滤误触：一像素的框、没动过的箭头不做成操作（画笔单击留一个圆点是有效的） */
function isMeaningfulOp(op) {
  if (op.kind === "rect" || op.kind === "ellipse" || op.kind === "mosaic") {
    return op.rect.width >= 2 && op.rect.height >= 2;
  }
  if (op.kind === "arrow") {
    return Math.hypot(op.to.x - op.from.x, op.to.y - op.from.y) >= 3;
  }
  return (op.points || []).length > 0;
}

function updateCursor(point) {
  const root = rootRef.value;
  if (!root) return;
  const sel = selection.value;
  let cursor = "crosshair";
  if (sel && tool.value === null) {
    const handle = hitHandle(sel, point, 7);
    if (handle) {
      const arrows = { nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize", n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize" };
      cursor = arrows[handle];
    } else if (insideRect(sel, point)) {
      cursor = "move";
    }
  } else if (sel && tool.value) {
    cursor = "crosshair";
  }
  root.style.cursor = cursor;
}

function updateMagnifier(point) {
  // 只在「选择/调整阶段」显示，避免画图时挡住笔迹；文字输入时不显示
  const show = tool.value === null && !textEditing.value && !draft.value;
  magnifier.visible = show;
  if (!show) return;
  magnifier.x = point.x;
  magnifier.y = point.y;
  nextTick(() => drawMagnifier());
}

function drawMagnifier() {
  const canvas = magRef.value;
  if (!canvas || !baseCanvas) return;
  const ctx = canvas.getContext("2d");
  const zoom = 6;
  const cssSize = 116;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cssSize * dpr;
  canvas.height = cssSize * dpr;
  const px = Math.round(magnifier.x * view.kx);
  const py = Math.round(magnifier.y * view.ky);
  magnifier.px = px;
  magnifier.py = py;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssSize, cssSize);
  const src = (cssSize / zoom) * 0.5;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(baseCanvas, px - src, py - src, src * 2, src * 2, 0, 0, cssSize, cssSize);
  // 十字线：中心对准当前像素
  ctx.strokeStyle = "rgba(76, 154, 255, 0.9)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cssSize / 2, 0);
  ctx.lineTo(cssSize / 2, cssSize);
  ctx.moveTo(0, cssSize / 2);
  ctx.lineTo(cssSize, cssSize / 2);
  ctx.stroke();
  const pixel = baseCtx.getImageData(Math.min(Math.max(px, 0), baseCanvas.width - 1), Math.min(Math.max(py, 0), baseCanvas.height - 1), 1, 1).data;
  magnifier.color = `#${[pixel[0], pixel[1], pixel[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

// ---------------- 文字工具 ----------------

function startTextInput(point) {
  textEditing.value = { x: point.x, y: point.y, value: "" };
  nextTick(() => textInputRef.value?.focus());
}

function commitText() {
  const editing = textEditing.value;
  textEditing.value = null;
  const text = String(editing?.value || "").trim();
  if (!text) {
    scheduleRender();
    return;
  }
  history.push({
    kind: "text",
    color: color.value,
    width: LINE_WIDTHS[widthIndex.value],
    size: TEXT_SIZES[widthIndex.value],
    x: editing.x,
    y: editing.y,
    text,
  });
  syncHistoryFlags();
  scheduleRender();
}

const textInputStyle = computed(() => {
  const editing = textEditing.value;
  if (!editing) return {};
  return {
    left: `${(editing.x / view.width) * 100}%`,
    top: `${(editing.y / view.height) * 100}%`,
    color: color.value,
    fontSize: `${TEXT_SIZES[widthIndex.value]}px`,
  };
});

// ---------------- 历史 ----------------

function syncHistoryFlags() {
  canUndo.value = history.canUndo;
  canRedo.value = history.canRedo;
  opsVersion.value += 1;
}

function undo() {
  history.undo();
  syncHistoryFlags();
  scheduleRender();
}

function redo() {
  history.redo();
  syncHistoryFlags();
  scheduleRender();
}

// ---------------- 输出 ----------------

function fullScreenSelection() {
  return { x: 0, y: 0, width: view.width, height: view.height };
}

/** 合成导出图：裁切冻结帧 + 重放标注（与屏幕预览同一套 drawOp） */
async function composeSelection() {
  const sel = selection.value || fullScreenSelection();
  const phys = toPhysicalRect(sel, view.kx, view.ky, { width: view.frameWidth, height: view.frameHeight });
  const out = document.createElement("canvas");
  out.width = phys.width;
  out.height = phys.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(baseCanvas, phys.x, phys.y, phys.width, phys.height, 0, 0, phys.width, phys.height);
  ctx.setTransform(1, 0, 0, 1, -phys.x, -phys.y);
  ctx.save();
  ctx.beginPath();
  ctx.rect(sel.x * view.kx, sel.y * view.ky, phys.width, phys.height);
  ctx.clip();
  for (const op of history.active()) drawOp(ctx, op);
  ctx.restore();
  return canvasToBase64(out);
}

async function commit(action, path) {
  if (busy.value || phase.value !== "ready") return;
  if (!selection.value && !textEditing.value) {
    // 无选区按 Enter：整屏复制（快速全屏截图的常见用法）
    selection.value = fullScreenSelection();
    scheduleRender();
  }
  if (textEditing.value) commitText();
  busy.value = true;
  try {
    const sel = selection.value;
    const pinRect = sel
      ? {
          x: sel.x * view.kx,
          y: sel.y * view.ky,
          width: sel.width * view.kx,
          height: sel.height * view.ky,
        }
      : null;
    const dataB64 = await composeSelection();
    await invoke("screenshot_commit", { sessionId, action, dataB64, path, pinRect });
    phase.value = "closing"; // Rust 正在销毁所有遮罩窗，本页不用再做什么
  } catch (e) {
    busy.value = false;
    notice.value = String(e?.message || e);
    setTimeout(() => (notice.value = ""), 3200);
  }
}

async function confirmCopy() {
  await commit("copy");
}

async function confirmSave() {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const path = await save({
    defaultPath: `screenshot-${stamp}.png`,
    filters: [{ name: "PNG", extensions: ["png"] }],
  });
  if (!path) return;
  await commit("save", path);
}

async function confirmPin() {
  await commit("pin");
}

async function cancelSession() {
  if (busy.value) return;
  phase.value = "closing";
  try {
    await invoke("screenshot_cancel", { sessionId });
  } catch {
    /* Rust 侧已清 */
  }
}

// ---------------- 键盘 ----------------

function onKeydown(event) {
  if (phase.value !== "ready") return;
  const mod = event.ctrlKey || event.metaKey;
  if (event.key === "Escape") {
    event.preventDefault();
    if (textEditing.value) textEditing.value = null;
    else if (tool.value) tool.value = null;
    else if (selection.value) selection.value = null;
    else cancelSession();
    scheduleRender();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (textEditing.value) commitText();
    else confirmCopy();
    return;
  }
  if (mod && (event.key === "c" || event.key === "C")) {
    event.preventDefault();
    confirmCopy();
    return;
  }
  if (mod && (event.key === "s" || event.key === "S")) {
    event.preventDefault();
    confirmSave();
    return;
  }
  if (mod && (event.key === "z" || event.key === "Z")) {
    event.preventDefault();
    event.shiftKey ? redo() : undo();
    return;
  }
  if (mod && (event.key === "y" || event.key === "Y")) {
    event.preventDefault();
    redo();
    return;
  }
  if (event.key === "F3") {
    event.preventDefault();
    confirmPin();
    return;
  }
  if (selection.value && (event.key.startsWith("Arrow"))) {
    event.preventDefault();
    selection.value = nudgeRect(selection.value, event.key, event.shiftKey ? 10 : 1, bounds());
    scheduleRender();
  }
}

// ---------------- 工具栏布局 ----------------

const toolbarStyle = computed(() => {
  const sel = selection.value;
  if (!sel) return { display: "none" };
  const barWidth = 560;
  const x = Math.min(Math.max(sel.x + sel.width / 2 - barWidth / 2, 8), Math.max(view.width - barWidth - 8, 8));
  const below = sel.y + sel.height + 10;
  const above = sel.y - 48;
  return { left: `${x}px`, top: `${below + 48 < view.height ? below : Math.max(above, 8)}px` };
});

const sizeLabelStyle = computed(() => {
  const sel = selection.value;
  if (!sel) return { display: "none" };
  const labelWidth = 96;
  const x = Math.min(Math.max(sel.x + sel.width - labelWidth, 4), Math.max(view.width - labelWidth - 4, 4));
  const y = sel.y + sel.height + 4;
  return {
    left: `${x}px`,
    top: `${sel.y + sel.height + 54 > view.height ? Math.max(sel.y - 26, 4) : y}px`,
  };
});

const sizeLabel = computed(() => {
  const sel = selection.value;
  if (!sel) return "";
  return `${Math.round(sel.width * view.kx)} × ${Math.round(sel.height * view.ky)}`;
});

const magnifierStyle = computed(() => {
  const size = 116;
  const flipX = magnifier.x + 24 + size > view.width;
  const flipY = magnifier.y + 24 + size > view.height;
  return {
    left: `${flipX ? magnifier.x - 24 - size : magnifier.x + 24}px`,
    top: `${flipY ? magnifier.y - 24 - size : magnifier.y + 24}px`,
  };
});

// ---------------- 生命周期 ----------------

// 抓帧是「先建窗（页面开始加载）、后抓帧编码」的并行流程：帧没编好时 Rust 返回
// 「截图尚未就绪」，这里固定间隔重试到拿到帧、或超过兜底时限。
// 匹配词必须与 Rust 侧 FRAME_PENDING 一致（见 screenshot.rs）。
const FRAME_PENDING_MARK = "截图尚未就绪";
const FRAME_WAIT_DEADLINE_MS = 20000;

async function fetchFrameWithRetry() {
  const deadline = Date.now() + FRAME_WAIT_DEADLINE_MS;
  for (;;) {
    try {
      return await invoke("screenshot_frame", { sessionId, monitor: monitorIndex });
    } catch (e) {
      const message = String(e?.message || e);
      if (!message.includes(FRAME_PENDING_MARK) || Date.now() > deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  try {
    const frame = await fetchFrameWithRetry();
    const bytes = base64ToBytes(frame.pngB64);
    blobUrl = bytesToBlobUrl(bytes);
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error("冻结帧解码失败"));
      image.src = blobUrl;
    });
    baseBitmap = await createImageBitmap(image);
    baseCanvas = document.createElement("canvas");
    baseCanvas.width = frame.width;
    baseCanvas.height = frame.height;
    baseCtx = baseCanvas.getContext("2d", { willReadFrequently: true });
    baseCtx.drawImage(baseBitmap, 0, 0);

    const canvas = canvasRef.value;
    canvas.width = frame.width;
    canvas.height = frame.height;
    view.width = window.innerWidth;
    view.height = window.innerHeight;
    view.kx = frame.width / view.width;
    view.ky = frame.height / view.height;
    view.frameWidth = frame.width;
    view.frameHeight = frame.height;

    phase.value = "ready";
    redraw();
    // 首帧真正合成上屏再显窗：redraw() 只是把绘制命令排进画布，Chromium 的栅格化/合成
    // 还差一两帧——这时显窗会先闪一帧空底（页面底色）。等两帧再 show，遮罩出现的第一眼
    // 就是冻结帧本身（加载期间用户看到的则是桌面，不是任何中间态）
    await nextPaint();
    const win = getCurrentWindow();
    await win.show();
    await win.setFocus();
  } catch (e) {
    // 取帧失败（含超时）：留着遮罩窗没有意义，主动请 Rust 收掉整次会话。
    // 不在此渲染错误——窗口马上会被销毁，留个控制台线索即可
    console.error("截图遮罩取帧失败", e);
    phase.value = "closing";
    invoke("screenshot_cancel", { sessionId }).catch(() => {});
  }
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  baseBitmap?.close?.();
});
</script>

<template>
  <div ref="rootRef" class="shot-root" @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @contextmenu.prevent @dblclick="selection && confirmCopy()">
    <canvas ref="canvasRef" class="shot-canvas"></canvas>

    <textarea
      v-if="textEditing"
      ref="textInputRef"
      v-model="textEditing.value"
      class="shot-text-input"
      :style="textInputStyle"
      rows="1"
      :placeholder="t('screenshot.textPlaceholder')"
      @pointerdown.stop
      @keydown.enter.prevent="commitText"
      @keydown.esc.prevent="textEditing = null"
      @blur="commitText"
    ></textarea>

    <!-- 标注工具栏 -->
    <div v-if="selection && phase === 'ready'" class="shot-toolbar" :style="toolbarStyle" @pointerdown.stop @dblclick.stop>
      <div class="tb-group">
        <button class="tb-btn" :disabled="!canUndo" :title="t('screenshot.undo')" @click="undo"><Icon name="rotate-left" :size="15" /></button>
        <button class="tb-btn" :disabled="!canRedo" :title="t('screenshot.redo')" @click="redo"><Icon name="rotate-right" :size="15" /></button>
      </div>
      <div class="tb-sep"></div>
      <div class="tb-group">
        <button
          v-for="item in TOOLS"
          :key="item.key"
          class="tb-btn"
          :class="{ on: tool === item.key }"
          :title="t(item.labelKey)"
          @click="tool = tool === item.key ? null : item.key"
        >
          <Icon :name="item.icon" :size="15" />
        </button>
      </div>
      <div class="tb-sep"></div>
      <div class="tb-group tb-colors">
        <button
          v-for="swatch in PALETTE"
          :key="swatch"
          class="tb-swatch"
          :class="{ on: color === swatch }"
          :style="{ background: swatch }"
          @click="color = swatch"
        ></button>
        <label class="tb-swatch tb-custom" :title="t('screenshot.customColor')">
          <input type="color" v-model="color" />
        </label>
      </div>
      <div class="tb-sep"></div>
      <div class="tb-group">
        <button
          v-for="(w, i) in LINE_WIDTHS"
          :key="w"
          class="tb-btn tb-width"
          :class="{ on: widthIndex === i }"
          :title="t('screenshot.lineWidth')"
          @click="widthIndex = i"
        >
          <span class="tb-dot" :style="{ width: `${4 + i * 4}px`, height: `${4 + i * 4}px` }"></span>
        </button>
      </div>
      <div class="tb-sep"></div>
      <div class="tb-group">
        <button class="tb-btn primary" :title="t('screenshot.copyTip')" @click="confirmCopy"><Icon name="copy" :size="14" />{{ t("screenshot.copy") }}</button>
        <button class="tb-btn" :title="t('screenshot.saveTip')" @click="confirmSave"><Icon name="download" :size="14" />{{ t("screenshot.save") }}</button>
        <button class="tb-btn" :title="t('screenshot.pinTip')" @click="confirmPin"><Icon name="pin" :size="14" />{{ t("screenshot.pin") }}</button>
        <button class="tb-btn" :title="t('screenshot.cancelTip')" @click="cancelSession"><Icon name="x" :size="14" /></button>
      </div>
    </div>

    <!-- 尺寸标签 -->
    <div v-if="selection" class="shot-size" :style="sizeLabelStyle">{{ sizeLabel }}</div>

    <!-- 放大镜 -->
    <div v-if="magnifier.visible && phase === 'ready'" class="shot-magnifier" :style="magnifierStyle">
      <canvas ref="magRef" class="mag-canvas"></canvas>
      <div class="mag-meta">
        <span class="mag-dot" :style="{ background: magnifier.color }"></span>
        <span class="mag-color">{{ magnifier.color }}</span>
        <span class="mag-pos">{{ magnifier.px }}, {{ magnifier.py }}</span>
      </div>
    </div>

    <!-- 快捷键提示 -->
    <div v-if="phase === 'ready'" class="shot-hint">{{ t("screenshot.hint") }}</div>

    <div v-if="notice" class="shot-notice">{{ notice }}</div>
  </div>
</template>

<style scoped>
/* 遮罩页恒为深色工具风：不跟随应用主题（截图场景下深色底不抢内容） */
.shot-root {
  position: fixed;
  inset: 0;
  overflow: hidden;
  background: #0b0e14;
  cursor: crosshair;
  user-select: none;
  color: #e6edf3;
  font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
}
.shot-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }

.shot-toolbar {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 6px 8px;
  background: rgba(22, 27, 34, 0.96);
  border: 1px solid #30363d;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
  z-index: 10;
  white-space: nowrap;
}
.tb-group { display: flex; align-items: center; gap: 2px; }
.tb-sep { width: 1px; height: 20px; background: #30363d; margin: 0 6px; }
.tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 28px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: none;
  color: #c9d1d9;
  font-size: 12.5px;
  cursor: pointer;
}
.tb-btn:hover { background: #21262d; color: #ffffff; }
.tb-btn.on { background: #1a3352; border-color: #2b6ad0; color: #79c0ff; }
.tb-btn:disabled { opacity: 0.4; cursor: default; }
.tb-btn.primary { background: #2b6ad0; border-color: #2b6ad0; color: #ffffff; }
.tb-btn.primary:hover { background: #3b7ae0; }
.tb-swatch { width: 18px; height: 18px; padding: 0; border-radius: 5px; border: 1px solid rgba(255, 255, 255, 0.35); cursor: pointer; }
.tb-swatch.on { outline: 2px solid #4c9aff; outline-offset: 1px; }
.tb-custom { position: relative; overflow: hidden; background: conic-gradient(#e5484d, #f5a623, #2ecc71, #0ea5e9, #8b5cf6, #e5484d); }
.tb-custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.tb-dot { display: inline-block; background: #c9d1d9; border-radius: 50%; }
.tb-btn.on .tb-dot { background: #79c0ff; }

.shot-size {
  position: absolute;
  min-width: 92px;
  padding: 3px 8px;
  background: rgba(22, 27, 34, 0.96);
  border: 1px solid #30363d;
  border-radius: 6px;
  font-size: 12px;
  text-align: center;
  font-variant-numeric: tabular-nums;
  z-index: 9;
  pointer-events: none;
}

.shot-text-input {
  position: absolute;
  min-width: 140px;
  padding: 2px 4px;
  background: rgba(22, 27, 34, 0.9);
  border: 1px dashed #4c9aff;
  border-radius: 4px;
  font-family: inherit;
  outline: none;
  resize: none;
  z-index: 11;
}

.shot-magnifier {
  position: absolute;
  width: 116px;
  z-index: 12;
  pointer-events: none;
  background: rgba(22, 27, 34, 0.96);
  border: 1px solid #30363d;
  border-radius: 8px;
  overflow: hidden;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.mag-canvas { display: block; width: 116px; height: 116px; }
.mag-meta { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 11px; font-variant-numeric: tabular-nums; }
.mag-dot { width: 10px; height: 10px; border-radius: 3px; border: 1px solid rgba(255, 255, 255, 0.35); }
.mag-color { color: #c9d1d9; }
.mag-pos { margin-left: auto; color: #8b949e; }

.shot-hint {
  position: absolute;
  left: 12px;
  bottom: 10px;
  padding: 4px 10px;
  background: rgba(22, 27, 34, 0.85);
  border-radius: 7px;
  font-size: 12px;
  color: #8b949e;
  z-index: 8;
  pointer-events: none;
}

.shot-notice {
  position: absolute;
  left: 50%;
  bottom: 42px;
  transform: translateX(-50%);
  max-width: 60vw;
  padding: 8px 16px;
  background: rgba(207, 34, 46, 0.92);
  border-radius: 8px;
  font-size: 13px;
  z-index: 20;
}
</style>
