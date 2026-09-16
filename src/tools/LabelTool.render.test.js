// LabelTool 渲染冒烟：node 环境用 SSR 渲染默认状态（无打印机、未连桌面）。
// 排版/TSPL 逻辑由 labelTool.test.js 与 Rust 单测覆盖，这里只兜住视图层回归：
// 模板绑定写错（渲染出 undefined/NaN）、动态拼的 i18n 键缺失（渲染出原文 key）、组件导入期崩溃。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import LabelTool from "./LabelTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(LabelTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("LabelTool 渲染", () => {
  it("渲染出内容、条码、二维码、纸张、预览与动作区", async () => {
    const html = await render();
    for (const key of [
      "toolbox.label.textTitle",
      "toolbox.label.barcodeTitle",
      "toolbox.label.qrTitle",
      "toolbox.label.paperTitle",
      "toolbox.label.previewTitle",
      "toolbox.label.issuesTitle",
      "toolbox.label.tsplTitle",
      "toolbox.label.exportPrn",
      "toolbox.label.printBtn",
      "toolbox.label.copies",
    ]) {
      expect(html, key).toContain(t(key));
    }
    expect(html).toContain('class="bench"');
    expect(html).toContain("<canvas");
  });

  it("动态拼接的选项词条都能解析（不是裸键或空值）", async () => {
    const html = await render();
    for (const key of [
      "toolbox.label.align_left",
      "toolbox.label.align_right",
      "toolbox.label.valign_bottom",
      "toolbox.label.sym_code128",
      "toolbox.label.sym_codabar",
      "toolbox.label.ecc_l",
      "toolbox.label.ecc_h",
      "toolbox.label.media_gap",
      "toolbox.label.media_continuous",
      "toolbox.label.fontChinese24",
      "toolbox.label.fontAscii5",
    ]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("不把未解析的词条 key 或脏值渲染到界面上", async () => {
    const html = await render();
    expect(html).not.toMatch(/toolbox\.label\.[A-Za-z]/);
    expect(html).not.toContain("undefined");
    expect(html).not.toContain("NaN");
  });

  it("没有打印机时说明当前状态，并提示仍未选择打印机", async () => {
    const html = await render();
    expect(html).toContain(t("toolbox.label.printerEmpty"));
    expect(html).toContain(t("toolbox.label.statusNoPrinter"));
  });

  it("默认纸张是 50×30mm / 203dpi，默认字体是中文点阵", async () => {
    const html = await render();
    expect(html).toContain("50 × 30 mm");
    expect(html).toContain("203 dpi");
    expect(html).toContain(t("toolbox.label.fontChinese24"));
  });
});
