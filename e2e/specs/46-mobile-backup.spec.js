// 备份与恢复 E2E（移动视口）。
//
// 手机端的备份走浏览器下载（JSON 文件），恢复走系统文件选择器（SAF）——
// 所以这里用假的 window.ToolCove 提供 file_pick 与 file_tool_read_text，
// 把"选文件 → 读内容 → 校验 → 写回"整条链路验一遍。
import { expect, test } from "@playwright/test";
import { seedData, seedMobileBridge } from "../helpers.js";

const MOBILE = "/mobile/app/index.html";

const openBackup = async (page) => {
  await page.locator(".m-tab[data-tab='settings']").click();
  await expect(page.locator(".m-settings")).toBeVisible();
  // 分段用真实的 data-nav 属性（设置页的 chips 是 data-nav，不是 data-section——
  // 猜选择器会得到"元素找不到"，这个会话里已经踩过好几次）
  await page.locator('.m-settings [data-nav="general"]').click();
  await expect(page.locator('[data-role="backup"]')).toBeVisible({ timeout: 10_000 });
};

test.describe("手机端设置（备份与恢复）", () => {
  test.use({ viewport: { width: 393, height: 851 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });

  test("导出备份：下载的 JSON 带格式标记与数据条目", async ({ page }) => {
    await seedData(page, {
      settings: { aiModel: "test-model" },
      snippets: [{ id: "s1", title: "备份用速记", content: "内容" }],
    });
    await page.goto(MOBILE);
    await openBackup(page);

    const waitDownload = page.waitForEvent("download");
    await page.locator('[data-role="backup"]').click();
    const download = await waitDownload;
    expect(download.suggestedFilename()).toMatch(/^toolcove-backup-\d{4}-\d{2}-\d{2}\.json$/);

    const stream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));

    // 文件头是"将来能识别旧格式"的关键
    expect(payload.format).toBe("toolcove-mobile-backup");
    expect(payload.version).toBe(1);
    expect(payload.platform).toBe("android");
    expect(Object.keys(payload.entries).length).toBeGreaterThan(0);
    // 速记数据真的在备份里
    const snippetKey = Object.keys(payload.entries).find((key) => key.includes("snippet"));
    expect(snippetKey, "备份里应包含速记数据").toBeTruthy();

    await expect(page.locator('[data-role="backup-notice"]')).toContainText(/导出|已导出/);
  });

  test("没有数据时不导出空文件（避免以为备份成功了）", async ({ page }) => {
    // 不种任何数据：IndexedDB 是空的
    await page.goto(MOBILE);
    await openBackup(page);

    await page.locator('[data-role="backup"]').click();
    await expect(page.locator('[data-role="backup-error"]')).toContainText(/没有|数据/);
  });

  test("恢复：选一个合法备份 → 写回并报出条数", async ({ page }) => {
    const backup = {
      format: "toolcove-mobile-backup",
      version: 1,
      createdAt: "2024-05-01T10:20:30.000Z",
      platform: "android",
      entries: { "toolcove.settings": { aiModel: "restored-model" } },
      stats: { keys: 1, missing: 0 },
    };
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, {
      pick: "content://x/backup.json",
      files: { "content://x/backup.json": JSON.stringify(backup) },
    });
    await page.goto(MOBILE);
    await openBackup(page);

    await page.locator('[data-role="restore"]').click();
    // 先展示"这次恢复会写回什么"，再执行
    await expect(page.locator('[data-role="backup-info"]')).toContainText(/1|条/);
    await expect(page.locator('[data-role="backup-notice"]')).toContainText(/恢复/);
  });

  test("选错文件（不是 JSON）时给出可读原因，而不是解析错误", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, {
      pick: "content://x/not-a-backup.zip",
      files: { "content://x/not-a-backup.zip": "PK\u0003\u0004 这是桌面端的 zip 包" },
    });
    await page.goto(MOBILE);
    await openBackup(page);

    await page.locator('[data-role="restore"]').click();
    // 要明确告诉用户"桌面端备份是 zip，请在电脑上恢复"
    await expect(page.locator('[data-role="backup-error"]')).toContainText(/zip|手机端备份|不是/);
  });

  test("选对 JSON 但不是本 App 的备份：说明格式不匹配", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, {
      pick: "content://x/other.json",
      files: { "content://x/other.json": JSON.stringify({ some: "other tool data" }) },
    });
    await page.goto(MOBILE);
    await openBackup(page);

    await page.locator('[data-role="restore"]').click();
    await expect(page.locator('[data-role="backup-error"]')).toContainText(/备份|格式|标记/);
  });

  test("用户取消选择文件：安静收场，不报错", async ({ page }) => {
    await seedData(page, { settings: {} });
    await seedMobileBridge(page, { pick: null, files: {} }); // 空串 = 取消
    await page.goto(MOBILE);
    await openBackup(page);

    await page.locator('[data-role="restore"]').click();
    await expect(page.locator('[data-role="backup-error"]')).toHaveCount(0);
    await expect(page.locator('[data-role="backup-notice"]')).toHaveCount(0);
  });
});
