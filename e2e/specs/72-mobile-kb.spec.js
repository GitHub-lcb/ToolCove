// 知识库工具 E2E（移动视口）。
//
// 与桌面端**共用同一份纯逻辑**（src/tools/kb/logic.js）与**同一个数据类别**（kb，随云同步），
// 所以这里重点验手机端的界面接线：列表 ⇄ 编辑两态切换、检索、标签横滑筛选、删除确认、文件导入。
import { expect, test } from "@playwright/test";
import { expectMobileToolboxCatalog, seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const openKb = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await page.locator('.m-item[data-tool="kb"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="kb"]')).toBeVisible();
};

async function addEntry(page, { title, tags = "", content }) {
  await page.locator('[data-role="new"]').click();
  await page.locator('[data-role="title"]').fill(title);
  if (tags) await page.locator('[data-role="tags-input"]').fill(tags);
  await page.locator('[data-role="content"]').fill(content);
  await page.locator('[data-role="save"]').click();
}

test.describe("手机端工具箱（知识库）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("工具箱：知识库已登记为可用，且目录与注册表一致", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='toolbox']").click();

    await expect(page.locator('.m-item[data-tool="kb"]')).toBeVisible();
    await expectMobileToolboxCatalog(page);
  });

  test("空库：说明怎么开始", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openKb(page);

    await expect(page.locator('[data-role="empty"]')).toContainText("空的");
    await expect(page.locator('[data-role="welcome"]')).toBeVisible();
  });

  test("新建条目：保存后回到列表并显示出来", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openKb(page);
    await addEntry(page, { title: "Nginx 排障", tags: "运维, 网络", content: "502 先看上游健康检查" });

    await expect(page.locator('[data-role="list"]')).toContainText("Nginx 排障");
    await expect(page.locator('[data-role="notice"]')).toContainText("已保存");
  });

  test("打开条目进入编辑态，改完保存的是同一条", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openKb(page);
    await addEntry(page, { title: "草稿", content: "初稿内容" });

    await page.locator('[data-role="entry"]').first().click();
    await expect(page.locator('[data-role="title"]')).toHaveValue("草稿");
    await page.locator('[data-role="title"]').fill("定稿标题");
    await page.locator('[data-role="save"]').click();

    await expect(page.locator('[data-role="list"]')).toContainText("定稿标题");
  });

  test("全文检索与标签筛选", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openKb(page);
    await addEntry(page, { title: "Nginx 排障", tags: "运维", content: "502 先看上游健康检查" });
    await addEntry(page, { title: "JWT 鉴权", tags: "后端", content: "access token 与 refresh token 分工" });
    await expect(page.locator('[data-role="entry"]')).toHaveCount(2);

    // 关键词命中正文
    await page.locator('[data-role="search"]').fill("refresh");
    await expect(page.locator('[data-role="entry"]')).toHaveCount(1);
    await expect(page.locator('[data-role="entry"]')).toContainText("JWT 鉴权");

    await page.locator('[data-role="search"]').fill("");
    await page.locator('.m-kb-tags [data-tag="运维"]').click();
    await expect(page.locator('[data-role="entry"]')).toHaveCount(1);
    await expect(page.locator('[data-role="list"]')).not.toContainText("JWT 鉴权");

    // 空结果要明说，而不是留一片空白
    await page.locator('[data-role="search"]').fill("不存在的关键词");
    await expect(page.locator('[data-role="empty"]')).toContainText("没有命中");
  });

  test("删除：确认框写明删的是哪一条，确认后确实删掉", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openKb(page);
    await addEntry(page, { title: "要删掉的", content: "x" });

    await page.locator('[data-role="entry"]').first().click();
    await page.locator('[data-role="delete"]').click();
    await expect(page.locator('[data-role="confirm"]')).toContainText("要删掉的");
    await page.locator('[data-role="confirm-ok"]').click();

    await expect(page.locator('[data-role="empty"]')).toContainText("空的");
  });

  test("取消删除：条目还在", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openKb(page);
    await addEntry(page, { title: "留着", content: "x" });

    await page.locator('[data-role="entry"]').first().click();
    await page.locator('[data-role="delete"]').click();
    await page.locator('[data-role="confirm-cancel"]').click();
    await page.locator('[data-role="back"]').click();

    await expect(page.locator('[data-role="entry"]')).toHaveCount(1);
    await expect(page.locator('[data-role="list"]')).toContainText("留着");
  });

  test("导入 txt 文件：标题取自文件名，正文进编辑态", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openKb(page);

    // 浏览器形态（无原生桥）走 <input type="file">：真机上由 SAF 选择器承担
    await page.locator('[data-role="file-input"]').setInputFiles({
      name: "运维手册.md",
      mimeType: "text/markdown",
      buffer: Buffer.from("# 运维手册\n\n重启顺序：先停流量再重启。", "utf8"),
    });

    await expect(page.locator('[data-role="title"]')).toHaveValue("运维手册");
    await expect(page.locator('[data-role="content"]')).toHaveValue(/先停流量再重启/);
    await page.locator('[data-role="back"]').click();
    await expect(page.locator('[data-role="list"]')).toContainText("运维手册");
  });

  test("导入说明写明只支持纯文本类", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openKb(page);

    // 提示只在编辑态出现（列表态空间优先给条目）
    await page.locator('[data-role="new"]').click();
    await expect(page.locator('[data-role="import-hint"]')).toContainText("PDF");
  });
});
