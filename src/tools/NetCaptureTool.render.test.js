// NetCaptureTool 的渲染冒烟（node 环境 → SSR 渲染，够不到 onMounted 里的加载状态）。
// 抓包逻辑本身由 src/tools/netcapture/*.test.js 与 scripts/verify-netcapture.mjs 兜着，
// 这里只盯两件事：首屏该有的文案都在；任何未注册的 i18n 键都不裸露成 netcapture.xxx，
// 否则界面会把键名直接显示给用户。
import { describe, expect, it } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import NetCaptureTool from "./NetCaptureTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(NetCaptureTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("NetCaptureTool 渲染", () => {
  it("首屏文案齐全：连接区、操作按钮、空态提示", async () => {
    const html = await render();
    for (const key of [
      "netcapture.title",
      "netcapture.subtitle",
      "netcapture.port",
      "netcapture.exePath",
      "netcapture.probe",
      "netcapture.launch",
      "netcapture.start",
      "netcapture.clear",
      "netcapture.empty",
    ]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("把「必须重启目标应用」这个使用前提摆在明面上", async () => {
    const html = await render();
    // 这是本工具唯一的使用前提。不说清楚，用户会一直以为能直接附加到已运行的程序上
    expect(html).toContain(t("netcapture.whyTitle"));
    expect(html).toContain(t("netcapture.why1"));
  });

  it("说清楚凭据拿不到这件事，而不是让用户以为配置能一键生成", async () => {
    const html = await render();
    expect(html).toContain(t("netcapture.why3"));
  });

  it("不渲染任何未注册的 i18n 键", async () => {
    const html = await render();
    expect(html).not.toMatch(/netcapture\.[A-Za-z]/);
  });

  it("不出现 undefined / null 之类的占位", async () => {
    const html = await render();
    expect(html).not.toContain("undefined");
    expect(html).not.toContain(">null<");
    expect(html).not.toContain("NaN");
  });

  it("抓包没开始时状态区给的是可操作的下一步，不是空白", async () => {
    const html = await render();
    expect(html).toContain(t("netcapture.idle"));
  });
});
