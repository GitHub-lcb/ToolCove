import { describe, expect, it } from "vitest";
import {
  buildRenamePreview,
  convertLineEndings,
  countLineEndings,
  estimateBase64Bytes,
  formatFileSize,
  getFileName,
} from "./fileTool.js";
import { i18n } from "./i18n/index.js";

describe("file paths and sizes", () => {
  it("supports Windows and Unix paths", () => {
    expect(getFileName("C:\\work\\demo.txt")).toBe("demo.txt");
    expect(getFileName("/tmp/demo.txt")).toBe("demo.txt");
  });

  it("formats file sizes and estimates Base64 bytes", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(2 * 1024 ** 2)).toBe("2 MB");
    expect(estimateBase64Bytes("aGVsbG8=")).toBe(5);
  });
});

describe("line ending handling", () => {
  it("counts CRLF, LF and CR without double counting", () => {
    expect(countLineEndings("a\r\nb\nc\rd")).toEqual({ crlf: 1, lf: 1, cr: 1, lines: 4, mixed: true });
    expect(countLineEndings("")).toEqual({ crlf: 0, lf: 0, cr: 0, lines: 0, mixed: false });
  });

  it("converts to the target line ending", () => {
    const input = "a\r\nb\nc\rd";
    expect(convertLineEndings(input, "LF")).toBe("a\nb\nc\nd");
    expect(convertLineEndings(input, "CRLF")).toBe("a\r\nb\r\nc\r\nd");
    expect(convertLineEndings(input, "CR")).toBe("a\rb\rc\rd");
  });
});

describe("batch rename preview", () => {
  const files = [
    { path: "C:\\demo\\Photo One.JPG", name: "Photo One.JPG" },
    { path: "C:\\demo\\Photo Two.JPG", name: "Photo Two.JPG" },
  ];

  it("combines replace, affixes, case and padded numbering", () => {
    const result = buildRenamePreview(files, {
      find: "Photo ",
      replace: "",
      prefix: "img-",
      suffix: "-raw",
      caseMode: "lower",
      numbering: "suffix",
      numberStart: 7,
      numberPadding: 3,
      numberSeparator: "_",
      preserveExtension: true,
    });
    expect(result.map((item) => item.targetName)).toEqual([
      "img-one-raw_007.JPG",
      "img-two-raw_008.JPG",
    ]);
    expect(result.every((item) => item.valid && item.changed)).toBe(true);
  });

  it("supports regex and case-sensitive replace", () => {
    const result = buildRenamePreview(files, {
      find: "photo\\s+",
      replace: "shot-",
      useRegex: true,
      caseSensitive: false,
      preserveExtension: true,
    });
    expect(result.map((item) => item.targetName)).toEqual(["shot-One.JPG", "shot-Two.JPG"]);
  });

  it("flags duplicate targets, invalid names and bad regex", () => {
    const duplicate = buildRenamePreview(files, { find: "Photo One", replace: "Photo Two" });
    expect(duplicate.every((item) => item.valid === false)).toBe(true);
    expect(duplicate[0].error).toContain(i18n.global.t("toolbox.file.errDupName"));

    const invalid = buildRenamePreview(files.slice(0, 1), { prefix: "bad:" });
    expect(invalid[0]).toMatchObject({ valid: false, error: i18n.global.t("toolbox.file.errInvalidChar") });

    const regex = buildRenamePreview(files.slice(0, 1), { find: "[", useRegex: true });
    expect(regex[0].valid).toBe(false);
    expect(regex[0].error).toContain(i18n.global.t("toolbox.file.errRegex", { error: "" }));
  });

  it("treats case-only changes as valid renames on Windows", () => {
    const result = buildRenamePreview(files.slice(0, 1), { caseMode: "lower", preserveExtension: false });
    expect(result[0]).toMatchObject({ targetName: "photo one.jpg", valid: true, changed: true });
  });
});
