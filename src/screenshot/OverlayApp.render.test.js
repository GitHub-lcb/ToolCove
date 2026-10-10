// OverlayApp 的渲染冒烟：Node（无 window）下应能完成首屏渲染而不抛错。
// 选区/标注/导出的逻辑在 geometry / history / png 的纯函数单测里；这里只管
// 「组件装配没坏」这条底线——遮罩页崩了就是整个截图功能不可用。
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import OverlayApp from "./OverlayApp.vue";

async function render() {
  const app = createSSRApp({ render: () => h(OverlayApp) });
  app.use(i18n);
  return renderToString(app);
}

describe("OverlayApp 渲染", () => {
  it("首屏可渲染：遮罩根节点与画布就位", async () => {
    const html = await render();
    expect(html).toContain("shot-root");
    expect(html).toContain("<canvas");
  });

  it("加载阶段不打扰：工具栏/尺寸标签/手柄已建好但一律隐藏（v-show，拖动开局不再付建树成本）", async () => {
    const html = await render();
    expect(html).toMatch(/shot-toolbar[^>]*style="[^"]*display:\s*none/);
    expect(html).toMatch(/shot-size[^>]*style="[^"]*display:\s*none/);
    expect(html).toMatch(/shot-handle[^>]*style="[^"]*display:\s*none/);
    expect(html).not.toContain("shot-hint");
  });

  it("不出现 undefined / null / NaN 占位", async () => {
    const html = await render();
    expect(html).not.toContain("undefined");
    expect(html).not.toContain(">null<");
    expect(html).not.toContain("NaN");
  });
});
