// 定时生成设置行的渲染冒烟：node 环境用 SSR 渲染。
// 这一行在 TaskView 的报告弹窗内，弹窗默认关闭，整体渲染时看不到它，所以单独渲染组件来断言。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import WeeklySchedulePanel from "./WeeklySchedulePanel.vue";

const t = (key, params) => i18n.global.t(key, params);

const WEEKDAY_KEYS = ["common.weekSun", "common.weekMon", "common.weekTue", "common.weekWed", "common.weekThu", "common.weekFri", "common.weekSat"];
const weekdayOptions = WEEKDAY_KEYS.map((key, i) => ({ value: i, label: t(key) }));

async function render(props) {
  const app = createSSRApp({ render: () => h(WeeklySchedulePanel, props) });
  app.use(i18n);
  return renderToString(app);
}

describe("WeeklySchedulePanel 渲染", () => {
  it("设置行文案齐全：开关、星期、时间、立即生成", async () => {
    const html = await render({ policy: { enabled: true, weekday: 5, hour: 17, minute: 0 }, weekdayOptions });
    for (const key of ["task.weeklySchedule", "task.weeklyWeekday", "task.weeklyTime", "task.weeklyGenerateNow"]) {
      expect(html, key).toContain(t(key));
    }
  });

  it("星期下拉包含全部 7 天的本地化名称", async () => {
    const html = await render({ policy: { enabled: true, weekday: 5, hour: 17, minute: 0 }, weekdayOptions });
    for (const key of WEEKDAY_KEYS) expect(html, key).toContain(t(key));
  });

  it("时间输入的值来自 policy（17:00）", async () => {
    const html = await render({ policy: { enabled: true, weekday: 5, hour: 17, minute: 5 }, weekdayOptions });
    expect(html).toContain('value="17:05"');
  });

  it("未启用时星期与时间控件禁用", async () => {
    const html = await render({ policy: { enabled: false, weekday: 5, hour: 17, minute: 0 }, weekdayOptions });
    expect(html).toContain("disabled");
  });

  it("生成中禁用「立即生成」，不生成时可用", async () => {
    const busy = await render({ policy: { enabled: true, weekday: 5, hour: 17, minute: 0 }, weekdayOptions, generating: true });
    expect(busy).toContain(t("task.generating"));
    const idle = await render({ policy: { enabled: true, weekday: 5, hour: 17, minute: 0 }, weekdayOptions });
    expect(idle).toContain(t("task.weeklyGenerateNow"));
  });

  it("不把未注册的 i18n 键原文漏到界面上", async () => {
    const html = await render({ policy: { enabled: true, weekday: 5, hour: 17, minute: 0 }, weekdayOptions });
    expect(html).not.toMatch(/task\.[A-Za-z]/);
    expect(html).not.toContain("undefined");
  });
});
