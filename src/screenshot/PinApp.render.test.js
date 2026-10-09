// PinApp 的渲染冒烟：Node（无 window）下应能完成首屏渲染而不抛错。
// 缩放几何（zoomed_size / zoom_anchor_position）在 Rust 侧单测。
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import PinApp from "./PinApp.vue";

async function render() {
  const app = createSSRApp({ render: () => h(PinApp) });
  app.use(i18n);
  return renderToString(app);
}

describe("PinApp 渲染", () => {
  it("首屏可渲染：贴图根节点就位", async () => {
    const html = await render();
    expect(html).toContain("pin-root");
  });

  it("取图前不渲染图片与菜单", async () => {
    const html = await render();
    expect(html).not.toContain("pin-image");
    expect(html).not.toContain("pin-menu");
  });
});
