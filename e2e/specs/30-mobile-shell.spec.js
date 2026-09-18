// 手机端地基的 E2E：平台判定、原生桥、能力矩阵、触摸目标。
//
// 覆盖方式说明：移动端前端在浏览器里就是普通网页（原生能力由可注入的桥提供），
// 所以这些用例不需要 APK——安卓壳本身的编译与装机由后续的 Gradle 任务验证。
// 页面结构在 Phase 2 变成「底部标签 + 记录页」，因此锚点是 .m-app / .m-tabbar / .m-tab。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

test.describe("手机端地基（移动视口）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("渲染壳层，平台判定为 mobile，且字典可用", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await seedData(page, { snippets: [], problems: [] });
    await page.goto(MOBILE);

    const app = page.locator(".m-app");
    await expect(app).toBeVisible();
    // 构建期常量 __MOBILE__ 生效 → env.js 判定为移动端
    await expect(app).toHaveAttribute("data-platform", "mobile");
    // 底部标签栏渲染出全部 5 个模块，且不漏词条 key
    await expect(page.locator(".m-tab")).toHaveCount(5);
    const labels = await page.locator(".m-tab-label").allInnerTexts();
    expect(labels.join(" ")).not.toMatch(/nav\./);
    expect(errors).toEqual([]);
  });

  test("浏览器里没有原生桥：如实显示为网页形态，而不是假装有", async ({ page }) => {
    await seedData(page, { snippets: [], problems: [] });
    await page.goto(MOBILE);
    // 切到未迁移的模块才能看到桥状态（记录页不展示它）
    await page.locator(".m-tab[data-tab='settings']").click();
    const bridge = page.locator(".m-bridge");
    await expect(bridge).toHaveAttribute("data-on", "false");
    // 文案要解释「为什么没有」以及此时的降级行为，而不是一句失败
    await expect(bridge).toContainText(/IndexedDB|网页形态/);
  });

  test("触摸目标不小于 44px（安卓无障碍建议）", async ({ page }) => {
    await seedData(page, { snippets: [], problems: [] });
    await page.goto(MOBILE);
    const heights = await page.locator(".m-tab").evaluateAll((nodes) => nodes.map((n) => n.getBoundingClientRect().height));
    expect(heights).toHaveLength(5);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(44);
  });

  // 能力矩阵（哪些能力在安卓上可用）是纯数据，由 env.capabilities.test.js 单测覆盖，
  // 不在这里隔着构建产物做断言——那样测的是打包细节，不是能力取值。
});
