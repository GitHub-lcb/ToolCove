// ScreenshotTool 的渲染冒烟（node 环境 → SSR，够不到 onMounted 里的设置加载）。
// 热键设置读写与注册回滚在 Rust 侧有单测；这里只盯两件事：首屏文案齐全、
// 任何未注册的 i18n 键都不裸露成 screenshot.xxx。
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import ScreenshotTool from "./ScreenshotTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(ScreenshotTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("ScreenshotTool 渲染", () => {
  it("首屏文案齐全：立即截图、热键区、说明、贴图说明", async () => {
    const html = await render();
    for (const key of [
      "screenshot.subtitle",
      "screenshot.actionNow",
      "screenshot.hotkeySection",
      "screenshot.hotkeyCapture",
      "screenshot.hotkeyPin",
      "screenshot.guideTitle",
      "screenshot.pinTitle",
    ]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("未加载设置时热键显示「未启用」而不是 undefined / 空按钮", async () => {
    const html = await render();
    expect(html).toContain(t("screenshot.hotkeyOff"));
    expect(html).not.toContain("undefined");
    expect(html).not.toContain(">null<");
    expect(html).not.toContain("NaN");
  });

  it("快捷键表把三个核心动作都写明了", async () => {
    const html = await render();
    for (const key of ["screenshot.keyCopy", "screenshot.keySave", "screenshot.keyPin", "screenshot.keyCancel"]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("不渲染任何未注册的 i18n 键", async () => {
    const html = await render();
    expect(html).not.toMatch(/screenshot\.[A-Za-z]+/);
    expect(html).not.toMatch(/toolbox\.registry\.[A-Za-z]+/);
  });
});
