// Agent 轨迹与执行动效 E2E：
// 1) 运行中执行记录自动展开、结束收起（用户实测「看不到动效」的回归点）
// 2) 工具卡带耗时与动作原型标记（四类微动效的数据来源）
// 3) 右栏轨迹可按工具名 / 参数过滤
// 4) 交付清单直接给出「看它怎么操作」，点击后在工具里真的开演
import { expect, test } from "@playwright/test";
import { expectRunFinished, final, mockAI, runGoal, seedWithAI, toolCall } from "../helpers.js";

const CSV = "id,name,city\n1,张三,杭州\n2,李四,成都";
const FLOW = [
  toolCall("table.convert", { text: CSV, delimiter: ",", format: "sql", tableName: "user_demo" }, "c1"),
  toolCall("table.parse", { text: CSV }, "c2"),
  final("完成：已转成 SQL"),
];

test.describe("Agent 轨迹与执行动效", () => {
  test("运行中自动展开执行记录，结束收起；工具卡带耗时与动作原型", async ({ page }) => {
    test.setTimeout(90_000);
    await seedWithAI(page);
    await mockAI(page, { responses: FLOW, delayMs: 800 });
    await page.goto("/");
    await runGoal(page, "把这段数据转成 SQL");

    // 运行中：执行记录自动展开——动效与演示入口不再藏在折叠后面
    const execution = page.locator(".execution");
    await expect(execution).toHaveJSProperty("open", true, { timeout: 15_000 });
    const card = page.locator('.tl-card[data-role="tool-card"]', { hasText: "table.convert" }).first();
    await expect(card).toHaveAttribute("data-motion", "flow");
    await expect(card.locator(".tl-dur")).toHaveText(/\d/, { timeout: 10_000 });

    await expectRunFinished(page);
    // 结束后收起：答案优先（可逆，随时手动展开）
    await expect(execution).toHaveJSProperty("open", false);

    // 展开后仍可取证：泳道 + 两次调用 + 卡头耗时；卡内每次尝试的耗时要点开卡片才渲染
    await page.locator(".execution-head").click();
    await expect(page.locator(".lanes")).toBeVisible();
    await expect(page.locator(".tl-card", { hasText: "table.parse" })).toHaveAttribute("data-motion", "scan");
    await expect(page.locator(".tl-dur").first()).toHaveText(/\d/);
    await page.locator('.tl-card[data-role="tool-card"]', { hasText: "table.convert" }).first().locator(".tl-head").click();
    await expect(page.locator(".ta-dur").first()).toHaveText(/\d/);
  });

  test("右栏轨迹可按工具名与参数过滤", async ({ page }) => {
    await seedWithAI(page);
    await mockAI(page, { responses: FLOW });
    await page.goto("/");
    await runGoal(page, "把这段数据转成 SQL");
    await expectRunFinished(page);

    await page.getByRole("button", { name: "显示任务监控", exact: true }).click();
    const rows = page.locator(".mon-row");
    await expect(rows).toHaveCount(2);
    await expect(page.locator(".monitor .lanes")).toBeVisible();
    await page.locator(".mon-search").fill("table.parse");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("table.parse");
  });

  test("交付清单的「看它怎么操作」进入工具并自动开演", async ({ page }) => {
    test.setTimeout(90_000);
    await seedWithAI(page);
    await mockAI(page, { responses: FLOW });
    await page.goto("/");
    await runGoal(page, "把这段数据转成 SQL");
    await expectRunFinished(page);

    await page.locator('[data-role="watch-demo-summary"]').first().click();
    // 浏览器形态没有独立工具窗口：回退为内嵌工具视图，脚本经存储交接后自动开播
    const demo = page.locator('[data-role="tool-demo"]');
    await expect(demo).toBeVisible({ timeout: 15_000 });
    // 输入框在解析出表格后会卸载：用「表格结果 + 演示设置」证明这一步真的演过
    await expect(page.locator('[data-role="stats"]')).toContainText(/2\s*行/, { timeout: 15_000 });
    await expect(page.locator('[data-role="delimiter"]')).toHaveValue(",");
    await expect(page.locator('[data-role="export-format"]')).toHaveValue("sql");
    await expect(demo).toHaveAttribute("data-done", "1", { timeout: 15_000 });
  });
});
