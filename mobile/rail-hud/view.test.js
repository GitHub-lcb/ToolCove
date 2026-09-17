// 手机版 HUD 的视图换算单测。
//
// 这里只测「把求解结果翻成界面要渲染什么」的那一层——真正的推断规则全部来自
// src/tools/railTycoon.js，那边有 railTycoon.test.js 覆盖，这里不重复测规则，
// 测的是手机端**容易自己写错**的三件事：站号口径、格子内容优先级、提示覆盖范围。

import { describe, it, expect } from "vitest";
import { MESSAGES } from "./i18n.gen.js";
import { setLocale, t } from "./i18n.js";
import {
  allRecorded,
  heroView,
  hintCoversShort,
  hintText,
  hudAdvice,
  isOrigin,
  lockedTypeAt,
  missingHints,
  progressPct,
  stationName,
  stripCellView,
  summaryText,
  TYPE_KEYS,
  typedCount,
  upcoming,
} from "./view.js";
import { STATION_COUNT, solveRailRoute, HINT_SAME, hintMax } from "../../src/tools/railTycoon.js";

setLocale("zh-CN");

const blank = () => ({
  observed: new Array(STATION_COUNT).fill(null),
  hints: new Array(STATION_COUNT).fill(null),
});
const solve = (state) => solveRailRoute(state);

describe("手机版 i18n", () => {
  it("两种语言都在，且键集合完全一致", () => {
    const flat = (node, prefix = "") =>
      Object.entries(node).flatMap(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k;
        return v && typeof v === "object" ? flat(v, key) : [key];
      });
    const zh = flat(MESSAGES["zh-CN"]).sort();
    const en = flat(MESSAGES["en-US"]).sort();
    expect(zh.length).toBeGreaterThan(100);
    expect(zh).toEqual(en);
  });

  it("插值按 {name} 替换，未提供的占位符原样保留", () => {
    setLocale("zh-CN");
    expect(t("nthStation", { n: 7 })).toBe("第 7 站");
    expect(t("hintCoversShort", { from: 4, to: 6 })).toBe("→ 第 4~6 站");
    setLocale("en-US");
    expect(t("nthStation", { n: 7 })).toBe("Stop 7");
    setLocale("zh-CN");
  });

  it("找不到的键返回键名本身（而不是空串，便于一眼看出漏词条）", () => {
    expect(t("noSuchKey")).toBe("noSuchKey");
  });

  it("手机端新增的导出/导入词条在两种语言里都有", () => {
    for (const key of ["export", "exportTitle", "import", "importApply", "importBadJson", "importBadKind", "importOk", "importBadShape", "importPlaceholder", "exportCopy", "importPick", "stripTitle", "close"]) {
      expect(typeof MESSAGES["zh-CN"][key], `zh ${key}`).toBe("string");
      expect(typeof MESSAGES["en-US"][key], `en ${key}`).toBe("string");
    }
  });
});

describe("站号口径（手机端不许自己算 +1）", () => {
  it("始发站是第 1 站，之后依次 2…16", () => {
    expect(isOrigin(0)).toBe(true);
    expect(stationName(0)).toBe("第 1 站");
    for (let i = 1; i < STATION_COUNT; i += 1) {
      expect(isOrigin(i)).toBe(false);
      expect(stationName(i)).toBe(`第 ${i + 1} 站`);
    }
  });
});

describe("提示覆盖范围", () => {
  it("下标 i 的提示覆盖 i+1 ~ i+3（站号 = 下标 + 1）", () => {
    expect(hintCoversShort(0)).toBe("→ 第 2~4 站");
    expect(hintCoversShort(3)).toBe("→ 第 5~7 站");
  });

  it("提示窗口随剩余站数收窄：第 14 站 → 15~16、第 15 站 → 16，终点站没有提示", () => {
    expect(hintCoversShort(11)).toBe("→ 第 13~15 站");
    expect(hintCoversShort(12)).toBe("→ 第 14~16 站");
    expect(hintCoversShort(13)).toBe("→ 第 15~16 站");
    // 只剩 1 站时用单站说法，不是「第 16~16 站」
    expect(hintCoversShort(14)).toBe("→ 第 16 站");
    expect(hintCoversShort(15)).toBe("");
  });
});

describe("16 格记录条", () => {
  it("开局：全空、写站号占位、首格是「始」", () => {
    const state = blank();
    const result = solve(state);
    const first = stripCellView(result, state.observed, state.hints, 0, 0);
    expect(first.text).toBe("始");
    expect(first.classes).toContain("st-empty");
    expect(first.classes).toContain("current");
    const second = stripCellView(result, state.observed, state.hints, 1, 0);
    expect(second.text).toBe("2");
    const last = stripCellView(result, state.observed, state.hints, 15, 0);
    expect(last.text).toBe("16");
    expect(last.classes).toContain("end");
  });

  it("已录入的站：格子写结果字（不是站号），状态走记录档位而非类型色", () => {
    const state = blank();
    state.observed[1] = 1; // 食铺
    const result = solve(state);
    const cell = stripCellView(result, state.observed, state.hints, 1, 0);
    expect(cell.text).toBe("食");
    expect(cell.kind).toBe("record");
    // 只记了类型（提示未记）= half；类型不再各染一色
    expect(cell.classes).toContain("st-half");
    expect(cell.classes.some((c) => c.startsWith("t-"))).toBe(false);
  });

  it("只记了一半的站标 half，记全的标 done", () => {
    const state = blank();
    state.observed[1] = 0; // 只记类型，提示还没记
    let result = solve(state);
    expect(stripCellView(result, state.observed, state.hints, 1, 0).classes).toContain("st-half");
    state.hints[1] = HINT_SAME;
    result = solve(state);
    expect(stripCellView(result, state.observed, state.hints, 1, 0).classes).toContain("st-done");
  });

  it("始发站只记提示就算记全——它没有类型", () => {
    const state = blank();
    state.hints[0] = hintMax(0);
    const result = solve(state);
    expect(stripCellView(result, state.observed, state.hints, 0, 0).classes).toContain("st-done");
  });

  it("推断锁定但未录入的站：写推断结果字 + 虚框（pred）", () => {
    // 第 1 站提示「酒庄最多」+ 第 2、3 站都是酒庄 → 第 4 站仍未知，构造一个必锁定的局面：
    // 用「各站数量相同」+ 已知两站来逼出第三站的唯一解
    const state = blank();
    state.hints[2] = HINT_SAME; // 覆盖第 3、4、5 站
    state.observed[3] = 0;
    state.observed[4] = 1;
    // 第 5 站必然只剩商行（三类各 1 个）
    const result = solve(state);
    expect(result.consistent).toBe(true);
    expect(result.locked[5]).toBe(true);
    const cell = stripCellView(result, state.observed, state.hints, 5, 0);
    expect(cell.kind).toBe("predict");
    expect(cell.text).toBe("商");
    expect(cell.classes).toContain("pred");
  });
});

describe("结论块", () => {
  it("开局：下一站是第 1 站、待定、三根占比条", () => {
    const result = solve(blank());
    const hero = heroView(result);
    expect(hero.kind).toBe("open");
    expect(hero.index).toBe(1);
    expect(hero.badge).toBe("待定");
    expect(hero.bars.map((b) => b.ti).sort()).toEqual([0, 1, 2]);
  });

  it("占比条按概率降序——扫一眼先看第一根", () => {
    const state = blank();
    state.hints[0] = hintMax(0); // 第 1~3 站里酒庄至少 2 个
    const hero = heroView(solve(state));
    expect(hero.kind).toBe("open");
    const ratios = hero.bars.map((b) => b.ratio);
    expect([...ratios].sort((a, b) => b - a)).toEqual(ratios);
  });

  it("唯一确定时收敛成一根 100% 满条，并标「已确定」", () => {
    const state = blank();
    state.hints[0] = HINT_SAME; // 第 1~3 站各 1 个
    state.observed[1] = 0;
    state.observed[2] = 1;
    // 第 3 站必然只剩商行
    const result = solve(state);
    expect(result.locked[3]).toBe(true);
    // 光标推进到第 3 站时结论块应该锁定
    const hero = heroView(result);
    expect(hero.index).toBe(3);
    expect(hero.kind).toBe("certain");
    expect(hero.badge).toBe("已确定");
    expect(hero.bars).toEqual([{ ti: 2, ratio: 1, locked: true }]);
  });

  it("记录自相矛盾时给冲突结论并指名可疑条目", () => {
    const state = blank();
    state.hints[0] = HINT_SAME;
    state.observed[1] = 0;
    state.observed[2] = 0;
    state.observed[3] = 0; // 三站同类型，与「各站数量相同」冲突
    const hero = heroView(solve(state));
    expect(hero.kind).toBe("conflict");
    expect(hero.note).toContain("矛盾条目");
  });

  it("16 站全确认后给「全程已确认」", () => {
    const state = blank();
    // 全线酒庄 + 每站都记「酒庄最多」：提示与录入自洽，且覆盖到最后一个提示位
    for (let i = 1; i < STATION_COUNT; i += 1) state.observed[i] = 0;
    for (let i = 0; i <= STATION_COUNT - 2; i += 1) state.hints[i] = hintMax(0);
    const hero = heroView(solve(state));
    expect(hero.kind).toBe("done");
  });
});

describe("进度与漏提示", () => {
  it("进度按「需类型的 15 站」算，始发站不计入", () => {
    const state = blank();
    expect(typedCount(state.observed)).toBe(0);
    expect(progressPct(state.observed)).toBe("0%");
    state.observed[1] = 0;
    state.observed[2] = 1;
    state.observed[3] = 2;
    expect(typedCount(state.observed)).toBe(3);
    expect(progressPct(state.observed)).toBe("20%");
  });

  it("漏提示只统计光标之前的站", () => {
    const state = blank();
    state.hints[1] = HINT_SAME; // 第 1 站记了，第 0、2 站没记
    expect(missingHints(state.observed, state.hints, 3)).toBe(2);
    expect(missingHints(state.observed, state.hints, 0)).toBe(0);
    expect(missingHints(state.observed, state.hints, 1)).toBe(1);
    expect(missingHints(state.observed, state.hints, 2)).toBe(1);
  });

  it("只有终点站不参与漏提示统计（它后面没有站）", () => {
    const state = blank();
    // 提示位是始发站 + 第 1~14 站，共 15 个；终点站没有提示
    expect(missingHints(state.observed, state.hints, STATION_COUNT)).toBe(STATION_COUNT - 1);
  });

  it("allRecorded 要求类型与提示都记全", () => {
    const state = blank();
    for (let i = 1; i < STATION_COUNT; i += 1) state.observed[i] = 0;
    expect(allRecorded(state.observed, state.hints)).toBe(false); // 提示一条没记
    for (let i = 0; i <= STATION_COUNT - 2; i += 1) state.hints[i] = HINT_SAME;
    expect(allRecorded(state.observed, state.hints)).toBe(true);
  });
});

describe("建议与一句话结论", () => {
  it("手机端折叠掉两条通用节奏建议", () => {
    const { items, folded } = hudAdvice(solve(blank()));
    expect(folded.map((i) => i.key).sort()).toEqual(["backToBack", "rhythm"]);
    expect(items.some((i) => i.key === "backToBack")).toBe(false);
    expect(items.some((i) => i.key === "rhythm")).toBe(false);
  });

  it("开局给「始发站只记提示」这条实操建议", () => {
    const { items } = hudAdvice(solve(blank()));
    expect(items[0].key).toBe("origin");
    expect(items[0].title).toContain("始发站");
  });

  it("建议三段结构：标题必有，动作/明细按需", () => {
    const { items } = hudAdvice(solve(blank()));
    for (const item of items) {
      expect(item.title.length, item.key).toBeGreaterThan(0);
      expect(item.title).not.toContain("adv.");
    }
  });

  it("一句话结论包含站名与候选类型，供复制到另一台设备", () => {
    const state = blank();
    const text = summaryText(solve(state), state.observed, state.hints);
    expect(text).toContain("铁路大亨");
    // 首个未确认站是下标 1 = 第 2 站
    expect(text).toContain("第 2 站");
  });
});

describe("推断自动填入", () => {
  it("锁定站给出唯一类型；未锁定 / 记录冲突时返回 null", () => {
    // 始发站提示「酒庄最多」覆盖第 1~3 站，第 1 站已确认食铺 → 第 2、3 站锁定酒庄
    const state = blank();
    state.observed[1] = 1;
    state.hints[0] = hintMax(0);
    const result = solve(state);
    expect(lockedTypeAt(result, 2)).toBe(0);
    expect(lockedTypeAt(result, 3)).toBe(0);
    // 第 4 站不受这条提示约束，仍是三选一
    expect(lockedTypeAt(result, 4)).toBeNull();

    // 记录冲突时不自动填任何类型（解空间为空）
    const bad = blank();
    bad.hints[0] = HINT_SAME;
    bad.observed[1] = 0;
    bad.observed[2] = 0;
    bad.observed[3] = 0;
    expect(lockedTypeAt(solve(bad), 4)).toBeNull();
  });
});

describe("后续站点预览", () => {
  it("最多往后看 3 站，且跳过已确认的站", () => {
    const state = blank();
    state.observed[1] = 0;
    const list = upcoming(solve(state));
    expect(list.map((x) => x.index)).toEqual([2, 3, 4]);
  });

  it("全确认后没有后续站", () => {
    const state = blank();
    for (let i = 1; i < STATION_COUNT; i += 1) state.observed[i] = i % 3;
    expect(upcoming(solve(state))).toEqual([]);
  });
});

describe("提示文案反查", () => {
  it("按值反查「X 最多」/「数量相同」，不去解析编码", () => {
    expect(hintText(HINT_SAME)).toBe("数量相同");
    expect(hintText(hintMax(0))).toBe("酒庄最多");
    expect(hintText(hintMax(2))).toBe("商行最多");
    expect(hintText(null)).toBe("");
    expect(hintText("max9")).toBe("");
  });

  it("三个类型键的顺序与 railTycoon.js 一致", () => {
    expect(TYPE_KEYS).toEqual(["winery", "eatery", "trade"]);
  });
});
