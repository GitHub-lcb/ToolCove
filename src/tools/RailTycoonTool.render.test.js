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

/**
 * 渲染完整版面。组件在 setup 里同步读 localStorage 的版面偏好（见 readSavedView），
 * 所以 SSR 里塞一个桩就能渲染出完整版面——否则这边永远只测得到驾驶舱。
 */
async function renderFull() {
  const backup = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: (key) => (key === "railTycoonView" ? "full" : null),
    setItem: () => {},
  };
  try {
    return await render();
  } finally {
    if (backup === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = backup;
  }
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
  it("驾驶舱四段顺序：工具栏 → 路线行（核心）→ 录入 → 提醒", async () => {
    const html = await render();
    const bar = html.indexOf('class="hud-toolbar"');
    const board = html.indexOf('class="route-board"');
    const quick = html.indexOf('class="quick"');
    const side = html.indexOf('class="hud-side"');
    expect(bar, "工具栏没渲染").toBeGreaterThan(-1);
    expect(board, "路线行没渲染").toBeGreaterThan(-1);
    expect(quick, "录入卡没渲染").toBeGreaterThan(-1);
    expect(side, "提醒区没渲染").toBeGreaterThan(-1);
    expect(bar).toBeLessThan(board);
    expect(board).toBeLessThan(quick);
    expect(quick).toBeLessThan(side);
  });

  it("路线行：恰好 16 格、站号 1~16、首格是「始」", async () => {
    const html = await render();
    const board = visible(slice(html, 'class="route-board"', 'class="quick"'));
    expect((board.match(/<li[^>]*class="[^"]*rnode/g) ?? []).length, "应恰好 16 格").toBe(16);
    for (let n = 1; n <= 16; n += 1) expect(board, `站号 ${n}`).toContain(`>${n}<`);
    expect(board).toContain(t("toolbox.rail.stripOrigin"));
    // 开局全未知：16 格都是虚线未知态，没有已录入、没有锁定色
    expect((board.match(/unknown/g) ?? []).length).toBe(16);
    expect(board).not.toContain("rec");
    expect(board).not.toContain("pred");
  });

  it("气泡长在「当前记录站」上（开局＝始发站），与下方录入卡说的是同一站", async () => {
    const html = await render();
    const board = visible(slice(html, 'class="route-board"', 'class="quick"'));
    expect((board.match(/bubble/g) ?? []).length, "气泡只该有一格").toBe(1);
    const bubble = board.match(/<li[^>]*bubble[\s\S]*?<\/li>/)[0];
    // 开局光标在始发站（第 1 站）：气泡必须落在第一格，且带站名与「始」字
    expect(bubble).toContain(t("toolbox.rail.nthStation", { n: 1 }));
    expect(bubble).toContain(t("toolbox.rail.stripOrigin"));
    // 第一格就是气泡本身（旧版是「前沿在第 2 站、游标在第 1 站」，上下不一致）
    const firstCell = board.match(/<li[\s\S]*?<\/li>/)[0];
    expect(firstCell).toBe(bubble);
    // 录入卡头部同样写「当前站 · 第 1 站」
    const quick = visible(slice(html, 'class="quick"', 'class="hud-side"'));
    expect(quick).toContain(t("toolbox.rail.nthStation", { n: 1 }));
  });

  it("录入卡只服务「记这一站」：类型 + 提示两组按钮，覆盖范围独立一行", async () => {
    const html = await render();
    const quick = visible(slice(html, 'class="quick"', 'class="hud-side"'));
    expect(quick).toContain(t("toolbox.rail.hudCurTag"));
    expect(quick).toContain(t("toolbox.rail.hudRecordShort"));
    // 开局光标停在始发站（第 1 站）
    expect(quick).toContain(t("toolbox.rail.origin"));
    for (const key of ["winery", "eatery", "trade"]) {
      const type = t(`toolbox.rail.short${key.charAt(0).toUpperCase()}${key.slice(1)}`);
      expect(quick, key).toContain(t("toolbox.rail.optHintMaxShort", { type }));
    }
    expect(quick).toContain(t("toolbox.rail.optHintSameShort"));
    // 覆盖范围独立成行（.covers）：始发站的提示覆盖第 2~4 站
    const covers = quick.match(/<p[^>]*class="covers"[^>]*>([^<]*)<\/p>/);
    expect(covers, "覆盖范围没渲染成独立行").toBeTruthy();
    expect(covers[1]).toContain(t("toolbox.rail.hintCoversLong", { from: 2, to: 4 }));
    // 翻站按钮删掉后词条也删了；「全部记录」已挪去工具栏，不占录入卡
    expect(quick).not.toContain("hudNav");
    expect(quick).not.toContain(t("toolbox.rail.allRecords"));
  });

  it("工具栏：题目 + 图标动作（全部记录入口在工具栏）；清空常亮、复制开局变灰", async () => {
    const html = await render();
    const bar = visible(slice(html, 'class="hud-toolbar"', 'class="route-board"'));
    expect(bar).toContain(t("toolbox.rail.badge", { n: 16 }));
    expect(bar).toContain(t("toolbox.rail.allRecordsTip"));
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

  it("提醒区：开局给动作建议 + 「记全才能去下一站」，不亮警告条、不出现推进按钮", async () => {
    const html = await render();
    const side = visible(slice(html, 'class="hud-side"', '</aside>'));
    expect(side).toContain(t("toolbox.rail.hudActOrigin"));
    expect(side).toContain(t("toolbox.rail.hudWaitNext"));
    // 本站（始发站）还没记提示 → 不能去下一站；推进按钮是手动动作，记全后才出现
    expect(side).not.toContain('class="go-next"');
    expect(side).not.toContain('class="alert2"');
  });

  it("「全部记录」覆盖层默认关着", async () => {
    const html = await render();
    expect(html).not.toContain('class="rec-overlay"');
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

  it("完整版面「下一站推断」写对站号：开局是第 2 站（始发站占第 1 站）", async () => {
    // 模板注释会原样进 SSR 输出，先摘掉再断言
    const html = visible(await renderFull());
    // 首个未确认站是下标 1 = 第 2 站；若哪个视图又自己做 +1，就会写成第 3 站
    expect(html).toContain(t("toolbox.rail.nextUncertain", { n: 2 }));
    expect(html).not.toContain(t("toolbox.rail.nextUncertain", { n: 3 }));
    // 终点站就是第 16 站，路线条上必须出现它
    expect(html).toContain(t("toolbox.rail.nthStation", { n: 16 }));
  });

  it("完整版面：提示下拉只有终点站禁用，尾段覆盖范围按剩余站数收窄", async () => {
    const html = await renderFull();
    const table = slice(html, 'class="table-card"', 'class="side"');
    // 16 行里只有终点站那一个提示下拉是禁用的（旧版会把第 13~15 站一起禁掉）
    expect((table.match(/disabled/g) ?? []).length, "只有终点站的提示下拉禁用").toBe(1);
    expect(table).toContain(t("toolbox.rail.hintDisabled"));
    // 下标 13（第 14 站）覆盖第 15~16 站；下标 14（第 15 站）只剩第 16 站，用单站说法
    expect(table).toContain(t("toolbox.rail.hintCoversLong", { from: 15, to: 16 }));
    expect(table).toContain(t("toolbox.rail.hintCoversOneLong", { to: 16 }));
  });

  it("完整版面的 16 站全表照常渲染", async () => {
    const html = await renderFull();
    expect(html).toContain('class="record-table"');
    expect(html).toContain(t("toolbox.rail.colStation"));
    // 始发站没有类型：给静态标签而不是下拉
    expect(html).toContain(t("toolbox.rail.origin"));
  });
});
