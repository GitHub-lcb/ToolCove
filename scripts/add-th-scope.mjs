#!/usr/bin/env node
// 给所有列表头补 scope="col"。
//
// 为什么值得单独做：实测全仓 27 个 `<th>`，**scope 出现 0 次**。
// 没有 scope，读屏走到单元格时只能说"第 3 列"，说不出"这一列是责任人"——
// 表格越宽越明显。这是纯机械修复：不新增文案、不改观感、不需要判断。
//
// 判据：<thead> 不能碰（`<th` 后面是字母就跳过）；已经写了 scope 的跳过
// （未来的行头 `<th scope="row">` 因此不会被改成列头）。
import fs from "node:fs";
import path from "node:path";

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith(".") || ["node_modules", "dist"].includes(e.name)) continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (p.endsWith(".vue")) out.push(p);
  }
  return out;
}

const RE = /<th(?![a-zA-Z-])(?![^>]*\bscope=)/g;
let total = 0;
for (const f of [...walk("src"), ...walk("mobile/app")]) {
  const original = fs.readFileSync(f, "utf8");
  const crlf = original.includes("\r\n");
  const t = crlf ? original.replace(/\r\n/g, "\n") : original;
  const n = (t.match(RE) || []).length;
  if (!n) continue;
  const next = t.replace(RE, '<th scope="col"');
  const body = /\n$/.test(original) ? next : next.replace(/\n+$/, "");
  fs.writeFileSync(f, crlf ? body.replace(/\n/g, "\r\n") : body, "utf8");
  const after = fs.readFileSync(f, "utf8");
  if (after.includes("\r\n") !== crlf) throw new Error(`行尾被改写：${f}`);
  total += n;
  console.log(`${f}: ${n} 处`);
}
console.log(`\n共补 scope="col" ${total} 处。`);
