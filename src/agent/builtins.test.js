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
