// 铁路大亨 · 挑战线路站点推断（《诡秘之主》家园「列车贸易」玩法）。
// 纯逻辑模块：把每站的「未来 3 站」提示当作约束，穷举全部合法排列，算出每站的可取类型与锁死情况。
//
// 规则（来源：游戏内「站点提示记录」面板的实测日志 + 玩家实测攻略，非官方公示数据；
//       每周一全区刷新行情，具体以游戏内为准）：
//   - 全程 16 个节点 = 始发站 + 第 1~15 站；第 1~15 站的类型为 酒庄 / 食铺 / 商行 之一；
//   - **始发站没有类型**：它不是三类店铺中的任何一类，游戏也不给它记类型。界面在它那里
//     只显示「始发站」。所以本模块的类型枚举只覆盖第 1~15 站（见 ORIGIN_PLACEHOLDER）；
//   - 始发站是线路的第一个节点，按游戏口径**不算「第 1 站」**：它不参与「第 N 站」编号，
//     于是「第 N 站」正好落在下标 N 上（见 stationNumber）；
//   - 每个节点都有一条「未来 3 站」提示，覆盖它**之后**的 3 个节点：下标 i 的提示覆盖
//     下标 i+1 / i+2 / i+3。所以始发站的提示覆盖第 1~3 站；提示只向后看 3 站，
//     末尾 3 站（第 13~15 站）凑不满 3 站、没有提示可录（见 canHintAt）。
//     反过来，始发站自己永远不会被任何提示覆盖——没有哪条提示能回头指向下标 0；
//   - 提示「X 最多」= 那 3 站里 X 至少出现 2 次（只出现 1 次时可能与其它类型并列，故不算「最多」）；
//   - 提示「各站点数量相同」= 那 3 站三类各 1 个。
//
// 窗口口径的验证（这里最容易搞错，写下来备查）：游戏内「站点提示记录」面板的实测日志里
// 有一条「第 3 站=商行，该站提示=各站点数量相同；第 4 站=食铺；第 6 站=酒庄」，攻略据此
// 手推出「第 6 站必定是酒庄」。若窗口是「本站 + 后 2 站」，该提示覆盖 {3,4,5} =
// {商行, 食铺, 商行}，不可能「数量相同」；只有「之后 3 站」= {4,5,6} = {食铺, 商行, 酒庄}
// 才成立。攻略另一例「第 1 站提示酒庄最多，第 2 站是食铺 → 第 3、4 站必定都是酒庄」同理
// 只对「之后 3 站」成立（3 站里至少 2 个酒庄）。
//
// 实现：以「最近 3 站类型」为状态的 27 态 DP，前向 prefix × 后向 ways 计数，
//       避免 3^16（约 4304 万）种排列的暴力枚举。

/** 挑战线路默认节点数（含始发站）。 */
export const STATION_COUNT = 16;

/**
 * 始发站下标。线路的第一个节点，不参与「第 N 站」编号，也**没有类型**。
 *
 * 注意：它**同样有**「未来 3 站」提示（覆盖第 1~3 站），只是没有哪条提示能回头覆盖它。
 */
export const ORIGIN_INDEX = 0;

/**
 * 始发站在模型里的占位类型。
 *
 * 始发站不是三类店铺中的任何一类，所以它不该有候选类型、也不该计入任何占比。但 DP 的状态
 * 窗口要跨过下标 0，于是给它一个固定占位值：**它不会进入任何提示窗口**（提示窗口最早从
 * 下标 1 开始），因此这个值取什么都一样。计数区会把下标 0 清零（见 solveRailRoute）。
 */
const ORIGIN_PLACEHOLDER = 0;

/** 站点类型（与 i18n 的 toolbox.rail.type* 一一对应）。 */
export const TYPE_KEYS = ["winery", "eatery", "trade"];

/** 提示「各站点数量相同」。 */
export const HINT_SAME = "same";

/** 提示「X 最多」前缀，完整值形如 max0 / max1 / max2。 */
export const HINT_MAX_PREFIX = "max";

/** 最后一个还能录入提示的节点下标（0 基）。提示覆盖其后 3 站，故末尾 3 站无提示。 */
export function hintMaxIndex(stationCount = STATION_COUNT) {
  return stationCount - 4;
}

/**
 * 节点在游戏里的编号：始发站返回 null，其余返回「第 N 站」的 N（1 起）。
 *
 * 编号 = 数组下标，**不是下标 + 1**。这不是笔误：数组的第一个位置被始发站占了，
 * 而始发站按游戏口径不编号，于是「第 N 站」正好落在下标 N 上。
 * 编号只在这里算一次——改版前 `index + 1` 散落在 6 处，正是全线站号整体多算一站的根源。
 */
export function stationNumber(index) {
  return Number.isInteger(index) && index > ORIGIN_INDEX ? index : null;
}

/** 生成「X 最多」提示值。 */
export function hintMax(typeIndex) {
  return `${HINT_MAX_PREFIX}${typeIndex}`;
}

/**
 * 该节点是否可录入提示（提示需覆盖其后 3 站）。
 *
 * 始发站（下标 0）**可以**录提示；只有末尾 3 站凑不满 3 站、没有提示可录。
 */
export function canHintAt(index, stationCount = STATION_COUNT) {
  return index >= ORIGIN_INDEX && index <= hintMaxIndex(stationCount);
}

/** 站点类型下标归一：非法值一律视为未知（null）。 */
export function normalizeType(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < TYPE_KEYS.length ? n : null;
}

/** 提示值归一：无法识别的值一律视为「未记录」（null），避免静默产生错误约束。 */
export function normalizeHint(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value === HINT_SAME) return HINT_SAME;
  if (typeof value === "string" && value.startsWith(HINT_MAX_PREFIX)) {
    const target = normalizeType(value.slice(HINT_MAX_PREFIX.length));
    if (target !== null) return hintMax(target);
  }
  return null;
}

/**
 * 校验一条提示对「之后 3 站」是否成立。
 * window 中若出现 null（尚未确定的占位），一律视为满足——未确定的位置不构成约束。
 */
export function checkHint(hint, window) {
  if (!hint) return true;
  if (window.some((t) => t === null || t === undefined)) return true;
  if (hint === HINT_SAME) {
    return window[0] !== window[1] && window[1] !== window[2] && window[0] !== window[2];
  }
  const target = normalizeType(hint.slice(HINT_MAX_PREFIX.length));
  if (target === null) return true;
  return window.filter((t) => t === target).length >= 2;
}

/**
 * 求解站点排列。
 *
 * @param {object} input
 * @param {Array<number|null>} [input.observed] 已确认的站点类型，null/缺省表示未知。
 *   下标 0（始发站）会被忽略——它没有类型。
 * @param {Array<string|null>} [input.hints] 各站的「未来 3 站」提示，null 表示未记录
 * @param {number} [input.stationCount]
 * @returns {{
 *   consistent: boolean, stationCount: number, total: number,
 *   counts: number[][], ratio: number[][], possibleTypes: number[][],
 *   locked: boolean[], known: boolean[],
 *   nextIndex: number, nextTypes: number[], nextLocked: boolean,
 *   observed: Array<number|null>, hints: Array<string|null>
 * }}
 *   total 为符合全部提示的合法类型排列数（始发站没有类型，不计入）；consistent=false 表示
 *   录入的记录自相矛盾。ratio 为每站各类型的占比（total=0 时全为 0）；locked 表示该站已被
 *   唯一确定。始发站恒为「无候选、未锁定」（possibleTypes[0] === []），nextIndex 也从下标 1 起。
 */
export function solveRailRoute({ observed = [], hints = [], stationCount = STATION_COUNT } = {}) {
  const n = Math.max(1, Math.floor(stationCount));
  const obs = Array.from({ length: n }, (_, i) => normalizeType(observed[i]));
  const hnt = Array.from({ length: n }, (_, i) => (canHintAt(i, n) ? normalizeHint(hints[i]) : null));
  // 始发站没有类型：忽略录入里可能残留在下标 0 的值（改版前那里放的是「第 1 站」的类型），
  // 模型只枚举第 1~n-1 站。
  obs[ORIGIN_INDEX] = null;

  // 始发站恒定取占位值——它不参与类型枚举，也不会进入任何提示窗口（窗口最早从下标 1 开始）。
  const allowedAt = (p) =>
    p === ORIGIN_INDEX ? [ORIGIN_PLACEHOLDER] : obs[p] === null ? [0, 1, 2] : [obs[p]];

  // 状态 (p, a, b, c)：a/b/c 依次为第 p-2 / p-1 / p 站的类型，站位不存在时用 -1 占位。
  function keysAt(p) {
    const choicesAt = (i) => (i < 0 ? [-1] : [0, 1, 2]);
    const out = [];
    for (const a of choicesAt(p - 2)) {
      for (const b of choicesAt(p - 1)) {
        for (const c of choicesAt(p)) out.push([a, b, c]);
      }
    }
    return out;
  }

  const waysMemo = new Map();
  const prefixMemo = new Map();
  const stateKey = (a, b, c) => `${a},${b},${c}`;

  // 后向计数：从第 p 站向前走完全程的合法方案数。
  function ways(p, a, b, c) {
    const memoKey = `${p}|${stateKey(a, b, c)}`;
    const hit = waysMemo.get(memoKey);
    if (hit !== undefined) return hit;
    let total = 0;
    if (p === n - 1) {
      total = 1;
    } else {
      for (const d of allowedAt(p + 1)) {
        // 落定第 p+1 站后，位于 p-2 的提示（覆盖 p-1 / p / p+1）才能判定。
        if (p - 2 >= 0 && !checkHint(hnt[p - 2], [b, c, d])) continue;
        total += ways(p + 1, b, c, d);
      }
    }
    waysMemo.set(memoKey, total);
    return total;
  }

  // 前向计数：走到第 p 站、且最近 3 站为 a/b/c 的合法前缀数。
  function prefix(p, a, b, c) {
    const memoKey = `P${p}|${stateKey(a, b, c)}`;
    const hit = prefixMemo.get(memoKey);
    if (hit !== undefined) return hit;
    if (!allowedAt(p).includes(c)) {
      prefixMemo.set(memoKey, 0);
      return 0;
    }
    let total = 0;
    if (p === 0) {
      total = 1;
    } else {
      const prevs = p - 3 >= 0 ? [0, 1, 2] : [-1];
      for (const x of prevs) {
        if (p - 3 >= 0 && !checkHint(hnt[p - 3], [a, b, c])) continue;
        total += prefix(p - 1, x, a, b);
      }
    }
    prefixMemo.set(memoKey, total);
    return total;
  }

  const counts = Array.from({ length: n }, () => [0, 0, 0]);
  let total = 0;
  for (const [a, b, c] of keysAt(n - 1)) total += prefix(n - 1, a, b, c);

  if (total > 0) {
    for (let p = 0; p < n; p++) {
      for (const [a, b, c] of keysAt(p)) {
        const f = prefix(p, a, b, c);
        if (!f) continue;
        counts[p][c] += f * ways(p, a, b, c);
      }
    }
  }

  // 始发站没有类型：占位计数清零，界面据此显示「始发站」而不是三类占比。
  counts[ORIGIN_INDEX] = [0, 0, 0];

  const ratio = counts.map((row) => (total > 0 ? row.map((v) => v / total) : [0, 0, 0]));
  const possibleTypes = counts.map((row) => row.flatMap((v, t) => (v > 0 ? [t] : [])));
  const locked = possibleTypes.map((list) => list.length === 1);
  const known = obs.map((v, i) => i > ORIGIN_INDEX && v !== null);
  // 始发站没有类型要填，所以「下一个待确认的站」从下标 1 起找。
  const nextIndex = obs.findIndex((v, i) => i > ORIGIN_INDEX && v === null);

  return {
    consistent: total > 0,
    stationCount: n,
    total,
    counts,
    ratio,
    possibleTypes,
    locked,
    known,
    nextIndex,
    nextTypes: nextIndex === -1 ? [] : possibleTypes[nextIndex],
    nextLocked: nextIndex !== -1 && locked[nextIndex],
    // 归一化后的录入（始发站恒为 null、越界提示恒为 null）。回传给上层做冲突诊断用，
    // 省得调用方自己再归一化一遍——两边规则不一致正是「诊断和求解各说各话」的来源。
    observed: obs,
    hints: hnt,
  };
}

/**
 * 建议条目的全部 key。
 *
 * 界面按 `toolbox.rail.adv.<key>.title / .act / .detail` 三段取文案，其中只有 title 必填，
 * act 与 detail 用 te() 判断有无。所以「漏写一条 title」不会报错，只会静默渲染成空标题——
 * i18n 单测拿这个列表反查两种语言，把这种静默失败挡在提交前。
 */
export const ADVICE_KEYS = [
  "conflict",
  "allKnown",
  "origin",
  "certain",
  "dontBoostSame",
  "uncertain",
  "earlyGame",
  "tail",
  "backToBack",
  "rhythm",
];

/**
 * 冲突诊断：指出「去掉哪一条记录，其余记录就自洽」。
 *
 * 只报「记录冲突」帮不上忙——16 站 ×（类型 + 提示）最多 31 格，用户不知道该查哪一格。
 * 做法是逐条试删：某条删掉后整个盘面变得自洽，那这条就是候选（通常只剩 1~3 条）。
 * 成本是每格一次求解（16 站 DP，微秒级），且只在已经冲突时才跑。
 *
 * @param {{observed?: Array, hints?: Array, stationCount?: number}} input 求解入参，
 *   或直接传 solveRailRoute 的返回值（已归一化，可直接复用）
 * @returns {{consistent: boolean, culprits: Array<{kind: "hint"|"type", index: number}>}}
 *   空 culprits = 删掉任何单条都不自洽（三条以上互相打架），界面退回泛化文案。
 */
export function diagnoseConflict(input = {}) {
  const observed = input.observed ?? [];
  const hints = input.hints ?? [];
  const stationCount = input.stationCount ?? STATION_COUNT;
  const base = solveRailRoute({ observed, hints, stationCount });
  if (base.consistent) return { consistent: true, culprits: [] };

  const n = base.stationCount;
  const culprits = [];
  for (let i = 0; i < n; i += 1) {
    if (canHintAt(i, n) && normalizeHint(hints[i]) !== null) {
      const probe = hints.slice();
      probe[i] = null;
      if (solveRailRoute({ observed, hints: probe, stationCount }).consistent) {
        culprits.push({ kind: "hint", index: i });
      }
    }
    // 始发站没有类型，所以类型只从下标 1 起试删
    if (i > ORIGIN_INDEX && normalizeType(observed[i]) !== null) {
      const probe = observed.slice();
      probe[i] = null;
      if (solveRailRoute({ observed: probe, hints, stationCount }).consistent) {
        culprits.push({ kind: "type", index: i });
      }
    }
  }
  return { consistent: false, culprits };
}

/**
 * 生成策略卡建议。返回结构化条目，文案由界面按 i18n key 渲染。
 * key 取自 ADVICE_KEYS；typeIndex 为需要插值的站点类型下标（0~2），无则 null。
 * conflict 一条额外带 culprits（诊断出的可疑录入），供界面指名道姓。
 * tone: info | success | warn | danger
 */
export function buildAdvice(result, { stationCount = STATION_COUNT } = {}) {
  const items = [];

  if (!result.consistent) {
    // 只说「记录冲突」等于把找错这一步丢回给用户：31 格录入里他得自己猜是哪一格。
    // 这里顺手跑一遍「去掉哪一条就自洽」的诊断，界面据此指名道姓。
    items.push({
      key: "conflict",
      typeIndex: null,
      tone: "danger",
      culprits: diagnoseConflict(result).culprits,
    });
    return items;
  }
  if (result.nextIndex === -1) {
    items.push({ key: "allKnown", typeIndex: null, tone: "info" });
    return items;
  }

  const hints = result.hints ?? [];
  // 开局：一条都没录（此时「下一站是什么」必然三选一，说「不确定」等于没说）。
  // 换成一条这一站该干什么的实操提示——始发站没有类型，只记它那条覆盖第 1~3 站的提示。
  const nothingRecorded = hints.every((h) => h === null) && !result.known.some(Boolean);

  const next = result.nextIndex;
  if (nothingRecorded) {
    items.push({ key: "origin", typeIndex: null, tone: "info" });
  } else if (result.nextLocked) {
    const type = result.nextTypes[0];
    items.push({ key: "certain", typeIndex: type, tone: "success" });
    // 连续两站同类型：上一站已经清过仓，下一站无货可卖，「下一站售价提升」等于 0 收益。
    // nextIndex 之前的所有站点都已确认，故上一站类型直接取 possibleTypes[next-1]。
    const prevTypes = next > 0 ? result.possibleTypes[next - 1] : [];
    if (prevTypes.length === 1 && prevTypes[0] === type) {
      items.push({ key: "dontBoostSame", typeIndex: type, tone: "warn" });
    }
  } else {
    items.push({ key: "uncertain", typeIndex: null, tone: "info" });
    if (next <= 2) items.push({ key: "earlyGame", typeIndex: null, tone: "info" });
  }

  if (stationCount - next <= 3) items.push({ key: "tail", typeIndex: null, tone: "info" });
  items.push({ key: "backToBack", typeIndex: null, tone: "info" });
  items.push({ key: "rhythm", typeIndex: null, tone: "info" });
  return items;
}

/**
 * 该站是否已「记录完整」。
 *
 * 完整 = 类型已确认，且该站该记的提示也记了（末尾第 13~15 站凑不满 3 站，没有提示可记）。
 * 提示是推断的唯一信息源，所以「只填类型」不算记完——界面据此决定要不要跳到下一站。
 * **始发站没有类型**（见文件头规则），它只要记了那条提示就算记完。
 *
 * @param {Array<number|null>} observed
 * @param {Array<string|null>} hints
 * @param {number} index 0 基站点下标
 * @param {number} [stationCount]
 */
export function isStationComplete(observed, hints, index, stationCount = STATION_COUNT) {
  if (index < 0 || index >= stationCount) return false;
  if (index > ORIGIN_INDEX && normalizeType(observed?.[index]) === null) return false;
  if (canHintAt(index, stationCount) && normalizeHint(hints?.[index]) === null) return false;
  return true;
}

/** 记录条上某一格的三种状态（见 stationRecordState）。 */
export const RECORD_EMPTY = "empty";
export const RECORD_HALF = "half";
export const RECORD_DONE = "done";

/**
 * 该站在「记录进度条」上该画成哪一档：`empty` 什么都没记 / `half` 记了一半 / `done` 记全了。
 *
 * 驾驶舱顶栏那 16 个方格就取这里的值上色——它回答的是「我记到哪了、哪站还缺一半」，
 * 与「下一站是什么」（推断）是两件事，所以不复用 result 里的 locked/possibleTypes。
 *
 * 三档的判据（**「记了一半」不是按字段数算的，是按「这一站还差什么」算的**）：
 *   - `done`：就是 isStationComplete —— 「已记全」只有这一个真源，不在别处重写一遍；
 *   - `empty`：这一站**一个字段都没填**；
 *   - `half`：填了、但没填全（只记了类型 / 只记了提示）。
 * ⚠️ 始发站没有类型，所以它「只记了提示」= `done`、而不是 `half`——光看字段数会把它判错。
 *
 * @param {Array<number|null>} observed
 * @param {Array<string|null>} hints
 * @param {number} index 0 基站点下标
 * @param {number} [stationCount]
 */
export function stationRecordState(observed, hints, index, stationCount = STATION_COUNT) {
  if (index < 0 || index >= stationCount) return RECORD_EMPTY;
  const typed = index > ORIGIN_INDEX && normalizeType(observed?.[index]) !== null;
  const hinted = canHintAt(index, stationCount) && normalizeHint(hints?.[index]) !== null;
  if (!typed && !hinted) return RECORD_EMPTY;
  return isStationComplete(observed, hints, index, stationCount) ? RECORD_DONE : RECORD_HALF;
}

/**
 * 记录条一格的**内容**来源：格子里写什么字、字从哪来。
 *
 * 旧版格子只报进度档位（站号 + 底色），用户反馈「确认的结果要写进方框」——
 * 光看颜色得凑近了猜，字直接写出来才是结果。三种来源按优先级排：
 *   - `record`：这一站的类型**已录入**——录入的是用户亲眼看到的，永远最优先；
 *   - `predict`：没录入、但求解器已把它唯一确定（locked）——推断确认的结果也写进去，
 *     但视图层必须用虚框和实底区分开，不能让人误以为已经录过了；
 *   - `label`：还没有任何结果，退回站号/始发站占位。
 *
 * @param {number|string|null} observedType 该站已录入的类型（原值，内部归一）
 * @param {number|string|null} predictedType 推断唯一确定的类型（仅 locked 站传入）
 * @returns {{ kind: string, typeIndex: number|null }}
 */
export const CELL_LABEL = "label";
export const CELL_RECORD = "record";
export const CELL_PREDICT = "predict";

export function stripCellContent(observedType, predictedType) {
  const obs = normalizeType(observedType);
  if (obs !== null) return { kind: CELL_RECORD, typeIndex: obs };
  const pred = normalizeType(predictedType);
  if (pred !== null) return { kind: CELL_PREDICT, typeIndex: pred };
  return { kind: CELL_LABEL, typeIndex: null };
}

/**
 * 第一个尚未记录完整的站点下标；全部记完返回 -1。
 *
 * @param {Array<number|null>} observed
 * @param {Array<string|null>} hints
 * @param {number} [stationCount]
 */
export function firstIncomplete(observed, hints, stationCount = STATION_COUNT) {
  for (let i = 0; i < stationCount; i += 1) {
    if (!isStationComplete(observed, hints, i, stationCount)) return i;
  }
  return -1;
}

/**
 * 从 from 之后找下一个尚未记录完整的站点；没有则返回 -1。
 * 用于「记完一站自动前进」，跳过的都是已经记全的站。
 *
 * @param {Array<number|null>} observed
 * @param {Array<string|null>} hints
 * @param {number} from
 * @param {number} [stationCount]
 */
export function nextIncompleteAfter(observed, hints, from, stationCount = STATION_COUNT) {
  for (let i = from + 1; i < stationCount; i += 1) {
    if (!isStationComplete(observed, hints, i, stationCount)) return i;
  }
  return -1;
}
