#!/usr/bin/env node
// 给全部对话框挂上 v-dialog（语义 + 焦点进出）。按行定位，改完打印每一处，便于逐条核对。
import fs from "node:fs";
import path from "node:path";

// 桌面端：遮罩类在下一行找盒子；手机端的 .m-modal 本身就是遮罩+居中层，直接挂它
const MASK = /class="[^"]*(modal-mask|tc-mask|m-modal)/;

function maskSites(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || ["node_modules", "dist"].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) maskSites(p, out);
    else if (e.name.endsWith(".vue")) {
      const lines = fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n").split("\n");
      lines.forEach((line, i) => { if (MASK.test(line)) out.push({ file: p, line: i + 1 }); });
    }
  }
  return out;
}

const targets = [];
for (const site of [...maskSites("src"), ...maskSites("mobile")]) {
  const raw = fs.readFileSync(site.file, "utf8");
  const crlf = raw.includes("\r\n");
  const lines = (crlf ? raw.replace(/\r\n/g, "\n") : raw).split("\n");

  // 遮罩自己已经带 role 的（rail 的二次确认层）就跳过
  let idx = site.line - 1;
  const isBox = (l) => /^\s*<div\s[^>]*class="/.test(l) && !MASK.test(l);
  // 往后找 3 行内的盒子；找不到（如纯图片预览）就把指令挂在遮罩上
  for (let k = 1; k <= 3; k++) {
    if (lines[idx + k] && isBox(lines[idx + k])) { idx = idx + k; break; }
  }
  const line = lines[idx];
  if (!line || /v-dialog|role="dialog"/.test(line)) {
    console.log(`跳过 ${site.file}:${idx + 1}（已有语义或结构不符）`);
    continue;
  }
  // 插到 class 属性后面，读起来像"这个元素是个对话框"
  const next = line.replace(/(class="[^"]*")/, `$1 v-dialog`);
  if (next === line) { console.log(`未能插入 ${site.file}:${idx + 1}`); continue; }
  lines[idx] = next;
  fs.writeFileSync(site.file, (crlf ? lines.join("\n").replace(/\n/g, "\r\n") : lines.join("\n")), "utf8");
  targets.push(`${site.file}:${idx + 1}  ${lines[idx].trim().slice(0, 96)}`);
}

console.log(`\n共挂 v-dialog ${targets.length} 处：`);
targets.forEach((t) => console.log("  " + t));
