// 工具结果的体量分层（对标 DSH 的 spill → prune → compact）。
//
// 旧行为（runtime.js:276）：结果超过 maxOutput 就 throw「工具结果过大，请缩小输入后重试」——
// 「结果太大」被当成「这步白做」，模型既拿不到数据，也拿不到该怎么做才对。
//
// 分层语义（阈值来自 runtime 的 maxOutput，默认 32000，硬上限 100000）：
//   size ≤ maxOutput                     → keep：原样进历史
//   maxOutput < size ≤ maxOutput × 4     → clip：头尾保留 + 省略标记
//   size > maxOutput × 4                 → spill：交给注入的钩子落盘，历史里只放引用
//
// 关键细节（DSH 的教训）：**提示文字自身的字节数要先预留**，否则替换后会超预算。
// 这里的做法不是「大致扣一点余量」，而是收窄后重新测量、按比例回退，直到
// safeJsonSize(结果) ≤ maxOutput 真的成立（见 clipToBudget 的收敛循环 + assertWithinBudget）。
//
// 纯函数、不 import Vue / Tauri：node 环境可直接单测。

/** 最低预算：再小的预算也不该把头尾压成空串（否则模型拿到的是纯标记）。 */
export const MIN_BUDGET = 200;
/** clip 的分界倍数：超过 4 倍才认为「该落盘而不是硬裁」。 */
export const SPILL_FACTOR = 4;

const clampBudget = (maxOutput) => {
  const n = Math.trunc(Number(maxOutput));
  return Number.isFinite(n) && n > 0 ? Math.max(n, MIN_BUDGET) : MIN_BUDGET;
};

/**
 * JSON 体量。三重兜底，绝不因为「量个长度」把一次成功的工具调用弄失败：
 *  - undefined / 函数：JSON.stringify 返回 undefined（不是字符串）
 *  - BigInt：JSON.stringify 抛 TypeError
 *  - 循环引用：JSON.stringify 抛 TypeError
 */
export function safeJsonSize(value) {
  try {
    const text = JSON.stringify(value ?? null);
    if (typeof text === 'string') return text.length;
  } catch {
    // 落到下面的兜底
  }
  try {
    return String(value).length;
  } catch {
    return 0;
  }
}

/** 把任意工具结果压成可裁剪的文本：字符串原样，其余走 JSON（失败退 String）。 */
export function toBudgetText(value) {
  if (typeof value === 'string') return value;
  try {
    const text = JSON.stringify(value ?? null, null, 2);
    if (typeof text === 'string') return text;
  } catch {
    // 落到 String 兜底
  }
  try {
    return String(value);
  } catch {
    return '';
  }
}

/** 省略标记的两种形态：正文标记（head 与 tail 之间）与「被省略的字符数」。 */
const markerOf = (omitted, total) => `\n…[已省略 ${omitted} 字符，原长度 ${total}]…\n`;

/**
 * 头尾保留字符数的首个估计：先把标记的固定部分扣掉，再对半分。
 * 第一轮必须有非零的头尾，否则收敛循环会立刻在「纯标记」上退出（曾经真的这么错过）。
 */
function initialSplit(budget, total) {
  const room = Math.max(budget - markerOf(total, total).length, 0);
  const half = Math.floor(room / 2);
  return { headChars: half, tailChars: half };
}

/**
 * 把超预算的文本裁成「头 + 省略标记 + 尾」，并保证结果不超预算。
 * 收敛方式：先按预算估头尾长度 → 读回真实标记长度（含被省略的字符数）→ 重新对半；
 * 仍超预算则按超出量成比例收窄，最多 8 轮。
 *
 * `strict` 为真时按 **safeJsonSize（最终 JSON 尺寸）** 收口，而不是字符数：
 * 裁剪出来的文本会被当作 JSON 字符串再序列化一次，里面的换行与引号要转义
 * （整齐 JSON 的转义开销约每行 1 个字符），只按字符数收会在写入 run 时超限。
 * 返回 head / marker / tail 三段（不靠反解字符串拼回去，避免标记内容参与解析）。
 */
export function clipToBudget(text, maxOutput, { strict = false } = {}) {
  const budget = clampBudget(maxOutput);
  const source = typeof text === 'string' ? text : String(text ?? '');
  const total = source.length;
  const seed = initialSplit(budget, total);

  let headChars = Math.min(seed.headChars, total);
  let tailChars = Math.min(seed.tailChars, Math.max(total - headChars, 0));
  let marker = '';
  let strictRounds = 0;

  const sizeOf = (head, mark, tail) => (strict ? safeJsonSize(head + mark + tail) : head.length + mark.length + tail.length);

  for (let round = 0; round < 16; round++) {
    const omitted = Math.max(total - headChars - tailChars, 0);
    marker = markerOf(omitted, total);
    const head = source.slice(0, headChars);
    const tail = tailChars > 0 ? source.slice(total - tailChars) : '';
    const overflow = sizeOf(head, marker, tail) - budget;
    if (overflow <= 0) break;
    if (headChars + tailChars === 0) break; // 纯标记已超预算：认了，由 assertWithinBudget 记一笔
    // 严格模式下转义开销不随裁剪线性变化，按比例收窄，最多多跑 8 轮
    const ratio = strict ? 0.9 : 1;
    const room = Math.max((headChars + tailChars - Math.max(overflow, 32)) * ratio, 0);
    const next = Math.max(Math.ceil(room / 2), 0);
    if (strict) {
      strictRounds += 1;
      if (strictRounds > 8) break;
    }
    headChars = next;
    tailChars = Math.max(room - next, 0);
    if (headChars + tailChars === 0) break;
  }

  const head = source.slice(0, headChars);
  const tail = tailChars > 0 ? source.slice(total - tailChars) : '';
  const omitted = Math.max(total - headChars - tailChars, 0);
  return {
    head,
    marker,
    tail,
    text: head + marker + tail,
    clipped: true,
    originalChars: total,
    retainedChars: headChars + tailChars,
    omittedChars: omitted,
  };
}

/**
 * 预算的口径说明（免得后来者按「字符数」和「JSON 长度」打架）：
 *  - 裁剪结果本身是字符串，`safeJsonSize` 会替它多算两个引号，所以不变量的表达是
 *    「payload ≤ 预算 + 2」，两个字符就是引号；不加这 2 个字符的宽容，就会出现
 *    「裁剪到 8000 却断言超了 2 个字符」这种假报警。
 *  - 严格裁剪走 safeJsonSize 收口（见 clipToBudget 的 strict），所以这里只是不变量本身的宽容度。
 */
const OVERHEAD = 2;

/** 预算不变量：收尾之后结果必须落在预算内（含字符串引号的两个字符）。 */
export function assertWithinBudget(value, maxOutput) {
  return safeJsonSize(value) <= clampBudget(maxOutput) + OVERHEAD;
}

/** 能否安全序列化：进历史的值必须存得下（持久化 run 是 JSON）。 */
function isSerializable(value) {
  try {
    return typeof JSON.stringify(value ?? null) === 'string';
  } catch {
    return false;
  }
}

/** 一次调用该走哪条路。spill 是否真的可用由调用方决定（浏览器端钩子可能缺失）。 */
export function planResult(value, maxOutput) {
  const budget = clampBudget(maxOutput);
  const size = safeJsonSize(value);
  // 不可序列化的值（BigInt / 循环引用）按体量说也许很小，但它进不了持久化 run，
  // 也读不回历史——直接走 clip 落成文本，而不是「keep 一个存不下的对象」。
  const forceText = !isSerializable(value);
  if (!forceText && size <= budget) return { kind: 'keep', value, size, maxOutput: budget };
  if (forceText || size <= budget * SPILL_FACTOR) return { kind: 'clip', value, size, maxOutput: budget };
  return { kind: 'spill', value, size, maxOutput: budget, text: toBudgetText(value) };
}

/**
 * 收尾：把分层计划变成真正进历史的值。
 * 裁剪的是 **JSON 文本**（对象、数组也一样），所以返回字符串——这是有意的：
 * 模型看到「头 + 省略标记 + 尾」比看到「一个被删空的对象」有用得多。
 */
export function finalizeResult(plan) {
  if (!plan || plan.kind === 'keep') return { value: plan?.value ?? null, clipped: false };
  const clipped = clipToBudget(toBudgetText(plan.value), plan.maxOutput, { strict: true });
  return {
    value: clipped.text,
    clipped: true,
    originalChars: clipped.originalChars,
    retainedChars: clipped.retainedChars,
    omittedChars: clipped.omittedChars,
    withinBudget: assertWithinBudget(clipped.text, plan.maxOutput),
  };
}

// ------- 事件载荷 -------
// 进历史的那一份已经被 finalizeResult 收过了，但 **发出去的 tool_result 事件带的是原始对象**：
// 一个 5 MB 的查询结果会原样进 session.steps、进持久化 run、进 DOM。所以事件载荷要单独收一遍，
// 且用比历史更小的预算（历史要大是为了让模型能继续推理，事件只需要让用户看清这一步做了什么）。
export const EVENT_PAYLOAD_LIMIT = 8000;
export const EVENT_FIELDS = Object.freeze(['result', 'answer', 'preview', 'error', 'question', 'args', 'text', 'value']);

/** 单个字段按预算收一遍：不超原样返回，超了裁成字符串。 */
export function fitPayload(value, limit = EVENT_PAYLOAD_LIMIT) {
  const budget = clampBudget(limit);
  if (safeJsonSize(value) <= budget) return { value, clipped: false };
  const clipped = clipToBudget(toBudgetText(value), budget, { strict: true });
  return { value: clipped.text, clipped: true, originalChars: clipped.originalChars, omittedChars: clipped.omittedChars };
}

/**
 * 收一遍事件里所有可能过大的字段。返回新对象（不改原事件，避免调用方拿到被替换的引用）。
 * 无字段命中时原样返回，省掉一次无谓的复制。
 */
export function budgetEvent(event, limit = EVENT_PAYLOAD_LIMIT) {
  if (!event || typeof event !== 'object') return event;
  let out = null;
  for (const field of EVENT_FIELDS) {
    if (!Object.hasOwn(event, field)) continue;
    const value = event[field];
    if (value == null) continue;
    if (safeJsonSize(value) <= clampBudget(limit)) continue;
    const fitted = fitPayload(value, limit);
    out = out || { ...event };
    out[field] = fitted.value;
    out.payloadClipped = true;
  }
  return out || event;
}

/** 折叠结果时给模型和 UI 的一句说明（i18n 键由 UI 侧映射，这里是引擎侧原文）。 */
export function clipNote(meta = {}) {
  const omitted = Math.max(Number(meta.omittedChars) || 0, 0);
  return `结果过长，已保留头尾并省略 ${omitted} 字符（原长度 ${Number(meta.originalChars) || 0}）。需要完整内容时请缩小输入范围或分段读取。`;
}

/** spill 成功后放进历史的引用说明：必须写清「怎么读回来」，否则等于没说。 */
export function spillNote(ref = {}) {
  const key = String(ref.key || '');
  const chars = Math.max(Number(ref.chars) || 0, 0);
  return `完整结果已保存为 ${key}（${chars} 字符）。用 spill.read 分段读取（可带 keyword 直接定位），摘要仍在本次结果中。`;
}

/**
 * 摘要可用的字符预算：把「保留说明」从整个结果预算里先扣掉。
 * 说明本身也占历史空间，扣掉它才是摘要真正的余量——否则摘要 + 说明会一起超预算。
 * 下限取一半，避免说明异常长时把摘要挤成空。
 */
export function retainedBudget(maxOutput, note = '') {
  const budget = clampBudget(maxOutput);
  return Math.max(budget - String(note).length, Math.floor(budget / 2));
}
