// PDF 工具单测：范围解析（纯函数）+ 真实 pdf-lib 字节操作（node 环境可直接跑）。
// 用 pdf-lib 现场构造夹具，断言页数、页面尺寸、旋转角与元数据，避免只测「函数被调用」。
import { describe, it, expect } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
import { readFileSync } from "node:fs";
import {
  attributeLoadFailure,
  buildSplitGroups,
  extractPages,
  formatPageRanges,
  looksEncryptedPdf,
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

/**
 * 构造一个「有 PDF 头、但结构坏到 pdf-lib 直接抛错」的样本，用于验证解析失败时的归因。
 * 两个样本完全一致，只差尾部带不带 /Encrypt，以此确认归因差异只来自加密字典本身。
 * 注意：pdf-lib 对退化结构相当宽容（只有头+trailer 也能加载），所以这里用真正的乱码结构。
 */
function unparseablePdf({ encrypt = false } = {}) {
  const junk = "\u0001\u0002 junk ".repeat(40);
  const marker = encrypt ? " /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> >>" : "";
  const text = `%PDF-1.7\n${junk}trailer\n<< /Size 2 /Root 1 0 R${marker} >>\nstartxref\n0\n%%EOF\n`;
  return new Uint8Array(Buffer.from(text, "latin1"));
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

  // 用户实际遇到的场景：文件确实加密了，但 pdf-lib 连文档都构不出来（对象流被加密），
  // 旧实现会走到 catch 分支直接报 invalid，界面显示「文件已损坏」——必须归因到加密。
  // 归因逻辑抽成纯函数后在这里直接验证（pdf-lib 对退化结构的容忍度在 CJS/ESM 构建间不一致，
  // 用「必然解析失败」的样本去测这条分支并不可靠；加密文档可解析的情形由上一条用例覆盖）。
  it("解析失败时按加密字典归因：带 /Encrypt 报 encrypted、不带才报 invalid", () => {
    const locked = unparseablePdf({ encrypt: true });
    const broken = unparseablePdf();
    expect(attributeLoadFailure(locked).code).toBe("encrypted");
    expect(attributeLoadFailure(broken).code).toBe("invalid");
    // 两个样本只差加密字典，确保差异确实来自它
    expect(looksEncryptedPdf(locked)).toBe(true);
    expect(looksEncryptedPdf(broken)).toBe(false);
    expect(locked.length).toBeGreaterThan(broken.length);
  });
});

describe("looksEncryptedPdf（字节级加密归因）", () => {
  it("识别经典 trailer 里的 /Encrypt 引用", () => {
    expect(looksEncryptedPdf(minimalPdf({ encrypt: true }))).toBe(true);
  });

  it("识别 xref 流字典里的内联 /Encrypt 字典，且容忍换行与多空格", () => {
    const tail = "\n25 0 obj\n<< /Type /XRef /Encrypt\n   << /Filter /Standard /V 5 >> >>\nstartxref\n0\n%%EOF\n";
    const bytes = new Uint8Array(Buffer.from("%PDF-1.7\n" + "x".repeat(64) + tail, "latin1"));
    expect(looksEncryptedPdf(bytes)).toBe(true);
  });

  it("正常 PDF 不误判", async () => {
    expect(looksEncryptedPdf(await makePdf(2))).toBe(false);
    expect(looksEncryptedPdf(minimalPdf())).toBe(false);
  });

  it("只在尾部窗口内匹配：正文里的 /Encrypt 字样不会误判", () => {
    const body = "%PDF-1.4\n1 0 obj\n<< /Note (/Encrypt 12 0 R 只是正文里的说明文字) >>\nendobj\n";
    const padding = "y".repeat(9000); // 把正文里的字样挤出尾部 8KB 窗口
    const trailer = "trailer\n<< /Size 2 /Root 1 0 R >>\nstartxref\n0\n%%EOF\n";
    const bytes = new Uint8Array(Buffer.from(body + padding + trailer, "latin1"));
    expect(looksEncryptedPdf(bytes)).toBe(false);
  });

  it("非 PDF 与空输入一律 false", () => {
    expect(looksEncryptedPdf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]))).toBe(false);
    expect(looksEncryptedPdf(new Uint8Array(0))).toBe(false);
    expect(looksEncryptedPdf(null)).toBe(false);
    expect(looksEncryptedPdf(new Uint8Array(Buffer.from("not a pdf at all /Encrypt 1 0 R", "latin1")))).toBe(false);
  });

  it("不依赖 Buffer（浏览器端可用）", async () => {
    const source = readFileSync(new URL("./pdfTool.js", import.meta.url), "utf8");
    const body = source.slice(source.indexOf("export function looksEncryptedPdf"), source.indexOf("/**", source.indexOf("export function looksEncryptedPdf")));
    expect(body).not.toContain("Buffer");
  });
});
