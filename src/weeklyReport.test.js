import { describe, it, expect } from "vitest";
import {
  DEFAULT_REPORT_SYSTEM,
  REPORT_SECTIONS,
  buildReportSystem,
  splitReportSamples,
  buildDistillPrompt,
  buildHeartPrompt,
  HEART_IMAGE_MAX,
  REPORT_STATUS,
  advanceReportStatus,
  recoverReportStatus,
  upsertReport,
  updateReportStatus,
  extractReportSection,
  replaceReportSection,
  truncate,
  SAMPLE_COUNT_MAX,
} from "./weeklyReport.js";

describe("truncate", () => {
  it("短文本原样返回", () => {
    expect(truncate("abc", 5)).toBe("abc");
  });
  it("超长截断并带省略号", () => {
    expect(truncate("abcdef", 4)).toBe("abcd…");
  });
  it("空值兜底为空串", () => {
    expect(truncate(null, 5)).toBe("");
    expect(truncate(undefined, 5)).toBe("");
  });
});

describe("buildReportSystem", () => {
  it("默认提示词包含固定三段结构", () => {
    for (const s of REPORT_SECTIONS) {
      expect(DEFAULT_REPORT_SYSTEM).toContain(s);
    }
  });
  it("无偏好时返回默认提示词", () => {
    expect(buildReportSystem()).toBe(DEFAULT_REPORT_SYSTEM);
    expect(buildReportSystem({})).toBe(DEFAULT_REPORT_SYSTEM);
    expect(buildReportSystem({ template: "  ", style: " " })).toBe(DEFAULT_REPORT_SYSTEM);
  });
  it("有模板时附加样本段", () => {
    const s = buildReportSystem({ template: "## 本周总结\n- 完成了一件事" });
    expect(s.startsWith(DEFAULT_REPORT_SYSTEM)).toBe(true);
    expect(s).toContain("【用户历史周报样本】");
    expect(s).toContain("完成了一件事");
  });
  it("有风格时附加风格段", () => {
    const s = buildReportSystem({ style: "喜欢用列表，篇幅简短" });
    expect(s).toContain("【用户的周报写作风格说明（必须遵循）】");
    expect(s).toContain("喜欢用列表");
  });
  it("模板与风格同时存在时模板段在前", () => {
    const s = buildReportSystem({ template: "T", style: "S" });
    expect(s.indexOf("【用户历史周报样本】")).toBeLessThan(s.indexOf("【用户的周报写作风格说明"));
  });
  it("超长模板与风格被截断", () => {
    const s = buildReportSystem({ template: "x".repeat(5000), style: "y".repeat(2000) });
    expect(s).toContain("…");
  });
});

describe("splitReportSamples", () => {
  it("空文本返回空数组", () => {
    expect(splitReportSamples("")).toEqual([]);
    expect(splitReportSamples("   \n\n  ")).toEqual([]);
  });
  it("无分隔线时整体算一份", () => {
    const r = splitReportSamples("第一行\n第二行");
    expect(r).toHaveLength(1);
    expect(r[0]).toBe("第一行\n第二行");
  });
  it("按 --- 分隔为多份", () => {
    const r = splitReportSamples("周报一\n---\n周报二\n---\n周报三");
    expect(r).toEqual(["周报一", "周报二", "周报三"]);
  });
  it("支持 === 与 *** 分隔", () => {
    const r = splitReportSamples("A\n===\nB\n***\nC");
    expect(r).toEqual(["A", "B", "C"]);
  });
  it("连续分隔线与首尾空段被忽略", () => {
    const r = splitReportSamples("---\nA\n---\n---\nB\n---");
    expect(r).toEqual(["A", "B"]);
  });
  it("最多取 SAMPLE_COUNT_MAX 份", () => {
    const r = splitReportSamples(Array.from({ length: 9 }, (_, i) => "第" + (i + 1) + "周").join("\n---\n"));
    expect(r).toHaveLength(SAMPLE_COUNT_MAX);
  });
  it("超长样本被截断", () => {
    const r = splitReportSamples("x".repeat(3000));
    expect(r[0].length).toBeLessThan(2100);
    expect(r[0].endsWith("…")).toBe(true);
  });
});

describe("buildDistillPrompt", () => {
  it("输出 system 与 user 消息", () => {
    const { system, user } = buildDistillPrompt(["周报A", "周报B"]);
    expect(system).toContain("周报写作风格分析师");
    expect(user).toContain("2 份历史周报");
    expect(user).toContain("周报A");
    expect(user).toContain("周报B");
  });
  it("超量样本被限制为 SAMPLE_COUNT_MAX", () => {
    const { user } = buildDistillPrompt(Array.from({ length: 10 }, (_, i) => "S" + i));
    expect(user).toContain(`${SAMPLE_COUNT_MAX} 份历史周报`);
  });
});

describe("buildHeartPrompt", () => {
  const report = "## 本周工作总结\n- 完成 A\n\n## 本周心得\n旧心得\n\n## 下周工作计划\n- B";
  it("带主题方向时写入主题", () => {
    const { system, user } = buildHeartPrompt("团队协作", report);
    expect(system).toContain("本周心得");
    expect(user).toContain("【主题方向】团队协作");
    expect(user).toContain(report);
  });
  it("无主题方向时标注自由发挥", () => {
    const { user } = buildHeartPrompt("", report);
    expect(user).toContain("（无，自由发挥）");
  });
  it("带图片时 user 变为内容块数组", () => {
    const { system, user } = buildHeartPrompt("", report, ["data:image/png;base64,AAA", "data:image/png;base64,BBB"]);
    expect(system).toContain("图片素材");
    expect(Array.isArray(user)).toBe(true);
    expect(user[0].type).toBe("text");
    expect(user[0].text).toContain("【图片素材】共 2 张");
    expect(user.filter((c) => c.type === "image_url")).toHaveLength(2);
    expect(user[1].image_url.url).toBe("data:image/png;base64,AAA");
  });
  it("图片超过上限时截取", () => {
    const imgs = Array.from({ length: 6 }, (_, i) => `data:image/png;base64,${i}`);
    const { user } = buildHeartPrompt("", report, imgs);
    expect(user.filter((c) => c.type === "image_url")).toHaveLength(HEART_IMAGE_MAX);
    expect(user[0].text).toContain(`共 ${HEART_IMAGE_MAX} 张`);
  });
});

describe("周报历史管理", () => {
  it("状态标签映射完整", () => {
    expect(REPORT_STATUS.pending).toBe("新建");
    expect(REPORT_STATUS.confirmed).toBe("确认");
    expect(REPORT_STATUS.archived).toBe("归档");
  });
  it("状态前进：新建→确认→归档，归档不再前进", () => {
    expect(advanceReportStatus("pending")).toBe("confirmed");
    expect(advanceReportStatus("confirmed")).toBe("archived");
    expect(advanceReportStatus("archived")).toBe("archived");
    expect(advanceReportStatus("unknown")).toBe("unknown");
  });
  it("归档可恢复为确认，其余状态不变", () => {
    expect(recoverReportStatus("archived")).toBe("confirmed");
    expect(recoverReportStatus("pending")).toBe("pending");
    expect(recoverReportStatus("confirmed")).toBe("confirmed");
  });
  it("upsert：空列表新增一条（状态新建、插在最前）", () => {
    const { list, item, created } = upsertReport([], { range: "this", rangeLabel: "本周", text: "## 本周工作总结\n内容" });
    expect(created).toBe(true);
    expect(list).toHaveLength(1);
    expect(item.status).toBe("pending");
    expect(item.rangeLabel).toBe("本周");
    expect(item.id).toBeTruthy();
    expect(list[0]).toBe(item);
  });
  it("upsert：同 range 已有新建草稿则更新而非新增", () => {
    const first = upsertReport([], { range: "this", rangeLabel: "本周", text: "v1" });
    const second = upsertReport(first.list, { range: "this", rangeLabel: "本周", text: "v2" });
    expect(second.created).toBe(false);
    expect(second.list).toHaveLength(1);
    expect(second.item.text).toBe("v2");
    expect(second.item.id).toBe(first.item.id);
  });
  it("upsert：同 range 已确认后再次保存会另起一条新建草稿", () => {
    const first = upsertReport([], { range: "this", rangeLabel: "本周", text: "v1" });
    const confirmed = updateReportStatus(first.list, first.item.id, "confirmed");
    const second = upsertReport(confirmed, { range: "this", rangeLabel: "本周", text: "v2" });
    expect(second.created).toBe(true);
    expect(second.list).toHaveLength(2);
    expect(second.list.filter((r) => r.status === "pending")).toHaveLength(1);
    expect(second.list.filter((r) => r.status === "confirmed")).toHaveLength(1);
  });
  it("upsert：不同 range 各自独立", () => {
    const a = upsertReport([], { range: "this", rangeLabel: "本周", text: "本周" });
    const b = upsertReport(a.list, { range: "last", rangeLabel: "上周", text: "上周" });
    expect(b.list).toHaveLength(2);
    expect(b.created).toBe(true);
  });
  it("updateReportStatus：按 id 更新并保留其他字段", () => {
    const { list } = upsertReport([], { range: "this", rangeLabel: "本周", text: "x" });
    const out = updateReportStatus(list, list[0].id, "confirmed");
    expect(out[0].status).toBe("confirmed");
    expect(out[0].text).toBe("x");
    expect(out[0].rangeLabel).toBe("本周");
  });
  it("updateReportStatus：找不到 id 原样返回", () => {
    const { list } = upsertReport([], { range: "this", rangeLabel: "本周", text: "x" });
    const out = updateReportStatus(list, "nope", "confirmed");
    expect(out).toEqual(list);
  });
});

describe("extractReportSection", () => {
  const report = "## 本周工作总结\n- 完成 A\n\n## 本周心得\n这是心得。\n多行心得。\n\n## 下周工作计划\n- B";
  it("提取指定小节内容（不含标题）", () => {
    expect(extractReportSection(report, "本周心得")).toBe("这是心得。\n多行心得。");
  });
  it("提取第一个小节", () => {
    expect(extractReportSection(report, "本周工作总结")).toBe("- 完成 A");
  });
  it("小节是最后一段也能提取", () => {
    expect(extractReportSection(report, "下周工作计划")).toBe("- B");
  });
  it("标题不存在返回空串", () => {
    expect(extractReportSection(report, "不存在的标题")).toBe("");
  });
  it("空文本返回空串", () => {
    expect(extractReportSection("", "本周心得")).toBe("");
  });
});

describe("replaceReportSection", () => {
  const report = "## 本周工作总结\n- 完成 A\n\n## 本周心得\n旧心得。\n\n## 下周工作计划\n- B";
  it("替换指定小节，其余不变", () => {
    const out = replaceReportSection(report, "本周心得", "新心得。");
    expect(out).toContain("## 本周心得\n\n新心得。");
    expect(out).toContain("- 完成 A");
    expect(out).toContain("- B");
    expect(out).not.toContain("旧心得。");
  });
  it("替换最后一个小节", () => {
    const out = replaceReportSection(report, "下周工作计划", "- C");
    expect(out).toContain("## 下周工作计划\n\n- C");
    expect(out).not.toContain("- B");
  });
  it("标题不存在时原样返回", () => {
    const out = replaceReportSection(report, "不存在的标题", "X");
    expect(out).toBe(report);
  });
  it("替换后不产生连续空行", () => {
    const out = replaceReportSection(report, "本周心得", "新心得。");
    expect(out).not.toMatch(/\n{3,}/);
  });
});
