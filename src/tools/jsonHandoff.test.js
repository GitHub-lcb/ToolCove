import { describe, expect, it } from "vitest";
import { createJsonHandoffQueue, createJsonHandoffReceiver } from "./jsonHandoff.js";
import { prepareJsonHandoff } from "./jsonWorkspace.js";

function ids(...values) {
  let index = 0;
  return () => values[index++] || "id-" + index;
}

describe("cross-tool JSON handoff queue", () => {
  it("serializes concurrent handoffs and keeps both contents", async () => {
    let persisted = { input: '{"base":true}', mode: "format" };
    let opened = 0;
    const run = createJsonHandoffQueue({
      loadState: async () => structuredClone(persisted),
      saveState: async (value) => {
        await Promise.resolve();
        persisted = structuredClone(value);
        return { ok: true };
      },
      prepareState: prepareJsonHandoff,
      idFactory: ids("base", "second", "third"),
      onOpen: () => { opened += 1; },
    });

    const results = await Promise.all([
      run('{"second":true}'),
      run('{"third":true}'),
    ]);

    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(persisted.jsonWorkspace.tabs.map((tab) => tab.input)).toEqual([
      '{"base":true}',
      '{"second":true}',
      '{"third":true}',
    ]);
    expect(opened).toBe(2);
  });

  it("does not open the tool when saving fails and reports the reason", async () => {
    const reasons = [];
    let opened = 0;
    const run = createJsonHandoffQueue({
      loadState: async () => ({}),
      saveState: async () => ({ ok: false, error: new Error("disk") }),
      prepareState: prepareJsonHandoff,
      idFactory: ids("first"),
      onOpen: () => { opened += 1; },
      onError: (reason) => reasons.push(reason),
    });

    await expect(run("{}")).resolves.toMatchObject({ ok: false, reason: "save-failed" });
    expect(opened).toBe(0);
    expect(reasons).toEqual(["save-failed"]);
  });

  it("treats only phase=load as a read failure", async () => {
    const reasons = [];
    let saves = 0;
    const runAfterMigrationFailure = createJsonHandoffQueue({
      loadState: async (onError) => {
        onError({ phase: "save", error: new Error("migration") });
        return {};
      },
      saveState: async () => { saves += 1; return { ok: true }; },
      prepareState: prepareJsonHandoff,
      idFactory: ids("migrated"),
      onOpen: () => {},
      onError: (reason) => reasons.push(reason),
    });
    await expect(runAfterMigrationFailure("{}")).resolves.toEqual({ ok: true });
    expect(saves).toBe(1);
    expect(reasons).toEqual([]);

    const runAfterReadFailure = createJsonHandoffQueue({
      loadState: async (onError) => {
        onError({ phase: "load", error: new Error("read") });
        return {};
      },
      saveState: async () => { throw new Error("must not save"); },
      prepareState: prepareJsonHandoff,
      idFactory: ids("unread"),
      onOpen: () => {},
      onError: (reason) => reasons.push(reason),
    });
    await expect(runAfterReadFailure("{}")).resolves.toEqual({ ok: false, reason: "load-failed" });
    expect(reasons).toEqual(["load-failed"]);
  });
});

describe("cross-window JSON handoff receiver", () => {
  it("cancels the old pending state via an immediate save, then applies the new state", async () => {
    const order = [];
    let applied = null;
    const receive = createJsonHandoffReceiver({
      normalizeState: (value) => ({ state: value, unsupportedVersion: false, destructive: false }),
      persistState: async (value) => { order.push("persist"); return { ok: true, value }; },
      applyState: (value) => { order.push("apply"); applied = value; },
      onError: () => {},
    });
    const payload = { schemaVersion: 2, dataType: "json" };

    await expect(receive(payload)).resolves.toEqual({ ok: true });
    expect(order).toEqual(["persist", "apply"]);
    expect(applied).toBe(payload);
  });



  it("completes persist and apply serially for concurrent events", async () => {
    const order = [];
    const receive = createJsonHandoffReceiver({
      normalizeState: (value) => ({ state: value, unsupportedVersion: false, destructive: false }),
      persistState: async (value) => {
        order.push("persist-start-" + value.id);
        await Promise.resolve();
        order.push("persist-end-" + value.id);
        return { ok: true };
      },
      applyState: (value) => order.push("apply-" + value.id),
      onError: () => {},
    });

    await Promise.all([receive({ id: "a" }), receive({ id: "b" })]);
    expect(order).toEqual([
      "persist-start-a",
      "persist-end-a",
      "apply-a",
      "persist-start-b",
      "persist-end-b",
      "apply-b",
    ]);
  });

  it("rejects future versions, destructive payloads and receiver save failures", async () => {
    const reasons = [];
    let applied = 0;
    const receive = createJsonHandoffReceiver({
      normalizeState: (value) => value,
      persistState: async () => ({ ok: false, error: new Error("disk") }),
      applyState: () => { applied += 1; },
      onError: (reason) => reasons.push(reason),
    });

    await expect(receive({ unsupportedVersion: true })).resolves.toEqual({ ok: false, reason: "invalid-state" });
    await expect(receive({ destructive: true })).resolves.toEqual({ ok: false, reason: "invalid-state" });
    await expect(receive({ state: { schemaVersion: 2 } })).resolves.toMatchObject({ ok: false, reason: "save-failed" });
    expect(applied).toBe(0);
    expect(reasons).toEqual(["invalid-state", "invalid-state", "save-failed"]);
  });
});
