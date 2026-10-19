// 运行日志导出（纯函数）：把一次 run 排成 Markdown，给人看，也给排障用。
//
// 复用 foldTimeline 而不是从原始事件流重排：折叠层已经把「重试是同一次尝试」「确认卡成对出现」
// 这些语义处理过（见 timeline.js），导出与界面读同一份结论，才不会出现「界面上是一次、
// 导出来是三次」的分裂。
import { foldTimeline } from "./timeline.js";
import { normalizeAttachments } from "./attachments.js";

// 导出比界面宽松：界面上折叠的长参数，日志里要留够排障上下文（4000 字符 ≈ 一屏参数）
export const EXPORT_CLIP = 4000;

/** JSON / 字符串统一成可读块，超长截断并明确标注。 */
export function exportBlock(value, max = EXPORT_CLIP) {
  if (value == null) return "";
  let text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (typeof text !== "string") text = String(value);
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字符）` : text;
}

const STATUS_KEY = {
  success: "agent.statusSuccess",
  completed: "agent.statusSuccess",
  failed: "agent.statusFailed",
  cancelled: "agent.statusCancelled",
  max_steps: "agent.statusMaxSteps",
  running: "agent.statusRunning",
  pending: "agent.statusRunning",
  waiting: "agent.statusWaiting",
};

function timeOf(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** 多行内容缩进成引用块，避免与上一段标题粘连。 */
function fence(text, lang = "") {
  const body = String(text ?? "");
  if (!body.trim()) return "";
  return ["```" + lang, body, "```"].join("\n");
}

/**
 * @param {object} run 一次运行（input / status / steps / usage / attachments / answer / error）
 * @param {(key: string, params?: object) => string} t i18n
 * @param {{ noticeText?: (item: object) => string }} helpers 视图侧已有的文案映射（notice 的 code → 人话）
 */
export function runToMarkdown(run, t, helpers = {}) {
  const r = run && typeof run === "object" ? run : {};
  const say = typeof t === "function" ? t : (key) => key;
  const noticeText = typeof helpers.noticeText === "function" ? helpers.noticeText : (item) => item?.text || item?.code || "";
  const lines = [`# ${say("agent.exportTitle")}`, ""];

  lines.push(`- ${say("agent.exportGoal")}: ${String(r.input || "").trim() || say("agent.exportEmpty")}`);
  const status = String(r.status || "");
  lines.push(`- ${say("agent.exportStatus")}: ${STATUS_KEY[status] ? say(STATUS_KEY[status]) : status || say("agent.exportEmpty")}`);
  if (r.id) lines.push(`- ${say("agent.exportRunId")}: ${r.id}`);
  const started = timeOf(r.createdAt);
  const ended = timeOf(r.finishedAt);
  if (started) lines.push(`- ${say("agent.exportTime")}: ${started}${ended ? ` -> ${ended}` : ""}`);
  if (r.model) {
    lines.push(`- ${say("agent.exportModel")}: ${r.model}${r.modelProfile && r.modelProfile !== r.model ? ` (${r.modelProfile})` : ""}`);
  }
  const usage = r.usage && typeof r.usage === "object" ? r.usage : {};
  lines.push(
    `- ${say("agent.exportUsage")}: ${say("agent.modelCalls")} ${Number(usage.calls) || 0}, Tokens ${Number(usage.totalTokens) || 0}`
  );

  const attachments = normalizeAttachments(r.attachments);
  if (attachments.length) {
    lines.push("", `## ${say("agent.exportAttachments")}`);
    for (const item of attachments) lines.push(`- ${item.path || item.name}`);
  }

  lines.push("", `## ${say("agent.exportSteps")}`);
  const items = foldTimeline(Array.isArray(r.steps) ? r.steps : []);
  if (!items.length) lines.push(say("agent.exportNoSteps"));
  // 终态答复的真相源有两个：落盘 run 常常只有 steps 里的 final 事件（session 的 answer 不写回 run），
  // 回看历史时读到的正是这种。所以先用 run.answer，缺了再取最后一条 final。
  let finalAnswer = String(r.answer || "").trim();
  let index = 0;
  for (const item of items) {
    if (item.kind === "tool") {
      index += 1;
      lines.push("", `### ${index}. ${item.tool || "tool"}`);
      for (const attempt of item.attempts || []) {
        const label = say(attempt.status === "ok" ? "agent.statusSuccess" : attempt.status === "error" ? "agent.stepError" : "agent.statusRunning");
        lines.push(`- ${say("agent.exportAttempt", { n: attempt.n, status: label })}`);
        const args = exportBlock(attempt.args);
        if (args.trim()) lines.push("", fence(args, "json"));
        if (attempt.status === "ok") {
          const result = exportBlock(attempt.result);
          if (result.trim()) lines.push("", fence(result, "json"));
        } else if (attempt.error) {
          lines.push("", fence(exportBlock(attempt.error), "text"));
        }
      }
      continue;
    }
    if (item.kind === "final") {
      if (!finalAnswer) finalAnswer = String(item.answer || "").trim();
      continue;
    }
    if (item.kind === "notice") {
      lines.push(`- ${noticeText(item)}`);
      continue;
    }
    if (item.kind === "confirm") {
      const answer = typeof item.answer === "string" ? item.answer : item.answer ? say("agent.confirmAllow") : say("agent.confirmDeny");
      lines.push(`- ${item.tool ? `${item.tool}: ` : ""}${item.question || say("agent.stepConfirm")} -> ${answer}`);
      continue;
    }
    if (item.kind === "approval") {
      const decided = item.decided ? (item.approved ? say("agent.approvalAllowed") : say("agent.approvalDenied")) : say("agent.approvalPending");
      lines.push(`- ${item.tool || "tool"}: ${item.reason || say("agent.stepConfirm")} -> ${decided}`);
    }
  }

  if (finalAnswer) lines.push("", `## ${say("agent.exportAnswer")}`, "", finalAnswer);
  const error = String(r.error || "").trim();
  if (error) lines.push("", `## ${say("agent.exportError")}`, "", error);

  return `${lines.join("\n").trimEnd()}\n`;
}
