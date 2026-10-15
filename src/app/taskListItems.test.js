// 侧边栏会话列表投影纯函数单测：行截取 / 标题派生 / 时间分组 / 搜索 / 工作面分组 /
// agent 不可隐藏语义。
import { describe, it, expect } from "vitest";
import {
  buildTaskItems,
  conversationTitle,
  filterTaskItems,
  groupKeyFor,
  groupNavModules,
  groupTaskItems,
  HISTORY_GROUPS,
  TASK_LIST_LIMIT,
  TITLE_MAX,
} from "./taskListItems.js";
import { NAV_MODULES } from "./navConfig.js";

describe("buildTaskItems", () => {
  const run = (id, over = {}) => ({ id, input: "目标 " + id, status: "completed", createdAt: 100, updatedAt: 200, ...over });

  it("取前 limit 条并保持原序（runs 已是最新在前，不重排）", () => {
    const runs = Array.from({ length: 30 }, (_, i) => run("r" + i));
    const items = buildTaskItems(runs);
    expect(items).toHaveLength(TASK_LIST_LIMIT);
    expect(items[0].id).toBe("r0");
    expect(items[items.length - 1].id).toBe("r" + (TASK_LIST_LIMIT - 1));
  });

  it("只投影渲染所需字段，updatedAt 缺时退回 createdAt", () => {
    const items = buildTaskItems([run("r1", { history: [1], steps: [2], usage: { calls: 3 } }), run("r2", { updatedAt: 0, createdAt: 50 })]);
    expect(items[0]).toEqual({ id: "r1", status: "completed", input: "目标 r1", title: "目标 r1", updatedAt: 200 });
    expect(items[1].updatedAt).toBe(50);
  });

  it("limit 可配；缺字段与脏记录有兜底", () => {
    expect(buildTaskItems([run("r1"), run("r2"), run("r3")], { limit: 2 }).map((x) => x.id)).toEqual(["r1", "r2"]);
    expect(buildTaskItems([{ id: "r9" }, null, {}])[0]).toEqual({ id: "r9", status: "", input: "", title: "", updatedAt: 0 });
  });

  it("非数组输入返回空数组", () => {
    expect(buildTaskItems(null)).toEqual([]);
    expect(buildTaskItems(undefined)).toEqual([]);
    expect(buildTaskItems("runs")).toEqual([]);
  });
});

describe("conversationTitle", () => {
  it("多行目标只留首行语义：换行与连续空白压成单空格", () => {
    expect(conversationTitle("合并两个 PDF\n输出到 下载 目录")).toBe("合并两个 PDF 输出到 下载 目录");
    expect(conversationTitle("  多余   空白  ")).toBe("多余 空白");
  });

  it("去掉结尾收尾标点（标题不该以句号结束）", () => {
    expect(conversationTitle("把这段 JSON 格式化。")).toBe("把这段 JSON 格式化");
    expect(conversationTitle("帮我查一下；")).toBe("帮我查一下");
  });

  it("超长时在断句处切，切出来是短语而不是半句话", () => {
    // 逗号落在预算内靠后的位置：应从逗号处断开，而不是在第 42 个字符硬切
    const input = "读取 order.json 找出重复字段并导出 csv，同时把重复项汇总成一张表另外再给我一份统计";
    const title = conversationTitle(input);
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX + 1);
    expect(title.startsWith("读取 order.json 找出重复字段并导出 csv")).toBe(true);
    expect(title.endsWith("，")).toBe(false);
    expect(input.startsWith(title)).toBe(true);
  });

  it("没有断句点时硬截并补省略号（用户能看出被截断了）", () => {
    const title = conversationTitle("a".repeat(100));
    expect(title).toBe("a".repeat(TITLE_MAX) + "…");
  });

  it("断句点太靠前就不切——否则会切出一个字的标题", () => {
    // 「你好。」落在预算的 1/2 之前，应改为硬截而不是切成「你好」
    const title = conversationTitle("你好。" + "很长的一段没有标点的目标描述".repeat(4));
    expect(title.length).toBeGreaterThan(2);
  });

  it("空值与非法输入返回空串", () => {
    expect(conversationTitle("")).toBe("");
    expect(conversationTitle("   ")).toBe("");
    expect(conversationTitle(null)).toBe("");
    expect(conversationTitle(undefined)).toBe("");
    expect(conversationTitle(123)).toBe("");
  });

  it("max 可配，且坏值退回默认上限", () => {
    expect(conversationTitle("abcdefghij", { max: 4 })).toBe("abcd…");
    expect(conversationTitle("a".repeat(TITLE_MAX + 5), { max: 0 }).length).toBe(TITLE_MAX + 1);
  });
});

describe("groupKeyFor / groupTaskItems", () => {
  // 固定时间基准：2026-03-10 15:00 本地时间
  const NOW = new Date(2026, 2, 10, 15, 0, 0).getTime();
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).getTime();
  const item = (id, updatedAt, status = "completed") => ({ id, title: id, input: id, status, updatedAt });

  it("进行中/等待中单独成组，优先级高于时间", () => {
    expect(groupKeyFor(item("a", NOW, "running"), NOW)).toBe("running");
    expect(groupKeyFor(item("a", NOW, "pending"), NOW)).toBe("running");
    // 昨天的运行中记录仍归 running：状态比时间更能说明「现在要看它」
    expect(groupKeyFor(item("a", at(2026, 3, 9), "running"), NOW)).toBe("running");
  });

  it("按本地自然日分组：23:59 与 00:01 跨天就算跨组", () => {
    expect(groupKeyFor(item("a", at(2026, 3, 10, 0)), NOW)).toBe("today");
    expect(groupKeyFor(item("a", at(2026, 3, 9, 23)), NOW)).toBe("yesterday");
    // 边界：距今正好 7 个日历天仍算「最近 7 天」，第 8 天才落到「更早」
    expect(groupKeyFor(item("a", at(2026, 3, 3, 0)), NOW)).toBe("week");
    expect(groupKeyFor(item("a", at(2026, 3, 2, 23)), NOW)).toBe("older");
  });

  it("缺时间戳归「更早」，不炸也不误判成今天", () => {
    expect(groupKeyFor({ id: "a", status: "completed" }, NOW)).toBe("older");
    expect(groupKeyFor(null, NOW)).toBe("older");
  });

  it("分组保持原顺序、空组不出现", () => {
    const items = [
      item("new", at(2026, 3, 10, 14)),
      item("run", at(2026, 3, 10, 13), "running"),
      item("old", at(2026, 3, 1)),
    ];
    const groups = groupTaskItems(items, { now: NOW });
    expect(groups.map((g) => g.key)).toEqual(["running", "today", "older"]);
    expect(groups[0].items.map((x) => x.id)).toEqual(["run"]);
    expect(groups[1].items.map((x) => x.id)).toEqual(["new"]);
    expect(groups[2].items.map((x) => x.id)).toEqual(["old"]);
  });

  it("非数组输入返回空数组；空列表不产生任何分组", () => {
    expect(groupTaskItems(null, { now: NOW })).toEqual([]);
    expect(groupTaskItems([], { now: NOW })).toEqual([]);
  });

  it("分组 key 集合稳定（组件按它渲染顺序与词条）", () => {
    expect([...HISTORY_GROUPS]).toEqual(["running", "today", "yesterday", "week", "older"]);
  });
});

describe("filterTaskItems", () => {
  const items = buildTaskItems([
    { id: "r1", input: "合并两个 PDF 文件", status: "completed", createdAt: 1, updatedAt: 2 },
    { id: "r2", input: "把 order.json 导出 CSV", status: "completed", createdAt: 1, updatedAt: 2 },
  ]);

  it("空查询原样返回（调用方据此决定是否显示分组头）", () => {
    expect(filterTaskItems(items, "")).toBe(items);
    expect(filterTaskItems(items, "   ")).toBe(items);
    expect(filterTaskItems(items, null)).toBe(items);
  });

  it("大小写不敏感，且匹配标题与目标全文", () => {
    expect(filterTaskItems(items, "csv").map((x) => x.id)).toEqual(["r2"]);
    expect(filterTaskItems(items, "CSV").map((x) => x.id)).toEqual(["r2"]);
    // 标题是压过空白的版本，用户按标题里看到的词必须能搜到
    expect(filterTaskItems(items, "pdf 文件").map((x) => x.id)).toEqual(["r1"]);
  });

  it("无命中返回空数组；limit 可配", () => {
    expect(filterTaskItems(items, "不存在的词")).toEqual([]);
    expect(filterTaskItems(items, "o", { limit: 1 })).toHaveLength(1);
  });

  it("非数组输入返回空数组", () => {
    expect(filterTaskItems(null, "a")).toEqual([]);
  });
});

describe("groupNavModules", () => {
  it("按 hiddenModules 过滤工作面三项", () => {
    expect(groupNavModules(NAV_MODULES, []).map((m) => m.key)).toEqual(["work", "records", "toolbox"]);
    expect(groupNavModules(NAV_MODULES, ["records"]).map((m) => m.key)).toEqual(["work", "toolbox"]);
    expect(groupNavModules(NAV_MODULES, ["work", "records", "toolbox"])).toEqual([]);
  });

  it("agent 永不入组：即使 hiddenKeys 含 agent 也只是剔除它，不影响其余", () => {
    // v9 迁移前的历史脏值里可能藏着 "agent"——它是默认主区，藏起来就没有主区了
    expect(groupNavModules(NAV_MODULES, ["agent"]).map((m) => m.key)).toEqual(["work", "records", "toolbox"]);
    expect(groupNavModules(NAV_MODULES, ["agent", "work"]).map((m) => m.key)).toEqual(["records", "toolbox"]);
  });

  it("非数组输入有兜底", () => {
    expect(groupNavModules(null, null)).toEqual([]);
    expect(groupNavModules(NAV_MODULES, null).map((m) => m.key)).toEqual(["work", "records", "toolbox"]);
  });
});
