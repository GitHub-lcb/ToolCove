// XML 工具 E2E（桌面视口）。
//
// 纯逻辑有 64 条单测（含自研解析器的全部边界），这里验界面接线：
// 模式切换、格式化写回、错误提示带行号、XPath 查询、统计、导出。
import { expect, test } from "@playwright/test";

async function openXmlTool(page) {
  await page.locator(".nav-item", { hasText: "工具箱" }).click();
  const card = page.locator(".tool-item", { hasText: "XML 报文" });
  await card.waitFor({ state: "visible", timeout: 10_000 });
  await card.click();
  await page.locator('[data-role="input"]').waitFor({ state: "visible", timeout: 10_000 });
}

/** 一份贴近真实报文的样例（含 CDATA、属性、命名空间）。 */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<order id="SO20260101"><customer><name>张三</name></customer><items><item sku="A-1">出库单</item><item sku="B-2">装箱单</item></items></order>`;

test.describe("工具箱（XML 报文）", () => {
  test("格式化：按层级缩进且属性保持一行", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);
    await page.locator('[data-mode="format"]').click();

    const output = await page.locator('[data-role="output"]').inputValue();
    const lines = output.split("\n");
    expect(lines[0]).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(lines[1]).toBe('<order id="SO20260101">');
    expect(lines[2]).toBe("  <customer>");
    expect(lines[3]).toBe("    <name>张三</name>");
  });

  test("压缩：去掉标签间空白", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);
    await page.locator('[data-mode="minify"]').click();
    const output = await page.locator('[data-role="output"]').inputValue();
    expect(output).not.toContain("\n  ");
    expect(output).toContain("<name>张三</name>");
  });

  test("格式化写回：把结果写回输入区", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill("<r><a>1</a></r>");
    await page.locator('[data-role="apply-format"]').click();
    await expect(page.locator('[data-role="input"]')).toHaveValue(/<r>\n {2}<a>1<\/a>\n<\/r>/);
  });

  test("转 JSON：属性加 @，纯文本元素直接是字符串", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill('<r><i id="1">甲</i><n>20</n></r>');
    await page.locator('[data-mode="json"]').click();

    const output = await page.locator('[data-role="output"]').inputValue();
    const parsed = JSON.parse(output);
    expect(parsed).toEqual({ r: { i: { "@id": "1", "#text": "甲" }, n: "20" } });
  });

  test("转回 XML 验证往返", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill('<r><i id="1">甲</i><i id="2">乙</i></r>');
    await page.locator('[data-mode="json"]').click();
    await page.locator('[data-role="json-back"]').click();

    const back = await page.locator('[data-role="json-back-output"]').inputValue();
    expect(back).toContain('<i id="1">甲</i>');
    expect(back).toContain('<i id="2">乙</i>');
    // 不能多包一层根元素
    expect(back).not.toContain("<r><r>");
  });

  test("XPath：查元素、取属性、按属性筛选", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);
    await page.locator('[data-mode="xpath"]').click();

    await page.locator('[data-role="xpath"]').fill("//item");
    await expect(page.locator('[data-role="output"]')).toHaveValue(/出库单[\s\S]*装箱单/);

    await page.locator('[data-role="xpath"]').fill("//item/@sku");
    await expect(page.locator('[data-role="output"]')).toHaveValue(/A-1[\s\S]*B-2/);

    await page.locator('[data-role="xpath"]').fill('//item[@sku="B-2"]');
    await expect(page.locator('[data-role="output"]')).toHaveValue(/装箱单/);
    await expect(page.locator('[data-role="output"]')).not.toHaveValue(/出库单/);
  });

  test("校验：错误带行号与原因（标签不匹配 / 未转义尖括号）", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);

    await page.locator('[data-role="input"]').fill("<a><b></c></a>");
    await expect(page.locator('[data-role="issue"]')).toContainText(/第 \d+ 行/);
    await expect(page.locator('[data-role="issue"]')).toContainText(/不匹配|期望/);

    await page.locator('[data-role="input"]').fill("<a>1 < 2</a>");
    await expect(page.locator('[data-role="issue"]')).toContainText(/未转义|<|转义/);
  });

  test("校验：合法报文给出良构提示", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);
    await expect(page.locator('[data-role="valid-hint"]')).toBeVisible();
    await expect(page.locator('[data-role="issue"]')).toHaveCount(0);
  });

  test("CDATA 内容不解析（里面的尖括号是文本）", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill("<r><remark><![CDATA[a < b & c > d]]></remark></r>");
    // 不应报错
    await expect(page.locator('[data-role="issue"]')).toHaveCount(0);
    await page.locator('[data-mode="json"]').click();
    const output = await page.locator('[data-role="output"]').inputValue();
    expect(JSON.parse(output).r.remark).toBe("a < b & c > d");
  });

  test("统计：元素/属性/深度/不同名称", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill('<r a="1"><x>1</x><x/><y><z/></y></r>');
    await page.locator('[data-mode="stats"]').click();

    const output = await page.locator('[data-role="output"]').inputValue();
    expect(output).toContain("5"); // 5 个元素
    expect(output).toContain("3"); // 最大深度
    expect(output).toContain("r, x, y, z");
  });

  test("下载：得到格式化后的 XML 文件", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill("<r><a>1</a></r>");
    await page.locator('[data-mode="format"]').click();

    const waitDownload = page.waitForEvent("download");
    await page.locator('[data-role="download"]').click();
    const download = await waitDownload;
    expect(download.suggestedFilename()).toBe("xml-output.xml");

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString("utf8")).toContain("<a>1</a>");
  });

  test("复制：拿到当前模式的输出", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill("<r><a>1</a></r>");
    await page.locator('[data-mode="minify"]').click();

    await page.locator('[data-role="copy"]').click();
    const text = await page.evaluate(() => navigator.clipboard.readText());
    expect(text).toBe("<r><a>1</a></r>");
  });

  test("命名空间前缀的元素名能查到", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill('<ns:r xmlns:ns="http://x"><ns:i>1</ns:i></ns:r>');
    await page.locator('[data-mode="xpath"]').click();
    await page.locator('[data-role="xpath"]').fill("//ns:i");
    await expect(page.locator('[data-role="output"]')).toHaveValue(/1/);
  });

  test("空输入不报错也不输出", async ({ page }) => {
    await page.goto("/");
    await openXmlTool(page);
    await page.locator('[data-role="input"]').fill("");
    await expect(page.locator('[data-role="issue"]')).toHaveCount(0);
    await expect(page.locator('[data-role="output"]')).toHaveValue("");
  });
});
