// 铁路大亨站点推断单测：约束求解器的黄金样本回归。
// 样本取自公测期玩家实测攻略里可手推的关卡，手推结论即断言目标。
import { describe, expect, it } from "vitest";
import {
  ADVICE_KEYS,
  buildAdvice,
  canHintAt,
  CELL_LABEL,
  CELL_PREDICT,
  CELL_RECORD,
  checkHint,
  diagnoseConflict,
  firstIncomplete,
  hintMax,
  hintMaxIndex,
  HINT_SAME,
  isStationComplete,
  nextIncompleteAfter,
  normalizeHint,
  normalizeType,
  ORIGIN_INDEX,
  RECORD_DONE,
  RECORD_EMPTY,
  RECORD_HALF,
  solveRailRoute,
  stationNumber,
  stationRecordState,
  stripCellContent,
  STATION_COUNT,
  TYPE_KEYS,
} from "./railTycoon.js";

const WINERY = 0;
const EATERY = 1;
const TRADE = 2;

/** 造一个指定长度的空录入数组。 */
const blank = (n = STATION_COUNT) => new Array(n).fill(null);

/** 在空数组上打点：patch({ 1: EATERY }) → 只有下标 1 有值。 */
function patch(map, n = STATION_COUNT) {
  const out = blank(n);
  for (const [i, v] of Object.entries(map)) out[Number(i)] = v;
  return out;
}

describe("提示语义", () => {
  it("「X 最多」= 之后 3 站里 X 至少出现 2 次", () => {
    expect(checkHint(hintMax(WINERY), [WINERY, WINERY, TRADE])).toBe(true);
    expect(checkHint(hintMax(WINERY), [WINERY, WINERY, WINERY])).toBe(true);
    // 只出现 1 次不算「最多」——这是最常见的录入误解
    expect(checkHint(hintMax(WINERY), [WINERY, EATERY, TRADE])).toBe(false);
    expect(checkHint(hintMax(WINERY), [EATERY, TRADE, WINERY])).toBe(false);
  });

  it("「各站点数量相同」= 之后 3 站三类各 1 个", () => {
    expect(checkHint(HINT_SAME, [WINERY, EATERY, TRADE])).toBe(true);
    expect(checkHint(HINT_SAME, [TRADE, WINERY, EATERY])).toBe(true);
    expect(checkHint(HINT_SAME, [WINERY, WINERY, TRADE])).toBe(false);
  });

  it("未记录提示与含未知位置的窗口都不构成约束", () => {
    expect(checkHint(null, [WINERY, WINERY, WINERY])).toBe(true);
    expect(checkHint(hintMax(WINERY), [EATERY, EATERY, null])).toBe(true);
  });

  it("始发站也有提示；只有末尾 3 站凑不满 3 站、没有提示", () => {
    // 始发站的提示覆盖第 1~3 站，所以它是可录的
    expect(canHintAt(ORIGIN_INDEX)).toBe(true);
    expect(canHintAt(1)).toBe(true);
    expect(hintMaxIndex()).toBe(12);
    expect(canHintAt(12)).toBe(true);
    // 第 13~15 站之后剩不下 3 站
    expect(canHintAt(13)).toBe(false);
    expect(canHintAt(STATION_COUNT - 1)).toBe(false);
  });

  it("始发站的提示覆盖第 1~3 站，参与推算", () => {
    const r = solveRailRoute({ hints: patch({ [ORIGIN_INDEX]: hintMax(WINERY) }) });
    // 第 1~3 站里至少 2 个酒庄：3^3 − (0 个: 2^3) − (1 个: 3×2^2) = 7 种；第 4~15 站自由
    expect(r.total).toBe(7 * 3 ** (STATION_COUNT - 4));
    expect(r.total).toBeLessThan(3 ** STATION_COUNT);
    // 始发站不被任何提示覆盖，而且它没有类型——候选集恒为空，永远不参与推断
    expect(r.possibleTypes[ORIGIN_INDEX]).toEqual([]);
    expect(r.ratio[ORIGIN_INDEX]).toEqual([0, 0, 0]);
  });

  it("始发站没有类型：录入里给它填了值也一律忽略", () => {
    const plain = solveRailRoute({});
    const withOriginType = solveRailRoute({ observed: patch({ [ORIGIN_INDEX]: WINERY }) });
    expect(withOriginType.total).toBe(plain.total);
    expect(withOriginType.nextIndex).toBe(1);
    expect(withOriginType.known[ORIGIN_INDEX]).toBe(false);
    expect(withOriginType.possibleTypes[ORIGIN_INDEX]).toEqual([]);
  });

  it("始发站提示酒庄最多 + 第 1 站食铺 → 第 2、3 站必定酒庄", () => {
    const r = solveRailRoute({
      observed: patch({ 1: EATERY }),
      hints: patch({ [ORIGIN_INDEX]: hintMax(WINERY) }),
    });
    expect(r.consistent).toBe(true);
    expect(r.possibleTypes[2]).toEqual([WINERY]);
    expect(r.possibleTypes[3]).toEqual([WINERY]);
    expect(r.locked[2]).toBe(true);
    expect(r.locked[3]).toBe(true);
    // 始发站的提示不覆盖第 4 站，那里重新变得不确定
    expect(r.possibleTypes[4]).toEqual([WINERY, EATERY, TRADE]);
  });

  it("站号 = 数组下标（始发站不编号），不是下标 + 1", () => {
    expect(stationNumber(ORIGIN_INDEX)).toBeNull();
    expect(stationNumber(1)).toBe(1);
    expect(stationNumber(15)).toBe(15);
    expect(stationNumber(null)).toBeNull();
    expect(stationNumber(undefined)).toBeNull();
  });

  it("归一化会丢弃无法识别的值，不静默产生错误约束", () => {
    expect(normalizeHint("max0")).toBe("max0");
    expect(normalizeHint(HINT_SAME)).toBe(HINT_SAME);
    expect(normalizeHint("max9")).toBe(null);
    expect(normalizeHint("最多")).toBe(null);
    expect(normalizeHint("")).toBe(null);
    expect(normalizeType("1")).toBe(1);
    expect(normalizeType(3)).toBe(null);
    expect(normalizeType(-1)).toBe(null);
  });
});

describe("求解：空输入", () => {
  it("无任何限制时等于 3^15 —— 始发站没有类型，参与枚举的只有第 1~15 站", () => {
    const r = solveRailRoute({ observed: blank(), hints: blank() });
    expect(r.total).toBe(3 ** (STATION_COUNT - 1));
    expect(r.consistent).toBe(true);
    // 始发站不参与：无候选、无计数
    expect(r.possibleTypes[ORIGIN_INDEX]).toEqual([]);
    expect(r.counts[ORIGIN_INDEX]).toEqual([0, 0, 0]);
    // 其余每站三类等概率
    for (let p = 1; p < STATION_COUNT; p++) {
      expect(r.possibleTypes[p]).toEqual([0, 1, 2]);
      expect(r.counts[p][0]).toBe(r.total / 3);
    }
    expect(r.nextIndex).toBe(1);
    expect(r.nextLocked).toBe(false);
  });

  it("题面数组缺省或过短也能求解", () => {
    expect(solveRailRoute().total).toBe(3 ** (STATION_COUNT - 1));
    const r = solveRailRoute({ observed: patch({ 1: WINERY }) });
    expect(r.total).toBe(3 ** (STATION_COUNT - 2));
    expect(r.counts[1]).toEqual([r.total, 0, 0]);
    // 始发站没有类型：不管录什么，它的计数恒为 0
    expect(solveRailRoute({ observed: patch({ [ORIGIN_INDEX]: WINERY }) }).counts[ORIGIN_INDEX]).toEqual([0, 0, 0]);
  });
});

describe("求解：单条提示锁定站点", () => {
  // 攻略原文样本：第 1 站提示「酒庄最多」，走到第 2 站是食铺 → 第 3、4 站必定都是酒庄
  it("第 1 站提示酒庄最多 + 第 2 站食铺 → 第 3、4 站必定酒庄", () => {
    const r = solveRailRoute({
      observed: patch({ 2: EATERY }),
      hints: patch({ 1: hintMax(WINERY) }),
    });
    expect(r.consistent).toBe(true);
    expect(r.possibleTypes[3]).toEqual([WINERY]);
    expect(r.possibleTypes[4]).toEqual([WINERY]);
    expect(r.locked[3]).toBe(true);
    expect(r.locked[4]).toBe(true);
    // 提示不覆盖第 5 站，那里应重新变得不确定
    expect(r.possibleTypes[5]).toEqual([WINERY, EATERY, TRADE]);
  });

  it("提示「各站数量相同」+ 已知两类 → 第 3 类被锁死", () => {
    const r = solveRailRoute({
      observed: patch({ 2: WINERY, 3: EATERY }),
      hints: patch({ 1: HINT_SAME }),
    });
    expect(r.consistent).toBe(true);
    expect(r.possibleTypes[4]).toEqual([TRADE]);
    expect(r.locked[4]).toBe(true);
  });

  it("第 1 站的提示对紧随其后的第 2 站几乎无参考价值", () => {
    const r = solveRailRoute({ hints: patch({ 1: hintMax(WINERY) }) });
    // 第 2 站（下标 2）仍可能是三类中任意一类
    expect(r.possibleTypes[2]).toEqual([WINERY, EATERY, TRADE]);
    // 第 1 站（下标 1）只有始发站记了提示才会被约束，这里没记；
    // 始发站（下标 0）则永远不被覆盖，而且它没有类型——候选集恒为空
    expect(r.possibleTypes[1]).toEqual([WINERY, EATERY, TRADE]);
    expect(r.possibleTypes[ORIGIN_INDEX]).toEqual([]);
  });
});

describe("求解：合法性与计数一致性", () => {
  it("提示与已确认站点冲突时报不一致，而不是硬给答案", () => {
    // 「各站数量相同」要求三类各 1 个，但窗口内已出现两个酒庄
    const r = solveRailRoute({
      observed: patch({ 2: WINERY, 3: WINERY }),
      hints: patch({ 1: HINT_SAME }),
    });
    expect(r.consistent).toBe(false);
    expect(r.total).toBe(0);
    expect(r.possibleTypes.every((list) => list.length === 0)).toBe(true);
    expect(r.ratio.every((row) => row.every((v) => v === 0))).toBe(true);
  });

  it("超出可录入范围的提示被忽略", () => {
    const n = STATION_COUNT;
    const observed = patch({ 14: WINERY, 15: WINERY }, n);
    // 下标 13（第 13 站）的提示要覆盖其后 3 站，但全程只剩第 14、15 站，凑不满 3 站，应被忽略
    const ignored = solveRailRoute({ observed, hints: patch({ 13: HINT_SAME }, n) });
    expect(ignored.consistent).toBe(true);
    // 已确认第 14、15 站 + 始发站没有类型 ⇒ 自由站为第 1~13 站
    expect(ignored.total).toBe(3 ** (n - 3));
  });

  it("每站各类型计数之和恒等于合法排列总数（始发站无类型，计 0）", () => {
    const r = solveRailRoute({
      observed: patch({ 1: EATERY, 5: TRADE }),
      hints: patch({ 2: hintMax(WINERY), 3: HINT_SAME, 4: hintMax(TRADE) }),
    });
    expect(r.consistent).toBe(true);
    expect(r.counts).toHaveLength(STATION_COUNT);
    expect(r.counts[ORIGIN_INDEX]).toEqual([0, 0, 0]);
    for (let i = 1; i < STATION_COUNT; i += 1) {
      expect(r.counts[i].reduce((a, b) => a + b, 0)).toBe(r.total);
    }
  });

  it("全站录入后只剩一种排列", () => {
    const observed = Array.from({ length: STATION_COUNT }, (_, i) => i % TYPE_KEYS.length);
    const r = solveRailRoute({ observed });
    expect(r.total).toBe(1);
    // 始发站没有类型，它不在「已锁定的站」之列
    for (let i = 1; i < STATION_COUNT; i += 1) expect(r.locked[i]).toBe(true);
    expect(r.locked[ORIGIN_INDEX]).toBe(false);
    expect(r.nextIndex).toBe(-1);
  });
});

describe("策略卡建议", () => {
  it("记录矛盾时优先提示修正录入", () => {
    const r = solveRailRoute({
      observed: patch({ 2: WINERY, 3: WINERY }),
      hints: patch({ 1: HINT_SAME }),
    });
    const advice = buildAdvice(r);
    expect(advice).toHaveLength(1);
    expect(advice[0]).toMatchObject({ key: "conflict", tone: "danger" });
  });

  it("下一站锁死时给出确定性建议", () => {
    const r = solveRailRoute({
      observed: patch({ 0: TRADE, 1: TRADE, 2: EATERY }),
      hints: patch({ 1: hintMax(WINERY) }),
    });
    expect(r.nextIndex).toBe(3);
    expect(r.nextLocked).toBe(true);
    const advice = buildAdvice(r);
    expect(advice[0]).toMatchObject({ key: "certain", typeIndex: WINERY, tone: "success" });
  });

  it("连续两站同类型时警告不要选「下一站售价提升」", () => {
    // 第 1 站的提示覆盖第 2~4 站；第 2 站食铺、第 3 站酒庄 → 第 4 站必为酒庄，与第 3 站同类型
    const r = solveRailRoute({
      observed: patch({ 0: TRADE, 1: TRADE, 2: EATERY, 3: WINERY }),
      hints: patch({ 1: hintMax(WINERY) }),
    });
    expect(r.nextIndex).toBe(4);
    expect(r.nextTypes).toEqual([WINERY]);
    const advice = buildAdvice(r);
    expect(advice.map((a) => a.key)).toContain("dontBoostSame");
    expect(advice.find((a) => a.key === "dontBoostSame")).toMatchObject({
      typeIndex: WINERY,
      tone: "warn",
    });
  });

  it("下一站不确定时给通用卡建议，开局几站额外提示不必纠结", () => {
    const r = solveRailRoute({
      observed: patch({ [ORIGIN_INDEX]: TRADE }),
      hints: patch({ 1: hintMax(WINERY) }),
    });
    const advice = buildAdvice(r);
    expect(advice[0]).toMatchObject({ key: "uncertain", tone: "info" });
    expect(advice.map((a) => a.key)).toContain("earlyGame");
    expect(advice.map((a) => a.key)).toContain("rhythm");
    expect(advice.map((a) => a.key)).not.toContain("dontBoostSame");
  });

  it("开局（一条都没录）给「始发站要记什么」的实操提示，而不是笼统说不确定", () => {
    const r = solveRailRoute({});
    // 始发站没有类型要填，所以「下一个待确认的站」是第 1 站
    expect(r.nextIndex).toBe(1);
    const advice = buildAdvice(r);
    expect(advice[0]).toMatchObject({ key: "origin", typeIndex: null, tone: "info" });
    expect(advice.map((a) => a.key)).not.toContain("uncertain");
  });

  it("始发站提示记下后就不再占建议位，回到正常的「不确定」建议", () => {
    const r = solveRailRoute({ hints: patch({ [ORIGIN_INDEX]: hintMax(EATERY) }) });
    const advice = buildAdvice(r);
    expect(advice.map((a) => a.key)).not.toContain("origin");
    expect(advice[0]).toMatchObject({ key: "uncertain" });
  });

  it("尾段（剩余不足 3 站）提示改用金博弈卡冲分", () => {
    const observed = Array.from({ length: 13 }, () => WINERY);
    const r = solveRailRoute({ observed: [...observed, null, null, null] });
    expect(r.nextIndex).toBe(13);
    const advice = buildAdvice(r);
    expect(advice.map((a) => a.key)).toContain("tail");
  });

  it("全程确认后不再给卡牌建议", () => {
    const r = solveRailRoute({ observed: Array.from({ length: STATION_COUNT }, () => WINERY) });
    expect(buildAdvice(r)).toEqual([{ key: "allKnown", typeIndex: null, tone: "info" }]);
  });

  it("建议条目只使用已登记的 i18n 键", () => {
    const allowed = new Set(ADVICE_KEYS);
    const cases = [
      solveRailRoute({}),
      solveRailRoute({ observed: patch({ 2: WINERY, 3: WINERY }), hints: patch({ 1: HINT_SAME }) }),
      solveRailRoute({ observed: patch({ 1: TRADE, 2: EATERY, 3: WINERY }), hints: patch({ 1: hintMax(0) }) }),
      solveRailRoute({ observed: Array.from({ length: STATION_COUNT }, () => TRADE) }),
    ];
    for (const r of cases) {
      for (const item of buildAdvice(r)) expect(allowed.has(item.key), item.key).toBe(true);
    }
  });
});

describe("站点数可配置", () => {
  it("支持非 16 站的关卡长度", () => {
    const n = 8;
    const r = solveRailRoute({ hints: patch({ 1: hintMax(WINERY) }, n), stationCount: n });
    expect(r.consistent).toBe(true);
    expect(r.counts).toHaveLength(n);
    // 第 1 站的提示覆盖第 2~4 站：这 3 站里至少 2 个酒庄，合法组合为 3^3 - (0 个: 2^3 + 1 个: 3×2^2) = 7 种；
    // 始发站没有类型，剩下第 1、5、6、7 站自由
    expect(r.total).toBe(7 * 3 ** (n - 4));
    // 提示只约束它之后的那 3 站：始发站没有类型，第 1 站仍是任意类型
    expect(r.possibleTypes[ORIGIN_INDEX]).toEqual([]);
    expect(r.possibleTypes[1]).toEqual([WINERY, EATERY, TRADE]);
  });

  it("不足 3 站的关卡退化为无约束", () => {
    const r = solveRailRoute({ stationCount: 2 });
    expect(r.total).toBe(3 ** (2 - 1));
    expect(r.counts).toHaveLength(2);
  });
});

// 录入进度：界面靠这组判定决定「记完一站自动前进」的时机。
// 关键点——只填类型不算记完：提示才是推断的信息源，跳过它就白录了。
describe("录入完整性", () => {
  it("始发站没有类型：只记提示就记全，没记提示就没记全", () => {
    expect(isStationComplete(blank(), blank(), ORIGIN_INDEX)).toBe(false);
    expect(isStationComplete(blank(), patch({ [ORIGIN_INDEX]: hintMax(WINERY) }), ORIGIN_INDEX)).toBe(true);
    // 就算录入里残留了「始发站的类型」，也不算它记全——它没有类型这回事
    expect(isStationComplete(patch({ [ORIGIN_INDEX]: WINERY }), blank(), ORIGIN_INDEX)).toBe(false);
  });

  it("第 1 站起只填类型、没填提示 → 不算记完", () => {
    const obs = patch({ 1: WINERY });
    expect(isStationComplete(obs, blank(), 1)).toBe(false);
  });

  it("类型 + 提示都填了 → 记完", () => {
    const obs = patch({ 1: WINERY });
    expect(isStationComplete(obs, patch({ 1: hintMax(TRADE) }), 1)).toBe(true);
    expect(isStationComplete(obs, patch({ 1: HINT_SAME }), 1)).toBe(true);
  });

  it("末尾 3 站没有提示可记，填了类型就算记完", () => {
    expect(canHintAt(13)).toBe(false);
    expect(canHintAt(15)).toBe(false);
    const obs = patch({ 13: TRADE });
    expect(isStationComplete(obs, blank(), 13)).toBe(true);
    expect(isStationComplete(obs, blank(), 12)).toBe(false); // 第 12 站仍有提示
  });

  it("提示填了但类型没填 → 不算记完", () => {
    expect(isStationComplete(blank(), patch({ 1: hintMax(WINERY) }), 1)).toBe(false);
  });

  it("越界下标一律视为未记完", () => {
    const obs = patch({ 1: WINERY });
    const hnt = patch({ 1: hintMax(WINERY) });
    expect(isStationComplete(obs, hnt, -1)).toBe(false);
    expect(isStationComplete(obs, hnt, STATION_COUNT)).toBe(false);
  });

  it("firstIncomplete 找第一个没记全的站，全记完返回 -1", () => {
    // 始发站与第 1 站记全，第 2 站只有类型
    const obs = patch({ 0: WINERY, 1: EATERY, 2: TRADE });
    const hnt = patch({ 0: hintMax(WINERY), 1: HINT_SAME });
    expect(firstIncomplete(obs, hnt)).toBe(2);
    expect(firstIncomplete(blank(), blank())).toBe(0);

    const fullObs = Array.from({ length: STATION_COUNT }, () => TRADE);
    const fullHnt = Array.from({ length: STATION_COUNT }, (_, i) =>
      canHintAt(i) ? hintMax(TRADE) : null,
    );
    expect(firstIncomplete(fullObs, fullHnt)).toBe(-1);
    // 只填满类型、提示全空 —— 始发站也要提示，所以第一个没记完的站就是始发站
    expect(firstIncomplete(fullObs, blank())).toBe(0);
  });

  it("nextIncompleteAfter 跳过已记全的站，找不到返回 -1", () => {
    const obs = patch({ 0: WINERY, 1: EATERY, 2: TRADE });
    const hnt = patch({ 0: hintMax(WINERY), 1: HINT_SAME, 2: hintMax(TRADE) });
    expect(nextIncompleteAfter(obs, hnt, 0)).toBe(3);
    expect(nextIncompleteAfter(obs, hnt, 1)).toBe(3);
    // 从末尾往后再找没有站
    expect(nextIncompleteAfter(obs, hnt, STATION_COUNT - 1)).toBe(-1);
  });

  it("「只填类型就跳下一站」会漏掉提示——本用例锁住这个回归", () => {
    const obs = patch({ 2: WINERY });
    const hnt = blank();
    // 场景：回到第 3 站补录。只点了类型的瞬间，第 3 站还没记完
    expect(isStationComplete(obs, hnt, 2)).toBe(false);
    expect(nextIncompleteAfter(obs, hnt, 2)).toBe(3);
    // 补上提示后才算记完，此时才允许前进
    hnt[2] = hintMax(WINERY);
    expect(isStationComplete(obs, hnt, 2)).toBe(true);
  });
});

// 驾驶舱顶栏那 16 个方格的取色依据。它回答「我记到哪了」，
// 所以三档只跟**记录**有关，不掺推断（推断是右边那张卡的事）。
describe("记录进度条的三档状态", () => {
  it("一个字段都没填 = empty", () => {
    expect(stationRecordState(blank(), blank(), 0)).toBe(RECORD_EMPTY);
    expect(stationRecordState(blank(), blank(), 1)).toBe(RECORD_EMPTY);
    expect(stationRecordState(blank(), blank(), 12)).toBe(RECORD_EMPTY);
  });

  it("只填类型 / 只填提示 = half", () => {
    expect(stationRecordState(patch({ 3: WINERY }), blank(), 3)).toBe(RECORD_HALF);
    expect(stationRecordState(blank(), patch({ 3: hintMax(WINERY) }), 3)).toBe(RECORD_HALF);
  });

  it("类型和提示都填了 = done", () => {
    expect(stationRecordState(patch({ 3: WINERY }), patch({ 3: hintMax(WINERY) }), 3)).toBe(
      RECORD_DONE,
    );
  });

  it("末尾第 13~15 站没有提示可记，只填类型就算 done", () => {
    const last = STATION_COUNT - 1;
    expect(canHintAt(last)).toBe(false);
    expect(stationRecordState(patch({ [last]: TRADE }), blank(), last)).toBe(RECORD_DONE);
    expect(stationRecordState(blank(), blank(), last)).toBe(RECORD_EMPTY);
  });

  it("始发站没有类型：只记了提示就算 done，而不是 half", () => {
    // 这是三档判据最容易写错的一处——按「字段数」算会把它判成 half
    expect(stationRecordState(blank(), patch({ 0: hintMax(EATERY) }), 0)).toBe(RECORD_DONE);
    expect(stationRecordState(blank(), blank(), 0)).toBe(RECORD_EMPTY);
    // 老存档里若给始发站留过类型值，那也不是「它记了一半」——始发站只有提示这一个字段，
    // 提示空着就是还没记（界面本来就不给它类型下拉，这个值进不来）
    expect(stationRecordState(patch({ 0: WINERY }), blank(), 0)).toBe(RECORD_EMPTY);
  });

  it("下标越界返回 empty，不抛错", () => {
    expect(stationRecordState(blank(), blank(), -1)).toBe(RECORD_EMPTY);
    expect(stationRecordState(blank(), blank(), STATION_COUNT)).toBe(RECORD_EMPTY);
  });

  it("done 与 isStationComplete 永远同进同出（只有一个真源）", () => {
    const obs = patch({ 0: null, 1: WINERY, 2: EATERY, 3: TRADE, 14: WINERY });
    const hnt = patch({ 0: HINT_SAME, 1: hintMax(WINERY), 2: HINT_SAME, 3: null });
    for (let i = 0; i < STATION_COUNT; i += 1) {
      const done = stationRecordState(obs, hnt, i) === RECORD_DONE;
      expect(done, `下标 ${i}`).toBe(isStationComplete(obs, hnt, i));
    }
  });
});

describe("记录条格子写什么字", () => {
  it("已录入的类型永远最优先（录的是亲眼所见，压过推断）", () => {
    const c = stripCellContent(EATERY, WINERY);
    expect(c.kind).toBe(CELL_RECORD);
    expect(c.typeIndex).toBe(EATERY);
  });

  it("没录入但推断已唯一确定 → predict，视图层用虚框区分", () => {
    const c = stripCellContent(null, TRADE);
    expect(c.kind).toBe(CELL_PREDICT);
    expect(c.typeIndex).toBe(TRADE);
  });

  it("两者都没有 → 退回站号占位", () => {
    expect(stripCellContent(null, null)).toEqual({ kind: CELL_LABEL, typeIndex: null });
  });

  it("原值先归一：乱值不算录入、也不算推断", () => {
    // "9" 不是合法类型——旧存档里的脏值不能伪装成结果写进格子
    expect(stripCellContent("9", null).kind).toBe(CELL_LABEL);
    expect(stripCellContent(null, "x").kind).toBe(CELL_LABEL);
    // 字符串数字（select 的 value 一律是字符串）要能认出来
    expect(stripCellContent("2", null)).toEqual({ kind: CELL_RECORD, typeIndex: TRADE });
  });
});

// 提示到底覆盖哪 3 站，是整个模块最容易搞错的一条口径。用游戏内的实测样本钉住它。
describe("提示覆盖窗口", () => {
  it("下标 i 的提示覆盖 i+1 / i+2 / i+3，不含本站", () => {
    // 攻略原文样本：第 1 站提示酒庄最多 + 第 2 站食铺 → 第 3、4 站必定都是酒庄
    const r = solveRailRoute({
      observed: patch({ 2: EATERY }),
      hints: patch({ 1: hintMax(WINERY) }),
    });
    expect(r.possibleTypes[3]).toEqual([WINERY]);
    expect(r.possibleTypes[4]).toEqual([WINERY]);
    // 若窗口是「本站 + 后 2 站」= {1,2,3}，第 4 站根本不会被约束 —— 上面两条就是分水岭
    expect(r.locked[4]).toBe(true);
  });

  it("游戏内「站点提示记录」样本：第 3 站「数量相同」+ 第 4 站食铺 + 第 5 站商行 ⇒ 第 6 站必酒庄", () => {
    const r = solveRailRoute({
      observed: patch({ 3: TRADE, 4: EATERY, 5: TRADE }),
      hints: patch({ 3: HINT_SAME }),
    });
    // 窗口若是 {3,4,5} = {商行, 食铺, 商行}，这条提示会直接判为矛盾；只有窗口 {4,5,6} 才推得出第 6 站
    expect(r.consistent).toBe(true);
    expect(r.possibleTypes[6]).toEqual([WINERY]);
    expect(r.locked[6]).toBe(true);
  });
});

// 冲突诊断：把「记录冲突」这件事从「用户自己猜」变成「指名道姓」。
describe("冲突诊断", () => {
  it("指出去掉哪一条记录就自洽——用户在游戏里遇到的那一组录入", () => {
    // 实测录入：始发站提示食铺最多；第 1 站 食铺 + 提示食铺最多；第 2 站 食铺 + 提示食铺最多；
    // 第 3 站 酒庄 + 提示「各站点数量相同」。
    // 这组数据确实自相矛盾（工具标「记录冲突」是对的）：第 1、2 站的提示已经推出
    // 第 4、5 站都是食铺，而第 3 站的「数量相同」要求第 4~6 站三类各一个 —— 不可能同时成立。
    const input = {
      observed: patch({ 1: EATERY, 2: EATERY, 3: WINERY }),
      hints: patch({
        [ORIGIN_INDEX]: hintMax(EATERY),
        1: hintMax(EATERY),
        2: hintMax(EATERY),
        3: HINT_SAME,
      }),
    };
    const r = solveRailRoute(input);
    expect(r.consistent).toBe(false);

    const { culprits } = diagnoseConflict(r);
    // 删掉其中任意一条，其余记录就自洽：第 2 站的提示 / 第 3 站的提示 / 第 3 站的类型
    expect(culprits).toEqual([
      { kind: "hint", index: 2 },
      { kind: "hint", index: 3 },
      { kind: "type", index: 3 },
    ]);

    // 建议条目带上诊断结果，界面据此指名道姓
    const advice = buildAdvice(r);
    expect(advice).toHaveLength(1);
    expect(advice[0].key).toBe("conflict");
    expect(advice[0].culprits).toHaveLength(3);
  });

  it("自洽时不报可疑条目；单条直接矛盾时报出那几条", () => {
    const ok = solveRailRoute({ hints: patch({ 1: hintMax(WINERY) }), observed: patch({ 2: EATERY }) });
    expect(diagnoseConflict(ok).culprits).toEqual([]);

    // 「各站数量相同」要求三类各 1 个，但窗口内第 2、3 站都是酒庄
    const bad = solveRailRoute({
      observed: patch({ 2: WINERY, 3: WINERY }),
      hints: patch({ 1: HINT_SAME }),
    });
    expect(bad.consistent).toBe(false);
    const { culprits } = diagnoseConflict(bad);
    expect(culprits).toContainEqual({ kind: "hint", index: 1 });
    expect(culprits).toContainEqual({ kind: "type", index: 2 });
    expect(culprits).toContainEqual({ kind: "type", index: 3 });
  });
});
