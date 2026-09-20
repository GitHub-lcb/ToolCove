// Markdown 工具 E2E（移动视口）。
//
// 与桌面端共用同一份纯逻辑（src/markdownTool.js）与同一个渲染器（shared.renderMarkdown），
// 这里验手机端的界面接线：编辑/预览切换、chips 操作、面板展开、导出下载。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const openMarkdown = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await page.locator('.m-item[data-tool="markdown"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="markdown"]')).toBeVisible();
};

const SAMPLE = ["# 标题一", "", "正文内容", "", "## 子标题", "", "| a | b |", "| --- | --- |", "| 1 | 2 |"].join("\n");

test.describe("手机端工具箱（Markdown）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("默认在编辑态，切到预览能看到渲染结果", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);

    await page.locator('[data-role="input"]').fill("# 你好\n\n**加粗** 与 `代码`");
    await page.locator('[data-view="preview"]').click();

    const preview = page.locator('[data-role="preview"]');
    await expect(preview).toContainText("你好");
    await expect(preview.locator("strong")).toHaveText("加粗");
    await expect(preview.locator("code")).toHaveText("代码");
    // 预览态下编辑区不显示（手机上并排没法看）
    await expect(page.locator('[data-role="input"]')).toHaveCount(0);
  });

  test("大纲面板：标题层级与行号，代码块里的 # 不算", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);
    await page.locator('[data-role="input"]').fill("# 真标题\n\n```bash\n# 代码里的注释\n```\n\n## 二级");

    await page.locator('[data-panel="outline"]').click();
    const outline = page.locator('[data-role="outline"]');
    await expect(outline).toContainText("真标题");
    await expect(outline).toContainText("二级");
    await expect(outline).not.toContainText("代码里的注释");
    // chip 上显示标题数量
    await expect(page.locator('[data-panel="outline"]')).toContainText("2");
  });

  test("表格对齐：中文按两列算宽", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);
    await page.locator('[data-role="input"]').fill("| 名称 | x |\n| --- | --- |\n| 甲 | 1 |");

    await page.locator('[data-role="format-tables"]').click();
    const value = await page.locator('[data-role="input"]').inputValue();
    expect(value.split("\n")[0]).toBe("| 名称 | x   |");
    expect(value.split("\n")[2]).toBe("| 甲   | 1   |");
    await expect(page.locator('[data-role="notice"]')).toContainText(/对齐/);
  });

  test("规范化：补空格、统一列表标记", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);
    await page.locator('[data-role="input"]').fill("#标题\n\n* 甲\n+ 乙");

    await page.locator('[data-role="normalize"]').click();
    const value = await page.locator('[data-role="input"]').inputValue();
    expect(value).toContain("# 标题");
    expect(value).toContain("- 甲");
    expect(value).not.toContain("* 甲");
  });

  test("插入目录：放在首个标题之后", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);
    await page.locator('[data-role="input"]').fill("# 甲\n\n正文\n\n## 乙");

    await page.locator('[data-role="insert-toc"]').click();
    const value = await page.locator('[data-role="input"]').inputValue();
    expect(value.split("\n")[0]).toBe("# 甲");
    expect(value).toContain("- [甲](#甲)");
    expect(value).toContain("  - [乙](#乙)");
  });

  test("检查面板：问题带行号与原因", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);
    await page.locator('[data-role="input"]').fill("# 甲\n### 跳级\n\n[空]()");

    await page.locator('[data-panel="issues"]').click();
    const issues = page.locator('[data-role="issues"]');
    await expect(issues.locator('[data-code="headingJump"]')).toBeVisible();
    await expect(issues.locator('[data-code="emptyLink"]')).toBeVisible();
    await expect(issues).toContainText(/第 \d+ 行/);
  });

  test("统计面板：标题数与表格数", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);

    await page.locator('[data-panel="stats"]').click();
    const stats = page.locator('[data-role="stats"]');
    await expect(stats).toBeVisible();
    await expect(stats).toContainText("2"); // 2 个标题
    await expect(stats).toContainText("1"); // 1 个表格
  });

  test("导出 HTML：下载得到完整文档", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);
    await page.locator('[data-role="input"]').fill("# 我的标题\n\n正文");
    await page.locator('[data-role="doc-title"]').fill("手机文档");

    const waitDownload = page.waitForEvent("download");
    await page.locator('[data-role="download-html"]').click();
    const download = await waitDownload;
    expect(download.suggestedFilename()).toBe("手机文档.html");

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const html = Buffer.concat(chunks).toString("utf8");
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("<title>手机文档</title>");
    expect(html).toContain("我的标题");
  });

  test("内容落盘：切走再回来还在", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openMarkdown(page);
    await page.locator('[data-role="input"]').fill("# 持久化的内容");

    // 切到别的标签再回来
    await page.locator(".m-tab[data-tab='records']").click();
    await page.locator(".m-tab[data-tab='toolbox']").click();
    await expect(page.locator(".m-toolbox")).toBeVisible();
    await page.locator('.m-item[data-tool="markdown"] .m-item-main').click();
    await expect(page.locator('[data-role="input"]')).toHaveValue(/# 持久化的内容/);
  });

  test("工具箱：Markdown 已登记，进度与条目数一致", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='toolbox']").click();

    await expect(page.locator('.m-item[data-tool="markdown"]')).toBeVisible();
    // 不写死总数：加工具不该让用例失效
    const total = await page.locator(".m-item[data-tool]").count();
    await expect(page.locator('[data-role="tool-progress"]')).toContainText(`${total}/${total}`);
  });
});
