import { describe, expect, it } from "vitest";
import {
  aspectRatioLabel,
  buildImageOutputName,
  calculateCenterCrop,
  calculateContainSize,
  calculateRenderPlan,
  clampQuality,
  encodeBmp,
  extractPaletteFromPixels,
  extractSvgFromAiText,
  formatPaletteCss,
  formatPaletteJson,
  buildLetterIconSvg,
  hexToRgb,
  iconOutputName,
  imageFormat,
  parseExif,
  rgbToHex,
  rgbToHsl,
  resizeWithAspect,
  sanitizeSvg,
} from "./imageTool.js";

describe("图片格式与命名", () => {
  it("识别输出格式并限制质量范围", () => {
    expect(imageFormat("webp")).toMatchObject({ mime: "image/webp", extension: "webp" });
    expect(imageFormat("unknown").key).toBe("png");
    expect(clampQuality(2)).toBe(1);
    expect(clampQuality(0)).toBe(0.8);
  });

  it("生成单张和批量输出名称", () => {
    expect(buildImageOutputName("C:\\photos\\demo.PNG", { format: "jpeg", suffix: "-small" })).toBe("demo-small.jpg");
    expect(buildImageOutputName("demo", { format: "webp", prefix: "web-", index: 3, padding: 3 })).toBe("web-demo_003.webp");
  });
});

describe("图片尺寸计算", () => {
  it("在边界内等比缩放且默认不放大", () => {
    expect(calculateContainSize(4000, 3000, 1200, 1200)).toMatchObject({ width: 1200, height: 900 });
    expect(calculateContainSize(400, 300, 1200, 1200)).toMatchObject({ width: 400, height: 300 });
    expect(calculateContainSize(400, 300, 1200, 1200, true)).toMatchObject({ width: 1200, height: 900 });
  });

  it("计算横图和竖图的居中裁剪区域", () => {
    expect(calculateCenterCrop(1600, 900, 1)).toEqual({ x: 350, y: 0, width: 900, height: 900 });
    expect(calculateCenterCrop(900, 1600, 16 / 9)).toEqual({ x: 0, y: 547, width: 900, height: 506 });
    expect(calculateCenterCrop(800, 600, 0)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("旋转 90 度时交换输出宽高并保留翻转设置", () => {
    expect(calculateRenderPlan(1600, 900, { width: 800, height: 450, rotation: 90, flipX: true })).toMatchObject({
      drawWidth: 800, drawHeight: 450, outputWidth: 450, outputHeight: 800, rotation: 90, flipX: true,
    });
  });

  it("锁定比例时根据修改方向计算另一边", () => {
    expect(resizeWithAspect(1920, 1080, 1280, 0, "width")).toEqual({ width: 1280, height: 720 });
    expect(resizeWithAspect(1920, 1080, 0, 540, "height")).toEqual({ width: 960, height: 540 });
    expect(aspectRatioLabel(1920, 1080)).toBe("16:9");
  });

  it("拒绝无效尺寸", () => {
    expect(() => calculateContainSize(0, 100, 50, 50)).toThrow("图片宽度必须大于 0");
  });
});

describe("EXIF 解析", () => {
  it("非 JPEG 或损坏数据返回空对象", () => {
    expect(parseExif(new Uint8Array([1, 2, 3, 4]).buffer)).toEqual({});
    expect(parseExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 99]).buffer)).toEqual({});
  });

  it("读取 JPEG 中的相机厂商与方向", () => {
    const bytes = new Uint8Array(60);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 0xffd8, false);
    view.setUint16(2, 0xffe1, false);
    view.setUint16(4, 56, false);
    "Exif\0\0".split("").forEach((char, index) => view.setUint8(6 + index, char.charCodeAt(0)));
    view.setUint16(12, 0x4949, false);
    view.setUint16(14, 42, true);
    view.setUint32(16, 8, true);
    view.setUint16(20, 2, true);
    view.setUint16(22, 0x010f, true);
    view.setUint16(24, 2, true);
    view.setUint32(26, 6, true);
    view.setUint32(30, 38, true);
    view.setUint16(34, 0x0112, true);
    view.setUint16(36, 3, true);
    view.setUint32(38, 1, true);
    view.setUint16(42, 6, true);
    "Canon\0".split("").forEach((char, index) => view.setUint8(50 + index, char.charCodeAt(0)));
    expect(parseExif(bytes.buffer)).toMatchObject({ make: "Canon", orientation: 6 });
  });
});

describe("BMP 编码", () => {
  it("输出合法的 24 位 BMP 文件头与 BGR 像素", () => {
    const bytes = encodeBmp(1, 1, new Uint8ClampedArray([255, 0, 0, 255]));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("BM");
    expect(view.getUint32(2, true)).toBe(58);
    expect(view.getInt32(18, true)).toBe(1);
    expect(view.getInt32(22, true)).toBe(1);
    expect(view.getUint16(28, true)).toBe(24);
    expect([...bytes.slice(54, 57)]).toEqual([0, 0, 255]);
  });

  it("拒绝尺寸不匹配的像素数据", () => {
    expect(() => encodeBmp(2, 2, new Uint8Array(4))).toThrow("像素数据长度");
  });
});

describe("颜色提取", () => {
  it("在 HEX、RGB 与 HSL 之间转换颜色", () => {
    expect(rgbToHex(9, 105, 218)).toBe("#0969DA");
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 100, l: 50 });
  });

  it("忽略透明像素并合并相近颜色", () => {
    const pixels = new Uint8ClampedArray([
      255, 0, 0, 255, 250, 8, 4, 255, 252, 4, 2, 255,
      0, 0, 255, 255, 3, 2, 248, 255, 0, 255, 0, 0,
    ]);
    const palette = extractPaletteFromPixels(pixels, 2);
    expect(palette).toHaveLength(2);
    expect(palette[0].r).toBeGreaterThan(240);
    expect(palette[0].percentage).toBe(60);
    expect(palette[1].b).toBeGreaterThan(240);
  });

  it("输出可复制的 CSS 变量与 JSON", () => {
    const palette = [{ hex: "#0969DA", rgb: "rgb(9, 105, 218)", hsl: "hsl(212, 92%, 45%)", percentage: 100 }];
    expect(formatPaletteCss(palette, "brand color")).toContain("--brand-color-1: #0969DA;");
    expect(JSON.parse(formatPaletteJson(palette))).toEqual(palette);
  });
});

describe("图标生成", () => {
  it("从 AI 文本与代码块中提取 SVG", () => {
    expect(extractSvgFromAiText("说明\n```svg\n<svg><path d=\"M0 0\"/></svg>\n```")).toBe('<svg><path d="M0 0"/></svg>');
    expect(() => extractSvgFromAiText("没有图形")).toThrow("AI 未返回");
  });

  it("清理脚本、事件、外链和危险节点", () => {
    const raw = '<svg onload="alert(1)" viewBox="0 0 24 24"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><path d="M1 1h20v20z" fill="#0969da" onclick="bad()"/><use href="https://bad/icon.svg#x"/></svg>';
    const clean = sanitizeSvg(raw);
    expect(clean).toContain('viewBox="0 0 512 512"');
    expect(clean).toContain('<path d="M1 1h20v20z" fill="#0969da"/>');
    expect(clean).not.toMatch(/script|foreignObject|onload|onclick|bad\/icon|<use/i);
  });

  it("拒绝外链填充并保留安全变换", () => {
    const clean = sanitizeSvg('<svg><g transform="translate(12 20) scale(2)"><circle cx="10" cy="10" r="8" fill="url(https://bad)" stroke="#fff"/></g></svg>');
    expect(clean).toContain('transform="translate(12 20) scale(2)"');
    expect(clean).not.toContain("url(");
    expect(clean).toContain('stroke="#fff"');
  });

  it("生成本地文字图标并转义文本", () => {
    const svg = buildLetterIconSvg({ text: "<&", background: "#0969da", foreground: "#fff", radius: 96, fontSize: 220 });
    expect(svg).toContain('rx="96"');
    expect(svg).toContain('fill="#0969DA"');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain("&lt;&amp;");
    expect(iconOutputName("我的 图标.svg", 128)).toBe("我的-图标-128.png");
  });
});
