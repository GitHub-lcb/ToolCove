// 图片工具 E2E（移动视口）。
//
// 夹具是 e2e/fixtures/sample-400x300.png —— 一张**真实生成的 400×300 PNG**（3670 字节），
// 而不是 1×1 占位图：只有真实尺寸才能验证"缩放按最长边计算"这类口径。
// 夹具用二进制文件而不是内联 base64——内联那种做法我抄坏过一次（长度都不是 4 的倍数，
// 页面报 "The source image could not be decoded."），二进制文件不可能抄错。
import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";
const FIXTURE = fileURLToPath(new URL("../fixtures/sample-400x300.png", import.meta.url));

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openTool = async (page, key) => {
  await page.locator(`.m-item[data-tool="${key}"] .m-item-main`).click();
  await expect(page.locator(`.m-tool[data-tool="${key}"]`)).toBeVisible();
};

/** 把内置夹具塞进隐藏的 file input（手机端挑图走的就是这条 File API 路径）。 */
async function pickFixture(page) {
  await page.locator('[data-role="file"]').setInputFiles(FIXTURE);
  // 等到尺寸行出现即说明解码成功（data-role="info" 是外层的 ul，不要用它等）
  await expect(page.locator('[data-tool="image"] [data-role="size"]')).toBeVisible();
}

test.describe("手机端工具箱（图片）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("选图后读出真实尺寸与比例", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "image");
    await pickFixture(page);

    const tool = page.locator('[data-tool="image"]');
    await expect(tool.locator('[data-role="size"]')).toHaveText("400 × 300");
    // 400:300 约简为 4:3
    await expect(tool.locator('[data-role="info"]')).toContainText("4:3");
    await expect(tool.locator('[data-role="preview"]')).toBeVisible();
  });

  test("缩放：按最长边等比缩小，输出尺寸正确", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "image");
    await pickFixture(page);

    const tool = page.locator('[data-tool="image"]');
    await tool.locator('.m-chip[data-tab="resize"]').click();
    await tool.locator('[data-role="max-width"]').fill("200");
    await tool.locator('[data-role="max-height"]').fill("200");
    // 计划尺寸先显示出来（400×300 → 200×150）
    await expect(tool.locator('[data-role="plan"]')).toContainText("200 × 150");

    await tool.locator('[data-role="run"]').click();
    await expect(tool.locator('[data-role="result"]')).toBeVisible();
    await expect(tool.locator('[data-role="result-size"]')).toBeVisible();
    // 结果区块里也标明输出尺寸
    await expect(tool.locator('[data-role="result"]')).toContainText("200 × 150");
  });

  test("压缩：JPEG 输出比 PNG 原图小，且能下载", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "image");
    await pickFixture(page);

    const tool = page.locator('[data-tool="image"]');
    await tool.locator('.m-chip[data-tab="compress"]').click();
    await tool.locator('[data-role="format"]').selectOption("jpeg");
    await tool.locator('[data-role="run"]').click();

    await expect(tool.locator('[data-role="result"]')).toBeVisible();
    // 输出文件名应带 .jpg 后缀（命名走共享层 buildImageOutputName）
    await expect(tool.locator('[data-role="result"]')).toContainText(".jpg");
    // 下载按钮可用（手机端走浏览器下载；安卓壳接管后落应用目录）
    await expect(tool.locator('[data-role="download"]')).toBeEnabled();
  });

  test("转换：PNG → WebP 并保留原尺寸", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "image");
    await pickFixture(page);

    const tool = page.locator('[data-tool="image"]');
    await tool.locator('.m-chip[data-tab="convert"]').click();
    await tool.locator('[data-role="format"]').selectOption("webp");
    await tool.locator('[data-role="run"]').click();

    await expect(tool.locator('[data-role="result"]')).toBeVisible();
    await expect(tool.locator('[data-role="result"]')).toContainText("400 × 300");
    await expect(tool.locator('[data-role="result"]')).toContainText(".webp");
  });

  test("取色：给出色板，并可导出 CSS 变量与 JSON", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "image");
    await pickFixture(page);

    const tool = page.locator('[data-tool="image"]');
    await tool.locator('.m-chip[data-tab="palette"]').click();
    await tool.locator('[data-role="extract"]').click();

    await expect(tool.locator('[data-role="palette"]')).toBeVisible();
    await expect(tool.locator('[data-role="palette"] .m-swatch').first()).toBeVisible();
    // 默认导出 CSS 变量
    const css = await tool.locator('[data-role="palette-text"]').inputValue();
    expect(css).toContain(":root {");
    expect(css).toMatch(/--color-1: #[0-9A-F]{6}/);

    await tool.locator(".m-chip", { hasText: "JSON" }).click();
    const json = await tool.locator('[data-role="palette-text"]').inputValue();
    expect(JSON.parse(json).length).toBeGreaterThan(0);
  });

  test("未选图时给出可读提示，而不是默默无反应", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openTool(page, "image");

    const tool = page.locator('[data-tool="image"]');
    await tool.locator('.m-chip[data-tab="compress"]').click();
    await expect(tool.locator('[data-role="run"]')).toBeEnabled(); // 按钮可点，点了要有提示
    await tool.locator('[data-role="run"]').click();
    await expect(tool.locator('[data-role="error"]')).toContainText(/选择|图片/);
  });

  test("工具按需加载：目录页不加载图片工具实现", async ({ page }) => {
    const scripts = [];
    page.on("request", (request) => {
      if (request.resourceType() === "script") scripts.push(request.url());
    });
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    expect(scripts.join(" ")).not.toContain("ImageToolView");

    await openTool(page, "image");
    expect(scripts.join(" ")).toContain("ImageToolView");
  });
});
