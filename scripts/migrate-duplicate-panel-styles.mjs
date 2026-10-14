#!/usr/bin/env node
// 迁移：把各工具视图里与 globals.css 重复的样式底座删掉。
//
// 背景：审计实测 `.panel-head` 那一条规则在 **10 个工具文件里逐字相同**，
// `.panel` 在 8 个文件里同值。这轮把它们收敛到 styles/globals.css 的兼容别名，
// 各文件只保留自己**真正不同**的部分（如 `.panel-head b` 的字号、`.panel-head span` 的右对齐）。
//
// 为什么脚本化：10 个文件 × 2 行，手改容易漏；而漏掉不会有任何报错，只是又多一份重复。
//
// ⚠️ 行尾必须逐文件保留：本仓库多数文件是 LF，但 db 工具的视图是 CRLF。
//    无脑 readFileSync+writeFileSync 会把 CRLF 变成 LF，产生整文件假 diff。
// 注：本脚本已执行过；路径按「工具包模型」更新为各包内的实际位置（历史记录见 git）。
import fs from "node:fs";
import path from "node:path";

const TARGETS = [
  "src/tools/file/View.vue",
  "src/tools/generator/View.vue",
  "src/tools/crypto/View.vue",
  "src/tools/image/View.vue",
  "src/tools/network/View.vue",
  "src/tools/pdf/View.vue",
  "src/tools/label/View.vue",
  "src/tools/convert/View.vue",
  "src/tools/diff/DiffTool.vue",
  "src/tools/diff/View.vue",
  "src/tools/image/ImagePreview.vue",
];

// 与 globals.css 完全相同的底座（逐字比对，含前后空格）
const DUP_PANEL = ".panel { min-width: 0; min-height: 0; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }";
const DUP_HEAD =
  ".panel-head { flex-shrink: 0; min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }";
// 变体（NetworkTool 缺 flex-shrink，ImagePreview 的 panel-head 也是同一形状）
const DUP_HEAD_VARIANTS = [
  DUP_HEAD,
  ".panel-head { min-height: 38px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4); border-bottom: 1px solid var(--border); background: var(--card-soft); }",
];

let touched = 0;
for (const file of TARGETS) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    console.log("skip (missing)", file);
    continue;
  }
  const original = fs.readFileSync(abs, "utf8");
  const crlf = original.includes("\r\n");
  // 按原始行尾切分，保证写回时行尾不变
  const eol = crlf ? "\r\n" : "\n";
  let lines = original.split(/\r?\n/);

  const before = lines.length;
  lines = lines.filter((line) => {
    const t = line.trim();
    if (t === DUP_PANEL) return false;
    return !DUP_HEAD_VARIANTS.includes(t);
  });

  if (lines.length !== before) {
    // 用与原文一致的 eol 拼回。末尾换行要**原样保持**：
    // 若原文以换行结尾就补一个，否则补会把 diff 尾部多出一行 "+"。
    const hadTrailing = /\r?\n$/.test(original);
    fs.writeFileSync(abs, lines.join(eol) + (hadTrailing ? eol : ""), "utf8");
    console.log(
      `${file}: 删除 ${before - lines.length} 行重复底座（行尾 ${crlf ? "CRLF" : "LF"} 保持不变）`,
    );
    touched++;
  } else {
    console.log(`${file}: 无重复底座`);
  }
}
console.log(`\n共改动 ${touched} 个文件。`);