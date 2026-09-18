// 工作台概览 E2E（移动视口）。
//
// 概览与桌面端 WorkOverviewView **同一统计口径**：只读 iterations / problems / settings，
// 活动与工时从迭代子任务与问题日志聚合。所以这里的断言值都是按那份数据手算出来的，
// 而不是"看起来像"。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

/** 构造一份可手算的数据：3 个迭代（2 个非 live）、2 个问题（1 个 open）。 */
const ITERATIONS = [
  {
    id: "i1",
    title: "9 月迭代",
    status: "dev",
    startDate: "2020-01-06",
    endDate: "2020-01-10",
    items: [
      {
        id: "r1",
        name: "登录改造",
        done: false,
        subtasks: [{ id: "s1", name: "接口", hours: 6, done: true, date: "2020-01-07" }],
        logs: [{ date: "2020-01-08", hours: 2, note: "联调" }],
      },
      { id: "r2", name: "导出补丁", done: true, subtasks: [] },
    ],
  },
  { id: "i2", title: "待开始迭代", status: "pending", startDate: "2020-01-06", endDate: "2020-01-08", items: [] },
  { id: "i3", title: "已发布迭代", status: "live", items: [] },
];

const PROBLEMS = [
  { id: "p1", title: "登录偶发失败", status: "open", logs: [{ date: "2020-01-09", hours: 1.5, note: "排查" }] },
  { id: "p2", title: "已修复的问题", status: "done", logs: [] },
];

const goOverview = async (page) => {
  await page.locator(".m-tab[data-tab='work']").click();
  await expect(page.locator(".m-work")).toBeVisible();
  // 默认落在概览层
  await expect(page.locator(".m-work")).toHaveAttribute("data-level", "overview");
  await expect(page.locator('[data-role="overview"]')).toBeVisible();
};

test.describe("手机端工作台（概览）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("默认进入概览（与桌面端 work 模块的默认标签一致）", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS, problems: PROBLEMS });
    await page.goto(MOBILE);
    await goOverview(page);
    await expect(page.locator('[data-role="kpis"]')).toBeVisible();
  });

  test("KPI 数字与数据一致（非 live 迭代数 / open 问题数）", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS, problems: PROBLEMS });
    await page.goto(MOBILE);
    await goOverview(page);

    // 3 个迭代里 2 个非 live；待开始 1 个
    await expect(page.locator('[data-role="kpi-iterations"]')).toHaveText("2");
    await expect(page.locator('[data-kpi="iterations"]')).toContainText("1");
    // 2 个问题里 1 个 open
    await expect(page.locator('[data-role="kpi-problems"]')).toHaveText("1");
  });

  test("空数据也能正常显示（不报错、有说明）", async ({ page }) => {
    await seedData(page, {});
    await page.goto(MOBILE);
    await goOverview(page);

    await expect(page.locator('[data-role="error"]')).toHaveCount(0);
    await expect(page.locator('[data-role="kpi-iterations"]')).toHaveText("0");
    await expect(page.locator('[data-role="no-week"]')).toBeVisible();
    await expect(page.locator('[data-role="no-logs"]')).toBeVisible();
  });

  test("最近活动来自迭代子任务与问题日志的聚合（不是独立数据键）", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS, problems: PROBLEMS });
    await page.goto(MOBILE);
    await goOverview(page);

    const logs = page.locator('[data-role="recent-logs"]');
    await expect(logs).toBeVisible();
    // 三条记录：子任务工时、需求日志、问题日志
    await expect(logs.locator("li")).toHaveCount(3);
    // 按日期倒序：01-09（问题）在最前
    await expect(logs.locator("li").first()).toContainText("2020-01-09");
    await expect(logs).toContainText("联调");
    await expect(logs).toContainText("排查");
  });

  test("系统返回键逐层回退：迭代 → 需求 → 迭代 → 概览", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS, problems: PROBLEMS });
    await page.goto(MOBILE);
    await goOverview(page);

    // 进入迭代层与需求层
    await page.locator('.m-work [data-nav="iterations"]').click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "list");
    await page.locator('.m-item[data-status="dev"] .m-item-main').first().click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "iter");

    // 系统返回键在 WebView 里就是 history.back()（MainActivity 的 onBackPressed → goBack）
    const back = async () => {
      await page.evaluate(() => history.back());
      await page.waitForTimeout(150);
    };

    await back();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "list");
    await back();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "overview");
    // 最外层：Shell 的哨兵已耗尽，history.length 不再增长。
    // （不测"URL 变了"——单页应用里 URL 本来就不变，那样断言等于没测）
    const depth = await page.evaluate(() => history.length);
    await back();
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => history.length), "最外层返回不该再补哨兵").toBeLessThanOrEqual(depth);
  });

  test("工具箱里按系统返回键回到工具列表（不是退出应用）", async ({ page }) => {
    await seedData(page, {});
    await page.goto(MOBILE);

    await page.locator(".m-tab[data-tab='toolbox']").click();
    await page.locator('.m-item[data-tool="json"] .m-item-main').click();
    await expect(page.locator('.m-tool[data-tool="json"]')).toBeVisible();

    await page.evaluate(() => history.back());
    await page.waitForTimeout(200);
    // 回到列表：工具页消失、列表还在（而不是应用被退出）
    await expect(page.locator('.m-tool[data-tool="json"]')).toHaveCount(0);
    await expect(page.locator(".m-toolbox")).toBeVisible();
  });

  test("切到概览会清掉钻取状态（否则点回迭代像没反应）", async ({ page }) => {
    await seedData(page, { iterations: ITERATIONS, problems: PROBLEMS });
    await page.goto(MOBILE);
    await goOverview(page);

    await page.locator('.m-work [data-nav="iterations"]').click();
    await page.locator('.m-item[data-status="dev"] .m-item-main').first().click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "iter");

    // 切到概览再切回迭代：应当回到列表，而不是停在上次打开的迭代里
    await page.locator('.m-work [data-nav="overview"]').click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "overview");
    await page.locator('.m-work [data-nav="iterations"]').click();
    await expect(page.locator(".m-work")).toHaveAttribute("data-level", "list");
  });
});
