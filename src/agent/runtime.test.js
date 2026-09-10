import { describe, expect, it, vi } from "vitest";
import { createToolRegistry, runAgent } from "./runtime.js";
import { createBuiltinRegistry } from "./builtins.js";

describe("agent runtime", () => {
  it("executes tool calls until the planner returns a final answer", async () => {
    const registry = createToolRegistry([
      { name: "math.add", description: "add", risk: "transform", inputSchema: { required: ["a", "b"] }, execute: ({ a, b }) => a + b },
    ]);
    const actions = [
      { type: "tool_call", id: "1", tool: "math.add", args: { a: 2, b: 3 } },
      { type: "final", answer: "5" },
    ];
    const events = [];
    const result = await runAgent("calculate", { registry, planner: async () => actions.shift(), onEvent: (e) => events.push(e) });
    expect(result.answer).toBe("5");
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_result", "final"]);
  });

  it("pauses for confirmation before risky tools", async () => {
    const registry = createToolRegistry([{ name: "file.write", description: "write", risk: "write", inputSchema: {}, execute: () => "ok" }]);
    const result = await runAgent("write", { registry, planner: async () => ({ type: "tool_call", tool: "file.write", args: {} }), confirm: async () => false });
    expect(result.status).toBe("cancelled");
  });

  it("exposes safe JSON tools in the builtin registry", async () => {
    const tool = createBuiltinRegistry().get("json.parse");
    expect(await tool.execute({ text: '{"a":1}' })).toEqual({ a: 1 });
  });

  it("retries a failed tool and records the final result", async () => {
    let attempts = 0;
    const registry = createToolRegistry([{ name: "unstable", description: "", inputSchema: {}, execute: () => { attempts++; if (attempts < 2) throw new Error("temporary"); return "ok"; } }]);
    const actions = [{ type: "tool_call", tool: "unstable", args: {} }, { type: "final", answer: "done" }];
    const result = await runAgent("x", { registry, planner: async () => actions.shift(), retries: 1 });
    expect(result.answer).toBe("done");
    expect(attempts).toBe(2);
  });

  it("never retries a write even when retries are enabled", async () => {
    let calls = 0;
    const registry = createToolRegistry([{ name: "write", risk: "write", execute: () => { calls++; throw Error("unknown outcome"); } }]);
    const actions = [{ type: "tool_call", tool: "write", args: {} }, { type: "final", answer: "failed" }];
    await runAgent("x", { registry, planner: async () => actions.shift(), confirm: async () => true, retries: 3 });
    expect(calls).toBe(1);
  });

  it("abort while planning settles promptly and prevents a late tool call", async () => {
    let resolve;
    let started;
    const ready = new Promise(r => { started = r; });
    const controller = new AbortController();
    const execute = vi.fn();
    const registry = createToolRegistry([{ name: "write", risk: "write", execute }]);
    const task = runAgent("x", { registry, signal: controller.signal, planner: () => new Promise(r => { resolve = r; started(); }) });
    await ready;
    controller.abort();
    resolve({ type: "tool_call", tool: "write", args: {} });
    expect((await task).status).toBe("cancelled");
    expect(execute).not.toHaveBeenCalled();
  });

  it("times out a stuck tool without retrying or allowing late result events", async () => {
    vi.useFakeTimers();
    try {
      let resolve;
      const events = [];
      const execute = vi.fn(() => new Promise(r => { resolve = r; }));
      const registry = createToolRegistry([{ name: "slow", execute }]);
      const task = runAgent("x", { registry, planner: async () => ({ type: "tool_call", tool: "slow", args: {} }), toolTimeoutMs: 10, retries: 3, onEvent: e => events.push(e) });
      await vi.advanceTimersByTimeAsync(20);
      const result = await task;
      expect(result.status).toBe("failed");
      expect(result.error).toContain("超时");
      expect(execute).toHaveBeenCalledTimes(1);
      resolve("late");
      await Promise.resolve();
      expect(events.some(e => e.type === "tool_result")).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("rejects unknown arguments and incorrect types before execution", async () => {
    const execute = vi.fn();
    const registry = createToolRegistry([{ name: "strict", inputSchema: { type: "object", additionalProperties: false, properties: { text: { type: "string" } }, required: ["text"] }, execute }]);
    for (const args of [{ text: 12 }, { text: "ok", path: "/secret" }]) {
      const result = await runAgent("x", { registry, planner: async () => ({ type: "tool_call", tool: "strict", args }) });
      expect(result.status).toBe("failed");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns bounded failure for malformed planner output and step exhaustion", async () => {
    const registry = createBuiltinRegistry();
    expect((await runAgent("x", { registry, planner: async () => ({ type: "shell", command: "x" }) })).status).toBe("failed");
    const result = await runAgent("x", { registry, maxSteps: 1, planner: async () => ({ type: "tool_call", tool: "json.parse", args: { text: "{}" } }) });
    expect(result.status).toBe("max_steps");
    expect(result.history).toHaveLength(1);
  });

  it("requireConfirmation 'always' 让只读/转换类工具也要确认", async () => {
    const registry = createToolRegistry([{ name: "math.add", risk: "transform", execute: () => 5 }]);
    const actions = [{ type: "tool_call", tool: "math.add", args: {} }, { type: "final", answer: "5" }];
    const confirm = vi.fn(async () => true);
    const result = await runAgent("x", { registry, planner: async () => actions.shift(), confirm, requireConfirmation: "always" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.answer).toBe("5");
  });

  it("requireConfirmation 'never' 跳过写入确认且不留 waiting checkpoint，但写入仍不重试", async () => {
    let calls = 0;
    const checkpoints = [];
    const registry = createToolRegistry([{ name: "write", risk: "write", execute: () => { calls++; throw Error("unknown outcome"); } }]);
    const confirm = vi.fn(async () => true);
    const result = await runAgent("x", {
      registry,
      planner: async () => ({ type: "tool_call", tool: "write", args: {} }),
      confirm,
      requireConfirmation: "never",
      retries: 3,
      onCheckpoint: (cp) => checkpoints.push(cp),
    });
    expect(confirm).not.toHaveBeenCalled();
    // 跳过确认不能靠「假装批准」实现，否则时间线里会出现一个没人做过的决定
    expect(checkpoints.filter((cp) => cp.type === "waiting")).toEqual([]);
    expect(calls).toBe(1);
    expect(result.status).toBe("failed");
  });

  it("非法或缺失 requireConfirmation 时退回按风险确认", async () => {
    const registry = createToolRegistry([{ name: "write", risk: "write", execute: () => "ok" }]);
    const confirm = vi.fn(async () => false);
    for (const mode of [undefined, "yolo", ""]) {
      const result = await runAgent("x", { registry, planner: async () => ({ type: "tool_call", tool: "write", args: {} }), confirm, requireConfirmation: mode });
      expect(result.status).toBe("cancelled");
    }
    expect(confirm).toHaveBeenCalledTimes(3);
  });
});

describe("错误码透传", () => {
  // UI 按 code 映射 i18n 键（FORBIDDEN/TIMEOUT/DESKTOP_ONLY/ABORTED），不能靠匹配中文文案
  it("工具失败把 code 带到 tool_error 事件与返回结果", async () => {
    const events = [];
    const registry = createToolRegistry([{
      name: "gated",
      risk: "write",
      execute: () => { throw Object.assign(Error("需要 Pro 授权"), { code: "FORBIDDEN" }); },
    }]);
    const result = await runAgent("x", {
      registry,
      planner: async () => ({ type: "tool_call", tool: "gated", args: {} }),
      confirm: async () => true,
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("FORBIDDEN");
    expect(events.find((e) => e.type === "tool_error").code).toBe("FORBIDDEN");
  });

  it("无 code 的普通错误得到空串而不是 undefined", async () => {
    const registry = createToolRegistry([{ name: "plain", execute: () => { throw Error("炸了"); } }]);
    const result = await runAgent("x", { registry, planner: async () => ({ type: "tool_call", tool: "plain", args: {} }) });
    expect(result.errorCode).toBe("");
  });

  it("运行级失败与中止也带 errorCode", async () => {
    const registry = createToolRegistry([{ name: "t", execute: () => "ok" }]);
    const timedOut = await runAgent("x", { registry, planner: () => new Promise(() => {}), plannerTimeoutMs: 1 });
    expect(timedOut.status).toBe("failed");
    expect(timedOut.errorCode).toBe("TIMEOUT");

    const controller = new AbortController();
    controller.abort();
    const aborted = await runAgent("x", { registry, signal: controller.signal, planner: async () => ({ type: "final", answer: "x" }) });
    expect(aborted.status).toBe("cancelled");
    expect(aborted.errorCode).toBe("ABORTED");
  });
});
