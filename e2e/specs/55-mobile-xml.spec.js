// XML 工具 E2E（移动视口）。
//
// 与桌面端共用同一份纯逻辑（src/xmlTool.js，66 条单测），这里验手机端界面接线：
// 模式 chips、输入/输出切换、校验提示、导出下载。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const openXml = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await page.locator('.m-item[data-tool="xml"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="xml"]')).toBeVisible();
};

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<order id="SO20260101"><customer><name>张三</name></customer><items><item sku="A-1">出库单</item><item sku="B-2">装箱单</item></items></order>`;

/** 手机上输出在另一个视图里，切过去再读。 */
const readOutput = async (page) => {
  await page.locator('[data-view="output"]').click();
  return await page.locator('[data-role="output"]').inputValue();
};

test.describe("手机端工具箱（XML 报文）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("格式化：按层级缩进，声明后不空行", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);
    await page.locator('[data-mode="format"]').click();

    const output = await readOutput(page);
    const lines = output.split("\n");
    expect(lines[0]).toBe('<?xml version="1.0" encoding="UTF-8"?>');
    expect(lines[1]).toBe('<order id="SO20260101">');
    expect(lines[2]).toBe("  <customer>");
  });

  test("压缩：去掉标签间空白", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);
    await page.locator('[data-mode="minify"]').click();
    const output = await readOutput(page);
    expect(output).not.toContain("\n  ");
    expect(output).toContain("<name>张三</name>");
  });

  test("转 JSON：属性加 @，纯文本元素是字符串", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
    await page.locator('[data-role="input"]').fill('<r><i id="1">甲</i><n>20</n></r>');
    await page.locator('[data-mode="json"]').click();
    const parsed = JSON.parse(await readOutput(page));
    expect(parsed).toEqual({ r: { i: { "@id": "1", "#text": "甲" }, n: "20" } });
  });

  test("XPath：查元素与取属性", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
    await page.locator('[data-role="input"]').fill(SAMPLE);

    await page.locator('[data-mode="xpath"]').click();
    await page.locator('[data-view="output"]').click();
    await page.locator('[data-role="xpath"]').fill("//item");
    await expect(page.locator('[data-role="output"]')).toHaveValue(/出库单[\s\S]*装箱单/);

    await page.locator('[data-role="xpath"]').fill("//item/@sku");
    await expect(page.locator('[data-role="output"]')).toHaveValue(/A-1[\s\S]*B-2/);
  });

  test("校验：错误带行号与原因，合法报文给出良构提示", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);

    await page.locator('[data-role="input"]').fill("<a><b></c></a>");
    await expect(page.locator('[data-role="issue"]')).toContainText(/第 \d+ 行/);

    await page.locator('[data-role="input"]').fill("<a>1 < 2</a>");
    await expect(page.locator('[data-role="issue"]')).toContainText(/转义|<|未转义/);

    await page.locator('[data-role="input"]').fill(SAMPLE);
    await expect(page.locator('[data-role="valid-hint"]')).toBeVisible();
    await expect(page.locator('[data-role="issue"]')).toHaveCount(0);
  });

  test("CDATA 内容不解析", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
    await page.locator('[data-role="input"]').fill("<r><remark><![CDATA[a < b & c > d]]></remark></r>");
    await expect(page.locator('[data-role="issue"]')).toHaveCount(0);
    await page.locator('[data-mode="json"]').click();
    expect(JSON.parse(await readOutput(page)).r.remark).toBe("a < b & c > d");
  });

  test("统计：元素/深度/名称列表", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
    await page.locator('[data-role="input"]').fill('<r a="1"><x>1</x><x/><y><z/></y></r>');
    await page.locator('[data-mode="stats"]').click();
    const output = await readOutput(page);
    expect(output).toContain("5");
    expect(output).toContain("3");
    expect(output).toContain("r, x, y, z");
  });

  test("格式化写回：结果写回输入区", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
    await page.locator('[data-role="input"]').fill("<r><a>1</a></r>");
    await page.locator('[data-role="apply-format"]').click();
    await expect(page.locator('[data-role="input"]')).toHaveValue(/<r>\n {2}<a>1<\/a>\n<\/r>/);
  });

  test("导出：下载得到 XML 文件", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
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

  test("内容落盘：切走再回来还在", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await openXml(page);
    await page.locator('[data-role="input"]').fill("<persist>保留我</persist>");

    await page.locator(".m-tab[data-tab='records']").click();
    await page.locator(".m-tab[data-tab='toolbox']").click();
    await expect(page.locator(".m-toolbox")).toBeVisible();
    await page.locator('.m-item[data-tool="xml"] .m-item-main').click();
    await expect(page.locator('[data-role="input"]')).toHaveValue(/保留我/);
  });

  test("工具箱：XML 已登记，进度与条目数一致", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await page.locator(".m-tab[data-tab='toolbox']").click();

    await expect(page.locator('.m-item[data-tool="xml"]')).toBeVisible();
    const total = await page.locator(".m-item[data-tool]").count();
    await expect(page.locator('[data-role="tool-progress"]')).toContainText(`${total}/${total}`);
  });
});
