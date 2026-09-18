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

// ── 资源布局与内置服务的候选前缀是否对得上 ────────────────────────────
// 这是"空壳包白屏"事故的防线：AssetsServer 按候选前缀顺序找资源，
// 如果三种候选都对不上真实布局，装上去就是白屏（而且构建是"成功"的）。
//
// 候选顺序**从 Kotlin 源码里读**（bridge/AssetPath.kt 的 candidatesFor），
// 不在这里手写第二份——两份清单迟早会漂，而漂了就是白屏。
const assetPathSource = readFileSync(join(here, "app", "src", "main", "java", "com", "githublcb", "toolcove", "bridge", "AssetPath.kt"), "utf8");
const candidateLine = /fun candidatesFor\(path: String\): List<String> = (.*)/.exec(assetPathSource);
if (!candidateLine) {
  bad("读不到 AssetPath.candidatesFor —— 它改了名字或写法，这个检查要跟着改");
} else {
  // Kotlin 的写法是 listOf("web/$path", path, "web/web/$path")：
  // 引号里的是模板，裸的 `path` 是"原样路径"（第二种候选）。
  // 所以要把带引号的模板与裸标识符都翻出来，否则报告里会漏掉最关键的那一种
  // （而真实 APK 恰好就是靠"原样路径"命中的——AGP 这次没保留 web 目录）。
  const quoted = [...candidateLine[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const hasBarePath = /(^|[\s,(])path([\s,)]|$)/.test(candidateLine[1]);
  const patterns = [...(hasBarePath ? ["$path"] : []), ...quoted];
  if (!patterns.length) bad("候选列表解析为空 —— 检查逻辑要跟着 Kotlin 的写法改");

  const inApk = names.filter((n) => n.startsWith("assets/")).map((n) => n.replace(/^assets\//, ""));
  const applyPattern = (pattern, path) => pattern.replace("$path", path);
  const resolveInApk = (requestPath) => patterns.map((p) => applyPattern(p, requestPath)).find((candidate) => inApk.includes(candidate)) || "";

  // 包里每个"前端会请求的文件"都要能被某个候选命中
  const requestable = inApk.filter((n) => n === "index.html" || n.startsWith("assets/"));
  const unreachable = requestable.filter((requestPath) => !resolveInApk(requestPath));
  if (unreachable.length) {
    bad(`这些资源按候选前缀都找不到（会 404 → 白屏）：${unreachable.slice(0, 5).join(", ")}${unreachable.length > 5 ? ` …共 ${unreachable.length} 个` : ""}`);
  } else {
    ok(`资源布局与候选前缀一致（${requestable.length} 个资源都能命中）`);
    // 报告实际命中的是哪一种：这个信息在排查"换了 AGP 版本后布局变了"时很有用
    const hitKind = new Map();
    for (const requestPath of requestable) {
      const hit = resolveInApk(requestPath);
      const pattern = patterns.find((p) => applyPattern(p, requestPath) === hit) || "?";
      hitKind.set(pattern, (hitKind.get(pattern) || 0) + 1);
    }
    ok(`命中分布：${[...hitKind].map(([pattern, count]) => `${pattern} ×${count}`).join("，")}`);
  }
  if (!resolveInApk("index.html")) bad("index.html 无法命中 —— 装上就是白屏");
}

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
