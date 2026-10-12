#!/usr/bin/env node
// 把子代理产出的 i18n 片段合并进 zh-CN.json / en-US.json。
//
// 为什么要有这个脚本而不是手工合并：并行改造 work 模块六个视图时，四个子代理
// 各自产出片段文件（互不写字典，避免冲突），最后由这一次合并统一落盘。
// 手工合并 600+ 个键既慢又容易漏，而且漏了不会有任何报错——只会在界面上
// 显示键名（vue-i18n 对未知键静默返回键名）。
//
// 校验规则（任一不过就拒绝写入，保持字典原样）：
//   1. 片段里 zh 与 en 的键集合必须完全一致
//   2. 值必须是非空字符串
//   3. 键不得包含空白；点分层级不得产生冲突（已存在标量 vs 新增子键）
//   4. 不覆盖已存在的键（重复定义会让字典出现两处真相）——
//      但允许 --force 覆盖，用于修正译错的既有词条
//
// 用法：node scripts/merge-i18n-fragments.mjs [--force] [--dry] [片段目录]
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const DRY = args.includes("--dry");
const dirArg = args.find((a) => !a.startsWith("--")) || "tmp/i18n-fragments";
const FRAG_DIR = path.resolve(dirArg);
const ZH_PATH = "src/i18n/zh-CN.json";
const EN_PATH = "src/i18n/en-US.json";

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** 点分键 → 嵌套写入；返回冲突描述或 null */
function setDeep(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (cur[k] === undefined) cur[k] = {};
    else if (typeof cur[k] !== "object" || cur[k] === null || Array.isArray(cur[k])) {
      return `路径冲突：${parts.slice(0, i + 1).join(".")} 已是标量`;
    }
    cur = cur[k];
  }
  const last = parts[parts.length - 1];
  if (typeof cur[last] === "object" && cur[last] !== null) return `路径冲突：${dotted} 已是对象`;
  cur[last] = value;
  return null;
}

function getDeep(obj, dotted) {
  return dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}

/** 收集片段文件里的键（一律展开成点分形式，便于比对） */
function flatten(obj, prefix = "", out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

const problems = [];
const additions = { zh: {}, en: {} };
const skipped = [];

const files = fs
  .readdirSync(FRAG_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

if (!files.length) {
  console.error(`片段目录里没有 .json：${FRAG_DIR}`);
  process.exit(1);
}

const zh = readJson(ZH_PATH);
const en = readJson(EN_PATH);

for (const file of files) {
  let frag;
  try {
    frag = readJson(path.join(FRAG_DIR, file));
  } catch (e) {
    problems.push(`${file}: JSON 解析失败 — ${e.message}`);
    continue;
  }
  const fz = frag.zh;
  const fe = frag.en;
  if (!fz || typeof fz !== "object") {
    problems.push(`${file}: 缺少 zh 段`);
    continue;
  }
  if (!fe || typeof fe !== "object") {
    problems.push(`${file}: 缺少 en 段`);
    continue;
  }

  const fzFlat = flatten(fz);
  const feFlat = flatten(fe);

  // 规则 1：键集合一致
  const zk = Object.keys(fzFlat).sort();
  const ek = Object.keys(feFlat).sort();
  const onlyZh = zk.filter((k) => !ek.includes(k));
  const onlyEn = ek.filter((k) => !zk.includes(k));
  if (onlyZh.length) problems.push(`${file}: zh 有而 en 无 → ${onlyZh.join(", ")}`);
  if (onlyEn.length) problems.push(`${file}: en 有而 zh 无 → ${onlyEn.join(", ")}`);

  for (const key of zk) {
    const zv = fzFlat[key];
    const ev = feFlat[key];
    // 规则 2：值非空
    if (typeof zv !== "string" || !zv.trim()) problems.push(`${file}: zh.${key} 为空或非字符串`);
    if (typeof ev !== "string" || !ev.trim()) problems.push(`${file}: en.${key} 为空或非字符串`);
    // 规则 3：键不含空白
    if (/\s/.test(key)) problems.push(`${file}: 键含空白 → ${JSON.stringify(key)}`);
    // 规则 4：不重复定义
    if (!FORCE) {
      if (getDeep(zh, key) !== undefined) {
        skipped.push(`${key}（zh 已存在）`);
        continue;
      }
      if (getDeep(en, key) !== undefined) {
        skipped.push(`${key}（en 已存在）`);
        continue;
      }
    }
    additions.zh[key] = zv;
    additions.en[key] = ev;
  }
}

if (problems.length) {
  console.error("校验未通过，字典未改动：\n");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}

const zhKeys = Object.keys(additions.zh);
console.log(`片段文件：${files.length} 个（${files.join(", ")}）`);
console.log(`待新增键：${zhKeys.length}`);
if (skipped.length) console.log(`跳过已存在：${skipped.length} 个（${skipped.slice(0, 5).join("; ")}${skipped.length > 5 ? " …" : ""}）`);

for (const key of zhKeys) {
  const c1 = setDeep(zh, key, additions.zh[key]);
  const c2 = setDeep(en, key, additions.en[key]);
  if (c1) problems.push(`zh ${key}: ${c1}`);
  if (c2) problems.push(`en ${key}: ${c2}`);
}
if (problems.length) {
  console.error("写入时发现路径冲突，字典未改动：\n");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}

// 收尾自检：两套字典键集合必须仍然完全一致（这是 i18n.test.js 的核心断言）
const zkAll = Object.keys(flatten(zh)).sort();
const ekAll = Object.keys(flatten(en)).sort();
if (zkAll.length !== ekAll.length || zkAll.some((k, i) => k !== ekAll[i])) {
  console.error(`收尾自检失败：zh ${zkAll.length} 键 vs en ${ekAll.length} 键，键集合不一致`);
  const miss = zkAll.filter((k) => !ekAll.includes(k));
  const extra = ekAll.filter((k) => !zkAll.includes(k));
  if (miss.length) console.error("  只存在于 zh：" + miss.slice(0, 10).join(", "));
  if (extra.length) console.error("  只存在于 en：" + extra.slice(0, 10).join(", "));
  process.exit(1);
}

if (DRY) {
  console.log(`\n[dry-run] 未写入。校验通过，合并后字典各 ${zkAll.length} 键。`);
  process.exit(0);
}

fs.writeFileSync(ZH_PATH, JSON.stringify(zh, null, 2) + "\n");
fs.writeFileSync(EN_PATH, JSON.stringify(en, null, 2) + "\n");
console.log(`\n已写入 ${ZH_PATH} 与 ${EN_PATH}，各 ${zkAll.length} 键。`);
