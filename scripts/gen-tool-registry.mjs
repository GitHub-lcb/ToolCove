#!/usr/bin/env node
// 工具注册表生成器：**目录即注册**。
//
// 扫描源只有一个：src/tools/<key>/contract.js（一个工具 = 一个自包含包）。
// 过渡期已关闭——旧的 src/contracts/<key>.js 形态不复存在，本目录只剩基础设施
// （index.js / index.generated.js / kit.js / groups.js），findStrayContracts 会把
// 重新冒出来的旧形态契约变成红灯，避免注册又被悄悄拆回两处。
// 生成三个**静态 import** 产物：
//   src/contracts/index.generated.js   → { TOOL_CONTRACTS, CONTRACT_BY_KEY }
//   src/toolComponents.generated.js    → { TOOL_COMPONENT_LOADERS }
//   src/toolExecutors.generated.js     → { TOOL_EXECUTORS }
//
// 为什么是「生成」而不是 import.meta.glob：契约必须能被**原生 Node ESM** 直接 import
// （手机端对齐测试走的是真实 import 路径，见 mobile/app/toolboxIcons.test.js），
// 而 glob 是 Vite 特性、原生 Node 不认。生成物是货真价实的静态 import，两边都能读。
//
// 为什么生成物要入库：与项目既有风格一致——把「忘了跑脚本」变成测试红灯
// （见 src/tools/registryGating.test.js），而不是等到线上缺工具才发现。
//
// 展示顺序：契约自带的 `order` 字段是单一真相源；缺失者排在有 order 的之后、按 key 排。
//
// 用法：
//   node scripts/gen-tool-registry.mjs          写盘
//   node scripts/gen-tool-registry.mjs --check  只校验（守卫测试调用 buildRegistry 直接比对）

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, "..");

/** 契约聚合器自身与共享数据件不算工具（kit 是 Schema 小件，groups 是分组元数据）。 */
const CONTRACT_INFRA = new Set(["index.js", "index.generated.js", "kit.js", "groups.js"]);

const posix = (p) => p.replace(/\\/g, "/");
const relFrom = (fromFile, target) => {
  const r = posix(path.relative(path.dirname(fromFile), target));
  return r.startsWith(".") ? r : "./" + r;
};

/** 扫出全部工具契约来源：只有工具包形态 src/tools/<key>/contract.js。 */
function scanContracts(root) {
  const found = [];
  const toolsDir = path.join(root, "src/tools");
  for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const contract = path.join(toolsDir, entry.name, "contract.js");
    if (fs.existsSync(contract)) found.push({ key: entry.name, file: contract, pkg: entry.name });
  }
  return found;
}

/**
 * 守卫「过渡期已关闭」：src/contracts/ 只许剩基础设施（CONTRACT_INFRA）与测试。
 * 若这里又出现一个工具契约，说明有人把契约拆回了旧形态——注册会变成两处，必须红灯。
 */
function findStrayContracts(root) {
  const contractsDir = path.join(root, "src/contracts");
  const strays = [];
  for (const entry of fs.readdirSync(contractsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) continue;
    if (CONTRACT_INFRA.has(entry.name) || entry.name.endsWith(".test.js")) continue;
    strays.push(posix(path.relative(root, path.join(contractsDir, entry.name))));
  }
  return strays;
}

/**
 * 生成三个产物内容（纯函数：不写盘，便于守卫测试直接比对）。
 * 返回 { files: { 绝对路径: 内容 } , errors: string[] }
 */
export async function buildRegistry({ root = ROOT } = {}) {
  const sources = scanContracts(root);
  const entries = [];
  const errors = [];

  // 过渡期已关闭：src/contracts 只剩基础设施，再冒出工具契约就是回退。
  for (const stray of findStrayContracts(root)) {
    errors.push(`src/contracts 出现旧形态契约（过渡期已关闭，契约应住 src/tools/<key>/contract.js）：${stray}`);
  }

  for (const source of sources) {
    let mod;
    try {
      mod = await import(pathToFileURL(source.file).href);
    } catch (error) {
      errors.push(`契约无法加载：${posix(path.relative(root, source.file))} → ${error?.message || error}`);
      continue;
    }
    const contract = mod.default;
    if (!contract || typeof contract !== "object") {
      errors.push(`契约缺少默认导出：${posix(path.relative(root, source.file))}`);
      continue;
    }
    if (contract.key !== source.key) {
      errors.push(`契约 key（${contract.key}）与所在位置（${source.key}）不一致：${posix(path.relative(root, source.file))}`);
      continue;
    }
    entries.push({ ...source, order: Number.isFinite(contract.order) ? contract.order : null });
  }

  // 唯一性
  const byKey = new Set();
  for (const e of entries) {
    if (byKey.has(e.key)) errors.push(`契约 key 重复：${e.key}`);
    byKey.add(e.key);
  }
  const orders = entries.filter((e) => e.order !== null);
  const seenOrder = new Map();
  for (const e of orders) {
    if (seenOrder.has(e.order)) errors.push(`order 重复：${e.order}（${seenOrder.get(e.order)} 与 ${e.key}）`);
    seenOrder.set(e.order, e.key);
  }

  // 展示顺序：有 order 的在前（升序），其余按 key 排在后面
  entries.sort((a, b) => {
    if (a.order !== null && b.order !== null) return a.order - b.order || a.key.localeCompare(b.key);
    if (a.order !== null) return -1;
    if (b.order !== null) return 1;
    return a.key.localeCompare(b.key);
  });

  if (errors.length) return { files: {}, errors };

  // ---- 产物 1：契约聚合 ----
  const indexPath = path.join(root, "src/contracts/index.generated.js");
  const importLines = entries.map((e, i) => `import tool${i} from "${relFrom(indexPath, e.file)}";`);
  const listLines = entries.map((e, i) => `  tool${i},`);
  const indexContent = [
    "// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。",
    "// 重新生成：node scripts/gen-tool-registry.mjs（或 npm run gen:tools）",
    "//",
    "// 为什么是生成物：新增工具只加一个目录（src/tools/<key>/），注册由脚本扫描得出——",
    "// 两个人在不同分支各加一个工具时，不会争抢同一个登记点。",
    "// 顺序 = 各契约的 order 字段（画廊展示顺序的单一真相源）。",
    ...importLines,
    "",
    "export const TOOL_CONTRACTS = Object.freeze([",
    ...listLines,
    "]);",
    "",
    "export const CONTRACT_BY_KEY = new Map(TOOL_CONTRACTS.map((contract) => [contract.key, contract]));",
    "",
  ].join("\n");

  // ---- 产物 2：组件加载器 ----
  const compPath = path.join(root, "src/toolComponents.generated.js");
  const compLines = [];
  for (const e of entries) {
    const view = path.join(root, "src/tools", e.pkg, "View.vue");
    if (!fs.existsSync(view)) {
      errors.push(`工具包缺少界面：src/tools/${e.pkg}/View.vue`);
      continue;
    }
    compLines.push(`  ${JSON.stringify(e.key)}: () => import("${relFrom(compPath, view)}"),`);
  }
  if (errors.length) return { files: {}, errors };
  const compContent = [
    "// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。",
    "// 重新生成：node scripts/gen-tool-registry.mjs",
    "//",
    "// 工具界面一律懒加载：只有真要打开某个工具的窗口/页面时才 import 它的 View.vue。",
    "export const TOOL_COMPONENT_LOADERS = Object.freeze({",
    ...compLines,
    "});",
    "",
  ].join("\n");

  // ---- 产物 3：动作实现（只有已迁进工具包的才有） ----
  const execPath = path.join(root, "src/toolExecutors.generated.js");
  const execPackages = entries.filter((e) => e.pkg && fs.existsSync(path.join(root, "src/tools", e.pkg, "executor.js")));
  const execImports = execPackages.map((e, i) => `import executor${i} from "${relFrom(execPath, path.join(root, "src/tools", e.pkg, "executor.js"))}";`);
  const execSpreads = execPackages.map((e, i) => `  ...executor${i},`);
  const execContent = [
    "// ⚠️ 本文件由 scripts/gen-tool-registry.mjs 生成，请勿手改。",
    "// 重新生成：node scripts/gen-tool-registry.mjs",
    "//",
    "// 各工具包自带的 Agent 动作实现。还没迁进包的工具，其实现仍在 agent/executors.js 手写区。",
    "// 装配：agent/executors.js 把本对象合并进 BUILTIN_TOOL_IMPLS（键集合由 catalog.test.js 双向强制）。",
    ...execImports,
    "",
    "export const TOOL_EXECUTORS = Object.freeze({",
    ...execSpreads,
    "});",
    "",
  ].join("\n");

  return {
    files: {
      [indexPath]: indexContent,
      [compPath]: compContent,
      [execPath]: execContent,
    },
    entries,
    errors: [],
  };
}

/** 校验生成物与目录现状是否一致；返回不一致的文件（空数组 = 一致）。 */
export async function checkRegistry({ root = ROOT } = {}) {
  const { files, errors } = await buildRegistry({ root });
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
  const { files, errors } = await buildRegistry();
  if (errors.length) {
    console.error("生成失败：\n  " + errors.join("\n  "));
    process.exit(1);
  }
  if (check) {
    const { stale } = await checkRegistry();
    if (stale.length) {
      console.error("生成物与目录不一致（忘记跑生成器？）：\n  " + stale.join("\n  "));
      process.exit(1);
    }
    console.log("生成物与目录一致。");
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
