// 审计接线：模拟一次真实 run 落盘后，审计存储里出现该次工具调用的条目。
// 单独一个文件：这里 mock 掉 platform/invoke（抓审计落盘），不影响 session.test.js 的真实路径。
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({ calls: [] }));
vi.mock("../platform/invoke.js", () => ({
  invoke: vi.fn(async (command, args) => {
    mocked.calls.push({ command, args });
    return command === "load_data" ? [] : null;
  }),
}));
vi.mock("../ai.js", () => ({ aiComplete: vi.fn(), isAIConfigured: vi.fn(async () => true), loadAIConfig: vi.fn(async () => null) }));
vi.mock("../typesafe.js", () => ({ resolveTypeSafeTransport: vi.fn(async () => null) }));

import { aiComplete } from "../ai.js";
import { AUDIT_KEY, __resetAudit } from "../enterprise/audit.js";
import { __resetAgentSession, initAgentSession, startAgentRun } from "./session.js";

beforeEach(async () => {
  __resetAgentSession();
  __resetAudit();
  vi.clearAllMocks();
  mocked.calls.length = 0;
  await initAgentSession();
});

describe("运行留痕接线", () => {
  it("一次工具调用（策略放行）在审计里留下 allow / policy 条目", async () => {
    let n = 0;
    aiComplete.mockImplementation(async () => {
      n += 1;
      return n === 1
        ? JSON.stringify({ type: "tool_call", id: "call-1", tool: "json.parse", args: { text: "{}" } })
        : JSON.stringify({ type: "final", answer: "done" });
    });

    await startAgentRun("解析一段 JSON");

    const saves = mocked.calls.filter((c) => c.command === "save_data" && c.args.key === AUDIT_KEY);
    expect(saves.length).toBeGreaterThan(0);
    const rows = saves.at(-1).args.data;
    expect(rows).toHaveLength(1);
    // id 是「runId:callId」形式（callId 由 runtime 生成，模型给的 id 不参与），此处只验形状
    expect(rows[0]).toEqual(
      expect.objectContaining({
        id: expect.stringMatching(/^[^:]+:[^:]+$/),
        tool: "json.parse",
        risk: "transform",
        decision: "allow",
        source: "policy",
      })
    );
  });
});
