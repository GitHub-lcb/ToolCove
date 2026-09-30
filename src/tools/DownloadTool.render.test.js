// DownloadTool 渲染冒烟：node 环境用 SSR 渲染默认（空队列）状态。
// 下载的分片计划、进度/速度/ETA 格式化与队列推进已由 downloader.test.js 覆盖，
// 这里只兜住视图层回归：模板绑定写错（渲染出 undefined/空）、词条缺失（渲染出原文 key）、
// 组件导入期崩溃。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import DownloadTool from "./DownloadTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(DownloadTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("DownloadTool 渲染", () => {
  it("空队列下渲染地址输入、保存目录、线程数与空态", async () => {
    const html = await render();
    for (const key of [
      "toolbox.downloader.addTitle",
      "toolbox.downloader.urlLabel",
      "toolbox.downloader.dirLabel",
      "toolbox.downloader.connsLabel",
      "toolbox.downloader.addBtn",
      "toolbox.downloader.queueTitle",
      "toolbox.downloader.emptyTitle",
    ]) {
      expect(html, key).toContain(t(key));
    }
    // 保存位置还没选时必须明确提示，而不是静默允许提交
    expect(html).toContain(t("toolbox.downloader.dirEmpty"));
  });

  it("不把未解析的词条 key 直接渲染到界面上", async () => {
    const html = await render();
    expect(html).not.toMatch(/toolbox\.downloader\.[A-Za-z]/);
    expect(html).not.toContain("undefined");
  });
});
