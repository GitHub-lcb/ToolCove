// 手机端壳的冒烟：验证「平台判定 + 原生桥 + 字典」三件事，并且**不需要 APK**。
//
// 这正是把原生能力做成可注入桥的价值：移动端前端能在浏览器里以移动视口跑自动化，
// 原生侧只需保证命令名与语义一致。安卓壳本身的编译与装机由 P1 的 Gradle 任务验证。
import { expect, test } from "@playwright/test";

const MOBILE = "/mobile/app/index.html";

test.describe("手机端壳（移动视口）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("渲染壳层，且平台判定为 mobile（不是 desktop/browser）", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto(MOBILE);

    const shell = page.locator(".m-shell");
    await expect(shell).toBeVisible();
    // 构建期常量 __MOBILE__ 生效 → env.js 判定为移动端
    await expect(shell).toHaveAttribute("data-platform", "mobile");
    await expect(page.locator(".m-title")).toHaveText("ToolCove");
    // 字典可用（不是漏出词条 key）
    await expect(page.locator(".m-hint")).not.toHaveText(/mobile\./);
    expect(errors).toEqual([]);
  });

  test("浏览器里没有原生桥：如实显示为网页形态，而不是假装有", async ({ page }) => {
    await page.goto(MOBILE);
    await expect(page.locator(".m-bridge")).toHaveAttribute("data-on", "false");
    await expect(page.locator(".m-native")).toHaveAttribute("data-on", "false");
    // 文案要能解释清楚「为什么没有」，而不是一句失败
    await expect(page.locator(".m-bridge")).toContainText(/IndexedDB|网页形态/);
  });

  test("能力矩阵按安卓现实取值：SQLite 可用，JDBC / 真打印 / ICMP 明确不支持", async ({ page }) => {
    await page.goto(MOBILE);
    const on = async (cap) => (await page.locator(`[data-cap="${cap}"]`).getAttribute("data-on")) === "true";
    expect(await on("sqlite"), "SQLite 在安卓上可用").toBe(true);
    expect(await on("jdbc"), "安卓没有 JDBC").toBe(false);
    expect(await on("rawPrint"), "安卓没有 Windows RAW 打印队列").toBe(false);
    expect(await on("icmpDiagnostics"), "WebView 无 ICMP/原始套接字").toBe(false);
    expect(await on("multiWindow"), "安卓没有 Tauri 多窗口").toBe(false);
    expect(await on("aiRequest"), "AI 请求可用（经桥或直连）").toBe(true);
  });

  test("触摸目标不小于 44px（安卓无障碍建议）", async ({ page }) => {
    await page.goto(MOBILE);
    const heights = await page.locator(".m-cap").evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(3);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
  });
});
