// 知识库工具包纯逻辑单测：标签解析、筛选联动、摘要、文件名归一。
// 这些函数三端共用，所以口径在这里锁死——手机端视图不再各写一遍。
import { describe, expect, it } from "vitest";
import { collectTags, excerpt, filterEntries, formatTags, matchEntry, parseTags, TEXT_EXTENSIONS, textStats, titleFromFile } from "./logic.js";

const entries = [
  { id: "a", title: "JWT 鉴权笔记", content: "access token 与 refresh token 的职责划分", tags: ["后端", "鉴权"], updatedAt: 100 },
  { id: "b", title: "待办", content: "把 Taro 小程序的构建脚本整理一下", tags: ["前端"], updatedAt: 300 },
  { id: "c", title: "运维速查", content: "nginx 反向代理与证书续期", tags: ["运维", "鉴权"], updatedAt: 200 },
];

describe("标签解析", () => {
  it("逗号/顿号/分号/空白/换行都是分隔符", () => {
    expect(parseTags("后端, 鉴权、Nginx；运维\n前端")).toEqual(["后端", "鉴权", "Nginx", "运维", "前端"]);
  });

  it("全角逗号与半角逗号等价", () => {
    expect(parseTags("a，b,c")).toEqual(["a", "b", "c"]);
  });

  it("去空、去重且保持输入顺序", () => {
    expect(parseTags("  a ,,a, b ,")).toEqual(["a", "b"]);
  });

  it("非字符串输入返回空数组而不是抛错", () => {
    expect(parseTags(null)).toEqual([]);
    expect(parseTags(undefined)).toEqual([]);
    expect(parseTags(123)).toEqual(["123"]);
  });

  it("formatTags 与 parseTags 互为逆运算", () => {
    expect(formatTags(parseTags("a、b，c"))).toBe("a, b, c");
    expect(formatTags(null)).toBe("");
  });
});

describe("标签集合", () => {
  it("按出现次数倒序，同次数按字典序", () => {
    expect(collectTags(entries)).toEqual(["鉴权", "前端", "后端", "运维"]);
  });

  it("忽略缺失 / 非法标签", () => {
    expect(collectTags([{ tags: null }, {}, { tags: ["x", "", 3] }])).toEqual(["x"]);
    expect(collectTags(null)).toEqual([]);
  });
});

describe("条目筛选", () => {
  it("关键词命中标题", () => {
    expect(matchEntry(entries[0], { keyword: "jwt" })).toBe(true);
  });

  it("关键词命中正文与标签", () => {
    expect(matchEntry(entries[0], { keyword: "refresh" })).toBe(true);
    expect(matchEntry(entries[0], { keyword: "后端" })).toBe(true);
  });

  it("标签是精确匹配，不是子串", () => {
    expect(matchEntry(entries[0], { tag: "鉴权" })).toBe(true);
    expect(matchEntry(entries[0], { tag: "鉴" })).toBe(false);
  });

  it("关键词与标签是「与」关系", () => {
    expect(matchEntry(entries[0], { keyword: "taro", tag: "后端" })).toBe(false);
    expect(matchEntry(entries[1], { keyword: "taro", tag: "前端" })).toBe(true);
  });

  it("空条件返回全部（筛选没填不该把所有东西藏起来）", () => {
    expect(filterEntries(entries).map((e) => e.id)).toEqual(["b", "c", "a"]);
  });

  it("结果是按更新时间倒序的新数组，不改动入参", () => {
    const filtered = filterEntries(entries, { tag: "鉴权" });
    expect(filtered.map((e) => e.id)).toEqual(["c", "a"]);
    expect(entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("updatedAt 是 ISO 字符串时也能排序（视图与同步写进来的形态不同）", () => {
    const mixed = [
      { id: "old", updatedAt: "2026-01-02T00:00:00Z" },
      { id: "new", updatedAt: "2026-03-02T00:00:00Z" },
      { id: "none" },
    ];
    expect(filterEntries(mixed).map((e) => e.id)).toEqual(["new", "old", "none"]);
  });
});

describe("摘要与统计", () => {
  it("摘要把换行与连续空白折叠成单空格", () => {
    expect(excerpt("第一行\n\n  第二行\t第三行")).toBe("第一行 第二行 第三行");
  });

  it("摘要超长时截断并加省略号", () => {
    const text = "x".repeat(30);
    expect(excerpt(text, 10)).toBe(`${"x".repeat(10)}…`);
    expect(excerpt(text, 30)).toBe(text);
    expect(excerpt(text, 40)).toBe(text);
  });

  it("空正文的统计为零而不是 1 行", () => {
    expect(textStats("")).toEqual({ chars: 0, lines: 0 });
    expect(textStats("a\nb")).toEqual({ chars: 3, lines: 2 });
  });
});

describe("文件名归一", () => {
  it("完整路径取基名并去扩展名", () => {
    expect(titleFromFile("/home/me/notes/JWT 笔记.md")).toBe("JWT 笔记");
    expect(titleFromFile("D:\\docs\\设计说明.docx")).toBe("设计说明");
  });

  it("没有扩展名或扩展名在开头时原样保留", () => {
    expect(titleFromFile("README")).toBe("README");
    expect(titleFromFile(".gitignore")).toBe(".gitignore");
  });

  it("空输入返回空串", () => {
    expect(titleFromFile(null)).toBe("");
    expect(titleFromFile("")).toBe("");
  });

  it("可导入的扩展名是纯文本类（PDF/DOCX 需正文抽取，不在列表里）", () => {
    expect(TEXT_EXTENSIONS).toContain("md");
    expect(TEXT_EXTENSIONS).toContain("txt");
    expect(TEXT_EXTENSIONS).not.toContain("pdf");
    expect(TEXT_EXTENSIONS).not.toContain("docx");
  });
});
