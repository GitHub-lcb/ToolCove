export const JSON_WORKSPACE_SCHEMA = 2;
export const MAX_JSON_TABS = 10;
export const MAX_PERSIST_BYTES = 200 * 1024;

const JSON_MODES = new Set(["format", "tree", "minify", "escape", "unescape", "to-yaml"]);
const YAML_MODES = new Set(["validate", "format", "tree", "to-json"]);
const encoder = new TextEncoder();

function nextId(idFactory, used = new Set()) {
  let id = "";
  do {
    id = String(idFactory());
  } while (!id || used.has(id));
  return id;
}

function nextTitle(tabs) {
  const used = new Set(tabs.map((tab) => tab.title));
  let index = 1;
  while (used.has("JSON " + index)) index += 1;
  return "JSON " + index;
}

function makeTab(id, title = "JSON 1", seed = {}) {
  return {
    id,
    title,
    input: typeof seed.input === "string" ? seed.input : "",
    inputOmitted: seed.inputOmitted === true,
    mode: JSON_MODES.has(seed.mode) ? seed.mode : "format",
    indent: seed.indent === 4 ? 4 : 2,
    autoFormat: seed.autoFormat === true,
    showTypes: seed.showTypes !== false,
  };
}

export function createJsonWorkspace(idFactory) {
  const tab = makeTab(nextId(idFactory));
  return { activeId: tab.id, tabs: [tab] };
}

function reject(workspace, reason) {
  return { ok: false, workspace, reason };
}

export function setActiveJsonTab(workspace, id) {
  if (!workspace.tabs.some((tab) => tab.id === id)) return reject(workspace, "not-found");
  return { ok: true, workspace: { ...workspace, activeId: id } };
}

export function addJsonTab(workspace, options = {}, idFactory) {
  if (workspace.tabs.length >= MAX_JSON_TABS) return reject(workspace, "limit");
  const active = workspace.tabs.find((tab) => tab.id === workspace.activeId) || workspace.tabs[0];
  const id = nextId(idFactory, new Set(workspace.tabs.map((tab) => tab.id)));
  const title = typeof options.title === "string" && options.title.trim()
    ? options.title.trim()
    : nextTitle(workspace.tabs);
  const tab = makeTab(id, title, {
    input: options.input,
    mode: "format",
    indent: options.indent ?? active?.indent,
    autoFormat: options.autoFormat ?? active?.autoFormat,
    showTypes: options.showTypes ?? active?.showTypes,
  });
  return {
    ok: true,
    tabId: id,
    workspace: { activeId: id, tabs: [...workspace.tabs, tab] },
  };
}

export function renameJsonTab(workspace, id, title) {
  const normalized = String(title ?? "").trim();
  if (!normalized) return reject(workspace, "empty-title");
  if (!workspace.tabs.some((tab) => tab.id === id)) return reject(workspace, "not-found");
  return {
    ok: true,
    workspace: {
      ...workspace,
      tabs: workspace.tabs.map((tab) => tab.id === id ? { ...tab, title: normalized } : tab),
    },
  };
}

export function closeJsonTab(workspace, id) {
  if (workspace.tabs.length === 1) return reject(workspace, "last-tab");
  const index = workspace.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return reject(workspace, "not-found");
  const tab = workspace.tabs[index];
  const tabs = workspace.tabs.filter((item) => item.id !== id);
  const activeId = workspace.activeId === id
    ? tabs[Math.min(index, tabs.length - 1)].id
    : workspace.activeId;
  return { ok: true, closed: { tab, index }, workspace: { activeId, tabs } };
}

export function restoreJsonTab(workspace, closed) {
  if (workspace.tabs.length >= MAX_JSON_TABS) return reject(workspace, "limit");
  if (!closed?.tab?.id || workspace.tabs.some((tab) => tab.id === closed.tab.id)) {
    return reject(workspace, "duplicate");
  }
  const index = Math.min(Math.max(Number(closed.index) || 0, 0), workspace.tabs.length);
  const tabs = [...workspace.tabs];
  tabs.splice(index, 0, { ...closed.tab });
  return { ok: true, workspace: { activeId: closed.tab.id, tabs } };
}

export function canWriteJsonTab(workspace, id, source) {
  const tab = workspace.tabs.find((item) => item.id === id);
  if (!tab) return { ok: false, reason: "closed" };
  if (tab.input !== source) return { ok: false, reason: "changed" };
  return { ok: true, tab };
}

function normalizeYamlDraft(value = {}) {
  return {
    input: typeof value.input === "string" ? value.input : "",
    mode: YAML_MODES.has(value.mode) ? value.mode : "validate",
    indent: value.indent === 4 ? 4 : 2,
    showTypes: value.showTypes !== false,
  };
}

function defaultState(idFactory) {
  return {
    schemaVersion: JSON_WORKSPACE_SCHEMA,
    dataType: "json",
    jsonWorkspace: createJsonWorkspace(idFactory),
    yamlDraft: normalizeYamlDraft(),
  };
}

function normalizeV2(saved, idFactory) {
  const warnings = [];
  const sourceTabs = Array.isArray(saved?.jsonWorkspace?.tabs)
    ? saved.jsonWorkspace.tabs
    : [];
  const used = new Set();
  let dropped = false;
  const tabs = sourceTabs.slice(0, MAX_JSON_TABS).flatMap((source, index) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) {
      dropped = true;
      return [];
    }
    let id = typeof source.id === "string" ? source.id : "";
    if (!id || used.has(id)) {
      id = nextId(idFactory, used);
      warnings.push("id-repaired");
    }
    used.add(id);
    const title = typeof source.title === "string" && source.title.trim()
      ? source.title.trim()
      : "JSON " + (index + 1);
    return [makeTab(id, title, source)];
  });

  if (sourceTabs.length > MAX_JSON_TABS) warnings.push("tabs-truncated");
  if (dropped) warnings.push("invalid-tabs-dropped");
  if (!tabs.length) {
    tabs.push(makeTab(nextId(idFactory, used)));
    warnings.push("empty-workspace-repaired");
  }

  const requestedActive = saved?.jsonWorkspace?.activeId;
  const activeId = tabs.some((tab) => tab.id === requestedActive)
    ? requestedActive
    : tabs[0].id;
  if (activeId !== requestedActive) warnings.push("active-id-repaired");

  return {
    state: {
      schemaVersion: JSON_WORKSPACE_SCHEMA,
      dataType: saved.dataType === "yaml" ? "yaml" : "json",
      jsonWorkspace: { activeId, tabs },
      yamlDraft: normalizeYamlDraft(saved.yamlDraft),
    },
    warnings,
    destructive: sourceTabs.length > MAX_JSON_TABS || dropped,
    unsupportedVersion: false,
    raw: saved,
  };
}

function migrateLegacy(saved, idFactory) {
  const state = defaultState(idFactory);
  const legacyYaml = saved?.dataType === "yaml"
    || (saved?.dataType !== "json" && saved?.mode === "yaml");

  if (legacyYaml) {
    state.dataType = "yaml";
    state.yamlDraft = normalizeYamlDraft({
      input: saved?.input,
      mode: saved?.mode === "yaml" ? "to-json" : saved?.mode,
      indent: saved?.indent,
      showTypes: saved?.showTypes,
    });
  } else {
    state.jsonWorkspace.tabs[0] = makeTab(
      state.jsonWorkspace.activeId,
      "JSON 1",
      saved || {},
    );
  }

  return {
    state,
    warnings: ["legacy-migrated"],
    destructive: false,
    unsupportedVersion: false,
    raw: saved,
  };
}

export function normalizeJsonToolState(saved, idFactory) {
  if (saved?.schemaVersion > JSON_WORKSPACE_SCHEMA) {
    return {
      state: defaultState(idFactory),
      warnings: ["unsupported-version"],
      destructive: false,
      unsupportedVersion: true,
      raw: saved,
    };
  }
  if (saved?.schemaVersion === JSON_WORKSPACE_SCHEMA) {
    return normalizeV2(saved, idFactory);
  }
  return migrateLegacy(saved && typeof saved === "object" ? saved : {}, idFactory);
}

export function prepareJsonHandoff(saved, text, idFactory) {
  const normalized = normalizeJsonToolState(saved, idFactory);
  if (normalized.unsupportedVersion) {
    return { ok: false, reason: "unsupported-version" };
  }
  if (normalized.destructive) {
    return { ok: false, reason: "recovery-required" };
  }

  const state = normalized.state;
  const tabs = state.jsonWorkspace.tabs;
  let workspace;
  if (tabs.length === 1 && tabs[0].input === "" && !tabs[0].inputOmitted) {
    workspace = {
      activeId: tabs[0].id,
      tabs: [{
        ...tabs[0],
        input: String(text ?? ""),
        inputOmitted: false,
        mode: "format",
      }],
    };
  } else {
    const added = addJsonTab(
      state.jsonWorkspace,
      { input: String(text ?? "") },
      idFactory,
    );
    if (!added.ok) return { ok: false, reason: added.reason };
    workspace = added.workspace;
  }

  return {
    ok: true,
    value: {
      ...state,
      dataType: "json",
      jsonWorkspace: workspace,
    },
  };
}

export function serializeJsonToolState(state) {
  const omittedTabIds = [];
  const tabs = state.jsonWorkspace.tabs.map((tab) => {
    const oversized = encoder.encode(tab.input).byteLength > MAX_PERSIST_BYTES;
    const omitted = oversized || (tab.inputOmitted === true && tab.input === "");
    if (omitted) omittedTabIds.push(tab.id);
    return {
      ...tab,
      input: omitted ? "" : tab.input,
      inputOmitted: omitted,
    };
  });

  return {
    omittedTabIds,
    value: {
      schemaVersion: JSON_WORKSPACE_SCHEMA,
      dataType: state.dataType,
      jsonWorkspace: {
        activeId: state.jsonWorkspace.activeId,
        tabs,
      },
      yamlDraft: normalizeYamlDraft(state.yamlDraft),
    },
  };
}

export function appendJsonRecoverySnapshot(existing, snapshot) {
  const valid = Array.isArray(existing)
    ? existing.filter((item) => item && Number.isFinite(item.capturedAt) && "source" in item)
    : [];
  return [...valid, { ...snapshot }]
    .sort((left, right) => right.capturedAt - left.capturedAt)
    .slice(0, 3);
}
