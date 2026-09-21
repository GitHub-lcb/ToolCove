import { describe, expect, it, vi } from "vitest";
import { createToolRegistry, runAgent } from "./runtime.js";
import { buildAgentRegistry } from "./tools.js";
import { createObservationGate } from "./observation.js";

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
    // 策略放行的调用也要留审计事件（approval_decided + by=policy），不是只在问人时才有
    expect(events.map((e) => e.type)).toEqual(["approval_decided", "tool_start", "tool_result", "final"]);
  });

  it("核验通过后追加一条 verify 事件，并随结果带出去", async () => {
    const registry = createToolRegistry([
      { name: "math.add", description: "add", risk: "transform", inputSchema: {}, execute: () => 5 },
    ]);
    const actions = [{ type: "tool_call", id: "1", tool: "math.add", args: { a: 2, b: 3 } }, { type: "final", answer: "结果是 5" }];
    const events = [];
    const transport = async (body) => ({
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: 0.9 }])),
    });
    const result = await runAgent("calculate", { registry, planner: async () => actions.shift(), onEvent: (e) => events.push(e), typesafeTransport: transport });
    const verify = events.find((e) => e.type === "verify");
    expect(verify).toMatchObject({ verified: true, needsReview: false });
    // usage 不进时间线事件（计量走 onUsage 通道）
    expect(verify.usage).toBeUndefined();
    expect(result.verify.weakest).toBeCloseTo(0.9);
  });

  it("核验发现疑点时标 needsReview，但不改答案也不改状态", async () => {
    const registry = createToolRegistry([{ name: "math.add", description: "add", risk: "transform", inputSchema: {}, execute: () => 0 }]);
    const actions = [{ type: "tool_call", id: "1", tool: "math.add", args: {} }, { type: "final", answer: "找到了 12 条" }];
    const events = [];
    const transport = async (body) => ({
      answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: "noul", noul: id.includes("grounded") ? 0.1 : 0.9 }])),
    });
    const result = await runAgent("算一下", { registry, planner: async () => actions.shift(), onEvent: (e) => events.push(e), typesafeTransport: transport });
    expect(result.status).toBe("completed");
    expect(result.answer).toBe("找到了 12 条");
    expect(events.find((e) => e.type === "verify")).toMatchObject({ needsReview: true, reviewOf: ["grounded"] });
  });

  it("没配 TypeSafe 时不留 verify 行（未启用不是每次都该报的异常）", async () => {
    const registry = createToolRegistry([{ name: "math.add", description: "add", risk: "transform", inputSchema: {}, execute: () => 5 }]);
    const actions = [{ type: "tool_call", id: "1", tool: "math.add", args: {} }, { type: "final", answer: "5" }];
    const events = [];
    await runAgent("x", { registry, planner: async () => actions.shift(), onEvent: (e) => events.push(e) });
    expect(events.map((e) => e.type)).toEqual(["approval_decided", "tool_start", "tool_result", "final"]);
  });

  it("pauses for confirmation before risky tools", async () => {
    const registry = createToolRegistry([{ name: "file.write", description: "write", risk: "write", inputSchema: {}, execute: () => "ok" }]);
    const result = await runAgent("write", { registry, planner: async () => ({ type: "tool_call", tool: "file.write", args: {} }), confirm: async () => false });
    expect(result.status).toBe("cancelled");
  });

  it("exposes safe JSON tools in the builtin registry", async () => {
    const tool = (await buildAgentRegistry(null)).get("json.parse");
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
    const registry = await buildAgentRegistry(null);
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

describe("逐次批准", () => {
  // 旧行为：批准一次后同一 run 内所有同类写调用直接放行 = 无意的批量授权。
  it("risky 下换了参数就必须重新问，不再复用上一次的结构性授权", async () => {
    let executed = 0;
    const registry = createToolRegistry([{ name: "file.write", risk: "write", retryable: false, inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } }, execute: () => { executed += 1; return "ok"; } }]);
    const actions = [
      { type: "tool_call", tool: "file.write", args: { path: "a.txt" } },
      { type: "tool_call", tool: "file.write", args: { path: "b.txt" } },
      { type: "final", answer: "done" },
    ];
    const confirm = vi.fn(async () => true);
    const result = await runAgent("x", { registry, planner: async () => actions.shift(), confirm, requireConfirmation: "risky" });
    expect(result.answer).toBe("done");
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(executed).toBe(2);
  });

  it("同工具同参数的重复调用折叠成一次询问（唯一允许的复用）", async () => {
    const registry = createToolRegistry([{ name: "file.write", risk: "write", retryable: false, inputSchema: { type: "object", properties: { path: { type: "string" } } }, execute: () => "ok" }]);
    const actions = [
      { type: "tool_call", tool: "file.write", args: { path: "a.txt" } },
      { type: "tool_call", tool: "file.write", args: { path: "a.txt" } },
      { type: "final", answer: "done" },
    ];
    const confirm = vi.fn(async () => true);
    const result = await runAgent("x", { registry, planner: async () => actions.shift(), confirm, requireConfirmation: "risky" });
    expect(result.answer).toBe("done");
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it("拒绝后把拒绝作为反馈回灌给模型，而不是放弃整个目标", async () => {
    const calls = [];
    const registry = createToolRegistry([{ name: "file.write", risk: "write", retryable: false, inputSchema: { type: "object", properties: { path: { type: "string" } } }, execute: ({ path }) => { calls.push(path); return "ok"; } }]);
    const actions = [
      { type: "tool_call", tool: "file.write", args: { path: "a.txt" } },
      { type: "tool_call", tool: "file.write", args: { path: "b.txt" } },
      { type: "final", answer: "换了个思路" },
    ];
    const confirm = vi.fn(async () => false); // 两次都拒绝
    const result = await runAgent("x", { registry, planner: async () => actions.shift(), confirm, requireConfirmation: "risky" });
    expect(result.answer).toBe("换了个思路");
    expect(calls).toEqual([]); // 被拒的调用从未执行
    // 拒绝原因进历史，模型才可能换招
    expect(result.history.some((h) => String(h.error || "").includes("用户拒绝"))).toBe(true);
  });

  it("第一次就拒绝且模型没有别的办法时，拒绝预算用尽后以 cancelled 收尾", async () => {
    const registry = createToolRegistry([{ name: "file.write", risk: "write", retryable: false, execute: () => "ok" }]);
    const result = await runAgent("x", { registry, planner: async () => ({ type: "tool_call", tool: "file.write", args: {} }), confirm: async () => false });
    expect(result.status).toBe("cancelled");
    // 拒绝不立刻取消：每次拒绝都作为反馈回灌，模型原样重试，
    // 走满 MAX_DENIALS_PER_RUN 次才收尾；历史里留下的是拒绝原因，而不是空历史
    expect(result.history.length).toBeGreaterThan(0);
    expect(result.history.every((h) => String(h.error || "").includes("用户拒绝"))).toBe(true);
  });

  it("审计事件成对：人类批准与策略放行都留 approval_asked / approval_decided", async () => {
    const events = [];
    const registry = createToolRegistry([
      { name: "json.parse", risk: "transform", execute: () => ({}) },
      { name: "file.write", risk: "write", retryable: false, execute: () => "ok" },
    ]);
    const actions = [
      { type: "tool_call", tool: "json.parse", args: {} },
      { type: "tool_call", tool: "file.write", args: {} },
      { type: "final", answer: "done" },
    ];
    await runAgent("x", { registry, planner: async () => actions.shift(), confirm: async () => true, onEvent: (e) => events.push(e) });

    const asked = events.filter((e) => e.type === "approval_asked");
    const decided = events.filter((e) => e.type === "approval_decided");
    expect(asked).toHaveLength(1); // 只读工具不需要问人，就没有 asked
    expect(decided).toHaveLength(2); // 但每一次调用都要有结论
    expect(asked[0].reason).toBe("risky-write");
    expect(asked[0].id).toBe(decided[1].id); // 成对：同一个 callId

    const safe = decided.find((e) => e.source === "policy");
    expect(safe.reason).toBe("safe-risk");
    expect(safe.approved).toBe(true);
    const human = decided.find((e) => e.source === "human");
    expect(human.approved).toBe(true);
    expect(human.by).toBe("user");
  });

  it("never 策略下审计写「策略放行」而不是「假装有人批准」", async () => {
    const events = [];
    const registry = createToolRegistry([{ name: "file.write", risk: "write", retryable: false, execute: () => "ok" }]);
    await runAgent("x", { registry, planner: async () => ({ type: "tool_call", tool: "file.write", args: {} }), confirm: async () => true, requireConfirmation: "never", onEvent: (e) => events.push(e) });
    const decided = events.find((e) => e.type === "approval_decided");
    expect(decided).toMatchObject({ approved: true, source: "policy", reason: "mode-never" });
    expect(events.some((e) => e.type === "approval_asked")).toBe(false);
  });

  it("confirm:'always' 的工具在 never 策略下仍然要问", async () => {
    const registry = createToolRegistry([{ name: "data.remove", risk: "write", confirm: "always", retryable: false, execute: () => "ok" }]);
    const confirm = vi.fn(async () => false);
    const result = await runAgent("x", { registry, planner: async () => ({ type: "tool_call", tool: "data.remove", args: {} }), confirm, requireConfirmation: "never" });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("cancelled");
  });

  // 回归：拒绝必须记账。否则模型原样重试同一调用时会对同一张卡片反复追问，
  // 把步数预算全耗在重复确认上（验证时实测到 5 次重复询问）。
  it("被拒绝的同一调用不再重复追问", async () => {
    const registry = createToolRegistry([{ name: "data.remove", risk: "write", confirm: "always", retryable: false, execute: () => "ok" }]);
    const confirm = vi.fn(async () => false);
    const result = await runAgent("x", {
      registry,
      planner: async () => ({ type: "tool_call", tool: "data.remove", args: {} }), // 每轮都原样重试
      confirm,
      requireConfirmation: "never",
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("cancelled");
  });

  // 回归：没问人不等于没决定。审计必须写出「策略放行」，否则「谁放行的」答不出来。
  it("无需问人的调用也留一条策略放行的审计事件", async () => {
    const events = [];
    const registry = createToolRegistry([{ name: "json.parse", risk: "transform", execute: () => ({}) }]);
    const actions = [{ type: "tool_call", tool: "json.parse", args: {} }, { type: "final", answer: "done" }];
    await runAgent("x", {
      registry,
      planner: async () => actions.shift(),
      confirm: async () => true,
      onEvent: (e) => events.push(e),
    });
    const decided = events.filter((e) => e.type === "approval_decided");
    expect(decided).toHaveLength(1);
    expect(decided[0]).toMatchObject({ approved: true, source: "policy", reason: "safe-risk", by: "policy" });
    expect(events.some((e) => e.type === "approval_asked")).toBe(false);
  });

  it("连续被拒达到上限后用 cancelled 收尾，不死磕", async () => {
    const registry = createToolRegistry([{ name: "file.write", risk: "write", retryable: false, execute: () => "ok" }]);
    let n = 0;
    const result = await runAgent("x", {
      registry,
      // 每轮都换一个参数，绕开折叠，逼出上限
      planner: async () => ({ type: "tool_call", tool: "file.write", args: { n: (n += 1) } }),
      confirm: async () => false,
    });
    expect(result.status).toBe("cancelled");
    expect(n).toBe(5);
  });
});

describe("读后写门禁", () => {
  // 三个文件工具的真实形状：read 读内容、inspect 只读元信息、write 受门禁保护
  const fileRegistry = (executed) =>
    createToolRegistry([
      {
        name: "file.read_text",
        risk: "read",
        retryable: false,
        inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
        execute: ({ path }) => ({ path, text: "旧内容" }),
      },
      {
        name: "file.inspect",
        risk: "read",
        retryable: false,
        inputSchema: { type: "object", required: ["paths"], properties: { paths: { type: "array", items: { type: "string" } } } },
        execute: ({ paths }) => paths.map((path) => ({ path, size: 10 })),
      },
      {
        name: "file.write_text",
        risk: "write",
        retryable: false,
        inputSchema: { type: "object", required: ["path", "text"], properties: { path: { type: "string" }, text: { type: "string" } } },
        execute: ({ path }) => { executed.push(path); return "written"; },
      },
    ]);

  const neverAsk = { confirm: async () => true, requireConfirmation: "never" };

  it("没读过就写：拒绝执行并给出可自救的错误码", async () => {
    const executed = [];
    const events = [];
    const result = await runAgent("x", {
      registry: fileRegistry(executed),
      planner: async () => ({ type: "tool_call", tool: "file.write_text", args: { path: "C:/tmp/a.txt", text: "新内容" } }),
      ...neverAsk,
      onEvent: (e) => events.push(e),
    });
    expect(executed).toEqual([]);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("OBSERVATION_REQUIRED");
    expect(result.error).toContain("file.read_text"); // 提示要能教模型自救
    expect(events.find((e) => e.type === "tool_error").code).toBe("OBSERVATION_REQUIRED");
  });

  it("先读后写：放行", async () => {
    const executed = [];
    const actions = [
      { type: "tool_call", tool: "file.read_text", args: { path: "C:/tmp/a.txt" } },
      { type: "tool_call", tool: "file.write_text", args: { path: "C:/tmp/a.txt", text: "新内容" } },
      { type: "final", answer: "done" },
    ];
    const result = await runAgent("x", { registry: fileRegistry(executed), planner: async () => actions.shift(), ...neverAsk });
    expect(result.answer).toBe("done");
    expect(executed).toEqual(["C:/tmp/a.txt"]);
  });

  it("读过但读不到（确定不存在）：放行创建，且状态记为 absent", async () => {
    // 注意：读取失败会让运行按工具失败收尾，所以「失败之后能否创建」无法在单次运行里断言。
    // 这里直接用门禁契约验证：一次「读不到」之后，写入不再被拦。
    const gate = createObservationGate();
    gate.observeFailure("file.read_text", { path: "C:/tmp/new.txt" }, Error("无法读取文件：不存在 (os error 2)"));
    expect(gate.statusOf("C:/tmp/new.txt")).toBe("absent");
    expect(gate.check("file.write_text", { path: "C:/tmp/new.txt" })).toBeNull();

    // 顺带确认运行确实用上了外部传入的门禁实例（runtime 支持注入，便于测试与复用）
    const registry = createToolRegistry([
      { name: "file.read_text", risk: "read", retryable: false, inputSchema: { type: "object", properties: { path: { type: "string" } } }, execute: () => { throw Error("无法读取文件：不存在 (os error 2)"); } },
    ]);
    const result = await runAgent("x", {
      registry,
      observationGate: gate,
      planner: async () => ({ type: "tool_call", tool: "file.read_text", args: { path: "C:/tmp/other.txt" } }),
      maxSteps: 1,
      ...neverAsk,
    });
    expect(result.error).toContain("不存在");
    expect(gate.statusOf("C:/tmp/other.txt")).toBe("absent");
  });

  it("inspect 只证明存在，仍不放行写入", async () => {
    const executed = [];
    const actions = [
      { type: "tool_call", tool: "file.inspect", args: { paths: ["C:/tmp/a.txt"] } },
      { type: "tool_call", tool: "file.write_text", args: { path: "C:/tmp/a.txt", text: "新内容" } },
    ];
    const result = await runAgent("x", { registry: fileRegistry(executed), planner: async () => actions.shift(), ...neverAsk });
    expect(executed).toEqual([]);
    expect(result.errorCode).toBe("OBSERVATION_REQUIRED");
    expect(result.error).toContain("元信息"); // 说明的是「看到过但没读过」，不是「完全没观察」
  });

  it("门禁结果按运行隔离：上一次运行的读取不会放行这一次", async () => {
    const executed = [];
    const registry = fileRegistry(executed);
    const read = { type: "tool_call", tool: "file.read_text", args: { path: "C:/tmp/a.txt" } };
    await runAgent("x", { registry, planner: async () => read, maxSteps: 1, ...neverAsk });
    const write = { type: "tool_call", tool: "file.write_text", args: { path: "C:/tmp/a.txt", text: "新内容" } };
    const second = await runAgent("x", { registry, planner: async () => write, ...neverAsk });
    expect(second.errorCode).toBe("OBSERVATION_REQUIRED");
    expect(executed).toEqual([]);
  });
});

describe("模型调用重试", () => {
  it("限流等瞬时错误退避重试，最终成功", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const events = [];
      const registry = createToolRegistry([{ name: "noop", execute: () => "ok" }]);
      const planner = async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(Error("rate limited"), { code: "RATE_LIMIT" });
        return { type: "final", answer: "ok" };
      };
      const task = runAgent("x", { registry, planner, onEvent: (e) => events.push(e) });
      await vi.advanceTimersByTimeAsync(1000);
      const result = await task;
      expect(result.status).toBe("completed");
      expect(calls).toBe(2);
      // 重试过程必须可见，否则用户只看到「卡了一下」
      expect(events.find((e) => e.type === "model_retry")).toMatchObject({ code: "RATE_LIMIT", attempt: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("鉴权类错误不重试，立刻失败", async () => {
    const registry = createToolRegistry([{ name: "noop", execute: () => "ok" }]);
    let calls = 0;
    const result = await runAgent("x", {
      registry,
      planner: async () => {
        calls += 1;
        throw Object.assign(Error("bad key"), { code: "AUTH" });
      },
    });
    expect(calls).toBe(1);
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("AUTH");
  });

  it("重试上限用尽后按失败收尾，且返回最后一次的错误码", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const registry = createToolRegistry([{ name: "noop", execute: () => "ok" }]);
      const task = runAgent("x", {
        registry,
        planner: async () => {
          calls += 1;
          throw Object.assign(Error("503"), { code: "SERVER" });
        },
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await task;
      expect(calls).toBe(3);
      expect(result.status).toBe("failed");
      expect(result.errorCode).toBe("SERVER");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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

// 旧行为：结果超过 maxOutput 直接 throw「工具结果过大，请缩小输入后重试」——「结果太大」= 「这步白做」。
// 新行为分三层：小结果原样 / 中结果头尾保留 / 大结果落盘（spill），并保证进历史的那一份永远在预算内。
describe("工具结果分层保留", () => {
  const bigTool = (value) => createToolRegistry([{ name: "big", description: "", risk: "read", inputSchema: {}, execute: () => value }]);
  /** 一次工具调用 + 收尾：planner 用 shift() 逐次返回，与文件里既有用例同形。 */
  const plannerFor = () => {
    const actions = [{ type: "tool_call", tool: "big", args: {} }, { type: "final", answer: "done" }];
    return async () => actions.shift();
  };

  it("小结果原样进历史，不产生裁剪标记", async () => {
    const registry = bigTool({ ok: true });
    const result = await runAgent("x", { registry, planner: plannerFor(), maxOutputLength: 1000 });
    expect(result.status).toBe("completed");
    expect(result.history[0].result).toEqual({ ok: true });
    expect(result.history[0].clipped).toBeUndefined();
  });

  it("超限但不算大：保留头尾，且历史那一份不超预算", async () => {
    const events = [];
    const registry = bigTool("H".repeat(50) + "m".repeat(3000) + "T".repeat(50));
    const result = await runAgent("x", { registry, planner: plannerFor(), maxOutputLength: 1000, onEvent: (e) => events.push(e) });
    const entry = result.history[0];
    expect(entry.clipped).toBe(true);
    expect(entry.omittedChars).toBeGreaterThan(0);
    // 预算口径：字符串载荷的 JSON 长度（含引号）不超过 maxOutput
    expect(JSON.stringify(entry.result).length).toBeLessThanOrEqual(1000);
    expect(String(entry.result).startsWith("H")).toBe(true);
    expect(String(entry.result).endsWith("T")).toBe(true);
    expect(entry.note).toContain("省略");
    expect(events.some((e) => e.type === "tool_clip")).toBe(true);
  });

  it("大结果落盘：历史里放引用与「怎么读回来」的说明", async () => {
    const spilled = [];
    const events = [];
    const registry = bigTool({ rows: "r".repeat(9000) });
    const result = await runAgent("x", {
      registry,
      planner: plannerFor(),
      maxOutputLength: 1000,
      spill: async (req) => { spilled.push(req); return { key: "spill:big-abc", chars: req.size }; },
      onEvent: (e) => events.push(e),
    });
    const entry = result.history[0];
    expect(spilled).toHaveLength(1);
    expect(spilled[0].tool).toBe("big");
    expect(entry.spilled).toBe(true);
    expect(entry.spillRef.key).toBe("spill:big-abc");
    expect(entry.note).toContain("spill.read");
    expect(events.some((e) => e.type === "tool_spill" && e.key === "spill:big-abc")).toBe(true);
    // 摘要 + 说明之和仍要在预算内：说明本身也占历史空间
    expect(JSON.stringify(entry.result).length + entry.note.length).toBeLessThanOrEqual(1000);
  });

  it("落盘失败降级为裁剪，并留下可见痕迹", async () => {
    const events = [];
    const registry = bigTool("z".repeat(9000));
    const result = await runAgent("x", {
      registry,
      planner: plannerFor(),
      maxOutputLength: 1000,
      spill: async () => null,
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("completed");
    expect(result.history[0].spilled).toBe(false);
    expect(result.history[0].clipped).toBe(true);
    expect(events.some((e) => e.type === "tool_clip")).toBe(true);
    expect(events.some((e) => e.type === "notice" && e.code === "spill_failed")).toBe(true);
  });

  it("没有落盘钩子（浏览器/测试）时不报错，直接裁剪", async () => {
    const registry = bigTool("q".repeat(9000));
    const result = await runAgent("x", { registry, planner: plannerFor(), maxOutputLength: 1000 });
    expect(result.status).toBe("completed");
    expect(result.history[0].clipped).toBe(true);
    expect(JSON.stringify(result.history[0].result).length).toBeLessThanOrEqual(1000);
  });

  it("超大结果也不会把运行的返回值撑爆", async () => {
    const registry = bigTool("w".repeat(500000));
    const result = await runAgent("x", { registry, planner: plannerFor(), maxOutputLength: 2000 });
    expect(JSON.stringify(result.history[0].result).length).toBeLessThanOrEqual(2000);
  });

  it("事件载荷单独收预算：5MB 结果不会顺着事件流进 DOM 与持久化", async () => {
    const events = [];
    const registry = bigTool({ rows: "r".repeat(200000) });
    await runAgent("x", { registry, planner: plannerFor(), maxOutputLength: 100000, onEvent: (e) => events.push(e) });
    const event = events.find((e) => e.type === "tool_result");
    expect(event.payloadClipped).toBe(true);
    expect(JSON.stringify(event.result).length).toBeLessThanOrEqual(8000 + 2);
  });
});

describe("ask_user 的回答是文本", () => {
  const askPlanner = () => {
    const actions = [
      { type: "ask_user", question: "请提供两个文件的绝对路径" },
      { type: "final", answer: "done" },
    ];
    return async () => actions.shift();
  };

  it("askUser 返回的文本进历史并出现在 confirmation 事件里", async () => {
    const events = [];
    const seen = [];
    const registry = createToolRegistry([{ name: "t", execute: () => "ok" }]);
    const result = await runAgent("x", {
      registry,
      planner: askPlanner(),
      askUser: async (question) => { seen.push(question); return "/tmp/a.txt 与 /tmp/b.txt"; },
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("completed");
    expect(seen[0]).toContain("绝对路径");
    expect(result.history[0]).toMatchObject({ action: { type: "ask_user" }, answer: "/tmp/a.txt 与 /tmp/b.txt" });
    expect(events.find((e) => e.type === "confirmation").answer).toBe("/tmp/a.txt 与 /tmp/b.txt");
  });

  it("布尔回答不再被当成答案（旧实现把 true 当答案回灌，模型只能再问一遍）", async () => {
    const events = [];
    const registry = createToolRegistry([{ name: "t", execute: () => "ok" }]);
    const result = await runAgent("x", {
      registry,
      planner: askPlanner(),
      // 只给了 confirm（布尔语义）而不是 askUser：回答被归一成字符串 "true"
      confirm: async () => true,
      onEvent: (e) => events.push(e),
    });
    expect(result.status).toBe("completed");
    expect(result.history[0].answer).toBe("true");
    // 但纯空白文本视为没回答 → 结束目标，而不是把空串喂给模型
    const blank = await runAgent("x", { registry, planner: askPlanner(), askUser: async () => "   " });
    expect(blank.status).toBe("cancelled");
    // null / false 仍然表示拒绝回答
    const denied = await runAgent("x", { registry, planner: askPlanner(), askUser: async () => null });
    expect(denied.status).toBe("cancelled");
  });

  it("答案过长被截断，不会把历史撑爆", async () => {
    const registry = createToolRegistry([{ name: "t", execute: () => "ok" }]);
    const result = await runAgent("x", { registry, planner: askPlanner(), askUser: async () => "x".repeat(9000) });
    expect(result.history[0].answer.length).toBeLessThanOrEqual(4000);
  });
});

describe("写前预览", () => {
  const writeRegistry = () => createToolRegistry([
    { name: "file.read_text", risk: "read", inputSchema: {}, execute: () => ({ text: "old" }) },
    { name: "file.write_text", risk: "write", previewBefore: true, inputSchema: {}, execute: () => "ok" },
  ]);
  /** 先读后写：门禁要求写之前必须读过（预览成功也会登记为内容观察，见 runtime 的说明）。 */
  const writePlanner = () => {
    const actions = [
      { type: "tool_call", tool: "file.read_text", args: { path: "a.txt" } },
      { type: "tool_call", tool: "file.write_text", args: { path: "a.txt", text: "new" } },
      { type: "final", answer: "done" },
    ];
    return async () => actions.shift();
  };

  it("确认卡带上 diff：人要看着 diff 才能决定放不放行", async () => {
    const previewed = [];
    const seen = [];
    const result = await runAgent("x", {
      registry: writeRegistry(),
      planner: writePlanner(),
      preview: async (tool, args) => ({ path: args.path, before: "old", after: args.text, diff: { hasChanges: true } }),
      confirm: async (message, meta) => { seen.push(meta.preview); return true; },
      onEvent: (e) => { if (e.type === "approval_asked") previewed.push(e); },
    });
    expect(result.status).toBe("completed");
    expect(previewed[0].preview.diff).toEqual({ hasChanges: true });
    expect(seen[0].path).toBe("a.txt");
  });

  it("预览成功也算「读过内容」：看着 diff 点了允许，不该再被读后写门禁拦住", async () => {
    const result = await runAgent("x", {
      registry: writeRegistry(),
      planner: (() => {
        const actions = [
          { type: "tool_call", tool: "file.write_text", args: { path: "a.txt", text: "new" } },
          { type: "final", answer: "done" },
        ];
        return async () => actions.shift();
      })(),
      preview: async (tool, args) => ({ path: args.path, before: "old", after: args.text, diff: {}, isNew: false }),
      confirm: async () => true,
    });
    expect(result.status).toBe("completed");
  });

  it("没读过就不给写：预览也不放宽这条门禁", async () => {
    const result = await runAgent("x", {
      registry: writeRegistry(),
      planner: async () => ({ type: "tool_call", tool: "file.write_text", args: { path: "a.txt", text: "new" } }),
      // 预览报 isNew（文件不存在）时不算内容观察，写入仍须先 inspect 证明缺失
      preview: async (tool, args) => ({ path: args.path, before: "", after: args.text, isNew: true }),
      confirm: async () => true,
    });
    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("OBSERVATION_REQUIRED");
  });

  it("预览失败不阻断批准：读不到旧文件也得让人做决定", async () => {
    const events = [];
    const result = await runAgent("x", {
      registry: writeRegistry(),
      planner: writePlanner(),
      preview: async () => { throw Error("no such file"); },
      confirm: async () => true,
      onEvent: (e) => events.push(e),
    });
    expect(events.find((e) => e.type === "approval_asked").preview).toBeUndefined();
  });

  it("没有预览需求的工具不会触发预览钩子", async () => {
    let called = 0;
    const registry = createToolRegistry([{ name: "data.remove", risk: "write", confirm: "always", inputSchema: {}, execute: () => "ok" }]);
    await runAgent("x", {
      registry,
      planner: async () => ({ type: "tool_call", tool: "data.remove", args: {} }),
      preview: async () => { called += 1; return {}; },
      confirm: async () => true,
    });
    expect(called).toBe(0);
  });
});
