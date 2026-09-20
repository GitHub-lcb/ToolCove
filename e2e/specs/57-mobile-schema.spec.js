// JSON Schema 工具 E2E（移动视口）。
//
// 与桌面端共用同一份纯逻辑（src/jsonSchema.js，60 条单测），这里验手机端界面接线：
// 模式 chips、输入切换、校验错误列表、造样例、结构解读、导出。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const openSchema = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await page.locator('.m-item[data-tool="schema"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="schema"]')).toBeVisible();
};

/** 切到某个输入页签并填写。 */
const fillInput = async (page, which, text) => {
  await page.locator(`[data-input="${which}"]`).click();
  await page.locator(`[data-role="${which}"]`).fill(text);
};

const DATA = JSON.stringify({ orderId: "SO1", items: [{ sku: "A-1", qty: 2 }] });
const SCHEMA = JSON.stringify({
  type: "object",
  properties: { orderId: { type: "string" }, items: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } }, required: ["sku", "qty"] } } },
  required: ["orderId", "items"],
  additionalProperties: false,
});

test.describe("手机端工具箱（JSON Schema）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("推断：从 JSON 生成 Schema 并一键应用", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "json", DATA);

    await page.locator('[data-mode="infer"]').click();
    const output = await page.locator('[data-role="output"]').inputValue();
    const schema = JSON.parse(output);
    expect(schema.properties.orderId.type).toBe("string");
    expect(schema.properties.items.items.properties.qty.type).toBe("integer");

    // 一键应用：切到校验并填好 Schema
    await page.locator('[data-role="use-inferred"]').click();
    await expect(page.locator('[data-mode="validate"]')).toHaveClass(/on/);
    await expect(page.locator('[data-role="valid"]')).toBeVisible();
  });

  test("校验通过：数据符合 Schema", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "json", DATA);
    await fillInput(page, "schema", SCHEMA);
    await page.locator('[data-mode="validate"]').click();
    await expect(page.locator('[data-role="valid"]')).toBeVisible();
    await expect(page.locator('[data-role="errors"]')).toHaveCount(0);
  });

  test("校验失败：错误带路径与关键字", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "json", JSON.stringify({ orderId: "SO1", items: [{ sku: "A-1", qty: "two" }], extra: 1 }));
    await fillInput(page, "schema", SCHEMA);
    await page.locator('[data-mode="validate"]').click();

    const errors = page.locator('[data-role="errors"]');
    await expect(errors).toBeVisible();
    await expect(errors.locator('[data-keyword="type"]')).toContainText("/items/0/qty");
    await expect(errors.locator('[data-keyword="additionalProperties"]')).toContainText("/extra");
  });

  test("缺必填字段：报出字段名", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "json", JSON.stringify({ items: [] }));
    await fillInput(page, "schema", SCHEMA);
    await page.locator('[data-mode="validate"]').click();
    await expect(page.locator('[data-keyword="required"]')).toContainText("orderId");
  });

  test("JSON 写错时给可读提示", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "json", "{ 这不是 JSON }");
    await expect(page.locator('[data-role="json-error"]')).toContainText(/JSON/);
  });

  test("造样例：生成的值满足 Schema", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "schema", SCHEMA);
    await page.locator('[data-mode="sample"]').click();

    const sample = JSON.parse(await page.locator('[data-role="output"]').inputValue());
    expect(sample.orderId).toBeTruthy();
    expect(sample.items[0]).toHaveProperty("qty");
  });

  test("结构解读：字段路径与标记", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "schema", SCHEMA);
    await page.locator('[data-mode="outline"]').click();

    const output = await page.locator('[data-role="output"]').inputValue();
    expect(output).toContain("/orderId");
    expect(output).toContain("required");
    expect(output).toContain("/items[]");
  });

  test("$ref 的失败路径指到实际位置", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "json", JSON.stringify({ user: { age: "x" } }));
    await fillInput(
      page,
      "schema",
      JSON.stringify({
        type: "object",
        properties: { user: { $ref: "#/$defs/User" } },
        $defs: { User: { type: "object", properties: { age: { type: "integer" } }, required: ["age"] } },
      })
    );
    await page.locator('[data-mode="validate"]').click();
    await expect(page.locator('[data-keyword="type"]')).toContainText("/user/age");
  });

  test("导出：下载得到 schema.json", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "json", DATA);
    await page.locator('[data-mode="infer"]').click();

    const waitDownload = page.waitForEvent("download");
    await page.locator('[data-role="download"]').click();
    const download = await waitDownload;
    expect(download.suggestedFilename()).toBe("schema.json");
  });

  test("内容落盘：切走再回来还在", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openSchema(page);
    await fillInput(page, "json", '{"persist":"保留我"}');

    await page.locator(".m-tab[data-tab='records']").click();
    await page.locator(".m-tab[data-tab='toolbox']").click();
    await expect(page.locator(".m-toolbox")).toBeVisible();
    await page.locator('.m-item[data-tool="schema"] .m-item-main').click();
    await expect(page.locator('[data-role="json"]')).toHaveValue(/保留我/);
  });

  test("工具箱：Schema 已登记，进度与条目数一致", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='toolbox']").click();

    await expect(page.locator('.m-item[data-tool="schema"]')).toBeVisible();
    const total = await page.locator(".m-item[data-tool]").count();
    await expect(page.locator('[data-role="tool-progress"]')).toContainText(`${total}/${total}`);
  });
});
