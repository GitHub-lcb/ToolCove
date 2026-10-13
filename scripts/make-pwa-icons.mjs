// 手机端 PWA 图标生成器：零依赖，纯 Node 画出各尺寸 PNG。
//
// 为什么程序化生成而不是塞几个二进制进仓库：
//   1) 图标形状/配色以后要调（比如换主题色），改这里一行重跑，不用找设计软件重新导出；
//   2) 仓库里少几个来源不可追溯的二进制文件；
//   3) 不用为了 resize 引 sharp 这类大依赖（只用 node:zlib 手写 PNG 编码）。
//
// 图形：主题蓝圆角底 + 白色相机剪影（与工具图标 "camera" 同一语义）。
// 输出：mobile/app/public/icons/ —— Vite 会把 <root>/public 原样拷进产物（含 GH Pages 部署）。
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(root, "mobile", "app", "public", "icons");

const BRAND = [0x2b, 0x6a, 0xd0]; // --primary
const WHITE = [0xff, 0xff, 0xff];

// ---------- PNG 编码（RGBA / 8bit / 无过滤） ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0; // filter: None
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 图形（相对坐标 0..1，2×2 超采样做抗锯齿） ----------

function inRoundedRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

function inCircle(x, y, cx, cy, r) {
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 一个采样点的颜色：相机剪影白、镜头/闪光灯打回主题蓝、其余为底。 */
function sampleColor(x, y) {
  const body = inRoundedRect(x, y, 0.16, 0.3, 0.84, 0.76, 0.07);
  const bump = inRoundedRect(x, y, 0.36, 0.21, 0.6, 0.34, 0.025);
  if (!body && !bump) return BRAND;
  if (inCircle(x, y, 0.5, 0.53, 0.145)) return BRAND; // 镜头
  if (inCircle(x, y, 0.72, 0.375, 0.022)) return BRAND; // 闪光灯
  return WHITE;
}

function drawIcon(size) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  const samples = 2;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px + (sx + 0.5) / samples) / size;
          const y = (py + (sy + 0.5) / samples) / size;
          const color = sampleColor(x, y);
          r += color[0];
          g += color[1];
          b += color[2];
        }
      }
      const n = samples * samples;
      const at = (py * size + px) * 4;
      rgba[at] = Math.round(r / n);
      rgba[at + 1] = Math.round(g / n);
      rgba[at + 2] = Math.round(b / n);
      rgba[at + 3] = 255;
    }
  }
  return encodePng(size, rgba);
}

mkdirSync(OUT_DIR, { recursive: true });
const outputs = [
  ["icon-192.png", 192],
  ["icon-512.png", 512],
  ["apple-touch-icon.png", 180],
];
for (const [name, size] of outputs) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, drawIcon(size));
  console.log(`[pwa-icons] ${name} (${size}x${size})`);
}
