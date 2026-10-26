#!/usr/bin/env node
// 把"谁盖住谁"与"遮罩长什么色"归一到 tokens.css 的刻度上。
//
// ## 为什么值得做
// 全局层的 z-index 此前是 18 个散落魔法值，遮罩底色有 4 种写法：
//   · rgba(17,24,39,.5) —— 只有 --overlay 的浅色值
//   · rgba(17,24,39,.4) —— request 工具的两种弹窗
//   · rgba(0,0,0,.4)    —— prompt 工具的两处弹窗
// 写死遮罩色的后果不是"颜色不统一"这么轻：`--overlay` 在深色下是
// rgba(0,0,0,.62)，而这 6 个弹窗绕过令牌，于是**同一应用里深色模式的遮罩
// 有的会变深、有的纹丝不动**——用户切主题时看到的是半套生效。
//
// ## ⚠️ 只做"按行精确替换"，不做全局正则
// z-index 在组件自己的层叠上下文内部（粘滞表头 z:1、图层 z:2）是**局部坐标**，
// 令牌化它们毫无意义，还会把不同文件里恰好同值的规则一起改掉。
// 所以这里用 (文件, 行号, 原值) 三元组钉住每一处，逐条替换该行第一次出现的
// `z-index: N`。行号来自 `grep -rn "z-index" src mobile` 的实测输出，
// 脚本会在值对不上时**报错退出**而不是静默跳过——静默跳过正是"扫描器坏了也全绿"。
//
// ## 局部值（<10）刻意不动
// db/photo/disk/table/rail/generator 里的 z-index: 1|2|3|5|6 全部保留：
// 它们只在各自 scoped 块内部比大小，不参与全局层叠。
// 守卫（src/styles/uiSpec.test.js）据此定的规则是：**z-index ≥ 10 必须走 --z-***。
import fs from "node:fs";
import path from "node:path";

/** 全局层叠：原值 → 令牌（档位严格递增，语义见 tokens.css 注释） */
const Z = {
  raised: "var(--z-raised)",   // 40  就地浮层：工具条、下拉、悬浮控件、抽屉浮出
  float: "var(--z-float)",     // 120 常驻悬浮件：后台监控条、更新/通知面板
  overlay: "var(--z-overlay)", // 200 模态遮罩 + 弹窗
  front: "var(--z-front)",     // 300 要盖住弹窗的浮层：图片预览、全局搜索、历史面板、toast
  confirm: "var(--z-confirm)", // 400 全局确认弹窗
  menu: "var(--z-menu)",       // 500 右键菜单
};

/**
 * [文件, 行号, 原值, 新令牌, 备注]
 * 备注列写的是"这一层在原设计里凭什么压过谁"——迁移时逐条核对过相对次序没被打乱。
 */
const EDITS = [
  // ---- 手机端（shell.css 自己的一份层叠，与桌面同值不同名） ----
  ["mobile/app/styles/shell.css", 80, 20, Z.raised, "底部标签栏 sticky，只需压过页面内容"],
  ["mobile/app/styles/shell.css", 423, 20, Z.overlay, "全屏编辑表单：压过标签栏"],
  ["mobile/app/styles/shell.css", 500, 30, Z.front, "应用内确认弹层：压过编辑表单"],
  ["mobile/app/tools/PhotoToolView.vue", 919, 40, Z.front, "本机图片预览：压过表单与内容"],

  // ---- 应用外壳 ----
  ["src/app/AgentComposer.vue", 1142, 40, Z.raised, "输入框上方弹层"],
  ["src/app/AgentSidePanel.vue", 614, 120, Z.float, "后台任务监控条：原值就是 120，等值迁移"],
  ["src/app/App.vue", 918, 60, Z.float, "更新/通知面板：仍低于遮罩"],
  ["src/app/App.vue", 992, 200, Z.front, "toast：原 200 高于 .modal-mask(100)，迁移后 300>200 关系不变"],
  ["src/app/App.vue", 1024, 45, Z.raised, "窄屏右侧 dock"],
  ["src/app/App.vue", 1036, 30, Z.raised, "窄屏侧栏临时展开：与 dock 互不重叠"],
  ["src/styles/globals.css", 142, 100, Z.overlay, "旧 .modal-mask 兼容别名"],
  ["src/styles/globals.css", 268, 400, Z.menu, "全局右键菜单"],
  ["src/styles/primitives.css", 245, 100, Z.overlay, ".tc-mask"],
  ["src/ui/ConfirmDialog.vue", 46, 300, Z.confirm, "全局确认弹窗：永远压过普通弹窗与浮层"],

  // ---- 工具与视图里的模态遮罩 ----
  ["src/tools/chat/View.vue", 838, 50, Z.overlay, "聊天内全屏遮罩"],
  ["src/tools/disk/View.vue", 1440, 200, Z.overlay, "迁移确认遮罩：源码注释写明要低于全局确认弹窗"],
  ["src/tools/prompt/PromptWorkflowDialog.vue", 219, 40, Z.overlay, "工作流弹窗遮罩"],
  ["src/tools/prompt/View.vue", 1048, 40, Z.overlay, "提示词弹窗遮罩"],
  ["src/tools/request/ReqEnvDialog.vue", 54, 60, Z.overlay, "环境弹窗遮罩"],
  ["src/tools/request/View.vue", 1180, 60, Z.overlay, "保存 / cURL 弹窗遮罩"],
  ["src/views/AiExtract.vue", 588, 260, Z.front, "识图遮罩：原 260 低于确认弹窗(300)，迁移后 300<400 关系不变"],
  ["src/views/GlobalSearch.vue", 295, 200, Z.front, "全局搜索面板：要压过普通弹窗"],
  ["src/views/IterationView.vue", 1762, 200, Z.front, "图片预览"],
  ["src/views/ProblemView.vue", 999, 200, Z.front, "图片预览"],
  ["src/views/SnippetView.vue", 595, 200, Z.front, "图片预览"],
  ["src/views/TaskView.vue", 1214, 260, Z.front, "工时历史遮罩"],

  // ---- 组件内部的浮层（absolute，不逃逸出自身上下文，但仍 ≥10 → 归到 raised 档） ----
  ["src/tools/chat/View.vue", 638, 10, Z.raised, "会话内浮动条"],
  ["src/tools/db/View.vue", 1759, 20, Z.raised, "结果区右侧浮出手柄"],
  ["src/tools/image/View.vue", 940, 30, Z.raised, "拖放高亮层"],
  ["src/tools/json/View.vue", 1462, 30, Z.raised, "历史面板"],
  ["src/tools/json/View.vue", 1475, 30, Z.raised, "Mock 面板"],
  ["src/tools/rail/View.vue", 1484, 30, Z.raised, "工具内二次确认层"],
];

/** 遮罩底色：写死的 rgba → var(--overlay)（深色下才会真的变深） */
const MASK_BG = [
  ["src/views/AiExtract.vue", 588, "rgba(17, 24, 39, 0.5)"],
  ["src/views/GlobalSearch.vue", 295, "rgba(17, 24, 39, 0.5)"],
  ["src/tools/request/View.vue", 1180, "rgba(17, 24, 39, 0.4)"],
  ["src/tools/request/ReqEnvDialog.vue", 54, "rgba(17, 24, 39, 0.4)"],
  ["src/tools/prompt/View.vue", 1044, "rgba(0, 0, 0, 0.4)"],
  ["src/tools/prompt/PromptWorkflowDialog.vue", 215, "rgba(0, 0, 0, 0.4)"],
];

/** 按行改写；行号与期望原值都必须命中，否则视为脚本失效 */
function rewrite(abs, ops) {
  const original = fs.readFileSync(abs, "utf8");
  const crlf = original.includes("\r\n");
  const lines = (crlf ? original.replace(/\r\n/g, "\n") : original).split("\n");
  let touched = 0;
  let done = 0;
  for (const { line, run, marker } of ops) {
    const idx = line - 1;
    const before = lines[idx];
    // 可重跑：本行已经是目标形态就跳过，不再要求原值仍在
    // （但**必须**在原值与目标值之间二选一命中——两者都没有说明行号已失效）
    if (before.includes(marker)) { done++; continue; }
    const after = run(before);
    if (after === null) throw new Error(`${abs}:${line} 既无期望原值也无目标值，脚本与源码已不同步`);
    if (after !== before) touched++;
    lines[idx] = after;
  }
  if (!touched) return done ? 0 : 0;
  const body = lines.join("\n");
  const out = /\n$/.test(original) ? body : body.replace(/\n+$/, "");
  fs.writeFileSync(abs, crlf ? out.replace(/\n/g, "\r\n") : out, "utf8");
  const after = fs.readFileSync(abs, "utf8");
  if (after.includes("\r\n") !== crlf) throw new Error(`行尾被改写：${abs}`);
  return touched;
}

const byFile = new Map();
const push = (file, line, run, marker) => {
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push({ line, run, marker });
};

for (const [file, line, oldVal, token] of EDITS) {
  push(file, line, (text) => {
    const needle = `z-index: ${oldVal}`;
    if (!text.includes(needle)) return null;
    return text.replace(needle, `z-index: ${token}`);
  }, `z-index: ${token}`);
}
for (const [file, line, rgba] of MASK_BG) {
  push(file, line, (text) => {
    const needle = `background: ${rgba}`;
    if (!text.includes(needle)) return null;
    return text.replace(needle, "background: var(--overlay)");
  }, "background: var(--overlay)");
}

let total = 0;
for (const [file, ops] of byFile) {
  const n = rewrite(path.resolve(file), ops);
  total += n;
  console.log(`${file}: ${n} 行（${ops.length} 处待改）`);
}
console.log(`\n共改写 ${total} 行 / ${EDITS.length + MASK_BG.length} 个目标点。`);
