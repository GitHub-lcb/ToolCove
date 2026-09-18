// 标签打印工具纯逻辑单测。
// 除了常规默认值/钳制/几何计算，这里还做两件事：
//   1. 用 Rust 源文件做「跨语言契约」校验：枚举名与结构体字段必须与 JS 送过去的 JSON 对得上
//      （serde 认不出的字段会被 default 静默吞掉，错一个字母就变成「设置莫名其妙不生效」）
//   2. 校验动态拼接的 i18n 键在中英字典里都存在（align_*/sym_*/issue.* 这类键没有静态引用）
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import zh from "./i18n/zh-CN.json";
import en from "./i18n/en-US.json";
import {
  ALIGN_OPTIONS, DEFAULT_SETTINGS, ECC_OPTIONS, FONT_OPTIONS, ISSUE_CODES, LABEL_PRESETS, LIMITS,
  MEDIA_OPTIONS, SYMBOLOGY_OPTIONS, VALIGN_OPTIONS,
  formatBytes, issueKey, issueMessage, normalizeSettings, plainSettings, previewGeometry, printerLabel, sourceLines,
} from "./labelTool.js";

function get(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

function camel(name) {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * 契约锚点：TSPL 的**数据模型与枚举**已经搬到 crates/label-core（纯逻辑，桌面端与手机端共用），
 * 平台相关的部分（打印机列表、打印命令）留在 src-tauri/src/label.rs。
 *
 * 所以这里要把两处都读进来：跨语言契约校验的是**字段名与取值**，与文件位置无关——
 * 搬移不该让契约失效，但读的文件必须跟着搬（否则测试会因为"找不到声明"而假失败）。
 */
const rustSource = ["crates/label-core/src/lib.rs", "src-tauri/src/label.rs", "src-tauri/src/printer.rs"]
  .map((rel) => readFileSync(resolve(process.cwd(), rel), "utf8"))
  .join("\n");

/** 从 Rust 源码里取指定声明的主体（花括号配对，嵌套的 struct 变体也能取全）。 */
function rustBlock(header) {
  const start = rustSource.indexOf(header);
  if (start < 0) throw new Error(`label-core / label.rs 里找不到 ${header}`);
  const open = rustSource.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < rustSource.length; i += 1) {
    if (rustSource[i] === "{") depth += 1;
    else if (rustSource[i] === "}") {
      depth -= 1;
      if (depth === 0) return rustSource.slice(open + 1, i);
    }
  }
  throw new Error(`${header} 的花括号没有闭合`);
}

/** 主体里的 pub 字段名 → camelCase（serde rename_all = "camelCase"）。 */
function rustFieldsOf(header) {
  return [...rustBlock(header).matchAll(/pub ([a-z0-9_]+):/g)].map((m) => snakeToCamel(m[1])).sort();
}

/** 从 label.rs 里取枚举变体名（跳过文档注释）。 */
function rustEnumVariants(name) {
  const match = new RegExp(`pub enum ${name} \\{([^}]*)\\}`).exec(rustSource);
  if (!match) throw new Error(`label.rs 里找不到枚举 ${name}`);
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Za-z0-9]*,?$/.test(line))
    .map((line) => line.replace(/,$/, ""));
}

/** 从 label.rs 里取结构体字段名（跳过文档注释、嵌套体由 default 兜底）。 */
function rustStructFields(name) {
  const match = new RegExp(`pub struct ${name} \\{([^}]*)\\}`).exec(rustSource);
  if (!match) throw new Error(`label.rs 里找不到结构体 ${name}`);
  return match[1]
    .split("\n")
    .map((line) => line.trim())
    .map((line) => /^pub ([a-z0-9_]+):/.exec(line))
    .filter(Boolean)
    .map((m) => m[1]);
}

function snakeToCamel(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

describe("normalizeSettings", () => {
  it("默认值原样通过，且可重复归一化", () => {
    const once = normalizeSettings(DEFAULT_SETTINGS);
    expect(once).toEqual(plainSettings(DEFAULT_SETTINGS));
    expect(normalizeSettings(once)).toEqual(once);
  });

  it("缺失/脏值回退到默认值，不让 Rust 反序列化失败", () => {
    const s = normalizeSettings({ label: { media: "不存在的纸张", widthMm: "abc" }, job: { text: 42, font: "comic" } });
    expect(s.label.media).toBe("gap");
    expect(s.label.widthMm).toBe(50);
    expect(s.job.text).toBe(DEFAULT_SETTINGS.job.text);
    expect(s.job.font).toBe("chinese24");
  });

  it("数值钳制到输入范围", () => {
    const s = normalizeSettings({
      label: { widthMm: 999, density: -3, marginX: 500 },
      job: { copies: 0, xMult: 99, barcode: { height: 5, narrow: 0 }, qr: { cell: 88 } },
    });
    expect(s.label.widthMm).toBe(LIMITS.widthMm[1]);
    expect(s.label.density).toBe(0);
    expect(s.label.marginX).toBe(LIMITS.marginX[1]);
    expect(s.job.copies).toBe(LIMITS.copies[0]);
    expect(s.job.xMult).toBe(LIMITS.xMult[1]);
    expect(s.job.barcode.height).toBe(LIMITS.barcodeHeight[0]);
    expect(s.job.barcode.narrow).toBe(LIMITS.barcodeNarrow[0]);
    expect(s.job.qr.cell).toBe(LIMITS.qrCell[1]);
  });

  it("非对象输入（null / 数组 / 字符串）也能得到完整默认设置", () => {
    for (const raw of [null, undefined, [], "x", 7]) {
      expect(normalizeSettings(raw)).toEqual(plainSettings(DEFAULT_SETTINGS));
    }
  });

  it("保留布尔开关与文本内容", () => {
    const s = normalizeSettings({
      printer: "Gprinter GP-2120TF",
      label: { codepage936: true },
      job: { text: "中文", barcode: { enabled: true, readable: false } },
    });
    expect(s.printer).toBe("Gprinter GP-2120TF");
    expect(s.label.codepage936).toBe(true);
    expect(s.job.text).toBe("中文");
    expect(s.job.barcode.enabled).toBe(true);
    expect(s.job.barcode.readable).toBe(false);
  });
});

describe("与 Rust 侧的契约（serde 名称）", () => {
  it("枚举选项与 label.rs 的 camelCase 变体名一致", () => {
    // 字体顺序故意把中文点阵放最前（默认选项），所以按集合比对而不是按顺序
    expect([...MEDIA_OPTIONS].sort()).toEqual(rustEnumVariants("Media").map(camel).sort());
    expect(FONT_OPTIONS.map((f) => f.value).sort()).toEqual(rustEnumVariants("Font").map(camel).sort());
    expect([...ALIGN_OPTIONS].sort()).toEqual(rustEnumVariants("Align").map(camel).sort());
    expect([...VALIGN_OPTIONS].sort()).toEqual(rustEnumVariants("VAlign").map(camel).sort());
    expect([...SYMBOLOGY_OPTIONS].sort()).toEqual(rustEnumVariants("Symbology").map(camel).sort());
    expect([...ECC_OPTIONS].sort()).toEqual(rustEnumVariants("Ecc").map(camel).sort());
  });

  it("设置字段与 label.rs 的结构体字段一一对应", () => {
    expect(Object.keys(DEFAULT_SETTINGS).sort()).toEqual(rustStructFields("Settings").map(snakeToCamel).sort());
    expect(Object.keys(DEFAULT_SETTINGS.label).sort()).toEqual(rustStructFields("LabelSpec").map(snakeToCamel).sort());
    expect(Object.keys(DEFAULT_SETTINGS.job).sort()).toEqual(rustStructFields("JobSpec").map(snakeToCamel).sort());
    expect(Object.keys(DEFAULT_SETTINGS.job.barcode).sort()).toEqual(rustStructFields("BarcodeSpec").map(snakeToCamel).sort());
    expect(Object.keys(DEFAULT_SETTINGS.job.qr).sort()).toEqual(rustStructFields("QrSpec").map(snakeToCamel).sort());
  });

  it("默认值与 label.rs 的 Default 一致（抽样：纸张 50×30、浓度 8、速度 4、203dpi）", () => {
    expect(DEFAULT_SETTINGS.label).toMatchObject({ widthMm: 50, heightMm: 30, gapMm: 2, dpi: 203, density: 8, speed: 4, marginX: 8, marginY: 8 });
    expect(DEFAULT_SETTINGS.job).toMatchObject({ font: "chinese24", xMult: 1, yMult: 1, lineGap: 4, blockGap: 10, align: "center", valign: "center", copies: 1 });
    expect(rustSource).toContain("width_mm: 50.0");
    expect(rustSource).toContain("density: 8");
    expect(rustSource).toContain("dpi: 203");
  });

  // 回包字段名没有任何编译期检查：Rust 改名而前端照旧读，只会静默变成 undefined
  it("回包结构与前端读取的字段一致", () => {
    expect(rustFieldsOf("pub struct Render")).toEqual(
      ["barcodeOk", "bytes", "canvasH", "canvasW", "gapDots", "issues", "items", "printerOk", "qrOk", "source"].sort()
    );
    expect(rustFieldsOf("pub struct Issue")).toEqual(["code", "level", "params"]);
    expect(rustFieldsOf("pub struct PrinterList")).toEqual(["printers", "suggested"]);
    expect(rustFieldsOf("pub struct PrinterInfo")).toEqual(["isDefault", "name"]);
    expect(rustFieldsOf("pub struct PrintReceipt")).toEqual(["bytes", "copies", "elapsedMs", "printer"]);
  });

  it("Rust 抛出的体检错误码都登记在 ISSUE_CODES（否则界面只能显示 unknown）", () => {
    const emitted = [...rustSource.matchAll(/Issue::(?:warn|info)\(\s*"([A-Za-z]+)"/g)].map((m) => m[1]);
    expect(emitted.length).toBeGreaterThan(0);
    for (const code of emitted) expect(ISSUE_CODES, code).toContain(code);
  });

  it("绘制模型的 kind 与字段和前端画布一致", () => {
    const variants = {};
    // 枚举变体的字段没有 pub 关键字，按「行首 字段名:」取（注释行以 / 开头，不会误命中）
    for (const match of rustBlock("pub enum DrawItem").matchAll(/([A-Z][A-Za-z0-9]*)\s*\{([^}]*)\}/g)) {
      variants[camel(match[1])] = [...match[2].matchAll(/(?:^|\n)\s*([a-z0-9_]+):/g)].map((m) => snakeToCamel(m[1])).sort();
    }
    expect(variants).toEqual({
      text: ["size", "text", "width", "x", "y"].sort(),
      barcode: ["height", "label", "labelSize", "modules", "narrow", "width", "x", "y"].sort(),
      qr: ["bits", "cell", "size", "x", "y"].sort(),
    });
  });
});

describe("previewGeometry", () => {
  it("50×30mm 标签（400×240 点）在 380px 台上按宽度铺满", () => {
    const geo = previewGeometry({ benchWidth: 380, dotW: 400, dotH: 240, widthMm: 50, gapDots: 16 });
    // 可用宽 380 - 34 = 346 → scale = 346/400
    expect(geo.scale).toBeCloseTo(346 / 400, 6);
    expect(geo.cssW).toBeCloseTo(346, 4);
    expect(geo.cssH).toBeCloseTo(240 * (346 / 400), 4);
    expect(geo.pxPerMm).toBeCloseTo((346 / 400) * 8, 4); // 203dpi：1mm = 8 点
    expect(geo.gapPx).toBeCloseTo(16 * (346 / 400), 4);
  });

  it("长标签按高度封顶，不会把预览撑出面板", () => {
    const geo = previewGeometry({ benchWidth: 800, dotW: 400, dotH: 1200, widthMm: 50, gapDots: 0 });
    expect(geo.cssH).toBeLessThanOrEqual(300.0001);
    expect(geo.scale).toBeCloseTo(300 / 1200, 6);
  });

  it("台面很窄时仍有最小可用宽度，且间隙不为负", () => {
    const geo = previewGeometry({ benchWidth: 0, dotW: 400, dotH: 240, widthMm: 50, gapDots: -5 });
    expect(geo.scale).toBeGreaterThan(0);
    expect(geo.gapPx).toBe(0);
  });
});

describe("formatBytes", () => {
  it("按量级切换单位", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 * 2)).toBe("2.00 MB");
  });

  it("非法值给出占位符而不是 NaN", () => {
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(-1)).toBe("—");
  });
});

describe("体检文案", () => {
  const t = (key, params) => `${key}${params && Object.keys(params).length ? `|${JSON.stringify(params)}` : ""}`;

  it("已知错误码走 issue.<code> 并带上参数", () => {
    expect(issueMessage({ code: "paperTooWide", params: { widthMm: "80.0" } }, t)).toBe('toolbox.label.issue.paperTooWide|{"widthMm":"80.0"}');
    expect(issueKey("barcodeEmpty")).toBe("toolbox.label.issue.barcodeEmpty");
  });

  it("未知错误码回退到 unknown，不露出裸键", () => {
    expect(issueMessage({ code: "brandNew" }, t)).toBe('toolbox.label.issue.unknown|{"code":"brandNew"}');
    expect(issueKey("brandNew")).toBe("toolbox.label.issue.unknown");
  });

  it("ISSUE_CODES 每个码在中英字典里都有词条（含 unknown）", () => {
    for (const code of [...ISSUE_CODES, "unknown"]) {
      const key = `toolbox.label.issue.${code}`;
      expect(get(zh, key), `zh ${key}`).toBeTypeOf("string");
      expect(get(en, key), `en ${key}`).toBeTypeOf("string");
    }
  });

  it("动态拼接的选项词条在中英字典里都存在", () => {
    const keys = [
      ...ALIGN_OPTIONS.map((a) => `toolbox.label.align_${a}`),
      ...VALIGN_OPTIONS.map((v) => `toolbox.label.valign_${v}`),
      ...SYMBOLOGY_OPTIONS.map((s) => `toolbox.label.sym_${s}`),
      ...ECC_OPTIONS.map((e) => `toolbox.label.ecc_${e}`),
      ...MEDIA_OPTIONS.map((m) => `toolbox.label.media_${m}`),
      ...FONT_OPTIONS.map((f) => f.labelKey),
      "toolbox.registry.toolLabel",
      "toolbox.registry.toolLabelDesc",
    ];
    for (const key of keys) {
      expect(get(zh, key), `zh ${key}`).toBeTypeOf("string");
      expect(get(en, key), `en ${key}`).toBeTypeOf("string");
    }
  });
});

describe("杂项", () => {
  it("TSPL 文本按行拆分（CRLF 不留下空行）", () => {
    expect(sourceLines("SIZE 50 mm,30 mm\r\nCLS\r\nPRINT 1,1\r\n")).toEqual(["SIZE 50 mm,30 mm", "CLS", "PRINT 1,1", ""]);
    expect(sourceLines(undefined)).toEqual([""]);
  });

  it("默认打印机在下拉里带标记", () => {
    expect(printerLabel({ name: "Gprinter GP-2120TF", isDefault: true }, "（默认）")).toBe("Gprinter GP-2120TF （默认）");
    expect(printerLabel({ name: "Fax", isDefault: false }, "（默认）")).toBe("Fax");
    expect(printerLabel(null, "（默认）")).toBe("");
  });

  it("常用规格都是正数且互不重复", () => {
    const seen = new Set();
    for (const preset of LABEL_PRESETS) {
      expect(preset.widthMm).toBeGreaterThan(0);
      expect(preset.heightMm).toBeGreaterThan(0);
      const key = `${preset.widthMm}x${preset.heightMm}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});
