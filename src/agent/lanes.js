// 执行泳道：把扁平事件流压成「模型 / 工具 / 确认」三条时间道。
// 纯函数，不依赖 Vue / Tauri；运行中由调用方传 now（时钟），回看传 0。
//
// 模型时间不是独立事件——它是工具与人工确认之外的补集。这样引擎不用新增事件，
// 泳道也能随 tool_start / tool_result 的时间戳自动成型。

const toMs = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function pushSpan(list, start, end) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  list.push({ start, end });
}

/** 合并重叠 / 包含的区间；相邻不合并——两次调用之间的空隙属于模型时间 */
function mergeSpans(spans) {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ ...s });
  }
  return out;
}

function complementSpans(busy, start, end) {
  const out = [];
  let cursor = start;
  for (const s of busy) {
    if (s.start > cursor) out.push({ start: cursor, end: Math.min(s.start, end) });
    cursor = Math.max(cursor, s.end);
    if (cursor >= end) break;
  }
  if (cursor < end) out.push({ start: cursor, end });
  return out.filter((s) => s.end > s.start);
}

/**
 * @param {Array} steps 已带 ts 的事件流（session.steps / run.steps）
 * @param {{ now?: number }} options 运行中传当前时刻，让进行中的段继续生长
 * @returns {{ start:number, end:number, totalMs:number, lanes:Array<{key:string,segments:Array<{start:number,end:number}>}> }|null}
 */
export function buildLanes(steps = [], { now = 0 } = {}) {
  const list = (Array.isArray(steps) ? steps : [])
    .filter((s) => s && toMs(s.ts) > 0)
    .map((s) => ({ ...s, ts: toMs(s.ts) }));
  if (!list.length) return null;

  const start = list[0].ts;
  const last = list[list.length - 1].ts;
  const end = Math.max(toMs(now), last, start + 1);
  if (end <= start) return null;

  const tools = [];
  const waits = [];
  const openTools = new Map();
  const openWaits = new Map();

  for (const s of list) {
    const ts = Math.min(Math.max(s.ts, start), end);
    switch (s.type) {
      case "tool_start":
        openTools.set(s.id || `t${ts}`, ts);
        break;
      case "tool_retry":
      case "tool_result":
      case "tool_error": {
        const opened = openTools.get(s.id || `t${ts}`);
        if (opened != null) {
          pushSpan(tools, opened, ts);
          openTools.delete(s.id || `t${ts}`);
        }
        break;
      }
      case "approval_asked":
        openWaits.set(s.id || `a${ts}`, ts);
        break;
      case "approval_decided": {
        const key = s.id || `a${ts}`;
        const opened = openWaits.get(key);
        if (opened != null) {
          pushSpan(waits, opened, ts);
          openWaits.delete(key);
        }
        break;
      }
      default:
        break;
    }
  }
  // 未收尾的尝试 / 等待：延到 end（运行中就是 now，回看就是最后一个事件）
  for (const opened of openTools.values()) pushSpan(tools, opened, end);
  for (const opened of openWaits.values()) pushSpan(waits, opened, end);

  const toolSpans = mergeSpans(tools);
  const waitSpans = mergeSpans(waits);
  const modelSpans = complementSpans(mergeSpans([...toolSpans, ...waitSpans]), start, end);

  return {
    start,
    end,
    totalMs: end - start,
    lanes: [
      { key: "model", segments: modelSpans },
      { key: "tool", segments: toolSpans },
      { key: "wait", segments: waitSpans },
    ],
  };
}
