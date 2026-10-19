// 输入框里的工作域弹层：新建即绑定。
// 之前这里只能挑研发模块里已有的领域，一个都没有时是死胡同（「去研发模块创建」）。
import { expect, test } from "@playwright/test";

test("工作域弹层里新建并绑定，刷新后领域仍在", async ({ page }) => {
  await page.goto("/");

  await page.locator(".mode-pill").click();
  await page.locator('[data-role="domain-new"]').click();
  await page.locator('[data-role="domain-new-name"]').fill("云仓");
  await page.locator('[data-role="domain-new-submit"]').click();

  // 建成即绑定：胶囊直接显示领域名，title 是上下文预览
  await expect(page.locator(".mode-pill")).toContainText("工作域：云仓");
  await expect(page.locator(".mode-pill")).toHaveAttribute("title", "上下文：云仓 · 0 个代码池");

  // 刷新：会话绑定回到「不指定」（一次性上下文不落盘），但领域数据还在
  await page.reload();
  await expect(page.locator(".mode-pill")).toContainText("不指定");
  await page.locator(".mode-pill").click();
  await expect(page.locator(".domain-pop")).toContainText("云仓");
});

test("回车也能创建（输入法组合中的回车不算）", async ({ page }) => {
  await page.goto("/");

  await page.locator(".mode-pill").click();
  await page.locator('[data-role="domain-new"]').click();
  const input = page.locator('[data-role="domain-new-name"]');
  await input.fill("回车域");
  await input.press("Enter");

  await expect(page.locator(".mode-pill")).toContainText("工作域：回车域");
});
