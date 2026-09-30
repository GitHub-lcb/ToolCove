// 运行记录落盘必须脱敏：appendStep 只洗 steps，history 与 spill 正文以前是原样写进
// agentRuns.json 的（还会被每日自动备份带走）——界面上显示 [REDACTED]，磁盘上却是明文。
// 单独一个文件：这里要 mock 掉 toolboxStore 抓落盘内容，不能影响 session.test.js 的真实存储路径。
import { beforeEach, describe, expect, it, vi } from "vitest";

const saved = vi.hoisted(() => []);

vi.mock("../ai.js", () => ({ aiComplete: vi.fn(), isAIConfigured: vi.fn(async () => true) }));
vi.mock("../typesafe.js", () => ({ resolveTypeSafeTransport: vi.fn(async () => null) }));
vi.mock("../toolboxStore.js", () => ({
  loadToolbox: async (_key, fallback) => fallback,
  saveToolbox: async (key, value) => { saved.push({ key, text: JSON.stringify(value) }); },
  saveToolboxNow: async (key, value) => { saved.push({ key, text: JSON.stringify(value) }); },
}));

import { aiComplete } from "../ai.js";
import { __resetAgentSession, agentSession, initAgentSession, startAgentRun } from "./session.js";
import { RUNS_KEY } from "./session.js";

beforeEach(async () => {
  __resetAgentSession();
  vi.clearAllMocks();
  saved.length = 0;
  await initAgentSession();
});

describe("运行记录落盘脱敏", () => {
  it("工具结果里的明文密码不会留在 agentRuns.json 里", async () => {
    // 第一次返回造密码的工具调用，第二次收尾（队列空时兜底 final，避免脚本写漏）
    let n = 0;
    aiComplete.mockImplementation(async () => {
      n += 1;
      return n === 1
        ? JSON.stringify({ type: "tool_call", id: "c1", tool: "crypto.password", args: { length: 16 } })
        : JSON.stringify({ type: "final", answer: "已生成" });
    });

    await startAgentRun("生成一个 16 位密码");

    const plain = agentSession.runs.at(-1).history[0].result.password;
    expect(typeof plain).toBe("string");
    expect(plain.length).toBe(16);

    const runsBlob = saved.filter((s) => s.key === RUNS_KEY).map((s) => s.text).join("\n");
    expect(runsBlob, "内存里有明文可以接受，落盘的副本必须已经洗过").not.toContain(plain);
    expect(runsBlob).toContain("[REDACTED]");
  });
});
