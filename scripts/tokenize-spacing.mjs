#!/usr/bin/env node
// 把硬编码的盒模型间距替换为 --sp-* 令牌。
//
// ## 为什么值得做
// 界面密度档（:root[data-density]）目前只改 7 个 --sp-* 令牌。
// 而统计显示源码里还有 **2000+ 处**写死的 px 间距——它们跟密度档毫无关系，
// 于是"切到舒适档"对绝大多数控件根本不生效：用户改了设置，看到的变化微乎其微。
//
// ## 边界（刻意只动这些）
//   · 只改**盒模型间距**属性：margin* / padding* / gap / row-gap / column-gap
//     （**不含** inset 与 top|right|bottom|left——那是坐标，见下面 SPACING_PROPS 的注释）
//   · 只改**整值**声明：`gap: 8px` → `gap: var(--sp-2)`；
//     `padding: 8px 12px` → `padding: var(--sp-2) var(--sp-4)`（逐个长度替换）
//   · **不改**：border / width / height / font-size / border-radius / flex-basis /
//     transform / line-height / opacity —— 它们不是间距，1px、50%、2px 本就该写死
//   · **不改**单位换算：只有 6/8/10/12/14/16/20px 这 6 个值有对应令牌，
//     5px/7px/9px/11px/13px/18px/22px 等"半档"值留着（给它们建令牌会让刻度变成 25 档）
//
// ## ⚠️ 为什么必须逐文件保留行尾
// 本仓库多数文件是 LF，但 db 工具的视图（src/tools/db/View.vue）是 CRLF。
// 无脑 readFileSync + writeFileSync 会把 CRLF 变 LF，产生整文件假 diff。
// 因此这里按文件判定：先把内容归一成 LF 处理，写回时若原本是 CRLF 就换回去，
// 让 diff 里只出现真正被令牌化的那几行（此前 CRLF 文件是整文件跳过，
// 结果是 ToolWindow.vue / WelcomeView.vue 的间距至今不吃密度档）。
import fs from "node:fs";
import path from "node:path";

const TARGET_DIRS = ["src", "mobile"];

/** 有对应令牌的间距值 → 令牌名（与 tokens.css 的默认档一致） */
const VALUE_TO_TOKEN = new Map([
  // 微间距两档：等值替换，且在密度档里**不重定义**（它们是"线"，不该随密度缩放）
  ["2px", "var(--sp-0)"],
  ["4px", "var(--sp-05)"],
  ["6px", "var(--sp-1)"],
  ["8px", "var(--sp-2)"],
  ["10px", "var(--sp-3)"],
  ["12px", "var(--sp-4)"],
  ["14px", "var(--sp-5)"],
  ["16px", "var(--sp-6)"],
  ["20px", "var(--sp-7)"],
]);

const SPACING_PROPS = [
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "margin-block", "margin-block-start", "margin-block-end",
  "margin-inline", "margin-inline-start", "margin-inline-end",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "padding-block", "padding-block-start", "padding-block-end",
  "padding-inline", "padding-inline-start", "padding-inline-end",
  "gap", "row-gap", "column-gap",
  // ⚠️ 刻意**不含** top / right / bottom / left / inset：
  // 那是"坐标"不是"间距"。TaskView 的月度图就有
  //   .chart-columns { inset: 0 0 38px }
  //   .chart-line    { bottom: calc(38px + (100% - 38px) * X) }
  // 两者是同一套坐标系；若把其中一个 38px 换成令牌而另一个没换，
  // 密度档一切换，图表坐标轴就对不上。布局坐标不参与"密度缩放"。
];
const PROP_RE = new RegExp(`(^|[;{}\\s])(${SPACING_PROPS.join("|")})(\\s*:\\s*)([^;{}]+)`, "g");

function sourceFiles(dir, out = []) {
  const abs = path.resolve(dir);
  if (!fs.existsSync(abs)) return out;
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith(".") || ["node_modules", "dist", "target"].includes(e.name)) continue;
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(rel, out);
    else if (/\.(vue|css)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(rel);
  }
  return out;
}

/** 把一条声明的值里的裸长度换成令牌；值里若已有 var() 则跳过该长度 */
function tokenizeValue(value) {
  let changed = false;
  const next = value.replace(/(?<![\w-])(\d+px)\b(?![\w-])/g, (m) => {
    const token = VALUE_TO_TOKEN.get(m);
    return token || m;
  });
  if (next !== value) changed = true;
  return { next, changed };
}

let filesChanged = 0;
let declsChanged = 0;

for (const dir of TARGET_DIRS) {
  for (const abs of sourceFiles(dir)) {
    const original = fs.readFileSync(abs, "utf8");
    // CRLF 文件不再整文件跳过：归一成 LF 处理，写回时按原样换行（保留行尾，diff 只含改动行）
    const crlf = original.includes("\r\n");
    const text = crlf ? original.replace(/\r\n/g, "\n") : original;

    let count = 0;
    const next = text.replace(PROP_RE, (whole, lead, prop, sep, value) => {
      // 值里已经有 var() 的不碰：避免 var(--sp-2) 被二次替换
      if (value.includes("var(")) return whole;
      const { next: v, changed } = tokenizeValue(value);
      if (!changed) return whole;
      count++;
      return `${lead}${prop}${sep}${v}`;
    });

    if (count > 0) {
      const hadTrailing = /\n$/.test(text);
      const body = hadTrailing ? next : next.replace(/\n+$/, "");
      const out = crlf ? body.replace(/\n/g, "\r\n") : body;
      fs.writeFileSync(abs, out, "utf8");
      // 复核：行尾状态必须与进来时一致，否则整文件假 diff
      const after = fs.readFileSync(abs, "utf8");
      if (after.includes("\r\n") !== crlf) throw new Error(`行尾被改写：${abs}`);
      filesChanged++;
      declsChanged += count;
      console.log(`${path.relative(process.cwd(), abs)}: ${count} 条声明${crlf ? " (CRLF 保留)" : ""}`);
    }
  }
}

console.log(`\n共 ${declsChanged} 条声明，分布在 ${filesChanged} 个文件。`);