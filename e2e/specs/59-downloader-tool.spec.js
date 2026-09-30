// 多线程下载器 E2E（桌面形态）。
//
// 分片计划、进度/速度/ETA 格式化与队列推进由 src/downloader.test.js 覆盖，
// 这里验**接线**：URL 解析入队 → 原生探测回填 → 事件驱动的进度与完成 → 取消回落暂停。
//
// 两个必须的安排：
//  1) 走 seedDesktopIpc —— 下载器标了 desktopOnly，浏览器形态会被从注册表里剔掉（压根不出现）；
//     而进度完全由原生事件推进，替身不发事件的话队列会永远停在等待态。
//  2) seedDesktopIpc 必须在 page.goto 之前调用 —— 它靠 addInitScript 注入
//     __TAURI_INTERNALS__，导航之后注册就只对下一次导航生效了。
//  3) 用 ?tool=downloader 直达而不是点工具箱卡片 —— 点卡片会走 openToolWindow 去建
//     独立窗口，替身没实现 plugin:webview|create_webview_window，只能靠降级兜底，不稳定。
import { expect, test } from "@playwright/test";
import { emitDesktopEvent, seedDesktopIpc } from "../helpers.js";

const DIR = "D:\\models";

/** 让 downloader_probe 按 URL 后缀回放预置结果（被测的仍是生产路径：组件 → invoke → 命令名）。 */
const PROBES = {
  "a.bin": { fileName: "a.bin", total: 100 * 1024 * 1024, ranges: true },
  "b.bin": { fileName: "b.bin", total: 50 * 1024 * 1024, ranges: true },
  "same.bin": { fileName: "same.bin", total: 1024, ranges: true },
};

/** 拿第 n 项的队列 id（模板上的 data-role="item-<id>"）。 */
async function itemId(page, index = 0) {
  const role = await page.locator(".queue-item").nth(index).getAttribute("data-role");
  return String(role).replace(/^item-/, "");
}

test.beforeEach(async ({ page }) => {
  await seedDesktopIpc(page, {});
  await page.exposeFunction("__e2eProbe", (url) => {
    // 故意用 bad 前缀模拟探测失败：验证错误会显示在队列项上而不是静默失败
    if (url.includes("bad.bin")) throw new Error("无法确定文件大小：服务器既未返回 Content-Length，也不支持 Range 请求");
    const key = Object.keys(PROBES).find((k) => url.endsWith(k));
    if (!key) throw new Error(`E2E 桩没有为 ${url} 配置探测结果`);
    return PROBES[key];
  });
  await page.addInitScript(() => {
    // downloader_probe 在替身里会落到「其余命令一律成功但无内容」，那会让 fileName 变成
    // undefined（真实运行不会这样）。这里把它转到上面那个探针，其余命令仍走原路径。
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args) =>
      cmd === "downloader_probe" ? window.__e2eProbe(String(args?.url ?? "")) : original(cmd, args);
  });
  await page.goto("/?tool=downloader");
  await page.locator('[data-role="urls"]').waitFor({ state: "visible", timeout: 15_000 });
  // 等事件订阅真的注册上（onMounted 里 listen 是异步的，早了 emit 会扑空）
  await page.waitForFunction(() => window.__E2E_EVENT_HANDLERS__?.["downloader:progress"] !== undefined);
});

/** 填地址并入队，等到第一项出现且探测完成。 */
async function enqueue(page, urls) {
  await page.locator('[data-role="dir"]').fill(DIR);
  await page.locator('[data-role="urls"]').fill(urls);
  await page.locator('[data-role="add"]').click();
  await expect(page.locator(".queue-item").first()).toBeVisible();
}

test.describe("工具箱（多线程下载）", () => {
  test("渲染工具主体与空态；没选保存位置时明确提示", async ({ page }) => {
    await expect(page.locator(".tool-downloader")).toBeVisible();
    await expect(page.locator('[data-role="empty"]')).toBeVisible();
    await expect(page.locator('[data-role="dir-error"]')).toContainText("请先选择保存位置");
  });

  test("保存位置必须是绝对路径", async ({ page }) => {
    await page.locator('[data-role="dir"]').fill("models");
    await expect(page.locator('[data-role="dir-error"]')).toContainText("绝对路径");
  });

  test("粘贴多行地址逐行解析并去重（非 URL 行被忽略）", async ({ page }) => {
    await page.locator('[data-role="urls"]').fill("https://x.com/a.bin\n不是地址\nhttps://x.com/a.bin\nhttp://y.com/b.bin");
    // 4 行里 2 条是地址，其中一条重复 → 2 条
    await expect(page.locator('[data-role="parsed-count"]')).toHaveText("2");
  });

  test("入队后回填原生探测到的文件名与体积", async ({ page }) => {
    await enqueue(page, "https://x.com/a.bin");
    const item = page.locator(".queue-item").first();
    await expect(item.locator(".item-name")).toHaveText("a.bin");
    await expect(item.locator('[data-role="item-size"]')).toContainText("100.0 MB");
    await expect(item.locator(".state-chip")).toHaveText("等待中");
  });

  test("探测失败时该项显示错误原因，而不是静默失败", async ({ page }) => {
    await enqueue(page, "https://x.com/bad.bin");
    const item = page.locator(".queue-item").first();
    await expect(item.locator('[data-role="item-error"]')).toContainText("Content-Length");
    await expect(item.locator(".state-chip")).toHaveText("出错");
  });

  test("同名文件会被跳过并提示（避免互相覆盖）", async ({ page }) => {
    await enqueue(page, "https://x.com/same.bin\nhttps://y.com/same.bin");
    await expect(page.locator(".queue-item")).toHaveCount(1);
    await expect(page.locator(".toast")).toContainText("同名");
  });

  test("线程数可调，并即时给出分片数预览", async ({ page }) => {
    await enqueue(page, "https://x.com/a.bin");
    await expect(page.locator('[data-role="part-preview"]')).toContainText("8");
    await page.locator('[data-conns="16"]').click();
    await expect(page.locator('[data-conns="16"]')).toHaveClass(/on/);
    await expect(page.locator('[data-role="part-preview"]')).toContainText("16");
  });

  test("开始下载：进度事件推进进度与速度，完成事件收尾", async ({ page }) => {
    await enqueue(page, "https://x.com/a.bin");
    const item = page.locator(".queue-item").first();
    await expect(item.locator(".state-chip")).toHaveText("等待中");
    const id = await itemId(page);

    await page.locator('[data-role="start-all"]').click();
    await emitDesktopEvent(page, "downloader:progress", { id, downloaded: 25 * 1024 * 1024, total: 100 * 1024 * 1024, speed: 5 * 1024 * 1024, conns: 8 });
    await expect(item.locator(".state-chip")).toHaveText("下载中");
    await expect(item.locator('[data-role="item-size"]')).toContainText("25.0 MB / 100.0 MB");
    await expect(item.locator('[data-role="item-speed"]')).toContainText("5.0 MB/s");
    await expect(item.locator('[data-role="item-eta"]')).toBeVisible();
    await expect(item.locator('[data-role="item-conns"]')).toContainText("8");

    await emitDesktopEvent(page, "downloader:finished", { id, ok: true, downloaded: 100 * 1024 * 1024, total: 100 * 1024 * 1024 });
    await expect(item.locator(".state-chip")).toHaveText("已完成");
    await expect(page.locator('[data-role="queue-meta"]')).toContainText("1 / 1");
  });

  test("取消：收到 canceled 事件后回落到暂停态（不是失败），可继续", async ({ page }) => {
    await enqueue(page, "https://x.com/a.bin");
    const item = page.locator(".queue-item").first();
    const id = await itemId(page);

    await page.locator('[data-role="start-all"]').click();
    await emitDesktopEvent(page, "downloader:finished", { id, ok: false, canceled: true });
    await expect(item.locator(".state-chip")).toHaveText("已暂停");
    // 暂停项给的是「继续」而不是「暂停」——断点还在
    await expect(page.locator(`[data-role="resume-${id}"]`)).toBeVisible();
    await expect(item.locator('[data-role="item-error"]')).toHaveCount(0);
  });

  test("出错时显示原因，并标出可续传", async ({ page }) => {
    await enqueue(page, "https://x.com/a.bin");
    const item = page.locator(".queue-item").first();
    const id = await itemId(page);

    await page.locator('[data-role="start-all"]').click();
    await emitDesktopEvent(page, "downloader:finished", { id, ok: false, error: "连接停滞超过 20 秒，已断开准备重连", resumable: true });
    await expect(item.locator(".state-chip")).toHaveText("出错");
    await expect(item.locator('[data-role="item-error"]')).toContainText("停滞");
    await expect(item.locator('[data-role="resumable"]')).toBeVisible();
  });

  test("队列串行：一次只跑一个，完成后自动起下一个", async ({ page }) => {
    await enqueue(page, "https://x.com/a.bin\nhttps://y.com/b.bin");
    await expect(page.locator(".queue-item")).toHaveCount(2);
    const first = page.locator(".queue-item").nth(0);
    const second = page.locator(".queue-item").nth(1);
    const firstId = await itemId(page, 0);

    await page.locator('[data-role="start-all"]').click();
    await expect(first.locator(".state-chip")).toHaveText("下载中");
    // 第二个还在等：这些文件本身就把带宽吃满，并发只会让每个都变慢、进度条互相跳
    await expect(second.locator(".state-chip")).toHaveText("等待中");

    await emitDesktopEvent(page, "downloader:finished", { id: firstId, ok: true, downloaded: 1, total: 1 });
    await expect(first.locator(".state-chip")).toHaveText("已完成");
    await expect(second.locator(".state-chip")).toHaveText("下载中");
  });

  test("移除一项后队列剩下一项", async ({ page }) => {
    await enqueue(page, "https://x.com/a.bin\nhttps://y.com/b.bin");
    await expect(page.locator(".queue-item")).toHaveCount(2);
    await page.locator('[data-role^="remove-"]').first().click();
    await expect(page.locator(".queue-item")).toHaveCount(1);
  });
});
