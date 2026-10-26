// 把 docs/ui-ux-spec.md §2.1 的刻度表变成**生成的**，不是手抄的。
//
// 为什么要生成：规范里"手抄一份值"这件事在本仓已经失败过两次——
// globals.css 抄了按钮数值导致几何漂移、DomainView 抄了令牌 hex 导致色相不一致。
// 文档抄 tokens.css 是同一个形态，而且**抄错了没有任何东西会红**（守卫能查代码，查不了散文）。
// 现在改成：`npm run gen:ui-scale` 写表，`uiSpec.test.js` 比对，不同步就红灯并告诉你跑哪条命令。
//
// 用法：
//   node scripts/ui-scale-table.mjs           # 写
//   node scripts/ui-scale-table.mjs --check   # 只检查（CI / 守卫用）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "../..");
const TOKENS = "src/styles/tokens.css";
const DOC = "docs/ui-ux-spec.md";
export const START = "<!-- ui-scale:start （由 scripts/ui-scale-table.mjs 生成，改令牌后跑 npm run gen:ui-scale，别手改） -->";
export const END = "<!-- ui-scale:end -->";

/** 族定义：order 是文档里的阅读顺序；scale=是否出现在舒适档对照里 */
export const FAMILIES = [
  { label: "字号 `--fs-*`", order: ["--fs-xs", "--fs-sm", "--fs-md", "--fs-base", "--fs-lg", "--fs-xl", "--fs-num"] },
  { label: "行高 `--lh-*`", order: ["--lh-tight", "--lh-body"] },
  { label: "圆角 `--r-*`", order: ["--r-xs", "--r-sm", "--r-md", "--r-lg", "--r-pill"] },
  { label: "间距 `--sp-1..7`", order: ["--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6", "--sp-7"] },
  { label: "微间距 `--sp-0` `--sp-05`", order: ["--sp-0", "--sp-05"] },
  { label: "控件高 `--control-h*`", order: ["--control-h", "--control-h-sm"] },
  { label: "动效 `--dur-*`", order: ["--dur-fast", "--dur-base", "--dur-slow", "--dur-pulse"] },
  { label: "层叠 `--z-*`", order: ["--z-raised", "--z-float", "--z-overlay", "--z-front", "--z-confirm", "--z-menu"] },
  { label: "外壳尺寸", order: ["--sidebar-w", "--rail-w", "--topbar-h", "--dock-w", "--dock-w-sm"] },
];

/**
 * 只取**顶格**的 `:root {` 与 `:root[data-density="comfort"] {` 两类块。
 * 必须按"是否顶格"过滤：深色段（`@media (prefers-color-scheme: dark) { :root:not(...) {`）
 * 和 reduced-motion 段里的 `:root` 都是缩进的，混进默认表就会拿深色值当浅色值抄错。
 */
export function readScales(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const grab = (selectorRe) => {
    const out = new Map();
    for (const m of text.matchAll(new RegExp(`^${selectorRe}\\s*\\{([\\s\\S]*?)^\\}`, "gm"))) {
      for (const d of m[1].matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(d[1], d[2].trim());
    }
    return out;
  };
  return { light: grab(":root"), comfort: grab(':root\\[data-density="comfort"\\]') };
}

/** 渲染成文档里那张表；同一族内用 ` · ` 连接，舒适档不同才写出来（相同写"不变"）。 */
export function renderTable({ light, comfort }) {
  const rows = ["| 族 | 默认取值 | 舒适档 |", "|---|---|---|"];
  for (const { label, order } of FAMILIES) {
    const defs = order.map((t) => {
      if (!light.has(t)) throw new Error(`tokens.css 的浅色段没有 ${t}`);
      return light.get(t);
    });
    const comf = order.map((t) => comfort.get(t));
    const scaled = order.map((t, i) => (comf[i] && comf[i] !== defs[i] ? comf[i] : null));
    const comfortCell = scaled.every((v) => v === null)
      ? "❌ 不参与"
      : order.map((t, i) => `${t.replace(/^--/, "")} ${scaled[i] ?? defs[i]}`).join(" · ");
    rows.push(`| ${label} | ${defs.join(" · ")} | ${comfortCell} |`);
  }
  return rows.join("\n");
}

export function applyToDoc(docText, table) {
  const s = docText.indexOf(START);
  const e = docText.indexOf(END);
  if (s < 0 || e < 0 || e < s) throw new Error("docs/ui-ux-spec.md 里找不到刻度表的标记对");
  const body = docText.slice(s + START.length, e).replace(/^\n+|\n+$/g, "");
  const block = `${START}\n\n${table}\n\n${END}`;
  return { text: `${docText.slice(0, s)}${block}${docText.slice(e + END.length)}`, changed: body !== table };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { light, comfort } = readScales(fs.readFileSync(path.join(ROOT, TOKENS), "utf8"));
  const table = renderTable({ light, comfort });
  const docPath = path.join(ROOT, DOC);
  const current = fs.readFileSync(docPath, "utf8").replace(/\r\n/g, "\n");
  const { text, changed } = applyToDoc(current, table);
  if (process.argv.includes("--check")) {
    if (changed) {
      console.error("[ui-scale] 文档里的刻度表与 tokens.css 不一致。跑：npm run gen:ui-scale");
      process.exit(1);
    }
    console.log("[ui-scale] 刻度表与 tokens.css 一致。");
  } else {
    const crlf = fs.readFileSync(docPath, "utf8").includes("\r\n");
    fs.writeFileSync(docPath, crlf ? text.replace(/\n/g, "\r\n") : text, "utf8");
    console.log(changed ? "[ui-scale] 已重写 docs/ui-ux-spec.md 的刻度表。" : "[ui-scale] 刻度表本来就是最新的。");
  }
}
