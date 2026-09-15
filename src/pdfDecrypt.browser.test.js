// 覆盖「浏览器装载路径」：window 存在时 resolveWasmLocation 直接返回 Vite 资源 URL，
// Emscripten 胶水走 web 分支（fetch + WebAssembly.instantiateStreaming）。
// vitest 每个测试文件模块隔离，所以这里可以让 pdfDecrypt 的首次初始化就走浏览器分支，
// 与 pdfDecrypt.test.js（Node 分支：fs 读 wasm）互补 —— 两条装载路径都有实测覆盖。
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";

const wasmBytes = readFileSync(new URL("../node_modules/@jspawn/qpdf-wasm/qpdf.wasm", import.meta.url));
const requested = [];

beforeAll(() => {
  globalThis.window = { name: "" };
  globalThis.self = { name: "", location: { href: "http://localhost/assets/" } };
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    return new Response(wasmBytes, { headers: { "content-type": "application/wasm" } });
  };
});

describe("decryptPdf（浏览器装载路径）", () => {
  it("通过 fetch 取 wasm 并完成解密，结果与 Node 路径一致", async () => {
    const { decryptPdf } = await import("./pdfDecrypt.js");
    const { readPdfSummary } = await import("./pdfTool.js");
    const locked = new Uint8Array(readFileSync(new URL("./fixtures/pdf/owner-only.pdf", import.meta.url)));

    const plain = await decryptPdf(locked);
    const summary = await readPdfSummary(plain);
    expect(summary.pageCount).toBe(2);
    expect(summary.title).toBe("ToolCove encrypted fixture");
    expect(requested.some((url) => url.includes("qpdf") && url.endsWith(".wasm"))).toBe(true);
  });

  it("需要密码的文件在该路径下同样能正确归因", async () => {
    const { decryptPdf } = await import("./pdfDecrypt.js");
    const locked = new Uint8Array(readFileSync(new URL("./fixtures/pdf/user-password.pdf", import.meta.url)));
    await expect(decryptPdf(locked)).rejects.toMatchObject({ code: "decryptionPasswordRequired" });
    const plain = await decryptPdf(locked, "open123");
    expect(plain.length).toBeGreaterThan(0);
  });
});
