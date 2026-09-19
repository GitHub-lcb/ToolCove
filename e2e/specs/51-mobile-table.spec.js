// 表格工具 E2E（移动视口）。
//
// 与桌面端**共用同一份纯逻辑**（src/tableTool.js），所以这里重点验手机端的界面接线：
// 输入 → 表格横向滚动 → chips 操作 → 导出下载。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

/** 带引号与制表符的样例（从 Excel 复制出来的形态）。 */
const TSV = ["name\tcity\tamount", "张三\t北京\t100", "李四\t上海\t200", "张三\t北京\t100", "王五\t\t50"].join("\n");

const openTable = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await page.locator('.m-item[data-tool="table"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="table"]')).toBeVisible();
};

test.describe("手机端工具箱（表格处理）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("粘贴制表符数据：自动识别分隔符并渲染表格", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);

    await page.locator('[data-role="input"]').fill(TSV);
    const table = page.locator('[data-role="table"]');
    await expect(table).toBeVisible();
    await expect(table).toContainText("张三");
    await expect(table).toContainText("上海");
    // 分隔符识别结果显示在 chip 上
    await expect(page.locator('[data-role="toggle-delimiter"]')).toContainText(/制表符|Tab/);
  });

  test("统计：行/列/空单元格/重复行", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);

    const stats = page.locator('[data-role="stats"]');
    await expect(stats).toContainText("4"); // 4 行数据
    await expect(stats).toContainText("3"); // 3 列
    await expect(stats).toContainText(/空单元格|重复/);
  });

  test("点列头排序（同一列再点切换升降序）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);

    const amount = page.locator('[data-role="table"] th').filter({ hasText: "amount" });
    await amount.click();
    const first = () => page.locator('[data-role="table"] tbody tr').first().locator("td").nth(3);
    await expect(first()).toHaveText("50"); // 数值升序：50 在 100 前
    await amount.click();
    await expect(first()).toHaveText("200"); // 降序
  });

  test("去重与撤销", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(4);

    await page.locator('[data-role="dedupe"]').click();
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(3);

    await page.locator('[data-role="reset-ops"]').click();
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(4);
  });

  test("表头开关：关掉后首行变成数据行", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);

    // 开：3 列 + 表头行；关：首行也进数据
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(4);
    await page.locator('[data-role="has-header"]').click();
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(5);
    await expect(page.locator('[data-role="table"] thead')).toHaveCount(0);
  });

  test("筛选：选列 + 包含匹配", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);

    await page.locator('[data-role="open-filter"]').click();
    await page.locator('[data-role="filter-column"]').selectOption("1");
    await page.locator('[data-role="filter-value"]').fill("北京");
    await page.locator('[data-role="apply-filter"]').click();
    await expect(page.locator('[data-role="table"] tbody tr')).toHaveCount(2);
  });

  test("选列：只保留勾选的列", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);

    await page.locator('[data-role="pick-columns"]').click();
    // 默认全选；取消勾选第 2、3 列，只留 name
    const boxes = page.locator('[data-role="column-panel"] input[type="checkbox"]');
    await boxes.nth(1).uncheck();
    await boxes.nth(2).uncheck();
    await page.locator('[data-role="apply-columns"]').click();

    const table = page.locator('[data-role="table"]');
    await expect(table).toContainText("张三");
    await expect(table).not.toContainText("北京");
  });

  test("导出 JSON：内容与数据一致", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);

    await page.locator('[data-role="toggle-export"]').click();
    await page.locator('[data-format="json"]').click();
    const output = await page.locator('[data-role="export-output"]').inputValue();
    const parsed = JSON.parse(output);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toEqual({ name: "张三", city: "北京", amount: "100" });
  });

  test("导出文件：下载得到 CSV", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);

    await page.locator('[data-role="toggle-export"]').click();
    const waitDownload = page.waitForEvent("download");
    await page.locator('[data-role="download-export"]').click();
    const download = await waitDownload;
    expect(download.suggestedFilename()).toBe("table.csv");

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text.split("\n")[0]).toBe("name,city,amount");
    expect(text).toContain("张三,北京,100");
  });

  test("清空后回到输入态", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openTable(page);
    await page.locator('[data-role="input"]').fill(TSV);
    await expect(page.locator('[data-role="table"]')).toBeVisible();

    await page.locator('[data-role="clear"]').click();
    await expect(page.locator('[data-role="table"]')).toHaveCount(0);
    await expect(page.locator('[data-role="input"]')).toBeVisible();
  });

  test("工具箱：表格工具已登记，且进度与条目数一致", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='toolbox']").click();

    await expect(page.locator('.m-item[data-tool="table"]')).toBeVisible();
    // 不写死总数：加工具不该让用例失效（断言一致性而不是快照）
    const total = await page.locator(".m-item[data-tool]").count();
    await expect(page.locator('[data-role="tool-progress"]')).toContainText(`${total}/${total}`);
  });
});
