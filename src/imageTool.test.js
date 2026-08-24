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
import { i18n } from "./i18n/index.js";

describe("image format and naming", () => {
  it("detects the output format and clamps quality", () => {
    expect(imageFormat("webp")).toMatchObject({ mime: "image/webp", extension: "webp" });
    expect(imageFormat("unknown").key).toBe("png");
    expect(clampQuality(2)).toBe(1);
    expect(clampQuality(0)).toBe(0.8);
  });

  it("builds single and batch output names", () => {
    expect(buildImageOutputName("C:\\photos\\demo.PNG", { format: "jpeg", suffix: "-small" })).toBe("demo-small.jpg");
    expect(buildImageOutputName("demo", { format: "webp", prefix: "web-", index: 3, padding: 3 })).toBe("web-demo_003.webp");
  });
});

describe("image size calculations", () => {
  it("scales within bounds without upscaling by default", () => {
    expect(calculateContainSize(4000, 3000, 1200, 1200)).toMatchObject({ width: 1200, height: 900 });
    expect(calculateContainSize(400, 300, 1200, 1200)).toMatchObject({ width: 400, height: 300 });
    expect(calculateContainSize(400, 300, 1200, 1200, true)).toMatchObject({ width: 1200, height: 900 });
  });

  it("computes center crops for landscape and portrait", () => {
    expect(calculateCenterCrop(1600, 900, 1)).toEqual({ x: 350, y: 0, width: 900, height: 900 });
    expect(calculateCenterCrop(900, 1600, 16 / 9)).toEqual({ x: 0, y: 547, width: 900, height: 506 });
    expect(calculateCenterCrop(800, 600, 0)).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });

  it("swaps output size on 90-degree rotation", () => {
    expect(calculateRenderPlan(1600, 900, { width: 800, height: 450, rotation: 90, flipX: true })).toMatchObject({
      drawWidth: 800, drawHeight: 450, outputWidth: 450, outputHeight: 800, rotation: 90, flipX: true,
    });
  });

  it("computes the other side when the aspect is locked", () => {
    expect(resizeWithAspect(1920, 1080, 1280, 0, "width")).toEqual({ width: 1280, height: 720 });
    expect(resizeWithAspect(1920, 1080, 0, 540, "height")).toEqual({ width: 960, height: 540 });
    expect(aspectRatioLabel(1920, 1080)).toBe("16:9");
  });

  it("rejects invalid sizes", () => {
    expect(() => calculateContainSize(0, 100, 50, 50)).toThrow(i18n.global.t("toolbox.image.positiveErr", { label: i18n.global.t("toolbox.image.imgWidth") }));
  });
});

describe("EXIF parsing", () => {
  it("returns an empty object for non-JPEG or corrupt data", () => {
    expect(parseExif(new Uint8Array([1, 2, 3, 4]).buffer)).toEqual({});
    expect(parseExif(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0, 99]).buffer)).toEqual({});
  });

  it("reads camera make and orientation from JPEG", () => {
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

describe("BMP encoding", () => {
  it("produces a valid 24-bit BMP header and BGR pixels", () => {
    const bytes = encodeBmp(1, 1, new Uint8ClampedArray([255, 0, 0, 255]));
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(bytes[0], bytes[1])).toBe("BM");
    expect(view.getUint32(2, true)).toBe(58);
    expect(view.getInt32(18, true)).toBe(1);
    expect(view.getInt32(22, true)).toBe(1);
    expect(view.getUint16(28, true)).toBe(24);
    expect([...bytes.slice(54, 57)]).toEqual([0, 0, 255]);
  });

  it("rejects mismatched pixel data", () => {
    expect(() => encodeBmp(2, 2, new Uint8Array(4))).toThrow(i18n.global.t("toolbox.image.errPixelMismatch"));
  });
});

describe("color extraction", () => {
  it("converts between HEX, RGB and HSL", () => {
    expect(rgbToHex(9, 105, 218)).toBe("#0969DA");
    expect(hexToRgb("#fff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 100, l: 50 });
  });

  it("ignores transparent pixels and merges similar colors", () => {
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

  it("outputs copyable CSS variables and JSON", () => {
    const palette = [{ hex: "#0969DA", rgb: "rgb(9, 105, 218)", hsl: "hsl(212, 92%, 45%)", percentage: 100 }];
    expect(formatPaletteCss(palette, "brand color")).toContain("--brand-color-1: #0969DA;");
    expect(JSON.parse(formatPaletteJson(palette))).toEqual(palette);
  });
});

describe("icon generation", () => {
  it("extracts SVG from AI text and code blocks", () => {
    expect(extractSvgFromAiText("note\n```svg\n<svg><path d=\"M0 0\"/></svg>\n```")).toBe('<svg><path d="M0 0"/></svg>');
    expect(() => extractSvgFromAiText("no shape")).toThrow(i18n.global.t("toolbox.image.errNoSvg"));
  });

  it("sanitizes scripts, events, links and dangerous nodes", () => {
    const raw = '<svg onload="alert(1)" viewBox="0 0 24 24"><script>alert(1)</script><foreignObject><div>bad</div></foreignObject><path d="M1 1h20v20z" fill="#0969da" onclick="bad()"/><use href="https://bad/icon.svg#x"/></svg>';
    const clean = sanitizeSvg(raw);
    expect(clean).toContain('viewBox="0 0 512 512"');
    expect(clean).toContain('<path d="M1 1h20v20z" fill="#0969da"/>');
    expect(clean).not.toMatch(/script|foreignObject|onload|onclick|bad\/icon|<use/i);
  });

  it("rejects external fills and keeps safe transforms", () => {
    const clean = sanitizeSvg('<svg><g transform="translate(12 20) scale(2)"><circle cx="10" cy="10" r="8" fill="url(https://bad)" stroke="#fff"/></g></svg>');
    expect(clean).toContain('transform="translate(12 20) scale(2)"');
    expect(clean).not.toContain("url(");
    expect(clean).toContain('stroke="#fff"');
  });

  it("builds local letter icons and escapes text", () => {
    const svg = buildLetterIconSvg({ text: "<&", background: "#0969da", foreground: "#fff", radius: 96, fontSize: 220 });
    expect(svg).toContain('rx="96"');
    expect(svg).toContain('fill="#0969DA"');
    expect(svg).toContain('fill="#FFFFFF"');
    expect(svg).toContain("&lt;&amp;");
    expect(iconOutputName("My Icon.svg", 128)).toBe("My-Icon-128.png");
  });
});
