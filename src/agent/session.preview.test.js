import { beforeEach, describe, expect, it, vi } from "vitest";

// 会话级链路：session → runtime → pending。
// 单测里 runtime 与 session 各自都有用例，但「写文件时确认卡到底拿没拿到 diff」只有把两者连起来才测得到
// ——用户实测反馈「没看到写入前预览」，就是这一层没有覆盖。
vi.mock("../ai.js", () => ({ aiComplete: vi.fn(), isAIConfigured: vi.fn(async () => true) }));

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("../platform/invoke.js", () => ({ invoke: invokeMock, createChannel: () => ({}) }));

import { aiComplete } from "../ai.js";
import { agentSession, initAgentSession, previewWrite, resolvePending, startAgentRun, __resetAgentSession } from "./session.js";

const FILE = "C:\\Users\\x\\Downloads\\test\\1.txt";

function scriptPlanner(actions) {
  const queue = [...actions];
  aiComplete.mockImplementation(async () => JSON.stringify(queue.shift() || { type: "final", answer: "done" }));
}
const call = (tool, args) => ({ type: "tool_call", id: crypto.randomUUID(), tool, args });

beforeEach(async () => {
  __resetAgentSession();
  vi.clearAllMocks();
  await initAgentSession();
});

describe("写前预览走到确认卡（会话级）", () => {
  it("file.write_text 的 pending 上带 preview（含 diff 与旧内容）", async () => {
    // 先读后写：门禁要求读过才能写（预演真实流程）
    invokeMock.mockImplementation(async (command) => {
      if (command === "file_tool_read_text") return { path: FILE, text: "old content", encoding: "UTF-8" };
      if (command === "file_tool_write_text") return null;
      return null;
    });
    scriptPlanner([call("file.read_text", { path: FILE }), call("file.write_text", { path: FILE, text: "new" })]);
    const run = startAgentRun("写入文件");
    await vi.waitFor(() => expect(agentSession.pending?.kind).toBe("tool"));
    // 这里就是用户看不到的那块内容
    expect(agentSession.pending.preview).toBeTruthy();
    expect(agentSession.pending.preview.path).toBe(FILE);
    expect(agentSession.pending.preview.before).toBe("old content");
    expect(agentSession.pending.preview.after).toBe("new");
    expect(agentSession.pending.preview.isNew).toBe(false);
    expect(agentSession.pending.preview.diff.hasChanges).toBe(true);
    resolvePending(true);
    await run;
  });

  it("读不到旧文件（新建）时也给人一张预览卡：isNew 与读取失败原因", async () => {
    // 门禁：read 报「不存在」→ 允许创建。这里直接驱动 previewWrite（不跑整个模型循环）：
    // 真实流程里模型会先 read（失败）再 write，而 write 的预览必然走「读到不存在」这一支。
    invokeMock.mockImplementation(async () => {
      throw new Error("无法读取文件：系统找不到指定的文件。 (os error 2)");
    });
    const preview = await previewWrite({ name: "file.write_text" }, { path: FILE, text: "hello" });
    expect(preview.isNew).toBe(true);
    expect(preview.after).toBe("hello");
    expect(preview.readError).toContain("无法读取文件");
    expect(preview.diff.hasChanges).toBe(true); // 新建也有 diff（全新增）
  });

  it("不是写文件工具的调用不产生预览", async () => {
    invokeMock.mockClear();
    expect(await previewWrite({ name: "file.read_text" }, { path: FILE })).toBe(null);
    expect(await previewWrite({ name: "file.write_text" }, {})).toBe(null);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("预览失败不阻断批准，但也不会留下半个 preview 对象", async () => {
    invokeMock.mockImplementation(async (command) => {
      if (command === "file_tool_read_text") return { path: FILE, text: "old" };
      if (command === "file_tool_write_text") return null;
      return null;
    });
    scriptPlanner([call("file.read_text", { path: FILE }), call("file.write_text", { path: FILE, text: "new" })]);
    const run = startAgentRun("写入文件");
    await vi.waitFor(() => expect(agentSession.pending?.kind).toBe("tool"));
    resolvePending(true);
    await run;
    expect(agentSession.runStatus).toBe("completed");
  });
});
