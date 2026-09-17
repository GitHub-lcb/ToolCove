// RailTycoonTool 渲染冒烟：node 环境用 SSR 渲染默认驾驶舱（未录任何一站）。
// 求解与建议逻辑由 railTycoon.test.js 覆盖，这里只兜住视图层回归：
// 模板绑定写错、动态拼的 i18n 键缺失、组件导入期崩溃，
// 外加三条版面约定——
//   1) 录入卡（记录·当前站）排在结论卡（推断·下一站）之前，即「左记右看」；
//   2) 录入卡头部只有不可点的「当前站」标签。旧版那个既可当站号、又能翻站的
//      「‹ 下一站 ›」按钮被删了，它的词条也一并删了，所以这里连裸键一起拦；
//   3) 驾驶舱顶栏左边是 16 格记录条（一格一站），替掉了旧版的「挑战线路 · 16 站」
//      徽标与「N 种合法排列」统计；「清空重来」常亮，确认层点了才弹；
//   4) 格子里写的是确认的结果字（已录入=实底、推断锁定=虚框），开局没有结果时才是站号占位。
import { describe, it, expect } from "vitest";
import { createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { i18n } from "../i18n/index.js";
import RailTycoonTool from "./RailTycoonTool.vue";

const t = (key, params) => i18n.global.t(key, params);

async function render() {
  const app = createSSRApp({ render: () => h(RailTycoonTool, { showToast: () => {} }) });
  app.use(i18n);
  return renderToString(app);
}

/** 取某段容器的 HTML：从 marker 起、到下一个同级 section 前止。 */
function slice(html, marker, endMarker) {
  const start = html.indexOf(marker);
  expect(start, `找不到 ${marker}`).toBeGreaterThan(-1);
  const end = endMarker ? html.indexOf(endMarker, start) : html.length;
  return html.slice(start, end === -1 ? html.length : end);
}

/**
 * 去掉 HTML 注释。
 *
 * 模板里的注释会原样进 SSR 输出，而它们讨论的正是「删掉了什么、为什么」——
 * 于是「界面上不该再出现 X」这类断言会被注释里的 X 误伤（本文件踩过一次）。
 * 要断言的是**渲染出来的东西**，所以先摘掉注释。
 */
function visible(html) {
  return html.replace(/<!--[\s\S]*?-->/g, "");
}

describe("RailTycoonTool 渲染", () => {
  it("录入卡排在结论卡之前（左记右看）", async () => {
    const html = await render();
    const quick = html.indexOf('class="quick"');
    const hero = html.indexOf('class="hero');
    expect(quick, "录入卡没渲染").toBeGreaterThan(-1);
    expect(hero, "结论卡没渲染").toBeGreaterThan(-1);
    expect(quick).toBeLessThan(hero);
  });

  it("录入卡头部只认「当前站」，不再出现可点的翻站按钮", async () => {
    const html = await render();
    const head = slice(html, 'class="quick-head"', 'class="hero');
    expect(head).toContain(t("toolbox.rail.hudCurTag"));
    expect(head).toContain(t("toolbox.rail.hudRecordShort"));
    // 开局光标停在始发站
    expect(head).toContain(t("toolbox.rail.origin"));
    // 「下一站」是结论卡的说法，录入卡头部不该出现（title 里的说明文字另有措辞）
    expect(head).not.toContain(`>${t("toolbox.rail.hudNextTag")}<`);
    // 翻站按钮删掉后，词条也删了：这里同时能拦住「模板还在用、词条已没」的裸键
    expect(head).not.toContain("hudNav");
  });

  it("结论卡在站号前标出「下一站」", async () => {
    const html = await render();
    const head = slice(html, 'class="hero-head"', 'class="hero-body"');
    expect(head).toContain(t("toolbox.rail.hudNextTag"));
    // 开局第一站未知，站号取「第 1 站」
    expect(head).toContain(t("toolbox.rail.nthStation", { n: 1 }));
  });

  it("录入卡保留两行按钮组与「全部记录」入口", async () => {
    const html = await render();
    const quick = slice(html, 'class="quick"', 'class="hero');
    for (const key of ["hudTypeLabel", "hudHintLabel"]) {
      expect(quick, key).toContain(t(`toolbox.rail.${key}`));
    }
    // 提示行四个按钮：三个「X 最多」+「数量相同」——这是推断唯一的约束来源
    for (const key of ["winery", "eatery", "trade"]) {
      const type = t(`toolbox.rail.short${key.charAt(0).toUpperCase()}${key.slice(1)}`);
      expect(quick, key).toContain(t("toolbox.rail.optHintMaxShort", { type }));
    }
    expect(quick).toContain(t("toolbox.rail.optHintSameShort"));
    // 全表入口：悬浮模式里顶栏被藏起来，这是浮窗内唯一的「看到别的站」的路径
    expect(quick).toContain(t("toolbox.rail.allRecords"));
  });

  it("「全部记录」覆盖层默认关着", async () => {
    const html = await render();
    expect(html).not.toContain('class="rec-overlay"');
  });

  it("驾驶舱顶栏是 16 格记录条：一格一站，开局全空", async () => {
    const html = await render();
    const bar = visible(slice(html, 'class="action-bar"', 'class="quick"'));
    expect((bar.match(/mini-cell/g) ?? []).length, "应恰好 16 格").toBe(16);
    // 开局什么都没记 → 16 格全是空态；半记/已记两档都不该出现
    expect((bar.match(/st-empty/g) ?? []).length).toBe(16);
    expect(bar).not.toContain("st-half");
    expect(bar).not.toContain("st-done");
    // 始发站不编号，用「始」占第 1 格；光标就在它上面（Vue 把动态 class 排在静态 class 之前）
    expect(bar).toContain(t("toolbox.rail.stripOrigin"));
    expect(bar).toContain("st-empty current mini-cell");
    // 末格是终点站，右侧加粗一档
    expect(bar).toContain("st-empty end mini-cell");
    // 开局没有任何结果：既没有结果字的颜色类，也没有推断虚框
    expect(bar).not.toContain("pred");
    for (const key of ["Winery", "Eatery", "Trade"]) {
      expect(bar).not.toContain(`t-${key.toLowerCase()}`);
    }
  });

  it("记录条格子写的是确认的结果：词条与占位口径对得上", async () => {
    const html = await render();
    const bar = visible(slice(html, 'class="action-bar"', 'class="quick"'));
    // 开局格子退回站号占位；结果字的词条必须存在且是单字/单字母——
    // 格子只有十几像素宽，放不下完整类型名（这里同时拦住模板还在用裸键）
    for (const key of ["cellWinery", "cellEatery", "cellTrade"]) {
      const word = t(`toolbox.rail.${key}`);
      expect(word.length, key).toBeLessThanOrEqual(2);
      expect(bar).not.toContain(`>${word}<`); // 开局没有结果，不该出现结果字
    }
    // 16 格恰好是「始 + 1~15」的占位
    for (let n = 1; n <= 15; n += 1) expect(bar).toContain(`>${n}<`);
  });

  it("顶栏不再显示「N 种合法排列」，也不再用徽标", async () => {
    const html = await render();
    const bar = visible(slice(html, 'class="action-bar"', 'class="quick"'));
    // 词条已删，模板若还引用就会渲染出裸键；这里三种都拦
    expect(bar).not.toContain("statLegal");
    expect(bar).not.toContain("种合法排列");
    expect(bar).not.toContain(t("toolbox.rail.badge", { n: 16 }));
  });

  it("「清空重来」常亮，复制仍按「有没有东西可复制」变灰", async () => {
    const html = await render();
    const bar = visible(slice(html, 'class="action-bar"', 'class="quick"'));
    const buttons = [...bar.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);
    const byLabel = (label) => buttons.find((b) => b.includes(label));
    const copy = byLabel(t("toolbox.rail.copy"));
    const reset = byLabel(t("toolbox.rail.reset"));
    expect(copy, "复制按钮没渲染").toBeTruthy();
    expect(reset, "清空按钮没渲染").toBeTruthy();
    // 清空是卡在半路时唯一的退路，退路不能有条件——开局没有记录也必须是亮的
    expect(reset).not.toContain("disabled");
    expect(copy).toContain("disabled");
  });

  it("清空确认层默认关着（点了才弹）", async () => {
    const html = await render();
    expect(html).not.toContain("confirm-panel");
  });

  it("不把未解析的词条 key 渲染到界面上", async () => {
    const html = await render();
    expect(html).not.toMatch(/toolbox\.rail\.[A-Za-z]/);
    expect(html).not.toContain("undefined");
  });
});
