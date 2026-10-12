// src/shared/links.js 的纯函数单测（从原 508 行的 shared.test.js 按领域拆出来）。
import { describe, it, expect } from "vitest";
import { bugStatusInfo, extractCode, parseIssueUrl } from "./links.js";describe("extractCode", () => {
  it("从完整链接提取编号", () => {
    expect(extractCode("https://team.coding.net/p/foo/backlog/issues/123/detail")).toBe("#123");
  });
  it("纯编号 / 带 # 编号", () => {
    expect(extractCode("#456")).toBe("#456");
    expect(extractCode("456")).toBe("#456");
  });
  it("空 / 无效输入返回空串", () => {
    expect(extractCode("")).toBe("");
    expect(extractCode("abc")).toBe("");
  });
});

describe("parseIssueUrl", () => {
  it("解析项目名与事项编号", () => {
    expect(parseIssueUrl("https://team.coding.net/p/myproj/backlog/issues/789/detail")).toEqual({ projectName: "myproj", issueCode: 789 });
  });
  it("bug 链接 / 纯编号兜底", () => {
    expect(parseIssueUrl("https://team.coding.net/p/p2/bugs/1001")).toEqual({ projectName: "p2", issueCode: 1001 });
    expect(parseIssueUrl("999")).toEqual({ projectName: "", issueCode: 999 });
  });
  it("无法解析返回 null", () => {
    expect(parseIssueUrl("")).toBeNull();
    expect(parseIssueUrl("随便什么")).toBeNull();
  });
});

describe("bugStatusInfo", () => {
  it("COMPLETED 类型归 done", () => {
    expect(bugStatusInfo("随便", "COMPLETED").tone).toBe("done");
  });
  it("名称关键词归类", () => {
    expect(bugStatusInfo("已完成").tone).toBe("done");
    expect(bugStatusInfo("处理中").tone).toBe("active");
    expect(bugStatusInfo("待修复").tone).toBe("pending");
  });
  it("空状态归 unknown", () => {
    expect(bugStatusInfo("").tone).toBe("unknown");
  });
});
