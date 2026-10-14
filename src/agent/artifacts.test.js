import { describe, expect, it } from "vitest";
import { extractArtifacts } from "./artifacts.js";

describe("extractArtifacts 产物提取", () => {
  it("output 形状（pdf.merge / pdf.extract_pages）：一条，label 取 basename", () => {
    expect(extractArtifacts({ output: "/tmp/out/merged.pdf", files: 3, bytes: 1024 })).toEqual([{ path: "/tmp/out/merged.pdf", label: "merged.pdf" }]);
    expect(extractArtifacts({ output: "D:\\docs\\pages.pdf", pages: 2, bytes: 10 })).toEqual([{ path: "D:\\docs\\pages.pdf", label: "pages.pdf" }]);
  });

  it("files 形状（pdf.split）：每个文件一条，保持顺序", () => {
    const result = {
      outputDir: "/tmp/out",
      count: 2,
      files: [
        { path: "/tmp/out/a_1-3.pdf", pages: 3, bytes: 10 },
        { path: "/tmp/out/a_4-6.pdf", pages: 3, bytes: 12 },
      ],
    };
    expect(extractArtifacts(result)).toEqual([
      { path: "/tmp/out/a_1-3.pdf", label: "a_1-3.pdf" },
      { path: "/tmp/out/a_4-6.pdf", label: "a_4-6.pdf" },
    ]);
  });

  it("output 优先于 files：merge 结果里的 files 是输入个数，不是产物列表", () => {
    expect(extractArtifacts({ output: "/tmp/m.pdf", files: 5 })).toHaveLength(1);
  });

  it("空 output / 非对象 / 无文件字段都返回 []", () => {
    expect(extractArtifacts(null)).toEqual([]);
    expect(extractArtifacts("same")).toEqual([]);
    expect(extractArtifacts({ text: "hi" })).toEqual([]);
    expect(extractArtifacts({ output: "  " })).toEqual([]);
    expect(extractArtifacts({ outputDir: "/tmp", files: [] })).toEqual([]);
    // files 里没有合法 path 的元素被跳过
    expect(extractArtifacts({ files: [{ pages: 1 }, { path: "" }, null] })).toEqual([]);
  });
});
