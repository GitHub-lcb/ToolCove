import { describe, expect, it } from "vitest";
import { EXPORT_CLIP, exportBlock, runToMarkdown } from "./runExport.js";

// 测试里用最小字典：导出是纯函数，只要求键回显稳定
const t = (key, params = {}) => {
  const dict = {
    "agent.exportTitle": "运行日志",
    "agent.exportGoal": "目标",
    "agent.exportStatus": "状态",
    "agent.exportRunId": "运行 ID",
    "agent.exportTime": "时间",
    "agent.exportModel": "模型",
    "agent.exportUsage": "用量",
    "agent.exportAttachments": "附件",
    "agent.exportSteps": "执行步骤",
    "agent.exportNoSteps": "（没有步骤）",
    "agent.exportAnswer": "最终答复",
    "agent.exportError": "错误",
    "agent.exportEmpty": "（空）",
    "agent.exportAttempt": "第 {n} 次尝试：{status}",
    "agent.modelCalls": "模型请求",
    "agent.statusSuccess": "已完成",
    "agent.statusFailed": "失败",
    "agent.statusRunning": "运行中",
    "agent.stepError": "出错",
    "agent.confirmAllow": "允许",
    "agent.confirmDeny": "拒绝",
    "agent.stepConfirm": "等待确认",
    "agent.approvalAllowed": "策略放行",
    "agent.approvalDenied": "已拒绝",
    "agent.approvalPending": "待决定",
    "agent.statusCancelled": "已取消",
    "agent.statusMaxSteps": "步数上限",
  };
  return String(dict[key] ?? key).replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? ""));
};

const run = (over = {}) => ({
  id: "r1",
  input: "把订单导成 CSV",
  status: "success",
  createdAt: Date.UTC(2026, 9, 19, 1, 30),
  finishedAt: Date.UTC(2026, 9, 19, 1, 42),
  usage: { calls: 3, totalTokens: 12345 },
  steps: [
    { type: "tool_start", id: "c1", tool: "file.read_text", args: { path: "E:\\a.json" }, attempt: 1 },
    { type: "tool_result", id: "c1", tool: "file.read_text", result: { text: "{\"a\":1}" } },
    { type: "notice", code: "tool_clip", text: "结果被裁剪" },
    { type: "final", answer: "已导出 12 行" },
  ],
  ...over,
});

describe("导出运行日志", () => {
  it("模型快照写进导出；配置名与模型不同时一并标注", () => {
    expect(runToMarkdown(run({ model: "deepseek-chat", modelProfile: "主力" }), t)).toContain("- 模型: deepseek-chat (主力)");
    expect(runToMarkdown(run({ model: "deepseek-chat", modelProfile: "deepseek-chat" }), t)).toContain("- 模型: deepseek-chat");
    expect(runToMarkdown(run(), t)).not.toContain("- 模型:");
  });

  it("目标、状态、用量、步骤与最终答复都在", () => {
    const md = runToMarkdown(run(), t);
    expect(md).toContain("# 运行日志");
    expect(md).toContain("把订单导成 CSV");
    expect(md).toContain("已完成");
    expect(md).toContain("3");
    expect(md).toContain("12345");
    expect(md).toContain("file.read_text");
    // 参数以 JSON 代码块导出：Windows 路径里的反斜杠会被 JSON 转义，这里只认路径本身
    expect(md).toContain("a.json");
    expect(md).toContain("结果被裁剪");
    expect(md).toContain("已导出 12 行");
  });

  it("附件写成可定位的完整路径", () => {
    const md = runToMarkdown(run({ attachments: [{ path: "E:\\in\\a.json" }, { name: "粘贴.txt", content: "x" }] }), t);
    expect(md).toContain("## 附件");
    expect(md).toContain("E:\\in\\a.json");
    expect(md).toContain("粘贴.txt");
  });

  it("没有步骤时给一句说明，不留下一个空标题", () => {
    const md = runToMarkdown(run({ steps: [] }), t);
    expect(md).toContain("（没有步骤）");
  });

  it("失败运行带上错误原文", () => {
    const md = runToMarkdown(run({ status: "failed", error: "HTTP 401：无效密钥" }), t);
    expect(md).toContain("## 错误");
    expect(md).toContain("HTTP 401");
  });

  it("空值 / 畸形入参不抛错", () => {
    expect(runToMarkdown(null, t)).toContain("# 运行日志");
    expect(runToMarkdown({}, t)).toContain("（空）");
  });

  it("长参数截断并标注原始长度", () => {
    const block = exportBlock("x".repeat(EXPORT_CLIP + 100));
    expect(block.length).toBeLessThan(EXPORT_CLIP + 100);
    expect(block).toContain("已截断");
    expect(block).toContain(String(EXPORT_CLIP + 100));
  });
});
