// 冒烟：应用能起来、导航能切、工具能开。
// 这类用例的价值在「白屏/点击无响应」——0.6.1 就是这么挂的，而单测测不出来（词条编译失败、
// 视图挂载异常都在运行时才暴露）。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

test("首屏渲染 Agent 工作台，不出现白屏或未解析词条", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await seedData(page, {});
  await page.goto("/");

  // 首屏是 Agent 工作台（App.vue 的 MODULES 第一项）
  await expect(page.locator(".agent")).toBeVisible();
  await expect(page.getByText("欢迎使用 Agent 工作台")).toBeVisible();
  // 目标输入框与主按钮可用
  await expect(page.getByPlaceholder(/描述目标/)).toBeVisible();

  // 未解析的词条会以 "agent.xxx" 形态漏到界面上；白屏则连 body 文本都没有
  const body = await page.locator("body").innerText();
  expect(body).not.toMatch(/\b(agent|nav|toolbox|settings)\.[a-zA-Z]+\.[a-zA-Z]+/);
  expect(body.length).toBeGreaterThan(50);
  expect(errors).toEqual([]);
});

test("四个导航模块都能切换并渲染出内容", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await seedData(page, {});
  await page.goto("/");
  await expect(page.locator(".agent")).toBeVisible();

  // 导航按钮没有 data-module，用可见文案定位（也就是用户看到的那几个词）
  const modules = [
    { label: "工作台", marker: /概览|迭代进度|待产品确认/ },
    { label: "记录", marker: /速记|问题/ },
    { label: "工具箱", marker: /工具箱|常用工具|数据与文本/ },
    { label: "Agent", marker: /Agent 工作台|欢迎使用/ },
  ];
  for (const item of modules) {
    await page.locator(".nav-item", { hasText: item.label }).first().click();
    const text = await page.locator("body").innerText();
    expect(text, `${item.label} 模块应渲染出内容`).toMatch(item.marker);
    // 未解析词条会以 "nav.xxx" 形态漏出来
    expect(text, `${item.label} 不应漏出词条 key`).not.toMatch(/\b(agent|nav|toolbox)\.[a-zA-Z]+\.[a-zA-Z]+/);
  }
  expect(errors).toEqual([]);
});

test("设置页显示构建指纹（用于判断运行的是哪次构建）", async ({ page }) => {
  await seedData(page, {});
  await page.goto("/");
  await page.getByTitle(/设置/).first().click().catch(async () => {
    await page.getByText("设置", { exact: true }).first().click();
  });
  await expect(page.locator(".ver-stamp")).toBeVisible();
  const stamp = await page.locator(".ver-stamp").innerText();
  // web 构建注入了构建时间；开发态是 dev
  expect(stamp).toMatch(/\d{4}-\d{2}-\d{2}|dev/);
});
