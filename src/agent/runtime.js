/** 工具白名单与受控执行循环。 */
import { createApprovalPolicy } from "./approval.js";
import { GUARDED_TOOLS, OBSERVE_TOOLS, createObservationGate } from "./observation.js";

// 模型调用失败的重试预算。与工具重试（options.retries）是两件事——那个重试的是工具执行，
// 这个重试的是模型请求本身（限流、5xx、网络）。工具结果里的模型输出格式问题由 index.js 的
// repair 次数（MAX_REPAIR_ATTEMPTS）负责，两者互不替代。
const MAX_MODEL_ATTEMPTS = 3;
// 值得退避重试的模型调用错误码；AUTH / 配置类错误重试无意义。
const RETRYABLE_MODEL_CODES = Object.freeze(["RATE_LIMIT", "SERVER", "TIMEOUT", "TRANSPORT"]);
const MODEL_RETRY_BASE_MS = 500;
const MODEL_RETRY_MAX_MS = 5000;
// 同一次运行内允许连续拒绝多少次工具调用后收尾。模型每次都能换招；这里只是防它死磕。
const MAX_DENIALS_PER_RUN = 5;
// 拒绝后回灌给模型的反馈（模型据此换一条路，而不是原样重试）
const DENIED_FEEDBACK = '用户拒绝执行该工具调用（已记录审计事件）';

export function createToolRegistry(tools = []) {
  const map = new Map();
  for (const tool of tools) {
    if (!tool?.name || typeof tool.execute !== 'function') throw Error('Invalid tool definition');
    if (map.has(tool.name)) throw Error(`Duplicate tool: ${tool.name}`);
    map.set(tool.name, { risk: 'read', inputSchema: {}, ...tool });
  }
  return { get: name => map.get(name), list: () => [...map.values()].map(({ execute, ...info }) => info) };
}

export function validateArgs(schema = {}, value, path = 'args') {
  if (schema.type === 'object' || schema.properties || schema.required) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(`${path} 必须为对象`);
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key) || value[key] == null) throw Error(`Missing required argument: ${key}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(schema.properties || {}, key)) throw Error(`未知参数：${path}.${key}`);
      if (Object.hasOwn(schema.properties || {}, key)) validateArgs(schema.properties[key], item, `${path}.${key}`);
    }
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw Error(`${path} 必须为数组`);
    if (schema.maxItems && value.length > schema.maxItems) throw Error(`${path} 项目过多`);
    value.forEach((v, i) => validateArgs(schema.items || {}, v, `${path}[${i}]`));
  } else if (schema.type) {
    const valid = schema.type === 'integer' ? Number.isSafeInteger(value)
      : schema.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      : typeof value === schema.type;
    if (!valid) throw Error(`${path} 类型应为 ${schema.type}`);
  }
  if (schema.enum && !schema.enum.includes(value)) throw Error(`${path} 不在允许值中`);
  if (typeof value === 'string' && schema.maxLength && value.length > schema.maxLength) throw Error(`${path} 内容过长`);
  if (typeof value === 'number' && ((schema.minimum != null && value < schema.minimum) || (schema.maximum != null && value > schema.maximum))) throw Error(`${path} 超出范围`);
}
const bounded = (value, fallback, max) => Number.isInteger(value) && value > 0 ? Math.min(value, max) : fallback;
const abortError = () => Object.assign(Error('任务已停止'), { code: 'ABORTED' });

// 取消等待后忽略迟到结果；底层工具需遵守 signal 才可真正中止副作用。
function guarded(task, { signal, timeout, shouldStop }, label) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timer, poll, settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(poll);
      signal?.removeEventListener('abort', abort);
      fn(value);
    };
    const abort = () => { controller.abort(); finish(reject, abortError()); };
    if (signal?.aborted || shouldStop?.()) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (shouldStop) poll = setInterval(() => { if (shouldStop()) abort(); }, 50);
    timer = setTimeout(() => {
      controller.abort();
      finish(reject, Object.assign(Error(`${label}超时，已停止等待；请确认执行结果后再试`), { code: 'TIMEOUT' }));
    }, timeout);
    Promise.resolve().then(() => {
      if (controller.signal.aborted) throw abortError();
      return task(controller.signal);
    }).then(v => finish(resolve, v), e => finish(reject, e));
  });
}

/** 可中断的等待，用于模型调用退避重试。 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => { clearTimeout(timer); reject(abortError()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 带退避的模型调用：只对感知失败分类重试，其余（配置/鉴权）立刻抛出。 */
async function callModel(task, { signal, shouldStop, label, onRetry, timeouts }) {
  let lastError;
  for (let attempt = 0; attempt < MAX_MODEL_ATTEMPTS; attempt++) {
    try {
      return await guarded(task, { signal, shouldStop, timeout: timeouts.planner }, label);
    } catch (error) {
      lastError = error;
      const code = error?.code || '';
      if (code === 'ABORTED' || code === 'TIMEOUT' || !RETRYABLE_MODEL_CODES.includes(code)) throw error;
      const last = attempt === MAX_MODEL_ATTEMPTS - 1;
      if (last) throw error;
      const delay = Math.min(MODEL_RETRY_BASE_MS * 2 ** attempt, MODEL_RETRY_MAX_MS);
      await onRetry?.({ attempt: attempt + 1, code, delay, error: error.message || String(error) });
      await sleep(delay, signal);
    }
  }
  throw lastError;
}

export async function runAgent(input, options = {}) {
  const { registry, planner, signal, shouldStop } = options;
  if (!registry || typeof planner !== 'function') throw Error('registry and planner are required');
  const history = structuredClone(options.history || []);
  const maxSteps = bounded(options.maxSteps, 12, 50);
  const maxOutput = bounded(options.maxOutputLength, 32000, 100000);
  const emit = async event => { await options.onEvent?.(event); };
  const check = () => { if (signal?.aborted || shouldStop?.()) throw abortError(); };
  const wait = (fn, timeout, label) => guarded(fn, { signal, shouldStop, timeout }, label);
  const timeouts = {
    planner: bounded(options.plannerTimeoutMs, 120000, 300000),
    tool: bounded(options.toolTimeoutMs, 30000, 120000),
    confirm: 600000,
  };
  // 逐次批准：批准只对「这一次调用（工具名 + 参数）」有效，见 approval.js。
  const approval = options.approvalPolicy || createApprovalPolicy({ mode: options.requireConfirmation });
  // 读后写门禁：按本次运行记账，见 observation.js。
  const gate = options.observationGate || createObservationGate();
  let denials = 0;

  /** 询问人类并落审计事件。返回是否放行。 */
  async function requestApproval(message, meta, tool, args) {
    const { decision, id } = meta;
    await emit({ type: 'approval_asked', id, tool: tool.name, risk: tool.risk || '', reason: decision.reason, args });
    const approved = await wait(() => options.confirm?.(message, { ...meta, tool }) ?? false, timeouts.confirm, '等待确认');
    check();
    // 批准与拒绝都要记账：批准供同参数折叠，拒绝让同一调用不再被反复追问。
    approval.record(decision.collapseKey, !!approved);
    await emit({
      type: 'approval_decided',
      id,
      tool: tool.name,
      approved: !!approved,
      source: decision.source,
      reason: decision.reason,
      by: 'user',
    });
    return !!approved;
  }

  /** 执行一个工具，并按观察规则记账。 */
  async function runTool(tool, args) {
    if (GUARDED_TOOLS.includes(tool.name)) {
      const refusal = gate.check(tool.name, args);
      if (refusal) throw Object.assign(Error(refusal.message), { code: refusal.code });
    }
    try {
      const value = await wait(s => tool.execute(args, { signal: s }), timeouts.tool, '工具执行');
      if (OBSERVE_TOOLS.includes(tool.name)) {
        try {
          gate.observeSuccess(tool.name, args, value);
        } catch {
          // 记账失败不该让一次成功的工具调用变成失败
        }
      }
      return value;
    } catch (error) {
      if (OBSERVE_TOOLS.includes(tool.name)) {
        try {
          gate.observeFailure(tool.name, args, error);
        } catch {
          // 同上
        }
      }
      throw error;
    }
  }

  try {
    if (typeof input !== 'string' || !input.trim() || input.length > 64000) throw Error('请输入任务目标（最多 64000 字符）');
    for (let step = 0; step < maxSteps; step++) {
      check();
      await options.onCheckpoint?.({ type: 'planning', history });
      const action = await callModel(
        s => planner({ input, history, tools: registry.list(), step, signal: s }),
        {
          signal,
          shouldStop,
          label: '模型响应',
          timeouts,
          onRetry: async info => { await emit({ type: 'model_retry', code: info.code, attempt: info.attempt, delay: info.delay, error: info.error }); },
        }
      );
      check();
      if (!action || typeof action !== 'object') throw Error('模型未返回有效动作');
      if (action.type === 'final') {
        if (typeof action.answer !== 'string' || !action.answer.trim()) throw Error('模型未返回最终答案');
        await emit({ type: 'final', answer: action.answer.slice(0, maxOutput) });
        return { status: 'completed', answer: action.answer.slice(0, maxOutput), history };
      }
      if (action.type === 'ask_user') {
        if (typeof action.question !== 'string' || !action.question.trim()) throw Error('模型未提供问题');
        await options.onCheckpoint?.({ type: 'waiting', question: action.question, history });
        const answer = options.askUser
          ? await wait(() => options.askUser(action.question), timeouts.confirm, '等待回答')
          : await wait(() => options.confirm?.(action.question, action) ?? false, timeouts.confirm, '等待确认');
        check();
        if (answer == null || answer === false) return { status: 'cancelled', history };
        history.push({ action, answer });
        await emit({ type: 'confirmation', question: action.question, answer });
        continue;
      }
      if (action.type !== 'tool_call') throw Error(`Unknown action type: ${action.type}`);
      const tool = registry.get(action.tool);
      if (!tool) throw Error(`Unknown tool: ${action.tool}`);
      const args = action.args ?? {};
      if (JSON.stringify(args).length > 64000) throw Error('工具输入过大');
      validateArgs(tool.inputSchema, args);
      if (tool.name === 'db.query_readonly' && !/^(?:\s*(?:WITH|SELECT|SHOW|DESCRIBE|DESC)\b)/i.test(String(args.sql || ''))) throw Error('只读查询工具拒绝执行写入 SQL');
      const safeRisk = ['read', 'transform'].includes(tool.risk);
      const id = crypto.randomUUID();
      // 确认决策与「能不能重试」解耦：approval 决定要不要问人，safeRisk 决定能不能重试。
      // tool.confirm === 'always' 的工具（如 data.remove）不受策略影响：用户选了「从不确认」也要问。
      const decision = approval.decide(tool, args);
      // 已被拒绝过的同一调用：不重问、也不执行，直接把拒绝作为反馈回灌，避免拿同一张卡反复追问。
      if (decision.reason === 'denied-before') {
        denials += 1;
        history.push({ action: { ...action, id }, error: DENIED_FEEDBACK });
        if (denials >= MAX_DENIALS_PER_RUN) return { status: 'cancelled', history };
        continue;
      }
      if (decision.ask) {
        await options.onCheckpoint?.({ type: 'waiting', action, history });
        const approved = await requestApproval(`即将执行 ${tool.name}`, { action, tool, decision, id }, tool, args);
        if (!approved) {
          // 拒绝不终止整个任务：把拒绝作为反馈回灌，让模型换一条路。
          // 这一点与旧行为不同（旧行为直接 cancelled）——用户拒绝某个写入，不代表放弃整个目标。
          denials += 1;
          history.push({ action: { ...action, id }, error: DENIED_FEEDBACK });
          if (denials >= MAX_DENIALS_PER_RUN) return { status: 'cancelled', history };
          continue;
        }
      } else {
        // 没问人不等于没有决定：审计必须写出「是策略放行的」，而不是留空。
        // （旧实现只在问人时留痕，于是「谁放行的」这类问题在只读工具上得不到答案。）
        await emit({
          type: 'approval_decided',
          id,
          tool: tool.name,
          approved: true,
          source: decision.source,
          reason: decision.reason,
          by: 'policy',
        });
      }
      const retries = safeRisk && tool.retryable !== false ? Math.min(Math.max(Math.trunc(options.retries || 0), 0), 3) : 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        check();
        await emit({ type: 'tool_start', id, tool: tool.name, args, attempt: attempt + 1 });
        let value;
        try {
          value = await runTool(tool, args);
        } catch (error) {
          check();
          if (error.code === 'TIMEOUT' || error.code === 'ABORTED') throw error;
          if (attempt < retries) {
            await emit({ type: 'tool_retry', id, tool: tool.name, error: error.message || String(error), attempt: attempt + 1 });
            continue;
          }
          history.push({ action: { ...action, id }, error: error.message || String(error) });
          await emit({ type: 'tool_error', id, tool: tool.name, args, error: error.message || String(error), code: error.code || '' });
          return { status: 'failed', error: error.message || String(error), errorCode: error.code || '', history };
        }
        check();
        if (JSON.stringify(value ?? null).length > maxOutput) throw Error('工具结果过大，请缩小输入后重试');
        history.push({ action: { ...action, id }, result: value ?? null });
        await emit({ type: 'tool_result', id, tool: tool.name, args, result: value ?? null });
        break;
      }
    }
    return { status: 'max_steps', history };
  } catch (error) {
    return { status: error.code === 'ABORTED' ? 'cancelled' : 'failed', error: error.message || String(error), errorCode: error.code || '', history };
  }
}
