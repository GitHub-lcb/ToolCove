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

describe("JSON 工作区标签操作", () => {
  it("创建默认活动标签", () => {
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

  it("新建继承偏好但固定为格式化模式", () => {
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

  it("使用最小未占用编号并保护上限", () => {
    const seed = workspaceWith(3);
    const withGap = {
      ...seed,
      tabs: seed.tabs.map((tab, index) => index === 1 ? { ...tab, title: "其他" } : tab),
    };
    expect(addJsonTab(withGap, {}, ids("id-4")).workspace.tabs[3].title).toBe("JSON 2");

    const full = workspaceWith(MAX_JSON_TABS);
    expect(addJsonTab(full, {}, ids("overflow"))).toEqual({
      ok: false,
      workspace: full,
      reason: "limit",
    });
  });

  it("切换与重命名返回明确结果且不修改输入图", () => {
    const original = workspaceWith(2);
    const switched = setActiveJsonTab(original, "id-1");
    expect(switched.workspace.activeId).toBe("id-1");
    expect(original.activeId).toBe("id-2");

    const renamed = renameJsonTab(switched.workspace, "id-1", "  用户详情  ");
    expect(renamed.workspace.tabs[0].title).toBe("用户详情");
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

  it("关闭活动标签右优先、末尾左兜底，并按原索引撤销", () => {
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

  it("保护最后标签和满额撤销", () => {
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

  it("异步结果只允许写回相同 ID 和源文本", () => {
    const workspace = createJsonWorkspace(ids("target"));
    const source = workspace.tabs[0].input;
    expect(canWriteJsonTab(workspace, "target", source).ok).toBe(true);
    expect(canWriteJsonTab(workspace, "missing", source)).toEqual({ ok: false, reason: "closed" });

    const changed = { ...workspace, tabs: [{ ...workspace.tabs[0], input: "changed" }] };
    expect(canWriteJsonTab(changed, "target", source)).toEqual({ ok: false, reason: "changed" });
  });

  it("关闭后按相同 ID 和源文本恢复时允许异步写回", () => {
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

describe("JSON 工具状态迁移与持久化", () => {
  it("迁移旧 JSON 与 YAML 单草稿", () => {
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

  it("保护未来版本并标记破坏性截断", () => {
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



  it("跨工具 JSON 在空工作区复用默认标签，在已有草稿时新建", () => {
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

  it("跨工具 JSON 不覆盖未来版本、破坏性状态或满额工作区", () => {
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

  it("按 UTF-8 字节判断 200KiB 边界", () => {
    const state = normalizeJsonToolState({}, ids("a")).state;
    state.jsonWorkspace.tabs[0].input = "中".repeat(Math.floor(MAX_PERSIST_BYTES / 3));
    expect(serializeJsonToolState(state).omittedTabIds).toEqual([]);

    state.jsonWorkspace.tabs[0].input += "中";
    expect(serializeJsonToolState(state)).toMatchObject({
      omittedTabIds: ["a"],
      value: { jsonWorkspace: { tabs: [{ input: "", inputOmitted: true }] } },
    });

    state.jsonWorkspace.tabs[0] = {
      ...state.jsonWorkspace.tabs[0],
      input: "𠮷".repeat(MAX_PERSIST_BYTES / 4),
      inputOmitted: false,
    };
    expect(serializeJsonToolState(state).omittedTabIds).toEqual([]);
    state.jsonWorkspace.tabs[0].input += "𠮷";
    expect(serializeJsonToolState(state).omittedTabIds).toEqual(["a"]);
  });

  it("恢复快照按外部时间排序并只保留三份", () => {
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
