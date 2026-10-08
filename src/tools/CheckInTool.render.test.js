// CheckInTool 的渲染冒烟（node 环境 → SSR 渲染，够不到 onMounted 里的加载状态）。
// 契约、幂等、调度都有 src/checkin/*.test.js 兜着，这里只盯两件事：
// 首屏该有的文案都在；任何未注册的 i18n 键都不裸露成 checkin.xxx，
// 否则界面会把键名直接显示给用户。
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import CheckInTool from "./CheckInTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(CheckInTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("CheckInTool 渲染", () => {
  it("首屏文案齐全：定时区、空态提示、操作按钮", async () => {
    const html = await render();
    for (const key of [
      "checkin.title",
      "checkin.subtitle",
      "checkin.autoLabel",
      "checkin.autoAt",
      "checkin.maxRuns",
      "checkin.autostartLabel",
      "checkin.autostartHint",
      "checkin.empty",
      "checkin.runAll",
      "checkin.addSite",
    ]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("界面上的提醒把「退出应用就不签」说清楚了，不能只写一句模糊的话", async () => {
    const html = await render();
    // 这句提示是本工具唯一的使用前提说明，删掉就会让人以为「关窗口也在跑」
    expect(html).toContain(t("checkin.autostartHint"));
  });

  it("不渲染任何未注册的 i18n 键", async () => {
    const html = await render();
    expect(html).not.toMatch(/checkin\.[A-Za-z]/);
    expect(html).not.toMatch(/checkin\.err\.[A-Za-z]/);
  });

  it("不出现 undefined / null 之类的占位", async () => {
    const html = await render();
    expect(html).not.toContain("undefined");
    expect(html).not.toContain(">null<");
    expect(html).not.toContain("NaN");
  });

  it("定时开关默认是关的——自动往外部发请求得用户自己点头", async () => {
    const html = await render();
    // DEFAULT_POLICY.enabled = false
    expect(html).toContain(t("checkin.scheduleOff"));
  });
});
