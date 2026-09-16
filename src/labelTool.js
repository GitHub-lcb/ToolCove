// 标签打印（TSPL）工具的纯逻辑：默认值、选项表、设置归一化与预览几何。
// 排版与指令生成在 Rust 侧（src-tauri/src/label.rs）单一实现，这里只负责「表单 ↔ IPC」之间
// 可单测的那部分，保证坏配置不会把 serde 反序列化搞崩、预览比例算得准。

/** 与 Rust 侧 LabelSpec/JobSpec 的 serde 默认值保持一致（改一处要改两处）。 */
export const DEFAULT_SETTINGS = Object.freeze({
  printer: "",
  label: {
    widthMm: 50,
    heightMm: 30,
    media: "gap",
    gapMm: 2,
    gapOffsetMm: 0,
    blackMarkMm: 0,
    dpi: 203,
    speed: 4,
    density: 8,
    direction: 1,
    marginX: 8,
    marginY: 8,
    codepage936: false,
  },
  job: {
    text: "测试标签\nTest Label",
    font: "chinese24",
    xMult: 1,
    yMult: 1,
    lineGap: 4,
    blockGap: 10,
    align: "center",
    valign: "center",
    barcode: { enabled: false, data: "", symbology: "code128", height: 60, narrow: 2, wide: 4, readable: true, align: "center" },
    qr: { enabled: false, data: "", cell: 4, ecc: "m", align: "center" },
    copies: 1,
  },
});

/** 输入范围：既给表单 min/max，也给归一化做钳制（与 Rust 的 clamp 对齐）。 */
export const LIMITS = Object.freeze({
  widthMm: [10, 80],
  heightMm: [5, 150],
  gapMm: [0, 10],
  gapOffsetMm: [-10, 10],
  blackMarkMm: [0, 20],
  density: [0, 15],
  speed: [1, 6],
  marginX: [0, 120],
  marginY: [0, 120],
  xMult: [1, 10],
  yMult: [1, 10],
  lineGap: [0, 80],
  blockGap: [0, 160],
  copies: [1, 999],
  barcodeHeight: [20, 200],
  barcodeNarrow: [1, 10],
  barcodeWide: [1, 10],
  qrCell: [1, 10],
});

/** 常见标签纸规格（GP-2120TF 随机 50×30mm）。 */
export const LABEL_PRESETS = Object.freeze([
  { widthMm: 50, heightMm: 30, gapMm: 2 },
  { widthMm: 40, heightMm: 30, gapMm: 2 },
  { widthMm: 60, heightMm: 40, gapMm: 2 },
  { widthMm: 50, heightMm: 40, gapMm: 2 },
  { widthMm: 40, heightMm: 20, gapMm: 2 },
  { widthMm: 30, heightMm: 20, gapMm: 2 },
]);

/** 打印机内置点阵字体（value 即 Rust Font 枚举名）。 */
export const FONT_OPTIONS = Object.freeze([
  { value: "chinese24", labelKey: "toolbox.label.fontChinese24" },
  { value: "ascii1", labelKey: "toolbox.label.fontAscii1" },
  { value: "ascii2", labelKey: "toolbox.label.fontAscii2" },
  { value: "ascii3", labelKey: "toolbox.label.fontAscii3" },
  { value: "ascii4", labelKey: "toolbox.label.fontAscii4" },
  { value: "ascii5", labelKey: "toolbox.label.fontAscii5" },
]);

export const SYMBOLOGY_OPTIONS = Object.freeze([
  "code128",
  "code39",
  "ean13",
  "ean8",
  "upcA",
  "itf14",
  "codabar",
]);

export const ECC_OPTIONS = Object.freeze(["l", "m", "q", "h"]);
export const MEDIA_OPTIONS = Object.freeze(["gap", "blackMark", "continuous"]);
export const ALIGN_OPTIONS = Object.freeze(["left", "center", "right"]);
export const VALIGN_OPTIONS = Object.freeze(["top", "center", "bottom"]);

/** 体检结论错误码：前端按 `toolbox.label.issue.<code>` 取文案（键缺失时回退 unknown）。 */
export const ISSUE_CODES = Object.freeze([
  "paperTooWide",
  "mediaRange",
  "asciiFontChinese",
  "barcodeEmpty",
  "barcodeTooWide",
  "qrTooWide",
  "contentOverflow",
  "printerMissing",
  "printerNotLabel",
]);

const ISSUE_KEY_PREFIX = "toolbox.label.issue.";

/** 预览台左右内边距 + 边框（CSS 像素），与样式里的 .bench 内边距同步。 */
export const BENCH_INSET = 34;
/** 预览画布高度上限（CSS 像素）。 */
export const PREVIEW_MAX_H = 300;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function clampNumber(value, [min, max], fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function pickEnum(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function pickText(value, fallback) {
  return typeof value === "string" ? value : fallback;
}

function pickBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeLabel(raw = {}) {
  const d = DEFAULT_SETTINGS.label;
  const src = isPlainObject(raw) ? raw : {};
  return {
    widthMm: clampNumber(src.widthMm, LIMITS.widthMm, d.widthMm),
    heightMm: clampNumber(src.heightMm, LIMITS.heightMm, d.heightMm),
    media: pickEnum(src.media, MEDIA_OPTIONS, d.media),
    gapMm: clampNumber(src.gapMm, LIMITS.gapMm, d.gapMm),
    gapOffsetMm: clampNumber(src.gapOffsetMm, LIMITS.gapOffsetMm, d.gapOffsetMm),
    blackMarkMm: clampNumber(src.blackMarkMm, LIMITS.blackMarkMm, d.blackMarkMm),
    dpi: clampNumber(src.dpi, [72, 600], d.dpi),
    speed: clampNumber(src.speed, LIMITS.speed, d.speed),
    density: clampNumber(src.density, LIMITS.density, d.density),
    direction: pickEnum(src.direction, [0, 1], d.direction),
    marginX: clampNumber(src.marginX, LIMITS.marginX, d.marginX),
    marginY: clampNumber(src.marginY, LIMITS.marginY, d.marginY),
    codepage936: pickBool(src.codepage936, d.codepage936),
  };
}

function normalizeJob(raw = {}) {
  const d = DEFAULT_SETTINGS.job;
  const src = isPlainObject(raw) ? raw : {};
  const bc = isPlainObject(src.barcode) ? src.barcode : {};
  const qr = isPlainObject(src.qr) ? src.qr : {};
  return {
    text: pickText(src.text, d.text),
    font: pickEnum(src.font, FONT_OPTIONS.map((f) => f.value), d.font),
    xMult: clampNumber(src.xMult, LIMITS.xMult, d.xMult),
    yMult: clampNumber(src.yMult, LIMITS.yMult, d.yMult),
    lineGap: clampNumber(src.lineGap, LIMITS.lineGap, d.lineGap),
    blockGap: clampNumber(src.blockGap, LIMITS.blockGap, d.blockGap),
    align: pickEnum(src.align, ALIGN_OPTIONS, d.align),
    valign: pickEnum(src.valign, VALIGN_OPTIONS, d.valign),
    barcode: {
      enabled: pickBool(bc.enabled, d.barcode.enabled),
      data: pickText(bc.data, d.barcode.data),
      symbology: pickEnum(bc.symbology, SYMBOLOGY_OPTIONS, d.barcode.symbology),
      height: clampNumber(bc.height, LIMITS.barcodeHeight, d.barcode.height),
      narrow: clampNumber(bc.narrow, LIMITS.barcodeNarrow, d.barcode.narrow),
      wide: clampNumber(bc.wide, LIMITS.barcodeWide, d.barcode.wide),
      readable: pickBool(bc.readable, d.barcode.readable),
      align: pickEnum(bc.align, ALIGN_OPTIONS, d.barcode.align),
    },
    qr: {
      enabled: pickBool(qr.enabled, d.qr.enabled),
      data: pickText(qr.data, d.qr.data),
      cell: clampNumber(qr.cell, LIMITS.qrCell, d.qr.cell),
      ecc: pickEnum(qr.ecc, ECC_OPTIONS, d.qr.ecc),
      align: pickEnum(qr.align, ALIGN_OPTIONS, d.qr.align),
    },
    copies: clampNumber(src.copies, LIMITS.copies, d.copies),
  };
}

/**
 * 归一化设置：合并默认值、丢弃非法枚举值、钳制数值范围。
 * 存储里的旧数据/手改数据都不能让 Rust 侧反序列化失败（枚举名不认识会直接报错）。
 */
export function normalizeSettings(raw) {
  const src = isPlainObject(raw) ? raw : {};
  return {
    printer: pickText(src.printer, DEFAULT_SETTINGS.printer),
    label: normalizeLabel(src.label),
    job: normalizeJob(src.job),
  };
}

/** 深度克隆成纯 JSON 值：落盘与 IPC 都不接受响应式代理。 */
export function plainSettings(settings) {
  return JSON.parse(JSON.stringify(settings));
}

/**
 * 预览几何：把「打印点」换算成 CSS 像素。
 * 底纹一格 = 1 毫米时，网格间距就是 pxPerMm，可以直接比划尺寸。
 */
export function previewGeometry({ benchWidth = 380, dotW = 400, dotH = 240, widthMm = 50, gapDots = 0 } = {}) {
  const availW = Math.max(120, Number(benchWidth) - BENCH_INSET);
  const safeDotW = Math.max(1, Number(dotW) || 1);
  const safeDotH = Math.max(1, Number(dotH) || 1);
  const scale = Math.min(availW / safeDotW, PREVIEW_MAX_H / safeDotH);
  const mmW = Number(widthMm) > 0 ? Number(widthMm) : 0;
  const pxPerMm = mmW > 0 ? scale * (safeDotW / mmW) : scale * 8;
  return {
    scale,
    pxPerMm,
    cssW: safeDotW * scale,
    cssH: safeDotH * scale,
    gapPx: Math.max(0, Number(gapDots) || 0) * scale,
  };
}

/** 数据量展示：1536 → "1.5 KB"。 */
export function formatBytes(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 体检结论的 i18n 键；未知错误码回退到 issue.unknown（不让界面露出裸键）。 */
export function issueKey(code) {
  return ISSUE_CODES.includes(code) ? ISSUE_KEY_PREFIX + code : ISSUE_KEY_PREFIX + "unknown";
}

/**
 * 渲染一条体检结论：`toolbox.label.issue.<code>` + 参数插值。
 * 字典里每个错误码都有词条（labelTool.test.js 会校验），未知码回退到 issue.unknown，
 * 不让界面露出裸键。
 */
export function issueMessage(issue, t) {
  const code = String(issue?.code ?? "");
  if (!ISSUE_CODES.includes(code)) return t(ISSUE_KEY_PREFIX + "unknown", { code });
  return t(ISSUE_KEY_PREFIX + code, issue?.params || {});
}

/** TSPL 指令文本 → 行数组（TSPL 用 CRLF）。 */
export function sourceLines(source) {
  return String(source ?? "").split(/\r?\n/);
}

/** 打印机下拉项文案：默认机加标记。 */
export function printerLabel(printer, defaultSuffix = "") {
  const name = printer?.name ?? "";
  return printer?.isDefault && defaultSuffix ? `${name} ${defaultSuffix}` : name;
}
