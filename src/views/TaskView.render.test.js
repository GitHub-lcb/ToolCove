// TaskView 渲染冒烟：node 环境用 SSR 渲染（onMounted 里的加载不会跑，但能兜住导入期崩溃与模板缺键）。
// 定时生成设置行本身在报告弹窗内（默认关闭），由 WeeklySchedulePanel.render.test.js 单独覆盖。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import TaskView from "./TaskView.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(TaskView, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("TaskView 渲染", () => {
  it("首屏渲染成功，核心区块都在", async () => {
    const html = await render();
    expect(html).toContain("hm-card");
    expect(html).toContain(t("task.monthTrendTitle"));
    expect(html.length).toBeGreaterThan(200);
  });

  it("不把未注册的 i18n 键原文漏到界面上", async () => {
    const html = await render();
    expect(html).not.toMatch(/task\.[A-Za-z]/);
    expect(html).not.toContain("undefined");
  });
});
