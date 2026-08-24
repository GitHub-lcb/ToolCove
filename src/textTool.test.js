import { describe, expect, it } from "vitest";
import { i18n } from "./i18n/index.js";
import {
  buildHighlightSegments,
  convertNaming,
  findRegexMatches,
  getTextStats,
  processLines,
  replaceText,
} from "./textTool.js";

describe("findRegexMatches", () => {
  it("returns all matches with capture and named groups", () => {
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

  it("non-global returns first match only; zero-length global match does not loop", () => {
    expect(findRegexMatches("a", "a a", "").matches).toHaveLength(1);
    expect(findRegexMatches("^|$", "abc", "gm").matches).toHaveLength(2);
  });

  it("invalid expression throws localized error", () => {
    const prefix = i18n.global.t("toolbox.text.errInvalidRegex", { err: "" }).replace(/[\s：:]+$/, "");
    expect(() => findRegexMatches("[", "text", "g")).toThrow(prefix);
  });
});

describe("buildHighlightSegments", () => {
  it("builds text and highlight segments by match ranges", () => {
    const matches = findRegexMatches("\\d+", "order12amount300", "g").matches;
    expect(buildHighlightSegments("order12amount300", matches)).toEqual([
      { text: "order", match: false },
      { text: "12", match: true, matchIndex: 0 },
      { text: "amount", match: false },
      { text: "300", match: true, matchIndex: 1 },
    ]);
  });
});

describe("replaceText", () => {
  it("plain replace supports replaceAll without regex interpretation", () => {
    expect(replaceText("a.b a.b", ".", "-", { replaceAll: true })).toBe("a-b a-b");
  });

  it("regex replace supports capture groups and ignoreCase", () => {
    expect(replaceText("Name: Tom\nNAME: Bob", "name: (\\w+)", "$1", {
      regex: true,
      replaceAll: true,
      ignoreCase: true,
    })).toBe("Tom\nBob");
  });

  it("empty find keeps original text", () => {
    expect(replaceText("abc", "", "x", { replaceAll: true })).toBe("abc");
  });
});

describe("processLines", () => {
  const source = " beta \nalpha\nbeta\n\n10\n2";

  it("dedupe keeps first occurrence order and can ignore trim", () => {
    expect(processLines(source, "dedupe", { trimForCompare: true })).toBe(" beta \nalpha\n\n10\n2");
  });

  it("supports sort, remove empty, trim and affix", () => {
    expect(processLines("10\n2\n1", "sort-number")).toBe("1\n2\n10");
    expect(processLines("a\n\n b ", "remove-empty")).toBe("a\n b ");
    expect(processLines(" a \n b ", "trim")).toBe("a\nb");
    expect(processLines("a\nb", "affix", { prefix: "[", suffix: "]" })).toBe("[a]\n[b]");
  });
});

describe("convertNaming", () => {
  it("splits camel/acronyms/digits into common naming styles", () => {
    expect(convertNaming("HTTPServer2 config", "camel")).toBe("httpServer2Config");
    expect(convertNaming("HTTPServer2 config", "pascal")).toBe("HttpServer2Config");
    expect(convertNaming("HTTPServer2 config", "snake")).toBe("http_server_2_config");
    expect(convertNaming("HTTPServer2 config", "constant")).toBe("HTTP_SERVER_2_CONFIG");
  });

  it("whitespace-only input returns empty string", () => {
    expect(convertNaming("  ", "kebab")).toBe("");
  });
});

describe("getTextStats", () => {
  it("counts characters, lines, words, CJK, UTF-8 bytes and duplicates", () => {
    // "世界" x2 written as unicode escapes to keep source pure ASCII
    expect(getTextStats("hello \u4e16\u754c\nhello \u4e16\u754c\n")).toEqual({
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

  it("empty text yields all-zero stats", () => {
    expect(getTextStats("")).toMatchObject({ characters: 0, lines: 0, bytes: 0 });
  });
});
