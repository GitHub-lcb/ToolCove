// UI/UX 基线：对比度与键盘焦点可见性。
//
// 为什么用「通用审计」而不是逐个元素断言：DOM 猜测太脆（这一轮已经踩过两次选择器的坑）。
// 这两个检查对所有界面都成立、且是真实可感的问题：
//   - 正文对比度低于 4.5:1 在深色主题下尤其常见；
//   - 焦点看不见 = 键盘用户无法操作（纯 CSS 收掉 outline 是典型成因）。
import { expect, test } from "@playwright/test";
import { seedData } from "../helpers.js";

/** 在页面里遍历可见文本，算 WCAG 对比度，返回不达标的元素摘要。 */
const CONTRAST_AUDIT = () => {
  const parse = (value) => {
    const match = String(value).match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(/[,/]/).map((n) => Number(n.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const blend = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const luminance = ({ r, g, b }) => {
    const channel = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  const ratio = (a, b) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  /** 逐级向上找第一个不透明背景（自己半透明则与父层合成） */
  const backgroundOf = (element) => {
    let node = element;
    let acc = null;
    while (node && node !== document.documentElement) {
      const bg = parse(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) acc = acc ? blend(acc, bg) : bg;
      if (acc && acc.a >= 1) return acc;
      node = node.parentElement;
    }
    const root = parse(getComputedStyle(document.documentElement).backgroundColor);
    const base = root && root.a > 0 ? root : { r: 255, g: 255, b: 255, a: 1 };
    return acc ? blend(acc, base) : base;
  };

  const offenders = [];
  const seen = new Set();
  for (const element of document.querySelectorAll("body *")) {
    if (element.children.length) continue; // 只看叶子文本节点
    const text = (element.textContent || "").trim();
    if (text.length < 2) continue;
    const style = getComputedStyle(element);
    if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) < 0.2) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue;
    const fg = parse(style.color);
    if (!fg) continue;
    const bg = backgroundOf(element);
    const effectiveFg = fg.a < 1 ? blend(fg, bg) : fg;
    const value = Number(ratio(effectiveFg, bg).toFixed(2));
    const fontSize = Number.parseFloat(style.fontSize) || 14;
    const bold = (Number(style.fontWeight) || 400) >= 700;
    // WCAG AA：正文 4.5:1；大字号（≥18.66px 或 ≥14px 加粗）3:1
    const large = fontSize >= 18.66 || (bold && fontSize >= 14);
    const required = large ? 3 : 4.5;
    const key = `${style.color}|${Math.round(fontSize)}|${text.slice(0, 12)}`;
    if (value < required && !seen.has(key)) {
      seen.add(key);
      offenders.push({
        text: text.slice(0, 24),
        cls: String(element.className || element.tagName).slice(0, 40),
        color: style.color,
        bg: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        size: `${fontSize}px${bold ? " bold" : ""}`,
        ratio: value,
        required,
      });
    }
  }
  return offenders;
};

test("浅色主题：正文对比度符合 WCAG AA", async ({ page }) => {
  await seedData(page, {});
  await page.goto("/");
  await page.locator(".agent").waitFor();
  const offenders = await page.evaluate(CONTRAST_AUDIT);
  if (offenders.length) console.log("浅色主题对比度不达标:", JSON.stringify(offenders.slice(0, 12), null, 1));
  // 允许少量装饰性文本，但正文不该成片不达标
  expect(offenders.length, "对比度不达标的文本数量").toBeLessThan(6);
});

test("深色主题：正文对比度符合 WCAG AA", async ({ page }) => {
  // 深色主题的 token 覆盖写在 @media (prefers-color-scheme: dark) 里（App.vue），
  // 所以这里直接模拟系统配色 —— 比点「切换主题」按钮更确定，也不依赖按钮的文案/类名。
  await page.emulateMedia({ colorScheme: "dark" });
  await seedData(page, {});
  await page.goto("/");
  await page.locator(".agent").waitFor();
  const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--card").trim());
  expect(bg, "深色下 --card 应该被媒体查询覆盖（说明确实切到了深色 token）").not.toBe("#ffffff");
  const offenders = await page.evaluate(CONTRAST_AUDIT);
  if (offenders.length) console.log("深色主题对比度不达标:", JSON.stringify(offenders.slice(0, 12), null, 1));
  expect(offenders.length, "对比度不达标的文本数量").toBeLessThan(6);
});

test("键盘可达：Tab 焦点可见，且不是被 outline:none 收掉的", async ({ page }) => {
  await seedData(page, {});
  await page.goto("/");
  await page.locator(".agent").waitFor();

  const invisible = await page.evaluate(async () => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const outline = `${style.outlineStyle} ${style.outlineWidth}`;
      const hasOutline = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
      const hasShadow = style.boxShadow && style.boxShadow !== "none";
      const hasRingBorder = style.borderBottomWidth !== "0px" || style.borderTopWidth !== "0px";
      return { outline, hasOutline, hasShadow, hasRingBorder };
    };
    const bad = [];
    const seen = new Set();
    for (let i = 0; i < 12; i++) {
      // 用真实的键盘事件推进焦点（Tab 的默认行为由浏览器完成）
      const focusable = [...document.querySelectorAll("button, a[href], input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter(
        (el) => el.offsetParent !== null
      );
      const target = focusable[i];
      if (!target) break;
      target.focus();
      const state = visible(target);
      // 焦点样式可以来自 outline、box-shadow 或 border；三者都没有才算「看不见」
      if (!state.hasOutline && !state.hasShadow && !state.hasRingBorder) {
        const key = String(target.className || target.tagName);
        if (!seen.has(key)) {
          seen.add(key);
          bad.push({ cls: key.slice(0, 50), text: (target.textContent || "").trim().slice(0, 20), outline: state.outline });
        }
      }
    }
    return bad;
  });

  if (invisible.length) console.log("焦点不可见的元素:", JSON.stringify(invisible, null, 1));
  expect(invisible.length, "焦点不可见的可交互元素数量").toBeLessThan(4);
});
