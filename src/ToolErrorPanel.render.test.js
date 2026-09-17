// ToolErrorPanel 渲染冒烟：独立窗口与主窗口内嵌共用的报错面板，
// 内容是「已翻译的标题 + 建议 + 原始原因」，三者都不能丢或渲染成空壳。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "./i18n/index.js";
import ToolErrorPanel from "./ToolErrorPanel.vue";

function render(props) {
  const app = createSSRApp({ render: () => h(ToolErrorPanel, props) });
  app.use(i18n);
  return renderToString(app);
}

describe("ToolErrorPanel 渲染", () => {
  it("渲染标题、排障建议与原始原因，并带 role=alert", async () => {
    const html = await render({
      reason: "工具加载失败",
      hint: "重启应用再试，把下面的原因一并反馈",
      detail: "boom: setup failed · setup function",
    });
    expect(html).toContain('class="tool-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("工具加载失败");
    expect(html).toContain("重启应用再试，把下面的原因一并反馈");
    expect(html).toContain("boom: setup failed · setup function");
  });

  it("只有标题时不渲染空的建议/原因占位", async () => {
    const html = await render({ reason: "工具加载超时" });
    expect(html).toContain("工具加载超时");
    expect(html).not.toContain("te-hint");
    expect(html).not.toContain("te-detail");
  });
});
