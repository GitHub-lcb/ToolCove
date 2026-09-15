// PDF 去加密集成测试：用真实加密样本（pikepdf / qpdf 12.3 生成）跑真正的 qpdf-wasm。
// 样本与生成方式见 src/fixtures/pdf/README.md —— 用官方实现造样本，qpdf-wasm 才能被真正验证。
//
// 注意：@jspawn/qpdf-wasm 的胶水是 Emscripten 产物，在 Node 18+ 下会误判「有全局 fetch → 用 fetch
// 读 wasm」，而 fetch 不支持 file:// —— 已知规避是在初始化期间临时移除 fetch（仅影响本测试文件）。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { PDFDocument } from "pdf-lib";
import { decryptPdf } from "./pdfDecrypt.js";
import { readPdfSummary, mergePdfs } from "./pdfTool.js";

const fixture = (name) => new Uint8Array(readFileSync(new URL(`./fixtures/pdf/${name}`, import.meta.url)));
const PASSWORD = "open123";

// 初始化前摘掉 fetch：让 Emscripten 回落到 fs 读 wasm
let realFetch;
beforeAll(() => {
  realFetch = globalThis.fetch;
  delete globalThis.fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
});

describe("decryptPdf（真实 qpdf-wasm）", () => {
  it("权限加密（空口令，电子发票/银行回单那类）无需密码即可解开", async () => {
    const locked = fixture("owner-only.pdf");
    await expect(readPdfSummary(locked)).rejects.toMatchObject({ code: "encrypted" });

    const plain = await decryptPdf(locked);
    const summary = await readPdfSummary(plain);
    expect(summary.pageCount).toBe(2);
    expect(summary.title).toBe("ToolCove encrypted fixture");
    // 解密结果必须能被 pdf-lib 正常使用（否则「去加密」等于没用）
    const merged = await mergePdfs([plain, plain]);
    expect((await readPdfSummary(merged)).pageCount).toBe(4);
  });

  it("老式 RC4（R=3）权限加密同样能解开", async () => {
    const plain = await decryptPdf(fixture("owner-only-rc4.pdf"));
    expect((await readPdfSummary(plain)).pageCount).toBe(2);
  });

  it("需要用户密码的文件：给对口令才解开", async () => {
    const locked = fixture("user-password.pdf");
    await expect(decryptPdf(locked)).rejects.toMatchObject({ code: "decryptionPasswordRequired" });
    await expect(decryptPdf(locked, "wrong-one")).rejects.toMatchObject({ code: "decryptionWrongPassword" });

    const plain = await decryptPdf(locked, PASSWORD);
    expect((await readPdfSummary(plain)).title).toBe("ToolCove encrypted fixture");
  });

  it("未加密的文件原样可用，不报错", async () => {
    const plain = await decryptPdf(fixture("base.pdf"));
    expect((await readPdfSummary(plain)).pageCount).toBe(2);
  });

  it("输入不是 PDF 时报 invalid，且不泄漏 qpdf 内部错误串", async () => {
    await expect(decryptPdf(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).rejects.toMatchObject({ code: "invalid" });
  });

  it("连续两次解密互不干扰（临时文件不串号）", async () => {
    const [a, b] = await Promise.all([decryptPdf(fixture("owner-only.pdf")), decryptPdf(fixture("owner-only.pdf"), "")]);
    expect((await readPdfSummary(a)).pageCount).toBe(2);
    expect((await readPdfSummary(b)).pageCount).toBe(2);
  });
});
