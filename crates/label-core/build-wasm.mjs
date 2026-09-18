// 构建标签排版引擎的 WASM 产物，并验证它能被真正调用。
//   node crates/label-core/build-wasm.mjs
//
// 为什么需要这个脚本：WASM 复用是「手机端与桌面端跑同一份排版引擎」的关键前提，
// 而"编译得出来"不等于"调得通"——内存协议、导出符号、返回形状都可能在运行时才暴露问题。
// 所以这里编译完立刻**实例化并真跑一次排版**，把结果与预期比对。
//
// 产物：crates/label-core/target/label-core.wasm（供手机端加载）
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "target", "label-core.wasm");
const log = (...a) => console.log("[label-wasm]", ...a);

log("编译 wasm32-unknown-unknown …");
execFileSync("cargo", ["build", "--manifest-path", join(here, "Cargo.toml"), "--target", "wasm32-unknown-unknown", "--release"], { stdio: "inherit" });

const built = join(here, "target", "wasm32-unknown-unknown", "release", "label_core.wasm");
if (!existsSync(built)) throw new Error(`没有产物：${built}`);
mkdirSync(dirname(out), { recursive: true });
copyFileSync(built, out);
log(`产物 ${out}（${Math.round(statSync(out).size / 1024)} KB）`);

// ── 立刻真跑一次：只编译不调用，等于没验 ──────────────────────────────
const bytes = readFileSync(out);
const { instance } = await WebAssembly.instantiate(bytes, {});
const api = instance.exports;

/** 与 crates/label-core/src/wasm.rs 里约定的内存协议一致。 */
function call(name, payload) {
  const input = new TextEncoder().encode(JSON.stringify(payload));
  const inPtr = api.alloc(input.length);
  new Uint8Array(api.memory.buffer, inPtr, input.length).set(input);
  const outPtr = api[name](inPtr, input.length);
  const outLen = api.last_len();
  const text = new TextDecoder().decode(new Uint8Array(api.memory.buffer, outPtr, outLen));
  api.dealloc(inPtr, input.length);
  api.release_last();
  return JSON.parse(text);
}

const settings = {
  label: { widthMm: 50, heightMm: 30, gapMm: 2, dpi: 203, density: 8, speed: 4, marginX: 0, media: "gap" },
  job: { copies: 1, elements: [{ kind: "text", x: 8, y: 8, font: "chinese24", xMult: 1, yMult: 1, text: "测试标签" }] },
  printer: "",
};

const render = call("layout_json", settings);
const problems = [];
const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) problems.push(`${label}: 实际 ${actual}，期望 ${wanted}`);
  log(`  ${ok ? "✓" : "✗"} ${label} = ${actual}`);
};

log("验证排版结果：");
expect("画布宽（50mm @203dpi）", render.canvasW, 400);
expect("画布高（30mm @203dpi）", render.canvasH, 240);
expect("间隙（2mm @203dpi）", render.gapDots, 16);
expect("绘制项数量", render.items?.length, 2);
// ⚠️ TSPL 指令用 CRLF（打印机协议要求），所以按行切分前要先归一化，
// 否则首行会带一个 \r（这条断言第一次就是这么失败的）
const sourceLines = String(render.source || "").replace(/\r\n/g, "\n").split("\n");
expect("指令首行", sourceLines[0], "SIZE 50 mm,30 mm");
// 文字水平居中：x = (400 - 96) / 2 = 152
expect("文字居中 x", render.items?.[0]?.x, 152);

// 两次调用必须完全一致（同一份引擎，无随机性）
const again = call("layout_json", settings);
expect("两次调用结果一致", again.source === render.source, true);

// 坏参数必须返回结构化错误，而不是 panic（wasm 里 panic 会让整个模块废掉）。
// 注意：字段缺失**不是**错误——Settings 有默认值，{nope:true} 会按默认设置排版，
// 这是刻意的容错（前端表单可能只传改过的字段）。所以这里用真正非法的输入（非 JSON）。
const broken = (() => {
  const input = new TextEncoder().encode("这不是 JSON");
  const inPtr = api.alloc(input.length);
  new Uint8Array(api.memory.buffer, inPtr, input.length).set(input);
  const outPtr = api.layout_json(inPtr, input.length);
  const outLen = api.last_len();
  const text = new TextDecoder().decode(new Uint8Array(api.memory.buffer, outPtr, outLen));
  api.dealloc(inPtr, input.length);
  api.release_last();
  return JSON.parse(text);
})();
expect("非 JSON 参数返回 __error", typeof broken.__error === "string", true);

// 字段缺失按默认值走（记录这个刻意行为，免得以后被当成 bug 改掉）
const partial = call("layout_json", { nope: true });
expect("字段缺失时按默认设置排版", partial.canvasW, 400);

if (problems.length) {
  console.error(`\n验证未通过（${problems.length} 项）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
log("验证通过：WASM 引擎可被调用，排版结果符合预期");
