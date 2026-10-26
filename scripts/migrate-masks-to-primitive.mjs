#!/usr/bin/env node
// 把 13 处各自实现的遮罩改成"复用 primitives.css 的底座 + 只保留真正的差异"。
//
// ## 为什么这样做而不是把类名统一成 .tc-mask
// 本仓 e2e 用 `data-role` 选元素，不用遮罩类名（已实测：`grep -rn mask e2e/` 零命中），
// 所以类名本身可以留着当语义钩子（`.ax-mask` 表达"这是识图弹窗的遮罩"），
// 只要**底座不再各写一份**。这是"同名不同义"的反面：同类不同名，但共享一条定义。
// 做法与 TaskView 已有的写法一致：`class="modal-mask hist-mask"` + scoped 里只留差异。
//
// ## 顺带补的一处规范缺口
// 三处图片预览用 rgba(10,12,16,.82)——比普通遮罩深得多的"媒体预览底"，
// 上一轮的守卫关键词表（mask/overlay/veil/backdrop/shade）**没覆盖 preview**，
// 所以它漏检了。现在：
//   · 新增令牌 --overlay-strong（浅色就是原来那档值，深色改成真正的黑）
//   · 守卫判据从"选择器含 mask 等词"改成"选择器含 mask/overlay/veil/backdrop/shade/
//     preview/lightbox/sheet/dim 等词，其 background 必须是 var(--overlay*)"
//
// ## 已知的一处观感变化
// 图片预览的内边距从 32px 收敛到底座的 20px（padding 是底座的一部分，
// 留着 32px 就等于第 14 份自写遮罩）。预览图因此会大 24px 见方。
import fs from "node:fs";
import path from "node:path";

const CRLF_SAFE = (f, pairs) => {
  const abs = path.resolve(f);
  const original = fs.readFileSync(abs, "utf8");
  const crlf = original.includes("\r\n");
  let text = crlf ? original.replace(/\r\n/g, "\n") : original;
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${f} 未命中：${from.slice(0, 60)}`);
    text = text.split(from).join(to);
  }
  const hadTrailing = /\n$/.test(original);
  const body = hadTrailing ? text : text.replace(/\n+$/, "");
  fs.writeFileSync(abs, crlf ? body.replace(/\n/g, "\r\n") : body, "utf8");
  const after = fs.readFileSync(abs, "utf8");
  if (after.includes("\r\n") !== crlf) throw new Error(`行尾被改写：${f}`);
  console.log(`${f}: ${pairs.length} 处`);
};

let touched = 0;
const run = (f, pairs) => { CRLF_SAFE(f, pairs); touched += pairs.length; };

// ── 1. 令牌：媒体预览专用的遮罩强度 ──────────────────────────
run("src/styles/tokens.css", [
  [
    "  --overlay: rgba(17, 24, 39, 0.5);  /* 统一遮罩色：旧代码有 4 种不同写法 */",
    `  --overlay: rgba(17, 24, 39, 0.5);  /* 统一遮罩色：旧代码有 4 种不同写法 */
  /* 媒体预览底：看图时要把周围全部压暗，让画面浮起来，比普通弹窗的遮罩深一档。
     这一档此前是三个视图各自写死的 rgba(10,12,16,.82)——**不随主题变**，
     深色下反而比 --overlay 更深，浅色下又比它深很多，等于同一件事三种强度。 */
  --overlay-strong: rgba(10, 12, 16, 0.82);`,
  ],
  [
    "    --overlay: rgba(0, 0, 0, 0.62);\n\n    --code-bg: #161a21;",
    "    --overlay: rgba(0, 0, 0, 0.62);\n    --overlay-strong: rgba(0, 0, 0, 0.86);\n\n    --code-bg: #161a21;",
  ],
  [
    "  --overlay: rgba(0, 0, 0, 0.62);\n  --code-bg: #161a21;",
    "  --overlay: rgba(0, 0, 0, 0.62);\n  --overlay-strong: rgba(0, 0, 0, 0.86);\n  --code-bg: #161a21;",
  ],
]);

// ── 2. 底座逐条删掉，模板改为"底座类名 + 语义类名" ────────────
// 完全等价的四处：一条 scoped 声明都不剩
run("src/tools/prompt/PromptWorkflowDialog.vue", [
  [`.wf-mask {\n  position: fixed;\n  inset: 0;\n  background: var(--overlay);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: var(--z-overlay);\n}\n`, ""],
  [`class="wf-mask"`, `class="modal-mask wf-mask"`],
]);
run("src/tools/prompt/View.vue", [
  [`.mask {\n  position: fixed;\n  inset: 0;\n  background: var(--overlay);\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  z-index: var(--z-overlay);\n}\n`, ""],
  [`class="mask" data-role="lib-editor"`, `class="modal-mask mask" data-role="lib-editor"`],
  [`class="mask" data-role="imp-panel"`, `class="modal-mask mask" data-role="imp-panel"`],
]);
run("src/tools/chat/View.vue", [
  [`.mask {\n  position: fixed;\n  inset: 0;\n  z-index: var(--z-overlay);\n  display: grid;\n  place-items: center;\n  background: var(--overlay);\n}\n`, ""],
  [`class="mask" @click.self="presetManage = false"`, `class="modal-mask mask" @click.self="presetManage = false"`],
]);
run("src/tools/request/View.vue", [
  [`.save-mask, .curl-mask { position: fixed; inset: 0; z-index: var(--z-overlay); display: flex; align-items: center; justify-content: center; background: var(--overlay); }`, `/* 底座（定位/层叠/居中/遮罩色）走全局 .modal-mask，这里只留语义类名当钩子 */`],
  [`class="save-mask" @click.self="saveOpen = false"`, `class="modal-mask save-mask" @click.self="saveOpen = false"`],
  [`class="save-mask" @click.self="collOpen = false"`, `class="modal-mask save-mask" @click.self="collOpen = false"`],
  [`class="curl-mask" @click.self="curlOpen = false"`, `class="modal-mask curl-mask" @click.self="curlOpen = false"`],
]);
run("src/tools/request/ReqEnvDialog.vue", [
  [`.env-mask { position: fixed; inset: 0; z-index: var(--z-overlay); display: flex; align-items: center; justify-content: center; background: var(--overlay); }`, `/* 底座走全局 .modal-mask */`],
  [`<div class="env-mask" @click.self="emit('close')">`, `<div class="modal-mask env-mask" @click.self="emit('close')">`],
]);

// 有真实差异的：只留差异那一行
run("src/views/AiExtract.vue", [
  [`.ax-mask { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: center; justify-content: center; z-index: var(--z-front); padding: var(--sp-7); }`, `.ax-mask { z-index: var(--z-front); }`],
  [`<div v-if="open" class="ax-mask">`, `<div v-if="open" class="modal-mask ax-mask">`],
]);
run("src/views/GlobalSearch.vue", [
  [`.gs-mask { position: fixed; inset: 0; background: var(--overlay); display: flex; align-items: flex-start; justify-content: center; z-index: var(--z-front); padding: 80px var(--sp-7) var(--sp-7); }`, `.gs-mask {\n  align-items: flex-start;\n  padding: 80px var(--sp-7) var(--sp-7);\n  z-index: var(--z-front);\n}`],
  [`class="gs-mask" @click.self="close"`, `class="modal-mask gs-mask" @click.self="close"`],
]);
run("src/tools/disk/View.vue", [
  [`.dk-mask { position: fixed; inset: 0; z-index: var(--z-overlay); background: var(--overlay); backdrop-filter: blur(3px); display: grid; place-items: center; }`, `.dk-mask { backdrop-filter: blur(3px); }`],
  [`class="dk-mask" data-role="migrate-dialog"`, `class="modal-mask dk-mask" data-role="migrate-dialog"`],
  [`class="dk-mask" data-role="records-dialog"`, `class="modal-mask dk-mask" data-role="records-dialog"`],
]);

// 图片预览三处：换成 --overlay-strong，其余交给底座
for (const f of ["src/views/IterationView.vue", "src/views/ProblemView.vue", "src/views/SnippetView.vue"]) {
  run(f, [
    [`.img-preview { position: fixed; inset: 0; z-index: var(--z-front); background: rgba(10, 12, 16, 0.82); display: grid; place-items: center; cursor: zoom-out; padding: 32px; }`, `.img-preview {\n  z-index: var(--z-front);\n  background: var(--overlay-strong);\n  cursor: zoom-out;\n}`],
    [`class="img-preview" @click=`, `class="modal-mask img-preview" @click=`],
  ]);
}

console.log(`\n共改写 ${touched} 处。`);
