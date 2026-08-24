import { describe, expect, it } from "vitest";
import {
  buildHighlightSegments,
  convertNaming,
  findRegexMatches,
  getTextStats,
  processLines,
  replaceText,
} from "./textTool.js";

describe("findRegexMatches", () => {
  it("返回全部匹配、捕获组和命名捕获组", () => {
    const result = findRegexMatches("(?<key>\\w+)=(\\d+)", "a=1 b=22", "g");
    expect(result.matches).toHaveLength(2);
    expect(result.matches[1]).toMatchObject({
      index: 4,
      end: 8,
      value: "b=22",
      groups: ["b", "22"],
      namedGroups: { key: "b" },
    });
  });

  it("非全局模式只返回首个匹配，零长度全局匹配不会死循环", () => {
    expect(findRegexMatches("a", "a a", "").matches).toHaveLength(1);
    expect(findRegexMatches("^|$", "abc", "gm").matches).toHaveLength(2);
  });

  it("非法表达式抛出中文错误", () => {
    expect(() => findRegexMatches("[", "text", "g")).toThrow("正则表达式无效");
  });
});

describe("buildHighlightSegments", () => {
  it("按匹配范围生成文本与高亮片段", () => {
    const matches = findRegexMatches("\\d+", "订单12金额300", "g").matches;
    expect(buildHighlightSegments("订单12金额300", matches)).toEqual([
      { text: "订单", match: false },
      { text: "12", match: true, matchIndex: 0 },
      { text: "金额", match: false },
      { text: "300", match: true, matchIndex: 1 },
    ]);
  });
});

describe("replaceText", () => {
  it("普通替换支持全部替换且不解释正则字符", () => {
    expect(replaceText("a.b a.b", ".", "-", { replaceAll: true })).toBe("a-b a-b");
  });

  it("正则替换支持捕获组和忽略大小写", () => {
    expect(replaceText("Name: Tom\nNAME: Bob", "name: (\\w+)", "$1", {
      regex: true,
      replaceAll: true,
      ignoreCase: true,
    })).toBe("Tom\nBob");
  });

  it("查找内容为空时保持原文", () => {
    expect(replaceText("abc", "", "x", { replaceAll: true })).toBe("abc");
  });
});

describe("processLines", () => {
  const source = " beta \nalpha\nbeta\n\n10\n2";

  it("去重保持首次出现顺序并可忽略首尾空白", () => {
    expect(processLines(source, "dedupe", { trimForCompare: true })).toBe(" beta \nalpha\n\n10\n2");
  });

  it("支持排序、过滤空行、清理空白和前后缀", () => {
    expect(processLines("10\n2\n1", "sort-number")).toBe("1\n2\n10");
    expect(processLines("a\n\n b ", "remove-empty")).toBe("a\n b ");
    expect(processLines(" a \n b ", "trim")).toBe("a\nb");
    expect(processLines("a\nb", "affix", { prefix: "[", suffix: "]" })).toBe("[a]\n[b]");
  });
});

describe("convertNaming", () => {
  it("拆分驼峰、缩写、数字并转换为常用命名风格", () => {
    expect(convertNaming("HTTPServer2 config", "camel")).toBe("httpServer2Config");
    expect(convertNaming("HTTPServer2 config", "pascal")).toBe("HttpServer2Config");
    expect(convertNaming("HTTPServer2 config", "snake")).toBe("http_server_2_config");
    expect(convertNaming("HTTPServer2 config", "constant")).toBe("HTTP_SERVER_2_CONFIG");
  });

  it("纯空白输入返回空串", () => {
    expect(convertNaming("  ", "kebab")).toBe("");
  });
});

describe("getTextStats", () => {
  it("统计字符、非空白、行、单词、中文、UTF-8 字节与重复行", () => {
    expect(getTextStats("hello 世界\nhello 世界\n")).toEqual({
      characters: 18,
      charactersNoWhitespace: 14,
      lines: 2,
      words: 4,
      chineseCharacters: 4,
      bytes: 26,
      uniqueLines: 1,
      duplicateLines: 1,
      emptyLines: 0,
    });
  });

  it("空文本所有统计为零", () => {
    expect(getTextStats("")).toMatchObject({ characters: 0, lines: 0, bytes: 0 });
  });
});
