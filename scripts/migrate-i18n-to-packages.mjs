#!/usr/bin/env node
// 一次性迁移脚本：把「工具词条」从共享字典 src/i18n/<locale>.json 搬进各自工具包内的
// i18n 片段（src/tools/<key>/i18n.<locale>.json）——即 i18n 归包。
//
// 为什么用脚本而不是手改：26 个工具、上千个叶子键，手改既慢又必然漏（漏了界面只会把键名
// 显示给用户，没有任何既有测试会报错）。这里用「按路径搬迁」保证：
//   · 字典侧是**纯删除**——其余键的相对顺序与值一字不动（沿用 JSON.stringify(obj,null,2)+"\n" 的原格式）；
//   · 片段侧保留这些键在字典里的原相对顺序（嵌套结构与书写顺序都照搬）。
//
// 归属原则（照任务给的清单逐条核实过）：一个命名空间/键组只有在「使用点都归这个工具的
// 功能」时才搬。这里刻意**不搬**的共享命名空间见脚本末尾的 SHARED 注释；
// 顶层 `prompt` / `json` 与 `toolbox.ai` 因被 src/ai.js、src/json.js、MarkdownRender 等
// 跨功能消费，留在共享字典。
//
// 用法：node scripts/migrate-i18n-to-packages.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["zh-CN", "en-US"];

// key：工具包目录名；subtrees：整棵搬迁的命名空间；registry/agent：搬迁的具体叶子键名。
const SPECS = [
  { key: "convert", subtrees: ["toolbox.convert"], registry: ["toolConvert", "toolConvertDesc", "kwConvert"], agent: ["toolBase64Encode", "toolBase64Decode"] },
  { key: "table", subtrees: ["toolbox.table"], registry: ["toolTable", "toolTableDesc", "kwTable"], agent: ["toolTableParse", "toolTableConvert"] },
  { key: "markdown", subtrees: ["toolbox.markdown"], registry: ["toolMarkdown", "toolMarkdownDesc", "kwMarkdown"], agent: ["toolMarkdownNormalize", "toolMarkdownLint"] },
  { key: "xml", subtrees: ["toolbox.xml"], registry: ["toolXml", "toolXmlDesc", "kwXml"], agent: ["toolXmlFormat", "toolXmlToJson", "toolXmlValidate"] },
  // diff 的 View（TextTool 含文本处理 + 对比两页签）：toolbox.text 与 toolbox.diff 都归它。
  { key: "diff", subtrees: ["toolbox.diff", "toolbox.text"], registry: ["toolDiff", "toolDiffDesc", "kwDiff"], agent: ["toolTextDiff"] },
  { key: "schema", subtrees: ["toolbox.schema"], registry: ["toolSchema", "toolSchemaDesc", "kwSchema"], agent: ["toolSchemaInfer", "toolSchemaValidate"] },
  { key: "time", subtrees: ["toolbox.time"], registry: ["toolTime", "toolTimeDesc", "kwTime"], agent: ["toolTimeTimestamp"] },
  // toolbox.yaml 是 JsonTool 的 YAML 页签；顶层 `json`（sensitiveKeyWords）被共享模块 src/json.js 消费，留在字典。
  { key: "json", subtrees: ["toolbox.json", "toolbox.yaml"], registry: ["toolJson", "toolJsonDesc", "kwJson"], agent: ["toolJsonParse", "toolJsonFormat", "toolYamlToJson"] },
  { key: "network", subtrees: ["toolbox.network"], registry: ["toolNetwork", "toolNetworkDesc", "kwNetwork"], agent: ["toolNetworkPing", "toolNetworkTrace", "toolNetworkDns", "toolNetworkTcpCheck"] },
  { key: "crypto", subtrees: ["toolbox.crypto"], registry: ["toolCrypto", "toolCryptoDesc", "kwCrypto"], agent: ["toolCryptoHash", "toolCryptoHmac", "toolCryptoPassword"] },
  { key: "file", subtrees: ["toolbox.file"], registry: ["toolFile", "toolFileDesc", "kwFile"], agent: ["toolFileInspect", "toolFileReadText", "toolFileWriteText", "toolFilePreviewWrite", "toolFileListDirectory"] },
  { key: "image", subtrees: ["toolbox.image"], registry: ["toolImage", "toolImageDesc", "kwImage"], agent: ["toolImagePlan"] },
  { key: "request", subtrees: ["toolbox.request"], registry: ["toolRequest", "toolRequestDesc", "kwRequest"], agent: ["toolHttpRequest"] },
  { key: "db", subtrees: ["toolbox.db"], registry: ["toolDb", "toolDbDesc", "kwDb"], agent: ["toolDbQueryReadonly"] },
  { key: "generator", subtrees: ["toolbox.generator"], registry: ["toolGenerator", "toolGeneratorDesc", "kwGenerator"], agent: ["toolIdGenerate"] },
  { key: "downloader", subtrees: ["toolbox.downloader"], registry: ["toolDownloader", "toolDownloaderDesc", "kwDownloader"], agent: [] },
  // chat 的 `toolbox.ai` 同时被 src/ai.js / chatSession / typesafe / MarkdownRender 消费，留共享字典：只搬注册表组。
  { key: "chat", subtrees: [], registry: ["toolChat", "toolChatDesc", "kwChat"], agent: [] },
  { key: "checkin", subtrees: ["checkin"], registry: ["toolCheckin", "toolCheckinDesc", "kwCheckin"], agent: [] },
  { key: "netcapture", subtrees: ["netcapture"], registry: ["toolNetcapture", "toolNetcaptureDesc", "kwNetcapture"], agent: [] },
  // 顶层 `prompt`（提示词模板/抽取指令）被共享 AI 层 src/ai.js 消费，留共享字典；toolbox.prompt 归提示词工具。
  { key: "prompt", subtrees: ["toolbox.prompt"], registry: ["toolPrompt", "toolPromptDesc", "kwPrompt"], agent: [] },
  { key: "screenshot", subtrees: ["screenshot"], registry: ["toolScreenshot", "toolScreenshotDesc", "kwScreenshot"], agent: [] },
  { key: "label", subtrees: ["toolbox.label"], registry: ["toolLabel", "toolLabelDesc", "kwLabel"], agent: [] },
  { key: "disk", subtrees: ["toolbox.disk"], registry: ["toolDisk", "toolDiskDesc", "kwDisk"], agent: [] },
  { key: "photo", subtrees: ["toolbox.photo"], registry: ["toolPhoto", "toolPhotoDesc", "kwPhoto"], agent: [] },
  { key: "rail", subtrees: ["toolbox.rail"], registry: ["toolRail", "toolRailDesc", "kwRail"], agent: [] },
  { key: "interview", subtrees: ["toolbox.interview"], registry: ["toolInterview", "toolInterviewDesc", "kwInterview"], agent: [] },
];

// 留共享字典（理由）：toolbox.gallery / toolbox.launchpad / toolbox.handoff / toolbox.comingSoon /
// toolbox.windowFailRetry / toolbox.windowFailFallback（画廊/启动台/交接/系统壳文案），
// 顶层 prompt / json，toolbox.ai，以及 toolbox.registry 里的非工具键。

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));
const getDeep = (o, parts) => parts.reduce((x, k) => (x == null ? x : x[k]), o);

/** 从 entries（一层对象）里分出「归某工具的搬迁项」与「保留项」，两者都保持原有顺序。 */
function partition(entries, prefix, subtreeOwner, leafOwner, fragments) {
  const kept = {};
  for (const [k, v] of Object.entries(entries)) {
    const dot = prefix ? `${prefix}.${k}` : k;
    let owner = subtreeOwner.get(dot) || leafOwner.get(dot);
    if (owner) {
      // 记入该工具的片段：按原顺序逐层搭出嵌套结构
      let node = fragments[owner];
      for (const part of dot.split(".").slice(0, -1)) node = node[part] ||= {};
      node[k] = v;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sub = partition(v, dot, subtreeOwner, leafOwner, fragments);
      if (Object.keys(sub).length) kept[k] = sub;
    } else {
      kept[k] = v;
    }
  }
  return kept;
}

function migrate(locale) {
  const dictPath = path.join(ROOT, "src/i18n", `${locale}.json`);
  const dict = readJson(dictPath);
  const subtreeOwner = new Map();
  const leafOwner = new Map();
  for (const spec of SPECS) {
    for (const s of spec.subtrees) subtreeOwner.set(s, spec.key);
    for (const name of spec.registry) leafOwner.set(`toolbox.registry.${name}`, spec.key);
    for (const name of spec.agent) leafOwner.set(`agent.${name}`, spec.key);
  }
  // 校验：每个搬迁路径都必须真实存在（漏一个就报错，绝不静默）
  for (const [dot, owner] of [...subtreeOwner, ...leafOwner]) {
    if (getDeep(dict, dot.split(".")) === undefined) throw new Error(`${locale}: ${owner} 的搬迁路径不存在 → ${dot}`);
  }
  const fragments = Object.fromEntries(SPECS.map((s) => [s.key, {}]));
  const rest = partition(dict, "", subtreeOwner, leafOwner, fragments);
  // 写回字典（纯删除：其余键的顺序与值不变）
  fs.writeFileSync(dictPath, JSON.stringify(rest, null, 2) + "\n");
  // 写片段
  let total = 0;
  const counts = {};
  for (const spec of SPECS) {
    const frag = fragments[spec.key];
    const outPath = path.join(ROOT, "src/tools", spec.key, `i18n.${locale}.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(frag, null, 2) + "\n");
    const n = countLeaves(frag);
    counts[spec.key] = n;
    total += n;
  }
  return { counts, total };
}

/** 叶子键计数：与 src/i18n/index.js 的 flatKeys 同语义（数组按索引展开）。 */
function countLeaves(v) {
  if (v && typeof v === "object") return Object.values(v).reduce((n, x) => n + countLeaves(x), 0);
  return 1;
}

function main() {
  const report = {};
  for (const locale of LOCALES) {
    report[locale] = migrate(locale);
    console.log(`\n[${locale}] 共搬出 ${report[locale].total} 个叶子键`);
    for (const spec of SPECS) console.log(`  ${spec.key.padEnd(12)} ${report[locale].counts[spec.key]}`);
  }
}

main();
