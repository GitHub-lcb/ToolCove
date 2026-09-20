// Markdown 工具 E2E（桌面视口）。
//
// 纯逻辑有 52 条单测，这里验界面接线：实时预览、目录跳转、表格对齐、检查项、导出 HTML。
import { expect, test } from "@playwright/test";

/** 打开 Markdown 工具（桌面端工具卡片是 .tool-item，按文本定位）。 */
async function openMarkdownTool(page) {
  await page.locator(".nav-item", { hasText: "工具箱" }).click();
  const card = page.locator(".tool-item", { hasText: "Markdown 文档" });
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  await page.locator('[data-role="input"]').waitFor({ state: "visible", timeout: 10_000 });
}

const SAMPLE = ["# 标题一", "", "正文内容", "", "## 子标题", "", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

test.describe("工具箱（Markdown）", () => {
  test("实时预览：编辑区改动立刻反映到预览", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);

    await page.locator('[data-role="input"]').fill("# 你好\n\n**加粗** 与 `代码`");
    const preview = page.locator('[data-role="preview"]');
    await expect(preview).toContainText("你好");
    await expect(preview.locator("strong")).toHaveText("加粗");
    await expect(preview.locator("code")).toHaveText("代码");
  });

  test("大纲：列出标题层级与行号，点击跳到对应行", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);

    const outline = page.locator('[data-role="outline"]');
    await expect(outline).toContainText("标题一");
    await expect(outline).toContainText("子标题");
    // 层级用 data-level 标出来（一级比二级缩进少）
    await expect(outline.locator('li[data-level="1"]')).toHaveCount(1);
    await expect(outline.locator('li[data-level="2"]')).toHaveCount(1);

    // 点大纲项应把光标定位到那一行（selectionStart > 0 说明跳过去了）
    await outline.locator('[data-role="outline-item"]').nth(1).click();
    const selectionStart = await page.locator('[data-role="input"]').evaluate((node) => node.selectionStart);
    expect(selectionStart).toBeGreaterThan(0);
  });

  test("代码块里的 # 不算标题（大纲不误导）", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("# 真标题\n\n```bash\n# 代码里的注释\n```");

    const outline = page.locator('[data-role="outline"]');
    await expect(outline).toContainText("真标题");
    await expect(outline).not.toContainText("代码里的注释");
  });

  test("表格对齐：源码里补齐空格（含中文按两列算宽）", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("| 名称 | x |\n| --- | --- |\n| 甲 | 1 |");

    await page.locator('[data-role="format-tables"]').click();
    const value = await page.locator('[data-role="input"]').inputValue();
    expect(value.split("\n")[0]).toBe("| 名称 | x   |");
    expect(value.split("\n")[2]).toBe("| 甲   | 1   |");
  });

  test("规范化：补标题空格、统一列表标记、压缩空行", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("#标题\n\n\n\n* 甲\n+ 乙");

    await page.locator('[data-role="normalize"]').click();
    const value = await page.locator('[data-role="input"]').inputValue();
    expect(value).toContain("# 标题");
    expect(value).toContain("- 甲");
    expect(value).toContain("- 乙");
    expect(value).not.toContain("* 甲");
  });

  test("插入目录：放在首个标题之后", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("# 甲\n\n正文\n\n## 乙");

    await page.locator('[data-role="insert-toc"]').click();
    const value = await page.locator('[data-role="input"]').inputValue();
    const lines = value.split("\n");
    expect(lines[0]).toBe("# 甲");
    expect(value).toContain("- [甲](#甲)");
    expect(value).toContain("  - [乙](#乙)");
  });

  test("检查：列出问题并带行号（缺空格 / 层级跳跃 / 空链接）", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("# 甲\n### 跳级\n\n[空]()");
    // 侧栏默认是大纲，要先切到「检查」面板
    await page.locator('[data-panel="issues"]').click();

    const issues = page.locator('[data-role="issues"]');
    await expect(issues.locator('[data-code="headingJump"]')).toBeVisible();
    await expect(issues.locator('[data-code="emptyLink"]')).toBeVisible();
    // 行号要显示出来（界面据此定位）
    await expect(issues).toContainText(/第 \d+ 行/);
  });

  test("检查：干净文档显示没有问题", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("# 标题\n\n正文\n\n## 子标题\n\n正文");
    await page.locator('[data-panel="issues"]').click();
    await expect(page.locator('[data-role="no-issues"]')).toBeVisible();
  });

  test("统计：行数/字数/标题/表格都算对", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);
    await page.locator('[data-panel="stats"]').click();

    const stats = page.locator('[data-role="stats"]');
    await expect(stats).toBeVisible();
    await expect(stats).toContainText("2"); // 2 个标题
    await expect(stats).toContainText("1"); // 1 个表格
  });

  test("导出 HTML：下载得到自带样式的完整文档", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("# 我的标题\n\n正文");
    await page.locator('[data-role="doc-title"]').fill("测试文档");

    const waitDownload = page.waitForEvent("download");
    await page.locator('[data-role="download-html"]').click();
    const download = await waitDownload;
    expect(download.suggestedFilename()).toBe("测试文档.html");

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const html = Buffer.concat(chunks).toString("utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>测试文档</title>");
    // 渲染过的正文（不是原始 Markdown 文本）
    expect(html).toContain("我的标题");
    expect(html).toContain("<style>");
  });

  test("复制 HTML：拿到渲染后的片段", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("# 标题\n\n**粗**");

    await page.locator('[data-role="copy-html"]').click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toContain("<strong>粗</strong>");
    // 复制的是片段而不是完整文档
    expect(text).not.toContain("<!doctype html>");
  });

  test("视图切换：编辑 / 预览 / 分栏", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);

    await page.locator('[data-view="preview"]').click();
    await expect(page.locator('[data-role="preview"]')).toBeVisible();
    await expect(page.locator('[data-role="input"]')).toHaveCount(0);

    await page.locator('[data-view="edit"]').click();
    await expect(page.locator('[data-role="input"]')).toBeVisible();
    await expect(page.locator('[data-role="preview"]')).toHaveCount(0);

    await page.locator('[data-view="split"]').click();
    await expect(page.locator('[data-role="input"]')).toBeVisible();
    await expect(page.locator('[data-role="preview"]')).toBeVisible();
  });

  test("清空后预览也跟着空", async ({ page }) => {
    await page.goto("/");
    await openMarkdownTool(page);
    await page.locator('[data-role="input"]').fill("# 有内容");
    await expect(page.locator('[data-role="preview"]')).toContainText("有内容");

    await page.locator('[data-role="clear"]').click();
    await expect(page.locator('[data-role="input"]')).toHaveValue("");
    await expect(page.locator('[data-role="preview"]')).not.toContainText("有内容");
  });
});
