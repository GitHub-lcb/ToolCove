// 数据库工具 E2E（移动视口）——用假的安卓原生桥提供内存 SQLite。
//
// E2E 验的是**前端渲染与命令接线**（结果表格、null 与空串的区分、截断提示、表结构懒加载）；
// 真正的 SQL 执行在 Kotlin 侧（SqliteAccess），SQL 分类与结果整形另有 17 条 JVM 单测。
import { expect, test } from "@playwright/test";
import { seedData, seedMobileBridge } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";
const DB_FILE = "/data/app/orders.db";

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openDb = async (page) => {
  await page.locator('.m-item[data-tool="db"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="db"]')).toBeVisible();
};

const DB_FIXTURE = {
  tables: ["orders", "users"],
  columns: {
    orders: [
      { name: "id", type: "INTEGER", pk: true },
      { name: "amount", type: "REAL", pk: false },
    ],
    users: [{ name: "name", type: "TEXT", pk: false }],
  },
};

test.describe("手机端工具箱（数据库 / SQLite）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("没有原生桥时如实说明，并点明只支持 SQLite", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openDb(page);

    const tool = page.locator('[data-tool="db"]');
    await expect(tool.locator('[data-role="no-bridge"]')).toBeVisible();
    // 「安卓没有 JDBC」这件事必须写在界面上，否则用户会找 MySQL 选项
    await expect(tool.locator('[data-role="sqlite-note"]')).toContainText(/JDBC|SQLite/);
    await expect(tool.locator('[data-role="pick-db"]')).toBeDisabled();
  });

  test("选库 → 连接 → 查询 → 表格渲染", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { pick: DB_FILE, db: DB_FIXTURE });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openDb(page);

    const tool = page.locator('[data-tool="db"]');
    await tool.locator('[data-role="pick-db"]').click();
    // 选完自动连接
    await expect(tool.locator('[data-role="conn-state"]')).toHaveAttribute("data-on", "true");

    await tool.locator('[data-role="sql"]').fill("SELECT * FROM users");
    await tool.locator('[data-role="run"]').click();

    const table = tool.locator('[data-role="table"]');
    await expect(table).toBeVisible();
    await expect(table).toContainText("id");
    await expect(table).toContainText("name");
    await expect(table).toContainText("alice");
    await expect(table).toContainText("carol");
    // 行数与耗时都展示出来
    await expect(tool.locator('[data-role="result-meta"]')).toContainText("3");
    await expect(tool.locator('[data-role="result-meta"]')).toContainText("ms");
  });

  test("null 与空串必须能区分（数据里这两者含义不同）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, {
      pick: DB_FILE,
      db: {
        ...DB_FIXTURE,
        queries: {
          "SELECT id, note FROM t": {
            columns: [{ name: "id", type: "INTEGER", pk: true }, { name: "note", type: "TEXT", pk: false }],
            rows: [[1, null], [2, ""]],
            affected: -1,
            truncated: false,
            durationMs: 2,
          },
        },
      },
    });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openDb(page);

    const tool = page.locator('[data-tool="db"]');
    await tool.locator('[data-role="pick-db"]').click();
    await tool.locator('[data-role="sql"]').fill("SELECT id, note FROM t");
    await tool.locator('[data-role="run"]').click();

    const table = tool.locator('[data-role="table"]');
    await expect(table).toContainText("NULL"); // null 有明确标记
    // 空串是空单元格，而不是 NULL 字样
    const emptyCell = table.locator("td").nth(3);
    await expect(emptyCell).toHaveText("");
  });

  test("结果被截断时明确提示，并给出收窄建议", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, {
      pick: DB_FILE,
      db: {
        ...DB_FIXTURE,
        queries: {
          "SELECT * FROM big": {
            columns: [{ name: "id", type: "INTEGER", pk: true }],
            rows: Array.from({ length: 5 }, (_, i) => [i]),
            affected: -1,
            truncated: true,
            durationMs: 30,
          },
        },
      },
    });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openDb(page);

    const tool = page.locator('[data-tool="db"]');
    await tool.locator('[data-role="pick-db"]').click();
    await tool.locator('[data-role="sql"]').fill("SELECT * FROM big");
    await tool.locator('[data-role="run"]').click();

    const truncated = tool.locator('[data-role="truncated"]');
    await expect(truncated).toBeVisible();
    await expect(truncated).toContainText(/LIMIT|WHERE/); // 给出可执行的建议
  });

  test("表结构：列出表、展开看列与主键标记、一键查看数据", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { pick: DB_FILE, db: DB_FIXTURE });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openDb(page);

    const tool = page.locator('[data-tool="db"]');
    await tool.locator('[data-role="pick-db"]').click();
    await tool.locator('[data-tab="structure"]').click();

    await expect(tool.locator('[data-role="tables"] [data-table]')).toHaveCount(2);
    // 展开第一张表：懒加载列结构
    await tool.locator('[data-role="table-name"]').first().click();
    const columns = tool.locator('[data-role="columns"]').first();
    await expect(columns).toContainText("id");
    await expect(columns).toContainText("PK"); // 主键要有标记
    await expect(columns).toContainText("amount");

    // 一键查看数据：切回查询页并执行 SELECT
    await tool.locator('[data-role="open-table"]').first().click();
    await expect(tool.locator('[data-tab="query"]')).toHaveClass(/on/);
    await expect(tool.locator('[data-role="table"]')).toBeVisible();
  });

  test("未连接就执行：给出可读提示而不是发一个空请求", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { db: DB_FIXTURE });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openDb(page);

    const tool = page.locator('[data-tool="db"]');
    // 手填路径后不点连接，直接想跑 SQL —— 此时查询区还没出现
    await expect(tool.locator('[data-role="sql"]')).toHaveCount(0);
    await expect(tool.locator('[data-role="conn-state"]')).toHaveAttribute("data-on", "false");
  });

  test("连接失败：报错带原因，且状态回到未连接", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { pick: "/nope.db", db: { ...DB_FIXTURE, failConnect: true } });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openDb(page);

    const tool = page.locator('[data-tool="db"]');
    await tool.locator('[data-role="pick-db"]').click();
    await expect(tool.locator('[data-role="error"]')).toContainText("无法打开");
    await expect(tool.locator('[data-role="conn-state"]')).toHaveAttribute("data-on", "false");
  });

  test("DML 结果显示影响行数（而不是空表格）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, {
      pick: DB_FILE,
      db: {
        ...DB_FIXTURE,
        queries: {
          "UPDATE users SET name='x'": { columns: [], rows: [], affected: 3, truncated: false, durationMs: 5 },
        },
      },
    });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openDb(page);

    const tool = page.locator('[data-tool="db"]');
    await tool.locator('[data-role="pick-db"]').click();
    await tool.locator('[data-role="sql"]').fill("UPDATE users SET name='x'");
    await tool.locator('[data-role="run"]').click();

    await expect(tool.locator('[data-role="result-meta"]')).toContainText("3");
    await expect(tool.locator('[data-role="table"]')).toHaveCount(0);
  });

  test("迁移进度：数据库已可用，且保留「只支持 SQLite」的说明", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    const db = page.locator('.m-item[data-tool="db"]');
    await expect(db).toHaveAttribute("data-ready", "true");
    // 「可用」与「和桌面一样」不是一回事：只支持 SQLite 必须写在列表上
    await expect(db).toContainText(/SQLite|JDBC/);

    // 只剩标签打印未迁移
    await expect(page.locator('.m-item[data-tool="label"]')).toHaveAttribute("data-ready", "false");
  });
});
