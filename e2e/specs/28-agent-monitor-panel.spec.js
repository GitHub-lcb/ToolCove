import { expect, test } from "@playwright/test";
import { expectRunFinished, final, mockAI, runGoal, seedWithAI, toolCall } from "../helpers.js";

const FLOW = [toolCall("json.parse", { text: '{"a":1}' }, "c1"), final("解析完成")];

test("监控由用户打开，空闲与运行时点击均有反馈", async ({ page }) => {
  await seedWithAI(page);
  await mockAI(page, { responses: FLOW, delayMs: 700 });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "任务监控", exact: true });
  await expect(page.locator(".monitor")).toHaveCount(0);
  await toggle.click();
  await expect(page.locator(".monitor")).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "收起任务监控", exact: true }).click();
  await runGoal(page, "解析这段 JSON");
  await expect(page.locator(".working")).toBeVisible();
  await expect(page.locator(".monitor")).toHaveCount(0);
  await expectRunFinished(page);
  await toggle.click();
  await expect(page.locator(".monitor")).toContainText("解析这段 JSON");
  await expect(page.locator(".mon-meter")).toContainText("模型请求");
});

test("取消后诊断折叠、结束说明中性，重填不自动发起任务", async ({ page }) => {
  await seedWithAI(page);
  await mockAI(page, { responses: ["invalid output", { type: "ask_user", question: "请提供文件路径" }] });
  await page.goto("/");
  await runGoal(page, "pdf处理");
  await expect(page.locator(".confirm")).toBeVisible();
  await page.getByRole("button", { name: "跳过并结束" }).click();
  await expectRunFinished(page, /已取消/);
  await expect(page.locator(".outcome")).toContainText("任务已停止");
  await expect(page.locator(".sum-card")).toHaveCount(0);
  await expect(page.locator(".execution")).not.toHaveAttribute("open");
  await expect(page.locator(".tl-notice").first()).not.toBeVisible();
  await page.locator(".execution-head").click();
  await expect(page.locator(".tl-notice").first()).toBeVisible();
  await page.getByRole("button", { name: "重新填入" }).click();
  await expect(page.locator(".goal")).toHaveValue("pdf处理");
  await expectRunFinished(page, /已取消/);
});

test("运行立即清空已发送目标，结束后保留期间起草的新目标，新建清空草稿", async ({ page }) => {
  await seedWithAI(page);
  await mockAI(page, { responses: [{ type: "ask_user", question: "请补充文件路径" }, final("完成")] });
  await page.goto("/");
  await runGoal(page, "处理文件");
  await expect(page.locator(".confirm")).toBeVisible();
  await expect(page.locator(".goal")).toHaveValue("");
  await page.locator(".goal").fill("下一项任务");
  await page.locator(".cf-answer").fill("C:/demo.txt");
  await page.getByRole("button", { name: "发送回答" }).click();
  await expectRunFinished(page);
  await expect(page.locator(".goal")).toHaveValue("下一项任务");
  await page.getByRole("button", { name: "新任务", exact: true }).click();
  await expect(page.locator(".goal")).toHaveValue("");
  await expect(page.locator(".canvas-empty")).toBeVisible();
});

test("提问框不把中文输入法回车当提交，Ctrl+Enter 可发送", async ({ page }) => {
  await seedWithAI(page);
  await mockAI(page, { responses: [{ type: "ask_user", question: "请补充文件路径" }, final("完成")] });
  await page.goto("/");
  await runGoal(page, "处理文件");
  const input = page.locator(".cf-answer");
  await input.fill("文件路径");
  await input.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(page.locator(".confirm")).toBeVisible();
  await input.press("Control+Enter");
  await expectRunFinished(page);
});

test("长内容、窄窗口、监控展开不挤走输入框，手动主题保持一致", async ({ page }) => {
  await seedWithAI(page);
  await page.goto("/");
  await page.locator(".goal").fill("长目标".repeat(300));
  for (const width of [1440, 960, 640, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await page.getByRole("button", { name: "任务监控", exact: true }).click();
    await expect(page.locator(".monitor")).toBeVisible();
    await page.getByRole("button", { name: "收起任务监控", exact: true }).click();
    const composer = await page.locator(".composer").boundingBox();
    expect(composer.y + composer.height).toBeLessThanOrEqual(800);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await expect(page.locator(".agent")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.locator(".agent")).toHaveCSS("background-color", "rgb(22, 27, 34)");
});

test("切换工作面后返回运行，已发送目标不会重新进入输入框", async ({ page }) => {
  await seedWithAI(page);
  await mockAI(page, { responses: [{ type: "ask_user", question: "请提供路径" }, final("完成")] });
  await page.goto("/");
  await runGoal(page, "处理当前文件");
  await expect(page.locator(".confirm")).toBeVisible();
  await page.locator(".nav").getByRole("button", { name: "记录", exact: true }).click();
  await page.locator(".agent-monitor").click();
  await expect(page.locator(".confirm")).toBeVisible();
  await expect(page.locator(".goal")).toHaveValue("");
  await page.locator(".cf-answer").fill("C:/demo.txt");
  await page.getByRole("button", { name: "发送回答" }).click();
  await expectRunFinished(page);
});
