// PDF 工具 E2E（移动视口）。
//
// 夹具是真实生成的 PDF（e2e/fixtures/sample-*.pdf，见 tmp 脚本用 pdf-lib 造）——
// 只有真实文件才能验证"合并后几页、拆分对不对、旋转写没写进去"。
// 下载结果不只看文件名：把下载的字节读回来用 pdf-lib 复核页数，才算真的验完。
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";
const FIXTURE_3P = fileURLToPath(new URL("../fixtures/sample-3p.pdf", import.meta.url));
const FIXTURE_5P = fileURLToPath(new URL("../fixtures/sample-5p.pdf", import.meta.url));

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openTool = async (page, key) => {
  await page.locator(`.m-item[data-tool="${key}"] .m-item-main`).click();
  await expect(page.locator(`.m-tool[data-tool="${key}"]`)).toBeVisible();
};

/** 点下载并抓取产物字节，返回 { name, pages }（用 pdf-lib 复核页数）。 */
async function downloadAndInspect(page, clickSelector) {
  const waitDownload = page.waitForEvent("download");
  await page.locator(clickSelector).click();
  const download = await waitDownload;
  const path = await download.path();
  const bytes = new Uint8Array(readFileSync(path));
  const doc = await PDFDocument.load(bytes);
  return { name: download.suggestedFilename(), pages: doc.getPageCount(), doc };
}

test.describe("手机端工具箱（PDF）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN", acceptDownloads: true });

  test("选文件后读出真实页数", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "pdf");

    const tool = page.locator('[data-tool="pdf"]');
    await tool.locator('[data-mode="pages"]').click();
    await tool.locator('[data-role="file"]').setInputFiles(FIXTURE_5P);

    await expect(tool.locator('[data-role="file-meta"]')).toContainText("5");
    await expect(tool.locator('[data-role="summary"]')).toBeVisible();
  });

  test("合并：3 页 + 5 页 → 输出 8 页（并复核产物）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "pdf");

    const tool = page.locator('[data-tool="pdf"]');
    await tool.locator('[data-role="file"]').setInputFiles([FIXTURE_3P, FIXTURE_5P]);
    await expect(tool.locator('[data-role="merge-list"] [data-file]')).toHaveCount(2);

    const result = await downloadAndInspect(page, '[data-role="merge"]');
    expect(result.pages).toBe(8);
    expect(result.name).toContain("merged");
    await expect(tool.locator('[data-role="notice"]')).toContainText("已保存");
  });

  test("提取：从 5 页里取 1-2,5 → 输出 3 页", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "pdf");

    const tool = page.locator('[data-tool="pdf"]');
    await tool.locator('[data-mode="pages"]').click();
    await tool.locator('[data-role="file"]').setInputFiles(FIXTURE_5P);
    await tool.locator('[data-role="range"]').fill("1-2,5");
    // 选中范围回显出来（让人确认自己选对了，而不是等到产物才发现）
    await expect(tool.locator('[data-role="selection"]')).toContainText("3");

    const result = await downloadAndInspect(page, '[data-role="extract"]');
    expect(result.pages).toBe(3);
  });

  test("删除：从 5 页里删 1-2 → 输出 3 页", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "pdf");

    const tool = page.locator('[data-tool="pdf"]');
    await tool.locator('[data-mode="pages"]').click();
    await tool.locator('[data-role="file"]').setInputFiles(FIXTURE_5P);
    await tool.locator('[data-role="range"]').fill("1-2");

    const result = await downloadAndInspect(page, '[data-role="remove"]');
    expect(result.pages).toBe(3);
  });

  test("旋转：把选中页转 90°，产物里读得到旋转角", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "pdf");

    const tool = page.locator('[data-tool="pdf"]');
    await tool.locator('[data-mode="pages"]').click();
    await tool.locator('[data-role="file"]').setInputFiles(FIXTURE_5P);
    await tool.locator('[data-role="range"]').fill("1");
    await tool.locator('[data-role="angle"]').selectOption("90");

    const result = await downloadAndInspect(page, '[data-role="rotate"]');
    expect(result.pages).toBe(5);
    // 第一页应带 90° 旋转，其余页不带
    const angles = result.doc.getPages().map((p) => p.getRotation().angle);
    expect(angles[0]).toBe(90);
    expect(angles[1]).toBe(0);
  });

  test("拆分：一行一组，输出多个文件", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "pdf");

    const tool = page.locator('[data-tool="pdf"]');
    await tool.locator('[data-mode="split"]').click();
    await tool.locator('[data-role="file"]').setInputFiles(FIXTURE_5P);
    // 一行一组（textarea，换行有意义）
    await tool.locator('[data-role="range"]').fill("1-2\n3-5");

    const downloads = [];
    page.on("download", (d) => downloads.push(d));
    await tool.locator('[data-role="split"]').click();
    await expect(tool.locator('[data-role="notice"]')).toContainText("2");
    // 等两个下载都落地
    await expect.poll(() => downloads.length, { timeout: 15_000 }).toBe(2);

    const counts = [];
    for (const download of downloads) {
      const bytes = new Uint8Array(readFileSync(await download.path()));
      counts.push((await PDFDocument.load(bytes)).getPageCount());
    }
    expect(counts.sort()).toEqual([2, 3]);
  });

  test("没选文件时点操作：给出可读提示而不是静默", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "pdf");

    const tool = page.locator('[data-tool="pdf"]');
    await tool.locator('[data-mode="pages"]').click();
    // 合并模式下按钮不出现；页面操作模式下没文件时操作按钮也不出现（先选文件）
    await expect(tool.locator('[data-role="empty"]')).toBeVisible();
    await expect(tool.locator('[data-role="extract"]')).toHaveCount(0);
  });

  test("按需加载：目录页不加载 PDF 工具实现", async ({ page }) => {
    const scripts = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    expect(scripts.join(" ")).not.toContain("PdfToolView");

    await openTool(page, "pdf");
    expect(scripts.join(" ")).toContain("PdfToolView");
  });
});
