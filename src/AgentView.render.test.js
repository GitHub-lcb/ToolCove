// AgentView 渲染冒烟：node 环境用 SSR 渲染，兜住视图层回归。
// 引擎逻辑已由 agent/*.test.js 覆盖，这里只保证三件事：
//   1) 组件导入期不崩（含 agent/session.js 的模块级依赖）；
//   2) 时间线、确认卡、技能库这些新增区块真的渲染出东西，且没有 undefined；
//   3) 词条缺失不会把 key 原文漏到界面上（i18nShadowing.test.js 只管遮蔽，不管缺键渲染）。
import { describe, it, expect, vi } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";

const state = vi.hoisted(() => ({ current: null }));
const spies = vi.hoisted(() => ({
  promoteRunToSkill: vi.fn(async () => ({ ok: true, skill: { name: "技能" }, updated: false })),
  setSkillEnabled: vi.fn(async () => ({})),
  deleteSkill: vi.fn(async () => true),
}));

vi.mock("./agent/session.js", () => ({
  // 用 getter 而不是直接赋 state.current：mock 工厂在模块加载期就求值，
  // 那时 current 还是 null，直接赋值会让组件 setup 阶段读到 null。
  get agentSession() {
    return state.current;
  },
  clearTimeline: vi.fn(),
  discardRun: vi.fn(),
  initAgentSession: vi.fn(async () => {}),
  resolvePending: vi.fn(() => true),
  resumeAgentRun: vi.fn(async () => true),
  startAgentRun: vi.fn(async () => true),
  stopAgentRun: vi.fn(() => true),
  setToolEnabled: vi.fn(async () => ({})),
  promoteRunToSkill: spies.promoteRunToSkill,
  setSkillEnabled: spies.setSkillEnabled,
  deleteSkill: spies.deleteSkill,
}));

import { i18n } from "./i18n/index.js";
import AgentView from "./AgentView.vue";

const t = (key, params) => i18n.global.t(key, params);

const skill = {
  id: "s1",
  name: "读取 order.json 导出 csv",
  description: "读取 order.json｜file.read_text → json.parse",
  instructions: "目标：读取 order.json\n- file.read_text → 12 项",
  keywords: ["order.json"],
  toolNames: ["file.read_text"],
  createdAt: 1000,
};

function session(over = {}) {
  return {
    ready: true,
    aiReady: true,
    status: "idle",
    goal: "",
    steps: [],
    answer: "",
    error: "",
    errorCode: "",
    runStatus: "",
    stopReason: "",
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 },
    currentRunId: "",
    runs: [],
    skills: [],
    cfg: { maxSteps: 12, retries: 1, requireConfirmation: "risky", disabledTools: [], disabledSkills: [] },
    pending: null,
    ...over,
  };
}

async function render(over = {}) {
  state.current = session(over);
  const app = createSSRApp({ render: () => h(AgentView, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

describe("AgentView 渲染", () => {
  it("空态渲染首屏与右栏能力清单", async () => {
    const html = await render();
    for (const key of ["agent.emptyTimeline", "agent.capTitle", "agent.history", "agent.capManual", "agent.capSkills"]) {
      expect(html, key).toContain(t(key));
    }
    expect(html).not.toContain("undefined");
  });

  it("时间线渲染工具卡、notice 与最终答复", async () => {
    const html = await render({
      runStatus: "completed",
      steps: [
        { type: "tool_start", id: "c1", tool: "file.read_text", args: { path: "a.txt" }, attempt: 1, ts: 1 },
        { type: "tool_result", id: "c1", tool: "file.read_text", result: { text: "hi" }, ts: 2 },
        { type: "tool_spill", tool: "db.query_readonly", key: "spill:db-query_readonly-ab12", chars: 90000, ts: 3 },
        { type: "final", answer: "完成", ts: 4 },
      ],
    });
    expect(html).toContain("file.read_text");
    expect(html).toContain("spill:db-query_readonly-ab12");
    expect(html).toContain("完成");
    // 折叠/落盘事件的说明来自带参数的词条，不该漏出 key 原文
    expect(html).not.toMatch(/agent\.[a-zA-Z]+\.[a-zA-Z]/);
  });

  it("确认卡渲染写前预览的 diff 行与节选说明", async () => {    const html = await render({
      status: "waiting",
      pending: {
        kind: "tool",
        callId: "c1",
        tool: "file.write_text",
        risk: "write",
        question: "",
        args: { path: "a.txt", text: "new" },
        preview: {
          path: "a.txt",
          isNew: false,
          before: "old",
          after: "new",
          diff: {
            hasChanges: true,
            stats: { added: 1, removed: 1, modified: 1, unchanged: 0 },
            rows: [
              { type: "removed", left: { number: 1, text: "old" }, right: null },
              { type: "added", left: null, right: { number: 1, text: "new" } },
            ],
          },
        },
      },
    });
    expect(html).toContain(t("agent.previewTitle"));
    expect(html).toContain("a.txt");
    expect(html).toContain("old");
    expect(html).toContain("new");
    expect(html).toContain(t("agent.confirmAllow"));
  });

  it("预览的行文本与语义底色真的渲染出来（不是只有标题）", async () => {
    // 用户实测场景：目标文件是 0 字节，写入单行内容 → 应显示一行「新增」
    const html = await render({
      status: "waiting",
      pending: {
        kind: "tool",
        callId: "c1",
        tool: "file.write_text",
        risk: "write",
        question: "",
        args: { path: "1.txt", text: "1231314" },
        preview: {
          path: "C:\\Users\\x\\Downloads\\test\\1.txt",
          isNew: false,
          before: "",
          after: "1231314",
          diff: {
            hasChanges: true,
            stats: { added: 1, removed: 0, modified: 0, unchanged: 0 },
            rows: [{ type: "added", left: null, right: { number: 1, text: "1231314" } }],
          },
        },
      },
    });
    expect(html).toContain("1231314");
    expect(html).toContain("pv-added"); // 新增行的底色
    expect(html).toContain("+1 / -0");
  });

  it("单行替换算 modified：diff 行有内容时计数不该显示成 +0 / -0", async () => {
    // 用户实测场景：文件里已有 "1231314"，改写成 "12342532" —— textDiff 判为 modified
    const html = await render({
      status: "waiting",
      pending: {
        kind: "tool",
        callId: "c1",
        tool: "file.write_text",
        risk: "write",
        question: "",
        args: { path: "1.txt", text: "12342532" },
        preview: {
          path: "1.txt",
          isNew: false,
          before: "1231314",
          after: "12342532",
          diff: {
            hasChanges: true,
            stats: { added: 0, removed: 0, modified: 1, unchanged: 0 },
            rows: [{ type: "modified", left: { number: 1, text: "1231314" }, right: { number: 1, text: "12342532" } }],
          },
        },
      },
    });
    expect(html).toContain("12342532");
    expect(html).toContain("pv-changed");
    // 改动确实是 1 处，不能显示成「0 增 0 删」让人以为没改动
    expect(html).toContain("+0 / -0");
    expect(html).toContain("修改 1");
  });

  it("提问卡渲染输入框而不是允许/拒绝（ask_user 要的是文本答案）", async () => {
    const html = await render({
      status: "waiting",
      pending: { kind: "ask", callId: "", tool: "", risk: "", question: "请提供两个文件的绝对路径", args: null, preview: null },
    });
    expect(html).toContain("请提供两个文件的绝对路径");
    expect(html).toContain(t("agent.answerSend"));
    expect(html).toContain(t("agent.answerSkip"));
    expect(html).toContain(t("agent.answerPlaceholder"));
    expect(html).toContain("textarea");
    // 关键回归：提问卡上不该有「允许 / 拒绝」两个按钮。
    // 只看按钮而不看整页——右栏能力清单里的「读取」等风险标签也含「取」等字，整页断言会误报。
    expect(html).not.toContain(`>${t("agent.confirmAllow")}<`);
    expect(html).not.toContain(`>${t("agent.confirmDeny")}<`);
  });

  it("运行成功后给出「沉淀为技能」入口", async () => {    const html = await render({ runStatus: "completed", currentRunId: "run-1", steps: [{ type: "final", answer: "完成", ts: 1 }] });
    expect(html).toContain(t("agent.skillPromote"));
  });

  it("技能库折叠时只显示条数（不把正文塞进首屏）", async () => {
    const html = await render({ skills: [skill] });
    expect(html).toContain(t("agent.capSkills"));
    expect(html).toContain("1");
    expect(html).not.toContain(skill.instructions);
  });
});
