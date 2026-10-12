import { describe, expect, it } from "vitest";
import en from "./i18n/en-US.json";
import zh from "./i18n/zh-CN.json";
import {
  buildExportPayload,
  categoriesOf,
  dedupeKey,
  exportPromptsJson,
  extractVariables,
  fillTemplate,
  filterPrompts,
  hasSample,
  normalizePromptDraft,
  normalizeTags,
  parsePromptsJson,
  SAMPLE_PROMPT_KEYS,
  samplePrompts,
  sortPrompts,
  splitImports,
  tagsOf,
  trimHistory,
  VAR_MAX_LEN,
} from "./promptLib.js";

const dictAt = (dict, path) => path.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), dict);

describe("提示词库：变量提取", () => {
  it("提取、去重、保序，支持中英文变量名与内部空白裁剪", () => {
    expect(extractVariables("a {{主题}} b {{style}} c {{主题}}")).toEqual(["主题", "style"]);
    expect(extractVariables("{{ a }} 与 {{a}} 是同一个")).toEqual(["a"]);
    expect(extractVariables("开头 {{名字}}", "负向也引用 {{名字}} 和 {{画风}}")).toEqual(["名字", "画风"]);
  });

  it("空变量、未闭合、跨行、超长都不算变量", () => {
    expect(extractVariables("{{}} {{a {{b}} {{a\nb}}")).toEqual(["b"]);
    expect(extractVariables(`{{${"x".repeat(VAR_MAX_LEN + 1)}}`)).toEqual([]);
    expect(extractVariables(null, undefined, 42)).toEqual([]);
  });

  it("大小写敏感：{{Topic}} 与 {{topic}} 是两个变量", () => {
    expect(extractVariables("{{Topic}} {{topic}}")).toEqual(["Topic", "topic"]);
  });
});

describe("提示词库：变量填充", () => {
  it("全填时输出成稿，无缺失", () => {
    const { output, missing } = fillTemplate("一只{{动物}}在{{场景}}", { 动物: "猫", 场景: "屋顶" });
    expect(output).toBe("一只猫在屋顶");
    expect(missing).toEqual([]);
  });

  it("未填变量保留原占位并计入 missing（去重保序），不禁用成稿", () => {
    const { output, missing } = fillTemplate("{{a}} 和 {{b}} 和 {{a}}", { b: "填了" });
    expect(output).toBe("{{a}} 和 填了 和 {{a}}");
    expect(missing).toEqual(["a"]);
  });

  it("值里含 {{x}} 不会被二次展开（单趟替换的回归锁）", () => {
    const { output, missing } = fillTemplate("{{a}}", { a: "{{b}}" });
    expect(output).toBe("{{b}}");
    expect(missing).toEqual([]);
  });

  it("空白值视为未填；空文本原样返回", () => {
    expect(fillTemplate("{{a}}", { a: "   " }).missing).toEqual(["a"]);
    expect(fillTemplate("", {}).output).toBe("");
    expect(fillTemplate(null, {}).output).toBe("");
  });
});

describe("提示词库：标签与草稿归一", () => {
  it("normalizeTags 按中英标点与空白切分、去重", () => {
    expect(normalizeTags("a, b，c、d; e；f g  a")).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
    expect(normalizeTags(["x", " x ", "y"])).toEqual(["x", "y"]);
    expect(normalizeTags(null)).toEqual([]);
  });

  it("normalizePromptDraft 兼容 content 别名、title 取首行、target 枚举收口", () => {
    const draft = normalizePromptDraft({ content: "第一行标题\n正文", target: "weird", tags: "a b" });
    expect(draft).toEqual({
      title: "第一行标题",
      positive: "第一行标题\n正文",
      negative: "",
      target: "image",
      category: "",
      tags: ["a", "b"],
      note: "",
      pinned: false,
    });
    expect(normalizePromptDraft({ positive: "x", target: "video" }).target).toBe("video");
  });

  it("positive 为空或超长的草稿无效", () => {
    expect(normalizePromptDraft({ title: "只有标题" })).toBeNull();
    expect(normalizePromptDraft({ positive: "y".repeat(100_001) })).toBeNull();
    expect(normalizePromptDraft(null)).toBeNull();
  });
});

describe("提示词库：排序与过滤", () => {
  const rows = [
    { id: "a", title: "猫猫肖像", positive: "a cat", category: "摄影", tags: ["写实"], updatedAt: 100, pinned: false },
    { id: "b", title: "动画场景", positive: "anime {{风格}}", category: "动漫", tags: ["二次元", "写实"], updatedAt: 300, pinned: false },
    { id: "c", title: "置顶条目", positive: "pin", category: "摄影", updatedAt: 50, pinned: true },
  ];

  it("sortPrompts：置顶优先 → updatedAt 倒序 → id 兜底", () => {
    expect(sortPrompts(rows).map((r) => r.id)).toEqual(["c", "b", "a"]);
    const same = [
      { id: "z", updatedAt: 0, pinned: false },
      { id: "y", updatedAt: 0, pinned: false },
    ];
    expect(sortPrompts(same).map((r) => r.id)).toEqual(["y", "z"]);
  });

  it("filterPrompts：关键词命 title/positive/tags，大小写不敏感", () => {
    expect(filterPrompts(rows, { keyword: "cat" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterPrompts(rows, { keyword: "风格" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterPrompts(rows, { keyword: "写实" }).map((r) => r.id)).toEqual(["a", "b"]);
    expect(filterPrompts(rows, { keyword: "  " }).map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("filterPrompts：分类与标签精确匹配，三条件为与", () => {
    expect(filterPrompts(rows, { category: "摄影" }).map((r) => r.id)).toEqual(["a", "c"]);
    expect(filterPrompts(rows, { tag: "写实" }).map((r) => r.id)).toEqual(["a", "b"]);
    expect(filterPrompts(rows, { category: "摄影", tag: "写实" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterPrompts(rows, { category: "不存在" })).toEqual([]);
  });

  it("categoriesOf / tagsOf 首次出现序去重", () => {
    expect(categoriesOf(rows)).toEqual(["摄影", "动漫"]);
    expect(tagsOf(rows)).toEqual(["写实", "二次元"]);
  });
});

describe("提示词库：导出与导入", () => {
  const lib = [
    {
      id: "u1",
      title: "人像",
      positive: "portrait of {{名字}}",
      negative: "lowres",
      target: "image",
      category: "摄影",
      tags: ["人像"],
      note: "n",
      pinned: true,
      createdAt: 1,
      updatedAt: 2,
    },
  ];

  it("导出可原样再导入：title/positive/negative/target/category/tags/pinned 不丢，源 id 不保留", () => {
    const parsed = parsePromptsJson(exportPromptsJson(lib));
    expect(parsed.ok).toBe(true);
    expect(parsed.prompts[0]).toEqual({
      title: "人像",
      positive: "portrait of {{名字}}",
      negative: "lowres",
      target: "image",
      category: "摄影",
      tags: ["人像"],
      note: "n",
      pinned: true,
    });
    expect(parsed.prompts[0].id).toBeUndefined();
  });

  it("错误码：empty / badJson / badFormat / badShape / noPrompts", () => {
    expect(parsePromptsJson("  ").error).toBe("empty");
    expect(parsePromptsJson("{oops").error).toBe("badJson");
    expect(parsePromptsJson({ format: "other-tool", prompts: [] }).error).toBe("badFormat");
    expect(parsePromptsJson(JSON.stringify({ hello: 1 })).error).toBe("badShape");
    expect(parsePromptsJson("[{\"positive\":\"\"}]").error).toBe("noPrompts");
  });

  it("数组形状直接收；单条无效跳过并计数；文件内按 dedupeKey 去重", () => {
    const parsed = parsePromptsJson([
      { positive: "same" },
      { positive: "same" },
      { positive: "" },
      { title: "无正文" },
      { positive: "other", title: "ok" },
    ]);
    expect(parsed.ok).toBe(true);
    expect(parsed.prompts.map((p) => p.positive)).toEqual(["same", "other"]);
    expect(parsed.stats).toEqual({ total: 5, valid: 2, invalid: 2, duplicates: 1 });
  });

  it("buildExportPayload 带格式头与导出时间", () => {
    const payload = buildExportPayload(lib, 1_700_000_000_000);
    expect(payload.format).toBe("toolcove-prompts");
    expect(payload.version).toBe(1);
    expect(payload.count).toBe(1);
    expect(payload.exportedAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("splitImports 按库内去重，同批内也去重", () => {
    const { fresh, duplicates } = splitImports(
      [{ title: "人像", positive: "portrait of {{名字}}" }, { title: "新", positive: "new" }, { title: "新", positive: "new" }],
      lib
    );
    expect(fresh.map((p) => p.positive)).toEqual(["new"]);
    expect(duplicates).toBe(2);
  });
});

describe("提示词库：历史裁剪与示例", () => {
  it("trimHistory 保留最新 cap 条，返回被淘汰项", () => {
    const list = [
      { id: "old", ts: 1 },
      { id: "new", ts: 3 },
      { id: "mid", ts: 2 },
    ];
    const { kept, evicted } = trimHistory(list, 2);
    expect(kept.map((r) => r.id)).toEqual(["new", "mid"]);
    expect(evicted.map((r) => r.id)).toEqual(["old"]);
  });

  it("hasSample 按 title+positive 判断是否已加入", () => {
    const sample = { title: "示例", positive: "body" };
    expect(hasSample([{ title: "示例", positive: "body" }], sample)).toBe(true);
    expect(hasSample([{ title: "示例", positive: "changed" }], sample)).toBe(false);
    expect(dedupeKey({ title: "A", positive: "B" })).toBe("A\nB");
  });

  it("samplePrompts 结构：6 条、图 4 视频 2、至少 3 条含变量；中英字典键存在", () => {
    const samples = samplePrompts((key) => String(dictAt(zh, key) ?? ""));
    expect(samples).toHaveLength(SAMPLE_PROMPT_KEYS.length);
    expect(samples.filter((s) => s.target === "image")).toHaveLength(4);
    expect(samples.filter((s) => s.target === "video")).toHaveLength(2);
    expect(samples.filter((s) => extractVariables(s.positive).length > 0).length).toBeGreaterThanOrEqual(3);
    for (const id of SAMPLE_PROMPT_KEYS) {
      for (const field of ["title", "positive", "negative"]) {
        for (const [name, dict] of [["zh", zh], ["en", en]]) {
          const value = dictAt(dict, `toolbox.prompt.samples.${id}.${field}`);
          expect(typeof value, `${name}:${id}.${field} 缺失`).toBe("string");
          expect(value.length, `${name}:${id}.${field} 为空`).toBeGreaterThan(0);
        }
      }
    }
    for (const dict of [zh, en]) {
      expect(dictAt(dict, "toolbox.prompt.samples.category")).toBeTruthy();
    }
  });
});
