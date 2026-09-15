// PDF 去加密：qpdf 编译成的 WebAssembly（@jspawn/qpdf-wasm 的单线程构建）。
//
// 为什么选这个包：qpdf-wasm 官方 `qpdf-wasm` 包是 pthread 构建，浏览器里需要 SharedArrayBuffer
// 与 COOP/COEP 跨源隔离响应头 —— Tauri 默认不提供、GitHub Pages 更是无法设置；这个旧版构建是
// 单线程的，不依赖跨源隔离，两端都能跑（qpdf 11.0.0，支持 RC4/AES-128/AES-256）。
//
// 体积与加载：wasm 约 1.3MB，只在真的遇到加密 PDF 时才动态加载，普通打开不付这份代价。
// 权限说明：qpdf 的 --decrypt 只能解开「用已知口令（含空口令）能打开」的文件，
// 不猜密码；需要口令的文件必须由用户提供。
import { looksEncryptedPdf, pdfError } from "./pdfTool.js";

let modulePromise = null;
let outputBuffer = "";

/**
 * wasm 位置：浏览器/桌面端用 Vite 给的资源 URL；Node（单测环境）下 Emscripten 走 fs.readFileSync，
 * 必须换成真实文件路径。用 window 判别而非 node: 内置模块，避免污染浏览器产物。
 * 注意别用 new URL(wasmUrl, file://) 解析：以 / 开头的路径会按「站点根」解析成 /node_modules/…，
 * 在 Windows 上会退化成盘符根目录。
 */
function resolveWasmLocation(wasmUrl) {
  if (typeof window !== "undefined") return wasmUrl;
  const relative = String(wasmUrl).replace(/^\.?\//, "");
  return `${process.cwd()}/${relative}`;
}

async function loadQpdf() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const [{ default: initQpdf }, { default: wasmUrl }] = await Promise.all([
        // 直接取 CJS 胶水（qpdf.js 的 module.exports = Module 工厂）。
        // 不走包自带的 qpdf.mjs：那个包装器靠 globalThis.exports.Module 传递工厂，
        // 而 Vite 的 CJS interop 不会把导出写到 globalThis，浏览器里会拿到 undefined。
        import("@jspawn/qpdf-wasm/qpdf.js"),
        import("@jspawn/qpdf-wasm/qpdf.wasm?url"),
      ]);
      return initQpdf({
        locateFile: () => resolveWasmLocation(wasmUrl),
        // qpdf 的错误信息走 stdout/stderr，两个都收：失败原因（如 invalid password）靠它区分
        print: (line) => {
          outputBuffer += `${line}\n`;
        },
        printErr: (line) => {
          outputBuffer += `${line}\n`;
        },
      });
    })().catch((error) => {
      modulePromise = null; // 加载失败不缓存，允许重试
      throw pdfError("decryptUnavailable", error?.message || String(error));
    });
  }
  return modulePromise;
}

/**
 * 判断是否解密成功。
 * 这个构建的 callMain 失败时既不抛错也不返回非零码（实测返回 0、输出文件不生成），
 * 也没有 analyzePath，所以唯一可靠的信号是「输出文件能不能读出来」。
 */
function readOutput(qpdf, path) {
  try {
    const bytes = qpdf.FS.readFile(path);
    return bytes && bytes.length ? bytes : null;
  } catch {
    return null;
  }
}

/** 运行一次 qpdf：这个构建不抛退出码，统一用输出文件是否生成来判定成败。 */
function runQpdf(qpdf, args) {
  outputBuffer = "";
  try {
    qpdf.callMain(args);
  } catch (error) {
    // 有些失败路径会抛 Emscripten 的 FS/abort 对象：记下信息，成败仍以输出文件为准
    if (typeof error === "number" || typeof error?.status === "number") return error?.status ?? error;
    outputBuffer += `${error?.message || error}\n`;
  }
  return 0;
}

function safeUnlink(qpdf, path) {
  try {
    qpdf.FS.unlink(path);
  } catch {
    // 清理失败不影响主流程
  }
}

/**
 * 去除 PDF 加密，返回解密后的字节。
 * password 省略时按「空口令」尝试 —— 电子发票 / 银行回单这类权限加密文件正是空口令，
 * 无需用户输入；需要口令的文件会抛 decryptionPasswordRequired / decryptionWrongPassword。
 */
export async function decryptPdf(bytes, password = "") {
  if (!bytes || bytes.length < 8) throw pdfError("invalid");
  // 先做文件头判定：非 PDF 直接拒绝，不必白跑一趟 wasm
  if (!new TextDecoder("latin1").decode(bytes.subarray(0, 5)).startsWith("%PDF-")) throw pdfError("invalid");

  const qpdf = await loadQpdf();
  const tag = Math.random().toString(36).slice(2, 10);
  const input = `/in-${tag}.pdf`;
  const output = `/out-${tag}.pdf`;
  try {
    qpdf.FS.writeFile(input, bytes);
    const args = ["--decrypt"];
    if (password) args.push(`--password=${password}`);
    args.push(input, output);
    runQpdf(qpdf, args);

    const result = readOutput(qpdf, output);
    if (!result) {
      // 这个构建拿不到 qpdf 的错误文本（消息直接写进程控制台，不经过 print/printErr），
      // 因此按语义归因：给了口令还失败 ⇒ 口令不对；空口令且文件确实带加密字典 ⇒ 需要口令。
      if (password) throw pdfError("decryptionWrongPassword");
      throw looksEncryptedPdf(bytes) ? pdfError("decryptionPasswordRequired") : pdfError("decryptionFailed");
    }
    return result;
  } finally {
    safeUnlink(qpdf, input);
    safeUnlink(qpdf, output);
  }
}
