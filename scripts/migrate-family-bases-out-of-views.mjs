#!/usr/bin/env node
// 消掉最后 5 个"又写了一遍组件底座骨架"的文件（守卫指标 familiesRestatedInViews）。
//
// 判据只认**结构骨架**（`.panel` 的外框三条、`.empty` 的居中三条、`.st-chip` 的胶囊三条），
// 覆盖个别属性（`.panel-head b { font-size }`、`.empty-ico { width: 40px }`）是规范认可的写法，不算违规。
// 所以这里的改法统一是：**底座属性从 scoped 里删掉，真差异留着**。
//
// 特别说一句 photo 工具的 `.st-chip`：它自带一套状态色，
// 但逐条比对后发现 `--ok-soft/--ok` 就是 `--done-soft/--done-deep`、
// `--primary-soft/--primary` 就是 `st-dev`、`--danger-soft/--danger-deep` 就是 `st-fail`——
// **同一套颜色写了第二遍**，只差没挂到共享的类名上。改成挂共享状态层后，
// 唯一的实际差别是"待上传/新照片"这枚中性胶囊的底从 `--ghost` 变成 `--well`（差一档灰度）。
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

// ── downloader：.panel 只留 flex 方向；.panel-head 与底座逐字相同 → 整条删掉
rewrite("src/tools/downloader/View.vue", [
  [`.panel {\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  border: 1px solid var(--card-border);\n  border-radius: var(--r-md);\n  background: var(--card);\n  overflow: hidden;\n}`,
    `/* 外框（描边/圆角/底色/裁切/min-width）走全局 .panel；这里只补纵向弹性布局 */\n.panel {\n  display: flex;\n  flex-direction: column;\n}`],
  [`.panel-head {\n  flex-shrink: 0;\n  min-height: 38px;\n  display: flex;\n  align-items: center;\n  gap: var(--sp-2);\n  padding: 0 var(--sp-4);\n  border-bottom: 1px solid var(--border);\n  background: var(--card-soft);\n}\n\n`,
    ""],
]);

// ── photo：同上两条 + 状态胶囊挂回共享状态层
rewrite("src/tools/photo/View.vue", [
  [`.panel {\n  min-width: 0;\n  display: flex;\n  flex-direction: column;\n  border: 1px solid var(--card-border);\n  border-radius: var(--r-md);\n  background: var(--card);\n  overflow: hidden;\n}`,
    `/* 外框走全局 .panel */\n.panel {\n  display: flex;\n  flex-direction: column;\n}`],
  [`.panel-head {\n  flex-shrink: 0;\n  min-height: 38px;\n  display: flex;\n  align-items: center;\n  gap: var(--sp-2);\n  padding: 0 var(--sp-4);\n  border-bottom: 1px solid var(--border);\n  background: var(--card-soft);\n}\n\n`,
    ""],
  [`.st-chip {
  flex-shrink: 0;
  padding: 1px var(--sp-2);
  border-radius: var(--r-pill);
  background: var(--ghost);
  color: var(--text-weak);
  font-size: var(--fs-xs);
}

.st-chip.ok {
  background: var(--ok-soft, var(--ghost));
  color: var(--ok);
}

.st-chip[data-state="uploading"] {
  background: var(--primary-soft);
  color: var(--primary);
}

.st-chip[data-state="done"] {
  background: var(--ok-soft, var(--ghost));
  color: var(--ok);
}

.st-chip[data-state="error"] {
  background: var(--danger-soft);
  color: var(--danger-deep);
}`,
    `/* 胶囊骨架与状态色都走共享的一层：.st-chip.sm + 状态类（见 primitives.css）。
   原先这里把同一套颜色又写了一遍（--ok-soft/--ok 就是 --done-soft/--done-deep、
   --primary-soft/--primary 就是 st-dev、--danger-soft/--danger-deep 就是 st-fail），
   连"小一档"的形态也早有 .st-chip.sm 在用。整段删掉后唯一的中性色差别：
   待上传/新照片这枚胶囊的底从 --ghost 变成 --well（差一档灰度），换来了全仓一致。 */`],
  // 模板：三处挂上 sm 与共享状态类（data-state 保留，e2e 靠它选元素）
  [`class="st-chip ok" data-role="archived-chip"`, `class="st-chip st-done sm" data-role="archived-chip"`],
  [`class="st-chip" data-role="fresh-chip"`, `class="st-chip tc-neutral sm" data-role="fresh-chip"`],
  [`class="st-chip" :data-state="item.status"`, `class="st-chip sm" :class="chipStateCls(item)" :data-state="item.status"`],
  // 状态 → 共享状态类
  [`function queueStateLabel(`, `/** 队列状态映射到跨页面统一的状态层（运行中/完成/失败/中性） */\nfunction chipStateCls(item) {\n  return {\n    "st-dev": item.status === QUEUE_STATE.uploading,\n    "st-done": item.status === QUEUE_STATE.done,\n    "st-fail": item.status === QUEUE_STATE.error,\n    "tc-neutral": ![\n      QUEUE_STATE.uploading,\n      QUEUE_STATE.done,\n      QUEUE_STATE.error,\n    ].includes(item.status),\n  };\n}\n\nfunction queueStateLabel(`],
]);

// ── pdf：.panel 只留弹性布局
rewrite("src/tools/pdf/View.vue", [
  [`.panel { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); }`,
    `/* 外框走全局 .panel；这里只补"占满剩余高度 + 纵向布局" */\n.panel { flex: 1; display: flex; flex-direction: column; }`],
]);

// ── label：.panel 与底座逐字相同（只少了 min-height，底座本就有）→ 整条删掉
rewrite("src/tools/label/View.vue", [
  [`.panel { border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); overflow: hidden; }`, ""],
]);

// ── WorkOverview：卡片内的小空态——只留 gap/padding/p 字号/图标下间距
rewrite("src/views/WorkOverviewView.vue", [
  [`.empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-05); padding: var(--sp-2) 0 var(--sp-4); text-align: center; }`,
    `/* 居中与文字层级走全局 .empty；这里只把它压成卡片内的小尺寸 */\n.empty { gap: var(--sp-05); padding: var(--sp-2) 0 var(--sp-4); }`],
  [`.empty-ico { width: 64px; height: 64px; display: grid; place-items: center; border-radius: 50%; background: var(--primary-soft); color: var(--primary); margin-bottom: var(--sp-05); }`,
    `.empty-ico { margin-bottom: var(--sp-05); }`],
  [`.empty p { margin: 0; font-size: var(--fs-md); color: var(--muted); }`,
    `.empty p { font-size: var(--fs-md); }`],
]);

console.log("\n完成。跑 UPDATE_UI_BASELINE=1 前请先确认 familiesRestatedInViews 已归零。");
