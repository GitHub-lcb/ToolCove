// JSON Schema 工具 E2E（桌面视口）。
//
// 纯逻辑有 60 条单测（含"造出的样例必须自己合法"的往返自检），这里验界面接线：
// 推断 → 应用 → 校验 → 错误定位 → 造样例 → 结构解读。
import { expect, test } from "@playwright/test";

async function openSchemaTool(page) {
  await page.locator(".nav-item", { hasText: "工具箱" }).click();
  const card = page.locator(".tool-item", { hasText: "JSON Schema" });
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  await page.locator('[data-role="json"]').waitFor({ state: "visible", timeout: 10_000 });
}

const DATA = JSON.stringify({ orderId: "SO1", items: [{ sku: "A-1", qty: 2 }] }, null, 2);
const SCHEMA = JSON.stringify(
  {
    type: "object",
    properties: { orderId: { type: "string" }, items: { type: "array", items: { type: "object", properties: { sku: { type: "string" }, qty: { type: "integer" } }, required: ["sku", "qty"] } } },
    required: ["orderId", "items"],
    additionalProperties: false,
  },
  null,
  2
);

test.describe("工具箱（JSON Schema）", () => {
  test("推断：从 JSON 生成 Schema，含字段类型与 required", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill(DATA);
    await page.locator('[data-mode="infer"]').click();

    const output = await page.locator('[data-role="output"]').inputValue();
    const schema = JSON.parse(output);
    expect(schema.type).toBe("object");
    expect(schema.properties.orderId.type).toBe("string");
    expect(schema.properties.items.type).toBe("array");
    expect(schema.required).toContain("orderId");
    // 对象数组里的字段
    expect(schema.properties.items.items.properties.qty.type).toBe("integer");
  });

  test("用推断结果：一键填进 Schema 并切到校验", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill(DATA);
    await page.locator('[data-role="use-inferred"]').click();

    // 应切到校验模式，且 Schema 已填好，数据合法
    await expect(page.locator('[data-mode="validate"]')).toHaveClass(/on/);
    await expect(page.locator('[data-role="schema"]')).not.toHaveValue("");
    await expect(page.locator('[data-role="valid"]')).toBeVisible();
  });

  test("校验通过：数据符合 Schema", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill(DATA);
    await page.locator('[data-role="schema"]').fill(SCHEMA);
    await page.locator('[data-mode="validate"]').click();
    await expect(page.locator('[data-role="valid"]')).toBeVisible();
    await expect(page.locator('[data-role="errors"]')).toHaveCount(0);
  });

  test("校验失败：错误带 JSON Pointer 路径与关键字", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    // qty 给了字符串（应为 integer），并多了一个未声明字段
    await page.locator('[data-role="json"]').fill(JSON.stringify({ orderId: "SO1", items: [{ sku: "A-1", qty: "two" }], extra: 1 }));
    await page.locator('[data-role="schema"]').fill(SCHEMA);
    await page.locator('[data-mode="validate"]').click();

    const errors = page.locator('[data-role="errors"]');
    await expect(errors).toBeVisible();
    // 类型错误定位到具体下标
    await expect(errors.locator('[data-keyword="type"]')).toContainText("/items/0/qty");
    // 未声明字段也报出来
    await expect(errors.locator('[data-keyword="additionalProperties"]')).toContainText("/extra");
    await expect(page.locator('[data-role="invalid"]')).toContainText(/\d+/);
  });

  test("校验失败：缺必填字段报出字段名", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill(JSON.stringify({ items: [] }));
    await page.locator('[data-role="schema"]').fill(SCHEMA);
    await page.locator('[data-mode="validate"]').click();
    await expect(page.locator('[data-keyword="required"]')).toContainText("orderId");
  });

  test("JSON 写错时给可读提示，而不是白屏", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill("{ 这不是 JSON }");
    await expect(page.locator('[data-role="json-error"]')).toBeVisible();
    await expect(page.locator('[data-role="json-error"]')).toContainText(/JSON/);
  });

  test("Schema 不是对象时明确报错", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill(DATA);
    await page.locator('[data-role="schema"]').fill('["not", "an", "object"]');
    await expect(page.locator('[data-role="schema-error"]')).toContainText(/对象/);
  });

  test("造样例：生成的值满足 Schema", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="schema"]').fill(SCHEMA);
    await page.locator('[data-mode="sample"]').click();

    const output = await page.locator('[data-role="output"]').inputValue();
    const sample = JSON.parse(output);
    expect(sample.orderId).toBeTruthy();
    expect(Array.isArray(sample.items)).toBe(true);
    expect(sample.items[0]).toHaveProperty("sku");
    expect(sample.items[0]).toHaveProperty("qty");
  });

  test("造样例：$ref 与 format 都能解析", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="schema"]').fill(
      JSON.stringify({ type: "object", properties: { u: { $ref: "#/$defs/U" } }, $defs: { U: { type: "string", format: "email" } } })
    );
    await page.locator('[data-mode="sample"]').click();
    const sample = JSON.parse(await page.locator('[data-role="output"]').inputValue());
    expect(sample.u).toContain("@");
  });

  test("结构解读：列出字段路径、类型与标记", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="schema"]').fill(SCHEMA);
    await page.locator('[data-mode="outline"]').click();

    const output = await page.locator('[data-role="output"]').inputValue();
    expect(output).toContain("/orderId");
    expect(output).toContain("string");
    expect(output).toContain("required");
    expect(output).toContain("/items[]");
    expect(output).toContain("no extra fields");
  });

  test("校验：$ref 的失败路径指到实际位置（不是 $defs 里）", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill(JSON.stringify({ user: { age: "x" } }));
    await page.locator('[data-role="schema"]').fill(
      JSON.stringify({
        type: "object",
        properties: { user: { $ref: "#/$defs/User" } },
        $defs: { User: { type: "object", properties: { age: { type: "integer" } }, required: ["age"] } },
      })
    );
    await page.locator('[data-mode="validate"]').click();
    await expect(page.locator('[data-keyword="type"]')).toContainText("/user/age");
  });

  test("校验：循环引用不会卡死", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill(JSON.stringify({ self: { self: {} } }));
    await page.locator('[data-role="schema"]').fill(JSON.stringify({ type: "object", properties: { self: { $ref: "#" } } }));
    await page.locator('[data-mode="validate"]').click();
    // 不崩、不死循环，给出结论
    await expect(page.locator('[data-role="valid"], [data-role="invalid"]')).toBeVisible({ timeout: 10_000 });
  });

  test("下载：得到推断出的 Schema 文件", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await page.locator('[data-role="json"]').fill(DATA);
    await page.locator('[data-mode="infer"]').click();

    const waitDownload = page.waitForEvent("download");
    await page.locator('[data-role="download"]').click();
    const download = await waitDownload;
    expect(download.suggestedFilename()).toBe("schema.json");
  });

  test("如实标注：支持的关键字是子集", async ({ page }) => {
    await page.goto("/");
    await openSchemaTool(page);
    await expect(page.locator(".tool-schema")).toContainText(/子集|不支持/);
  });
});
