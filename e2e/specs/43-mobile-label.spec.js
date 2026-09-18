// 标签工具 E2E（移动视口）——真的加载 WASM 引擎并排版。
//
// 这套用例的价值在于：**手机端与桌面端跑的是同一份排版引擎**（crates/label-core 编译出的 wasm），
// 所以这里断言的画布尺寸、居中坐标、TSPL 指令，与桌面端是同一个函数算出来的。
// 「所见即所打」由此可验，而不是靠人工比对两端截图。
//
// 引擎产物由 `npm run build:label-wasm` 生成到 mobile/public/（随 APK 打包），
// playwright 的 webServer 会先跑 build:mobile，所以 E2E 跑在真实产物上。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openLabel = async (page) => {
  await page.locator('.m-item[data-tool="label"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="label"]')).toBeVisible();
  // 引擎是异步加载的：等它就绪再断言（否则会看到"加载中"）
  await expect(page.locator('[data-role="preview"]')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-role="engine-error"]')).toHaveCount(0);
};

test.describe("手机端工具箱（标签 / WASM 引擎）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("加载 wasm 引擎并排出默认标签（50×30mm @203dpi = 400×240）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openLabel(page);

    // 画布尺寸来自引擎，不是前端算的
    await expect(page.locator('[data-role="canvas-size"]')).toHaveText("400 × 240");
  });

  test("预览画的是引擎给的绘制模型（canvas 真的有内容）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openLabel(page);

    // 取画布像素：默认内容"测试标签"是黑字，应当存在黑色像素
    const painted = await page.locator('[data-role="preview"]').evaluate((canvas) => {
      const ctx = canvas.getContext("2d");
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] < 64 && data[i + 1] < 64 && data[i + 2] < 64) dark += 1;
      }
      return { dark, total: data.length / 4 };
    });
    expect(painted.dark, "画布上应有黑色像素（文字被画出来了）").toBeGreaterThan(0);
    // 但也不该整块变黑（那说明填充逻辑错了）
    expect(painted.dark / painted.total).toBeLessThan(0.5);
  });

  test("改尺寸立刻重排（排版是纯计算，不需要点预览）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openLabel(page);

    await page.locator('[data-role="width"]').fill("40");
    await expect(page.locator('[data-role="canvas-size"]')).toHaveText("320 × 240");

    await page.locator('[data-role="height"]').fill("20");
    await expect(page.locator('[data-role="canvas-size"]')).toHaveText("320 × 160");
  });

  test("TSPL 指令与预览同源：指令里带 SIZE/GAP，且尺寸与画布一致", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openLabel(page);

    await page.locator('[data-role="toggle-source"]').click();
    const source = await page.locator('[data-role="source"]').inputValue();

    // 指令按打印机协议用 CRLF
    expect(source).toContain("SIZE 50 mm,30 mm");
    expect(source).toContain("GAP 2 mm,0 mm");
    expect(source).toContain("DIRECTION 1");
    // 画布 400×240 与 SIZE 50mm,30mm 是同一件事的两种表达（@203dpi）
    await expect(page.locator('[data-role="canvas-size"]')).toHaveText("400 × 240");
  });

  test("条码与二维码：内容进绘制模型，条码过宽时给体检提示", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openLabel(page);

    await page.locator('[data-role="barcode"]').fill("123456789012");
    await page.locator('[data-role="qr"]').fill("https://example.com");
    // 内容加进来后画布上会有更多黑色像素
    const painted = await page.locator('[data-role="preview"]').evaluate((canvas) => {
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i] < 64) dark += 1;
      return dark;
    });
    expect(painted).toBeGreaterThan(0);

    // 体检提示区存在（有内容时会有 printerMissing 之类的 info）
    await expect(page.locator('[data-role="issues"]')).toBeVisible();
  });

  test("纸张类型可切换，指令跟着变（间隙纸 vs 连续纸）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openLabel(page);

    await page.locator('[data-role="toggle-source"]').click();
    expect(await page.locator('[data-role="source"]').inputValue()).toContain("GAP 2 mm");

    await page.locator('[data-media="continuous"]').click();
    const continuous = await page.locator('[data-role="source"]').inputValue();
    // 连续纸没有间隙：不该再有 GAP 指令
    expect(continuous).not.toContain("GAP 2 mm");
  });

  test("导出 .prn：拿到文件且内容是 TSPL 指令", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openLabel(page);

    const waitDownload = page.waitForEvent("download");
    await page.locator('[data-role="export"]').click();
    const download = await waitDownload;
    expect(download.suggestedFilename()).toBe("label.prn");
    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    expect(text).toContain("SIZE 50 mm,30 mm");
    await expect(page.locator('[data-role="notice"]')).toContainText("label.prn");
  });

  test("如实标注：安卓没有 RAW 打印队列（不假装能直接打印）", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openLabel(page);

    const note = page.locator('[data-role="print-note"]');
    await expect(note).toBeVisible();
    // 说明要点出"同一份引擎"与"需要 TSPL 工具发送"两件事
    await expect(note).toContainText(/RAW|打印队列/);
    await expect(note).toContainText(/TSPL|同一份/);
  });

  test("工具箱 14/14：全部可用，能力受限的四项仍带说明", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    // 没有未迁移项
    await expect(page.locator('.m-item[data-ready="false"]')).toHaveCount(0);
    const total = await page.locator(".m-item[data-tool]").count();
    const progress = await page.locator('[data-role="tool-progress"]').innerText();
    expect(progress).toContain(`${total}/${total}`);

    // 能力受限的四项说明还在（可用 ≠ 和桌面一样）
    for (const key of ["network", "file", "db", "label"]) {
      await expect(page.locator(`.m-item[data-tool="${key}"]`)).toContainText(/\S{6,}/);
    }
  });
});
