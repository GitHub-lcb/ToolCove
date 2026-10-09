// 多线程下载器 E2E（移动视口）。
//
// 这个工具在安卓上**做不了**：分片要把十几 GB 摊在磁盘上再合并，而 SAF 给不出可随机写的
// 目录句柄。它在 mobile/app/toolbox.test.js 的 DESKTOP_ONLY_TOOLS 白名单里（该名单要求
// 每一条都写明降级原因），所以这里验的正是那条约定有没有落到界面上：
// 入口如实标注「仅桌面端」+ 说清为什么，**不是**一个点得动却没反应的空壳。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

test.describe("手机端工具箱（多线程下载）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("桌面独占的工具标注「仅桌面端」并说明原因，且点不动", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='toolbox']").click();

    const entry = page.locator('.m-item[data-tool="downloader"]');
    await expect(entry).toBeVisible();
    await expect(entry).toHaveAttribute("data-ready", "false");

    // 徽标要说清是「不迁」而不是「还没迁」，否则用户会一直等
    await expect(entry.locator(".m-badge")).toHaveText("仅桌面端");
    await expect(entry).toContainText("安卓没有任意路径写入");

    // 按钮禁用：点下去不能进一个空页面
    await expect(entry.locator(".m-item-main")).toBeDisabled();
  });

});
