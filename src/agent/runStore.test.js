import { describe, expect, it } from "vitest";
import { createRun, appendStep, sanitizeRun, addUsage } from "./runStore.js";

describe("agent run store", () => {
  it("tracks pending and completed steps", () => {
    const run = createRun("demo");
    expect(run.status).toBe("pending");
    appendStep(run, { status: "running", tool: "json.parse", args: { token: "secret" } });
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].status).toBe("running");
  });
  it("redacts sensitive values", () => {
    const safe = sanitizeRun({ args: { apiKey: "abc", nested: { password: "pw" } } });
    expect(safe.args.apiKey).toBe("[REDACTED]");
    expect(safe.args.nested.password).toBe("[REDACTED]");
  });
  it('redacts JSON strings, auth headers, URL passwords and repeated secrets without mutating input', () => {
    const raw = { input: 'password="two words"', args: { text: '{"apiKey":"local-secret"}' }, result: 'local-secret', headers: [{ key: 'Authorization', value: 'Bearer abcdef' }], url: 'https://user:pwd@example.com/?access_token=private' };
    const text = JSON.stringify(sanitizeRun(raw));
    for (const secret of ['two words', 'local-secret', 'abcdef', ':pwd@', '=private']) expect(text).not.toContain(secret);
    expect(raw.result).toBe('local-secret');
  });
  it("createRun 初始化零用量", () => {
    expect(createRun("demo").usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 });
  });
  it("addUsage 就地累加并刷新 updatedAt", () => {
    const run = createRun("demo");
    run.updatedAt = 0;
    expect(addUsage(run, { promptTokens: 10, completionTokens: 4, totalTokens: 14 }))
      .toEqual({ promptTokens: 10, completionTokens: 4, totalTokens: 14, calls: 1 });
    expect(run.usage.calls).toBe(1);
    expect(run.updatedAt).toBeGreaterThan(0);
    addUsage(run, { promptTokens: 1, completionTokens: 1, totalTokens: 2 });
    expect(run.usage).toEqual({ promptTokens: 11, completionTokens: 5, totalTokens: 16, calls: 2 });
  });
  it("旧的已存 run 没有 usage 字段也能累加，因此不需要数据迁移", () => {
    const legacy = { id: "old", input: "x", steps: [], history: [] };
    expect(addUsage(legacy, { totalTokens: 5 }).totalTokens).toBe(5);
    expect(legacy.usage.calls).toBe(1);
    expect(addUsage(null, { totalTokens: 5 })).toBeNull();
  });
});
