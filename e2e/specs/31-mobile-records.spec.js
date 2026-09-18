// 记录页 E2E（移动视口）：这一套同时是「数据层真的平台无关」的证据——
// 页面直接调用桌面端同一个 `repository`，写入落到 IndexedDB（安卓上换成原生桥），
// 因此增删改查与搜索都必须在手机视口下成立。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

/** 播种：与桌面端同键同结构（repository 的 KINDS.sortBy 语义一致）。 */
const SNIPPETS = [
  { id: "s1", title: "数据库连接", category: "开发", content: "jdbc:mysql://host:3306/db", pinned: true, createdAt: 2000, updatedAt: 3000 },
  { id: "s2", title: "咖啡机位置", category: "生活", content: "三楼茶水间", createdAt: 1000, updatedAt: 2000 },
];
const PROBLEMS = [
  { id: "p1", title: "登录偶发失败", type: "online", status: "open", tags: ["线上"], note: "刷新 token 后恢复", createdAt: 2000, updatedAt: 2500 },
  { id: "p2", title: "导出乱码", type: "temp", status: "done", resolvedAt: 2600, note: "补 BOM 解决", createdAt: 1000, updatedAt: 2600 },
];

test.describe("手机端记录页", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("空态给出创建入口，一次点击就能开始记", async ({ page }) => {
    await seedData(page, { snippets: [], problems: [] });
    await page.goto(MOBILE);
    await expect(page.locator(".m-empty-box")).toBeVisible();
    await page.locator(".m-empty-btn").click();
    await expect(page.locator(".m-sheet")).toBeVisible();
  });

  test("新建速记 → 出现在列表 → 刷新后仍在（真的落盘了）", async ({ page }) => {
    await seedData(page, { snippets: [], problems: [] });
    await page.goto(MOBILE);

    await page.locator(".m-add").click();
    await page.locator(".m-field", { hasText: "标题" }).locator("input").first().fill("接口文档");
    await page.locator(".m-field textarea").fill("https://api.example.com/v1");
    await page.locator(".m-sheet-save").click();

    const item = page.locator(".m-item", { hasText: "接口文档" });
    await expect(item).toBeVisible();
    await expect(item).toContainText("https://api.example.com/v1");

    // 刷新：数据在存储里，不是内存态
    await page.reload();
    await expect(page.locator(".m-item", { hasText: "接口文档" })).toBeVisible();
  });

  test("列表按置顶 + 更新时间排序，搜索能收敛到一条", async ({ page }) => {
    await seedData(page, { snippets: SNIPPETS, problems: PROBLEMS });
    await page.goto(MOBILE);

    const titles = await page.locator(".m-item-title").allInnerTexts();
    expect(titles[0]).toContain("数据库连接"); // pinned 优先，尽管它更新时间更近

    await page.locator(".m-search").fill("3306");
    await expect(page.locator(".m-item")).toHaveCount(1);
    await expect(page.locator(".m-item")).toContainText("数据库连接");

    // 搜不到时给出空态而不是残留旧列表
    await page.locator(".m-search").fill("不存在的关键词");
    await expect(page.locator(".m-item")).toHaveCount(0);
  });

  test("编辑已有速记：改动落盘且反映在列表上", async ({ page }) => {
    await seedData(page, { snippets: SNIPPETS, problems: [] });
    await page.goto(MOBILE);

    await page.locator(".m-item", { hasText: "咖啡机位置" }).locator(".m-item-main").click();
    await expect(page.locator(".m-sheet")).toBeVisible();
    await page.locator(".m-field", { hasText: "标题" }).locator("input").first().fill("咖啡机（新址）");
    await page.locator(".m-sheet-save").click();

    await expect(page.locator(".m-item", { hasText: "咖啡机（新址）" })).toBeVisible();
    await expect(page.locator(".m-item", { hasText: "咖啡机位置" })).toHaveCount(0);
  });

  test("删除必须先确认：取消不删、确认才删", async ({ page }) => {
    await seedData(page, { snippets: SNIPPETS, problems: [] });
    await page.goto(MOBILE);

    const item = page.locator(".m-item", { hasText: "咖啡机位置" });
    await item.locator(".m-op.danger").click();
    await expect(page.locator(".m-modal")).toBeVisible();

    await page.locator(".m-modal-cancel").click();
    await expect(item).toBeVisible();

    await item.locator(".m-op.danger").click();
    await page.locator(".m-modal-ok").click();
    await expect(page.locator(".m-item", { hasText: "咖啡机位置" })).toHaveCount(0);
    // 刷新确认删除也落盘了
    await page.reload();
    await expect(page.locator(".m-item", { hasText: "咖啡机位置" })).toHaveCount(0);
  });

  test("问题分段：默认只看未解决，可切到全部/已解决", async ({ page }) => {
    await seedData(page, { snippets: SNIPPETS, problems: PROBLEMS });
    await page.goto(MOBILE);

    await page.locator(".m-seg-btn", { hasText: "问题" }).click();
    // 默认 open：只显示未解决的那条
    await expect(page.locator(".m-item")).toHaveCount(1);
    await expect(page.locator(".m-item")).toContainText("登录偶发失败");

    await page.locator(".m-chip", { hasText: "已解决" }).click();
    await expect(page.locator(".m-item")).toHaveCount(1);
    await expect(page.locator(".m-item")).toContainText("导出乱码");

    await page.locator(".m-chip", { hasText: "全部" }).click();
    await expect(page.locator(".m-item")).toHaveCount(2);
    // 标签参与搜索
    await page.locator(".m-search").fill("线上");
    await expect(page.locator(".m-item")).toHaveCount(1);
  });

  test("标签栏：记录可用，未迁移的模块如实显示为迁移中", async ({ page }) => {
    await seedData(page, { snippets: [], problems: [] });
    await page.goto(MOBILE);

    await expect(page.locator(".m-tab[data-tab='records']")).toHaveAttribute("aria-selected", "true");
    await page.locator(".m-tab[data-tab='toolbox']").click();
    await expect(page.locator(".m-todo")).toBeVisible();
    await expect(page.locator(".m-todo-body")).toContainText(/迁移|ported/);
    // 标签栏常驻：切回来还能用
    await page.locator(".m-tab[data-tab='records']").click();
    await expect(page.locator(".m-records")).toBeVisible();
  });
});
