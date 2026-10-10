// 截图遮罩页 E2E（浏览器形态 + 伪 Tauri IPC）——这是唯一能自动化跑到框选/标注/导出的地方：
// 真实桌面端遮罩由 Rust 建窗、要 Windows 屏幕，自动化到不了；而遮罩页本身是纯前端，
// 只要喂它一帧「冻结图」就能把交互跑完。冻结帧用 Node 现场编码一张真 PNG，
// 走的仍是生产代码路径（invoke("screenshot_frame") → 画布 → 选区 → 合成 → invoke("screenshot_commit")）。
//
// 注意两件事：
//  1) 提交是异步的（合成 PNG + toBlob），断言一律用 expect.poll 等调用记录出现，别读完就走；
//  2) 视口尺寸由 devices["Desktop Chrome"] 决定（1280×720），与冻结帧尺寸无关——
//     期望值按 window.innerWidth/innerHeight 现算 kx/ky，不写死像素数。
import { expect, test } from "@playwright/test";
import zlib from "node:zlib";
import { seedDesktopIpc } from "../helpers.js";

const FRAME_W = 1440;
const FRAME_H = 900;
const SEL = { left: 100, top: 100, right: 500, bottom: 400 };

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

/** 现场编一张带渐变的真 PNG：遮罩页会走 createImageBitmap + 画布渲染，假图过不了。 */
function makeFramePngBase64(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const p = row + 1 + x * 4;
      raw[p] = (x * 255) / width;
      raw[p + 1] = (y * 255) / height;
      raw[p + 2] = 128;
      raw[p + 3] = 255;
    }
  }
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return png.toString("base64");
}

/** 打开遮罩页：伪 Tauri IPC 喂冻结帧，其余截图命令记录调用；返回逻辑→物理的换算系数。
 *  pendingTimes > 0 时先回「尚未就绪」再给帧——复现「先建窗后抓帧」的并行流程。 */
async function openOverlay(page, { pendingTimes = 0 } = {}) {
  await seedDesktopIpc(page, {});
  await page.addInitScript(
    ({ png, frame, pendingTimes }) => {
      window.__shotCalls = [];
      let pendingLeft = pendingTimes;
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        const name = String(cmd);
        if (name.startsWith("screenshot_") || name.startsWith("pin_")) {
          window.__shotCalls.push({ cmd: name, args: args || {} });
          if (name === "screenshot_frame") {
            if (pendingLeft > 0) {
              pendingLeft -= 1;
              throw new Error("截图尚未就绪");
            }
            return { ...frame, pngB64: png };
          }
          return null;
        }
        return original(cmd, args);
      };
    },
    { png: makeFramePngBase64(FRAME_W, FRAME_H), frame: { index: 0, x: 0, y: 0, width: FRAME_W, height: FRAME_H, scale: 1, count: 1 }, pendingTimes }
  );
  await page.goto("/?shot=overlay&session=1&monitor=0");
  // 提示条出现 === 已取到帧、首帧已渲染、窗口已自显
  await page.locator(".shot-hint").waitFor({ state: "visible", timeout: 10_000 });
  const vp = await page.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
  return { kx: FRAME_W / vp.w, ky: FRAME_H / vp.h };
}

async function dragSelection(page) {
  await page.mouse.move(SEL.left, SEL.top);
  await page.mouse.down();
  await page.mouse.move(SEL.right, SEL.bottom, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".shot-toolbar")).toBeVisible();
}

const shotCalls = (page) => page.evaluate(() => window.__shotCalls);

/** 等某命令被调用（提交是异步的：合成 PNG → toBlob → invoke），返回最后一次的调用。 */
async function waitCall(page, cmd) {
  await expect.poll(async () => (await shotCalls(page)).filter((c) => c.cmd === cmd).length, { timeout: 10_000 }).toBeGreaterThan(0);
  return (await shotCalls(page)).filter((c) => c.cmd === cmd).at(-1);
}

test.describe("截图遮罩页（交互链路）", () => {
  test("跟手性基准：每事件的同步 JS 成本与拖动帧节奏", async ({ page }) => {
    await openOverlay(page);
    const measure = () =>
      page.evaluate(async () => {
        const root = document.querySelector(".shot-root");
        const fire = (type, x, y) =>
          root.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, bubbles: true, pointerId: 1, pointerType: "mouse", button: 0 }));
        // 1) 悬停阶段：200 次 pointermove 的同步 JS 成本（高刷鼠标 1000Hz 时每秒来 1000 次）
        let t0 = performance.now();
        for (let i = 0; i < 200; i++) fire("pointermove", 300 + (i % 40), 200 + (i % 30));
        const hoverEventsMs = performance.now() - t0;
        // 2) 框选拖动中：200 次 pointermove 的同步 JS 成本
        fire("pointerdown", 100, 100);
        t0 = performance.now();
        for (let i = 0; i < 200; i++) fire("pointermove", 120 + i * 2, 140 + (i % 60));
        const dragEventsMs = performance.now() - t0;
        fire("pointerup", 500, 260);
        // 3) 拖动过程的帧节奏：每帧派发一次移动，记录 90 帧间隔（前 30 帧算预热：
        //    选区/工具栏/提示条首帧与首屏绘制的一次性成本不该算进稳态跟手性）
        fire("pointerdown", 150, 150);
        const all = [];
        await new Promise((resolve) => {
          let last = performance.now();
          let n = 0;
          const tick = () => {
            const now = performance.now();
            all.push(now - last);
            last = now;
            fire("pointermove", 200 + (n % 60) * 4, 200 + (n % 50));
            if (++n >= 120) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        fire("pointerup", 600, 300);
        const deltas = all.slice(30).sort((a, b) => a - b);
        return {
          hoverEventsMs: Math.round(hoverEventsMs),
          dragEventsMs: Math.round(dragEventsMs),
          frameMedianMs: Math.round(deltas[Math.floor(deltas.length / 2)]),
          frameP95Ms: Math.round(deltas[Math.floor(deltas.length * 0.95)]),
        };
      });

    // 单次测量在本地与 CI 上都噪声很大——按本仓性能用例的既有约定：跑 3 次取中位数
    const rounds = [await measure(), await measure(), await measure()];
    const median = (key) => [...rounds.map((r) => r[key])].sort((a, b) => a - b)[1];
    const perf = { rounds, frameMedianMs: median("frameMedianMs"), dragEventsMs: median("dragEventsMs") };
    console.log("OVERLAY-PERF", JSON.stringify(perf));

    expect(perf.dragEventsMs, `拖动 200 次事件同步耗时中位 ${perf.dragEventsMs}ms`).toBeLessThan(600);
    // 预算：拖动帧间隔中位 < 40ms（≈25fps）。改回「逐帧整屏重绘」时中位会飙到 ~51ms 立刻红；
    // 40 而不是 30 是给慢机器留余量（CI 跑者的软件栅格比本机慢），与 20-performance 的宽预算同一口径。
    expect(perf.frameMedianMs, `拖动帧间隔中位 ${perf.frameMedianMs}ms`).toBeLessThan(40);
  });

  test("遮罩/选区框/手柄走 DOM 层且几何正确（拖动只改样式的前提）", async ({ page }) => {
    await openOverlay(page);
    const { kx, ky } = { kx: 1, ky: 1 };
    // 无选区：一层全屏遮罩
    let dim = page.locator(".shot-dim");
    await expect(dim).toHaveCount(1);

    await page.mouse.move(SEL.left, SEL.top);
    await page.mouse.down();
    await page.mouse.move(SEL.right, SEL.bottom, { steps: 4 });
    await page.mouse.up();

    // 有选区：4 条遮罩 + 选区框 + 8 个手柄
    dim = page.locator(".shot-dim");
    await expect(dim).toHaveCount(4);
    await expect(page.locator(".shot-sel")).toHaveCount(1);
    await expect(page.locator(".shot-handle")).toHaveCount(8);
    // 手柄几何落在选区边界上（右下角手柄 = 选区右下角）
    const box = await page.locator(".shot-sel").boundingBox();
    expect(Math.round(box.x)).toBe(SEL.left);
    expect(Math.round(box.y)).toBe(SEL.top);
    expect(Math.round(box.width)).toBe(SEL.right - SEL.left);
    expect(Math.round(box.height)).toBe(SEL.bottom - SEL.top);
    // 遮罩透明度：有选区 0.45、无选区 0.25（canvas 已不再画遮罩，这里守的是 DOM 版的正确值）
    const bg = await dim.first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).toBe("rgba(0, 0, 0, 0.45)");
    void kx; void ky;
  });

  test("抓帧未就绪时轮询等待，就绪后照常框选（先建窗后抓帧的并行流程）", async ({ page }) => {
    // 前两次取帧回「尚未就绪」：页面必须继续轮询而不是报错退出
    await openOverlay(page, { pendingTimes: 2 });
    await dragSelection(page);
    const frames = (await shotCalls(page)).filter((c) => c.cmd === "screenshot_frame");
    expect(frames.length).toBeGreaterThanOrEqual(3); // 两次未就绪 + 一次成功
  });

  test("取帧后进入框选；出现工具栏与尺寸标签；Enter 复制并退出", async ({ page }) => {
    const { kx, ky } = await openOverlay(page);
    await dragSelection(page);

    // 尺寸标签按物理像素显示（kx/ky 由实际视口推出，不同跑机视口变了也不会假红）
    await expect(page.locator(".shot-size")).toHaveText(`${Math.round((SEL.right - SEL.left) * kx)} × ${Math.round((SEL.bottom - SEL.top) * ky)}`);

    await page.keyboard.press("Enter");
    const commit = await waitCall(page, "screenshot_commit");
    expect(commit?.args?.action).toBe("copy");
    expect(String(commit?.args?.dataB64 || "").length).toBeGreaterThan(1000);
    // 贴图落点 = 选区的物理矩形（Rust 用它把贴图放回原位）
    expect(Math.abs(commit?.args?.pinRect?.x - SEL.left * kx)).toBeLessThanOrEqual(1);
    expect(Math.abs(commit?.args?.pinRect?.y - SEL.top * ky)).toBeLessThanOrEqual(1);
    expect(Math.abs(commit?.args?.pinRect?.width - (SEL.right - SEL.left) * kx)).toBeLessThanOrEqual(2);
    expect(Math.abs(commit?.args?.pinRect?.height - (SEL.bottom - SEL.top) * ky)).toBeLessThanOrEqual(2);
  });

  test("矩形标注可撤销可重做；Esc 逐级退出后调用 screenshot_cancel", async ({ page }) => {
    await openOverlay(page);
    await dragSelection(page);

    const undo = page.locator('.shot-toolbar button[title*="撤销"]');
    const redo = page.locator('.shot-toolbar button[title*="重做"]');
    await expect(undo).toBeDisabled();

    // 选矩形工具，在选区内画一笔
    await page.locator('.shot-toolbar button[title="矩形"]').click();
    await page.mouse.move(180, 160);
    await page.mouse.down();
    await page.mouse.move(420, 340, { steps: 5 });
    await page.mouse.up();
    await expect(undo).toBeEnabled();

    await page.keyboard.press("Control+z");
    await expect(undo).toBeDisabled();
    await expect(redo).toBeEnabled();
    await page.keyboard.press("Control+Shift+Z");
    await expect(undo).toBeEnabled();

    // 第一次 Esc 撤工具，第二次撤选区，第三次退出
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    // 工具栏是常驻 DOM（v-show，拖动开局不再付建树成本）——这里断言「不可见」而非「不存在」
    await expect(page.locator(".shot-toolbar")).toBeHidden();
    await page.keyboard.press("Escape");
    const cancel = await waitCall(page, "screenshot_cancel");
    expect(cancel?.args?.sessionId).toBe("1");
  });

  test("工具栏「贴图」动作以 pin 提交，参数与复制同形", async ({ page }) => {
    await openOverlay(page);
    await dragSelection(page);
    await page.locator(".shot-toolbar button", { hasText: "贴图" }).click();
    const commit = await waitCall(page, "screenshot_commit");
    expect(commit?.args?.action).toBe("pin");
    expect(String(commit?.args?.dataB64 || "").length).toBeGreaterThan(1000);
  });

  test("无选区时 Esc 直接退出（调用 screenshot_cancel）", async ({ page }) => {
    await openOverlay(page);
    // 工具栏是常驻 DOM（v-show，拖动开局不再付建树成本）——这里断言「不可见」而非「不存在」
    await expect(page.locator(".shot-toolbar")).toBeHidden();
    await page.keyboard.press("Escape");
    const byEsc = await waitCall(page, "screenshot_cancel");
    expect(byEsc?.args?.sessionId).toBe("1");
  });

  test("无选区时右键退出", async ({ page }) => {
    await openOverlay(page);
    await page.mouse.click(700, 500, { button: "right" });
    const byRight = await waitCall(page, "screenshot_cancel");
    expect(byRight?.args?.sessionId).toBe("1");
  });
});
