// CSS 变量守卫：两件只靠人眼发现不了的事，钉成用例。
//
//   1) **引用了却从未定义**——CSS 对未定义的 var() 会丢弃整条声明（不是回退成空串），
//      所以 `background: var(--soft)` 在 --soft 没定义时，那条 background **根本不存在**，
//      元素会保持继承来的透明底。界面不报错、测试不红、控制台也没有 warning。
//      审计实测本仓库有 3 组这样的变量、10 处调用；其中 --soft 的 6 处连 fallback 都没写。
//
//   2) **定义了却零引用**——令牌表会越滚越大，而"没人用的颜色"没人敢删，
//      因为一旦有人在删错就炸。实测曾有 11 个死 token（热力图 7 个等）。
//
// 用法：新增/删除 CSS 变量时，本用例会告诉你要不要同时更新 tokens.css。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 本文件在 src/styles/ 下，比 src/ 根级测试深一层，所以要上溯两级才到仓库根。
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** 会被扫描的源码：所有写样式的 .vue / .css / .js（测试自身与构建产物跳过） */
function sourceFiles(dir, out = []) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (["node_modules", "dist", "target", "build", "out"].includes(entry.name)) continue;
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) sourceFiles(rel, out);
    else if (/\.(vue|css|js)$/.test(entry.name) && !/\.test\.js$/.test(entry.name)) out.push(rel);
  }
  return out;
}

const FILES = ["src", "mobile"].flatMap((d) => sourceFiles(d));

/** 去掉注释，避免把注释里举例的变量名算成真实引用 */
const stripComments = (code) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/[^\n]*/g, "$1");

/** var(--name) 与 var(--name, fallback) */
const VAR_USE = /var\(\s*(--[A-Za-z0-9_-]+)/g;

/**
 * 收集"定义处"。刻意**不**把 `var(--x, fallback)` 当作定义：
 * 带 fallback 的引用在 --x 未定义时仍然有效，不是缺陷。
 *
 * 三条容易踩的坑，都在这里挡掉：
 *  1. tokens.css 为了紧凑把多个变量写在同一行（`--a: x;  --b: y;`），
 *     所以不能要求 `--name` 在行首，否则整批漏判成"未定义"。
 *  2. .vue 里的 `:style="{ '--month-days': n }"` 是 **JS 对象字面量**，
 *     键被单引号包着。那是**运行时注入**——CSS 变量在 :style 内联样式里本来
 *     就合法（浏览器会把它当成自定义属性写进 style 属性），不该判成缺失。
 *  3. 反过来，`var(--x, y)` 里的 `--x` 绝不能被当成定义，
 *     否则「缺失」会被自己掩盖掉。
 *
 * 实现上：先剥掉 `var(...)` 片段（消掉坑 3），再按 CSS 声明语法收 `--name:`（消掉坑 1、2）。
 */
const definedName = (m) => m[1];
const VAR_DEF = /(--[A-Za-z0-9_-]+)\s*:(?!:)/g;

/**
 * 内联 :style 里注入的自定义属性（`:style="{ '--month-days': n }"`）：
 * 它是**运行时**写进 style 属性的，作用域仅限那一个元素，
 * 所以不该要求它出现在全局令牌表里——但也不该报"缺失"。
 *
 * 在**未经任何剥离**的原文上直接提取，比让后面那串剥离正则去猜要稳得多：
 * 这些 key 天然只出现在 :style="..." 之内，而那里的引号是配对的。
 */
function runtimeInjectedNames(rawCode) {
  const out = [];
  // 关键：用非贪婪 `*?` 并要求收尾是 `" }` 或 `"` 紧跟 `>`。
  // 贪心的 `[^"]*` 会在嵌套模板串里的引号处提前截断
  // （例如 :style="{ bottom: `calc(… * ${x})` }" 里没有引号，但
  //  相邻属性一旦含 `"` 就会把配对关系带偏）。
  for (const m of rawCode.matchAll(/:style\s*=\s*"(\{.*?\})"\s*>/g)) {
    for (const k of m[1].matchAll(/(['"])(--[A-Za-z0-9_-]+)\1\s*:/g)) out.push(k[2]);
  }
  return out;
}

/**
 * 选择器里的 BEM 修饰符不是变量。
 * `.tc-btn--outline { }` 里的 `--outline` 会被朴素的 `--name:` 规则误当成
 * "定义了一个叫 --outline 的变量"，于是真正的死令牌判断被噪声淹没。
 * 这里先把整条规则的选择器部分挖掉，只留下花括号里的声明。
 */
function stripSelectors(code) {
  return code.replace(/(^|})\s*[^{}]+?\{/g, "$1{");
}

/** 从一段代码里收集"定义处"的变量名（选择器与 var() 已先被挖掉） */
function collectDefinitions(code) {
  const body = stripSelectors(code.replace(/var\([^)]*\)/g, " "));
  const out = [];
  for (const m of body.matchAll(VAR_DEF)) out.push(definedName(m));
  return out;
}

/**
 * 第三方与平台自带的变量，不归桌面令牌表管：
 *  - `--m-*` 由手机端 shell.css 自带（桌面构建根本不加载它）
 */
function isForeign(name) {
  return name.startsWith("--m-");
}

/**
 * `tokens.css` 里某段选择器之后的第一对花括号内容。
 * 必须自己配平花括号：深色块嵌套在 `@media` 里，正则截不干净。
 */
function blockAfter(code, selectorIndex) {
  const open = code.indexOf("{", selectorIndex);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (!depth) return code.slice(open + 1, i);
    }
  }
  return "";
}

const varsIn = (body) => new Set([...body.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));

/**
 * 深色有**两套**触发方式（见 tokens.css 顶部与规范 §6.1）：
 * 跟随系统的 media query，以及用户显式选择时的 `[data-theme="dark"]`。
 * 注释先剥掉，免得把说明文字里举的变量名算进来。
 */
function darkThemeVars() {
  const css = stripComments(fs.readFileSync(path.join(ROOT, "src/styles/tokens.css"), "utf8"));
  const mediaAt = css.search(/@media \(prefers-color-scheme: dark\)/);
  const mediaSel = mediaAt < 0 ? -1 : css.indexOf(':root:not([data-theme="light"])', mediaAt);
  const attrSel = css.search(/^\[data-theme="dark"\]\s*\{/m);
  return {
    byMedia: mediaSel < 0 ? new Set() : varsIn(blockAfter(css, mediaSel)),
    byAttr: attrSel < 0 ? new Set() : varsIn(blockAfter(css, attrSel)),
  };
}

describe("CSS 变量：引用必有定义，定义必有人用", () => {
  it("扫描到的文件数合理（防止正则或路径写错导致空扫描静默通过）", () => {
    expect(FILES.length, "没扫到任何样式文件，检查 SCAN 目录").toBeGreaterThan(50);
  });

  it("每个被 var() 引用的变量都有定义，且无 fallback 的引用不允许缺定义", () => {
    const defined = new Set();
    const uses = [];

    for (const file of FILES) {
      const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
      // 运行时注入的变量也算"有定义"——它在那个元素上真实存在
      for (const name of runtimeInjectedNames(raw)) defined.add(name);
      const code = stripComments(raw);
      // 1) 先收静态定义（全局 + 文件内）
      for (const name of collectDefinitions(code)) defined.add(name);
      // 2) 再收引用，并记下这个调用点有没有 fallback
      for (const m of code.matchAll(VAR_USE)) {
        const name = m[1];
        if (isForeign(name)) continue;
        const after = code.slice(m.index + m[0].length);
        uses.push({ file, name, hasFallback: /^\s*,/.test(after) });
      }
    }

    const missing = uses.filter((u) => !defined.has(u.name));
    const missingNoFallback = missing.filter((u) => !u.hasFallback);
    const missingWithFallback = missing.filter((u) => u.hasFallback);

    expect(
      missingNoFallback.map((u) => `${u.file}  ${u.name}`),
      "以下变量被引用但从未定义，且没有写 fallback —— 这些 CSS 声明会被浏览器整条丢弃，" +
        "元素将保持透明：\n（要么在 styles/tokens.css 补上定义，要么在调用点写 var(--x, 兜底值)）",
    ).toEqual([]);

    // 带 fallback 的不判死（能正常渲染），但要在输出里可见，避免"悄悄依赖外部注入"
    if (missingWithFallback.length) {
      const names = [...new Set(missingWithFallback.map((u) => u.name))];
      console.warn(`[css-vars] ${missingWithFallback.length} 处引用依赖 fallback 或外部注入：${names.join(", ")}`);
    }
  });

  it("没有零引用的死令牌", () => {
    const defined = new Set();
    const used = new Set();

    for (const file of FILES) {
      const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
      const code = stripComments(raw);
      // 运行时注入既算「有定义」也算「有人用」——它就是给某个元素用的
      for (const name of runtimeInjectedNames(raw)) {
        defined.add(name);
        used.add(name);
      }
      for (const name of collectDefinitions(code)) defined.add(name);
      for (const m of code.matchAll(VAR_USE)) used.add(m[1]);
    }

    const dead = [...defined].filter((n) => !used.has(n) && !isForeign(n));
    // 已知且有意保留的例外（写明原因，避免下一个人以为是漏删）
    const KNOWN = new Set(["--orb-opacity"]); // 背景氛围层强度，由 media-query 背景图使用
    const unexpected = dead.filter((n) => !KNOWN.has(n));

    expect(
      unexpected,
      "以下令牌定义了却没有任何地方引用（死令牌）：确认无用后请从 tokens.css 删除；" +
        "若是有意保留，请加进 KNOWN 例外并写明原因",
    ).toEqual([]);
  });

  it("深色两套触发的变量集合必须一致（少补一处 = 半深半浅，没有别的东西会红）", () => {
    const { byMedia, byAttr } = darkThemeVars();
    // 扫描规模兜底：解析正则写坏了不能静默变绿
    expect(byMedia.size, "没解析到「跟随系统」分支的深色变量").toBeGreaterThan(50);
    expect(byAttr.size, "没解析到 [data-theme=dark] 分支的深色变量").toBeGreaterThan(50);

    expect(
      [...byMedia].filter((n) => !byAttr.has(n)),
      "这些变量只在「跟随系统」分支里定义，用户手动切深色时会退回浅色值",
    ).toEqual([]);
    expect(
      [...byAttr].filter((n) => !byMedia.has(n)),
      "这些变量只在 [data-theme=dark] 分支里定义，跟随系统深色时会退回浅色值",
    ).toEqual([]);
  });
});