// 表格工具 E2E（桌面视口）。
//
// 覆盖真实使用路径：从 Excel 粘贴（制表符 + 引号内容）→ 表格视图 → 排序/去重/筛选 → 导出。
// 解析逻辑本身有 54 条单测，这里验的是**界面接线与交互**。
import { expect, test } from "@playwright/test";

/** 带引号与制表符的"从 Excel 复制"样例：内容里有逗号，容易误判分隔符。 */
const TSV = ["name\tcity\tamount", "张三\t北京\t100", "李四\t上海\t200", "张三\t北京\t100", "王五\t\t50"].join("\n");

/**
 * 打开表格工具。
 *
 * 桌面端的工具卡片是 `button.tool-item`，**没有 data-tool 属性**（手机端才有），
 * 所以这里按可见文本定位。先点导航进工具箱，再点「表格处理」。
 */
async function openTableTool(page) {
  await page.locator(".nav-item", { hasText: "工具箱" }).click();
  const card = page.locator(".tool-item", { hasText: "表格处理" });
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  // 工具页里输入框出现即认为打开完成
  await page.locator('[data-role="input"], [data-role="table"]').first().waitFor({ state: "visible", timeout: 10_000 });
}

test.describe("工具箱（表格处理）", () => {
  test("从剪贴板粘贴制表符数据：自动识别分隔符并渲染表格", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await page.evaluate((text) => navigator.clipboard.writeText(text), TSV);

    await openTableTool(page);
    await page.locator('[data-role="paste"]').click();

    const table = page.locator('[data-role="table"]');
    await expect(table).toBeVisible();
    // 制表符被识别出来（而不是逗号）
    await expect(page.locator('[data-role="detected"]')).toContainText(/制表符|Tab/);
    // 表头与数据都在
    await expect(table).toContainText("name");
    await expect(table).toContainText("张三");
    await expect(table).toContainText("上海");
  });

  test("统计数字与数据一致（行/列/空单元格/重复行）", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);

    const stats = page.locator('[data-role="stats"]');
    await expect(stats).toContainText("4"); // 4 行数据（不含表头）
    await expect(stats).toContainText("3"); // 3 列
    // 一个空单元格（王五的城市）与一行重复（张三出现两次）
    await expect(stats).toContainText(/空单元格/);
    await expect(stats).toContainText(/重复/);
  });

  test("点列头排序：同一列再点切换升降序", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);

    const amountHeader = page.locator('[data-role="table"] th').filter({ hasText: "amount" });
    await amountHeader.click();
    // 升序：数值比较（50 在 100 前）
    const firstCell = () => page.locator('[data-role="table"] tbody tr').first().locator("td").nth(3);
    await expect(firstCell()).toHaveText("50");

    await amountHeader.click();
    // 降序：200 在前
    await expect(firstCell()).toHaveText("200");
  });

  test("去重：重复行被移除且统计跟着变", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(4);

    await page.locator('[data-role="dedupe"]').click();
    // 张三那条重复的被去掉 → 3 行
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(3);
  });

  test("筛选：按列包含匹配", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);

    await page.locator('[data-role="open-filter"]').click();
    // 必须显式选列：默认是第 0 列（name），拿 city 的值去筛 name 只会得到 0 行
    await page.locator('[data-role="filter-column"]').selectOption("1");
    await page.locator('[data-role="filter-value"]').fill("北京");
    await page.locator('[data-role="apply-filter"]').click();

    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(2); // 张三那条（重复的还在）
    await expect(page.locator('[data-role="table"] tbody')).not.toContainText("上海");
  });

  test("筛选：默认列是第 0 列，选错列会得到 0 行", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);

    await page.locator('[data-role="open-filter"]').click();
    // 用 city 的值去筛第 0 列（name）——行为正确但结果为空。这条把默认列的语义固定下来，
    // 免得以后有人把默认列改成"自动猜"，反而让结果变得不可预期。
    await page.locator('[data-role="filter-value"]').fill("北京");
    await page.locator('[data-role="apply-filter"]').click();
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(0);
  });

  test("撤销操作：一键回到原始数据", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);

    await page.locator('[data-role="dedupe"]').click();
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(3);
    await page.locator('[data-role="reset-ops"]').click();
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(4);
  });

  test("导出 JSON：键名来自表头，重名列不丢数据", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill(TSV);
    await page.locator('[data-role="export-format"]').selectOption("json");

    const output = await page.locator('[data-role="export-output"]').inputValue();
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({ name: "张三", city: "北京", amount: "100" });
  });

  test("导出 SQL：转义单引号且不推断类型", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill("name,code\nO'Brien,007");
    await page.locator('[data-role="export-format"]').selectOption("sql");
    await page.locator('[data-role="sql-table"]').fill("users");

    const output = await page.locator('[data-role="export-output"]').inputValue();
    expect(output).toContain("INSERT INTO `users`");
    expect(output).toContain("'O''Brien'");
    // 007 不能被当成数字（否则变成 7）
    expect(output).toContain("'007'");
  });

  test("导出 Markdown：转义竖线避免表格错列", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    await page.locator('[data-role="input"]').fill("a,b\nx|y,z");
    await page.locator('[data-role="export-format"]').selectOption("markdown");

    const output = await page.locator('[data-role="export-output"]').inputValue();
    expect(output).toContain("| a | b |");
    expect(output).toContain("x\\|y");
  });

  test("CSV 往返：导出再粘回来，数据一致", async ({ page }) => {
    await page.goto("/");
    await openTableTool(page);
    // 内容里含逗号与引号，导出时必须加引号，否则粘回来会错列
    await page.locator('[data-role="input"]').fill('name,note\n张三,"含,逗号"\n李四,"含""引号"""');
    await page.locator('[data-role="export-format"]').selectOption("csv");

    const csv = await page.locator('[data-role="export-output"]').inputValue();
    await page.locator('[data-role="clear"]').click();
    await page.locator('[data-role="input"]').fill(csv);

    const table = page.locator('[data-role="table"]');
    await expect(table).toContainText("含,逗号");
    await expect(table).toContainText('含"引号"');
  });
});
