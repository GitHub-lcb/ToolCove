#!/usr/bin/env node
// 把守卫 `handRolledComponents` 名单里那批**真正的空态**接回全局 .empty。
//
// 只动语义确定的那些：「这里还没有内容」。名单里剩下的十几条刻意不动，因为它们不是同一个东西——
// `.file-drop` / `.style-bar` 是虚线拖放区、`.noai` 是提示条、`.tl-item` 是列表行、
// `.go-next` 是带主色描边的 CTA、`.mock-run` 用了渐变底。
// 把它们一律抹成原语会**改变观感**，而这一轮的判据是「等值收敛」：
// 只删掉与底座逐字相同的属性，其余作为真差异留在 scoped 里。
//
// 每条改动的等价性核对：底座给的是 display:flex / flex-direction:column /
// align-items:center / justify-content:center / text-align:center（这五条正是被复制的部分），
// 而 gap、padding、min-height、flex、各自的 color/font-size 全部原样保留。
import fs from "node:fs";
import path from "node:path";

function rewrite(f, pairs) {
  const abs = path.resolve(f);
  const original = fs.readFileSync(abs, "utf8");
  const crlf = original.includes("\r\n");
  let text = crlf ? original.replace(/\r\n/g, "\n") : original;
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${f} 未命中：${from.slice(0, 70)}`);
    text = text.split(from).join(to);
  }
  const body = /\n$/.test(original) ? text : text.replace(/\n+$/, "");
  fs.writeFileSync(abs, crlf ? body.replace(/\n/g, "\r\n") : body, "utf8");
  console.log(`${f}: ${pairs.length} 处`);
}

const SKELETON = [
  "  display: flex;",
  "  flex-direction: column;",
  "  align-items: center;",
  "  justify-content: center;",
  "",
].join("\n");

// ── convert：单行规则
rewrite("src/tools/convert/View.vue", [
  [".error-state { flex: 1; min-height: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-7); text-align: center; }",
    "/* 居中骨架走全局 .empty；这里只留占满剩余高度与更紧的 gap/padding */\n.error-state { flex: 1; min-height: 0; gap: var(--sp-2); padding: var(--sp-7); }"],
  ['class="error-state"', 'class="empty error-state"'],
]);

// ── diff：三种结果态共用同一个类
rewrite("src/tools/diff/DiffTool.vue", [
  [".result-state { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-7); text-align: center; }",
    "/* 居中骨架走全局 .empty */\n.result-state { flex: 1; gap: var(--sp-2); padding: var(--sp-7); }"],
  ['class="result-state', 'class="empty result-state'],
]);

// ── downloader / photo：逐字相同的两块空白态（原本就是互相抄的一份）
for (const f of ["src/tools/downloader/View.vue", "src/tools/photo/View.vue"]) {
  rewrite(f, [
    [`.blank-state {\n  flex: 1;\n  min-height: 130px;\n${SKELETON}  gap: var(--sp-1);\n  color: var(--muted);\n  font-size: var(--fs-sm);\n  text-align: center;\n  padding: var(--sp-4);`,
      `.blank-state {\n  flex: 1;\n  min-height: 130px;\n  gap: var(--sp-1);\n  font-size: var(--fs-sm);\n  padding: var(--sp-4);`],
    ['class="blank-state"', 'class="empty blank-state"'],
  ]);
}

// ── AgentView 空画布
rewrite("src/views/AgentView.vue", [
  [".canvas-empty { flex: 1; min-height: 320px; margin: 0; padding: var(--sp-7) 0 var(--sp-6); display: flex; flex-direction: column; gap: var(--sp-2); align-items: center; justify-content: center; text-align: center; }",
    "/* 居中骨架与文字层级走全局 .empty */\n.canvas-empty { flex: 1; min-height: 320px; margin: 0; padding: var(--sp-7) 0 var(--sp-6); gap: var(--sp-2); }"],
  ['class="canvas-empty"', 'class="empty canvas-empty"'],
]);

// ── prompt 桌面独占提示
rewrite("src/tools/prompt/View.vue", [
  [`.desktop-error {\n  flex: 1;\n${SKELETON}  gap: var(--sp-4);\n  color: var(--text-weak);\n  padding: 40px;\n  text-align: center;`,
    `.desktop-error {\n  flex: 1;\n  gap: var(--sp-4);\n  color: var(--text-weak);\n  padding: 40px;`],
  ['class="desktop-error"', 'class="empty desktop-error"'],
]);

// ── chat 的新建按钮：本来就是主按钮的形状
rewrite("src/tools/chat/View.vue", [
  [`.new-btn {\n  display: inline-flex;\n  align-items: center;\n  justify-content: center;\n  gap: var(--sp-1);\n  padding: 7px 0;\n  font-weight: 600;\n  color: var(--text-invert);\n  background: var(--primary);\n  border: none;\n  border-radius: var(--r-sm);\n  cursor: pointer;\n  transition: background 0.15s;\n}`,
    "/* 骨架与主色底走全局 .btn-primary；这里只留整条宽度、无左右内边距这一个差异 */\n.new-btn {\n  padding: 7px 0;\n  gap: var(--sp-1);\n}"],
  ['class="new-btn"', 'class="btn-primary new-btn"'],
]);

console.log("\n完成。守卫的 handRolledComponents 应从 21 降到 14；剩下的 14 条是刻意保留的差异。");
