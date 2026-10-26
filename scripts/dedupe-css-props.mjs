// 把"同一个类把同一个属性写了两遍"合并成一处——**保留最后一份，从前面几份里删掉被重定义的属性**。
//
// 为什么这样等价：同一个单类选择器写两遍时，后一份对它包含的属性就是赢家；
// 把前一份里那些"反正会被盖掉"的声明删掉，赢家不变，位置也不变，
// 于是夹在中间的同特异度规则（如 `.m-iteration .m-bar`）依然按原顺序生效。
// 所以这是一次**零观感变化**的机械清理，不是重新设计。
//
// 用法：
//   node scripts/dedupe-css-props.mjs            # 预览（打印每一处准备删的声明）
//   node scripts/dedupe-css-props.mjs --write    # 落盘
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const FILES = ["src/styles/primitives.css", "src/styles/globals.css", "mobile/app/styles/shell.css"];
const write = process.argv.includes("--write");

let total = 0;
for (const rel of FILES) {
  const p = path.join(ROOT, rel);
  const raw = fs.readFileSync(p, "utf8");
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const lines = raw.split(/\r?\n/);

  // 找单类块的起始行与结束行（只认顶格、选择器就是一个类）
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^\.([a-zA-Z][\w-]*)\s*\{\s*$/.exec(lines[i]);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^\}/.test(lines[j])) j += 1;
    blocks.push({ cls: m[1], from: i + 1, to: j, body: lines.slice(i + 1, j) });
    i = j;
  }

  // 每个 (类, 属性) 的最后一块位置
  const lastAt = new Map();
  for (const b of blocks) for (const ln of b.body) {
    const d = /^\s*([a-z-]+)\s*:/.exec(ln);
    if (d) lastAt.set(`${b.cls}.${d[1]}`, b.from);
  }

  const drop = [];
  const risky = [];
  for (const b of blocks) {
    for (let k = 0; k < b.body.length; k += 1) {
      const d = /^\s*([a-z-]+)\s*:/.exec(b.body[k]);
      if (!d) continue;
      const key = `${b.cls}.${d[1]}`;
      if (lastAt.get(key) === b.from) continue;
      const text = b.body[k].trim();
      // 只删"整行就是一条完整声明"的行。跨行写的值（多段 box-shadow / transition）
      // 删首行会把 CSS 改坏，宁可留着也不能机械删。
      if (!/;$/.test(text)) risky.push(`${key} @${b.from + k + 1}: ${text}`);
      else drop.push({ line: b.from + k, key, text });
    }
  }
  for (const r of risky) console.log(`   ⚠️ 跳过（值跨行，不能机械删）：${r}`);
  if (!drop.length) {
    console.log(`${rel}: 没有重复定义`);
    continue;
  }
  console.log(`${rel}: 要删 ${drop.length} 条被后面盖掉的声明`);
  for (const d of drop) console.log(`   第 ${d.line + 1} 行  ${d.text}   （${d.key} 由更晚的那一份赢）`);
  total += drop.length;

  if (write) {
    // 这里踩过一次真实的坑：`drop.line` 存的是**0-based 行号**，
    // 曾经又减了一次 1 去删，于是 12 条"该删的行"变成了"上一行"，
    // 把 `.m-badge {` 的选择器行都删掉了（CSS 结构当场断裂）。
    // 所以现在两道保险：删之前断言行号合法，删之后断言行数正好等于计划数。
    for (const d of drop) {
      const txt = lines[d.line] || "";
      if (!new RegExp(`^\\s*${d.key.split(".")[1]}\\s*:`).test(txt)) {
        console.error(`行号对不上，放弃写入：第 ${d.line + 1} 行是 ${JSON.stringify(txt)}，期望 ${d.key}`);
        process.exit(1);
      }
    }
    const kill = new Set(drop.map((d) => d.line));
    const before = lines.length;
    const kept = lines.filter((_, idx) => !kill.has(idx));
    const after = kept.join(eol);
    const opens = (after.match(/\{/g) || []).length;
    const closes = (after.match(/\}/g) || []).length;
    if (before - kept.length !== drop.length || opens !== closes) {
      console.error(`自检没过（删了 ${before - kept.length} / 计划 ${drop.length}；花括号 ${opens}/${closes}），放弃写入`);
      process.exit(1);
    }
    fs.writeFileSync(p, after, "utf8");
    console.log(`   → 已写回 ${rel}（-${drop.length} 行，花括号配平自检通过）`);
  }
}
console.log(write ? `\n共删除 ${total} 条重复声明。` : `\n共 ${total} 条待删（预览模式，没动文件）。加 --write 落盘。`);
