import { it, expect } from 'vitest';
import { createBuiltinRegistry } from './builtins.js';
import { runAgent } from './runtime.js';

it('converts YAML, compares text, converts timestamps and generates identifiers', async () => {
  const r = createBuiltinRegistry();
  expect(JSON.parse(await r.get('yaml.to_json').execute({ text: 'name: ToolCove' }))).toEqual({ name: 'ToolCove' });
  expect(await r.get('text.diff').execute({ left: 'a', right: 'b' })).toMatchObject({ hasChanges: true });
  expect(await r.get('time.timestamp').execute({ text: '0', unit: 'seconds' })).toMatchObject({ milliseconds: 0 });
  const ids = await r.get('id.generate').execute({ type: 'uuid-v4', count: 2 });
  expect(ids).toHaveLength(2);
  expect(ids[0]).not.toBe(ids[1]);
});

it('publishes typed schemas and rejects oversized generation requests', async () => {
  const registry = createBuiltinRegistry();
  expect(registry.list().every(t => t.inputSchema.type === 'object' && t.inputSchema.additionalProperties === false)).toBe(true);
  const result = await runAgent('x', { registry, planner: async () => ({ type: 'tool_call', tool: 'id.generate', args: { type: 'uuid-v4', count: 10000000 } }) });
  expect(result.status).toBe('failed');
});

it('covers every toolbox capability with an agent tool', () => {
  const toolKeys = [...new Set(createBuiltinRegistry().list().map(t => t.toolKey))].sort();
  // chat 是面向人的对话界面，不作为 Agent 工具；其余工具箱能力都有对应工具
  expect(toolKeys).toEqual(['convert', 'crypto', 'db', 'diff', 'file', 'generator', 'image', 'json', 'network', 'request', 'time']);
});

it('hashes text and marks remote-capable tools with the right risk', async () => {
  const registry = createBuiltinRegistry();
  expect(await registry.get('crypto.hash').execute({ text: 'abc' })).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const { password } = await registry.get('crypto.password').execute({ length: 24 });
  expect(password).toHaveLength(24);
  expect(await registry.get('image.plan').execute({ width: 1920, height: 1080, maxWidth: 800 })).toMatchObject({ contain: { width: 800, height: 450 } });
  // 出站请求有副作用，必须走确认；网络诊断只读
  expect(registry.get('http.request').risk).toBe('write');
  expect(registry.get('network.ping').risk).toBe('read');
});
