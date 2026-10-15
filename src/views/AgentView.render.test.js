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

vi.mock("../agent/session.js", () => ({
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

// 假领域数据：AgentView 的 onServerPrefetch 会真的调用 repository.load，
// SSR 渲染时能把它喂进域选择器——否则（真实运行时才跑的 onMounted）在 node 环境读不到数据。
vi.mock("../data/repository.js", () => ({
  load: vi.fn(async (kind) =>
    kind === "domains"
      ? [
          { id: "d1", name: "云仓" },
          { id: "d2", name: "云集" },
        ]
      : [
          { id: "p1", domainId: "d1", name: "wms.api" },
          { id: "p2", domainId: "d1", name: "wms.ui" },
        ]
  ),
  create: vi.fn(async () => ({ id: "rec-1" })),
}));

import { i18n } from "../i18n/index.js";
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
    contextDomain: "",
    pending: null,
    ...over,
  };
}

async function render(over = {}, props = {}) {
  state.current = session(over);
  const app = createSSRApp({ render: () => h(AgentView, { showToast: () => {}, ...props }) });
  app.use(i18n);
  return renderToString(app);
}

describe("AgentView 渲染", () => {
  it("空态渲染任务导向的标语与示例，且不再有常驻能力清单", async () => {
    const html = await render();
    for (const key of ["agent.emptySlogan", "agent.emptyHint", "agent.example1", "agent.example2", "agent.example3"]) {
      expect(html, key).toContain(t(key));
    }
    expect(html).not.toContain("undefined");
    // 工具目录已搬进设置页：对话主区不该再出现「手动工具箱 / 技能库」这类配置块
    expect(html).not.toContain(t("agent.capManual"));
    expect(html).not.toContain(t("agent.capSkills"));
  });

  it("骨架是「消息流 + 底部输入框」：输入框在文档流末尾，任务监控默认不出现", async () => {
    const html = await render();
    expect(html).toContain("canvas");
    expect(html).toContain("composer");
    // 空态与输入框同在，但输入框（composer）必须排在空态之后——这是「输入框钉底部」的结构证据
    expect(html.indexOf("composer")).toBeGreaterThan(html.indexOf("canvas-empty"));
    // 空闲且无产物时右侧监控面板整块不渲染（条件出现）
    expect(html).not.toContain('class="monitor"');
    // 二期的会话列表已上移应用侧边栏，主区不该再有那一栏。
    // 断言 class 而不是裸词 "sessions"：SSR 会把模板注释一起输出，
    // 注释里提一句 "VS Code Chat view 的 sessions/对话/输入三段" 就会把裸词断言打成假红。
    expect(html).not.toContain('class="sessions"');
  });

  it("用户的目标作为「我说的那句话」进入消息流首条", async () => {
    const html = await render({
      runStatus: "completed",
      goal: "合并两个 PDF 文件",
      steps: [{ type: "final", answer: "完成", ts: 1 }],
    });
    expect(html).toContain("msg-user");
    expect(html).toContain(t("agent.you"));
    expect(html).toContain("合并两个 PDF 文件");
    // 有步骤时空态消失（两者互斥）
    expect(html).not.toContain("canvas-empty");
  });

  it("进入终态且无产物时任务监控仍不出现（它是运行态面板，不是常驻配置栏）", async () => {
    const html = await render({
      runStatus: "completed",
      goal: "合并两个 PDF",
      steps: [{ type: "final", answer: "完成", ts: 1 }],
    });
    expect(html).not.toContain('class="monitor"');
  });

  it("历史任务回看：横幅 + 该 run 的 steps 时间线，目标输入框隐藏", async () => {
    const html = await render(
      {
        runs: [
          {
            id: "r1",
            input: "合并两个 PDF 文件",
            status: "completed",
            steps: [
              { type: "tool_start", id: "c1", tool: "pdf.merge", args: { paths: ["a.pdf", "b.pdf"] }, attempt: 1, ts: 1 },
              { type: "tool_result", id: "c1", tool: "pdf.merge", result: { output: "/tmp/out/m.pdf" }, ts: 2 },
              { type: "final", answer: "历史答案", ts: 3 },
            ],
            usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 1 },
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
      { jumpId: { module: "agent", tab: null, action: "view", runId: "r1", ts: 1 } }
    );
    // 回看横幅（文案 + 目标摘要 + 返回/续跑/重跑入口）
    expect(html).toContain("view-banner");
    expect(html).toContain(t("agent.viewingHistory"));
    expect(html).toContain(t("agent.backToCurrent"));
    expect(html).toContain("合并两个 PDF 文件");
    // 画布渲染的是历史 run 的 steps（只读）：工具卡与最终答案都在
    expect(html).toContain("pdf.merge");
    expect(html).toContain("历史答案");
    // 回看模式隐藏目标输入框，避免误以为在编辑历史
    expect(html).not.toContain("goal-box");
    // 历史终态也出交付清单（数据源参数化后吃该 run 的快照）
    expect(html).toContain("sum-card");
    // 词条缺失不该漏出 key 原文
    expect(html).not.toMatch(/agent\.[a-zA-Z]+\.[a-zA-Z]/);
  });

  it("jump 指向不存在的 run：忽略深链，退回实时画布", async () => {
    const html = await render({}, { jumpId: { module: "agent", tab: null, action: "view", runId: "ghost", ts: 1 } });
    expect(html).not.toContain("view-banner");
    expect(html).toContain("goal-box");
  });

  it("终态渲染交付清单：状态 chip、工具统计、产物 chip（在工具中打开）", async () => {
    const html = await render({
      runStatus: "completed",
      goal: "合并两个 PDF",
      steps: [
        { type: "tool_start", id: "c1", tool: "pdf.merge", args: { paths: ["a.pdf", "b.pdf"], output: "/tmp/out/merged.pdf" }, attempt: 1, ts: 1 },
        { type: "tool_result", id: "c1", tool: "pdf.merge", result: { output: "/tmp/out/merged.pdf", files: 2, bytes: 1024 }, ts: 2 },
        { type: "final", answer: "完成", ts: 3 },
      ],
    });
    expect(html).toContain("sum-card");
    expect(html).toContain(t("agent.summaryTitle"));
    expect(html).toContain(t("agent.summaryTools"));
    expect(html).toContain("pdf.merge");
    expect(html).toContain("merged.pdf"); // 产物 chip（basename）
    expect(html).toContain(t("agent.openInTool"));
    // 词条缺失不该漏出 key 原文
    expect(html).not.toMatch(/agent\.[a-zA-Z]+\.[a-zA-Z]/);
  });

  it("非终态不渲染交付清单", async () => {
    const html = await render({ steps: [{ type: "final", answer: "完成", ts: 1 }] });
    expect(html).not.toContain("sum-card");
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

  it("技能库不在对话主区（正文不会漏进首屏）", async () => {
    const html = await render({ skills: [skill] });
    // 技能库整块已搬进「设置 → Agent」：主区既不显示条数，更不该把正文塞进首屏
    expect(html).not.toContain(t("agent.capSkills"));
    expect(html).not.toContain(skill.instructions);
    expect(html).not.toContain(skill.description);
  });

  it("最终答复卡给出「存为速记 / 存为问题」写回入口（知识沉淀）", async () => {
    const html = await render({ runStatus: "completed", currentRunId: "run-1", steps: [{ type: "final", answer: "导出成功", ts: 1 }] });
    expect(html).toContain(t("agent.saveToSnippet"));
    expect(html).toContain(t("agent.saveToProblem"));
    // 文案保持动词原样：不该暗示一种不存在的「已保存」状态
    expect(html).not.toContain(t("agent.savedSnippet"));
    expect(html).not.toContain(t("agent.savedProblem"));
  });

  it("域选择器：有领域时渲染下拉与「不指定」，选中后显示上下文预览", async () => {
    const html = await render({ contextDomain: "d1" });
    expect(html).toContain(t("agent.domain"));
    expect(html).toContain(t("agent.domainNone"));
    expect(html).toContain("云仓");
    // 预览行走带 {name,n} 参数的词条（n = 该领域代码池数，这里 d1 有 2 个）
    expect(html).toContain(t("agent.domainContext", { name: "云仓", n: 2 }));
    expect(html).toContain(t("agent.domainClear"));
  });

  it("未选域时不显示上下文预览（默认零变化的界面侧）", async () => {
    const html = await render();
    expect(html).toContain(t("agent.domainNone"));
    expect(html).not.toContain(t("agent.domainContext", { name: "云仓", n: 2 }));
  });

  it("回看历史时域选择器随之隐藏（它在目标输入卡内，历史只读）", async () => {
    const html = await render(
      {
        runs: [
          {
            id: "r1",
            input: "历史任务",
            status: "completed",
            steps: [{ type: "final", answer: "历史答案", ts: 1 }],
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      },
      { jumpId: { module: "agent", action: "view", runId: "r1", ts: 1 } }
    );
    expect(html).not.toContain(t("agent.domainNone"));
  });
});
