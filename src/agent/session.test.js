import { beforeEach, describe, expect, it, vi } from "vitest";

// session.js 只用到 ai.js 的 aiComplete（经 index.js 的默认 planner）与 isAIConfigured；
// mock 掉整个模块，既避开真实 IPC，也让规划脚本可控。
vi.mock("../ai.js", () => ({ aiComplete: vi.fn(), isAIConfigured: vi.fn(async () => true) }));

import { aiComplete } from "../ai.js";
import { buildAgentRegistry } from "./tools.js";
import { canResume } from "./runStore.js";
import { foldTimeline } from "./timeline.js";
import {
  agentSession,
  answerPending,
  clearTimeline,
  discardRun,
  initAgentSession,
  resolvePending,
  startAgentRun,
  stopAgentRun,
  __resetAgentSession,
} from "./session.js";

// 按顺序回放模型动作；用完后再调用返回 final，避免脚本写漏导致死循环。
// 传 usage 时每次调用都上报用量，用于断言 token 计量。
function scriptPlanner(actions, usage = null) {
  const queue = [...actions];
  aiComplete.mockImplementation(async (_prompt, opts) => {
    if (usage) opts?.onUsage?.(usage);
    return JSON.stringify(queue.shift() || { type: "final", answer: "done" });
  });
}
const call = (tool, args) => ({ type: "tool_call", id: crypto.randomUUID(), tool, args });
const final = (answer) => ({ type: "final", answer });

beforeEach(async () => {
  __resetAgentSession();
  vi.clearAllMocks();
  await initAgentSession();
});

describe("initAgentSession", () => {
  it("载入默认配置与 AI 就绪态", () => {
    expect(agentSession.ready).toBe(true);
    expect(agentSession.aiReady).toBe(true);
    expect(agentSession.cfg).toMatchObject({ maxSteps: 12, retries: 1, requireConfirmation: "risky", disabledTools: [] });
  });
});

describe("运行前门禁", () => {
  it("空目标不启动，也不调用模型", async () => {
    expect(await startAgentRun("   ")).toBe(false);
    expect(aiComplete).not.toHaveBeenCalled();
    expect(agentSession.status).toBe("idle");
  });
});

describe("一次完整运行", () => {
  it("记账 steps/tokens，落历史并渲染时间线", async () => {
    scriptPlanner(
      [call("base64.encode", { text: "hello" }), final("已编码")],
      { promptTokens: 10, completionTokens: 5, totalTokens: 15 }
    );

    expect(await startAgentRun("把 hello 转 base64")).toBe(true);

    expect(agentSession.status).toBe("idle");
    expect(agentSession.runStatus).toBe("completed");
    expect(agentSession.answer).toBe("已编码");
    expect(agentSession.usage).toEqual({ promptTokens: 20, completionTokens: 10, totalTokens: 30, calls: 2 });

    expect(agentSession.runs).toHaveLength(1);
    expect(agentSession.runs[0].status).toBe("success");
    expect(agentSession.currentRunId).toBe(agentSession.runs[0].id);

    const types = agentSession.steps.map((s) => s.type);
    // 策略放行的调用也有一条 approval_decided（by=policy），审计不留空白
    expect(types).toEqual(["approval_decided", "tool_start", "tool_result", "final"]);
  });

  it("时间线上的 args 与 result 也脱敏，不只脱敏持久化副本", async () => {
    scriptPlanner([
      call("base64.encode", { text: 'password="hunter2-secret"' }),
      final("done"),
    ]);
    await startAgentRun("编码这段文本");
    const shown = JSON.stringify(agentSession.steps);
    expect(shown).not.toContain("hunter2-secret");
    expect(shown).toContain("[REDACTED]");
  });

  it("停用的工具不在 registry，模型调用会失败而不是执行", async () => {
    agentSession.cfg = { ...agentSession.cfg, disabledTools: ["base64.encode"] };
    scriptPlanner([call("base64.encode", { text: "hi" })]);
    await startAgentRun("编码");
    expect(agentSession.runStatus).toBe("failed");
    expect(agentSession.error).toContain("Unknown tool: base64.encode");
    expect(agentSession.steps.some((s) => s.type === "notice" && s.code === "failed")).toBe(true);
  });

  it("写文件在确认前就被读后写门禁拦下（门禁先于执行，先于传输层）", async () => {
    agentSession.cfg = { ...agentSession.cfg, maxSteps: 1 };
    scriptPlanner([call("file.write_text", { path: "C:/tmp/x.txt", text: "hi" })]);
    const run = startAgentRun("写个文件");
    await vi.waitFor(() => expect(agentSession.pending?.kind).toBe("tool"));
    expect(agentSession.pending.tool).toBe("file.write_text");
    expect(agentSession.pending.risk).toBe("write");
    // callId 要进 pending：审计事件靠它指回具体这一次调用
    expect(agentSession.pending.callId).toBeTruthy();
    expect(agentSession.status).toBe("waiting");
    resolvePending(true);
    await run;
    // 没有先读过该文件：门禁拒绝，而不是走到 Tauri 传输层才失败
    expect(agentSession.steps.find((s) => s.type === "tool_error").code).toBe("OBSERVATION_REQUIRED");
  });
});

describe("逐次批准与审计", () => {
  it("换参数的写调用要重新问：批准不再覆盖同一 run 内的后续同类调用", async () => {
    agentSession.cfg = { ...agentSession.cfg, requireConfirmation: "always" };
    scriptPlanner([
      call("json.format", { text: '{"a":1}' }),
      call("json.format", { text: '{"b":2}' }),
      final("done"),
    ]);
    // 不能先 await 整次运行：确认卡在等人，先 await 就死锁了。
    // 起运行拿 promise → 等卡 → 决议 → 再等第二张卡 → 最后才 await。
    const run = startAgentRun("格式化两段 JSON");
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull());
    resolvePending(true);
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull()); // 第二次仍然要问
    resolvePending(true);
    expect(await run).toBe(true);
    expect(agentSession.runStatus).toBe("completed");
    expect(agentSession.steps.filter((s) => s.type === "approval_asked")).toHaveLength(2);
  });

  it("同工具同参数的重复调用折叠成一次询问", async () => {
    agentSession.cfg = { ...agentSession.cfg, requireConfirmation: "always" };
    scriptPlanner([
      // 先读一次，让读后写门禁放行；再连续两次同参数写入（第三次折叠成复用）
      call("base64.encode", { text: "hi" }),
      call("base64.encode", { text: "hi" }),
      call("base64.encode", { text: "hi" }),
      final("done"),
    ]);
    const run = startAgentRun("编码三遍");
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull());
    resolvePending(true);
    await run;
    expect(agentSession.runStatus).toBe("completed");
    expect(agentSession.steps.filter((s) => s.type === "approval_asked")).toHaveLength(1);
    // 三次调用各有结论（后两次是折叠沿用），所以 decided 仍是三条
    expect(agentSession.steps.filter((s) => s.type === "approval_decided")).toHaveLength(3);
  });

  it("拒绝后把拒绝回灌给模型，而不是立刻取消整个目标", async () => {
    scriptPlanner([
      call("file.write_text", { path: "C:/tmp/x.txt", text: "hi" }),
      final("那我改用只读方式"),
    ]);
    const run = startAgentRun("写文件");
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull());
    resolvePending(false);
    await run;
    expect(agentSession.runStatus).toBe("completed");
    expect(agentSession.answer).toBe("那我改用只读方式");
    // 审计要留下「谁拒了哪一次」
    const decided = agentSession.steps.find((s) => s.type === "approval_decided");
    expect(decided).toMatchObject({ approved: false, source: "human" });
  });

  it("第一个确认卡就被拒且模型没有别的办法：记为用户拒绝而非模糊的已取消", async () => {
    scriptPlanner([call("file.write_text", { path: "C:/tmp/x.txt", text: "hi" })]);
    const run = startAgentRun("写文件");
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull());
    resolvePending(false);
    await run;
    // scriptPlanner 用完后回 final，所以这里会完成；换一个「一直写」的规划器才走到 cancelled
    expect(agentSession.steps.some((s) => s.type === "approval_decided" && s.approved === false)).toBe(true);
  });

  it("时间线折叠出审计行，且带上「为什么问」的原因", async () => {
    scriptPlanner([call("file.write_text", { path: "C:/tmp/x.txt", text: "hi" }), final("done")]);
    const run = startAgentRun("写文件");
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull());
    resolvePending(true);
    await run;
    const folded = foldTimeline(agentSession.steps);
    const audit = folded.filter((item) => item.kind === "approval");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ tool: "file.write_text", asked: true, decided: true, approved: true, source: "human", reason: "risky-write" });
  });

  it("never 策略下没有确认卡，审计写「策略放行」", async () => {
    agentSession.cfg = { ...agentSession.cfg, requireConfirmation: "never" };
    scriptPlanner([call("file.write_text", { path: "C:/tmp/x.txt", text: "hi" }), final("done")]);
    await startAgentRun("写文件");
    const asked = agentSession.steps.filter((s) => s.type === "approval_asked");
    expect(asked).toHaveLength(0);
    const decided = agentSession.steps.find((s) => s.type === "approval_decided");
    // reason 说明的是「哪条规则放行的」：never 策略放行的原因是 mode-never，
    // 而不是 risky-write（那是「为什么要问人」的原因，只在真的问人时出现）
    expect(decided).toMatchObject({ approved: true, source: "policy", reason: "mode-never" });
  });

  it("模型返回非 JSON 时先尝试修复，修复过程进时间线", async () => {
    let n = 0;
    aiComplete.mockImplementation(async () => {
      n += 1;
      if (n === 1) return "好的，我先看看这个任务";
      return JSON.stringify(final("修复后完成"));
    });
    await startAgentRun("随便看看");
    expect(agentSession.runStatus).toBe("completed");
    expect(agentSession.answer).toBe("修复后完成");
    expect(agentSession.steps.some((s) => s.type === "model_repair")).toBe(true);
  });
});

describe("确认与停止", () => {
  it("always 策略下每次工具调用都出内联确认卡；拒绝只否决这一次调用", async () => {
    agentSession.cfg = { ...agentSession.cfg, requireConfirmation: "always" };
    scriptPlanner([call("base64.encode", { text: "hi" }), final("改用只读方式")]);
    const run = startAgentRun("编码");
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull());
    expect(agentSession.pending.kind).toBe("tool");
    expect(resolvePending(false)).toBe(true);
    await run;
    // 拒绝不立刻取消整个目标：拒绝作为反馈回灌，模型换一条路后本次运行仍可完成
    expect(agentSession.runStatus).toBe("completed");
    expect(agentSession.answer).toBe("改用只读方式");
    expect(agentSession.pending).toBeNull();
    // 人类决定要进时间线，否则历史里看不出是谁放行的
    expect(agentSession.steps.some((s) => s.type === "confirmation" && s.answer === false)).toBe(true);
    expect(agentSession.steps.some((s) => s.type === "approval_decided" && s.approved === false)).toBe(true);
  });

  it("允许后工具照常执行并完成", async () => {
    agentSession.cfg = { ...agentSession.cfg, requireConfirmation: "always" };
    scriptPlanner([call("base64.encode", { text: "hi" }), final("完成")]);
    const run = startAgentRun("编码");
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull());
    resolvePending(true);
    await run;
    expect(agentSession.runStatus).toBe("completed");
    expect(agentSession.steps.some((s) => s.type === "confirmation" && s.answer === true)).toBe(true);
  });

  it("无 pending 时 resolvePending 返回 false", () => {
    expect(resolvePending(true)).toBe(false);
  });

  it("用户停止记为 stopped", async () => {
    let seen = 0;
    aiComplete.mockImplementation(async () => {
      seen += 1;
      if (seen === 2) stopAgentRun("user");
      return JSON.stringify(call("base64.encode", { text: "x" }));
    });
    await startAgentRun("一直编码");
    expect(agentSession.runStatus).toBe("cancelled");
    expect(agentSession.stopReason).toBe("user");
    expect(agentSession.steps.at(-1)).toMatchObject({ type: "notice", code: "stopped" });
    expect(agentSession.runs[0].stopReason).toBe("user");
  });

  it("空闲时点停止是 no-op", () => {
    expect(stopAgentRun()).toBe(false);
  });
});

// 旧行为：ask_user 复用布尔确认卡，点「允许」把 true 当答案回灌，模型只能再问一遍
// （用户实测反馈：点了允许却始终没机会输入文件路径）。现在提问走文本入口。
describe("ask_user 的文本回答", () => {
  const ask = (question) => ({ type: "ask_user", question });

  it("回答文本进历史、进时间线，运行继续到收尾", async () => {
    scriptPlanner([ask("请提供两个文件的绝对路径"), final("已比较")]);
    const run = startAgentRun("比较两个文件");
    await vi.waitFor(() => expect(agentSession.pending?.kind).toBe("ask"));
    expect(agentSession.pending.question).toContain("绝对路径");
    expect(answerPending("/tmp/a.txt /tmp/b.txt")).toBe(true);
    await run;
    expect(agentSession.runStatus).toBe("completed");
    expect(agentSession.steps.some((s) => s.type === "confirmation" && s.answer === "/tmp/a.txt /tmp/b.txt")).toBe(true);
  });

  it("空回答不发：pending 保留，等用户补内容（而不是把空串回灌给模型）", async () => {
    scriptPlanner([ask("要比较哪两个文件？"), final("done")]);
    const run = startAgentRun("比较");
    await vi.waitFor(() => expect(agentSession.pending?.kind).toBe("ask"));
    expect(answerPending("   ")).toBe(false);
    expect(agentSession.pending).not.toBeNull();
    expect(answerPending("/tmp/a.txt /tmp/b.txt")).toBe(true);
    await run;
    expect(agentSession.runStatus).toBe("completed");
  });

  it("工具确认卡不接受文本回答（两条路径不互相串）", async () => {
    // 用写类工具（默认 risky 策略会弹确认卡），但不落文件系统：http.request 只出站请求，
    // 既避开读后写门禁，也避开真实文件副作用。这里验证的是两条确认路径不互相串。
    scriptPlanner([call("http.request", { method: "GET", url: "http://127.0.0.1:1/" }), final("done")]);
    const run = startAgentRun("发个请求");
    await vi.waitFor(() => expect(agentSession.pending?.kind).toBe("tool"));
    // 文本入口对工具确认卡无效
    expect(answerPending("随便写点什么")).toBe(false);
    expect(agentSession.pending).not.toBeNull();
    // 布尔入口才是它的回答方式
    expect(resolvePending(true)).toBe(true);
    await run;
    // 时间线里记的是布尔答案，而不是把文本塞进确认事件
    expect(agentSession.steps.some((s) => s.type === "confirmation" && s.answer === true)).toBe(true);
    expect(agentSession.steps.some((s) => s.type === "tool_start" && s.tool === "http.request")).toBe(true);
  });

  it("跳过提问等于放弃目标（cancelled）", async () => {
    scriptPlanner([ask("要比较哪两个文件？")]);
    const run = startAgentRun("比较");
    await vi.waitFor(() => expect(agentSession.pending?.kind).toBe("ask"));
    stopAgentRun("denied");
    await run;
    expect(agentSession.runStatus).toBe("cancelled");
    expect(agentSession.pending).toBeNull();
  });
});

describe("步数上限", () => {
  it("按设置的步数上限收尾并标 max_steps", async () => {
    agentSession.cfg = { ...agentSession.cfg, maxSteps: 3 };
    let planned = 0;
    aiComplete.mockImplementation(async () => {
      planned += 1;
      return JSON.stringify(call("base64.encode", { text: "x" }));
    });
    await startAgentRun("一直编码");
    expect(agentSession.runStatus).toBe("max_steps");
    expect(planned).toBe(3);
    expect(agentSession.steps.at(-1)).toMatchObject({ type: "notice", code: "max_steps" });
  });
});

describe("历史", () => {
  // 与 AgentView.resumeMap 同款判定：续跑用的必须是「新运行将使用的同一个过滤后 registry」
  const resumable = (run) => !!run?.input && canResume(run, buildAgentRegistry(agentSession.cfg));

  it("含脱敏内容的历史不可续跑", async () => {
    scriptPlanner([call("base64.encode", { text: 'password="hunter2-secret"' }), final("done")]);
    await startAgentRun("编码");
    const run = agentSession.runs[0];
    expect(resumable(run)).toBe(false);
  });

  it("干净的只读历史可续跑", () => {
    const run = { id: "r1", input: "编码 hello", status: "success", history: [{ action: { type: "tool_call", tool: "base64.encode" }, result: "aGk=" }] };
    expect(resumable(run)).toBe(true);
  });

  it("历史里用过的工具被停用后不可续跑", () => {
    const run = { id: "r1", input: "编码 hello", status: "success", history: [{ action: { type: "tool_call", tool: "base64.encode" }, result: "aGk=" }] };
    expect(resumable(run)).toBe(true);
    agentSession.cfg = { ...agentSession.cfg, disabledTools: ["base64.encode"] };
    expect(resumable(run)).toBe(false);
  });

  it("空输入或缺 id 的历史不可续跑", () => {
    expect(resumable(null)).toBe(false);
    expect(resumable({ id: "x", input: "" })).toBe(false);
  });

  it("丢弃历史条目并清空时间线", async () => {
    scriptPlanner([final("ok")]);
    await startAgentRun("随便");
    const id = agentSession.runs[0].id;
    discardRun(id);
    expect(agentSession.runs).toHaveLength(0);
    expect(agentSession.steps.length).toBeGreaterThan(0);
    clearTimeline();
    expect(agentSession.steps).toEqual([]);
    expect(agentSession.answer).toBe("");
  });
});
