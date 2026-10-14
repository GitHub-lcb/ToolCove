// 文本分段读取（spill 回来的完整结果、以及 file.read_text 的分页）。
//
// 为什么必须有这段：spill 出来一份 200 KB 结果后，如果读取通道还是「整份读回来」，
// 一读又会撞上工具结果的上限——spill 就成了死路（DSH 明确点过这个坑）。
// 所以窗口语义要和 spill 同批落地：读得回、读得动、读得准。
//
// 纯函数、不 import Vue / Tauri：node 环境可直接单测。

/** 默认窗口大小：与事件载荷预算同量级，保证「读回来的一段」不会再触发裁剪。 */
export const DEFAULT_WINDOW = 8000;
/** 单次窗口上限：再大就失去分段的意义了。 */
export const MAX_WINDOW = 32000;
/** keyword 命中时最多返回几处上下文。 */
export const MAX_HITS = 5;
/** 每处上下文两侧各取多少字符。 */
const HIT_CONTEXT = 300;

const clampWindow = (value, fallback, max) => {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
};

/**
 * 归一 offset：接受 0 或 1 两种起点，内部统一成 0 基。
 * 模型两种都会写（0 基是它的直觉，1 基是编辑器显示），与其报错不如都认。
 */
function normalizeOffset(offset) {
  const n = Math.trunc(Number(offset));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n;
}

/** 字符位置 → 行号（1 基）。从窗口起点往前找最后一个换行。 */
function lineAt(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** 全文行数（1 基）：空文本记 0 行；末字符是换行时不额外多算一行。 */
function countLines(text) {
  if (!text.length) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines += 1;
  return text.charCodeAt(text.length - 1) === 10 ? lines - 1 : lines;
}

/**
 * 开窗。offset 语义：0 基字符位置（`nextOffset` 可直接回填）。
 * 越界一律夹取，绝不抛错——模型给负数/超大值是常态，为此失败一步不值得。
 */
export function createReadWindow(source, options = {}) {
  const text = typeof source === 'string' ? source : String(source ?? '');
  const totalChars = text.length;
  const limit = clampWindow(options.limit, DEFAULT_WINDOW, MAX_WINDOW);
  const offset = Math.min(normalizeOffset(options.offset), totalChars);
  const end = Math.min(offset + limit, totalChars);
  const hasMore = end < totalChars;
  return {
    text: text.slice(offset, end),
    offset,
    end,
    limit,
    nextOffset: hasMore ? end : null,
    totalChars,
    // 只在窗口没到结尾时才需要数全文行数（到结尾就是窗口自身的行数）
    totalLines: hasMore ? countLines(text) : countLines(text.slice(offset, end)),
    windowLine: lineAt(text, offset),
    hasMore,
    truncated: hasMore,
    overLimit: totalChars > limit,
  };
}

/** 关键词定位：命中处带行号与上下文。找不到时返回空数组（调用方负责给出提示）。 */
export function findKeyword(source, keyword, options = {}) {
  const text = typeof source === 'string' ? source : String(source ?? '');
  const needle = String(keyword ?? '').trim();
  if (!needle) return [];
  const limit = clampWindow(options.limit, MAX_HITS, MAX_HITS);
  const haystack = text.toLowerCase();
  const target = needle.toLowerCase();
  const hits = [];
  let from = 0;
  while (hits.length < limit) {
    const index = haystack.indexOf(target, from);
    if (index < 0) break;
    const start = Math.max(index - HIT_CONTEXT, 0);
    const end = Math.min(index + target.length + HIT_CONTEXT, text.length);
    hits.push({
      index,
      line: lineAt(text, index),
      context: `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`,
    });
    from = index + target.length;
  }
  return hits;
}

/** 给模型的一句可执行说明：还剩多少、下次怎么读。截断时才有。 */
export function windowNote(meta = {}) {
  if (!meta.hasMore) return '';
  const remaining = Math.max((Number(meta.totalChars) || 0) - (Number(meta.end) || 0), 0);
  return `仅返回第 ${Number(meta.offset) + 1}–${Number(meta.end)} 个字符（共 ${meta.totalChars} 字符，剩余 ${remaining}）。继续读请传 offset=${meta.nextOffset}；也可以传 keyword 直接定位。`;
}

/** 关键词没命中时的说明：告诉模型还能怎么办，而不是只报一句「没有」。 */
export function missNote(keyword, meta = {}) {
  return `未找到「${String(keyword ?? '')}」（已搜索全部 ${Number(meta.totalChars) || 0} 字符）。可以换关键词，或按 offset 顺序分段读取。`;
}

/** 组装一个窗口结果（含说明），供 spill.read / file.read_text 共用。 */
export function readWindowResult(source, options = {}) {
  const meta = createReadWindow(source, options);
  const note = windowNote(meta);
  return { ...meta, note };
}

/** spill.read 的完整返回体：keyword 优先，其次开窗。 */
export function readSpillResult(source, options = {}) {
  const text = typeof source === 'string' ? source : String(source ?? '');
  const keyword = String(options.keyword ?? '').trim();
  if (keyword) {
    const hits = findKeyword(text, keyword, options);
    return hits.length
      ? { mode: 'keyword', keyword, hits, totalChars: text.length, totalLines: createReadWindow(text).totalLines }
      : { mode: 'keyword', keyword, hits: [], totalChars: text.length, note: missNote(keyword, { totalChars: text.length }) };
  }
  return { mode: 'window', ...readWindowResult(text, options) };
}
