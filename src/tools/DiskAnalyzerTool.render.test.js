// DiskAnalyzerTool 的渲染冒烟（node 环境 → SSR，够不到 onMounted 里的驱动器枚举）。
// 扫描、聚合、下钻的真实链路：Rust 侧有单测、E2E 验接线、桌面行为靠人工实测（见 CI 边界）。
// 这里只盯两件事：空态文案齐全；任何未注册的 i18n 键都不裸露成 toolbox.disk.xxx。
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import DiskAnalyzerTool from "./DiskAnalyzerTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(DiskAnalyzerTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("DiskAnalyzerTool 渲染", () => {
  it("首屏给出开始方式与只读承诺", async () => {
    const html = await render();
    for (const key of [
      "toolbox.registry.toolDisk",
      "toolbox.disk.subtitle",
      "toolbox.disk.pickFolder",
      "toolbox.disk.emptyTitle",
      "toolbox.disk.emptyHint",
    ]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("未开始扫描时没有假进度、假数字", async () => {
    const html = await render();
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
    expect(html).not.toContain(">null<");
    // 驱动器列表与结果区都要等真实数据，首屏不渲染
    expect(html).not.toContain(t("toolbox.disk.scanning"));
    expect(html).not.toContain(t("toolbox.disk.topFilesTitle"));
  });

  it("不渲染任何未注册的 i18n 键", async () => {
    const html = await render();
    expect(html).not.toMatch(/toolbox\.disk\.[A-Za-z]+/);
    expect(html).not.toMatch(/toolbox\.registry\.[A-Za-z]+/);
  });
});
