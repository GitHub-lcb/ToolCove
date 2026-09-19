// AI 对话工具 E2E（移动视口）。
//
// 复用 helpers 的 mockAI（走浏览器 fetch 分支的流式接口）与 AI_SETTINGS——
// 与桌面端用例同一套桩，所以这里验的是"手机端界面对同一份 AI 通道的接线"。
import { expect, test } from "@playwright/test";
import { mockAI, seedData, seedWithAI } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openChat = async (page) => {
  await page.locator('.m-item[data-tool="chat"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="chat"]')).toBeVisible();
};

test.describe("手机端工具箱（AI 对话）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("未配 AI 时给出可读提示，而不是静默失败", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openChat(page);

    const tool = page.locator('[data-tool="chat"]');
    await expect(tool.locator('[data-role="empty"]')).toBeVisible();
    await tool.locator('[data-role="input"]').fill("你好");
    await tool.locator('[data-role="send"]').click();
    // 提示要指向"去设置里配 AI"，而不是只说失败
    await expect(tool.locator('[data-role="error"]')).toContainText(/AI|配置/);
  });

  test("发一条消息：用户消息与 AI 回复都进对话区", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [{ type: "final", answer: "你好，我是 AI" }] });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openChat(page);

    const tool = page.locator('[data-tool="chat"]');
    await tool.locator('[data-role="input"]').fill("你好");
    await tool.locator('[data-role="send"]').click();

    const messages = tool.locator('[data-role="messages"]');
    await expect(messages.locator('[data-role="user"]')).toContainText("你好");
    await expect(messages.locator('[data-role="assistant"]').last()).toContainText(/你好|AI/, { timeout: 20_000 });
  });

  test("会话标题自动取自首条用户消息", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [{ type: "final", answer: "收到" }] });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openChat(page);

    const tool = page.locator('[data-tool="chat"]');
    await tool.locator('[data-role="input"]').fill("帮我写一段正则校验手机号");
    await tool.locator('[data-role="send"]').click();

    // 会话 chip 上应出现标题（取首条消息的前若干字）
    await expect(tool.locator('[data-role="sessions"]')).toContainText("帮我写一段正则", { timeout: 20_000 });
  });

  test("多会话：新建后可以来回切换，各自保留内容", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [{ type: "final", answer: "回复一" }] });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openChat(page);

    const tool = page.locator('[data-tool="chat"]');
    await tool.locator('[data-role="input"]').fill("第一个会话");
    await tool.locator('[data-role="send"]').click();
    await expect(tool.locator('[data-role="messages"]')).toContainText("第一个会话");

    // 新建第二个会话：消息区应当是空的
    await tool.locator('[data-role="new-session"]').click();
    await expect(tool.locator('[data-role="empty"]')).toBeVisible();

    // 切回第一个：内容还在
    await tool.locator('[data-session]').nth(1).click();
    await expect(tool.locator('[data-role="messages"]')).toContainText("第一个会话");
  });

  test("会话落盘：刷新后会话与消息仍在", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [{ type: "final", answer: "持久化回复" }] });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openChat(page);

    const tool = page.locator('[data-tool="chat"]');
    await tool.locator('[data-role="input"]').fill("这条要能持久化");
    await tool.locator('[data-role="send"]').click();
    await expect(tool.locator('[data-role="messages"]')).toContainText(/持久化回复|持久化/, { timeout: 20_000 });

    await page.reload();
    await goToolbox(page);
    await openChat(page);
    await expect(page.locator('[data-tool="chat"] [data-role="sessions"]')).toContainText("这条要能持久化");
  });

  test("提示词预设可选用（正文来自字典，不是空的）", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [{ type: "final", answer: "ok" }] });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openChat(page);

    const tool = page.locator('[data-tool="chat"]');
    await tool.locator('[data-role="input"]').fill("随便说点什么");
    await tool.locator('[data-role="send"]').click();
    await expect(tool.locator('[data-role="messages"]')).toContainText("随便说点什么");

    await tool.locator('[data-role="toggle-presets"]').click();
    const presets = tool.locator('[data-role="presets"] .m-chip');
    await expect(presets.first()).toBeVisible();
    // 预设名不能渲染成词条 key
    const text = await presets.first().innerText();
    expect(text).not.toContain("toolbox.");

    // 选用预设：正文填进输入框（且不是 undefined）
    await presets.first().click();
    const value = await tool.locator('[data-role="input"]').inputValue();
    expect(value.length).toBeGreaterThan(0);
    expect(value).not.toContain("undefined");
  });

  test("删除会话后回到空态", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: [{ type: "final", answer: "ok" }] });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openChat(page);

    const tool = page.locator('[data-tool="chat"]');
    await tool.locator('[data-role="input"]').fill("待删除的会话");
    await tool.locator('[data-role="send"]').click();
    await expect(tool.locator('[data-role="messages"]')).toContainText("待删除的会话");

    await tool.locator('[data-role="delete-session"]').click();
    await expect(tool.locator('[data-role="empty"]')).toBeVisible();
  });

  test("工具箱进度与页面条目数一致（不写死数字：加工具不该让这条失效）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    // ⚠️ 不写死 "15/15" 这类数字——每加一个工具就要改一次，已经改过两轮。
    // 改成断言"进度显示的数字 = 页面上真实可点的条目数"，这才是这条用例要守的东西。
    const total = await page.locator(".m-item[data-tool]").count();
    const progress = await page.locator('[data-role="tool-progress"]').innerText();
    expect(total).toBeGreaterThan(10);
    expect(progress).toContain(`${total}/${total}`);
    await expect(page.locator('.m-item[data-ready="false"]')).toHaveCount(0);
    // AI 分组也在（之前整个分组漏掉了）
    await expect(page.locator('.m-item[data-tool="chat"]')).toBeVisible();
  });
});
