// APK 产物自检（发版前跑，也可本地手动跑）：
//   node mobile/android/verify-apk.mjs [apk 路径]
//
// 为什么需要它：**空壳包能装上、能启动、但打开是白屏**——这是最难排查的失败形态
// （上一代手机端就出过：assets 同步路径算错，包 645KB 却没有任何页面）。
// 所以发版前必须验产物本身，而不是只看"构建成功"。
//
// 检查三件事：
//   1) 前端产物真的在包里（assets/index.html 与 assets/assets/*）；
//   2) 版本号与 package.json 的 mobileVersion 一致（单一真相源）；
//   3) versionCode 符合 1.2.3 → 10203 的推导规则（不单调递增会导致装不上新版本）。
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const apk = process.argv[2] || join(here, "out", "toolcove-release.apk");

const problems = [];
const ok = (message) => console.log(`  ✓ ${message}`);
const bad = (message) => {
  problems.push(message);
  console.log(`  ✗ ${message}`);
};

// ── 1. 前端产物 ─────────────────────────────────────────────────────
console.log(`检查 ${apk}`);
const buf = readFileSync(apk);
const names = [];
let i = 0;
while ((i = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), i)) !== -1) {
  const nameLen = buf.readUInt16LE(i + 26);
  const extraLen = buf.readUInt16LE(i + 28);
  const size = buf.readUInt32LE(i + 18);
  names.push(buf.subarray(i + 30, i + 30 + nameLen).toString("utf8"));
  i += 30 + nameLen + extraLen + size;
}
if (names.includes("assets/index.html")) ok("包含 assets/index.html");
else bad("缺少 assets/index.html —— 这是个空壳包，装上会白屏");

const chunks = names.filter((n) => n.startsWith("assets/assets/") && n.endsWith(".js"));
if (chunks.length >= 5) ok(`包含 ${chunks.length} 个前端 chunk（工具按需加载）`);
else bad(`前端 chunk 只有 ${chunks.length} 个，疑似资源没同步完整`);

// 标签排版引擎的 wasm：缺了它标签工具装上就废（而且是"打开那个工具才暴露"的失败形态）
const wasm = names.filter((n) => n.startsWith("assets/assets/") && n.endsWith(".wasm"));
if (wasm.length) ok(`包含排版引擎 ${wasm.map((n) => n.split("/").pop()).join(", ")}`);
else bad("缺少 label-core.wasm —— 标签工具会加载失败");

// ── 2. 版本号 ───────────────────────────────────────────────────────
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const aapt = join(here, ".toolchain", "android-sdk", "build-tools", "35.0.0", process.platform === "win32" ? "aapt2.exe" : "aapt2");
let badging = "";
try {
  badging = execFileSync(aapt, ["dump", "badging", apk], { encoding: "utf8" });
} catch {
  console.log("  （找不到 aapt2，跳过版本号检查——CI 上会由工作流单独校验）");
}

if (badging) {
  const line = badging.split("\n").find((l) => l.startsWith("package:")) || "";
  const versionName = /versionName='([^']+)'/.exec(line)?.[1] || "";
  const versionCode = Number(/versionCode='([^']+)'/.exec(line)?.[1] || 0);

  if (versionName === pkg.mobileVersion) ok(`versionName ${versionName} 与 package.json 一致`);
  else bad(`versionName ${versionName} 与 package.json 的 ${pkg.mobileVersion} 不一致`);

  const expected = pkg.mobileVersion
    .split(".")
    .reduce((acc, part, index) => acc + Number(part) * [10000, 100, 1][index], 0);
  if (versionCode === expected) ok(`versionCode ${versionCode} 符合推导规则`);
  else bad(`versionCode ${versionCode} 与推导值 ${expected} 不一致`);
}

// ── 3. 体积（只提示不拦截：这是给人看的参考值） ──────────────────────
console.log(`  · APK 体积 ${Math.round(buf.length / 1024)} KB`);

if (problems.length) {
  console.error(`\n产物自检未通过（${problems.length} 项）：`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log("\n产物自检通过");
