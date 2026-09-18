// 历史折叠：让长任务不丢「早期关键事实」。
//
// 旧实现是 `历史：${JSON.stringify(history.slice(-8))}`（index.js）。它丢掉的恰恰是
// 「任务目标推导出的早期关键事实」——一个跑了 20 步的任务，第 3 步的失败原因早就没了，
// 模型于是反复重试同一件事，而人看不出为什么。
//
// 折法（对标 DSH 的折叠语义）：早期步骤只留摘要，最近若干步原样保留，并在文本里**明说已折叠**，
// 免得模型把摘要当成完整结果。摘要一律保留：工具名、参数摘要、结果摘要或条数、错误原文。
// 预算倾斜：错误步骤与写类步骤给更高预算——错误信息是模型纠错的主要依据（DSH 明确点过）。
//
// 纯函数、不 import Vue / Tauri：node 环境可直接单测。

/** 原样保留的最近步数。 */
export const KEEP_TAIL = 8;
/** 折叠后（摘要段）的字符预算。 */
export const SUMMARY_BUDGET = 1500;
/** 错误/写类步骤的预算加权：它们决定模型下一步能不能纠错。 */
export const IMPORTANT_WEIGHT = 3;
/** 单字段（参数/结果）摘要的字符上限。 */
const FIELD_LIMIT = 200;
/** 一步摘要的硬上限，避免 40 步 × 200 字符把预算吃光。 */
const STEP_LIMIT = 600;

const isErrorStep = (step) => typeof step?.error === 'string' && step.error.length > 0;
const isWriteStep = (step) => step?.action?.type === 'tool_call' && step?.risk === 'write';

/** 折叠权重：错误与写类步骤更值钱。 */
export function stepWeight(step) {
  if (isErrorStep(step)) return IMPORTANT_WEIGHT;
  if (isWriteStep(step)) return IMPORTANT_WEIGHT;
  return 1;
}

/** 一行文本的紧凑化：换行压成空格、去多余空白、超长截断。 */
function compact(value, limit = FIELD_LIMIT) {
  const text = typeof value === 'string' ? value : safeText(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function safeText(value) {
  if (value == null) return '';
  try {
    const text = JSON.stringify(value);
    if (typeof text === 'string') return text;
  } catch {
    // 循环引用 / BigInt：退到 String
  }
  try {
    return String(value);
  } catch {
    return '';
  }
}

/** 结果的紧凑描述：数组给条数 + 首项，对象给字段名，标量给值。 */
function resultSummary(value) {
  if (value == null) return '';
  if (Array.isArray(value)) {
    const head = value.length ? `，首项 ${compact(value[0], 80)}` : '';
    return `数组 ${value.length} 项${head}`;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    const head = keys.slice(0, 8).join(', ');
    return `对象字段 {${head}${keys.length > 8 ? ', …' : ''}}`;
  }
  return compact(value);
}

/** 把一步折叠成一行：工具名 + 参数摘要 + 结果/错误摘要。 */
export function summarizeStep(step) {
  if (!step || typeof step !== 'object') return '';
  const action = step.action || {};
  if (action.type === 'protocol_error') return `协议错误：${compact(step.error, 300)}`;
  if (action.type === 'final') return `最终答复：${compact(action.answer, 300)}`;
  if (action.type === 'ask_user') return `询问用户：${compact(action.question, 200)}`;
  if (action.type !== 'tool_call') return '';

  const parts = [`调用 ${compact(action.tool, 60) || '（未命名工具）'}`];
  if (action.args && Object.keys(action.args).length) parts.push(`参数 ${compact(action.args)}`);
  if (isErrorStep(step)) parts.push(`失败 ${compact(step.error, 300)}`);
  else if (step.result !== undefined) parts.push(`结果 ${resultSummary(step.result)}`);
  return parts.join(' · ');
}

/**
 * 生成给模型看的历史视图。
 * 返回 { folded, recent, note }：
 *   folded —— 早期步骤摘要（已按预算裁剪，空串表示没有可折叠的内容）
 *   recent —— 原样保留的最近步骤
 *   note   —— 折叠说明（含被折叠的步数），不折叠时为空串
 */
export function buildHistoryView(history, options = {}) {
  const list = Array.isArray(history) ? history : [];
  const keepTail = Number.isInteger(options.keepTail) && options.keepTail >= 0 ? options.keepTail : KEEP_TAIL;
  const budget = Number.isInteger(options.summaryBudget) && options.summaryBudget > 0 ? options.summaryBudget : SUMMARY_BUDGET;
  if (list.length <= keepTail) return { folded: '', recent: list, note: '', foldedCount: 0 };

  const early = list.slice(0, list.length - keepTail);
  const recent = list.slice(list.length - keepTail);

  // 两步：先把每行压成摘要，再分配预算。
  // 分配顺序刻意如此——**先保错误行**。全部均分会把「第 3 步为什么失败」截成半句，
  // 而那正是模型纠错唯一能依据的东西；宁可把成功行的结果摘要压得更短。
  const lines = early.map((step) => ({ text: summarizeStep(step), weight: stepWeight(step) })).filter((line) => line.text);
  const weightSum = lines.reduce((sum, line) => sum + line.weight, 0) || 1;
  const allocated = lines.map((line) => Math.min(line.weight * Math.floor(budget / weightSum), line.text.length));
  let remaining = budget - allocated.reduce((sum, n) => sum + n, 0);
  // 剩下的按权重补给还没吃饱的行（错误行权重更高，所以先被补满）
  for (let pass = 0; pass < 3 && remaining > 0; pass++) {
    for (let i = 0; i < lines.length && remaining > 0; i++) {
      const room = Math.min(lines[i].text.length - allocated[i], STEP_LIMIT - allocated[i]);
      if (room <= 0) continue;
      const give = Math.min(room, Math.ceil(remaining / Math.max(lines[i].weight, 1)));
      allocated[i] += give;
      remaining -= give;
    }
  }

  const folded = lines
    .map((line, i) => (allocated[i] >= line.text.length ? line.text : `${line.text.slice(0, allocated[i])}…`))
    .join('\n');
  const note = `（以上 ${early.length} 步已折叠为摘要，字段被截断；最近 ${recent.length} 步为原文。）`;
  return { folded, recent, note, foldedCount: early.length };
}

/**
 * 拼出一段可直接塞进 prompt 的历史文本。比让调用方自己拼更不容易漏掉折叠说明。
 */
export function historyPromptText(history, options = {}) {
  const view = buildHistoryView(history, options);
  if (!view.folded) return safeText(view.recent);
  return `${view.note}\n${view.folded}\n--- 最近 ${view.recent.length} 步原文 ---\n${safeText(view.recent)}`;
}
