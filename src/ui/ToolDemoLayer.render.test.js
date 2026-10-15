// 演示层渲染冒烟：不播动画、只验「该出现的都在，不该出现的不在」。
// 最关键的一条是**手动打开工具时整层不渲染**——否则用户自己点开工具也会看到
// 「AI 打开了这个工具」的横幅，那是明显的假话。
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { describe, expect, it } from "vitest";
import { i18n } from "../i18n/index.js";
import ToolDemoLayer from "./ToolDemoLayer.vue";

const t = (key, params) => i18n.global.t(key, params);
const visible = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

const script = [
  { anchor: "input", action: "fill", value: "name,city", captionKey: "toolbox.demo.fillInput" },
  { anchor: "output", action: "reveal", value: null, captionKey: "toolbox.demo.showOutput" },
];

async function render(state) {
  const app = createSSRApp({ render: () => h(ToolDemoLayer, { state }) });
  app.use(i18n);
  return visible(await renderToString(app));
}

const base = { active: false, done: false, skipped: false, index: 0, total: 2, captionKey: "", captionValue: null, script, runId: "r1" };

describe("工具演示层", () => {
  it("手动打开工具（未激活）时整层不出现——不能对用户说假话", async () => {
    expect(await render(base)).not.toContain("data-role=\"tool-demo\"");
  });

  it("播放中：说明来源、当前字幕、值片段、进度点与跳过按钮都在", async () => {
    const html = await render({ ...base, active: true, captionKey: "toolbox.demo.fillInput", captionValue: "name,city" });
    expect(html).toContain('data-role="tool-demo"');
    expect(html).toContain(t("toolbox.demo.openedByAgent"));
    expect(html).toContain(t("toolbox.demo.fillInput"));
    expect(html).toContain("name,city");
    expect(html).toContain('data-role="demo-skip"');
    // 进度点数量 = 步骤数（用户据此知道还要看几步）
    expect((html.match(/<i /g) || []).length).toBe(2);
  });

  it("结束后：给结论、给复现步骤、把「跳过」换成「重播」", async () => {
    const html = await render({ ...base, active: true, done: true, index: 1 });
    expect(html).toContain(t("toolbox.demo.done"));
    expect(html).toContain(t("toolbox.demo.stepsTitle"));
    expect(html).toContain('data-role="demo-replay"');
    expect(html).not.toContain('data-role="demo-skip"');
    // 复现步骤的第 1 步带上了那次调用真实用的值
    expect(html).toContain("name,city");
  });

  it("被跳过时如实说跳过，不谎称演完了", async () => {
    const html = await render({ ...base, active: true, done: true, skipped: true, index: 0 });
    expect(html).toContain(t("toolbox.demo.skipped"));
    expect(html).not.toContain(t("toolbox.demo.done"));
  });

  it("e2e 依赖的钩子都在", async () => {
    const html = await render({ ...base, active: true, done: true, index: 1 });
    for (const role of ["tool-demo", "demo-origin", "demo-dots", "demo-caption", "demo-replay", "demo-steps"]) {
      expect(html, `缺少 data-role="${role}"`).toContain(`data-role="${role}"`);
    }
  });
});
