import { beforeEach, describe, expect, it, vi } from "vitest";

// session.js 只用到 ai.js 的 aiComplete（经 index.js 的默认 planner）与 isAIConfigured；
// mock 掉整个模块，既避开真实 IPC，也让规划脚本可控。
vi.mock("../ai.js", () => ({ aiComplete: vi.fn(), isAIConfigured: vi.fn(async () => true) }));

import { aiComplete } from "../ai.js";
import { buildAgentRegistry } from "./tools.js";
import { canResume } from "./runStore.js";
import {
  agentSession,
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
    expect(types).toEqual(["tool_start", "tool_result", "final"]);
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

  it("写入工具无授权门禁：确认后直达执行，失败原因来自传输层", async () => {
    scriptPlanner([call("file.write_text", { path: "C:/tmp/x.txt", text: "hi" })]);
    const run = startAgentRun("写个文件");
    await vi.waitFor(() => expect(agentSession.pending?.kind).toBe("tool"));
    expect(agentSession.pending.tool).toBe("file.write_text");
    expect(agentSession.pending.risk).toBe("write");
    expect(agentSession.status).toBe("waiting");
    resolvePending(true);
    await run;
    // node 环境没有 Tauri IPC：工具真的被调用了，失败来自传输层而不是门禁
    expect(agentSession.errorCode).toBe("TAURI_COMMAND_FAILED");
    expect(agentSession.errorCode).not.toBe("FORBIDDEN");
  });
});

describe("确认与停止", () => {
  it("always 策略下每次工具调用都出内联确认卡，拒绝即取消", async () => {
    agentSession.cfg = { ...agentSession.cfg, requireConfirmation: "always" };
    scriptPlanner([call("base64.encode", { text: "hi" }), final("不该到这")]);
    const run = startAgentRun("编码");
    await vi.waitFor(() => expect(agentSession.pending).not.toBeNull());
    expect(agentSession.pending.kind).toBe("tool");
    expect(resolvePending(false)).toBe(true);
    await run;
    expect(agentSession.runStatus).toBe("cancelled");
    expect(agentSession.pending).toBeNull();
    // 人类决定要进时间线，否则历史里看不出是谁放行的
    expect(agentSession.steps.some((s) => s.type === "confirmation" && s.answer === false)).toBe(true);
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
