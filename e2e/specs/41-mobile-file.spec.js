// 文件工具 E2E（移动视口）——用**假的安卓原生桥**跑通整条前端链路。
//
// 这正是当初把桥做成"可注入"的回报：不必有设备/模拟器，就能把
// FileToolView → invoke("file_pick"/"file_tool_read_text"/"file_tool_write_text")
// → bridge.js → 原生返回形状 这条路径完整验证一遍。
// 原生侧对应的实现另有 57 条 Kotlin JVM 单测（编解码、命令分发、选择器时序）。
import { expect, test } from "@playwright/test";
import { seedData, seedMobileBridge } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";
const URI = "content://com.android.providers.downloads/document/primary%3ADownload%2Forder.txt";

const goToolbox = async (page) => {
  await page.locator(".m-tab[data-tab='toolbox']").click();
  await expect(page.locator(".m-toolbox")).toBeVisible();
};

const openFile = async (page) => {
  await page.locator('.m-item[data-tool="file"] .m-item-main').click();
  await expect(page.locator('.m-tool[data-tool="file"]')).toBeVisible();
};

test.describe("手机端工具箱（文件 / SAF）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("没有原生桥时如实说明：浏览器预览下没有系统文件选择器", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openFile(page);

    const tool = page.locator('[data-tool="file"]');
    await expect(tool.locator('[data-role="no-bridge"]')).toBeVisible();
    await expect(tool.locator('[data-role="no-bridge"]')).toContainText(/App|浏览器/);
    // 按钮禁用，而不是点了没反应
    await expect(tool.locator('[data-role="open"]')).toBeDisabled();
  });

  test("选文件 → 读出内容与真实编码/BOM 信息", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { files: { [URI]: "第一行\n第二行" }, pick: URI });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openFile(page);

    const tool = page.locator('[data-tool="file"]');
    await tool.locator('[data-role="open"]').click();

    await expect(tool.locator('[data-role="file-meta"]')).toBeVisible();
    await expect(tool.locator('[data-role="file-name"]')).toContainText("order.txt");
    await expect(tool.locator('[data-role="file-encoding"]')).toHaveText("UTF-8");
    await expect(tool.locator('[data-role="content"]')).toHaveValue(/第一行/);

    // 走的是真实命令名（与桌面端一致），而不是前端自己编的
    const calls = await page.evaluate(() => window.__E2E_NATIVE_CALLS__.map((c) => c.cmd));
    expect(calls).toContain("file_pick");
    expect(calls).toContain("file_tool_read_text");
  });

  test("用户取消选择：安静收场，不报错也不留半截状态", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { files: {}, pick: null }); // pick=null → 返回空串 = 取消
    await page.goto(MOBILE);
    await goToolbox(page);
    await openFile(page);

    const tool = page.locator('[data-tool="file"]');
    await tool.locator('[data-role="open"]').click();

    // 取消不是错误：不能弹红字，也不该出现文件信息
    await expect(tool.locator('[data-role="error"]')).toHaveCount(0);
    await expect(tool.locator('[data-role="file-meta"]')).toHaveCount(0);
    await expect(tool.locator('[data-role="content"]')).toHaveCount(0);
  });

  test("选择器打不开时给出可读原因", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { failPick: true });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openFile(page);

    const tool = page.locator('[data-tool="file"]');
    await tool.locator('[data-role="open"]').click();
    await expect(tool.locator('[data-role="error"]')).toContainText("文件选择器");
  });

  test("编辑后保存回原文件，并重新读取确认落盘结果", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { files: { [URI]: "旧内容" }, pick: URI });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openFile(page);

    const tool = page.locator('[data-tool="file"]');
    await tool.locator('[data-role="open"]').click();
    await expect(tool.locator('[data-role="content"]')).toHaveValue("旧内容");

    // 未改动时保存按钮禁用（避免无意义写盘）
    await expect(tool.locator('[data-role="save"]')).toBeDisabled();

    await tool.locator('[data-role="content"]').fill("新内容更长一些");
    await expect(tool.locator('[data-role="save"]')).toBeEnabled();
    await tool.locator('[data-role="save"]').click();

    await expect(tool.locator('[data-role="notice"]')).toContainText("已保存");
    // 写回后会重新读：内容与大小都反映真实落盘结果
    await expect(tool.locator('[data-role="content"]')).toHaveValue("新内容更长一些");
    const calls = await page.evaluate(() => window.__E2E_NATIVE_CALLS__.map((c) => c.cmd));
    expect(calls.filter((c) => c === "file_tool_write_text")).toHaveLength(1);
    expect(calls.filter((c) => c === "file_tool_read_text").length).toBeGreaterThanOrEqual(2);
  });

  test("读出的编码成为写回默认值（避免悄悄改坏文件）", async ({ page }) => {
    await seedData(page, { settings: {} });
    // 带 BOM 的文件：写回默认应继承"UTF-8 + BOM"，否则 BOM 会被悄悄丢掉
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("带 BOM 的内容")]);
    await seedMobileBridge(page, { files: { [URI]: Array.from(bom) }, pick: URI });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openFile(page);

    const tool = page.locator('[data-tool="file"]');
    await tool.locator('[data-role="open"]').click();

    await expect(tool.locator('[data-role="file-meta"]')).toContainText("BOM");
    await expect(tool.locator('[data-role="write-encoding"]')).toHaveValue("UTF-8");
    await expect(tool.locator('[data-role="bom"]')).toHaveClass(/on/);
  });

  test("读不存在的文件：报错带原因，不留半截状态", async ({ page }) => {
    await seedData(page, { settings: {} });
    // pick 指向一个不在内存文件系统里的 URI
    await seedMobileBridge(page, { files: {}, pick: "content://x/gone.txt" });
    await page.goto(MOBILE);
    await goToolbox(page);
    await openFile(page);

    const tool = page.locator('[data-tool="file"]');
    await tool.locator('[data-role="open"]').click();
    await expect(tool.locator('[data-role="error"]')).toContainText("gone.txt");
    await expect(tool.locator('[data-role="file-meta"]')).toHaveCount(0);
  });

  test("迁移进度：文件工具已可用，且保留 SAF 说明", async ({ page }) => {
    await seedData(page, { settings: {} });
    await page.goto(MOBILE);
    await goToolbox(page);

    const file = page.locator('.m-item[data-tool="file"]');
    await expect(file).toHaveAttribute("data-ready", "true");
    // 「可用」与「和桌面一样」不是一回事：SAF 的语义差异必须写在列表上
    await expect(file).toContainText(/SAF|系统选择器/);
  });
});
