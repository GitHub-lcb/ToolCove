// 操作审计留痕（三期管理面）——纯函数（run → 条目）+ 内存缓存 + 落盘。
//
// 事件形状来自 agent/runtime.js 发出的审计事件（经 sanitizeRun 脱敏后进 run.steps）：
//   approval_asked   { type, id, tool, risk, reason, args, [preview] }   —— 仅在「要问人」时发出，带 risk
//   approval_decided { type, id, tool, approved, source, reason, by }    —— source: "human" | "policy"
// runtime 的两处 emit 保证**每次工具调用恰好有一条 approval_decided**：问人路径在 requestApproval 里发，
// 策略放行路径（无需询问）单独发。所以它以 1:1 对应「一次工具调用 + 其决定」，正是审计要的粒度：
//   decision：approved → allow / 否则 deny
//   source：human（人批准）/ policy（策略判定放行）
// risk 只在 approval_asked 上有；策略放行的调用没有这条，于是回落到工具目录里的风险级别。
import { AGENT_TOOL_BY_NAME } from "../agent/catalog.js";
import { invoke } from "../platform/invoke.js";

export const AUDIT_KEY = "auditLog";
export const AUDIT_MAX = 500; // 超出丢最旧
const GOAL_MAX = 120; // 目标摘要截断长度

// 工具名 → 风险级别的静态索引（catalog 是纯元数据，导入不拖实现层的重依赖）
const RISK_BY_TOOL = new Map([...AGENT_TOOL_BY_NAME.values()].map((meta) => [meta.name, meta.risk]));

const clip = (text, max) => {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) : s;
};

/**
 * 一次 run → 审计条目数组（纯函数）。
 * 只在 approval_decided 事件上产出条目（每次工具调用一条）；tool_start / tool_result 等执行事件不产出，
 * 因为「决定」才是审计关心的东西，执行成败会重复计入反而看不清。
 */
export function auditFromRun(run) {
  if (!run || typeof run !== "object") return [];
  const steps = Array.isArray(run.steps) ? run.steps : [];
  const runId = String(run.id || "");
  const goal = clip(run.input, GOAL_MAX);

  // 先从 approval_asked 收集每次调用的 risk（策略放行路径没有 asked，故可能缺，后落到目录索引）
  const risks = new Map();
  for (const step of steps) {
    if (step?.type === "approval_asked" && step.id) risks.set(String(step.id), step.risk || "");
  }

  const entries = [];
  for (const step of steps) {
    if (step?.type !== "approval_decided") continue;
    const callId = String(step.id || "");
    const tool = String(step.tool || "");
    if (!tool && !callId) continue; // 畸形事件不带任何可识别信息，跳过
    const ts = Number.isFinite(Number(step.ts)) ? Number(step.ts) : Number(run.updatedAt) || 0;
    entries.push({
      // runId 前缀：同一次运行的重复落盘算出同一个 id（幂等），跨 run 又不会撞
      id: `${runId}:${callId || `${tool}@${ts}`}`,
      ts,
      runId,
      goal,
      tool,
      risk: risks.get(callId) || RISK_BY_TOOL.get(tool) || "",
      decision: step.approved ? "allow" : "deny",
      source: step.source === "human" ? "human" : "policy",
    });
  }
  return entries;
}

/**
 * 合并审计：新的在前、按 id 去重（重复 id 保留新的那一份）、裁剪到上限（丢最旧）。纯函数。
 * incoming 视为比 existing 新（先并入），其内部按时间倒序排列以维持「最新在前」。
 */
export function mergeAudit(existing, incoming) {
  const inList = Array.isArray(incoming) ? [...incoming].reverse() : [];
  const exList = Array.isArray(existing) ? existing : [];
  const seen = new Set();
  const out = [];
  for (const entry of [...inList, ...exList]) {
    if (!entry || typeof entry !== "object") continue;
    const id = String(entry.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(entry);
    if (out.length >= AUDIT_MAX) break;
  }
  return out;
}

// ---------- 存储层 ----------
// 内存镜像：append 会高频发生（每次 run 变化一次），每次都读盘/远端太贵；镜像只在首次或显式
// load 时从存储载入，之后合并写回。null = 尚未加载。
let cache = null;
let chain = Promise.resolve();

/** 从存储读回并刷新镜像。读失败保留既有镜像（首次失败则置空）。 */
export async function loadAudit() {
  try {
    const raw = await invoke("load_data", { key: AUDIT_KEY });
    cache = mergeAudit(Array.isArray(raw) ? raw : [], []);
  } catch {
    if (cache === null) cache = [];
  }
  return cache;
}

function ensureLoaded() {
  return cache !== null ? Promise.resolve(cache) : loadAudit();
}

/**
 * 追加审计条目（幂等：同 id 由 mergeAudit 去重）。
 * 串行队列保证「读-合并-写」不被并发打断；返回值恒为 Promise，且**永不 reject**——
 * 审计落盘失败不该中断 Agent 运行。仅在确有新增条目时才写盘，避免每个运行步骤都触发一次存储写。
 */
export function appendAudit(entries) {
  const incoming = Array.isArray(entries) ? entries : [];
  const task = async () => {
    try {
      const existing = await ensureLoaded();
      if (!incoming.length) return existing;
      const merged = mergeAudit(existing, incoming);
      cache = merged;
      if (merged.length !== existing.length) await invoke("save_data", { key: AUDIT_KEY, data: merged });
      return merged;
    } catch {
      return cache || [];
    }
  };
  chain = chain.then(task, task);
  return chain;
}

/** 清空审计：镜像与存储一并置空。 */
export async function clearAudit() {
  cache = [];
  try {
    await invoke("save_data", { key: AUDIT_KEY, data: [] });
  } catch {
    // 清空失败不回滚镜像：界面已按「已清空」呈现，回滚只会自相矛盾
  }
  return cache;
}

/** 供测试清理镜像与队列，避免跨用例状态泄漏。 */
export function __resetAudit() {
  cache = null;
  chain = Promise.resolve();
}
