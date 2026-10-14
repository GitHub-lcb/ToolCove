// 装配层（generateWeeklyDraft / archiveDraftToSnippet）的单测：mock 掉 invoke 与 AI，
// 只验证「无素材跳过、无 AI 跳过、成功落 pending 草稿、已有草稿则更新而非新增」这些业务判据。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fmtDate } from "../shared/dates.js";

vi.mock("../data/repository.js", () => ({ load: vi.fn(), create: vi.fn() }));
vi.mock("../platform/invoke.js", () => ({ invoke: vi.fn() }));
vi.mock("../ai.js", () => ({ aiComplete: vi.fn(), isAIConfigured: vi.fn() }));

import { load, create } from "../data/repository.js";
import { invoke } from "../platform/invoke.js";
import { aiComplete, isAIConfigured } from "../ai.js";
import { generateWeeklyDraft, archiveDraftToSnippet } from "./index.js";

// 一条落在「今天」的子任务工时（今天必在本周范围内，跨时区/跨日都成立）
function iterationsWithToday() {
  return [
    {
      id: "i1",
      title: "迭代A",
      items: [{ id: "r1", name: "需求1", subtasks: [{ id: "s1", name: "子任务a", hours: 3, date: fmtDate(new Date()) }] }],
    },
  ];
}

let storage;

beforeEach(() => {
  storage = { settings: { displayName: "Me" }, reportPrefs: {}, reports: [] };
  invoke.mockReset();
  invoke.mockImplementation(async (cmd, args = {}) => {
    if (cmd === "load_data") return storage[args.key];
    if (cmd === "save_data") {
      storage[args.key] = args.data;
      return null;
    }
    return null;
  });
  load.mockReset();
  load.mockImplementation(async () => []);
  create.mockReset();
  create.mockResolvedValue({ id: "s1", title: "t" });
  aiComplete.mockReset();
  isAIConfigured.mockReset();
});

describe("generateWeeklyDraft", () => {
  it("无素材：返回 no-material，不调用 AI、不落盘", async () => {
    const res = await generateWeeklyDraft();
    expect(res).toEqual({ ok: false, reason: "no-material" });
    expect(isAIConfigured).not.toHaveBeenCalled();
    expect(aiComplete).not.toHaveBeenCalled();
    expect(storage.reports).toEqual([]);
  });

  it("有素材但未配置 AI：返回 no-ai，不生成也不落盘", async () => {
    load.mockImplementation(async (kind) => (kind === "iterations" ? iterationsWithToday() : []));
    isAIConfigured.mockResolvedValue(false);
    const res = await generateWeeklyDraft();
    expect(res).toEqual({ ok: false, reason: "no-ai" });
    expect(aiComplete).not.toHaveBeenCalled();
    expect(storage.reports).toEqual([]);
  });

  it("成功：调用 AI 并写入 reports（状态保持 pending，range=this）", async () => {
    load.mockImplementation(async (kind) => (kind === "iterations" ? iterationsWithToday() : []));
    isAIConfigured.mockResolvedValue(true);
    aiComplete.mockResolvedValue("## 本周工作总结\n完成了 A");
    const res = await generateWeeklyDraft();
    expect(res.ok).toBe(true);
    expect(res.text).toContain("完成了 A");
    expect(res.range.label).toBe("本周");
    expect(storage.reports).toHaveLength(1);
    expect(storage.reports[0]).toMatchObject({ range: "this", status: "pending", rangeLabel: "本周" });
    expect(storage.reports[0].text).toContain("完成了 A");
  });

  it("同 range 已有 pending 草稿：更新内容而非新增（条数不变、id 不变）", async () => {
    load.mockImplementation(async (kind) => (kind === "iterations" ? iterationsWithToday() : []));
    isAIConfigured.mockResolvedValue(true);
    aiComplete.mockResolvedValue("新内容");
    storage.reports = [
      { id: "old", range: "this", rangeLabel: "本周", text: "旧内容", status: "pending", createdAt: "x", updatedAt: "2026-01-01T00:00:00.000Z" },
    ];
    await generateWeeklyDraft();
    expect(storage.reports).toHaveLength(1);
    expect(storage.reports[0].id).toBe("old");
    expect(storage.reports[0].text).toBe("新内容");
    expect(storage.reports[0].status).toBe("pending");
  });

  it("AI 返回空串：视为无素材，不落盘", async () => {
    load.mockImplementation(async (kind) => (kind === "iterations" ? iterationsWithToday() : []));
    isAIConfigured.mockResolvedValue(true);
    aiComplete.mockResolvedValue("");
    const res = await generateWeeklyDraft();
    expect(res.ok).toBe(false);
    expect(storage.reports).toEqual([]);
  });
});

describe("archiveDraftToSnippet", () => {
  it("复用 repository.create 写 snippets，带 source=report 与「周报」标签", async () => {
    await archiveDraftToSnippet({ rangeLabel: "本周", text: "周报正文" });
    expect(create).toHaveBeenCalledTimes(1);
    const [kind, draft, options] = create.mock.calls[0];
    expect(kind).toBe("snippets");
    expect(draft).toMatchObject({ title: "本周 周报", content: "周报正文", tags: ["周报"], pinned: false });
    expect(options).toMatchObject({ source: "report" });
  });

  it("空报告不写入", async () => {
    await archiveDraftToSnippet(null);
    expect(create).not.toHaveBeenCalled();
  });
});
