// 工作台 E2E（移动视口）：迭代 → 需求 → 子任务三层，全部走共享的 tasks.js / requirementMetrics.js。
//
// 与记录页一样，这一套不依赖安卓环境：数据经 repository 落到 IndexedDB，
// 刷新后仍在即说明「写路径真的落盘」，而不是只改了内存。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const ITERATIONS = [
  {
    id: "i1",
    title: "9 月迭代",
    status: "dev",
    releaseDate: "2026-10-01",
    items: [
      { id: "r1", name: "登录改造", done: false, estimateDays: 2, subtasks: [{ id: "s1", name: "接口", hours: 6, done: true }, { id: "s2", name: "页面", hours: 4, done: false }] },
      { id: "r2", name: "导出补丁", done: true, estimateDays: 1, subtasks: [{ id: "s3", name: "补 BOM", hours: 2, done: true }] },
    ],
  },
  { id: "i2", title: "已完成的迭代", status: "live", releaseDate: "2026-08-01", items: [] },
];

/**
 * 进入工作台。
 *
 * ⚠️ 工作台现在有「概览 / 迭代」两个分段，**默认落在概览**（与桌面端 work 模块的
 * 默认标签一致）。本文件测的是迭代层的钻取，所以统一先切到「迭代」分段。
 * 概览本身另有用例（47-mobile-overview）。
 */
const goWork = async (page) => {
  await page.locator(".m-tab[data-tab='work']").click();
  await expect(page.locator(".m-work")).toBeVisible();
  await page.locator('.m-work [data-nav="iterations"]').click();
  await expect(page.locator(".m-work")).toHaveAttribute("data-level", "list");
};

test.describe("手机端工作台", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("迭代列表：状态、需求进度与工时都显示出来", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS });
    await page.goto(MOBILE);
    await goWork(page);

    const first = page.locator(".m-item").first();
    await expect(first).toContainText("9 月迭代");
    // 开发中排最前（已上线的沉底）
    await expect(first.locator(".m-status-chip")).toHaveText("开发");
    // 2 条需求里完成 1 条；工时 6+4+2=12h
    await expect(first).toContainText("1/2");
    await expect(first).toContainText("12h");
    // 进度条宽度 = 50%
    const width = await first.locator(".m-bar i").evaluate((el) => el.style.width);
    expect(width).toBe("50%");

    // 已上线的排在后面
    await expect(page.locator(".m-item").nth(1)).toContainText("已完成的迭代");
  });

  test("新建迭代 → 出现在列表 → 刷新后仍在", async ({ page }) => {
    await seedData(page, { iterations: [] });
    await page.goto(MOBILE);
    await goWork(page);

    await expect(page.locator(".m-empty-box")).toBeVisible();
    await page.locator(".m-empty-btn").click();
    await page.locator(".m-modal .m-field input").first().fill("10 月迭代");
    await page.locator(".m-modal-ok").click();

    await expect(page.locator(".m-item", { hasText: "10 月迭代" })).toBeVisible();
    await page.reload();
    await goWork(page);
    await expect(page.locator(".m-item", { hasText: "10 月迭代" })).toBeVisible();
  });

  test("下钻到需求：默认只看未完成，可切到已解决", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS });
    await page.goto(MOBILE);
    await goWork(page);

    await page.locator(".m-item", { hasText: "9 月迭代" }).locator(".m-item-main").click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "iter");
    await expect(page.locator(".m-item")).toHaveCount(1);
    await expect(page.locator(".m-item")).toContainText("登录改造");
    // 工时与估算同屏可见
    await expect(page.locator(".m-item")).toContainText("10h");
    await expect(page.locator(".m-item")).toContainText("2d");

    await page.locator(".m-chip", { hasText: "已解决" }).click();
    await expect(page.locator(".m-item")).toHaveCount(1);
    await expect(page.locator(".m-item")).toContainText("导出补丁");

    await page.locator(".m-chip", { hasText: "全部" }).click();
    await expect(page.locator(".m-item")).toHaveCount(2);
  });

  test("勾选需求完成：落盘且进度条跟着变", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS });
    await page.goto(MOBILE);
    await goWork(page);

    await page.locator(".m-item", { hasText: "9 月迭代" }).locator(".m-item-main").click();
    await page.locator(".m-item", { hasText: "登录改造" }).locator(".m-op").first().click();

    // 完成后从「未完成」筛选里消失
    await expect(page.locator(".m-item", { hasText: "登录改造" })).toHaveCount(0);
    await page.locator(".m-back").click();
    await expect(page.locator(".m-item").first()).toContainText("2/2");
    const width = await page.locator(".m-item").first().locator(".m-bar i").evaluate((el) => el.style.width);
    expect(width).toBe("100%");

    // 刷新后仍是 2/2
    await page.reload();
    await goWork(page);
    await expect(page.locator(".m-item").first()).toContainText("2/2");
  });

  test("子任务层：勾选与删除，且返回逐层回退", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS });
    await page.goto(MOBILE);
    await goWork(page);

    // 下钻前先等列表稳定：数据是异步读回来的，点早了会点到还没渲染完的空列表
    const iterationItem = page.locator(".m-item", { hasText: "9 月迭代" });
    await expect(iterationItem).toBeVisible();
    await iterationItem.locator(".m-item-main").click();

    const requirementItem = page.locator(".m-item", { hasText: "登录改造" });
    await expect(requirementItem).toBeVisible();
    await requirementItem.locator(".m-item-main").click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "req");
    await expect(page.locator(".m-item")).toHaveCount(2);

    // 勾选第一个子任务（显示为 ✓ 前缀）
    await page.locator(".m-item").first().locator(".m-item-main").click();
    await expect(page.locator(".m-item").first().locator(".m-item-title")).toContainText("✓");

    // 删除第二个子任务：先确认再删
    await page.locator(".m-item").nth(1).locator(".m-op.danger").click();
    await page.locator(".m-modal-ok").click();
    await expect(page.locator(".m-item")).toHaveCount(1);

    // 返回：子任务 → 需求 → 迭代列表
    await page.locator(".m-back").click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "iter");
    await page.locator(".m-back").click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "list");
  });

  test("删除迭代必须确认，确认后落盘", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS });
    await page.goto(MOBILE);
    await goWork(page);

    const item = page.locator(".m-item", { hasText: "已完成的迭代" });
    await item.locator(".m-op.danger").click();
    await expect(page.locator(".m-modal")).toBeVisible();
    await page.locator(".m-modal-cancel").click();
    await expect(item).toBeVisible();

    await item.locator(".m-op.danger").click();
    await page.locator(".m-modal-ok").click();
    await expect(page.locator(".m-item", { hasText: "已完成的迭代" })).toHaveCount(0);

    await page.reload();
    await goWork(page);
    await expect(page.locator(".m-item", { hasText: "已完成的迭代" })).toHaveCount(0);
  });
});
