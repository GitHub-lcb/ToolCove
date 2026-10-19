#!/usr/bin/env node
// i18n 迁移基线重生成：新增 / 删除词条后刷新 src/i18n/preMigrationKeys.json。
//
// 基线是「迁移前快照」，用来抓「手术式改字典时多删了键 / 悄悄改了值」；
// 它必须由脚本生成：手改键列表容易漏、改哈希更是不可能，注释字段也容易丢。
//
// 用法：
//   node scripts/gen-i18n-baseline.mjs   （或 npm run gen:i18n-baseline）
// 何时跑：
//   新增/删除 i18n 词条（含工具包片段）之后；合并多个分支后最终统一跑一次。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { TOOL_MESSAGES } from "../src/i18n/tools.generated.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

/** 与运行时同一语义：对象递归合并，数组与标量以片段为准。 */
function deepMerge(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay || {})) {
    const objectLike = (v) => v && typeof v === "object" && !Array.isArray(v);
    out[key] = objectLike(value) && objectLike(out[key]) ? deepMerge(out[key], value) : value;
  }
  return out;
}

/** 扁平键（与 src/i18n/index.js 的 flatKeys 对齐）。 */
export function flatKeys(dict, prefix = "") {
  return Object.entries(dict).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    return value && typeof value === "object" ? flatKeys(value, full) : [full];
  });
}

/** 键→值摘要：排序后的扁平键值对取 sha256（与 i18nFragments.test.js 同一算法）。 */
export function messagesHash(dict) {
  const flat = {};
  const walk = (obj, prefix = "") => {
    for (const [key, value] of Object.entries(obj)) {
      const full = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object") walk(value, full);
      else flat[full] = value;
    }
  };
  walk(dict);
  const canonical = Object.keys(flat).sort().map((key) => [key, flat[key]]);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** 计算基线内容（纯函数，供守卫测试比对）。保留原有的 //、//why、//how 注释。 */
export function buildBaseline({ root = ROOT } = {}) {
  const zh = deepMerge(readJson(path.join(root, "src/i18n/zh-CN.json")), TOOL_MESSAGES["zh-CN"] || {});
  const en = deepMerge(readJson(path.join(root, "src/i18n/en-US.json")), TOOL_MESSAGES["en-US"] || {});
  const file = path.join(root, "src/i18n/preMigrationKeys.json");
  const previous = readJson(file);
  const zhKeys = flatKeys(zh).sort();
  return {
    file,
    data: {
      ...previous,
      count: zhKeys.length,
      zhKeys,
      zhMessagesSha256: messagesHash(zh),
      enMessagesSha256: messagesHash(en),
    },
  };
}

export function writeBaseline({ root = ROOT } = {}) {
  const { file, data } = buildBaseline({ root });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n");
  return { file, count: data.count };
}

function main() {
  const { file, count } = writeBaseline();
  console.log(`已重生成 ${path.relative(ROOT, file)}：${count} 个键`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
