// PDF 工具单测：范围解析（纯函数）+ 真实 pdf-lib 字节操作（node 环境可直接跑）。
// 用 pdf-lib 现场构造夹具，断言页数、页面尺寸、旋转角与元数据，避免只测「函数被调用」。
import { describe, it, expect } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import {
  buildSplitGroups,
  extractPages,
  formatPageRanges,
  mergePdfs,
  normalizeAngle,
  normalizeIndices,
  parsePageRanges,
  parseRangeGroups,
  pdfBaseName,
  pdfOutputName,
  readPdfSummary,
  removePages,
  rotatePages,
  splitPdf,
} from "./pdfTool.js";

async function makePdf(pageCount, { width = 595, height = 842, title, rotate = 0 } = {}) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < pageCount; i += 1) {
    const page = doc.addPage([width, height]);
    if (rotate) page.setRotation(degrees(rotate));
  }
  if (title) doc.setTitle(title);
  return doc.save();
}

// pdf-lib 只能写 xref 流，写不出带经典 trailer 的加密样本；这里手写一个最小 PDF，
// 以便真实覆盖「加密文档」这条路径（pdf-lib 的 EncryptedPDFError instanceof 在 ES5 产物下失效）
function minimalPdf({ encrypt = false } = {}) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefStart = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  const zeros = "0".repeat(64);
  const entry = encrypt ? ` /Encrypt << /Filter /Standard /V 1 /R 2 /O <${zeros}> /U <${zeros}> /P -1 >>` : "";
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${entry} >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(body, "latin1"));
}

async function inspect(bytes) {
  const doc = await PDFDocument.load(bytes);
  return {
    pageCount: doc.getPageCount(),
    sizes: doc.getPages().map((page) => {
      const { width, height } = page.getSize();
      return `${Math.round(width)}x${Math.round(height)}`;
    }),
    rotations: doc.getPages().map((page) => normalizeAngle(page.getRotation().angle)),
    title: doc.getTitle() || "",
  };
}

async function expectCode(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

describe("parseRangeGroups", () => {
  it("按逗号分段，段落即拆分单元", () => {
    const { groups, invalid, outOfRange } = parseRangeGroups("1-3, 5", 10);
    expect(groups).toEqual([
      { token: "1-3", indices: [0, 1, 2] },
      { token: "5", indices: [4] },
    ]);
    expect(invalid).toEqual([]);
    expect(outOfRange).toEqual([]);
  });

  it("兼容全角逗号、顿号与多种连字符", () => {
    expect(parsePageRanges("1-2，4、6", 10)).toEqual([0, 1, 3, 5]);
    expect(parsePageRanges("1~2 3—4 5－6", 10)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("反写区间自动交换（3-1 等价 1-3）", () => {
    expect(parsePageRanges("3-1", 10)).toEqual([0, 1, 2]);
  });

  it("越界段钳制到有效范围并记入 outOfRange", () => {
    const { groups, outOfRange } = parseRangeGroups("3-99", 10);
    expect(groups[0].indices).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
    expect(outOfRange).toEqual(["3-99"]);
  });

  it("整段越界不产生空分组", () => {
    const { groups, outOfRange } = parseRangeGroups("99,0", 10);
    expect(groups).toEqual([]);
    expect(outOfRange).toEqual(["99", "0"]);
  });

  it("非数字 token 记入 invalid", () => {
    const { groups, invalid } = parseRangeGroups("abc,1-2", 10);
    expect(invalid).toEqual(["abc"]);
    expect(groups).toEqual([{ token: "1-2", indices: [0, 1] }]);
  });

  it("空输入与脏输入不抛错", () => {
    expect(parseRangeGroups("", 10).groups).toEqual([]);
    expect(parseRangeGroups(null, 10).groups).toEqual([]);
    expect(parseRangeGroups("1-3", 0).groups).toEqual([]);
  });

  it("跨段重叠在展平时去重且保序", () => {
    expect(parsePageRanges("3,1-2,2-4", 10)).toEqual([2, 0, 1, 3]);
  });
});

describe("formatPageRanges", () => {
  it("折叠连续页码并去重排序", () => {
    expect(formatPageRanges([0, 1, 2, 4])).toBe("1-3,5");
    expect(formatPageRanges([4, 0, 1, 2, 2])).toBe("1-3,5");
  });

  it("空列表与非整数按空处理", () => {
    expect(formatPageRanges([])).toBe("");
    expect(formatPageRanges(["1", -1, 1.5])).toBe("");
  });
});

describe("buildSplitGroups", () => {
  it("留空 = 每页一个文件", () => {
    expect(buildSplitGroups("", 3)).toEqual([
      { token: "1", indices: [0] },
      { token: "2", indices: [1] },
      { token: "3", indices: [2] },
    ]);
  });

  it("给定表达式时按段落拆分", () => {
    expect(buildSplitGroups("1-3,5", 10).map((group) => group.token)).toEqual(["1-3", "5"]);
  });
});

describe("normalizeIndices / normalizeAngle", () => {
  it("过滤越界与重复，保持入参顺序", () => {
    expect(normalizeIndices([2, 0, 2, 9, -1, "x"], 3)).toEqual([2, 0]);
  });

  it("角度归一到 [0,360)", () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(undefined)).toBe(0);
  });
});

describe("输出文件名", () => {
  it("去扩展名并拼接后缀", () => {
    expect(pdfOutputName("报告 v2.pdf", "1-3")).toBe("报告 v2-1-3.pdf");
    expect(pdfOutputName("a.PDF", "")).toBe("a.pdf");
  });

  it("剥离路径并清洗非法字符", () => {
    expect(pdfBaseName("C:\\docs\\q1:final?.pdf")).toBe("q1_final_");
    expect(pdfBaseName("")).toBe("document");
  });
});

describe("PDF 字节操作", () => {
  it("合并按给定顺序拼接页面并保留各自尺寸", async () => {
    const a = await makePdf(2, { width: 100, height: 200, title: "甲" });
    const b = await makePdf(1, { width: 300, height: 400 });
    const merged = await mergePdfs([a, b]);
    const info = await inspect(merged);
    expect(info.pageCount).toBe(3);
    expect(info.sizes).toEqual(["100x200", "100x200", "300x400"]);
    expect(info.title).toBe("甲");
  });

  it("提取页按入参顺序输出，可用于重排", async () => {
    const source = await makePdf(5);
    const extracted = await extractPages(source, [4, 0]);
    expect((await inspect(extracted)).pageCount).toBe(2);
    await expectCode(extractPages(source, []), "emptySelection");
  });

  it("删除页保留其余页原顺序", async () => {
    const source = await makePdf(4, { width: 200, height: 300 });
    const result = await removePages(source, [1, 3]);
    expect((await inspect(result)).pageCount).toBe(2);
    await expectCode(removePages(source, [0, 1, 2, 3]), "emptyResult");
    await expectCode(removePages(source, []), "emptySelection");
  });

  it("旋转叠加在页面原有角度上", async () => {
    const source = await makePdf(2, { rotate: 90 });
    const once = await rotatePages(source, { 0: 90 });
    expect((await inspect(once)).rotations).toEqual([180, 90]);
    const twice = await rotatePages(once, { 0: 270, 1: -90 });
    expect((await inspect(twice)).rotations).toEqual([90, 0]);
  });

  it("旋转未命中任何页时报 emptySelection", async () => {
    const source = await makePdf(1);
    await expectCode(rotatePages(source, {}), "emptySelection");
    await expectCode(rotatePages(source, { 5: 90 }), "emptySelection");
    await expectCode(rotatePages(source, { 0: 0 }), "emptySelection");
  });

  it("拆分按分组产出独立文件，页数与 token 对应", async () => {
    const source = await makePdf(6);
    const parts = await splitPdf(source, buildSplitGroups("1-2,4-6", 6));
    expect(parts.map((part) => part.token)).toEqual(["1-2", "4-6"]);
    expect(parts.map((part) => part.indices)).toEqual([[0, 1], [3, 4, 5]]);
    expect((await inspect(parts[0].bytes)).pageCount).toBe(2);
    expect((await inspect(parts[1].bytes)).pageCount).toBe(3);
  });

  it("读取概要：页数、尺寸分布、每页旋转与元数据", async () => {
    const source = await makePdf(2, { rotate: 90, title: "概要" });
    const summary = await readPdfSummary(source);
    expect(summary.pageCount).toBe(2);
    expect(summary.pageRotations).toEqual([90, 90]);
    expect(summary.sizes).toEqual([{ label: "595 × 842 pt", count: 2 }]);
    expect(summary.title).toBe("概要");
    expect(summary.sizeBytes).toBe(source.length);
  });

  it("非 PDF 字节按 invalid 拒绝", async () => {
    const garbage = new Uint8Array([1, 2, 3, 4, 5]);
    await expectCode(readPdfSummary(garbage), "invalid");
    await expectCode(mergePdfs([garbage]), "invalid");
    await expectCode(mergePdfs([]), "emptyInput");
  });

  it("加密 PDF 一律按 encrypted 拒绝，不产出损坏文件", async () => {
    const plain = minimalPdf();
    const locked = minimalPdf({ encrypt: true });
    // 手写样本本身必须可解析，否则这条用例会退化成「invalid 也算过」
    expect((await readPdfSummary(plain)).pageCount).toBe(1);
    await expectCode(readPdfSummary(locked), "encrypted");
    await expectCode(mergePdfs([plain, locked]), "encrypted");
    await expectCode(extractPages(locked, [0]), "encrypted");
    await expectCode(removePages(locked, [0]), "encrypted");
    await expectCode(rotatePages(locked, { 0: 90 }), "encrypted");
    await expectCode(splitPdf(locked, buildSplitGroups("", 1)), "encrypted");
  });
});
