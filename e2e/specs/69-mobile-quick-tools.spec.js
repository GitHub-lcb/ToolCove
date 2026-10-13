// 手机端工具箱的「常用工具」区（移动视口）。
//
// 守的是两件事，都是"看起来做了但不可用"的高发区：
//  1. 用过一次的工具要自己浮到常用区（不需要用户手工整理）——排序规则与桌面端同一份纯函数；
//  2. 收藏（★）能把工具钉在常用区最前，且刷新后仍然在（持久化真的落盘了）。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

test.describe("手机端工具箱 · 常用工具", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("打开过的工具出现在常用区；收藏后钉在最前且刷新仍在", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='toolbox']").click();

    const quick = page.locator('[data-role="quick"]');
    await expect(quick).toBeVisible();
    // 首次进入没有任何历史：常用区按注册表顺序补位，保证入口不为空
    const first = await quick.locator(".m-quick-item").first().getAttribute("data-quick");
    expect(first).toBeTruthy();

    // 打开一个"靠后"的工具（时间工具），它此前不在常用区
    await page.locator('.m-item[data-tool="time"] .m-item-main').click();
    await expect(page.locator('.m-tool[data-tool="time"]')).toBeVisible();
    await page.locator(".m-back").click();

    // 用过一次 → 最近使用把它顶到常用区第一屏（次数 ≥2 才算"常用"，最近使用立竿见影）
    await expect(quick.locator('[data-quick="time"]')).toBeVisible();

    // 收藏：钉在常用区最前
    await page.locator('[data-role="pin-time"]').click();
    await expect(quick.locator(".m-quick-item").first()).toHaveAttribute("data-quick", "time");

    // 刷新后仍在：收藏与使用次数都真的落盘了
    await page.reload();
    await page.locator(".m-tab[data-tab='toolbox']").click();
    await expect(quick.locator(".m-quick-item").first()).toHaveAttribute("data-quick", "time");
  });
});
