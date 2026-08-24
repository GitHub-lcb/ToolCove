import { describe, expect, it } from "vitest";
import {
  MAX_JSON_TABS,
  MAX_PERSIST_BYTES,
  addJsonTab,
  appendJsonRecoverySnapshot,
  canWriteJsonTab,
  closeJsonTab,
  createJsonWorkspace,
  normalizeJsonToolState,
  prepareJsonHandoff,
  renameJsonTab,
  restoreJsonTab,
  serializeJsonToolState,
  setActiveJsonTab,
} from "./jsonWorkspace.js";

function ids(...values) {
  let index = 0;
  return () => values[index++] || "id-" + index;
}

function workspaceWith(count) {
  let workspace = createJsonWorkspace(ids("id-1"));
  for (let n = 2; n <= count; n += 1) {
    workspace = addJsonTab(workspace, {}, ids("id-" + n)).workspace;
  }
  return workspace;
}

describe("JSON workspace tab operations", () => {
  it("creates a default active tab", () => {
    expect(createJsonWorkspace(ids("tab-1"))).toEqual({
      activeId: "tab-1",
      tabs: [{
        id: "tab-1",
        title: "JSON 1",
        input: "",
        inputOmitted: false,
        mode: "format",
        indent: 2,
        autoFormat: false,
        showTypes: true,
      }],
    });
  });

  it("new tabs inherit preferences but are pinned to format mode", () => {
    const seed = createJsonWorkspace(ids("a"));
    const original = {
      ...seed,
      tabs: [{ ...seed.tabs[0], mode: "tree", indent: 4, autoFormat: true, showTypes: false }],
    };
    const result = addJsonTab(original, {}, ids("b"));

    expect(result).toMatchObject({ ok: true, tabId: "b" });
    expect(result.workspace.tabs[1]).toMatchObject({
      title: "JSON 2",
      mode: "format",
      indent: 4,
      autoFormat: true,
      showTypes: false,
    });
    expect(original.tabs).toHaveLength(1);
  });

  it("uses the smallest free number and guards the limit", () => {
    const seed = workspaceWith(3);
    const withGap = {
      ...seed,
      // tab title 其他 kept as unicode escapes
      tabs: seed.tabs.map((tab, index) => index === 1 ? { ...tab, title: "\u5176\u4ed6" } : tab),
    };
    expect(addJsonTab(withGap, {}, ids("id-4")).workspace.tabs[3].title).toBe("JSON 2");

    const full = workspaceWith(MAX_JSON_TABS);
    expect(addJsonTab(full, {}, ids("overflow"))).toEqual({
      ok: false,
      workspace: full,
      reason: "limit",
    });
  });

  it("switch and rename return explicit results without mutating the input", () => {
    const original = workspaceWith(2);
    const switched = setActiveJsonTab(original, "id-1");
    expect(switched.workspace.activeId).toBe("id-1");
    expect(original.activeId).toBe("id-2");

    // title 用户详情 kept as unicode escapes
    const renamed = renameJsonTab(switched.workspace, "id-1", "  \u7528\u6237\u8be6\u60c5  ");
    expect(renamed.workspace.tabs[0].title).toBe("\u7528\u6237\u8be6\u60c5");
    expect(switched.workspace.tabs[0].title).toBe("JSON 1");
    expect(renameJsonTab(switched.workspace, "id-1", "  ")).toEqual({
      ok: false,
      workspace: switched.workspace,
      reason: "empty-title",
    });
    expect(setActiveJsonTab(original, "missing")).toEqual({
      ok: false,
      workspace: original,
      reason: "not-found",
    });
  });

  it("closing prefers the right neighbour, falls back left at the end, and restores at the original index", () => {
    const workspace = workspaceWith(3);
    const middle = setActiveJsonTab(workspace, "id-2").workspace;
    const closed = closeJsonTab(middle, "id-2");
    expect(closed.workspace.activeId).toBe("id-3");
    expect(closed.closed).toMatchObject({ index: 1, tab: { id: "id-2" } });

    const restored = restoreJsonTab(closed.workspace, closed.closed);
    expect(restored.workspace.tabs.map((tab) => tab.id)).toEqual(["id-1", "id-2", "id-3"]);
    expect(restored.workspace.activeId).toBe("id-2");

    const lastActive = setActiveJsonTab(workspace, "id-3").workspace;
    expect(closeJsonTab(lastActive, "id-3").workspace.activeId).toBe("id-2");
  });

  it("guards the last tab and restore at the limit", () => {
    const single = createJsonWorkspace(ids("only"));
    expect(closeJsonTab(single, "only")).toEqual({
      ok: false,
      workspace: single,
      reason: "last-tab",
    });

    const full = workspaceWith(MAX_JSON_TABS);
    expect(restoreJsonTab(full, { index: 0, tab: { ...full.tabs[0], id: "closed" } })).toEqual({
      ok: false,
      workspace: full,
      reason: "limit",
    });
  });

  it("async results may only write back with the same id and source text", () => {
    const workspace = createJsonWorkspace(ids("target"));
    const source = workspace.tabs[0].input;
    expect(canWriteJsonTab(workspace, "target", source).ok).toBe(true);
    expect(canWriteJsonTab(workspace, "missing", source)).toEqual({ ok: false, reason: "closed" });

    const changed = { ...workspace, tabs: [{ ...workspace.tabs[0], input: "changed" }] };
    expect(canWriteJsonTab(changed, "target", source)).toEqual({ ok: false, reason: "changed" });
  });

  it("async write-back is allowed after restoring the same id and source text", () => {
    const sourceWorkspace = createJsonWorkspace(ids("target"));
    const sourceTab = sourceWorkspace.tabs[0];
    const withSecond = addJsonTab(sourceWorkspace, {}, ids("second")).workspace;
    const closed = closeJsonTab(withSecond, sourceTab.id);

    expect(canWriteJsonTab(closed.workspace, sourceTab.id, sourceTab.input)).toEqual({
      ok: false,
      reason: "closed",
    });
    const restored = restoreJsonTab(closed.workspace, closed.closed);
    expect(canWriteJsonTab(restored.workspace, sourceTab.id, sourceTab.input).ok).toBe(true);
  });
});

describe("JSON tool state migration and persistence", () => {
  it("migrates legacy JSON and YAML single drafts", () => {
    const json = normalizeJsonToolState({
      dataType: "json",
      input: "{\"a\":1}",
      mode: "tree",
      indent: 4,
      autoFormat: true,
      showTypes: false,
    }, ids("json-tab"));
    expect(json.state.jsonWorkspace.tabs[0]).toMatchObject({
      input: "{\"a\":1}",
      mode: "tree",
      indent: 4,
      autoFormat: true,
      showTypes: false,
    });

    const yaml = normalizeJsonToolState({
      dataType: "yaml",
      input: "a: 1",
      mode: "format",
      indent: 4,
      autoFormat: true,
      showTypes: false,
    }, ids("yaml-json-tab"));
    expect(yaml.state.yamlDraft).toEqual({
      input: "a: 1",
      mode: "format",
      indent: 4,
      showTypes: false,
    });
    expect(yaml.state.yamlDraft).not.toHaveProperty("autoFormat");

    const oldYamlMode = normalizeJsonToolState({ input: "b: 2", mode: "yaml" }, ids("old-yaml"));
    expect(oldYamlMode.state).toMatchObject({
      dataType: "yaml",
      yamlDraft: { input: "b: 2", mode: "to-json" },
    });
  });

  it("guards future versions and flags destructive truncation", () => {
    const future = { schemaVersion: 9, jsonWorkspace: { tabs: [{ input: "keep" }] } };
    expect(normalizeJsonToolState(future, ids("temp"))).toMatchObject({
      unsupportedVersion: true,
      raw: future,
    });

    const tabs = Array.from({ length: 12 }, (_, index) => ({
      id: index < 2 ? "dup" : "id-" + index,
      title: "T" + index,
      input: String(index),
    }));
    const normalized = normalizeJsonToolState({
      schemaVersion: 2,
      dataType: "json",
      jsonWorkspace: { activeId: "missing", tabs },
      yamlDraft: {},
    }, ids("new-1", "new-2"));
    expect(normalized.state.jsonWorkspace.tabs).toHaveLength(10);
    expect(new Set(normalized.state.jsonWorkspace.tabs.map((tab) => tab.id)).size).toBe(10);
    expect(normalized.state.jsonWorkspace.activeId).toBe(normalized.state.jsonWorkspace.tabs[0].id);
    expect(normalized.destructive).toBe(true);
    expect(normalized.warnings).toContain("tabs-truncated");
  });



  it("cross-tool JSON reuses the default tab in an empty workspace and adds one otherwise", () => {
    const empty = prepareJsonHandoff({}, '{"from":"request"}', ids("first"));
    expect(empty).toMatchObject({
      ok: true,
      value: {
        dataType: "json",
        jsonWorkspace: {
          activeId: "first",
          tabs: [{ id: "first", input: '{"from":"request"}', mode: "format" }],
        },
      },
    });

    const saved = normalizeJsonToolState({ input: '{"keep":true}' }, ids("keep")).state;
    const added = prepareJsonHandoff(saved, '{"new":true}', ids("new"));
    expect(added.ok).toBe(true);
    expect(added.value.jsonWorkspace.tabs.map((tab) => tab.input)).toEqual([
      '{"keep":true}',
      '{"new":true}',
    ]);
    expect(added.value.jsonWorkspace.activeId).toBe("new");

    const omittedState = {
      ...saved,
      jsonWorkspace: {
        ...saved.jsonWorkspace,
        tabs: [{ ...saved.jsonWorkspace.tabs[0], input: "", inputOmitted: true }],
      },
    };
    const preserved = prepareJsonHandoff(omittedState, '{"next":true}', ids("next"));
    expect(preserved.value.jsonWorkspace.tabs).toHaveLength(2);
    expect(preserved.value.jsonWorkspace.tabs[0]).toMatchObject({ input: "", inputOmitted: true });
    expect(preserved.value.jsonWorkspace.tabs[1].input).toBe('{"next":true}');
  });

  it("cross-tool JSON never overwrites future versions, destructive states or full workspaces", () => {
    expect(prepareJsonHandoff({ schemaVersion: 9 }, "{}", ids("future"))).toMatchObject({
      ok: false,
      reason: "unsupported-version",
    });
    expect(prepareJsonHandoff({
      schemaVersion: 2,
      dataType: "json",
      jsonWorkspace: { activeId: "a", tabs: [null, { id: "a", input: "keep" }] },
      yamlDraft: {},
    }, "{}", ids("repair"))).toMatchObject({ ok: false, reason: "recovery-required" });

    const full = { schemaVersion: 2, dataType: "json", jsonWorkspace: workspaceWith(MAX_JSON_TABS), yamlDraft: {} };
    expect(prepareJsonHandoff(full, "{}", ids("overflow"))).toMatchObject({
      ok: false,
      reason: "limit",
    });
  });

  it("judges the 200KiB boundary by UTF-8 bytes", () => {
    const state = normalizeJsonToolState({}, ids("a")).state;
    // 中 is a 3-byte UTF-8 char; kept as unicode escape
    state.jsonWorkspace.tabs[0].input = "\u4e2d".repeat(Math.floor(MAX_PERSIST_BYTES / 3));
    expect(serializeJsonToolState(state).omittedTabIds).toEqual([]);

    state.jsonWorkspace.tabs[0].input += "\u4e2d";
    expect(serializeJsonToolState(state)).toMatchObject({
      omittedTabIds: ["a"],
      value: { jsonWorkspace: { tabs: [{ input: "", inputOmitted: true }] } },
    });

    state.jsonWorkspace.tabs[0] = {
      ...state.jsonWorkspace.tabs[0],
      // 𠮷 is a 4-byte UTF-8 char; kept as a surrogate pair
      input: "\ud842\udfb7".repeat(MAX_PERSIST_BYTES / 4),
      inputOmitted: false,
    };
    expect(serializeJsonToolState(state).omittedTabIds).toEqual([]);
    state.jsonWorkspace.tabs[0].input += "\ud842\udfb7";
    expect(serializeJsonToolState(state).omittedTabIds).toEqual(["a"]);
  });

  it("recovery snapshots are ordered by external time and capped at three", () => {
    const snapshots = [1, 2, 3].map((capturedAt) => ({
      capturedAt,
      reason: "r" + capturedAt,
      source: { capturedAt },
    }));
    const result = appendJsonRecoverySnapshot(snapshots, {
      capturedAt: 4,
      reason: "r4",
      source: { capturedAt: 4 },
    });
    expect(result.map((item) => item.capturedAt)).toEqual([4, 3, 2]);
    expect(snapshots).toHaveLength(3);
  });
});
