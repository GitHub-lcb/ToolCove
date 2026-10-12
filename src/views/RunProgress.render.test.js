// RunProgress 的渲染守卫。
//
// 这条用例守的是三件容易悄悄坏掉的事：
//   1. 五种运行状态各自映射到正确的语义色类（跨页面一致的色彩语言）；
//   2. 「当前工具」只在进行中显示——已结束后还挂着上一个工具名会误导人；
//   3. 步数上限为 0（未配置）时不画进度条，而不是画一条 0% 的空槽。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import RunProgress from "./RunProgress.vue";

async function renderIt(props) {
  const app = createSSRApp({ render: () => h(RunProgress, props) });
  app.use(i18n);
  return renderToString(app);
}

const step = (type, tool = "json.parse") => ({ type, tool, ts: Date.now() });

describe("RunProgress", () => {
  it("运行中/等待/完成/失败各映射到自己的语义态", async () => {
    expect(await renderIt({ status: "running" })).toContain("rp--run");
    expect(await renderIt({ status: "waiting" })).toContain("rp--wait");
    expect(await renderIt({ status: "completed" })).toContain("rp--done");
    expect(await renderIt({ status: "failed" })).toContain("rp--fail");
    expect(await renderIt({ status: "" })).toContain("rp--idle");
  });

  it("只数 tool_start，重试不重复计数", async () => {
    const steps = [step("tool_start", "json.parse"), step("tool_error"), step("tool_start", "json.parse")];
    const html = await renderIt({ steps, status: "running" });
    expect(html).toContain("2 步");
  });

  it("有失败步骤时才显示失败计数", async () => {
    const ok = await renderIt({ steps: [step("tool_start")], status: "running" });
    expect(ok).not.toContain("rp-fail");
    const bad = await renderIt({ steps: [step("tool_start"), step("tool_error")], status: "failed" });
    expect(bad).toContain("rp-fail");
  });

  it("进行中才显示当前工具；结束后不再挂着上一个工具名", async () => {
    const running = await renderIt({ status: "running", currentTool: "file.read_text" });
    expect(running).toContain("file.read_text");
    const done = await renderIt({ status: "completed", currentTool: "file.read_text" });
    expect(done).not.toContain("file.read_text");
  });

  it("步数上限为 0 时不画进度条（未配置 maxSteps 的场合）", async () => {
    const html = await renderIt({ status: "running", maxSteps: 0 });
    expect(html).not.toContain("rp-track");
  });

  it("配置了上限才画进度条，且宽度按步数收敛", async () => {
    const html = await renderIt({ steps: [step("tool_start")], status: "running", maxSteps: 4 });
    expect(html).toContain("rp-track");
    expect(html).toContain("width:25%");
  });
});