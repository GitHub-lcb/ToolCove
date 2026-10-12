#!/usr/bin/env node
// 把一批模块移进子目录，并把**全仓**引用它们的相对 import 一起改到新的相对路径。
//
// 用法：
//   node scripts/move-into-subdir.mjs --dest src/tools/interview --apply src/tools/interviewBank*.js ...
//   node scripts/move-into-subdir.mjs --dest <新目录> <要移动的文件...>            # 默认 dry-run，只打印
//
// 为什么用「解析后的真实路径」而不是文本替换：
//   `./interviewBankParts.js`（同批移动，保持 `./`）、`../i18n/index.js`（越级变 `../../`）、
//   `./JsonTool.vue`（不搬，变 `../JsonTool.vue`）三种情况**长得像但结果不同**，
//   纯文本替换必然漏一类。这里先把每条 specifier 解析到绝对路径，再按「目标新位置 vs 文件新位置」
//   重算相对路径，判据只有一条：真实路径。
//
// 行尾按文件保留（见 docs/ui-upgrade-progress-and-constraints.md 里的 CRLF 教训）。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const destIdx = argv.indexOf("--dest");
if (destIdx < 0) {
  console.error("用法：--dest <新目录> <文件...> [--apply]");
  process.exit(2);
}
const dest = path.resolve(ROOT, argv[destIdx + 1]);
const flags = argv.filter((a, i) => !a.startsWith("--") && !(i === destIdx + 1));
const apply = argv.includes("--apply");
const moved = flags.map((rel) => path.resolve(ROOT, rel)).filter((abs) => fs.existsSync(abs));

if (!moved.length) {
  console.error("没有匹配到要移动的文件");
  process.exit(2);
}

/** 扫描范围：所有可能 import 这些模块的地方 */
const SCAN = ["src", "mobile/app", "e2e", "scripts"];
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "out", "release-out", "test-results", "playwright-report", ".toolchain", ".vite"]);

function walk(abs, out = []) {
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|vue|css)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** oldAbs → newAbs */
const moveMap = new Map(moved.map((abs) => [abs, path.join(dest, path.basename(abs))]));
for (const [fromAbs, toAbs] of moveMap) {
  if (path.dirname(fromAbs) === path.dirname(toAbs)) {
    console.error(`目标目录与源目录相同：${fromAbs}`);
    process.exit(2);
  }
}

const SPEC_RE = /((?:^|\n)\s*(?:import|export)[^;'"]*?from\s*|(?<![\w$])import\(\s*|(?<![\w$.])(?:vi|jest)\.(?:unmock|mock|doMock|doUnmock|mockOnce|mockResolvedValue|mockRejectedValue)\(\s*)(['"])(\.\.?\/[^'"]*)\2/g;

let filesTouched = 0;
let specsRewritten = 0;
const report = [];

for (const dir of SCAN) {
  for (const fileAbs of walk(path.resolve(ROOT, dir))) {
    const isNewHome = moveMap.has(fileAbs);
    const homeAfter = isNewHome ? moveMap.get(fileAbs) : fileAbs;
    const original = fs.readFileSync(fileAbs, "utf8");
    const crlf = original.includes("\r\n");
    const text = crlf ? original.replace(/\r\n/g, "\n") : original;

    let hits = 0;
    const next = text.replace(SPEC_RE, (whole, prefix, quote, spec) => {
      const targetAbs = path.resolve(path.dirname(fileAbs), spec);
      const newTarget = moveMap.get(targetAbs) || targetAbs;
      // 两端都可能动：引用方搬家（./x.js 要变 ../x.js）、或被引用方搬家
      if (newTarget === targetAbs && homeAfter === fileAbs) return whole;
      let rel = path.relative(path.dirname(homeAfter), newTarget).replace(/\\/g, "/");
      if (!rel.startsWith(".")) rel = "./" + rel;
      if (rel === spec) return whole;
      hits++;
      specsRewritten++;
      return `${prefix}${quote}${rel}${quote}`;
    });

    if (hits > 0) {
      filesTouched++;
      const body = crlf ? next.replace(/\n/g, "\r\n") : next;
      report.push(`${path.relative(ROOT, homeAfter).replace(/\\/g, "/")}: ${hits} 条`);
      if (apply) fs.writeFileSync(fileAbs, body, "utf8");
    }
  }
}

console.log(`${apply ? "已改写" : "将改写"} ${specsRewritten} 条 import，分布在 ${filesTouched} 个文件：`);
for (const line of report) console.log("   " + line);

if (!apply) {
  console.log(`\n将移动 ${moved.length} 个文件到 ${path.relative(ROOT, dest).replace(/\\/g, "/")}/（dry-run，加 --apply 才动手）`);
  console.log("注意：本脚本只改 import 语句；注释与文档里的路径字符串要人工同步。");
  process.exit(0);
}

fs.mkdirSync(dest, { recursive: true });
for (const [fromAbs, toAbs] of moveMap) fs.renameSync(fromAbs, toAbs);
console.log(`\n已移动 ${moved.length} 个文件到 ${path.relative(ROOT, dest).replace(/\\/g, "/")}/`);
