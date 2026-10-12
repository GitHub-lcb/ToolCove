// 手机端令牌守卫：--m-* 必须是桌面令牌的**别名**，不许再抄一份数值。
//
// 为什么需要它：手机端是独立构建，历史上不加载 `src/styles/tokens.css`，
// 于是 `shell.css` 自带一份"抄来的"颜色。抄写会漂——审计实测三处已经漂了
// （--m-muted / 深色 --m-muted / 深色 --m-danger），而且漂了是**静默**的：
// 两端都照常显示，只是深浅略有不同，没有任何测试会红。
// 现在 `main.js` 先引 tokens.css，`shell.css` 里的 `--m-*` 全部写成 `var(--…)`，
// 本守卫把这件事钉住：出现裸色值、出现误导性的近似 fallback、或引错了顺序，都失败。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SHELL = path.join(ROOT, "mobile/app/styles/shell.css");
const MAIN = path.join(ROOT, "mobile/app/main.js");

/** 手机独有、按物理尺寸定义的令牌（触摸目标 / 标签栏高度），允许写 px。 */
const GEOMETRY = new Set(["--m-touch", "--m-tabbar"]);

const shell = fs.readFileSync(SHELL, "utf8");
const main = fs.readFileSync(MAIN, "utf8");

/** 去掉 /* … *\/ 注释，避免把注释里举例的色值当成定义。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

const code = stripComments(shell);

/** 所有 `--m-xxx: 值;` 定义（可能出现在 :root 与 @media 两块里）。 */
function definitions(text) {
  const out = [];
  const re = /(--m-[a-z-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(text))) out.push({ name: m[1], value: m[2].trim() });
  return out;
}

const defs = definitions(code);

/** 收集 mobile/app 下所有被引用的 --m-*（排除构建产物）。 */
function usedTokens(dir, out = new Set()) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) usedTokens(p, out);
    else if (/\.(css|vue)$/.test(entry.name)) {
      const re = /var\(\s*(--m-[a-z-]+)/g;
      let m;
      while ((m = re.exec(stripComments(fs.readFileSync(p, "utf8"))))) out.add(m[1]);
    }
  }
  return out;
}

describe("手机端令牌是桌面令牌的别名", () => {
  it("扫描规模合理（守卫自己扫空了不能假装全绿）", () => {
    expect(defs.length, "shell.css 里的 --m-* 定义数").toBeGreaterThanOrEqual(15);
    expect(usedTokens(path.join(ROOT, "mobile/app")).size, "被引用的 --m-* 数").toBeGreaterThan(10);
  });

  it("颜色/圆角/间距类令牌一个裸值都不留", () => {
    const offenders = defs.filter((d) => !GEOMETRY.has(d.name) && !/^var\(--[a-z0-9-]+\)$/.test(d.value));
    expect(offenders.map((d) => `${d.name}: ${d.value}`), "必须是纯 var(--…) 别名").toEqual([]);
  });

  it("不许有近似值的 fallback（var(--m-ok, #1e7e34) 这种会把漂移藏起来）", () => {
    const withFallback = code.match(/var\(\s*--m-[a-z-]+\s*,[^)]*\)/g) || [];
    expect(withFallback, `带 fallback 的 --m-* 引用：${withFallback.join(" / ")}`).toEqual([]);
  });

  it("样式文件里不出现裸的十六进制颜色（两处刻意的例外已就地注释说明）", () => {
    const hexes = (code.match(/#[0-9a-fA-F]{3,8}\b/g) || []).filter((h) => h !== "#ffffff" && h !== "#1f2328");
    expect(hexes, `意外的裸色值：${hexes.join(" / ")}`).toEqual([]);
    // 两个例外必须是"固定白底上的固定深字/画布底"，且各自有注释解释为什么不跟随主题
    expect(shell).toContain("这里**不该**跟随主题");
    expect(shell).toMatch(/\.m-canvas-wrap canvas\s*\{[^}]*background:\s*#ffffff/);
  });

  it("引用的每个 --m-* 都有定义", () => {
    const defined = new Set(defs.map((d) => d.name));
    const missing = [...usedTokens(path.join(ROOT, "mobile/app"))].filter((t) => !defined.has(t));
    expect(missing.sort(), `未定义的令牌：${missing.join(", ")}`).toEqual([]);
  });

  it("main.js 先引 tokens.css 再引 shell.css（顺序反了第一轮计算拿不到值）", () => {
    const tokensAt = main.indexOf("styles/tokens.css");
    const shellAt = main.indexOf("styles/shell.css");
    expect(tokensAt, "手机端必须加载桌面令牌").toBeGreaterThan(-1);
    expect(shellAt, "手机端样式必须仍被引入").toBeGreaterThan(-1);
    expect(tokensAt, "tokens.css 必须早于 shell.css").toBeLessThan(shellAt);
  });
});
