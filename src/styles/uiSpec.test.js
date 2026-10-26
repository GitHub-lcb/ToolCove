// UI/UX 规范守卫：把 docs/ui-ux-spec.md 里"能被机器判定"的那部分钉成用例。
//
// 规范文档本身不会被遵守第二次——这是本仓已经验证过多次的教训
// （"新代码请直接用 .tc-*"这句写在 globals.css 注释里，实际兑现 11 处）。
// 所以每条规则要么**当前就是零**（硬性断言），要么**冻结为基线只减不增**（棘轮）。
//
// ── 两类规则的差别 ────────────────────────────────────────────
// 硬性（数字必须是 0）：
//   · 全局层 z-index 必须走 --z-* 刻度
//   · 遮罩底色不许写死 rgba
//   · 组件族的底座只许定义在 primitives.css（且每个族恰好一份）
//   · .vue 里用到的 .tc-* 必须在 primitives.css 里有定义（否则类名静默失效）
// 棘轮（<= 基线）：
//   · 裸色值、裸字号、刻度外间距、刻度外圆角、定义了但零引用的原语类、
//     自己重写组件底座的文件数
//
// 刷新基线：`UPDATE_UI_BASELINE=1 npx vitest run src/styles/uiSpec.test.js`
// 只在**真的减少了债务**之后刷新；刷新前先 `git diff src/styles/uiDebtBaseline.json`。
//
// ⚠️ 每条扫描都必须带"规模下限"：本仓踩过一次扫描器路径算错一层、
// 扫到 0 个文件、断言照样全绿的坑（见 docs/ui-upgrade-progress-and-constraints.md）。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { START, END, readScales, renderTable, applyToDoc } from "../../scripts/ui-scale-table.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const BASELINE_PATH = path.join(ROOT, "src/styles/uiDebtBaseline.json");

/** 扫描范围：与 cssVars.test.js 一致的源码集合（样式只可能写在这些文件里） */
function sourceFiles(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (["node_modules", "dist", "target", "build", "out"].includes(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(rel, out);
    else if (/\.(vue|css)$/.test(entry.name) && !/\.test\./.test(entry.name)) out.push(rel);
  }
  return out;
}
const FILES = ["src", "mobile"].flatMap((d) => sourceFiles(d));

const stripComments = (code) =>
  code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/** .vue 只取 <style> 块：模板里的 class="..." 不是 CSS，脚本里的字符串会污染计数 */
function styleText(rel, raw) {
  if (!rel.endsWith(".vue")) return raw;
  const blocks = [...raw.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]);
  return blocks.join("\n");
}

/** 样式文本（.vue 只取 <style> 块）：判定 CSS 声明用这份 */
const TEXTS = new Map(FILES.map((rel) => [rel, stripComments(styleText(rel, fs.readFileSync(path.join(ROOT, rel), "utf8")))]));
/** 整份文件（模板 + 脚本）：判定"这个类名有没有人用"必须看模板，只看 style 块会把整套原语都判成零引用 */
const RAW = new Map(FILES.map((rel) => [rel, stripComments(fs.readFileSync(path.join(ROOT, rel), "utf8"))]));

/** 除令牌表本身以外的所有样式文本（tokens.css 里当然可以写 hex） */
const NON_TOKEN_FILES = FILES.filter((f) => !f.endsWith("styles/tokens.css"));

/**
 * 定义了却零引用的原语类——"两套体系"就是这样重新长回来的温床：
 * 一份没人用的 `.tc-*`，等于给下一个人留了个"这儿还有个更新的写法"的缺口。
 * 用法判定看**整份文件**（模板里 class="tc-btn tc-btn--ghost" 也是用了），
 * 只看 style 块会把整套原语都判成零引用（这个坑本轮踩过一次）。
 */
const UNUSED_PRIMITIVES = (() => {
  const uniq = [
    ...new Set(
      [...TEXTS.get("src/styles/primitives.css").matchAll(/\.(tc-[a-z][a-z0-9_-]*)(?![a-z0-9_-])/g)].map((m) => m[1])
    ),
  ];
  const used = NON_TOKEN_FILES
    .filter((f) => !f.endsWith("styles/primitives.css"))
    .map((f) => RAW.get(f))
    .join(" ");
  const shell = TEXTS.get("src/styles/globals.css") || "";
  return uniq
    .filter((cls) => {
      const re = new RegExp(`${cls.replace(/-/g, "\\-")}(?![a-z0-9_-])`);
      return !re.test(used) && !re.test(shell);
    })
    .sort();
})();

const countIn = (files, re) =>
  files.reduce((sum, f) => sum + [...TEXTS.get(f).matchAll(re)].length, 0);

/**
 * 遮罩族的关键字。两条方向的教训都留在这里：
 *  · 少了词就漏检：关键词表最初只有 mask/overlay/veil/backdrop/shade，
 *    于是三个 `.img-preview` 的 rgba(10,12,16,.82) 从守卫底下溜过去了。
 *  · 多了词就误伤：`sheet` 会匹配手机端的 `.m-sheet`——那是**全屏表单**
 *    （不透明底、纵向滚动），不是压暗画面的遮罩，本就该自己写定位。
 * 判据必须同时有正反样例才敢定，光看数字对不上是不够的。
 */
const VEIL_KEYWORDS = "mask|overlay|veil|backdrop|shade|lightbox|dim|preview";
function eachVeilRule(fn) {
  const re = new RegExp(`([^{}]*(?:${VEIL_KEYWORDS})[^{}]*)\\{([^{}]*)\\}`, "gi");
  for (const f of FILES) {
    if (f.endsWith("styles/primitives.css")) continue;
    for (const m of TEXTS.get(f).matchAll(re)) fn(m[1], m[2], f);
  }
}
/**
 * 真正的"遮罩"= 类名像遮罩 **且** 自己钉在视口上（position: fixed）。
 * 只用类名判会大面积误伤（`.preview-panel`、`.icon-preview-area` 是预览**面板**，
 * 底色当然该用 --card/--well），第一轮就栽在这里。
 */
const isVeil = (body) => /position:\s*fixed/i.test(body);
/** 写死的遮罩底色：字面 rgba/hex/hsl 都不行，必须走 --overlay / --overlay-strong */
const LITERAL_BG = /background:\s*(?:rgba?\(|hsla?\(|#)/i;
/** 又写了一遍底座（fixed + inset:0）：本轮迁掉 13 处，这条指标防的是第 14 处 */
const RESTATES_BASE = (body) => /position:\s*fixed/i.test(body) && /inset:\s*0/i.test(body);

const VEIL_HITS = [];
const VEIL_BASE_HITS = [];
const VEIL_BASE_HITS_MOBILE = [];
eachVeilRule((sel, body, f) => {
  if (!isVeil(body)) return;
  const label = `${f}  ${(sel.trim().replace(/\s+/g, " ") || "(继承)")}`;
  if (LITERAL_BG.test(body)) VEIL_HITS.push(`${label}: ${(body.match(/background:[^;]*/i) || [""])[0].trim()}`);
  if (!RESTATES_BASE(body)) return;
  // 手机端**不引 primitives.css**（只引 tokens.css + shell.css），那里根本没有
  // .modal-mask 这条底座可复用——所以手机端允许自己写定位，桌面端一条都不许再写。
  // 要消掉这个例外，得先让 mobile 的构建也引入 primitives.css（需要真机确认）。
  (f.startsWith("mobile") ? VEIL_BASE_HITS_MOBILE : VEIL_BASE_HITS).push(label);
});

// ============================================================
// 刻度定义（与 tokens.css 保持一致；这里硬写是为了让"扩刻度"变成一次显式的改动）
// ============================================================
const SPACING_SCALE = new Set(["2px", "4px", "6px", "8px", "10px", "12px", "14px", "16px", "20px"]);
const RADIUS_SCALE = new Set(["6px", "9px", "12px", "16px", "999px", "50%", "calc(50% - 1px)"]);
const FONT_SCALE = new Set(["11px", "12.5px", "13.5px", "14.5px", "16px", "20px", "26px"]);

/** 盒模型间距属性（与 scripts/tokenize-spacing.mjs 同一套边界：不含坐标） */
const SPACING_PROPS =
  "(?:margin|margin-top|margin-right|margin-bottom|margin-left|padding|padding-top|padding-right|padding-bottom|padding-left|gap|row-gap|column-gap)";

/**
 * 组件族的**结构骨架**签名：选择器命中族名 **且** 规则体同时含这几条声明，
 * 才算"又写了一遍底座"。
 * ⚠️ 判据校准踩过一次太宽：最初只要 scoped 里出现 `.empty-ico` 就算违规，
 * 于是 23 个文件里绝大多数被误报——它们只是覆盖尺寸（`.empty-ico { width: 40px }`），
 * 而"只留真差异"正是规范 §3.3 认可的写法。签名必须取**该族赖以成立的那几条属性**。
 */
const FAMILY_SIGNATURES = [
  ["空态的居中骨架", /\.empty\b|\.empty-ico\b/, [/display:\s*flex/, /flex-direction:\s*column/, /align-items:\s*center/]],
  ["面板的外框", /\.panel\b/, [/border:\s*1px solid var\(--card-border\)/, /border-radius:\s*var\(--r-md\)/, /background:\s*var\(--card\)/]],
  ["按钮的骨架", /\.btn-primary\b|\.btn-outline\b|\.btn-ghost\b|\.icon-btn\b/, [/display:\s*inline-flex/, /align-items:\s*center/, /font-weight:\s*600/]],
  ["弹窗的骨架", /\.modal\b/, [/max-height:\s*90vh/, /box-shadow:\s*var\(--shadow-pop\)/]],
  ["胶囊的骨架", /\.st-chip\b|\.tc-chip\b/, [/border-radius:\s*var\(--r-pill\)/, /white-space:\s*nowrap/, /font-weight:\s*600/]],
];
const RULE_BODY = /([^{}]*)\{([^{}]*)\}/g;

/** 在自己 <style scoped> 里又写了一遍组件底座（而不是覆盖个别属性）的文件 */
const RESTATING_FILES = NON_TOKEN_FILES.filter((f) => {
  if (!f.endsWith(".vue")) return false;
  const text = TEXTS.get(f);
  return FAMILY_SIGNATURES.some(([, selRes, bodyRes]) => {
    if (!selRes.test(text)) return false;
    for (const m of text.matchAll(RULE_BODY)) {
      if (!selRes.test(m[1])) continue;
      if (bodyRes.every((re) => re.test(m[2]))) return true;
    }
    return false;
  });
});

/**
 * 桌面端 = 硬性 0（`.panel/.empty/.st-chip/.modal/.btn-*` 的底座就在 primitives.css 里，
 * 并列类名 + 只留真差异的做法已经验证可行）；
 * 手机端另计，它的构建里没有 primitives.css，没有底座可复用。
 */
const RESTATING_FILES_DESKTOP = RESTATING_FILES.filter((f) => f.startsWith("src/"));
const RESTATING_FILES_MOBILE = RESTATING_FILES.filter((f) => f.startsWith("mobile/"));

/**
 * 换个类名再写一遍——这才是"自造组件"的主形态。
 * 上面那段只抓得住沿用族名的（`.panel`、`.empty`），而工具里更常见的是
 * `.md-btn`、`.tt-toolbar` 这种**换了名字的同一种东西**。
 * 所以这里不看类名，只看骨架属性组合：凑齐就判"又一个自造实现"。
 * 它是棘轮而不是硬性 0：存量确实还有一批，逐个替换要看着界面来。
 */
const SKELETON_SHAPES = [
  ["按钮", [/display:\s*inline-flex/, /align-items:\s*center/, /justify-content:\s*center/, /border-radius:\s*var\(--r-(sm|md)\)/, /cursor:\s*pointer/]],
  ["空态", [/flex-direction:\s*column/, /align-items:\s*center/, /justify-content:\s*center/, /text-align:\s*center/]],
  ["工具条", [/display:\s*flex/, /align-items:\s*center/, /gap:\s*var\(--sp-/, /border-radius:\s*var\(--r-md\)/, /background:\s*var\(--card\)/]],
];
const HAND_ROLLED = [];
for (const f of NON_TOKEN_FILES) {
  if (!f.endsWith(".vue") || /primitives|globals|tokens/.test(f)) continue;
  for (const m of TEXTS.get(f).matchAll(RULE_BODY)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    // 只认"这个类自己就是那个组件"的规则：伪类与后代选择器（.x:hover、.a .b）不算
    if (!/^\.[\w-]+(?:,\s*\.[\w-]+)*$/.test(sel)) continue;
    for (const [shape, res] of SKELETON_SHAPES) {
      if (res.every((re) => re.test(m[2]))) HAND_ROLLED.push(`${f}  ${sel} → 又一个${shape}`);
    }
  }
}

/**
 * 遮罩站点与对话框语义。
 * 一个遮罩 = 一个对话框：它必须挂 `v-dialog`（或自己写了 role="dialog"）。
 * 指令在挂载时才产出 role/aria-modal/可访问名，SSR 里看不到，所以这里判的是**模板**，
 * 真实语义由浏览器端 e2e 覆盖。
 */
const MASK_SITE = /class="[^"]*(?:modal-mask|tc-mask|m-modal)(?!-)/;
const DIALOG_SEMANTICS = /v-dialog|role="dialog"/;
const TOAST_EL = /class="[^"]*\btoast\b(?!-)[^"]*"/;
const dialogsMissingSemantics = (() => {
  let n = 0;
  for (const f of FILES) {
    if (!f.endsWith(".vue")) continue;
    const lines = RAW.get(f).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!MASK_SITE.test(lines[i])) continue;
      // 盒子通常在遮罩的同一行或接下来三行内
      const window = lines.slice(i, i + 4).join("\n");
      if (!DIALOG_SEMANTICS.test(window)) n++;
    }
  }
  return n;
})();
/** 提示区必须是 live region，否则读屏用户完全收不到"发生后才知道"的信息 */
const toastsWithoutLiveRegion = (() => {
  let n = 0;
  for (const f of FILES) {
    if (!f.endsWith(".vue")) continue;
    for (const line of RAW.get(f).split("\n")) {
      if (!TOAST_EL.test(line) || !/<div\b/.test(line)) continue;
      if (!/aria-live|role="status"|role="alert"/.test(line)) n++;
    }
  }
  return n;
})();

/**
 * 用了 `v-dialog` 的组件必须自己 import 指令。
 * 全局注册只保证浏览器里能用；SSR 渲染测试（`createSSRApp` + `renderToString`）里
 * 未注册的指令会让整条渲染报错——本轮就撞过一次：24 个组件里漏了 1 个，
 * `RequestTool` 的三条渲染用例直接红在"Failed to resolve directive: dialog"上。
 * `<script setup>` 会就地解析同名 `vXxx` 绑定，所以导入才是可靠的那条路。
 */
const directiveNotImported = FILES.filter(
  (f) => f.endsWith(".vue") && /(?:\sv-dialog\b|v-dialog=)/.test(RAW.get(f)) && !/import\s*\{\s*vDialog\s*\}/.test(RAW.get(f))
);
/** 同一条教训用在 `v-field-error` 上：用了指令就得就地 import（SSR 渲染测试不吃全局注册） */
const fieldErrorNotImported = FILES.filter(
  (f) => f.endsWith(".vue") && /(?:\sv-field-error\b|v-field-error=)/.test(RAW.get(f)) && !/import\s*\{\s*vFieldError\s*\}/.test(RAW.get(f))
);

/**
 * 纯图标按钮必须有可访问名（`title` 或 `aria-label`）。
 * 这条原本是"走查"，因为它按行判会大面积误判——SFC 里 `<button>` 的属性常换行写，
 * `class="icon-btn"` 在第一行、`:title` 在第四行。所以这里**按标签取整段属性**再判。
 * ⚠️ 取标签不能用"碰到第一个 > 就停"：JSON 工具里有个
 * `:disabled="tabs.length >= 10"`，那个 `>` 会把标签腰斩，
 * 于是把本来带了 title 的按钮误报成"没名字"（第一版就踩了）。
 * 所以逐字符走，引号内的 > 不算结束。
 */
function buttonTags(text) {
  const out = [];
  let i = 0;
  while ((i = text.indexOf("<button", i)) !== -1) {
    let j = i + 7;
    let quote = null;
    while (j < text.length) {
      const c = text[j];
      if (quote) { if (c === quote) quote = null; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === ">") break;
      j++;
    }
    out.push(text.slice(i + 7, j));
    i = j + 1;
  }
  return out;
}
const UNNAMED_ICON_BUTTONS = (() => {
  const hits = [];
  for (const f of FILES) {
    if (!f.endsWith(".vue")) continue;
    for (const attrs of buttonTags(RAW.get(f))) {
      if (!/class="[^"]*(?:icon-btn|tc-btn--icon)/.test(attrs)) continue;
      if (/(?:^|[\s:]):?(?:v-bind:)?(?:title|aria-label|aria-labelledby)=/.test(attrs)) continue;
      hits.push(`${f}  ${attrs.trim().replace(/\s+/g, " ").slice(0, 90)}`);
    }
  }
  return hits;
})();

/**
 * 整份文件里没有 `aria-*`、没有 `role=`、也没挂 `v-dialog` 的界面数（棘轮）。
 * ⚠️ 判据为什么扫**整份文件**而不是只扫 `<template>` 段：
 *   带嵌套 `<template #slot>` 的视图里，"从第一个 <template> 取到最后一个 </template>"
 *   这种切法会切歪（IterationView 实测被切掉一半，明明有 `aria-expanded` 却判成缺失）。
 *   扫整份文件的代价是：JS 里拼的 aria 字符串也算"有语义"——
 *   对棘轮来说这是偏松，不是偏严，可接受；真要收紧得先写个能配对标签的小解析器。
 */
/**
 * 有理由不带 aria/role 语义的界面，以及**为什么**。
 * 豁免必须写理由——否则一年后没人记得这是漏网还是决定。
 * （先例：工具契约里的 `agentExempt` 也是"允许不做，但必须写清为什么"。）
 */
const VIEWS_ARIA_EXEMPT = {
  "src/views/PoolStatus.vue": "单枚状态徽标：文字可见，播报由承载它的列表负责，自身没有可交互结构",
  "src/views/WelcomeView.vue": "首屏引导页：动作全是带可见文字的主按钮，无列表/进度等需要额外角色的结构",
};
const VIEWS_WITHOUT_ARIA = (() => {
  const dirs = ["src/views/", "src/app/"];
  const hits = [];
  for (const f of FILES) {
    if (!f.endsWith(".vue") || !dirs.some((d) => f.startsWith(d))) continue;
    if (VIEWS_ARIA_EXEMPT[f]) continue;
    if (/aria-[a-z]+=|\brole="|v-dialog/.test(RAW.get(f))) continue;
    hits.push(f);
  }
  return hits;
})();

/**
 * 列头必须有 `scope="col"`：没有它，读屏走到单元格只能说"第 3 列"，说不出这一列是什么。
 * 判据与 scripts/add-th-scope.mjs 完全一致（`<th` 后面是字母就跳过，避免误伤 `<thead`；
 * 已写 scope 的跳过，所以未来的行头 `<th scope="row">` 不会被算成违规）。
 */
const HEADERS_WITHOUT_SCOPE = FILES.filter((f) => f.endsWith(".vue")).flatMap(
  (f) => (RAW.get(f).match(/<th(?![a-zA-Z-])(?![^>]*\bscope=)/g) || []).map(() => f)
);

/**
 * "禁用之后要看得出禁用"，两端分开判，因为**组件层是两套**：
 * 桌面/网页构建引 `primitives.css`，那里有一条元素级底线 `button:disabled`；
 * 手机端只引 `tokens.css` + `shell.css`，底线够不着它，必须按族给口径
 * （`.m-btn[disabled]` / `.m-item-main[disabled]` / `.m-item button[disabled]`，
 * 本轮又补了 `.m-op`（PDF 排序、自检"单独跑一项"）与 `.m-chip`（知识库保存/删除、同步开关）——
 * 钉守卫之前这两族禁用后与能点**长得一模一样**）。
 * 判据取交集：被禁用的 `<button>` 只要**任一**类名在本层有口径就算合规，
 * 因为 `.primary/.sm/.danger` 是跟着底座走的修饰名，单独要求它们有 `[disabled]` 是错的。
 * （代价：并列选择器 `.a, .b[disabled]` 会把 `.a` 也算成有口径；本层的口径也允许来自别的文件的
 * scoped 块——两处都偏松，方向与"别误伤"一致。）
 */
const disabledClassesIn = (inLayer) => {
  const withRule = new Set();
  const css = FILES.filter(inLayer)
    .map((f) => TEXTS.get(f) || "")
    .join("\n}\n");
  for (const block of css.split("}")) {
    const brace = block.indexOf("{");
    if (brace < 0) continue;
    const sel = block.slice(0, brace);
    if (!/\[disabled\]|:disabled/.test(sel)) continue;
    for (const cls of sel.match(/\.[\w-]+/g) || []) withRule.add(cls.slice(1));
  }
  return withRule;
};
const DESKTOP_DISABLED_CLASSES = disabledClassesIn((f) => f.startsWith("src"));
const MOBILE_DISABLED_CLASSES = disabledClassesIn((f) => f.startsWith("mobile"));
/** 桌面那一层的元素级底线；没有它，六个自定义按钮类（.mp-item/.effort-chip/.theme-btn/.mini-btn/.chip）就没人兜 */
const HAS_BUTTON_ELEMENT_RULE = /\bbutton:disabled\b/.test(TEXTS.get("src/styles/primitives.css"));
const DISABLED_WITHOUT_AFFORDANCE = (() => {
  const hits = [];
  for (const [layer, classes, hasElementRule] of [
    ["src", DESKTOP_DISABLED_CLASSES, HAS_BUTTON_ELEMENT_RULE],
    ["mobile", MOBILE_DISABLED_CLASSES, false],
  ]) {
    for (const f of FILES.filter((x) => x.startsWith(layer) && x.endsWith(".vue"))) {
      for (const attrs of buttonTags(RAW.get(f))) {
        if (!/(?:^|[\s:])disabled=/.test(attrs)) continue;
        if (hasElementRule) continue;
        const cls = (attrs.match(/class="([^"]+)"/)?.[1] || "").split(/\s+/).filter(Boolean);
        if (cls.some((c) => classes.has(c))) continue;
        hits.push(`${f}  [${cls.join(" ") || "没有 class 属性"}]`);
      }
    }
  }
  return hits;
})();

/**
 * 同一层 CSS 里"同一个类把同一个属性写了两遍"——这就是"两份定义开始漂移"的形态。
 * 扫三层：桌面原语、桌面全局层、手机端 `shell.css`（手机层历史上真的攒过 12 条死声明，
 * 由 `scripts/dedupe-css-props.mjs` 机械清掉：保留最后一份、从前面几份删被盖掉的属性，
 * 赢家与层叠顺序都不变，所以是零观感变化的清理）。
 * ⚠️ 判据是**属性重复**而不是"类出现两次"：
 * `.panel-head` / `.tc-textarea` 都合法地出现两次（第二次只补不冲突的属性，
 * 用来给历史名加它独有的差异，而共享部分写在选择器组里只有一份），
 * 那种"同一条声明各写一遍"才是要拦的东西。
 * 本条抓到的真实例子：胶囊配色表里误加过一行 `.tc-note { color: --wait-deep; background: --wait-soft }`，
 * 而 `.tc-note` 是提示条的名字——`background` 被后面的定义盖掉、`color` 漏过来，
 * 于是所有 `.tc-note--*` 的文字都是琥珀色。**零引用的原语出事没人看得见，正是这条守卫存在的理由。**
 */
const DUPLICATE_CSS_PROPS = (() => {
  const dupes = [];
  for (const rel of ["src/styles/primitives.css", "src/styles/globals.css", "mobile/app/styles/shell.css"]) {
    const css = TEXTS.get(rel) || "";
    const seen = new Set();
    for (const m of css.matchAll(/^\.([a-z][\w-]*)\s*\{([^}]*)\}/gim)) {
      for (const d of m[2].matchAll(/([a-z-]+)\s*:/g)) {
        const key = `${rel.split("/").pop()} ${m[1]}.${d[1]}`;
        if (seen.has(key)) dupes.push(key);
        else seen.add(key);
      }
    }
  }
  return dupes;
})();

function measure() {
  return {
    // ---- 硬性：这三项必须为 0 ----
    magicZIndex: countIn(NON_TOKEN_FILES, /z-index:\s*([1-9]\d+)\b(?!\s*;?\s*\/\*)/g),
    dialogsMissingSemantics,
    iconButtonsWithoutName: UNNAMED_ICON_BUTTONS.length,
    /** 没有 scope 的列头（本轮 44 个已补齐，新增即红灯） */
    headersWithoutScope: HEADERS_WITHOUT_SCOPE.length,
    /** 禁用后没有可见反馈的按钮（两端各自判，见 DISABLED_WITHOUT_AFFORDANCE 的判据说明） */
    disabledWithoutAffordance: DISABLED_WITHOUT_AFFORDANCE.length,
    /** 同一个类把同一个属性写了两遍，三层 CSS 一起扫（判据见 DUPLICATE_CSS_PROPS 的注释） */
    duplicateCssProps: DUPLICATE_CSS_PROPS.length,
    /** 还缺 aria/role 语义的界面数（棘轮，见 VIEWS_WITHOUT_ARIA 的判据说明） */
    viewsWithoutAriaSemantics: VIEWS_WITHOUT_ARIA.length,
    dialogDirectiveNotImported: directiveNotImported.length,
    fieldErrorDirectiveNotImported: fieldErrorNotImported.length,
    toastsWithoutLiveRegion,
    /**
     * 遮罩底色不许写死：必须 var(--overlay) / --overlay-strong。
     * ⚠️ 判据是"类名像遮罩 **且** position: fixed"——只用类名判会大面积误伤，
     * 本轮第一次收紧时就误报了 24 条（`.preview-panel` 这类预览**面板**底色当然该用 --card）。
     * 而更早的关键词表漏了 `preview`，于是三个 `.img-preview` 的
     * `rgba(10,12,16,.82)` 从守卫底下溜过去——**两头都要有样例才敢定判据**。
     */
    hardcodedOverlay: VEIL_HITS.length,
    /** 桌面端自写遮罩底座：本轮迁完 16 处后必须为 0（手机端另计） */
    restatedMaskBasesDesktop: VEIL_BASE_HITS.length,
    /** 手机端自写底座数——它的构建里没有 primitives.css，见上方注释 */
    restatedMaskBasesMobile: VEIL_BASE_HITS_MOBILE.length,

    tcClassWithoutDefinition: (() => {
      const defined = new Set(
        [...TEXTS.get("src/styles/primitives.css").matchAll(/\.(tc-[a-z][a-z0-9_-]*)/g)].map((m) => m[1])
      );
      let n = 0;
      for (const [rel, text] of RAW) {
        if (rel.endsWith("styles/primitives.css") || rel.endsWith("styles/globals.css")) continue;
        for (const m of text.matchAll(/(?::class|class)="([^"]*tc-[a-z0-9 _.'"[\]-]*)"/gi)) {
          for (const cls of m[1].split(/[\s'"[\]{},]+/)) {
            if (/^tc-[a-z]/.test(cls) && !defined.has(cls)) n++;
          }
        }
      }
      return n;
    })(),

    // ---- 棘轮 ----
    bareHex: countIn(NON_TOKEN_FILES, /#[0-9a-fA-F]{3,8}\b/g),
    bareFontSize: countIn(NON_TOKEN_FILES, /font-size:\s*(\d+(?:\.\d+)?px)/g),
    offScaleSpacing: NON_TOKEN_FILES.reduce((sum, f) => {
      let n = 0;
      for (const m of TEXTS.get(f).matchAll(new RegExp(`${SPACING_PROPS}\\s*:\\s*([^;{}]+)`, "g"))) {
        if (m[1].includes("var(") || m[1].includes("calc(")) continue;
        for (const v of m[1].matchAll(/(?<![\w-])(\d+px)\b(?![\w-])/g)) if (!SPACING_SCALE.has(v[1])) n++;
      }
      return sum + n;
    }, 0),
    offScaleRadius: NON_TOKEN_FILES.reduce((sum, f) => {
      let n = 0;
      for (const m of TEXTS.get(f).matchAll(/border-radius:\s*([^;{}]+|var\([^)]*\))/g)) {
        if (m[1].includes("var(") || RADIUS_SCALE.has(m[1].trim())) continue;
        n++;
      }
      return sum + n;
    }, 0),
    /** 定义了却零引用的原语类数量（名单见 UNUSED_PRIMITIVES，刷新基线时会打印） */
    unusedPrimitives: UNUSED_PRIMITIVES.length,
    /** 又写了一遍组件底座骨架的文件（只覆盖个别属性的不算）——桌面端必须为 0 */
    familiesRestatedInViewsDesktop: RESTATING_FILES_DESKTOP.length,
    familiesRestatedInViewsMobile: RESTATING_FILES_MOBILE.length,
    /** 换了名字的自造组件（按钮/空态/工具条骨架被重新拼一遍）条数 */
    handRolledComponents: HAND_ROLLED.length,
    /** 视口断点的**种数**（取值白名单见 §11.2 与下面的 BREAKPOINT_TIERS） */
    viewportBreakpoints: viewportBreakpointValues().size,
    /** 图标尺寸的**种数**（六档 + 存量白名单，见 §11.3） */
    iconSizes: iconSizeValues().size,
    /** 应用外壳尺寸（280/56/48/340/300）已收成令牌，这里必须为 0 */
    shellGeometryLiterals: ((app) =>
      [...app.matchAll(/(?:grid-template-columns|width|height|min-height):[^;{]*?\b(?:280px|56px|48px|340px|300px)\b/g)].length)(
      TEXTS.get("src/app/App.vue") || ""
    ),
  };
}

/** 所有出现过的媒体查询断点值（≥320px） */
function viewportBreakpointValues() {
  const set = new Set();
  for (const f of FILES) {
    for (const m of TEXTS.get(f).matchAll(/@media[^{]*?\((?:max|min)-width:\s*(\d{3,4})px/g)) {
      if (Number(m[1]) >= 320) set.add(m[1]);
    }
  }
  return set;
}

/** 所有出现过的 `<Icon :size="N">` 取值 */
function iconSizeValues() {
  const set = new Set();
  for (const f of FILES) {
    if (!f.endsWith(".vue")) continue;
    for (const m of RAW.get(f).matchAll(/:size="'?(\d{2})"'?/g)) set.add(m[1]);
  }
  return set;
}

/**
 * 断点与图标尺寸的**取值白名单**（§11.2 / §11.3）。
 *
 * 棘轮只数"种数"，挡不住"换一个数值"：把 780 改成 785，种数还是 17，守卫照样绿。
 * 所以这里把值本身钉住——新增一个主干外的取值会红，删掉存量后白名单里的那一项也要跟着删
 * （下面有用例检查"白名单里已经没有在用的值"）。
 *
 * 加新档位是**一次决定**：先改规范对应小节，再改这里；两处一起改才算数。
 */
const BREAKPOINT_TIERS = ["760", "820", "900", "1000", "1180"];
const KNOWN_OFF_TIER_BREAKPOINTS = ["560", "600", "619", "620", "720", "780", "819", "860", "980", "1100", "1150", "1280"];
const ICON_SIZE_TIERS = ["12", "14", "16", "20", "24", "32"];
const KNOWN_OFF_TIER_ICON_SIZES = ["10", "11", "13", "15", "17", "18", "19", "21", "22", "26", "28", "30", "36", "40"];

const METRICS = measure();

describe("UI/UX 规范：硬性规则（当前必须为零）", () => {
  it("扫描规模合理（防止扫描器坏掉还全绿）", () => {
    // 实测本仓写样式的文件约 110 个（src 73 个 .vue + 4 个 .css，mobile 31 个 .vue + shell.css）
    expect(FILES.length).toBeGreaterThan(100);
    expect(NON_TOKEN_FILES.length).toBeGreaterThan(95);
    // 真的在扫样式：这套 UI 不可能少于 3000 处 var() 引用
    expect(countIn(FILES, /var\(--/g)).toBeGreaterThan(3000);
  });

  it("全局层 z-index 一律走 --z-* 刻度（>=10 不许写数字）", () => {
    expect(METRICS.magicZIndex).toBe(0);
  });

  it("遮罩底色不许写死 rgba（深色下 --overlay 才会真的变深）", () => {
    expect(METRICS.hardcodedOverlay, `写死的遮罩底色：\n${VEIL_HITS.slice(0, 10).join("\n")}`).toBe(0);
  });

  it("桌面端不许再自写遮罩底座（fixed+inset:0 走 .modal-mask）", () => {
    expect(
      METRICS.restatedMaskBasesDesktop,
      `自写底座的遮罩：\n${VEIL_BASE_HITS.slice(0, 10).join("\n")}\n` +
        "改法：模板写 class=\"modal-mask 你的语义类名\"，scoped 里只留真差异（参考 dk-mask / cf-mask）"
    ).toBe(0);
  });

  it(".vue 里用到的 .tc-* 都能在 primitives.css 找到定义", () => {
    expect(METRICS.tcClassWithoutDefinition).toBe(0);
  });

  it("组件族底座只定义在 primitives.css，globals.css 不再兜住任何组件", () => {
    const globals = TEXTS.get("src/styles/globals.css");
    for (const re of [/\.btn-primary\s*\{/, /\.modal\s*\{/, /\.empty\s*\{/, /\.panel\s*\{/, /\.st-chip\s*\{/, /\.skel-block\s*\{/, /\.spin\s*\{/]) {
      expect(re.test(globals), `globals.css 里又出现了组件底座 ${re.source}`).toBe(false);
    }
    const primitives = TEXTS.get("src/styles/primitives.css");
    for (const cls of ["btn-primary", "modal-mask", "empty", "panel", "st-chip", "skel-block", "spin", "tc-btn", "tc-mask", "tc-modal"]) {
      expect(primitives.includes(`.${cls}`), `primitives.css 缺 ${cls}`).toBe(true);
    }
    // 关键帧只许一处：同名 @keyframes 出现两次就是"两份定义开始漂移"的前兆
    const keyframes = [...primitives.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]);
    expect(new Set(keyframes).size).toBe(keyframes.length);
    expect(globals.match(/@keyframes\s+tc-spin/g)).toBe(null);
  });

  it("用 v-dialog 的组件都要自己 import 指令（SSR 渲染测试依赖就地解析）", () => {
    expect(
      METRICS.dialogDirectiveNotImported,
      `缺 import 的组件：\n${directiveNotImported.join("\n")}\n加一行：import { vDialog } from "<相对路径>/ui/dialog.js";`
    ).toBe(0);
  });

  it("用 v-field-error 的组件都要自己 import 指令（同 v-dialog 的教训）", () => {
    expect(
      METRICS.fieldErrorDirectiveNotImported,
      `缺 import 的组件：\n${fieldErrorNotImported.join("\n")}\n加一行：import { vFieldError } from "<相对路径>/ui/fieldError.js";`
    ).toBe(0);
  });

  it("纯图标按钮都要有可访问名（title 或 aria-label）", () => {
    expect(
      METRICS.iconButtonsWithoutName,
      `没有名字的图标按钮：\n${UNNAMED_ICON_BUTTONS.slice(0, 10).join("\n")}\n` +
        '补 :title="t(\x27…\x27)" :aria-label="t(\x27…\x27)"（工具自己的 i18n 片段里加键后跑 npm run gen:tools）'
    ).toBe(0);
  });

  it("同一个类不许把同一个属性写两遍（一份定义才是「改一处两边都变」的前提）", () => {
    expect(
      METRICS.duplicateCssProps,
      `CSS 里重复定义的属性（同一个类 + 同一个属性写了两遍）：\n${DUPLICATE_CSS_PROPS.join("\n")}\n` +
        "机械清理：node scripts/dedupe-css-props.mjs --write（保留最后一份、删掉前面被盖掉的同名属性，" +
        "赢家与层叠顺序都不变）。如果要给历史名补独有差异，就只写**不冲突**的属性（`.panel-head` 那种写法）"
    ).toBe(0);
  });

  it("被禁用的按钮都要有禁用态口径（禁用后必须看得出禁用了）", () => {
    expect(
      METRICS.disabledWithoutAffordance,
      `禁用后没有任何可见反馈的按钮：\n${[...new Set(DISABLED_WITHOUT_AFFORDANCE)].join("\n")}\n` +
        "桌面/网页：primitives.css 的元素级底线 `button:disabled` 必须在；" +
        "手机端不引 primitives.css，得在 mobile/app/styles/shell.css 里给这个按钮族补 " +
        "`[disabled] { opacity: .5; cursor: default; }`（与 .m-btn 同口径）"
    ).toBe(0);
  });

  it("列头都要有 scope（读屏才知道单元格属于哪一列）", () => {
    expect(
      METRICS.headersWithoutScope,
      `缺 scope 的 <th> 出现在：\n${[...new Set(HEADERS_WITHOUT_SCOPE)].join("\n")}\n补 scope="col"（行头用 scope="row"，判据两者都接受）`
    ).toBe(0);
  });

  it("界面都要有 aria/role 语义（豁免必须写明理由）", () => {
    expect(
      METRICS.viewsWithoutAriaSemantics,
      `没有语义的界面：\n${VIEWS_WITHOUT_ARIA.join("\n")}\n` +
        "能加语义就加（列表补 role=list、表格关联标题、状态行补 role=status）；" +
        "确实不需要的，进 VIEWS_ARIA_EXEMPT 并写清为什么"
    ).toBe(0);
  });

  it("每个对话框都要有 dialog 语义（挂 v-dialog 或自己写 role）", () => {
    expect(METRICS.dialogsMissingSemantics, "有遮罩站点没挂对话框语义（见 src/ui/dialog.js）").toBe(0);
  });

  it("提示区必须是 live region（读屏才收得到）", () => {
    expect(METRICS.toastsWithoutLiveRegion, "class=\"toast\" 的元素没有 aria-live/role=status").toBe(0);
  });

  it("应用外壳尺寸只走尺寸令牌（--sidebar-w/--rail-w/--topbar-h/--dock-w）", () => {
    expect(METRICS.shellGeometryLiterals, "App.vue 的 <style> 里又出现了裸的 280/56/48/340/300px").toBe(0);
  });

  it("桌面端不许再自写组件底座骨架（并列类名 + 只留真差异）", () => {
    expect(
      METRICS.familiesRestatedInViewsDesktop,
      `又写了一遍底座的文件：\n${RESTATING_FILES_DESKTOP.join("\n")}\n` +
        "改法：模板写成 class=\"empty 你的类名\"，scoped 里只留这个界面真需要的差异"
    ).toBe(0);
  });

  it("手抄的令牌 hex 必须等于 tokens.css 的浅色值（抄来的值会静默漂移）", () => {
    const tokens = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");
    const light = tokens.match(/^:root\s*\{([\s\S]*?)^\}/m);
    expect(light, "tokens.css 的 :root 浅色段结构变了").not.toBe(null);
    const decl = (name) => {
      const m = light[1].match(new RegExp(`${name}\\s*:\\s*([^;]+)`, "m"));
      return m ? m[1].trim() : null;
    };
    /** 令牌允许是 `var(--x)` 别名，逐层跟进真实色值 */
    const hexOf = (name, depth = 0) => {
      const v = decl(name);
      if (!v) return null;
      if (v.startsWith("#")) return v;
      const ref = v.match(/^var\((--[\w-]+)\)$/);
      return ref && depth < 3 ? hexOf(ref[1], depth + 1) : v;
    };

    // 领域配色表：JS 里的 hueShiftOf 解析不了 var()，只能拿基准 hex 算色相。
    // 这类"抄一份值"在本仓已经漂过两次（手机端 shell.css、这里的 --amber），
    // 能继续留着的前提是**有人逐条比对**——所以比对交给守卫。
    const src = fs.readFileSync(path.join(ROOT, "src/views/DomainView.vue"), "utf8");
    const table = src.match(/const TOKEN_HEX = \{([\s\S]*?)\n\};/);
    expect(table, "DomainView 的 TOKEN_HEX 结构变了，守卫要跟着改").not.toBe(null);
    const pairs = [...table[1].matchAll(/"(--[\w-]+)"\s*:\s*"(#[0-9a-fA-F]{3,8})"/g)];
    expect(pairs.length).toBeGreaterThan(5);
    for (const [, name, hex] of pairs) {
      const truth = hexOf(name);
      expect(truth, `tokens.css 里找不到 ${name} 的浅色值`).toBeTruthy();
      expect(String(truth).toLowerCase(), `TOKEN_HEX 抄的是 ${hex}，令牌已经是 ${truth}`).toBe(hex.toLowerCase());
    }
  });

  it("规范 §2.1 的刻度表与 tokens.css 逐条相等（那张表是生成的，不是手抄的）", () => {
    const docPath = path.join(ROOT, "docs/ui-ux-spec.md");
    const doc = fs.readFileSync(docPath, "utf8").replace(/\r\n/g, "\n");
    expect(doc.includes(START) && doc.includes(END), "docs/ui-ux-spec.md 里少了刻度表的标记对").toBe(true);
    const tokens = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");
    const changed = applyToDoc(doc, renderTable(readScales(tokens))).changed;
    expect(changed, "规范里的刻度表与 tokens.css 不一致——跑 npm run gen:ui-scale").toBe(false);
  });

  it("密度档只缩放留白，微间距两档刻意不参与", () => {
    const tokens = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");
    const comfort = tokens.match(/\[data-density="comfort"\]\s*\{([\s\S]*?)\}/)[1];
    for (const step of ["--sp-1", "--sp-2", "--sp-3", "--sp-4", "--sp-5", "--sp-6", "--sp-7"]) {
      expect(comfort.includes(`${step}:`), `舒适档漏覆盖 ${step}`).toBe(true);
    }
    // --sp-0 / --sp-05 是"线"不是"面"：舒适档里重定义它们会让图标与文字散架
    expect(comfort.includes("--sp-0:")).toBe(false);
    expect(comfort.includes("--sp-05:")).toBe(false);
  });

  it("§2 的刻度集合与 tokens.css 一致（扩刻度必须同时改集合，否则等于绕过「显式决定」）", () => {
    const css = fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8");
    // 只取浅色段顶格的 :root 块；深色段与舒适档的重定义另有口径，不参与刻度定义
    const light = css.slice(css.search(/^:root\s*\{/m));
    const body = light.slice(0, light.indexOf("\n}"));
    const values = (prefix) =>
      new Set([...body.matchAll(new RegExp(`${prefix}\\s*:\\s*([^;]+);`, "g"))].map((m) => m[1].trim()));

    const spacing = values("--sp-[\\w-]+");
    const radius = values("--r-[\\w-]+");
    const fonts = values("--fs-[\\w-]+");
    // 规模下限：解析写坏时不能静默变绿
    expect(spacing.size, "没解析到 --sp-* 令牌").toBeGreaterThan(5);
    expect(fonts.size, "没解析到 --fs-* 令牌").toBeGreaterThan(5);

    expect([...spacing].filter((v) => !SPACING_SCALE.has(v)), "tokens 里的 --sp-* 出现了刻度外的值").toEqual([]);
    expect([...SPACING_SCALE].filter((v) => !spacing.has(v)), "SPACING_SCALE 里有 tokens 已不用的值，删掉").toEqual([]);
    expect([...radius].filter((v) => !RADIUS_SCALE.has(v)), "tokens 里的 --r-* 出现了刻度外的值").toEqual([]);
    expect([...fonts].filter((v) => !FONT_SCALE.has(v)), "tokens 里的 --fs-* 出现了刻度外的值").toEqual([]);
    expect([...FONT_SCALE].filter((v) => !fonts.has(v)), "FONT_SCALE 里有 tokens 已不用的值，删掉").toEqual([]);
  });

  it("断点只许取 §11.2 的五档 + 存量白名单（换一个数值也算新增）", () => {
    const values = viewportBreakpointValues();
    expect(values.size, "没扫到断点，检查扫描器").toBeGreaterThan(10);
    const unexpected = [...values].filter(
      (v) => !BREAKPOINT_TIERS.includes(v) && !KNOWN_OFF_TIER_BREAKPOINTS.includes(v)
    );
    expect(
      unexpected,
      "新增了主干五档（760/820/900/1000/1180）以外的断点：先问能不能复用其中一档；" +
        "确实需要新档位，先改规范 §11.2，再把它加进白名单——两处一起改才算一次决定"
    ).toEqual([]);
    // 白名单只记录存量：存量清掉了，名单也要跟着删，否则下一个人会以为它还在
    expect(
      KNOWN_OFF_TIER_BREAKPOINTS.filter((v) => !values.has(v)),
      "白名单里的这些断点已经没人用了，从 KNOWN_OFF_TIER_BREAKPOINTS 删掉它们"
    ).toEqual([]);
  });

  it("图标尺寸只许取 §11.3 的六档 + 存量白名单（13/15/17 不许再新增）", () => {
    const values = iconSizeValues();
    expect(values.size, "没扫到图标尺寸，检查扫描器").toBeGreaterThan(10);
    const unexpected = [...values].filter(
      (v) => !ICON_SIZE_TIERS.includes(v) && !KNOWN_OFF_TIER_ICON_SIZES.includes(v)
    );
    expect(
      unexpected,
      "新增了六档（12/14/16/20/24/32）以外的图标尺寸：新写的图标取六档之一；" +
        "确实需要新档位，先改规范 §11.3，再更新白名单"
    ).toEqual([]);
    expect(
      KNOWN_OFF_TIER_ICON_SIZES.filter((v) => !values.has(v)),
      "白名单里的这些尺寸已经没人用了，从 KNOWN_OFF_TIER_ICON_SIZES 删掉它们"
    ).toEqual([]);
  });
});

describe("UI/UX 规范：存量债务棘轮（只减不增）", () => {
  const numeric = Object.fromEntries(Object.entries(METRICS).filter(([, v]) => typeof v === "number"));

  if (process.env.UPDATE_UI_BASELINE === "1") {
    // 只在**真的减少了债务**之后刷新；先 git diff src/styles/uiDebtBaseline.json 再提交
    it(`基线已刷新：${JSON.stringify(numeric)}`, () => {
      const out = {
        _comment:
          "由 src/styles/uiSpec.test.js 生成的债务上限，只减不增。刷新：UPDATE_UI_BASELINE=1 npx vitest run src/styles/uiSpec.test.js",
        ...numeric,
      };
      fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(out, null, 2)}\n`, "utf8");
      console.log(`[ui-spec] 零引用的原语类 ${UNUSED_PRIMITIVES.length} 个：${UNUSED_PRIMITIVES.join(", ")}`);
      console.log(`[ui-spec] 又写了一遍底座骨架的 ${RESTATING_FILES.length} 个文件：\n  ${RESTATING_FILES.join("\n  ")}`);
      console.log(`[ui-spec] 手机端自写遮罩底座：\n  ${VEIL_BASE_HITS_MOBILE.join("\n  ")}`);
      console.log(`[ui-spec] 换名字的自造组件 ${HAND_ROLLED.length} 条（前 20）：\n  ${HAND_ROLLED.slice(0, 20).join("\n  ")}`);
      console.log(`[ui-spec] 还缺 aria/role 语义的界面 ${VIEWS_WITHOUT_ARIA.length} 个：\n  ${VIEWS_WITHOUT_ARIA.join("\n  ")}`);
      expect(true).toBe(true);
    });
    return;
  }

  const baseline = fs.existsSync(BASELINE_PATH)
    ? JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"))
    : null;

  if (!baseline) {
    it("基线文件缺失（跑 UPDATE_UI_BASELINE=1 生成）", () => {
      expect(baseline, "src/styles/uiDebtBaseline.json 不存在").not.toBe(null);
    });
    return;
  }

  for (const [key, value] of Object.entries(baseline)) {
    if (key === "_comment") continue;
    it(`${key}：上限 ${value}，当前 ${numeric[key]}`, () => {
      expect(numeric[key], `${key} 涨了，说明新写了一处违规`).toBeLessThanOrEqual(value);
    });
  }
});
