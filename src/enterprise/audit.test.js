// 审计：run → 条目（纯函数）、合并去重与上限、以及读-合并-写的落盘行为。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ calls: [], loadResult: [] }));
vi.mock("../platform/invoke.js", () => ({
  invoke: vi.fn(async (command, args) => {
    mocked.calls.push({ command, args });
    return command === "load_data" ? mocked.loadResult : null;
  }),
}));

import { invoke } from "../platform/invoke.js";
import { AUDIT_KEY, AUDIT_MAX, __resetAudit, appendAudit, auditFromRun, clearAudit, loadAudit, mergeAudit } from "./audit.js";

const saveCalls = () => mocked.calls.filter((c) => c.command === "save_data");
const entry = (over = {}) => ({ id: "r1:c1", ts: 1, runId: "r1", goal: "g", tool: "json.parse", risk: "transform", decision: "allow", source: "policy", ...over });

beforeEach(() => {
  __resetAudit();
  mocked.calls.length = 0;
  mocked.loadResult = [];
  invoke.mockClear();
});

describe("auditFromRun", () => {
  it("把每次工具调用的批准决定映射为一条审计条目", () => {
    const run = {
      id: "r1",
      input: "读取订单文件并导出",
      updatedAt: 200,
      steps: [
        { type: "approval_asked", id: "c1", tool: "file.write_text", risk: "write", ts: 100 },
        { type: "approval_decided", id: "c1", tool: "file.write_text", approved: true, source: "human", ts: 101 },
        { type: "tool_start", id: "c1", tool: "file.write_text", ts: 102 },
        { type: "tool_result", id: "c1", tool: "file.write_text", ts: 103 },
        { type: "approval_decided", id: "c2", tool: "json.parse", approved: true, source: "policy", ts: 104 },
        { type: "approval_decided", id: "c3", tool: "data.remove", approved: false, source: "human", ts: 105 },
      ],
    };
    const entries = auditFromRun(run);
    expect(entries).toEqual([
      { id: "r1:c1", ts: 101, runId: "r1", goal: "读取订单文件并导出", tool: "file.write_text", risk: "write", decision: "allow", source: "human" },
      { id: "r1:c2", ts: 104, runId: "r1", goal: "读取订单文件并导出", tool: "json.parse", risk: "transform", decision: "allow", source: "policy" },
      { id: "r1:c3", ts: 105, runId: "r1", goal: "读取订单文件并导出", tool: "data.remove", risk: "write", decision: "deny", source: "human" },
    ]);
  });

  it("策略放行的调用没有 approval_asked，risk 回落到目录索引", () => {
    const run = { id: "r2", input: "x", steps: [{ type: "approval_decided", id: "c1", tool: "db.query_readonly", approved: true, source: "policy", ts: 5 }] };
    expect(auditFromRun(run)[0].risk).toBe("database");
  });

  it("goal 截断到 120 字符，ts 缺失回落到 run.updatedAt", () => {
    const run = { id: "r3", input: "目".repeat(300), updatedAt: 999, steps: [{ type: "approval_decided", id: "c1", tool: "json.parse", approved: true, source: "policy" }] };
    const [audit] = auditFromRun(run);
    expect(audit.goal).toHaveLength(120);
    expect(audit.ts).toBe(999);
  });

  it("空 steps / 畸形 run 返回空数组，不抛错", () => {
    expect(auditFromRun({ id: "r4", input: "x", steps: [] })).toEqual([]);
    expect(auditFromRun(null)).toEqual([]);
    expect(auditFromRun({ steps: [{ type: "approval_decided" }] })).toEqual([]);
  });

  it("只有 approval_decided 才产条目，工具执行 / 失败事件不产（不管执行成败，审计只认决定）", () => {
    const run = {
      id: "r5",
      input: "x",
      steps: [
        { type: "tool_start", id: "c1", tool: "file.read_text", ts: 1 },
        { type: "tool_error", id: "c1", tool: "file.read_text", ts: 2 },
        { type: "notice", code: "failed", ts: 3 },
      ],
    };
    expect(auditFromRun(run)).toEqual([]);
  });
});

describe("mergeAudit", () => {
  it("新的在前、按 id 去重（保留新的那份）", () => {
    const a = { id: "x", ts: 1 };
    const b = { id: "y", ts: 2 };
    expect(mergeAudit([a], [a, b]).map((e) => e.id)).toEqual(["y", "x"]);
  });

  it("incoming 按时间倒序并入，最新条目在最前", () => {
    const older = { id: "old" };
    const list = [{ id: "a" }, { id: "b" }, { id: "c" }]; // 时间升序
    expect(mergeAudit([older], list).map((e) => e.id)).toEqual(["c", "b", "a", "old"]);
  });

  it("裁剪到上限，丢弃最旧", () => {
    const many = Array.from({ length: AUDIT_MAX + 100 }, (_, i) => ({ id: `e${i}` }));
    const out = mergeAudit([], many);
    expect(out).toHaveLength(AUDIT_MAX);
    expect(out[0].id).toBe(`e${AUDIT_MAX + 99}`);
  });

  it("忽略非法条目与非数组入参", () => {
    expect(mergeAudit(null, [{ id: "a" }, null, {}, { noId: 1 }]).map((e) => e.id)).toEqual(["a"]);
    expect(mergeAudit([{ id: "a" }], "not-array")).toEqual([{ id: "a" }]);
  });
});

describe("审计存储", () => {
  it("appendAudit 读-合并-写：新条目落盘，且新的在前", async () => {
    await appendAudit([entry({ id: "r1:c1" })]);
    expect(saveCalls().at(-1).args).toEqual({ key: AUDIT_KEY, data: [entry({ id: "r1:c1" })] });
  });

  it("appendAudit 幂等：重复的同一条目不再写盘（run 每次变化都会触发）", async () => {
    const e = entry({ id: "r1:c1" });
    await appendAudit([e]);
    const before = saveCalls().length;
    await appendAudit([e]);
    expect(saveCalls().length).toBe(before);
  });

  it("appendAudit 与存储中的既有条目合并", async () => {
    mocked.loadResult = [entry({ id: "r0:c1", runId: "r0", tool: "file.read_text", risk: "read" })];
    await appendAudit([entry({ id: "r1:c2" })]);
    expect(saveCalls().at(-1).args.data.map((e) => e.id)).toEqual(["r1:c2", "r0:c1"]);
  });

  it("时间线倒序：超出上限时丢最旧", async () => {
    const many = Array.from({ length: AUDIT_MAX + 10 }, (_, i) => entry({ id: `r:c${i}` }));
    await appendAudit(many);
    const saved = saveCalls().at(-1).args.data;
    expect(saved).toHaveLength(AUDIT_MAX);
    expect(saved[0].id).toBe(`r:c${AUDIT_MAX + 9}`);
  });

  it("loadAudit 读回存储内容", async () => {
    mocked.loadResult = [entry({ id: "r9:c1" })];
    await expect(loadAudit()).resolves.toEqual([entry({ id: "r9:c1" })]);
  });

  it("loadAudit 读失败返回空数组", async () => {
    invoke.mockImplementationOnce(async () => { throw new Error("boom"); });
    await expect(loadAudit()).resolves.toEqual([]);
  });

  it("clearAudit 写空数组并清空镜像", async () => {
    await appendAudit([entry({ id: "r1:c1" })]);
    await clearAudit();
    expect(saveCalls().at(-1).args).toEqual({ key: AUDIT_KEY, data: [] });
  });
});
