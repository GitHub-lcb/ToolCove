// 手机版 DOM 契约单测：index.html 里被 main.js 引用的 id / data 属性必须真实存在。
//
// 为什么值得单独测：main.js 里全是 `$("#xxx")`，**写错一个 id 不会抛错**——
// 只会得到一个 null，然后在某个事件回调里炸掉，或者更糟：静默什么也不发生。
// 而这类错字在构建、类型检查、SSR 渲染里都查不出来（这个页面根本没有 Vue）。
// 所以从 HTML 里把 id 全抓出来，和源码里引用的一一对齐。
//
// 同时锁住两条版面约定：结论在最前、录入在最后（滚动时结论吸顶、录入钉底）。

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("./main.js", import.meta.url), "utf8");

/** HTML 里所有 id="..." */
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/** main.js 里所有 $("#xxx") / querySelector("#xxx") 引用 */
const referenced = new Set([...main.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)].map((m) => m[1]));

describe("DOM 契约：main.js 引用的 id 都真实存在", () => {
  it("没有引用了但 HTML 里不存在的 id", () => {
    const missing = [...referenced].filter((id) => !htmlIds.has(id)).sort();
    expect(missing, `这些 id 在 index.html 里找不到：${missing.join(", ")}`).toEqual([]);
  });

  it("引用数量对得上（防止正则失效后这条断言变成空跑）", () => {
    expect(referenced.size).toBeGreaterThan(15);
  });

  it("data-mode 与 data-import-pick 这类属性存在", () => {
    expect(html).toContain('data-mode="full"');
    expect(html).toContain("data-import-pick");
  });

  it("构建脚本要替换的两个占位注释都在", () => {
    // build.mjs 靠这两个注释定位插入点，删了它会在构建时抛错（这里提前拦住）
    expect(html).toContain("<!-- STYLES -->");
    expect(html).toContain("<!-- SCRIPT -->");
  });
});

describe("版面约定", () => {
  it("结论（hero）排在录入（setup）之前——滚动时结论在上、录入在下", () => {
    const hero = html.indexOf('id="hero"');
    const setup = html.indexOf('id="setup"');
    expect(hero).toBeGreaterThan(-1);
    expect(setup).toBeGreaterThan(-1);
    expect(hero).toBeLessThan(setup);
  });

  it("16 格记录条与建议区都在两者之间", () => {
    const hero = html.indexOf('id="hero"');
    const strip = html.indexOf('id="strip"');
    const advice = html.indexOf('id="advice"');
    const setup = html.indexOf('id="setup"');
    expect(hero).toBeLessThan(strip);
    expect(strip).toBeLessThan(advice);
    expect(advice).toBeLessThan(setup);
  });

  it("收起态的展开出口挂在 hero 里（顶栏被藏后仍能展开回来）", () => {
    const heroStart = html.indexOf('id="hero"');
    const heroEnd = html.indexOf("</section>", heroStart);
    expect(html.slice(heroStart, heroEnd)).toContain('id="btn-expand"');
  });

  it("面板里不放输入控件（悬浮窗 FLAG_NOT_FOCUSABLE，软键盘弹不出来）", () => {
    // 唯一的 <input> 是隐藏的文件选择器，而且它只在全屏页/浏览器里会用
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((m) => m[0]);
    for (const input of inputs) expect(input).toContain('type="file"');
    // textarea 只出现在导出/导入弹层里（那是全屏页的功能）
    for (const m of html.matchAll(/<textarea[^>]*id="([^"]+)"/g)) {
      expect(["export-text", "import-text"]).toContain(m[1]);
    }
  });
});

describe("构建产物约束", () => {
  it("页面里没有 <script type=module>（file:// 下会被 CORS 拦掉）", () => {
    expect(html).not.toMatch(/<script[^>]+type="module"/);
  });

  it("脚本位置只有构建脚本要替换的那一个占位注释", () => {
    // 源码里不该出现真正的 <script src>——产物是内联的，
    // 而占位注释在构建时会被整段替换掉（build.mjs 会校验替换是否发生）
    expect(html).not.toMatch(/<script\s+src/);
    expect([...html.matchAll(/<!-- SCRIPT -->/g)].length).toBe(1);
  });
});

// ── 真机回归：弹层点不动（用户实测反馈）────────────────────────────────
//
// 现象：悬浮窗里清空确认弹层的「取消 / 清空并回始发站」两个按钮点了没有任何反应。
// 根因是弹层贴在屏幕最底部（align-items: flex-end + 只有 12px 内边距），按钮正好压在
// 安卓手势导航条上，手势条优先吃触摸。
//
// 这类故障编译不报错、单测（当时的）也照过，只在真机上表现为「点了没反应」，
// 所以单独锁两条：安全区内边距、以及「面板里不许开页内弹层」的边界。
describe("弹层可点击性（真机回归）", () => {
  const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

  it("弹层底部内边距叠加了安全区，按钮不会压在手势导航条上", () => {
    const rule = css.match(/\.dialog\s*\{[^}]*\}/);
    expect(rule, "找不到 .dialog 规则").toBeTruthy();
    expect(rule[0]).toMatch(/--safe-bottom/);
  });

  it("弹层靠屏幕底部对齐（这正是必须留安全区的原因）", () => {
    const rule = css.match(/\.dialog\s*\{[^}]*\}/)[0];
    expect(rule).toContain("flex-end");
  });

  it("[hidden] 时确实不显示（display:flex 会盖掉浏览器默认的 hidden 样式）", () => {
    // 弹层用 display:flex 布局，若不显式处理 [hidden]，隐藏的弹层会一直盖在界面上、
    // 吃掉所有点击——这是同一类「按钮没反应」的另一种成因。
    expect(css).toMatch(/\.dialog\[hidden\]\s*\{[^}]*display:\s*none/);
  });

  it("toast 也留了安全区", () => {
    expect(css.match(/\.toast\s*\{[^}]*\}/)[0]).toMatch(/--safe-bottom/);
  });

  it("面板模式（panel）里不渲染任何弹层入口——转交全屏页", () => {
    // 三个会开弹层的动作都必须先走 openInActivity：
    // 全部记录 / 清空确认 / 导入
    expect(main).toMatch(/function openRecords\(\)\s*\{[\s\S]{0,200}?openInActivity\(ACTION_RECORDS\)/);
    expect(main).toMatch(/function doReset\(\)\s*\{[\s\S]{0,200}?openInActivity\(ACTION_RESET\)/);
    expect(main).toMatch(/function openInActivity\(action\)/);
  });

  it("转交动作名与 Kotlin 侧逐字一致（写错只会表现为点了没反应）", () => {
    const kt = readFileSync(
      new URL("../android/app/src/main/java/com/githublcb/railpanel/SupportActivity.kt", import.meta.url),
      "utf8",
    );
    const jsActions = [...main.matchAll(/const (ACTION_[A-Z]+) = "([^"]+)"/g)].map((m) => [m[1], m[2]]);
    expect(jsActions.length, "main.js 里没找到 ACTION_* 常量").toBeGreaterThanOrEqual(4);
    for (const [name, value] of jsActions) {
      expect(kt, `Kotlin 侧没有 ${name} = "${value}"`).toContain(`const val ${name} = "${value}"`);
    }
  });

  it("原生确认清空后回灌页面的钩子存在（否则原生清了、页面还留着旧记录）", () => {
    expect(main).toMatch(/confirmReset\(\)\s*\{[\s\S]{0,80}?resetAll\(\)/);
    const kt = readFileSync(
      new URL("../android/app/src/main/java/com/githublcb/railpanel/SupportActivity.kt", import.meta.url),
      "utf8",
    );
    expect(kt).toContain("window.railHud.confirmReset()");
  });
});
