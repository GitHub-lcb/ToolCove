export const IMAGE_FORMATS = [
  { key: "png", label: "PNG", mime: "image/png", extension: "png", supportsQuality: false },
  { key: "jpeg", label: "JPEG", mime: "image/jpeg", extension: "jpg", supportsQuality: true },
  { key: "webp", label: "WebP", mime: "image/webp", extension: "webp", supportsQuality: true },
  { key: "bmp", label: "BMP", mime: "image/bmp", extension: "bmp", supportsQuality: false },
];

export const CROP_RATIOS = [
  { key: "original", label: "原始比例", ratio: 0 },
  { key: "free", label: "自由尺寸", ratio: 0 },
  { key: "1:1", label: "1:1", ratio: 1 },
  { key: "4:3", label: "4:3", ratio: 4 / 3 },
  { key: "3:2", label: "3:2", ratio: 3 / 2 },
  { key: "16:9", label: "16:9", ratio: 16 / 9 },
  { key: "9:16", label: "9:16", ratio: 9 / 16 },
];

const SAFE_SVG_ELEMENTS = new Set(["svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]);
const SAFE_SVG_ATTRIBUTES = new Set([
  "viewBox", "xmlns", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
  "fill-rule", "clip-rule", "d", "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry",
  "width", "height", "points", "opacity", "transform",
]);

export function imageFormat(key) {
  return IMAGE_FORMATS.find((item) => item.key === key) || IMAGE_FORMATS[0];
}

export function clampQuality(value) {
  return Math.min(1, Math.max(0.01, Number(value) || 0.8));
}

export function calculateContainSize(width, height, maxWidth, maxHeight, allowUpscale = false) {
  const sourceWidth = positiveInteger(width, "图片宽度");
  const sourceHeight = positiveInteger(height, "图片高度");
  const limitWidth = positiveInteger(maxWidth || sourceWidth, "最大宽度");
  const limitHeight = positiveInteger(maxHeight || sourceHeight, "最大高度");
  let scale = Math.min(limitWidth / sourceWidth, limitHeight / sourceHeight);
  if (!allowUpscale) scale = Math.min(1, scale);
  return {
    width: Math.max(1, Math.round(sourceWidth * scale)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    scale,
  };
}

export function calculateCenterCrop(width, height, ratio) {
  const sourceWidth = positiveInteger(width, "图片宽度");
  const sourceHeight = positiveInteger(height, "图片高度");
  const targetRatio = Number(ratio);
  if (!Number.isFinite(targetRatio) || targetRatio <= 0) {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }
  const sourceRatio = sourceWidth / sourceHeight;
  if (Math.abs(sourceRatio - targetRatio) < 1e-8) {
    return { x: 0, y: 0, width: sourceWidth, height: sourceHeight };
  }
  if (sourceRatio > targetRatio) {
    const cropWidth = Math.round(sourceHeight * targetRatio);
    return { x: Math.floor((sourceWidth - cropWidth) / 2), y: 0, width: cropWidth, height: sourceHeight };
  }
  const cropHeight = Math.round(sourceWidth / targetRatio);
  return { x: 0, y: Math.floor((sourceHeight - cropHeight) / 2), width: sourceWidth, height: cropHeight };
}

export function calculateRenderPlan(sourceWidth, sourceHeight, options = {}) {
  const crop = calculateCenterCrop(sourceWidth, sourceHeight, options.cropRatio);
  const width = positiveInteger(options.width || crop.width, "输出宽度");
  const height = positiveInteger(options.height || crop.height, "输出高度");
  const rotation = normalizeRotation(options.rotation);
  return {
    crop,
    drawWidth: width,
    drawHeight: height,
    outputWidth: rotation % 180 === 0 ? width : height,
    outputHeight: rotation % 180 === 0 ? height : width,
    rotation,
    flipX: Boolean(options.flipX),
    flipY: Boolean(options.flipY),
  };
}

export function resizeWithAspect(width, height, nextWidth, nextHeight, changed = "width") {
  const sourceWidth = positiveInteger(width, "图片宽度");
  const sourceHeight = positiveInteger(height, "图片高度");
  if (changed === "height") {
    const targetHeight = positiveInteger(nextHeight, "输出高度");
    return { width: Math.max(1, Math.round(targetHeight * sourceWidth / sourceHeight)), height: targetHeight };
  }
  const targetWidth = positiveInteger(nextWidth, "输出宽度");
  return { width: targetWidth, height: Math.max(1, Math.round(targetWidth * sourceHeight / sourceWidth)) };
}

export function buildImageOutputName(sourceName, options = {}) {
  const source = String(sourceName || "image").split(/[\\/]/).pop() || "image";
  const dot = source.lastIndexOf(".");
  const stem = dot > 0 ? source.slice(0, dot) : source;
  const format = imageFormat(options.format);
  const prefix = String(options.prefix || "");
  const suffix = String(options.suffix || "");
  const index = Number(options.index);
  const sequence = Number.isFinite(index)
    ? `_${String(Math.max(0, Math.trunc(index))).padStart(Math.max(1, Math.trunc(Number(options.padding) || 2)), "0")}`
    : "";
  return `${prefix}${stem}${suffix}${sequence}.${format.extension}`;
}

export function aspectRatioLabel(width, height) {
  const w = positiveInteger(width, "图片宽度");
  const h = positiveInteger(height, "图片高度");
  const divisor = gcd(w, h);
  return `${w / divisor}:${h / divisor}`;
}

export function parseExif(arrayBuffer) {
  try {
    const view = new DataView(arrayBuffer);
    if (view.byteLength < 4 || view.getUint16(0, false) !== 0xffd8) return {};
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      if (view.getUint8(offset) !== 0xff) break;
      const marker = view.getUint8(offset + 1);
      if (marker === 0xda || marker === 0xd9) break;
      const length = view.getUint16(offset + 2, false);
      if (length < 2 || offset + 2 + length > view.byteLength) break;
      if (marker === 0xe1 && length >= 8 && ascii(view, offset + 4, 6) === "Exif\0\0") {
        return parseTiff(view, offset + 10, length - 8);
      }
      offset += length + 2;
    }
  } catch {
    return {};
  }
  return {};
}

export function encodeBmp(width, height, rgba) {
  const w = positiveInteger(width, "图片宽度");
  const h = positiveInteger(height, "图片高度");
  const pixels = rgba instanceof Uint8ClampedArray || rgba instanceof Uint8Array
    ? rgba
    : new Uint8ClampedArray(rgba || []);
  if (pixels.length !== w * h * 4) throw new Error("像素数据长度与图片尺寸不匹配");
  const rowSize = Math.ceil((w * 3) / 4) * 4;
  const pixelBytes = rowSize * h;
  const output = new Uint8Array(54 + pixelBytes);
  const view = new DataView(output.buffer);
  output[0] = 0x42;
  output[1] = 0x4d;
  view.setUint32(2, output.length, true);
  view.setUint32(10, 54, true);
  view.setUint32(14, 40, true);
  view.setInt32(18, w, true);
  view.setInt32(22, h, true);
  view.setUint16(26, 1, true);
  view.setUint16(28, 24, true);
  view.setUint32(34, pixelBytes, true);
  for (let y = 0; y < h; y += 1) {
    const sourceY = h - 1 - y;
    const targetRow = 54 + y * rowSize;
    for (let x = 0; x < w; x += 1) {
      const source = (sourceY * w + x) * 4;
      const target = targetRow + x * 3;
      const alpha = pixels[source + 3] / 255;
      output[target] = Math.round(pixels[source + 2] * alpha + 255 * (1 - alpha));
      output[target + 1] = Math.round(pixels[source + 1] * alpha + 255 * (1 - alpha));
      output[target + 2] = Math.round(pixels[source] * alpha + 255 * (1 - alpha));
    }
  }
  return output;
}

export function rgbToHex(red, green, blue) {
  return `#${[red, green, blue].map((value) => clampByte(value).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

export function hexToRgb(value) {
  const input = String(value || "").trim().replace(/^#/, "");
  const normalized = input.length === 3 ? input.split("").map((char) => char + char).join("") : input;
  if (!/^[\da-f]{6}$/i.test(normalized)) throw new Error("颜色必须是 3 位或 6 位 HEX");
  return {
    r: Number.parseInt(normalized.slice(0, 2), 16),
    g: Number.parseInt(normalized.slice(2, 4), 16),
    b: Number.parseInt(normalized.slice(4, 6), 16),
  };
}

export function rgbToHsl(red, green, blue) {
  const r = clampByte(red) / 255;
  const g = clampByte(green) / 255;
  const b = clampByte(blue) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l: Math.round(lightness * 100) };
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === r) hue = (g - b) / delta + (g < b ? 6 : 0);
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;
  return { h: Math.round(hue * 60), s: Math.round(saturation * 100), l: Math.round(lightness * 100) };
}

export function colorDistance(first, second) {
  const redMean = (Number(first.r) + Number(second.r)) / 2;
  const red = Number(first.r) - Number(second.r);
  const green = Number(first.g) - Number(second.g);
  const blue = Number(first.b) - Number(second.b);
  return Math.sqrt((2 + redMean / 256) * red * red + 4 * green * green + (2 + (255 - redMean) / 256) * blue * blue);
}

export function extractPaletteFromPixels(rgba, colorCount = 6, options = {}) {
  const pixels = rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray ? rgba : new Uint8ClampedArray(rgba || []);
  if (pixels.length % 4 !== 0) throw new Error("像素数据长度必须是 4 的倍数");
  const targetCount = Math.min(12, Math.max(1, Math.round(Number(colorCount) || 6)));
  const alphaThreshold = Math.min(255, Math.max(0, Number(options.alphaThreshold ?? 24)));
  const maxSamples = Math.max(100, Number(options.maxSamples) || 50000);
  const step = Math.max(1, Math.ceil(pixels.length / 4 / maxSamples));
  const samples = [];
  const buckets = new Map();
  for (let pixel = 0; pixel < pixels.length / 4; pixel += step) {
    const offset = pixel * 4;
    if (pixels[offset + 3] <= alphaThreshold) continue;
    const sample = { r: pixels[offset], g: pixels[offset + 1], b: pixels[offset + 2] };
    samples.push(sample);
    const key = `${sample.r >> 4}-${sample.g >> 4}-${sample.b >> 4}`;
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, count: 0 };
    bucket.r += sample.r;
    bucket.g += sample.g;
    bucket.b += sample.b;
    bucket.count += 1;
    buckets.set(key, bucket);
  }
  if (!samples.length) return [];
  const candidates = [...buckets.values()]
    .map((bucket) => ({ r: bucket.r / bucket.count, g: bucket.g / bucket.count, b: bucket.b / bucket.count, count: bucket.count }))
    .sort((a, b) => b.count - a.count);
  const centers = [candidates[0]];
  while (centers.length < Math.min(targetCount, candidates.length)) {
    let best = null;
    let bestScore = -1;
    for (const candidate of candidates) {
      const distance = Math.min(...centers.map((center) => colorDistance(candidate, center)));
      const score = distance * distance * Math.sqrt(candidate.count);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best || centers.includes(best)) break;
    centers.push(best);
  }
  let groups = [];
  for (let iteration = 0; iteration < 8; iteration += 1) {
    groups = centers.map(() => ({ r: 0, g: 0, b: 0, count: 0 }));
    for (const sample of samples) {
      let selected = 0;
      let nearest = Number.POSITIVE_INFINITY;
      centers.forEach((center, index) => {
        const distance = colorDistance(sample, center);
        if (distance < nearest) {
          selected = index;
          nearest = distance;
        }
      });
      groups[selected].r += sample.r;
      groups[selected].g += sample.g;
      groups[selected].b += sample.b;
      groups[selected].count += 1;
    }
    groups.forEach((group, index) => {
      if (!group.count) return;
      centers[index] = { r: group.r / group.count, g: group.g / group.count, b: group.b / group.count };
    });
  }
  return groups
    .filter((group) => group.count)
    .map((group) => {
      const color = {
        r: Math.round(group.r / group.count),
        g: Math.round(group.g / group.count),
        b: Math.round(group.b / group.count),
      };
      const hsl = rgbToHsl(color.r, color.g, color.b);
      return {
        ...color,
        hex: rgbToHex(color.r, color.g, color.b),
        rgb: `rgb(${color.r}, ${color.g}, ${color.b})`,
        hsl: `hsl(${hsl.h}, ${hsl.s}%, ${hsl.l}%)`,
        count: group.count,
        percentage: Number((group.count / samples.length * 100).toFixed(1)),
      };
    })
    .sort((a, b) => b.count - a.count);
}

export function formatPaletteCss(palette, prefix = "color") {
  const name = String(prefix || "color").trim().replace(/[^a-z\d_-]+/gi, "-").replace(/^-+|-+$/g, "") || "color";
  const rows = (palette || []).map((color, index) => `  --${name}-${index + 1}: ${String(color.hex).toUpperCase()};`);
  return `:root {\n${rows.join("\n")}\n}`;
}

export function formatPaletteJson(palette) {
  return JSON.stringify((palette || []).map(({ hex, rgb, hsl, percentage }) => ({ hex, rgb, hsl, percentage })), null, 2);
}

export function extractSvgFromAiText(value) {
  const text = String(value || "").trim();
  const fenced = text.match(/```(?:svg|xml)?\s*([\s\S]*?)```/i)?.[1] || text;
  const start = fenced.search(/<svg\b/i);
  const end = fenced.toLowerCase().lastIndexOf("</svg>");
  if (start < 0 || end < start) throw new Error("AI 未返回可识别的 SVG");
  return fenced.slice(start, end + 6).trim();
}

export function sanitizeSvg(value) {
  const input = extractSvgFromAiText(value);
  if (/<!DOCTYPE|<!ENTITY|<\?xml/i.test(input)) throw new Error("SVG 包含不安全声明");
  const tokens = input.match(/<[^>]+>|[^<]+/g) || [];
  const output = [];
  const stack = [];
  let skippedDepth = 0;
  let rootSeen = false;
  for (const token of tokens) {
    if (!token.startsWith("<")) continue;
    if (/^<\s*\//.test(token)) {
      const name = token.match(/^<\s*\/\s*([\w:-]+)/)?.[1]?.toLowerCase();
      if (skippedDepth) {
        skippedDepth -= 1;
        continue;
      }
      if (!name || stack.at(-1) !== name) continue;
      stack.pop();
      output.push(`</${name}>`);
      continue;
    }
    if (/^<\s*[!?]/.test(token)) continue;
    const match = token.match(/^<\s*([\w:-]+)\b([\s\S]*?)(\/?)\s*>$/);
    if (!match) continue;
    const name = match[1].toLowerCase();
    const selfClosing = match[3] === "/";
    if (skippedDepth) {
      if (!selfClosing) skippedDepth += 1;
      continue;
    }
    if (!SAFE_SVG_ELEMENTS.has(name) || (!rootSeen && name !== "svg") || (rootSeen && name === "svg")) {
      if (!selfClosing) skippedDepth = 1;
      continue;
    }
    rootSeen = true;
    const attributes = [];
    const rawAttributes = match[2];
    const attributePattern = /([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g;
    let attribute;
    while ((attribute = attributePattern.exec(rawAttributes))) {
      const rawName = attribute[1];
      const normalizedName = rawName.toLowerCase() === "viewbox" ? "viewBox" : rawName.toLowerCase();
      if (!SAFE_SVG_ATTRIBUTES.has(normalizedName) || !isSafeSvgAttribute(normalizedName, attribute[3])) continue;
      if (name === "svg" && (normalizedName === "viewBox" || normalizedName === "xmlns" || normalizedName === "width" || normalizedName === "height")) continue;
      attributes.push(`${normalizedName}="${escapeXml(attribute[3].trim())}"`);
    }
    if (name === "svg") attributes.unshift('xmlns="http://www.w3.org/2000/svg"', 'viewBox="0 0 512 512"');
    output.push(`<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}${selfClosing ? "/" : ""}>`);
    if (!selfClosing) stack.push(name);
  }
  while (stack.length) output.push(`</${stack.pop()}>`);
  const sanitized = output.join("");
  if (!sanitized.startsWith("<svg") || !/<(?:path|circle|rect|line|polyline|polygon|ellipse)\b/.test(sanitized)) {
    throw new Error("SVG 中没有可用的图形");
  }
  return sanitized;
}

export function buildLetterIconSvg(options = {}) {
  const text = String(options.text || "ZG").trim().slice(0, 3) || "ZG";
  const background = normalizeHex(options.background, "#0969DA");
  const foreground = normalizeHex(options.foreground, "#FFFFFF");
  const radius = Math.min(256, Math.max(0, Math.round(Number(options.radius) || 0)));
  const fontSize = Math.min(360, Math.max(80, Math.round(Number(options.fontSize) || 220)));
  const backgroundNode = options.transparent ? "" : `<rect width="512" height="512" rx="${radius}" fill="${background}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">${backgroundNode}<text x="256" y="256" fill="${foreground}" font-family="Microsoft YaHei,Arial,sans-serif" font-size="${fontSize}" font-weight="700" text-anchor="middle" dominant-baseline="central">${escapeXml(text)}</text></svg>`;
}

export function iconOutputName(name, size, extension = "png") {
  const stem = String(name || "icon").trim().replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\u0000-\u001f]+/g, "-").replace(/\s+/g, "-").replace(/^-+|-+$/g, "") || "icon";
  const outputSize = Math.min(4096, Math.max(1, Math.round(Number(size) || 512)));
  const ext = String(extension || "png").toLowerCase() === "svg" ? "svg" : "png";
  return `${stem}-${outputSize}.${ext}`;
}

function parseTiff(view, tiffStart, available) {
  const end = Math.min(view.byteLength, tiffStart + available);
  if (tiffStart + 8 > end) return {};
  const order = view.getUint16(tiffStart, false);
  const little = order === 0x4949;
  if (!little && order !== 0x4d4d) return {};
  if (view.getUint16(tiffStart + 2, little) !== 42) return {};
  const result = {};
  const visited = new Set();

  const readValue = (entry, type, count) => {
    const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
    const size = sizes[type];
    if (!size || count <= 0 || count > 1024) return undefined;
    const byteLength = size * count;
    const valueOffset = byteLength <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, little);
    if (valueOffset < tiffStart || valueOffset + byteLength > end) return undefined;
    if (type === 2) return ascii(view, valueOffset, count).replace(/\0+$/, "").trim();
    if (type === 3) return count === 1 ? view.getUint16(valueOffset, little) : undefined;
    if (type === 4) return count === 1 ? view.getUint32(valueOffset, little) : undefined;
    if (type === 5 || type === 10) {
      const numerator = type === 5 ? view.getUint32(valueOffset, little) : view.getInt32(valueOffset, little);
      const denominator = type === 5 ? view.getUint32(valueOffset + 4, little) : view.getInt32(valueOffset + 4, little);
      return denominator ? numerator / denominator : undefined;
    }
    return undefined;
  };

  const readIfd = (relativeOffset, exif = false) => {
    if (!relativeOffset || visited.has(relativeOffset)) return;
    visited.add(relativeOffset);
    const start = tiffStart + relativeOffset;
    if (start + 2 > end) return;
    const count = view.getUint16(start, little);
    if (count > 256 || start + 2 + count * 12 > end) return;
    for (let index = 0; index < count; index += 1) {
      const entry = start + 2 + index * 12;
      const tag = view.getUint16(entry, little);
      const type = view.getUint16(entry + 2, little);
      const valueCount = view.getUint32(entry + 4, little);
      const value = readValue(entry, type, valueCount);
      if (!exif && tag === 0x8769 && typeof value === "number") readIfd(value, true);
      else if (!exif && tag === 0x8825) result.hasGps = true;
      else assignExifTag(result, tag, value, exif);
    }
  };

  readIfd(view.getUint32(tiffStart + 4, little));
  return result;
}

function assignExifTag(result, tag, value, exif) {
  if (value === undefined || value === "") return;
  const baseTags = { 0x010f: "make", 0x0110: "model", 0x0112: "orientation", 0x0132: "modifiedAt" };
  const exifTags = {
    0x829a: "exposureTime", 0x829d: "fNumber", 0x8827: "iso", 0x9003: "takenAt",
    0x920a: "focalLength", 0xa002: "pixelWidth", 0xa003: "pixelHeight",
  };
  const key = (exif ? exifTags : baseTags)[tag];
  if (key) result[key] = value;
}

function ascii(view, offset, length) {
  let result = "";
  for (let index = 0; index < length && offset + index < view.byteLength; index += 1) {
    result += String.fromCharCode(view.getUint8(offset + index));
  }
  return result;
}

function normalizeRotation(value) {
  const rotation = Math.round((Number(value) || 0) / 90) * 90;
  return ((rotation % 360) + 360) % 360;
}

function positiveInteger(value, label) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label}必须大于 0`);
  return number;
}

function gcd(a, b) {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

function clampByte(value) {
  return Math.min(255, Math.max(0, Math.round(Number(value) || 0)));
}

function normalizeHex(value, fallback) {
  try {
    const color = hexToRgb(value || fallback);
    return rgbToHex(color.r, color.g, color.b);
  } catch {
    return fallback;
  }
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]);
}

function isSafeSvgAttribute(name, value) {
  const input = String(value).trim();
  if (!input || /url\s*\(|javascript:|data:|https?:|@import|expression\s*\(/i.test(input)) return false;
  if (["fill", "stroke"].includes(name)) return /^(?:none|currentColor|#[\da-f]{3,8}|rgba?\([\d\s.,%]+\)|hsla?\([\d\s.,%]+\))$/i.test(input);
  if (["stroke-linecap", "stroke-linejoin", "fill-rule", "clip-rule"].includes(name)) return /^[a-z-]+$/i.test(input);
  if (name === "d") return /^[\d\s.,+\-eEaAcChHlLmMqQsStTvVzZ]+$/.test(input);
  if (name === "points") return /^[\d\s.,+\-eE]+$/.test(input);
  if (name === "transform") return /^(?:\s*(?:matrix|translate|scale|rotate|skewX|skewY)\([\d\s.,+\-eE]+\)\s*)+$/i.test(input);
  if (name === "viewBox") return /^[\d\s.+\-eE]+$/.test(input);
  if (name === "xmlns") return input === "http://www.w3.org/2000/svg";
  return /^[\d.+\-eE%]+$/.test(input);
}
