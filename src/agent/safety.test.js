import { it, expect } from 'vitest';
import { createBuiltinRegistry } from './builtins.js';
import { runAgent } from './runtime.js';

it('exposes a file write preview tool without side effects', async () => {
  const preview = createBuiltinRegistry().get('file.preview_write');
  expect(preview.risk).toBe('read');
  expect(preview.inputSchema.required).toEqual(['path', 'text']);
});

it('blocks SQL writes even if the model selects the readonly tool', async () => {
  const result = await runAgent('query', { registry: createBuiltinRegistry(), planner: async () => ({ type: 'tool_call', tool: 'db.query_readonly', args: { connId: '1', sql: 'UPDATE users SET name="x"' } }) });
  expect(result.status).toBe('failed');
  expect(result.error).toMatch(/只读/);
});
