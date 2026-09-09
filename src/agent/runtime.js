/** 工具白名单与受控执行循环。 */
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

export async function runAgent(input, options = {}) {
  const { registry, planner, signal, shouldStop } = options;
  if (!registry || typeof planner !== 'function') throw Error('registry and planner are required');
  const history = structuredClone(options.history || []);
  const maxSteps = bounded(options.maxSteps, 12, 50);
  const maxOutput = bounded(options.maxOutputLength, 32000, 100000);
  const emit = async event => { await options.onEvent?.(event); };
  const check = () => { if (signal?.aborted || shouldStop?.()) throw abortError(); };
  const wait = (fn, timeout, label) => guarded(fn, { signal, shouldStop, timeout }, label);
  try {
    if (typeof input !== 'string' || !input.trim() || input.length > 64000) throw Error('请输入任务目标（最多 64000 字符）');
    for (let step = 0; step < maxSteps; step++) {
      check();
      await options.onCheckpoint?.({ type: 'planning', history });
      const action = await wait(s => planner({ input, history, tools: registry.list(), step, signal: s }), bounded(options.plannerTimeoutMs, 120000, 300000), '模型响应');
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
          ? await wait(() => options.askUser(action.question), 600000, '等待回答')
          : await wait(() => options.confirm?.(action.question, action) ?? false, 600000, '等待确认');
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
      // 确认策略与风险解耦：mode 决定「要不要问用户」，safeRisk 继续决定「能不能重试」。
      // 不传 requireConfirmation 时落到 'risky'，与引入该选项前的行为完全一致。
      const mode = ['always', 'never'].includes(options.requireConfirmation) ? options.requireConfirmation : 'risky';
      const needsConfirm = mode === 'always' ? true : mode === 'never' ? false : !safeRisk;
      if (needsConfirm) {
        await options.onCheckpoint?.({ type: 'waiting', action, history });
        const approved = await wait(() => options.confirm?.(`即将执行 ${tool.name}`, { action, tool }) ?? false, 600000, '等待确认');
        check();
        if (!approved) return { status: 'cancelled', history };
      }
      const id = crypto.randomUUID();
      const retries = safeRisk && tool.retryable !== false ? Math.min(Math.max(Math.trunc(options.retries || 0), 0), 3) : 0;
      for (let attempt = 0; attempt <= retries; attempt++) {
        check();
        await emit({ type: 'tool_start', id, tool: tool.name, args, attempt: attempt + 1 });
        let value;
        try {
          value = await wait(s => tool.execute(args, { signal: s }), bounded(options.toolTimeoutMs, 30000, 120000), '工具执行');
        } catch (error) {
          check();
          if (error.code === 'TIMEOUT' || error.code === 'ABORTED') throw error;
          if (attempt < retries) {
            await emit({ type: 'tool_retry', id, tool: tool.name, error: error.message || String(error), attempt: attempt + 1 });
            continue;
          }
          history.push({ action: { ...action, id }, error: error.message || String(error) });
          await emit({ type: 'tool_error', id, tool: tool.name, args, error: error.message || String(error) });
          return { status: 'failed', error: error.message || String(error), history };
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
    return { status: error.code === 'ABORTED' ? 'cancelled' : 'failed', error: error.message || String(error), history };
  }
}
