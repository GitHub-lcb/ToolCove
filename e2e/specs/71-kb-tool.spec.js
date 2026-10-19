// 知识库工具 E2E（桌面视口）。
//
// 纯逻辑（标签解析/筛选/摘要/文件名归一）在 src/tools/kb/logic.test.js 有单测，
// 这里验的是**界面接线**：条目 CRUD、全文检索、标签筛选、文本文件导入，
// 以及「写进 kb 数据类别」（后续云同步与 Agent 的 data.* 都靠它）。
import { expect, test } from "@playwright/test";
import { readKv, seedData } from "../helpers.js";

/** 打开知识库工具：桌面端卡片是 button.tool-item（没有 data-tool 属性），按可见文本定位。 */
async function openKbTool(page) {
  await page.locator(".nav-item", { hasText: "本地工具" }).click();
  const card = page.locator(".lt-tool", { hasText: "知识库" });
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  await page.locator('[data-role="search"]').waitFor({ state: "visible", timeout: 10_000 });
}

async function addEntry(page, { title, tags = "", content }) {
  await page.locator('[data-role="new"]').click();
  await page.locator('[data-role="title"]').fill(title);
  if (tags) await page.locator('[data-role="tags"]').fill(tags);
  await page.locator('[data-role="content"]').fill(content);
  await page.locator('[data-role="save"]').click();
}

test.describe("工具箱（知识库）", () => {
  test("空库：如实说明怎么开始，而不是一片空白", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);

    await expect(page.locator('[data-role="empty"]')).toContainText("空的");
    await expect(page.locator('[data-role="welcome"]')).toBeVisible();
  });

  test("新建条目：出现在列表并可再次打开", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);
    await addEntry(page, { title: "Nginx 排障", tags: "运维, 网络", content: "502 先看上游健康检查" });

    const list = page.locator('[data-role="list"]');
    await expect(list).toContainText("Nginx 排障");
    await expect(list).toContainText("502 先看上游健康检查");

    // 落盘：条目写进 kb 数据类别（不是只活在内存里）
    const stored = await readKv(page, "kb");
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("Nginx 排障");
    expect(stored[0].tags).toEqual(["运维", "网络"]);
  });

  test("全文检索：关键词命中正文与标签，不只是标题", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);
    await addEntry(page, { title: "Nginx 排障", tags: "运维", content: "502 先看上游健康检查" });
    await addEntry(page, { title: "JWT 鉴权", tags: "后端", content: "access token 与 refresh token 分工" });
    await expect(page.locator('[data-role="entry"]')).toHaveCount(2);

    const search = page.locator('[data-role="search"]');
    await search.fill("refresh");
    await expect(page.locator('[data-role="entry"]')).toHaveCount(1);
    await expect(page.locator('[data-role="entry"]')).toContainText("JWT 鉴权");

    // 标签也算正文的一部分
    await search.fill("运维");
    await expect(page.locator('[data-role="entry"]')).toHaveCount(1);
    await expect(page.locator('[data-role="entry"]')).toContainText("Nginx 排障");

    await search.fill("不存在的关键词");
    await expect(page.locator('[data-role="empty"]')).toContainText("没有命中");
  });

  test("标签筛选：只留该标签的条目，且与关键词是「与」关系", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);
    await addEntry(page, { title: "Nginx 排障", tags: "运维, 网络", content: "502" });
    await addEntry(page, { title: "JWT 鉴权", tags: "后端", content: "access token" });

    await page.locator('[data-role="tag-cloud"] [data-tag="运维"]').click();
    await expect(page.locator('[data-role="entry"]')).toHaveCount(1);
    await expect(page.locator('[data-role="list"]')).not.toContainText("JWT 鉴权");

    // 关键词与标签同时生效：命中的必须是「运维标签 + 关键词」的交集
    await page.locator('[data-role="search"]').fill("token");
    await expect(page.locator('[data-role="entry"]')).toHaveCount(0);

    await page.locator('[data-role="tag-cloud"] [data-tag=""]').click();
    await expect(page.locator('[data-role="entry"]')).toHaveCount(1);
  });

  test("编辑已有条目：改完落盘的是同一条（不新增记录）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);
    await addEntry(page, { title: "草稿", content: "初稿内容" });

    await page.locator('[data-role="entry"]').first().click();
    await page.locator('[data-role="title"]').fill("定稿标题");
    await page.locator('[data-role="content"]').fill("改好的内容");
    await page.locator('[data-role="save"]').click();

    await expect(page.locator('[data-role="list"]')).toContainText("定稿标题");
    await expect(page.locator('[data-role="entry"]')).toHaveCount(1);
    const stored = await readKv(page, "kb");
    expect(stored).toHaveLength(1);
    expect(stored[0].content).toBe("改好的内容");
  });

  test("删除：先确认再删，且确认框写明删的是哪一条", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);
    await addEntry(page, { title: "要删掉的", content: "x" });

    await page.locator('[data-role="entry"]').first().click();
    await page.locator('[data-role="delete"]').click();
    await expect(page.locator(".cf-box")).toContainText("要删掉的");
    await page.locator(".cf-btn.ok").click();

    await expect(page.locator('[data-role="empty"]')).toContainText("空的");
    expect(await readKv(page, "kb")).toEqual([]);
  });

  test("未选条目时删除按钮不可点（避免删到不存在的目标）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);
    await expect(page.locator('[data-role="delete"]')).toBeDisabled();
  });

  test("标题留空但正文有内容：用正文摘要兜底，不让保存静默失败", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);
    await addEntry(page, { title: "", content: "只写了正文的一条知识" });

    await expect(page.locator('[data-role="list"]')).toContainText("只写了正文的一条知识");
    const stored = await readKv(page, "kb");
    expect(stored).toHaveLength(1);
    expect(stored[0].title).toBe("只写了正文的一条知识");
  });

  test("导入 txt 文件：标题取自文件名，正文全部入库", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);

    await page.locator('[data-role="file-input"]').setInputFiles({
      name: "运维手册.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 运维手册\n\n重启顺序：先停流量再重启。", "utf8"),
    });

    await expect(page.locator('[data-role="title"]')).toHaveValue("运维手册");
    await expect(page.locator('[data-role="content"]')).toHaveValue(/先停流量再重启/);
    const stored = await readKv(page, "kb");
    expect(stored).toHaveLength(1);
    expect(stored[0].source).toBe("运维手册.md");
  });

  test("导入空文件：明确提示没有内容可导入，不产出一条空记录", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);

    await page.locator('[data-role="file-input"]').setInputFiles({
      name: "empty.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("   \n\n", "utf8"),
    });

    await expect(page.locator(".toast").first()).toContainText("空的", { timeout: 5000 });
    expect(await readKv(page, "kb")).toEqual([]);
  });

  test("支持的导入格式写明只有纯文本类（PDF/Word 不在列表里）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto("/");
    await openKbTool(page);

    await expect(page.locator('[data-role="import-hint"]')).toContainText("PDF");
    await expect(page.locator('[data-role="import-hint"]')).toContainText("md");
  });
});
