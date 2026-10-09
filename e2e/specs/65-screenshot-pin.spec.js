// 贴图窗 E2E（浏览器形态 + 伪 Tauri IPC）：贴图窗同样是纯前端页面，
// 喂一张 PNG 就能把「取图 → 自显 → 滚轮缩放 → 右键菜单 → 关闭」跑完。
// Rust 侧的窗口创建与缩放几何（zoomed_size / zoom_anchor_position / pin_geometry）由 cargo 单测覆盖。
import { expect, test } from "@playwright/test";
import zlib from "node:zlib";
import { seedDesktopIpc } from "../helpers.js";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([length, typeBuf, data, crc]);
}

/** 单色 PNG（贴图窗只做展示，不需要内容变化）。 */
function makeSolidPngBase64(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4;
      raw[p] = 40;
      raw[p + 1] = 120;
      raw[p + 2] = 200;
      raw[p + 3] = 255;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]).toString("base64");
}

async function openPin(page) {
  await seedDesktopIpc(page, {});
  await page.addInitScript((png) => {
    window.__pinCalls = [];
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      const name = String(cmd);
      if (name.startsWith("pin_")) {
        window.__pinCalls.push({ cmd: name, args: args || {} });
        if (name === "pin_image") return png;
        return null;
      }
      return original(cmd, args);
    };
  }, makeSolidPngBase64(240, 160));
  await page.goto("/?shot=pin");
  await expect(page.locator(".pin-image")).toBeVisible({ timeout: 10_000 });
}

const pinCalls = (page) => page.evaluate(() => window.__pinCalls);
const lastPin = async (page, cmd) => (await pinCalls(page)).filter((c) => c.cmd === cmd).at(-1);

test.describe("贴图窗（交互链路）", () => {
  test("取图后铺满窗口；滚轮缩放调用 pin_zoom（上滚放大、下滚缩小）", async ({ page }) => {
    await openPin(page);
    await page.mouse.move(120, 80);
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => (await pinCalls(page)).some((c) => c.cmd === "pin_zoom")).toBe(true);
    const zoomIn = await lastPin(page, "pin_zoom");
    expect(zoomIn?.args?.factor).toBeGreaterThan(1);

    await page.mouse.wheel(0, 120);
    const zoomOut = await lastPin(page, "pin_zoom");
    expect(zoomOut?.args?.factor).toBeLessThan(1);
  });

  test("右键菜单 4 项齐全，「复制图片」调用 pin_copy，Esc 关闭贴图", async ({ page }) => {
    await openPin(page);
    await page.mouse.click(120, 80, { button: "right" });
    const menu = page.locator(".pin-menu");
    await expect(menu).toBeVisible();
    await expect(menu.locator(".menu-item")).toHaveCount(4);
    await expect(menu).toContainText("复制图片");
    await expect(menu).toContainText("另存为");
    await expect(menu).toContainText("重置缩放");

    await menu.locator(".menu-item", { hasText: "复制图片" }).click();
    await expect.poll(async () => (await pinCalls(page)).some((c) => c.cmd === "pin_copy")).toBe(true);

    await page.keyboard.press("Escape");
    await expect.poll(async () => (await pinCalls(page)).some((c) => c.cmd === "pin_close")).toBe(true);
  });

  test("「重置缩放」以 factor=0 调用 pin_zoom（Rust 侧解释为回原始尺寸）", async ({ page }) => {
    await openPin(page);
    await page.mouse.click(120, 80, { button: "right" });
    await page.locator(".pin-menu .menu-item", { hasText: "重置缩放" }).click();
    const reset = await lastPin(page, "pin_zoom");
    expect(reset?.args?.factor).toBe(0);
  });

  test("双击关闭贴图", async ({ page }) => {
    await openPin(page);
    await page.locator(".pin-image").dblclick();
    await expect.poll(async () => (await pinCalls(page)).some((c) => c.cmd === "pin_close")).toBe(true);
  });
});
