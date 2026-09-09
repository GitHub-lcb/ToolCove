import { it, expect, vi, describe } from 'vitest';

// 既有用例都传自己的 planner，不经过 aiComplete；mock 掉 ai.js 以便测默认 planner 的用量串联
vi.mock('../ai.js', () => ({ aiComplete: vi.fn() }));

import { aiComplete } from '../ai.js';
import { runAIAgent, createAIPlanner } from './index.js';
import { createToolRegistry } from './runtime.js';

const registry = createToolRegistry([{ name: 'echo', risk: 'transform', execute: ({ text }) => text }]);
it('checkpoints before execution and persists failed final state', async () => {
  const saved = [];
  const result = await runAIAgent('hello', { registry, planner: async () => { throw Error('offline'); }, onRun: async r => saved.push(structuredClone(r)) });
  expect(result.run.status).toBe('failed');
  expect(saved[0].status).toBe('pending');
  expect(saved.at(-1).error).toBe('offline');
  expect(saved.at(-1).finishedAt).toBeGreaterThan(0);
});
it('saves tool results incrementally and continues from saved results without replay', async () => {
  const saved = [];
  const actions = [{ type: 'tool_call', tool: 'echo', args: { text: 'value' } }, { type: 'final', answer: 'done' }];
  const first = await runAIAgent('hello', { registry, planner: async () => actions.shift(), onRun: r => saved.push(structuredClone(r)) });
  expect(saved.some(r => r.history?.[0]?.result === 'value')).toBe(true);
  const result = await runAIAgent('hello', { registry, resume: first.run, planner: async ({ history }) => {
    expect(history[0].result).toBe('value');
    return { type: 'final', answer: 'continued' };
  } });
  expect(result.run.parentId).toBe(first.run.id);
  expect(result.run.id).not.toBe(first.run.id);
});
it('does not resume redacted inputs or replay unknown side effects', async () => {
  const unsafe = { id: 'old', input: 'password=secret', history: [] };
  await expect(runAIAgent(unsafe.input, { registry, resume: unsafe, planner: async () => ({ type: 'final', answer: 'x' }) })).rejects.toThrow(/脱敏/);
});
it('refuses execution when the initial checkpoint cannot be saved', async () => {
  let called = false;
  await expect(runAIAgent('hello', { registry, planner: () => { called = true; }, onRun: async () => { throw Error('disk full'); } })).rejects.toThrow('disk full');
  expect(called).toBe(false);
});

describe('token 用量计量', () => {
  const USAGE = { promptTokens: 10, completionTokens: 4, totalTokens: 14 };

  it('createAIPlanner 把 onUsage 透传给 aiComplete，并解析围栏 JSON', async () => {
    aiComplete.mockResolvedValue('```json\n{"type":"final","answer":"ok"}\n```');
    const onUsage = vi.fn();
    const action = await createAIPlanner({ onUsage })({ input: 'x', history: [], tools: [] });
    expect(action).toEqual({ type: 'final', answer: 'ok' });
    expect(aiComplete).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ onUsage }));
  });

  it('未提供 onUsage 时按原样传模型选项，不塞多余字段', async () => {
    aiComplete.mockResolvedValue('{"type":"final","answer":"ok"}');
    await createAIPlanner({ modelOptions: { model: 'm' } })({ input: 'x', history: [], tools: [] });
    expect(aiComplete).toHaveBeenCalledWith(expect.any(String), { model: 'm' });
  });

  it('runAIAgent 把用量累加到 run、写进持久化快照并透传给调用方', async () => {
    aiComplete.mockImplementation(async (_prompt, opts) => {
      opts?.onUsage?.(USAGE);
      return '{"type":"final","answer":"done"}';
    });
    const saved = [];
    const seen = [];
    const result = await runAIAgent('hello', {
      registry,
      onRun: async (r) => saved.push(structuredClone(r)),
      onUsage: (usage, run) => seen.push({ usage, total: run.usage.totalTokens }),
    });
    expect(seen).toEqual([{ usage: USAGE, total: 14 }]);
    expect(result.run.usage).toEqual({ ...USAGE, calls: 1 });
    expect(result.answer).toBe('done');
    expect(saved.at(-1).usage).toEqual({ ...USAGE, calls: 1 });
  });

  it('多次模型调用累加 calls 与 tokens', async () => {
    let seen = 0;
    aiComplete.mockImplementation(async (_prompt, opts) => {
      opts?.onUsage?.(USAGE);
      seen += 1;
      return seen < 2
        ? '{"type":"tool_call","id":"1","tool":"echo","args":{"text":"hi"}}'
        : '{"type":"final","answer":"done"}';
    });
    const result = await runAIAgent('hello', { registry });
    expect(result.run.usage).toEqual({ promptTokens: 20, completionTokens: 8, totalTokens: 28, calls: 2 });
  });
});
