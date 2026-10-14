#!/usr/bin/env node
// 工具 i18n 片段生成器：**工具词条住各自包内，框架按生成物合并**。
//
// 为什么要有它：i18n 字典（src/i18n/<locale>.json）曾是工具注册的最后一个共享面——
// 每加一个工具就要往那份 5500 行的巨型字典里插「名称 + 描述 + 关键词 + 一整棵界面词条树」，
// 两个人在不同分支各加一个工具时必然在同一批行上打架（工具包模型已经消灭了契约侧的争抢，
// 这里消灭 i18n 侧的最后一份）。
//
// 现在：一个工具的词条住在它自己的包内——src/tools/<key>/i18n.<locale>.json（嵌套 JSON，
// 只含本工具的子树）。本脚本扫这些片段、按 locale 深合并，写出 src/i18n/tools.generated.js：
//   export const TOOL_MESSAGES = Object.freeze({ "zh-CN": {...}, "en-US": {...} });
// 运行时（src/i18n/index.js）拿到手写字典后再与 TOOL_MESSAGES[locale] 深合并交给 vue-i18n。
//
// 为什么是「生成」而不是运行时 guru 扫描：与 gen-tool-registry.mjs 同源——把
// 「忘了跑脚本」变成测试红灯（见 src/i18n/i18nFragments.test.js），而不是等界面显示键名。
// 生成物是货真价实的静态 import，原生 Node ESM 与 Vite 都能读（手机端与桌面端同一份）。
//
// 合并规则（严格，任一不过就报错、不写盘）：
//   1. 每个工具两种语言的片段必须同在（只有一个语言的片段 = 漏翻译的隐患）
//   2. 逐工具：zh 与 en 片段的键集合必须一致
//   3. 同一路径既出现标量又出现子树 → 报错（子树与标量不可混用）
//   4. 两个片段对同一叶子键重复定义（值不同）→ 报错（两处真相）
//
// 用法：
//   node scripts/gen-tool-i18n.mjs          写盘
//   node scripts/gen-tool-i18n.mjs --check  只校验（守卫测试调用 checkI18n 直接比对）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

/** 框架支持的语言（与 src/i18n/index.js 的 LOCALES 一致）。 */
export const LOCALES = ["zh-CN", "en-US"];

const posix = (p) => p.replace(/\\/g, "/");

/**
 * 展开嵌套字典为点分键（**数组按索引展开**，与 src/i18n/index.js 的 flatKeys 同语义）。
 * 键集合比对用得到它：zh/en 片段若某个关键词数组长度不同，索引展开能立刻抓到。
 */
function collectPaths(value, prefix = "", out = []) {
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectPaths(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.push(prefix);
  }
  return out;
}

/** 扫出带 i18n 片段的工具包：src/tools/<key>/i18n.<locale>.json。 */
function scanFragments(root) {
  const toolsDir = path.join(root, "src/tools");
  const found = [];
  if (!fs.existsSync(toolsDir)) return found;
  for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = {};
    for (const locale of LOCALES) {
      const p = path.join(toolsDir, entry.name, `i18n.${locale}.json`);
      if (fs.existsSync(p)) files[locale] = p;
    }
    if (Object.keys(files).length) found.push({ key: entry.name, files });
  }
  found.sort((a, b) => a.key.localeCompare(b.key));
  return found;
}

/**
 * 深合并：把片段 source 并进 target。
 * 对象递归；数组与标量直接赋值。冲突（标量 vs 子树、重复定义）返回错误描述，否则 null。
 */
function mergeInto(target, source, trail, errors, owner) {
  for (const [k, v] of Object.entries(source)) {
    const at = trail ? `${trail}.${k}` : k;
    const existing = target[k];
    const objectLike = (x) => x && typeof x === "object" && !Array.isArray(x);
    if (objectLike(v)) {
      if (existing !== undefined && !objectLike(existing)) {
        errors.push(`路径冲突：${at} 一侧是标量、一侧是子树（片段 ${owner}）`);
        continue;
      }
      if (existing === undefined) target[k] = {};
      mergeInto(target[k], v, at, errors, owner);
    } else {
      if (objectLike(existing)) {
        errors.push(`路径冲突：${at} 一侧是子树、一侧是标量（片段 ${owner}）`);
        continue;
      }
      if (existing !== undefined && existing !== v) {
        errors.push(`重复定义且值不同：${at}（片段 ${owner}）`);
        continue;
      }
      target[k] = v;
    }
  }
}

/**
 * 生成产物内容（纯函数：不写盘，便于守卫测试直接比对）。
 * 返回 { files: { 绝对路径: 内容 }, toolMessages, fragmentKeys, errors }
 *   toolMessages —— 生成物 TOOL_MESSAGES 的内容（**只有工具词条**，不含手写字典；
 *                   运行时由 src/i18n/index.js 的 mergeMessages 并进字典）
 *   fragmentKeys —— 各 locale 片段展开出的扁平键（守卫用）
 */
export function buildI18n({ root = ROOT } = {}) {
  const sources = scanFragments(root);
  const errors = [];
  const toolMessages = Object.fromEntries(LOCALES.map((locale) => [locale, {}]));
  const fragmentKeys = Object.fromEntries(LOCALES.map((locale) => [locale, []]));

  for (const { key, files } of sources) {
    const missing = LOCALES.filter((locale) => !files[locale]);
    if (missing.length) {
      errors.push(`工具 ${key} 缺少 i18n 片段：${missing.map((l) => `i18n.${l}.json`).join("、")}（两种语言必须同在）`);
      continue;
    }
    const parsed = {};
    let bad = false;
    for (const locale of LOCALES) {
      try {
        parsed[locale] = JSON.parse(fs.readFileSync(files[locale], "utf8"));
      } catch (error) {
        errors.push(`片段 JSON 解析失败：${posix(path.relative(root, files[locale]))} → ${error?.message || error}`);
        bad = true;
      }
    }
    if (bad) continue;
    for (const locale of LOCALES) {
      if (!parsed[locale] || typeof parsed[locale] !== "object" || Array.isArray(parsed[locale])) {
        errors.push(`片段根必须是对象：${posix(path.relative(root, files[locale]))}`);
        bad = true;
      }
    }
    if (bad) continue;

    // 规则 2：逐工具 zh / en 键集合一致（数组按索引展开，长度不同也能抓到）。
    const zhKeys = collectPaths(parsed["zh-CN"]).sort();
    const enKeys = collectPaths(parsed["en-US"]).sort();
    const onlyZh = zhKeys.filter((k) => !enKeys.includes(k));
    const onlyEn = enKeys.filter((k) => !zhKeys.includes(k));
    if (onlyZh.length) errors.push(`工具 ${key}：zh 有而 en 无 → ${onlyZh.join(", ")}`);
    if (onlyEn.length) errors.push(`工具 ${key}：en 有而 zh 无 → ${onlyEn.join(", ")}`);

    for (const locale of LOCALES) {
      mergeInto(toolMessages[locale], parsed[locale], "", errors, key);
      fragmentKeys[locale].push(...collectPaths(parsed[locale]));
    }
  }

  if (errors.length) return { files: {}, toolMessages, fragmentKeys, errors };

  const outPath = path.join(root, "src/i18n/tools.generated.js");
  const content = [
    "// ⚠️ 本文件由 scripts/gen-tool-i18n.mjs 生成，请勿手改。",
    "// 重新生成：node scripts/gen-tool-i18n.mjs（或 npm run gen:i18n）",
    "//",
    "// 工具词条住在各自包内（src/tools/<key>/i18n.<locale>.json），本文件是它们在框架侧的合并产物：",
    "// 新增工具时只在该工具包内加片段文件，i18n 不再需要改共享字典（src/i18n/<locale>.json）。",
    "//",
    "// 取舍：本文件被 src/i18n/index.js **静态** import，因此它包含两种语言的工具词条。",
    "// 这是可接受的——它只含工具词条，规模远小于整份字典；手写字典仍维持「首屏只打包当前语言」",
    "// （en-US 字典走动态 import，见 index.js）。若将来工具词条膨胀到可观体量，可拆成每语言独立生成物，",
    "// 让 en 与字典同走动态 import。",
    "export const TOOL_MESSAGES = Object.freeze(" + JSON.stringify(toolMessages, null, 2) + ");",
    "",
  ].join("\n");

  return { files: { [outPath]: content }, toolMessages, fragmentKeys, errors: [] };
}

/** 校验生成物与片段现状是否一致；返回 { errors, stale }（stale 空 = 一致）。 */
export function checkI18n({ root = ROOT } = {}) {
  const { files, errors } = buildI18n({ root });
  if (errors.length) return { errors, stale: [] };
  const stale = [];
  for (const [file, expected] of Object.entries(files)) {
    let actual = null;
    try {
      actual = fs.readFileSync(file, "utf8");
    } catch {
      actual = null;
    }
    if (actual !== expected) stale.push(posix(path.relative(root, file)));
  }
  return { errors: [], stale };
}

async function main() {
  const check = process.argv.includes("--check");
  const { files, errors } = buildI18n();
  if (errors.length) {
    console.error("生成失败：\n  " + errors.join("\n  "));
    process.exit(1);
  }
  if (check) {
    const { stale, errors: errs } = checkI18n();
    if (errs.length) {
      console.error("扫描/加载失败：\n  " + errs.join("\n  "));
      process.exit(1);
    }
    if (stale.length) {
      console.error("生成物与片段不一致（忘记跑生成器？）：\n  " + stale.join("\n  "));
      process.exit(1);
    }
    console.log("生成物与片段一致。");
    return;
  }
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(file, content);
    console.log("写入 " + posix(path.relative(ROOT, file)));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
