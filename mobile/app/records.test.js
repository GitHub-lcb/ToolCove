import { describe, expect, it } from "vitest";
import {
  EDITABLE_FIELDS,
  RECORD_KINDS,
  dayBucket,
  fieldCount,
  filterByStatus,
  filterRecords,
  recordSummary,
  sortRecords,
  toPayload,
} from "./records.js";

const snippet = (over = {}) => ({ id: "s1", title: "标题", content: "内容", createdAt: 1000, updatedAt: 1000, ...over });

describe("sortRecords", () => {
  it("置顶优先，其次按更新时间倒序", () => {
    const list = [
      snippet({ id: "a", updatedAt: 100 }),
      snippet({ id: "b", updatedAt: 300 }),
      snippet({ id: "c", updatedAt: 200, pinned: true }),
    ];
    expect(sortRecords(list).map((r) => r.id)).toEqual(["c", "b", "a"]);
  });

  it("时间相同用 id 兜底，保证顺序稳定（避免每次渲染都跳动）", () => {
    const list = [snippet({ id: "b", updatedAt: 100 }), snippet({ id: "a", updatedAt: 100 })];
    expect(sortRecords(list).map((r) => r.id)).toEqual(["a", "b"]);
    expect(sortRecords(sortRecords(list)).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("updatedAt 缺失时回落到 createdAt；两者都缺排最后", () => {
    const list = [snippet({ id: "none", createdAt: 0, updatedAt: 0 }), snippet({ id: "old", createdAt: 50, updatedAt: undefined })];
    expect(sortRecords(list).map((r) => r.id)).toEqual(["old", "none"]);
  });

  it("容忍坏输入（坏条目排最后，不让它们插队到正常记录前面）", () => {
    expect(sortRecords()).toEqual([]);
    expect(sortRecords([null, 7, snippet({ id: "ok" })]).map((r) => r?.id ?? "bad")).toEqual(["ok", "bad", "bad"]);
  });
});

describe("filterRecords", () => {
  const list = [
    snippet({ id: "1", title: "数据库连接", content: "jdbc:mysql://host:3306" }),
    snippet({ id: "2", title: "咖啡机", category: "生活", content: "三楼茶水间" }),
    snippet({ id: "3", title: "接口文档", fields: [{ label: "地址", value: "https://api.example.com" }] }),
  ];

  it("匹配标题、正文、分类、字段", () => {
    expect(filterRecords(list, "数据库").map((r) => r.id)).toEqual(["1"]);
    expect(filterRecords(list, "3306").map((r) => r.id)).toEqual(["1"]);
    expect(filterRecords(list, "生活").map((r) => r.id)).toEqual(["2"]);
    expect(filterRecords(list, "example.com").map((r) => r.id)).toEqual(["3"]);
    expect(filterRecords(list, "地址").map((r) => r.id)).toEqual(["3"]);
  });

  it("大小写不敏感；空关键词返回全部", () => {
    expect(filterRecords(list, "API").map((r) => r.id)).toEqual(["3"]);
    expect(filterRecords(list, "  ")).toHaveLength(3);
  });

  it("问题类型的标签与解决说明也参与匹配", () => {
    const problems = [{ id: "p1", title: "登录偶发失败", tags: ["线上", "鉴权"], note: "", resolution: "刷新 token" }];
    expect(filterRecords(problems, "鉴权")).toHaveLength(1);
    expect(filterRecords(problems, "刷新")).toHaveLength(1);
    expect(filterRecords(problems, "不存在")).toHaveLength(0);
  });
});

describe("recordSummary", () => {
  it("压成单行并限长", () => {
    expect(recordSummary({ content: "第一行\n\n第二行  第三行" })).toBe("第一行 第二行 第三行");
    expect(recordSummary({ content: "x".repeat(100) }, 10)).toBe("xxxxxxxxxx…");
  });

  it("速记取 content、问题取 note；都空返回空串", () => {
    expect(recordSummary({ note: "问题的备注" })).toBe("问题的备注");
    expect(recordSummary({})).toBe("");
    expect(recordSummary(null)).toBe("");
  });
});

describe("fieldCount / dayBucket", () => {
  it("只数有值的字段", () => {
    expect(fieldCount({ fields: [{ value: "a" }, { value: "  " }, {}] })).toBe(1);
    expect(fieldCount({})).toBe(0);
  });

  it("按自然日分桶", () => {
    const now = new Date("2026-09-20T10:00:00").getTime();
    const at = (iso) => new Date(iso).getTime();
    expect(dayBucket({ updatedAt: at("2026-09-20T09:00:00") }, now)).toBe("today");
    expect(dayBucket({ updatedAt: at("2026-09-19T23:00:00") }, now)).toBe("yesterday");
    expect(dayBucket({ updatedAt: at("2026-09-01T09:00:00") }, now)).toBe("earlier");
    expect(dayBucket({}, now)).toBe("earlier");
  });
});

describe("filterByStatus", () => {
  const list = [{ id: "open", status: "open" }, { id: "done", resolvedAt: 123 }, { id: "res", status: "resolved" }];
  it("open/done/all 三态", () => {
    expect(filterByStatus(list, "open").map((r) => r.id)).toEqual(["open"]);
    expect(filterByStatus(list, "done").map((r) => r.id)).toEqual(["done", "res"]);
    expect(filterByStatus(list, "all")).toHaveLength(3);
    // 实现按「open / 其余」两分支：未知状态等同于 all，不会因为状态值意外而把列表筛空
    expect(filterByStatus(list, "bogus")).toHaveLength(3);
  });
});

describe("toPayload", () => {
  it("只保留白名单字段且必须有标题", () => {
    const payload = toPayload("snippets", { title: "  标题  ", content: "内容", evil: "x", id: "hack" });
    expect(payload).toEqual({ title: "标题", content: "内容" });
    expect(toPayload("snippets", { title: "   " })).toBe(null);
    expect(toPayload("unknown-kind", { title: "x" })).toBe(null);
  });

  it("数组字段（标签）会 trim 并去掉空项", () => {
    expect(toPayload("problems", { title: "t", tags: [" 线上 ", "", "  鉴权"] })).toEqual({ title: "t", tags: ["线上", "鉴权"] });
  });

  it("白名单内的字段才会传出（问题不得误改 status 之外的东西）", () => {
    const payload = toPayload("problems", { title: "t", status: "done", createdAt: 1, logs: [{ x: 1 }] });
    expect(Object.keys(payload).sort()).toEqual(["status", "title"]);
  });

  it("两种记录类型的白名单都在", () => {
    expect(EDITABLE_FIELDS.snippets).toContain("pinned");
    expect(EDITABLE_FIELDS.problems).toContain("resolution");
    expect(RECORD_KINDS.snippets.labelKey).toBe("nav.snippet");
  });
});
