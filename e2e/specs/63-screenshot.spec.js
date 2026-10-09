// 截图工具 E2E（桌面形态）。
//
// 遮罩框选、标注与贴图窗都是 Windows 原生窗口（由 Rust 直接创建、靠全局热键拉起），
// 浏览器替身到不了那一层——那部分靠 Rust 单测 + 渲染冒烟 + 人工桌面验收。
// 这里守的是工具页这条接线：设置读取 → 热键状态渲染 → 录制改键 → 「立即截图」发出 screenshot_begin。
import { expect, test } from "@playwright/test";
import { seedData, seedDesktopIpc } from "../helpers.js";

const SETTINGS = { captureHotkey: "F1", pinHotkey: "F3", captureRegistered: true, pinRegistered: true };

/** 截图命令的可控替身：设置读写给结构化结果，其余截图/贴图命令记录调用。 */
async function stubScreenshot(page, { settings = SETTINGS } = {}) {
  // 首启的遥测询问弹窗是全屏遮罩，会把所有点击都拦掉；标记成已询问即可（同 61 号用例）
  await seedData(page, { settings: { telemetry: { prompted: true, enabled: false } } });
  await seedDesktopIpc(page, {});
  await page.addInitScript((initial) => {
    window.__shotCalls = [];
    const original = window.__TAURI_INTERNALS__.invoke;
    window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      const name = String(cmd);
      if (name.startsWith("screenshot_") || name.startsWith("pin_")) {
        window.__shotCalls.push({ cmd: name, args: args || {} });
        if (name === "screenshot_settings_get") return initial;
        if (name === "screenshot_settings_set") {
          return {
            captureHotkey: args?.captureHotkey ?? "",
            pinHotkey: args?.pinHotkey ?? "",
            captureRegistered: Boolean(args?.captureHotkey),
            pinRegistered: Boolean(args?.pinHotkey),
          };
        }
        return null;
      }
      return original(cmd, args);
    };
  }, settings);
}

/** 工具箱里名为「截图」的那张卡（「截图」二字也出现在别的工具描述里，按卡片标题精确匹配）。 */
const screenshotCard = (page) => page.locator(".tool-item .name", { hasText: /^截图$/ });

const shotCalls = (page) => page.evaluate(() => window.__shotCalls);

test.describe("工具（截图）", () => {
  test("工具页渲染当前热键与说明，桌面形态下可从工具箱搜到", async ({ page }) => {
    await stubScreenshot(page);
    await page.goto("/?tool=screenshot");
    await page.locator(".st-head h2").waitFor({ state: "visible", timeout: 10_000 });

    // 热键键位与状态如实显示
    await expect(page.locator('[data-role="hotkey-capture"]')).toContainText("F1");
    await expect(page.locator('[data-role="hotkey-pin"]')).toContainText("F3");
    await expect(page.locator(".st-chip.on")).toHaveCount(2);
    // 用法说明与贴图说明在首屏
    await expect(page.locator(".st-steps")).toContainText("冻结全屏");
    await expect(page.locator(".st-keys")).toContainText("另存为 PNG 文件");

    // 工具箱里能搜到（desktopOnly 工具在桌面形态可见）
    await page.goto("/");
    await page.locator(".nav-item", { hasText: "工具箱" }).click();
    const box = page.locator(".toolbox-search input");
    await box.waitFor({ state: "visible", timeout: 10_000 });
    await box.fill("截图");
    await expect(screenshotCard(page)).toHaveCount(1);
  });

  test("「立即截图」发出 screenshot_begin 并给出提示", async ({ page }) => {
    await stubScreenshot(page);
    await page.goto("/?tool=screenshot");
    await page.locator('[data-role="capture-now"]').click();

    await expect(page.locator(".toast")).toContainText("已发起截图");
    const calls = await shotCalls(page);
    expect(calls.map((c) => c.cmd)).toContain("screenshot_begin");
  });

  test("录制改键：按下组合键即保存，Backspace 关闭该热键", async ({ page }) => {
    await stubScreenshot(page);
    await page.goto("/?tool=screenshot");
    const captureKey = page.locator('[data-role="hotkey-capture"]');
    await captureKey.waitFor({ state: "visible" });

    await captureKey.click();
    await expect(captureKey).toContainText("按下组合键");
    await page.keyboard.press("Control+g");
    await expect(captureKey).toContainText("Ctrl");
    await expect(captureKey).toContainText("G");

    const saved = (await shotCalls(page)).filter((c) => c.cmd === "screenshot_settings_set");
    expect(saved.at(-1)?.args?.captureHotkey).toBe("Ctrl+G");
    // 保存时贴图热键必须原样带上，不能被清空
    expect(saved.at(-1)?.args?.pinHotkey).toBe("F3");

    await captureKey.click();
    await page.keyboard.press("Backspace");
    await expect(captureKey).toContainText("未启用");
    const afterClear = (await shotCalls(page)).filter((c) => c.cmd === "screenshot_settings_set");
    expect(afterClear.at(-1)?.args?.captureHotkey).toBe("");
  });

  test("热键被其它程序占用时如实警示，不假装生效", async ({ page }) => {
    await stubScreenshot(page, {
      settings: { ...SETTINGS, captureRegistered: false },
    });
    await page.goto("/?tool=screenshot");
    await expect(page.locator('[data-role="hotkey-capture"]')).toContainText("F1");
    await expect(page.locator(".st-chip.warn")).toHaveText("被其它程序占用");
    await expect(page.locator(".st-chip.on")).toHaveCount(1); // 贴图键仍生效
  });

  test("浏览器形态：直达链接显示桌面专属错误，工具箱里不出现该卡片", async ({ page }) => {
    // 不 seed：浏览器形态下 desktopOnly 工具会被过滤掉
    await page.goto("/?tool=screenshot");
    await expect(page.locator(".st-error")).toContainText("桌面版能力");
    await expect(page.locator('[data-role="capture-now"]')).toBeDisabled();

    await page.goto("/");
    await page.locator(".nav-item", { hasText: "工具箱" }).click();
    const box = page.locator(".toolbox-search input");
    await box.waitFor({ state: "visible", timeout: 10_000 });
    await box.fill("截图");
    await expect(screenshotCard(page)).toHaveCount(0);
  });
});
