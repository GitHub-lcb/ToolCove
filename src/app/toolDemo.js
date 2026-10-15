// 工具演示脚本：把「Agent 调用某个动作时给了什么参数」翻成一段能在工具界面上**真实回放**的步骤。
//
// 为什么脚本写在契约里、锚点名由视图注册：参数名 → 界面控件 的对应关系只有工具自己知道，
// 而且视图改版时这层必须跟着改。所以契约只说「我要操作名为 input 的锚点、值取 args.text」，
// 具体是哪个元素由视图给（见 app/useToolDemo.js）；两边的一致性由 toolDemoContract.test.js 强制。
//
// 本文件是纯逻辑（只 import 契约这份纯数据），node 环境可直接单测。
import { TOOL_CONTRACTS } from "../contracts/index.js";

/** 允许的步骤类型；fill/select/click 会真的改数据，reveal 只是把视线引过去。 */
export const STEP_ACTIONS = Object.freeze(["fill", "select", "click", "reveal"]);
/** 需要取值的动作：填/选必须知道填什么；点一下按钮本身不需要值。 */
const VALUE_REQUIRED = new Set(["fill", "select"]);

const CONTRACT_BY_KEY = new Map(TOOL_CONTRACTS.map((contract) => [contract.key, contract]));

/** 按动作全名（如 "table.convert"）取它的演示声明；没有 = 这个动作不参与演示。 */
export function actionDemo(toolKey, actionName) {
  const contract = CONTRACT_BY_KEY.get(toolKey);
  const action = contract && (contract.actions || []).find((a) => a && a.name === actionName);
  const demo = action && action.demo;
  if (!demo || !Array.isArray(demo.steps) || !demo.steps.length) return null;
  return demo;
}

/** 参数取值：显式 value 优先，其次按 from 从动作参数里取（取不到 = ok:false）。 */
function resolveValue(raw, args) {
  if (Object.hasOwn(raw, "value")) return { ok: raw.value != null, value: raw.value };
  if (typeof raw.from === "string") {
    const value = args && typeof args === "object" ? args[raw.from] : undefined;
    return { ok: value != null && value !== "", value: value ?? null };
  }
  return { ok: false, value: null };
}

/**
 * 用动作参数生成可播放脚本。
 *
 * 取值缺失的 fill/select 步骤直接丢掉——宁可少演一步，也不能演一个「填了空值」的假动作
 * （那比不演示更糟：用户会以为工具对空输入就是这个反应）。
 * click 只是点一下按钮，reveal 只是指出结果，两者都不需要值，一律保留。
 */
export function buildDemoScript(demo, args) {
  const steps = [];
  for (const raw of (demo && demo.steps) || []) {
    if (!raw || typeof raw !== "object") continue;
    const action = String(raw.action || "");
    if (!STEP_ACTIONS.includes(action)) continue;
    const anchor = String(raw.anchor || "");
    if (!anchor) continue;
    const picked = resolveValue(raw, args);
    if (!picked.ok && VALUE_REQUIRED.has(action)) continue;
    steps.push({
      anchor,
      action,
      value: picked.ok ? picked.value : null,
      captionKey: typeof raw.captionKey === "string" && raw.captionKey ? raw.captionKey : `toolbox.demo.step_${action}`,
    });
  }
  return steps;
}

/** 值压成一行短文本（放进「复现步骤」与字幕）：长文本只留头尾线索，不把整段贴出来。 */
export function clipValue(value, max = 48) {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * 「复现步骤」文本（教学用）：演示结束后给一份人能照着做的清单。
 * 传 t 取当前语言文案；不传则退回键名（便于单测断言结构）。
 */
export function replayLines(script, { t, max = 8 } = {}) {
  const tr = typeof t === "function" ? t : (key) => key;
  return (script || []).slice(0, max).map((step, index) => {
    const caption = tr(step.captionKey);
    return step.value == null ? `${index + 1}. ${caption}` : `${index + 1}. ${caption}：${clipValue(step.value)}`;
  });
}

/** 演示是否值得播（有步骤才有演示，空脚本一律当作「不演示」） */
export function isPlayable(script) {
  return Array.isArray(script) && script.length > 0;
}
