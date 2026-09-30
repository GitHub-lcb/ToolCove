#!/usr/bin/env node
// 从 GitHub 仓库批量拉题，生成一份可导入的题库文件。
//
// 为什么是**构建脚本**而不是运行时抓取：这个应用的核心承诺之一是「完全离线」。
// 如果题库靠运行时去 GitHub 拉，离线就废了、还受 rate limit 与网络影响。
// 所以拉取只发生在你手动执行 `npm run bank:fetch` 的时候，产物落到磁盘上，之后照常离线用。
//
// 用法：
//   node scripts/build-interview-bank.mjs                     # 用内置的推荐仓库清单
//   node scripts/build-interview-bank.mjs --config my.json     # 用自定义清单
//   node scripts/build-interview-bank.mjs --out tmp/bank.json  # 换输出位置
//
// 配置形状（my.json）：
//   {
//     "sources": [
//       { "repo": "Snailclimb/JavaGuide", "path": "docs/java/basis",
//         "category": "backend", "topic": "Java 基础", "difficulty": 2 },
//       ...
//     ]
//   }
//   repo 必填；path 是仓库内的目录（递归）或单个 .md 文件；category 必填且必须是四个方向之一。
//
// ── 版权红线（务必读一遍）────────────────────────────────────────────
// 这个脚本会把**别人仓库的正文**抓下来。哪些能用取决于那些仓库的许可证：
//   · 有明确开源许可证（MIT / Apache-2.0 / CC-BY-SA-4.0 …）→ 按许可证条款使用，**必须保留署名**
//     （生成的题库里每题都带 `sources`，导入后界面上会显示出处，这是署名，不要删）；
//   · **没有 LICENSE 文件**的仓库（不少高 star 的中文仓库都没有）→ 默认保留所有权利。
//     自己私下刷题是一回事，把正文再分发（打包进你发布的产物、传到公开仓库）是另一回事。
//     这个脚本默认把产物写到 tmp/（已 gitignore），就是为了不让你顺手把它提交上去。
// 所以：产物要不要入库、要不要随应用分发，请先确认对应仓库的许可证。
//
// ── 现实预期（也别跳过）──────────────────────────────────────────────
// 实测结论：这些高 star 仓库**绝大多数不是题库**，而是成篇的讲解文章。
// 脚本按 Markdown 标题把文章切块，再筛出「像问题」的标题，所以：
//   · 收进来的量远小于文章数。实测 hello-algo 的「排序」一章 13 个文件只收出个位数；
//   · 想要量就得开 --all-headings，但那时切出来的是章节而不是题目，质量参差；
//   · 更合适的用法有两种，取决于你想要什么：
//       1) 想要**真题库** → 找本身就是 Q&A 结构的仓库（每篇一个问题），把它配进清单；
//       2) 想要**知识点拆解** → 把这份产物当「按标题切片的学习材料」，配合 --all-headings 用。
// 无论哪种，抓完请用 --sample 抽查几条，别指望开箱即用。

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const CATEGORIES = new Set(["backend", "algo", "system", "frontend"]);

/** 内置的推荐清单：都验证过 star 数与目录真实存在（见 README / 题库出处说明）。 */
const DEFAULT_SOURCES = [
  { repo: "Snailclimb/JavaGuide", path: "docs/java/basis", category: "backend", topic: "Java 基础" },
  { repo: "Snailclimb/JavaGuide", path: "docs/java/collection", category: "backend", topic: "集合" },
  { repo: "Snailclimb/JavaGuide", path: "docs/java/concurrent", category: "backend", topic: "并发" },
  { repo: "Snailclimb/JavaGuide", path: "docs/java/jvm", category: "backend", topic: "JVM" },
  { repo: "Snailclimb/JavaGuide", path: "docs/database/mysql", category: "backend", topic: "MySQL" },
  { repo: "Snailclimb/JavaGuide", path: "docs/database/redis", category: "backend", topic: "Redis" },
  { repo: "Snailclimb/JavaGuide", path: "docs/system-design/framework/spring", category: "backend", topic: "Spring" },
  { repo: "Snailclimb/JavaGuide", path: "docs/distributed-system", category: "backend", topic: "分布式" },
  { repo: "doocs/advanced-java", path: "docs/high-concurrency", category: "system", topic: "高并发" },
  { repo: "doocs/advanced-java", path: "docs/distributed-system", category: "system", topic: "分布式" },
  { repo: "krahets/hello-algo", path: "docs/chapter_sorting", category: "algo", topic: "排序" },
  { repo: "krahets/hello-algo", path: "docs/chapter_tree", category: "algo", topic: "二叉树" },
  { repo: "krahets/hello-algo", path: "docs/chapter_dynamic_programming", category: "algo", topic: "动态规划" },
  { repo: "krahets/hello-algo", path: "docs/chapter_graph", category: "algo", topic: "图论" },
  { repo: "febobo/web-interview", path: "docs", category: "frontend", topic: "前端" },
];

function parseArgs(argv) {
  const args = { config: "", out: "tmp/interview-bank.fetched.json", sample: 0, requireQuestion: true, minAnswer: 80, cache: "tmp/.bank-cache" };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--config") args.config = argv[++i];
    else if (flag === "--out") args.out = argv[++i];
    else if (flag === "--sample") args.sample = Number(argv[++i]) || 0;
    else if (flag === "--min-answer") args.minAnswer = Number(argv[++i]) || 80;
    else if (flag === "--cache") args.cache = argv[++i];
    else if (flag === "--all-headings") args.requireQuestion = false;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new Error(`未知参数：${flag}（--help 看用法）`);
  }
  return args;
}

const HELP = `
从 GitHub 仓库批量拉题，生成可导入的题库文件。

  node scripts/build-interview-bank.mjs [选项]

  --config <file>      自定义清单 JSON（默认用脚本内置的推荐仓库清单）
  --out <file>         输出文件（默认 tmp/interview-bank.fetched.json，tmp/ 已 gitignore）
  --sample <n>         额外打印 n 条样本，供人工抽查质量
  --min-answer <n>     正文短于 n 字的块丢弃（默认 80）
  --all-headings       不要求标题像问题（默认只收像问题的标题；开了会收进大量章节标题）
  --cache <dir>        HTTP 缓存目录（默认 tmp/.bank-cache，避免反复抓同一批文件）
  --help               显示这段说明

环境变量 GITHUB_TOKEN 可选：设了就用它请求，rate limit 从 60/h 提到 5000/h。
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带磁盘缓存的 GET。GitHub 的 rate limit 很紧，重复跑脚本不该重复抓。 */
async function cachedFetch(url, { cache, accept = "application/vnd.github+json", binary = false } = {}) {
  const key = url.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-180);
  const file = resolve(cache, key);
  try {
    const hit = await readFile(file);
    return binary ? hit : hit.toString("utf8");
  } catch {
    // 未命中缓存，去抓
  }
  const headers = { "User-Agent": "ToolCove-bank-fetcher", Accept: accept };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { headers });
    if (response.status === 403 || response.status === 429) {
      const wait = 5000 * (attempt + 1);
      process.stderr.write(`  限流（${response.status}），${wait / 1000}s 后重试…\n`);
      await sleep(wait);
      continue;
    }
    if (!response.ok) throw new Error(`${response.status} ${response.statusText} — ${url}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(cache, { recursive: true });
    await writeFile(file, buffer);
    return binary ? buffer : buffer.toString("utf8");
  }
  throw new Error(`重试三次仍被限流：${url}（设 GITHUB_TOKEN 可提高额度）`);
}

/** 列出一个目录下的所有 .md（递归）。返回仓库内相对路径。 */
async function listMarkdown(repo, path, cache) {
  const url = `${API}/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const entries = JSON.parse(await cachedFetch(url, { cache }));
  if (!Array.isArray(entries)) throw new Error(`${repo}/${path} 不是一个目录`);
  const out = [];
  for (const entry of entries) {
    if (entry.type === "dir") out.push(...(await listMarkdown(repo, entry.path, cache)));
    else if (entry.type === "file" && /\.mdx?$/i.test(entry.name)) out.push(entry.path);
  }
  return out;
}

/**
 * 标题像不像一个面试问题。
 *
 * 默认口径刻意**收得很紧**，原因是实测出来的：这些高 star 仓库绝大多数是**成篇的讲解文章**，
 * 不是题库。按标题切块时，切出来的第一版样本长这样——「简单实现」「完整实现」「一、概述」，
 * 全是章节标题而不是问题（bucket_sort.md 里「如何实现平均分配」才是真问题）。
 * 所以默认要求「标题以问号结尾」或「以疑问词开头」，并用黑名单挡掉常见章节名。
 * 想全收（把文章按章节拆成学习单元）用 --all-headings，但要接受质量参差。
 */
const SECTION_WORDS = /^(实现|完整实现|简单实现|代码实现|概述|简介|介绍|总结|小结|示例|例子|步骤|流程|分析|原理|机制|结构|定义|分类|应用|优缺点|复杂度|练习|习题|参考|参考资料|延伸阅读|写在最后|前言|背景|目标|要求|思路|解法|题解|注意|补充|优化|扩展|对比|选型|一|二|三|四|五|六|七|八|九|十)[、,，.：:\s]/;
const QUESTION_START = /^(什么|什么是|为何|为什么|如何|怎么|怎样|哪些|哪个|哪种|是否|能否|有没有|介绍下|谈谈|说说|讲讲|聊聊|简述|对比一下)/;

function looksLikeQuestion(title) {
  const text = title.replace(/[*`#]/g, "").trim();
  if (!text || text.length < 4) return false;
  if (SECTION_WORDS.test(text)) return false;
  if (/[?？]\s*$/.test(text)) return true;
  if (QUESTION_START.test(text)) return true;
  // 没有问号、也不以疑问词开头时，只有出现明确的「提问句式」才收
  return /(是什么|有什么区别|有什么不同|有哪些|为什么|怎么办|怎么选|怎么用|如何|能否|是否)/.test(text);
}

/** 按 Markdown 标题切块。只切 ## 及更深，一级标题当文件标题。 */
function splitBlocks(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const heading = /^(#{2,6})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      if (current) blocks.push(current);
      current = { title: heading[2].trim(), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) blocks.push(current);
  return blocks;
}

/** 从正文里摘出「要点」，没有就返回空数组（导入后界面会隐藏这一块）。 */
function extractPoints(body) {
  const bullets = body
    .split("\n")
    .filter((line) => /^\s*[-*]\s+\S/.test(line))
    .map((line) => line.replace(/^\s*[-*]\s+/, "").replace(/[*`]/g, "").trim())
    .filter((line) => line.length >= 4 && line.length <= 40);
  return bullets.slice(0, 3);
}

/** 标题 + 正文 → 一条题库记录；不合格返回 null。 */
function toQuestion(block, source, repoSlug, filePath, options) {
  const title = block.title.replace(/[*`]/g, "").trim();
  if (!title) return null;
  if (options.requireQuestion && !looksLikeQuestion(title)) return null;
  const body = block.body.join("\n").trim();
  if (body.length < options.minAnswer) return null;
  // 目录/索引页的典型形状：整篇都是链接
  const linkLines = body.split("\n").filter((l) => /^\s*[-*]?\s*\[.+\]\(.+\)\s*$/.test(l)).length;
  if (linkLines > 0 && linkLines / body.split("\n").length > 0.6) return null;
  return {
    id: `gh-${repoSlug}-${filePath}-${title}`
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80),
    category: source.category,
    topic: source.topic || "导入",
    difficulty: source.difficulty ?? 2,
    tags: [repoSlug, source.topic].filter(Boolean),
    question: title,
    answer: body,
    points: extractPoints(body),
    follow: "",
    // repo 用 owner/name 原样存：这是**出处署名**，导入后界面上会显示，不要删
    sources: [{ repo: `${repoSlug}`, path: filePath }],
    custom: true,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  let sources = DEFAULT_SOURCES;
  if (args.config) {
    const raw = JSON.parse(await readFile(args.config, "utf8"));
    if (!Array.isArray(raw.sources) || !raw.sources.length) throw new Error(`${args.config} 里没有 sources 数组`);
    sources = raw.sources;
  }
  for (const source of sources) {
    if (!source.repo || !source.path) throw new Error(`清单项缺 repo 或 path：${JSON.stringify(source)}`);
    if (!CATEGORIES.has(source.category)) throw new Error(`清单项 category 必须是 backend/algo/system/frontend 之一：${JSON.stringify(source)}`);
  }

  process.stdout.write(`从 ${sources.length} 个来源拉取（缓存：${args.cache}）\n`);
  const questions = [];
  const seen = new Set();
  const report = [];

  for (const source of sources) {
    const repoSlug = source.repo.replace("/", "-");
    let files;
    try {
      files = source.path.endsWith(".md") ? [source.path] : await listMarkdown(source.repo, source.path, args.cache);
    } catch (error) {
      report.push({ source: `${source.repo}/${source.path}`, files: 0, kept: 0, dropped: 0, error: String(error.message) });
      process.stderr.write(`  ✗ ${source.repo}/${source.path} — ${error.message}\n`);
      continue;
    }
    let kept = 0;
    let dropped = 0;
    for (const filePath of files) {
      // README / index / exercises 这类不是题，跳过（它们的标题全是章节导航）
      if (/(^|\/)(README|readme|index|exercises|SUMMARY)\.mdx?$/.test(filePath)) continue;
      const rawUrl = `${RAW}/${source.repo}/HEAD/${filePath.split("/").map(encodeURIComponent).join("/")}`;
      let markdown;
      try {
        markdown = await cachedFetch(rawUrl, { cache: args.cache, accept: "text/plain" });
      } catch (error) {
        process.stderr.write(`  ✗ ${filePath} — ${error.message}\n`);
        continue;
      }
      for (const block of splitBlocks(markdown)) {
        const question = toQuestion(block, source, repoSlug, filePath, args);
        if (!question) {
          dropped += 1;
          continue;
        }
        if (seen.has(question.id)) {
          dropped += 1;
          continue;
        }
        seen.add(question.id);
        questions.push(question);
        kept += 1;
      }
    }
    report.push({ source: `${source.repo}/${source.path}`, files: files.length, kept, dropped, error: "" });
    process.stdout.write(`  ✓ ${source.repo}/${source.path} — ${files.length} 个文件，收 ${kept} 条，丢 ${dropped} 条\n`);
  }

  const payload = {
    // 顶层带元信息：这份产物是脚本生成的，重新生成会覆盖，别手工改
    generatedBy: "scripts/build-interview-bank.mjs",
    generatedAt: new Date().toISOString(),
    note: "由构建脚本从 GitHub 抓取生成。使用前请确认各来源仓库的许可证与署名要求（见脚本头部说明）。",
    questions,
  };
  await mkdir(dirname(resolve(args.out)), { recursive: true });
  await writeFile(resolve(args.out), `${JSON.stringify(payload, null, 2)}\n`);

  const byCategory = {};
  for (const question of questions) byCategory[question.category] = (byCategory[question.category] ?? 0) + 1;
  process.stdout.write(`\n合计 ${questions.length} 条 → ${args.out}\n`);
  process.stdout.write(`  按方向：${JSON.stringify(byCategory)}\n`);
  const failed = report.filter((r) => r.error);
  if (failed.length) {
    process.stdout.write(`  ${failed.length} 个来源失败：\n`);
    for (const item of failed) process.stdout.write(`    ✗ ${item.source} — ${item.error}\n`);
  }
  const droppedTotal = report.reduce((sum, r) => sum + r.dropped, 0);
  if (droppedTotal) {
    process.stdout.write(`  丢弃 ${droppedTotal} 个块（标题不像问题 / 正文太短 / 目录页 / 重复）——想全收用 --all-headings\n`);
  }

  if (args.sample > 0) {
    process.stdout.write(`\n样本（人工抽查用）：\n`);
    for (const question of questions.slice(0, args.sample)) {
      process.stdout.write(`\n  [${question.category}/${question.topic}] ${question.question}\n`);
      process.stdout.write(`  ${question.answer.slice(0, 160).replace(/\n/g, " ")}…\n`);
      process.stdout.write(`  出处：${question.sources[0].repo} · ${question.sources[0].path}\n`);
    }
  }

  process.stdout.write(`\n导入方式：面试刷题 →「导入与设置」→ 选默认方向 → 粘贴这个 JSON 文件的内容 → 解析并导入。\n`);
  process.stdout.write(`注意：产物落在 ${args.out}（tmp/ 已 gitignore）。入库或随应用分发前，请先确认来源仓库的许可证。\n`);
}

main().catch((error) => {
  process.stderr.write(`\n失败：${error.message}\n`);
  process.exitCode = 1;
});
