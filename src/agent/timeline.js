// Agent 时间线折叠：把 runtime 发出的扁平事件流按工具调用 id 归并成可渲染的条目。
// 纯函数，不 import Vue / Tauri —— 保持 node 环境可单测（vite.config.js 无 jsdom）。
//
// runtime 的重试语义：for attempt 循环里先发 tool_start(attempt=n)，失败且还有余量时发
// tool_retry(attempt=n)，然后 continue 发下一次 tool_start(attempt=n+1)。所以 tool_retry
// 标记的是「当前这张尝试卡失败并将重试」，不该新开一行。

// 超过该长度的 args / result 默认折叠，由 UI 提供「展开全部」
export const COLLAPSE_AT = 400;
// 显示硬截断：再长的内容也不整块塞进 DOM
export const DISPLAY_CLIP = 2000;

export function clipText(value, max = DISPLAY_CLIP) {
  const s = String(value ?? "");
  return s.length > max ? s.slice(0, max) + "…" : s;
}

export function payloadText(value) {
  if (value == null) return "";
  if (typeof value === "string") return clipText(value);
  try {
    return clipText(JSON.stringify(value, null, 2));
  } catch {
    return clipText(String(value));
  }
}

/**
 * 折叠事件流。入参应为已脱敏的事件（调用方推入前过 sanitizeRun）。
 * 返回条目：
 *   { kind:"tool", id, tool, ts, attempts:[{ n, args, status:"running"|"ok"|"retry"|"error", result, error, code, ts }] }
 *   { kind:"confirm", tool, question, answer, ts }
 *   { kind:"final", answer, ts }
 *   { kind:"notice", code, text, ts }
 * planning / waiting 类 checkpoint 不入列（UI 用运行中指示器表达）。
 */
export function foldTimeline(events = []) {
  const out = [];
  const byId = new Map();
  const approvals = new Map();
  const list = Array.isArray(events) ? events : [];

  const cardOf = (id, tool, ts) => {
    let card = byId.get(id);
    if (!card) {
      card = { kind: "tool", id: id || "", tool: tool || "", ts, attempts: [] };
      if (id) byId.set(id, card);
      out.push(card);
    }
    return card;
  };
  // 审计事件成对渲染：asked 先建条目，decided 补结论。只有 decided 没有 asked 的畸形事件
  // 单独成条而不是丢弃——审计记录缺一半也必须看得见。
  const approvalOf = (id, tool, ts) => {
    const key = id || `${tool}@${ts}`;
    let item = approvals.get(key);
    if (!item) {
      item = { kind: "approval", id: id || "", tool: tool || "", ts, asked: false, decided: false, approved: null, source: "", reason: "" };
      approvals.set(key, item);
      out.push(item);
    }
    return item;
  };
  const lastAttempt = (card) => card.attempts[card.attempts.length - 1] || null;

  for (const raw of list) {
    if (!raw || typeof raw !== "object") continue;
    const ts = Number.isFinite(Number(raw.ts)) ? Number(raw.ts) : 0;
    switch (raw.type) {
      case "tool_start": {
        const card = cardOf(raw.id, raw.tool, ts);
        card.attempts.push({
          n: Number.isInteger(raw.attempt) ? raw.attempt : card.attempts.length + 1,
          args: raw.args ?? null,
          status: "running",
          result: null,
          error: "",
          code: "",
          ts,
        });
        break;
      }
      case "tool_retry": {
        // 没有对应 tool_start 的 retry 是畸形事件：不能建卡，否则得到一张 attempts 为空的工具卡
        const card = raw.id ? byId.get(raw.id) : null;
        const attempt = card ? lastAttempt(card) : null;
        if (attempt) {
          attempt.status = "retry";
          attempt.error = raw.error || "";
          attempt.code = raw.code || "";
        }
        break;
      }
      case "tool_result": {
        const card = cardOf(raw.id, raw.tool, ts);
        const attempt = lastAttempt(card);
        if (attempt) {
          attempt.status = "ok";
          attempt.result = raw.result ?? null;
          attempt.args = raw.args ?? attempt.args;
        } else {
          card.attempts.push({ n: 1, args: raw.args ?? null, status: "ok", result: raw.result ?? null, error: "", code: "", ts });
        }
        break;
      }
      case "tool_error": {
        const card = cardOf(raw.id, raw.tool, ts);
        const attempt = lastAttempt(card);
        if (attempt) {
          attempt.status = "error";
          attempt.error = raw.error || "";
          attempt.code = raw.code || "";
          attempt.args = raw.args ?? attempt.args;
        } else {
          card.attempts.push({ n: 1, args: raw.args ?? null, status: "error", result: null, error: raw.error || "", code: raw.code || "", ts });
        }
        break;
      }
      case "confirmation":
        out.push({ kind: "confirm", tool: raw.tool || "", question: raw.question || "", answer: raw.answer, ts });
        break;
      case "approval_asked": {
        const item = approvalOf(raw.id, raw.tool, ts);
        item.asked = true;
        item.tool = raw.tool || item.tool;
        item.reason = raw.reason || item.reason;
        item.args = raw.args ?? null;
        item.ts = item.ts || ts;
        break;
      }
      case "approval_decided": {
        const item = approvalOf(raw.id, raw.tool, ts);
        item.decided = true;
        item.approved = !!raw.approved;
        item.source = raw.source || "";
        item.reason = raw.reason || item.reason;
        break;
      }
      case "final":
        out.push({ kind: "final", answer: raw.answer || "", ts });
        break;
      case "notice":
        out.push({ kind: "notice", code: raw.code || "", text: raw.text || "", ts });
        break;
      // 模型侧的失败也要在时间线上看得见：用户需要知道「为什么这一步慢了」，
      // 否则退避重试与格式修复都是静默发生的。
      case "model_retry":
        out.push({ kind: "notice", code: "model_retry", text: raw.error || "", attempt: raw.attempt || 0, ts });
        break;
      case "model_repair":
        out.push({ kind: "notice", code: "model_repair", text: raw.error || "", attempt: raw.attempt || 0, ts });
        break;
      default:
        break; // checkpoint(planning/waiting) 与未知类型不占时间线一行
    }
  }
  return out;
}

/** 时间线里是否还有未收尾的工具卡（用于「运行中」指示器） */
export function hasRunning(timeline = []) {
  return timeline.some((item) => item.kind === "tool" && item.attempts.some((a) => a.status === "running"));
}
