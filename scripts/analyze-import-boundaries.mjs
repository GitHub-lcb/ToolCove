// 一次性分层边界盘点（分析用，非守卫）：
//   node scripts/analyze-import-boundaries.mjs
// 打印各跨区依赖边的实例，用于确定 eslint no-restricted-imports 的可行边界。
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP = new Set(["node_modules", "dist", "build", "out", "release-out", "test-results", "playwright-report", ".git", ".toolchain", ".vite"]);
const SCAN = ["src", "mobile/app"];

function walk(abs, out = []) {
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
    const p = path.join(abs, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (/\.(vue|js|mjs)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(p);
  }
  return out;
}

const files = SCAN.flatMap((d) => walk(path.join(ROOT, d)));
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;'"]*?from\s*['"]([^'"]+)['"]/g;
const DYN_RE = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const edges = [];
for (const file of files) {
  const text = fs.readFileSync(file, "utf8");
  const rel = path.relative(ROOT, file).replace(/\\/g, "/");
  for (const re of [IMPORT_RE, DYN_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const abs = path.resolve(path.dirname(file), spec).replace(/\\/g, "/");
      const relTarget = path.relative(ROOT, abs).replace(/\\/g, "/");
      edges.push({ from: rel, to: relTarget, spec });
    }
  }
}

const zone = (p) => {
  if (p.startsWith("src/tools/")) return "tools";
  if (p.startsWith("src/ui/")) return "ui";
  if (p.startsWith("src/agent/")) return "agent";
  if (p.startsWith("src/platform/")) return "platform";
  if (p.startsWith("src/i18n")) return "i18n";
  if (p.startsWith("src/data/")) return "data";
  if (p.startsWith("src/screenshot/")) return "screenshot";
  if (p.startsWith("src/sync/")) return "sync";
  if (p.startsWith("src/checkin/")) return "checkin";
  if (p.startsWith("src/styles/")) return "styles";
  if (p.startsWith("mobile/app")) return "mobile";
  if (/^src\/[A-Z][A-Za-z]*View\.vue$/.test(p)) return "root-view";
  if (/^src\/[A-Z][A-Za-z]*\.vue$/.test(p)) return "root-vue";
  if (p.startsWith("src/")) return "root-js";
  return "other";
};

const bucket = {};
for (const e of edges) {
  const a = zone(e.from);
  const b = zone(e.to);
  if (a === b || b === "other") continue;
  const key = `${a} -> ${b}`;
  (bucket[key] ||= []).push(`${e.from}:${e.spec}`);
}

const show = process.argv.slice(2);
for (const key of Object.keys(bucket).sort((x, y) => bucket[y].length - bucket[x].length)) {
  const list = bucket[key];
  if (show.length && !show.some((s) => key.includes(s))) continue;
  console.log(`\n${key}  (${list.length})`);
  for (const item of list.slice(0, 12)) console.log("   " + item);
  if (list.length > 12) console.log(`   … +${list.length - 12} more`);
}
console.log(`\n扫描 ${files.length} 个文件 / ${edges.length} 条相对 import`);
