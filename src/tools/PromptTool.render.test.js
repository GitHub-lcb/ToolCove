// PromptTool 的渲染冒烟（node 环境 → SSR；Node 下 env.js 按桌面处理，走完整界面而不是 desktopOnly 页）。
// 真实生成链路（Rust 命令 / ComfyUI 往返 / repository 落盘）由单测 + E2E 覆盖，这里只盯：
// 空态文案齐全、没有未注册的 i18n 键裸露、没有 undefined/NaN 假数字。
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import PromptTool from "./PromptTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(PromptTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("PromptTool 渲染", () => {
  it("空库首屏给出库区、三个 Tab 与内置示例", async () => {
    const html = await render();
    for (const key of [
      "toolbox.prompt.libTitle",
      "toolbox.prompt.libEmpty",
      "toolbox.prompt.libSamplesTitle",
      "toolbox.prompt.genTab",
      "toolbox.prompt.histTab",
      "toolbox.prompt.setTab",
    ]) {
      expect(html, key).toContain(t(key));
    }
    expect(html).toContain(t("toolbox.prompt.samples.portrait.title"));
    expect(html).toContain(t("toolbox.prompt.samples.loopVideo.title"));
  });

  it("桌面形态不渲染 desktopOnly 页；也不出现假数字", async () => {
    const html = await render();
    expect(html).not.toContain(t("toolbox.prompt.desktopOnly"));
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain(">null<");
    // 生成面板要等配置读完（bootstrapped）才挂载，SSR 首屏按设计不含它——不该反过来渲染半个空壳
    expect(html).not.toContain(t("toolbox.prompt.gen-run"));
  });

  it("不渲染任何未注册的 i18n 键", async () => {
    const html = await render();
    expect(html).not.toMatch(/toolbox\.prompt\.[A-Za-z]+/);
    expect(html).not.toMatch(/toolbox\.registry\.[A-Za-z]+/);
    expect(html).not.toMatch(/mobile\.[A-Za-z]+/);
  });
});
