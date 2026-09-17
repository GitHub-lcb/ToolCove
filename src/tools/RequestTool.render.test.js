// RequestTool 渲染冒烟：node 环境用 SSR 渲染默认状态（无桌面 IPC、无历史数据）。
// 目的：把整个模板跑一遍。之前标签栏那句 `v-for="t in tabs"` + `t('toolbox.request.loading')`
// 会在渲染期抛 TypeError，渲染直接中断——后面半个模板从来没被验证过，所以这里整体兜一遍：
// 后续任何一处绑定写错、动态拼的 i18n 键缺失，都会在这里暴露。
import { describe, it, expect, beforeAll, vi } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

let RequestTool;

beforeAll(async () => {
  // 组件 setup 里读了 window.__TAURI_INTERNALS__ / localStorage，node 环境先补上空壳再动态引入
  vi.stubGlobal("window", {
    __TAURI_INTERNALS__: undefined,
    location: { search: "" },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem() {}, removeItem() {} });
  RequestTool = (await import("./RequestTool.vue")).default;
});

async function render() {
  const app = createSSRApp({ render: () => h(RequestTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("RequestTool 渲染", () => {
  it("渲染出请求行、参数页签与发送按钮", async () => {
    const html = await render();
    for (const key of [
      "toolbox.request.send",
      "toolbox.request.params",
      "toolbox.request.newTab",
      "toolbox.request.noEnv",
      "toolbox.request.tipTitle",
    ]) {
      expect(html, key).toContain(t(key));
    }
    // Headers / Body 在模板里是字面量（HTTP 术语，两种语言都不译），这里只确认页签在
    expect(html).toContain("Headers");
    expect(html).toContain("Body");
  });

  it("默认标签栏与提示区都渲染出来，不是裸键也不是空壳", async () => {
    const html = await render();
    expect(html).toContain('class="req-tool"');
    expect(html).toContain('class="tab-bar"');
    // 标签栏的 title 走的是 t('toolbox.request.closeTab')，遮蔽 bug 就是在这里炸的
    expect(html).toContain(t("toolbox.request.closeTab"));
    expect(html).toContain(t("toolbox.request.tipTitle"));
  });

  it("cURL 占位文案按字面量渲染出花括号（不能被当成占位符吃掉）", async () => {
    const html = await render();
    // 转义后必须能编译出来；这里只要确认花括号还在，避免以后又被写成裸 {...} 而整块炸掉
    expect(t("toolbox.request.curlPh")).toContain("{...}");
  });
});
