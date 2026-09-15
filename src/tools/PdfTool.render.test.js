// PdfTool 渲染冒烟：node 环境用 SSR 渲染默认（合并）模式。
// PDF 的字节逻辑已由 pdfTool.test.js 覆盖，这里只兜住视图层回归：
// 模板绑定写错（渲染出 undefined/空）、词条缺失（渲染出原文 key）、组件导入期崩溃。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import PdfTool from "./PdfTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(PdfTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("PdfTool 渲染", () => {
  it("默认进入合并模式并渲染模式切换、空态与主操作", async () => {
    const html = await render();
    for (const key of ["toolbox.pdf.modeMerge", "toolbox.pdf.modePages", "toolbox.pdf.modeSplit", "toolbox.pdf.addFiles", "toolbox.pdf.mergeAction", "toolbox.pdf.mergeEmptyTitle", "toolbox.pdf.mergeEmptyHint"]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("不把未解析的词条 key 直接渲染到界面上", async () => {
    const html = await render();
    expect(html).not.toMatch(/toolbox\.pdf\.[A-Za-z]/);
    expect(html).not.toContain("undefined");
  });
});
