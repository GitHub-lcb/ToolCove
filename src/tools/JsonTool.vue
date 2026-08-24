<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import { useI18n } from "vue-i18n";
import { formatJson, minifyJson, escapeJson, unescapeJson, parseJson, jsonStats, maskJsonText } from "./json.js";
import { formatYaml, jsonToYaml, lintYaml, parseYaml, yamlToJson } from "./yaml.js";
import { buildTree, searchTree, flattenTree, defaultExpanded, allContainerIds, primitivePreview, typeLabel } from "./jsonTree.js";
import { highlightLines } from "./jsonHighlight.js";
import { listen } from "@tauri-apps/api/event";
import { createJsonHandoffReceiver, JSON_HANDOFF_EVENT } from "./jsonHandoff.js";
import {
  addJsonTab,
  appendJsonRecoverySnapshot,
  canWriteJsonTab,
  closeJsonTab,
  createJsonWorkspace,
  normalizeJsonToolState,
  renameJsonTab,
  restoreJsonTab,
  serializeJsonToolState,
  setActiveJsonTab,
} from "./jsonWorkspace.js";
import { relativeTime } from "../shared.js";
import { isAIConfigured, aiRepairJson, aiMockJson } from "../ai.js";
import { loadToolbox, saveToolbox, saveToolboxNow, flushToolbox } from "../toolboxStore.js";
import Icon from "../Icon.vue";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const { t } = useI18n();

const HIST_MAX = 10;
const HIST_ITEM_MAX = 50 * 1024; // 单条历史最多存 50KB
const HL_MAX = 150 * 1024; // 输出超过 150KB 不做语法高亮（退化为纯文本）

const DATA_TYPES = [
  { key: "json", label: "JSON" },
  { key: "yaml", label: "YAML" },
];
const JSON_MODES = [
  { key: "format", labelKey: "toolbox.json.modeFormat" },
  { key: "tree", labelKey: "toolbox.json.modeTree" },
  { key: "minify", labelKey: "toolbox.json.modeMinify" },
  { key: "escape", labelKey: "toolbox.json.modeEscape" },
  { key: "unescape", labelKey: "toolbox.json.modeUnescape" },
  { key: "to-yaml", labelKey: "toolbox.json.modeToYaml" },
];
const YAML_MODES = [
  { key: "validate", labelKey: "toolbox.json.modeValidate" },
  { key: "format", labelKey: "toolbox.json.modeFormat", titleKey: "toolbox.json.yamlFormatTip" },
  { key: "tree", labelKey: "toolbox.json.modeTree" },
  { key: "to-json", labelKey: "toolbox.json.modeToJson" },
];

// 快捷示例
const SAMPLES = [
  {
    key: "user",
    labelKey: "toolbox.json.sampleUser",
    text: JSON.stringify({
      code: 200,
      data: {
        user: {
          id: 101,
          name: "ToolCove",
          role: "admin",
          skills: ["Vue", "Tauri", "Rust"],
          active: true,
          createdAt: "2024-05-20T10:30:00Z",
        },
      },
      message: "ok",
    }),
  },
  {
    key: "list",
    labelKey: "toolbox.json.sampleList",
    text: JSON.stringify({
      total: 3,
      items: [
        { id: 1, title: "Code review", done: true },
        { id: 2, title: "API testing", done: false },
        { id: 3, title: "Release", done: false },
      ],
      page: 1,
      pageSize: 20,
    }),
  },
  {
    key: "api",
    labelKey: "toolbox.json.sampleApi",
    text: JSON.stringify({
      stat: {
        _apiUUID: "db5b706a-3816-4642-9d23-b2bd2555d6aa",
        _mt: "invoicemanager.service.v2.autoMatchData",
        code: 0,
        notificationList: [
          { key: "output", value: "[2091]" },
          { key: "dubbo", value: "[2.0.2]" },
        ],
        stateList: [{ code: 0, defaultTip: "Success", length: 480, msg: "SUCCESS_0" }],
        systime: 1785318116516,
      },
      content: [{ id: 1, name: "Sample item", enabled: true, tags: ["a", "b"] }],
    }),
  },
  {
    key: "sensitive",
    labelKey: "toolbox.json.sampleSensitive",
    text: JSON.stringify({
      code: 200,
      data: {
        userId: 100238,
        name: "Sample User",
        phone: "13812345678",
        email: "user@example.com",
        idCard: "110101199001011234",
        bankCard: "6222021234567890123",
        password: "MyP@ssw0rd123",
        token: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        salary: 25000,
        address: "88 Sample Road, Sample City",
        loginIp: "192.0.2.100",
      },
      message: "ok",
    }),
  },
  {
    key: "yaml",
    labelKey: "toolbox.json.sampleYaml",
    dataType: "yaml",
    text: [
      "# Service config example",
      "server:",
      "  host: 0.0.0.0",
      "  port: 8080",
      "database:",
      "  type: mysql",
      "  name: dev_db",
      "  pool:",
      "    max: 10",
      "    idle: 2",
      "features:",
      "  - login",
      "  - order",
      "enabled: true",
    ].join("\n"),
  },
  {
    key: "yaml-compose",
    labelKey: "toolbox.json.sampleYamlCompose",
    dataType: "yaml",
    text: [
      "# docker-compose style deployment config",
      "version: \"3.8\"",
      "services:",
      "  web:",
      "    image: nginx:1.25",
      "    ports:",
      "      - \"8080:80\"",
      "    environment:",
      "      - TZ=Asia/Shanghai",
      "      - LOG_LEVEL=info",
      "    depends_on:",
      "      - db",
      "  db:",
      "    image: mysql:8.0",
      "    environment:",
      "      MYSQL_ROOT_PASSWORD: \"******\"",
      "    volumes:",
      "      - db_data:/var/lib/mysql",
      "volumes:",
      "  db_data: {}",
    ].join("\n"),
  },
];

const idFactory = () => crypto.randomUUID();
const toolState = ref({
  schemaVersion: 2,
  dataType: "json",
  jsonWorkspace: createJsonWorkspace(idFactory),
  yamlDraft: { input: "", mode: "validate", indent: 2, showTypes: true },
});
const hydrated = ref(false);
const persistenceBlocked = ref(false);
const omittedWarned = new Set();
let persistenceWarned = false;
let disposed = false;
let stopPersist = null;
let unlistenJsonHandoff = null;
let pendingHandoffState = null;

const dataType = computed({
  get: () => toolState.value.dataType,
  set: (value) => { toolState.value = { ...toolState.value, dataType: value }; },
});
const activeTab = computed(() =>
  toolState.value.jsonWorkspace.tabs.find((tab) => tab.id === toolState.value.jsonWorkspace.activeId)
  || toolState.value.jsonWorkspace.tabs[0]
);

function patchActiveTab(patch) {
  const activeId = toolState.value.jsonWorkspace.activeId;
  toolState.value = {
    ...toolState.value,
    jsonWorkspace: {
      ...toolState.value.jsonWorkspace,
      tabs: toolState.value.jsonWorkspace.tabs.map((tab) =>
        tab.id === activeId ? { ...tab, ...patch } : tab
      ),
    },
  };
}

const input = computed({
  get: () => dataType.value === "json" ? activeTab.value.input : toolState.value.yamlDraft.input,
  set: (value) => {
    if (dataType.value === "json") patchActiveTab({ input: value, inputOmitted: false });
    else toolState.value = { ...toolState.value, yamlDraft: { ...toolState.value.yamlDraft, input: value } };
  },
});
const mode = computed({
  get: () => dataType.value === "json" ? activeTab.value.mode : toolState.value.yamlDraft.mode,
  set: (value) => {
    if (dataType.value === "json") patchActiveTab({ mode: value });
    else toolState.value = { ...toolState.value, yamlDraft: { ...toolState.value.yamlDraft, mode: value } };
  },
});
const indent = computed({
  get: () => dataType.value === "json" ? activeTab.value.indent : toolState.value.yamlDraft.indent,
  set: (value) => {
    if (dataType.value === "json") patchActiveTab({ indent: value });
    else toolState.value = { ...toolState.value, yamlDraft: { ...toolState.value.yamlDraft, indent: value } };
  },
});
const autoFormat = computed({
  get: () => activeTab.value.autoFormat,
  set: (value) => patchActiveTab({ autoFormat: value }),
});
const showTypes = computed({
  get: () => dataType.value === "json" ? activeTab.value.showTypes : toolState.value.yamlDraft.showTypes,
  set: (value) => {
    if (dataType.value === "json") patchActiveTab({ showTypes: value });
    else toolState.value = { ...toolState.value, yamlDraft: { ...toolState.value.yamlDraft, showTypes: value } };
  },
});

const taRef = ref(null);
const gutterRef = ref(null);
const fileRef = ref(null);
const cursor = ref({ line: 1, col: 1 });
const aiFixing = ref(false); // AI 修复进行中
// 历史记录
const history = ref([]); // [{ text, ts, dataType, mode }]
const historyOpen = ref(false);
const histWrap = ref(null);
const renameRef = ref(null);
const editingTabId = ref("");
const editingTitle = ref("");

function finalizeCurrentBeforeSwitch() {
  if (dataType.value === "json" && autoFormat.value) applyFormat();
  pushHistory();
}

function switchJsonTab(id) {
  if (id === toolState.value.jsonWorkspace.activeId) return;
  finalizeCurrentBeforeSwitch();
  const result = setActiveJsonTab(toolState.value.jsonWorkspace, id);
  if (!result.ok) return;
  toolState.value = {
    ...toolState.value,
    dataType: "json",
    jsonWorkspace: result.workspace,
  };
  resetTransientState();
}

function createTab(options = {}) {
  if (dataType.value === "json") finalizeCurrentBeforeSwitch();
  const result = addJsonTab(toolState.value.jsonWorkspace, options, idFactory);
  if (!result.ok) {
    props.showToast(t("toolbox.json.tabLimit"));
    return false;
  }
  toolState.value = {
    ...toolState.value,
    dataType: "json",
    jsonWorkspace: result.workspace,
  };
  resetTransientState();
  return true;
}

function setRenameRef(element) {
  renameRef.value = element;
}

function beginRename(tab) {
  editingTabId.value = tab.id;
  editingTitle.value = tab.title;
  nextTick(() => renameRef.value?.select());
}

function cancelRename() {
  editingTabId.value = "";
  editingTitle.value = "";
}

function commitRename() {
  if (!editingTabId.value) return;
  const result = renameJsonTab(
    toolState.value.jsonWorkspace,
    editingTabId.value,
    editingTitle.value,
  );
  if (result.ok) {
    toolState.value = { ...toolState.value, jsonWorkspace: result.workspace };
  }
  cancelRename();
}

function closeTab(id) {
  const wasActive = id === toolState.value.jsonWorkspace.activeId;
  const result = closeJsonTab(toolState.value.jsonWorkspace, id);
  if (!result.ok) {
    if (result.reason === "last-tab") {
      props.showToast(t("toolbox.json.lastTab"));
    }
    return;
  }
  toolState.value = { ...toolState.value, jsonWorkspace: result.workspace };
  if (wasActive) resetTransientState();
  props.showToast(t("toolbox.json.closedTab", { title: result.closed.tab.title }), {
    actionLabel: t("toolbox.json.undo"),
    duration: 5000,
    onAction: () => {
      const restored = restoreJsonTab(toolState.value.jsonWorkspace, result.closed);
      if (!restored.ok) {
        props.showToast(t("toolbox.json.undoTabFull"));
        return;
      }
      toolState.value = {
        ...toolState.value,
        dataType: "json",
        jsonWorkspace: restored.workspace,
      };
      resetTransientState();
      props.showToast(t("toolbox.json.tabRestored"));
    },
  });
}

function cycleTab(delta) {
  const tabs = toolState.value.jsonWorkspace.tabs;
  const index = tabs.findIndex((tab) => tab.id === toolState.value.jsonWorkspace.activeId);
  switchJsonTab(tabs[(index + delta + tabs.length) % tabs.length].id);
}

function onWorkspaceKeydown(event) {
  if (!hydrated.value || dataType.value !== "json" || editingTabId.value) return;
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === "t") {
    event.preventDefault();
    createTab();
  } else if (key === "w") {
    event.preventDefault();
    closeTab(toolState.value.jsonWorkspace.activeId);
  } else if (key === "tab") {
    event.preventDefault();
    cycleTab(event.shiftKey ? -1 : 1);
  }
}
// 树视图状态
const treeQuery = ref("");
const expandedSet = ref(new Set());
const matchIndex = ref(0);
const treeRef = ref(null);
const modes = computed(() => (dataType.value === "yaml" ? YAML_MODES : JSON_MODES));
const visibleSamples = computed(() => SAMPLES.filter((sample) => (sample.dataType || "json") === dataType.value));

function resetTransientState() {
  cursor.value = { line: 1, col: 1 };
  treeQuery.value = "";
  expandedSet.value = new Set();
  matchIndex.value = 0;
  historyOpen.value = false;
  mockOpen.value = false;
  nextTick(() => {
    if (gutterRef.value) gutterRef.value.scrollTop = 0;
    if (taRef.value) {
      taRef.value.scrollTop = 0;
      taRef.value.scrollLeft = 0;
    }
  });
}

function selectDataType(nextType) {
  if (dataType.value === nextType) return;
  dataType.value = nextType;
  resetTransientState();
}

function showPersistenceError() {
  if (persistenceWarned) return;
  persistenceWarned = true;
  props.showToast(t("toolbox.json.persistFailed"));
}

function persistState() {
  if (!hydrated.value || disposed || persistenceBlocked.value) return;
  const { value, omittedTabIds } = serializeJsonToolState(toolState.value);
  const omitted = new Set(omittedTabIds);
  for (const id of omitted) {
    if (!omittedWarned.has(id)) props.showToast(t("toolbox.json.tabOmitted"));
    omittedWarned.add(id);
  }
  for (const id of [...omittedWarned]) {
    if (!omitted.has(id)) omittedWarned.delete(id);
  }
  saveToolbox("json", value, { onError: showPersistenceError });
}

async function backupDestructiveState(normalized) {
  let readFailed = false;
  const existing = await loadToolbox("json-recovery", [], {
    onError: () => { readFailed = true; },
  });
  if (disposed || readFailed) return false;
  const snapshots = appendJsonRecoverySnapshot(existing, {
    capturedAt: Date.now(),
    reason: normalized.warnings.join(","),
    source: normalized.raw,
  });
  const saved = await saveToolboxNow("json-recovery", snapshots);
  if (!saved.ok) return false;
  props.showToast(t("toolbox.json.draftBackedUp"));
  return true;
}

const receiveJsonHandoff = createJsonHandoffReceiver({
  normalizeState: (value) => normalizeJsonToolState(value, idFactory),
  persistState: (state) => {
    const serialized = serializeJsonToolState(state);
    return saveToolboxNow("json", serialized.value);
  },
  applyState: (state) => {
    if (!hydrated.value) {
      pendingHandoffState = state;
      return;
    }
    persistenceBlocked.value = false;
    toolState.value = { ...state, dataType: "json" };
    if (!stopPersist) stopPersist = watch(toolState, persistState, { deep: true });
    resetTransientState();
    props.showToast(t("toolbox.json.handoffOpened"));
  },
  onError: (reason) => {
    const message = reason === "save-failed"
      ? t("toolbox.json.handoffSaveFailed")
      : t("toolbox.json.handoffInvalid");
    props.showToast(message);
  },
});

function hydratePendingHandoff() {
  if (!pendingHandoffState) return false;
  const state = pendingHandoffState;
  pendingHandoffState = null;
  persistenceBlocked.value = false;
  toolState.value = { ...state, dataType: "json" };
  hydrated.value = true;
  if (!stopPersist) stopPersist = watch(toolState, persistState, { deep: true });
  persistState();
  resetTransientState();
  props.showToast(t("toolbox.json.handoffOpened"));
  return true;
}

function onBrowserJsonHandoff(event) {
  void receiveJsonHandoff(event.detail);
}

// 恢复上次状态；初始化完成前不注册 watch，避免默认值覆盖磁盘草稿。
onMounted(async () => {
  document.addEventListener("click", onDocClick);
  if (window.__TAURI_INTERNALS__) {
    try {
      unlistenJsonHandoff = await listen(JSON_HANDOFF_EVENT, (event) => {
        void receiveJsonHandoff(event.payload);
      });
    } catch {
      props.showToast(t("toolbox.json.handoffInitFailed"));
    }
  } else {
    window.addEventListener(JSON_HANDOFF_EVENT, onBrowserJsonHandoff);
  }
  let stateLoadFailed = false;
  let stateMigrationSaveFailed = false;
  let historyLoadFailed = false;
  let historyMigrationSaveFailed = false;
  const [saved, savedHistory] = await Promise.all([
    loadToolbox("json", {}, {
      onError: ({ phase }) => {
        if (phase === "load") stateLoadFailed = true;
        else stateMigrationSaveFailed = true;
      },
    }),
    loadToolbox("json-history", [], {
      onError: ({ phase }) => {
        if (phase === "load") historyLoadFailed = true;
        else historyMigrationSaveFailed = true;
      },
    }),
  ]);
  if (disposed) return;

  history.value = Array.isArray(savedHistory)
    ? savedHistory.filter((item) => item && typeof item.text === "string").slice(0, HIST_MAX)
    : [];
  if (historyLoadFailed) props.showToast(t("toolbox.json.historyLoadFailed"));
  else if (historyMigrationSaveFailed) props.showToast(t("toolbox.json.historyMigrateFailed"));
  if (hydratePendingHandoff()) return;
  if (stateLoadFailed) {
    persistenceBlocked.value = true;
    hydrated.value = true;
    showPersistenceError();
    return;
  }

  const normalized = normalizeJsonToolState(saved, idFactory);
  if (normalized.unsupportedVersion) {
    persistenceBlocked.value = true;
    toolState.value = normalized.state;
    hydrated.value = true;
    props.showToast(t("toolbox.json.draftFutureVersion"));
    return;
  }
  if (stateMigrationSaveFailed) {
    persistenceBlocked.value = true;
    props.showToast(t("toolbox.json.draftMigrateFailed"));
  }
  if (normalized.destructive && !(await backupDestructiveState(normalized))) {
    if (disposed) return;
    persistenceBlocked.value = true;
    props.showToast(t("toolbox.json.recoveryBackupFailed"));
  }
  if (disposed) return;
  if (hydratePendingHandoff()) return;

  toolState.value = normalized.state;
  const omittedIds = normalized.state.jsonWorkspace.tabs
    .filter((tab) => tab.inputOmitted)
    .map((tab) => tab.id);
  for (const id of omittedIds) omittedWarned.add(id);
  if (omittedIds.length) props.showToast(t("toolbox.json.omittedNotRestored", { count: omittedIds.length }));

  hydrated.value = true;
  if (!persistenceBlocked.value) {
    stopPersist = watch(toolState, persistState, { deep: true });
    persistState();
  }
});

onBeforeUnmount(() => {
  disposed = true;
  stopPersist?.();
  unlistenJsonHandoff?.();
  unlistenJsonHandoff = null;
  window.removeEventListener(JSON_HANDOFF_EVENT, onBrowserJsonHandoff);
  document.removeEventListener("click", onDocClick);
  if (hydrated.value && !persistenceBlocked.value) flushToolbox("json");
  flushToolbox("json-history");
});

// 两种结构化格式分别解析；校验状态不依赖后续格式化或转换是否成功。
const parsed = computed(() => {
  if (dataType.value !== "json" || !input.value.trim()) return null;
  return parseJson(input.value);
});
const yamlParsed = computed(() => {
  if (dataType.value !== "yaml" || !input.value.trim()) return null;
  return parseYaml(input.value);
});

// 计算结果
const result = computed(() => {
  const text = input.value;
  if (!text.trim()) return { ok: true, output: "", error: null, empty: true };
  if (dataType.value === "json") {
    if (mode.value === "format") return formatJson(text, indent.value);
    if (mode.value === "minify") return minifyJson(text);
    if (mode.value === "escape") return escapeJson(text);
    if (mode.value === "unescape") return unescapeJson(text);
    if (mode.value === "to-yaml") return jsonToYaml(text, indent.value);
    const p = parsed.value;
    if (!p.ok) return { ok: false, output: "", error: p.error };
    return { ok: true, output: JSON.stringify(p.value, null, indent.value), error: null, value: p.value };
  }

  if (mode.value === "validate") {
    const p = yamlParsed.value;
    if (!p.ok) return { ok: false, output: "", error: p.error };
    return { ok: true, output: "", error: null, empty: p.documentCount === 0, documentCount: p.documentCount };
  }
  if (mode.value === "format") return formatYaml(text, indent.value);
  return yamlToJson(text, indent.value); // 树视图和转 JSON 共用受限的 JSON 兼容转换
});

const error = computed(() => (result.value.ok ? null : result.value.error));
const output = computed(() => (result.value.ok ? result.value.output : ""));
const isEmpty = computed(() => !!result.value.empty);

const errorText = computed(() => {
  const e = error.value;
  if (!e) return "";
  if (e.line > 0) return t("toolbox.json.errorLocation", { line: e.line, column: e.column, message: e.message });
  return e.message;
});

// 校验状态：只反映输入语法，不把“无法转换为另一种格式”误报成语法错误。
const inputState = computed(() => {
  if (!input.value.trim()) return "empty";
  if (dataType.value === "yaml") return yamlParsed.value?.ok ? "ok" : "bad";
  return parsed.value ? (parsed.value.ok ? "ok" : "bad") : "empty";
});
// YAML 样式提示与语法错误独立显示，全角标点等问题在解析失败时仍能给出明确线索。
const yamlWarnings = computed(() => {
  if (dataType.value !== "yaml" || !input.value.trim()) return [];
  return lintYaml(input.value);
});
// JSON 校验状态（AI 修复 / 脱敏 / mock 等 JSON 专属能力用）
const jsonState = computed(() => {
  if (dataType.value !== "json" || !parsed.value) return "empty";
  return parsed.value.ok ? "ok" : "bad";
});
// 能否发起 AI 修复：仅 JSON 模式且输入不是合法 JSON 时
const canAiFix = computed(() => dataType.value === "json" && jsonState.value === "bad");

// 数据统计
const charCount = computed(() => input.value.length);
const stats = computed(() => {
  if (dataType.value === "json") return parsed.value?.ok ? jsonStats(parsed.value.value) : null;
  if ((mode.value === "tree" || mode.value === "to-json") && result.value.ok && !result.value.empty) return jsonStats(result.value.value);
  return null;
});

// 行号
const lineCount = computed(() => Math.max(1, input.value.split("\n").length));
const lineNumbers = computed(() => Array.from({ length: lineCount.value }, (_, i) => i + 1));
const errorLine = computed(() => (error.value && error.value.line > 0 ? error.value.line : 0));

// 输出高亮（超大输出退化为纯文本）
const outLines = computed(() => {
  const isJsonOutput = (dataType.value === "json" && mode.value !== "to-yaml") || (dataType.value === "yaml" && mode.value === "to-json");
  if (!isJsonOutput || !output.value || output.value.length > HL_MAX) return null;
  return highlightLines(output.value);
});
const outLineCount = computed(() => (output.value ? output.value.split("\n").length : 0));

const resultTitle = computed(() => {
  if (dataType.value === "yaml") {
    return { validate: "toolbox.json.resultValidate", format: "toolbox.json.resultYamlFormat", tree: "toolbox.json.resultTree", "to-json": "toolbox.json.resultToJson" }[mode.value];
  }
  return { format: "toolbox.json.resultJsonFormat", tree: "toolbox.json.resultTree", minify: "toolbox.json.resultMinify", escape: "toolbox.json.resultEscape", unescape: "toolbox.json.resultUnescape", "to-yaml": "toolbox.json.resultToYaml" }[mode.value];
});

// 输入区标题与占位文案随模式切换
const inputTitle = computed(() => t("toolbox.json.inputTitle", { type: dataType.value.toUpperCase() }));
const inputPlaceholder = computed(() =>
  dataType.value === "yaml" ? t("toolbox.json.inputPlaceholderYaml") : t("toolbox.json.inputPlaceholderJson")
);
const emptyHint = computed(() => t("toolbox.json.emptyHint", { type: dataType.value.toUpperCase() }));
const isTreeMode = computed(() => mode.value === "tree");
const isValidateMode = computed(() => dataType.value === "yaml" && mode.value === "validate");
const syntaxStatusText = computed(() => (dataType.value === "yaml" ? t("toolbox.json.syntaxOkYaml") : t("toolbox.json.syntaxOkJson")));
const invalidStatusText = computed(() => (dataType.value === "yaml" ? t("toolbox.json.syntaxBadYaml") : t("toolbox.json.syntaxBadJson")));
const resultHint = computed(() => {
  if (isEmpty.value) return emptyHint.value;
  if (error.value?.kind === "conversion") return t("toolbox.json.conversionImpossible");
  return t("toolbox.json.fixErrorFirst");
});

// 行号列与 textarea 滚动同步
function onScroll() {
  if (gutterRef.value && taRef.value) gutterRef.value.scrollTop = taRef.value.scrollTop;
}
// 更新光标行列（编辑器底部状态栏）
function updateCursor() {
  const ta = taRef.value;
  if (!ta) return;
  const pos = ta.selectionStart ?? 0;
  const before = input.value.slice(0, pos);
  const lines = before.split("\n");
  cursor.value = { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

// 自动格式化只修改 JSON 输入；YAML 格式化会丢失注释，因此只在结果区显式提供。
function applyFormat() {
  if (dataType.value !== "json") return;
  const r = formatJson(input.value, indent.value);
  if (r.ok && r.output && r.output !== input.value) input.value = r.output;
}
function toggleAuto() {
  autoFormat.value = !autoFormat.value;
  if (autoFormat.value) applyFormat();
}
function onBlur() {
  if (autoFormat.value) applyFormat();
  pushHistory();
  nextTick(updateCursor);
}

// ---------- 历史记录 ----------
function pushHistorySnapshot(text, type, selectedMode, { persist = true } = {}) {
  if (!text.trim() || text.length > HIST_ITEM_MAX) return false;
  const targetType = type === "yaml" ? "yaml" : "json";
  if (
    history.value[0]?.text === text
    && (history.value[0]?.dataType || "json") === targetType
  ) return true;
  history.value = [
    { text, ts: Date.now(), dataType: targetType, mode: selectedMode },
    ...history.value.filter((item) => !(
      item.text === text && (item.dataType || "json") === targetType
    )),
  ].slice(0, HIST_MAX);
  if (persist) saveHistory();
  return true;
}

async function saveAiHistorySnapshot(text, selectedMode) {
  if (!pushHistorySnapshot(text, "json", selectedMode, { persist: false })) {
    props.showToast(t("toolbox.json.aiHistoryTooLarge"));
    return false;
  }
  const saved = await saveToolboxNow("json-history", history.value);
  if (!saved.ok) {
    props.showToast(t("toolbox.json.aiHistorySaveFailed"));
    return false;
  }
  return true;
}

function pushHistory() {
  pushHistorySnapshot(input.value, dataType.value, mode.value);
}

function restoreHistory(item) {
  const targetType = item.dataType === "yaml" ? "yaml" : "json";
  dataType.value = targetType;
  input.value = item.text;
  if (targetType === "json") {
    mode.value = JSON_MODES.some((entry) => entry.key === item.mode)
      ? item.mode
      : "format";
  } else {
    mode.value = YAML_MODES.some((entry) => entry.key === item.mode)
      ? item.mode
      : "validate";
  }
  historyOpen.value = false;
  resetTransientState();
  props.showToast(t("toolbox.json.historyRestored"));
}
function clearHistory() {
  history.value = [];
  saveHistory();
}
function saveHistory() {
  saveToolbox("json-history", history.value);
}
function preview(text) {
  return text.replace(/\s+/g, " ").slice(0, 60);
}
function onDocClick(e) {
  if (histWrap.value && !histWrap.value.contains(e.target)) historyOpen.value = false;
  if (mockWrap.value && !mockWrap.value.contains(e.target)) mockOpen.value = false;
}

const copiedResult = ref(false); // 复制结果反馈：按钮短暂变 check
let copiedTimer = null;
async function copyResult() {
  if (!output.value) return props.showToast(t("toolbox.json.nothingToCopy"));
  try {
    await navigator.clipboard.writeText(output.value);
    copiedResult.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => (copiedResult.value = false), 1200);
    props.showToast(t("toolbox.json.copiedResult"));
  } catch (e) {
    props.showToast(t("toolbox.json.copyFailed", { err: e }));
  }
}
function clearAll() {
  pushHistory(); // 清空前留档，防误清
  input.value = "";
  cursor.value = { line: 1, col: 1 };
}
function loadSample(sample) {
  pushHistory();
  input.value = dataType.value === "json"
    ? JSON.stringify(JSON.parse(sample.text), null, indent.value)
    : sample.text;
  mode.value = dataType.value === "json" ? "format" : "validate";
  resetTransientState();
  props.showToast(t("toolbox.json.sampleLoaded", { label: t(sample.labelKey) }));
}
function triggerImport() {
  fileRef.value?.click();
}
function onFile(event) {
  const file = event.target.files?.[0];
  event.target.value = ""; // 允许再次导入同一文件
  if (!file) return;

  const extension = file.name.split(".").pop()?.toLowerCase();
  const targetsYaml = extension === "yaml"
    || extension === "yml"
    || (extension === "txt" && dataType.value === "yaml");
  if (!targetsYaml && toolState.value.jsonWorkspace.tabs.length >= 10) {
    props.showToast(t("toolbox.json.tabLimit"));
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    const text = String(reader.result || "");
    if (targetsYaml) {
      pushHistorySnapshot(
        toolState.value.yamlDraft.input,
        "yaml",
        toolState.value.yamlDraft.mode,
      );
      toolState.value = {
        ...toolState.value,
        dataType: "yaml",
        yamlDraft: {
          ...toolState.value.yamlDraft,
          input: text,
          mode: "validate",
        },
      };
    } else if (!createTab({ title: file.name.trim(), input: text })) {
      return;
    }
    resetTransientState();
    props.showToast(t("toolbox.json.imported", { name: file.name }));
  };
  reader.onerror = () => props.showToast(t("toolbox.json.fileReadFailed"));
  reader.readAsText(file);
}

// ---------- AI 修复 ----------
// 把非法 JSON 交给 AI 修复，成功后回填并按当前缩进格式化（修复前自动留档可回退）。
async function aiRepair() {
  if (!canAiFix.value || aiFixing.value) return;
  const tabId = toolState.value.jsonWorkspace.activeId;
  const source = activeTab.value.input;
  const sourceMode = activeTab.value.mode;
  aiFixing.value = true;
  try {
    if (!(await isAIConfigured())) {
      props.showToast(t("toolbox.json.aiNotConfigured"));
      return;
    }
    if (!canWriteJsonTab(toolState.value.jsonWorkspace, tabId, source).ok) {
      props.showToast(t("toolbox.json.tabChanged"));
      return;
    }
    if (!(await saveAiHistorySnapshot(source, sourceMode))) return;
    if (!canWriteJsonTab(toolState.value.jsonWorkspace, tabId, source).ok) {
      props.showToast(t("toolbox.json.tabChanged"));
      return;
    }
    props.showToast(t("toolbox.json.aiFixing"));
    const fixed = await aiRepairJson(source);
    const target = canWriteJsonTab(toolState.value.jsonWorkspace, tabId, source);
    if (!target.ok) {
      props.showToast(t("toolbox.json.tabChanged"));
      return;
    }
    const formatted = JSON.stringify(JSON.parse(fixed), null, target.tab.indent);
    toolState.value = {
      ...toolState.value,
      jsonWorkspace: {
        ...toolState.value.jsonWorkspace,
        tabs: toolState.value.jsonWorkspace.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, input: formatted, inputOmitted: false } : tab
        ),
      },
    };
    if (toolState.value.jsonWorkspace.activeId === tabId && dataType.value === "json") {
      cursor.value = { line: 1, col: 1 };
    }
    props.showToast(t("toolbox.json.aiFixed"));
  } catch (e) {
    props.showToast(t("toolbox.json.aiFixFailed", { err: e && e.message ? e.message : e }));
  } finally {
    aiFixing.value = false;
  }
}

// ---------- 一键脱敏 ----------
// 对当前合法 JSON 脱敏（纯本地），回填到输入区（脱敏前自动留档可回退）。
function maskSensitive() {
  if (dataType.value !== "json" || jsonState.value !== "ok") return props.showToast(t("toolbox.json.needValidJson"));
  const r = maskJsonText(input.value, indent.value);
  if (!r.ok) return props.showToast(t("toolbox.json.maskFormatError"));
  if (!r.count) return props.showToast(t("toolbox.json.maskNoneFound"));
  pushHistory();
  input.value = r.output;
  cursor.value = { line: 1, col: 1 };
  props.showToast(t("toolbox.json.masked", { count: r.count }));
}

// ---------- AI mock 数据 ----------
const mockOpen = ref(false); // mock 面板开关
const mockInstruction = ref(""); // 用户生成指令
const mocking = ref(false);
const mockWrap = ref(null);
function toggleMock() {
  if (dataType.value !== "json" || jsonState.value !== "ok") return props.showToast(t("toolbox.json.needValidJsonTemplate"));
  mockOpen.value = !mockOpen.value;
}
async function runMock() {
  if (mocking.value) return;
  if (dataType.value !== "json" || jsonState.value !== "ok") {
    return props.showToast(t("toolbox.json.needValidJsonTemplate"));
  }
  const tabId = toolState.value.jsonWorkspace.activeId;
  const source = activeTab.value.input;
  const sourceMode = activeTab.value.mode;
  const instruction = mockInstruction.value;
  mocking.value = true;
  try {
    if (!(await isAIConfigured())) {
      props.showToast(t("toolbox.json.aiNotConfigured"));
      return;
    }
    if (!canWriteJsonTab(toolState.value.jsonWorkspace, tabId, source).ok) {
      props.showToast(t("toolbox.json.tabChanged"));
      return;
    }
    if (!(await saveAiHistorySnapshot(source, sourceMode))) return;
    if (!canWriteJsonTab(toolState.value.jsonWorkspace, tabId, source).ok) {
      props.showToast(t("toolbox.json.tabChanged"));
      return;
    }
    props.showToast(t("toolbox.json.mockGenerating"));
    const mocked = await aiMockJson(source, instruction);
    const target = canWriteJsonTab(toolState.value.jsonWorkspace, tabId, source);
    if (!target.ok) {
      props.showToast(t("toolbox.json.tabChanged"));
      return;
    }
    const formatted = JSON.stringify(JSON.parse(mocked), null, target.tab.indent);
    toolState.value = {
      ...toolState.value,
      jsonWorkspace: {
        ...toolState.value.jsonWorkspace,
        tabs: toolState.value.jsonWorkspace.tabs.map((tab) =>
          tab.id === tabId ? { ...tab, input: formatted, inputOmitted: false } : tab
        ),
      },
    };
    if (toolState.value.jsonWorkspace.activeId === tabId && dataType.value === "json") {
      cursor.value = { line: 1, col: 1 };
    }
    mockOpen.value = false;
    props.showToast(t("toolbox.json.mockGenerated"));
  } catch (e) {
    props.showToast(t("toolbox.json.mockFailed", { err: e && e.message ? e.message : e }));
  } finally {
    mocking.value = false;
  }
}

// ---------- 树视图 ----------
const treeRoot = computed(() => {
  if (mode.value !== "tree" || !result.value.ok || result.value.empty) return null;
  return buildTree(result.value.value);
});

// 新解析出树时重置展开集为默认（根 + 一级容器）
watch(treeRoot, (root) => {
  expandedSet.value = root ? defaultExpanded(root, 1) : new Set();
  matchIndex.value = 0;
});

const search = computed(() => searchTree(treeRoot.value, treeQuery.value));
const matchOrder = computed(() => search.value.order);
const matchedSet = computed(() => search.value.matched);
const matchCount = computed(() => matchOrder.value.length);
const currentMatchId = computed(() => (matchCount.value ? matchOrder.value[matchIndex.value] : -1));

// 搜索变化：自动展开命中路径并定位首个命中
watch(search, (s) => {
  matchIndex.value = 0;
  if (s.expand.size) {
    const merged = new Set(expandedSet.value);
    s.expand.forEach((id) => merged.add(id));
    expandedSet.value = merged;
  }
  nextTick(scrollToMatch);
});

const rows = computed(() => flattenTree(treeRoot.value, expandedSet.value));

function toggle(id) {
  const s = new Set(expandedSet.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  expandedSet.value = s;
}
function expandAll() { expandedSet.value = allContainerIds(treeRoot.value); }
function collapseAll() { expandedSet.value = new Set(); }

function gotoMatch(delta) {
  const n = matchCount.value;
  if (!n) return;
  matchIndex.value = (matchIndex.value + delta + n) % n;
  nextTick(scrollToMatch);
}
function scrollToMatch() {
  const id = currentMatchId.value;
  if (id < 0 || !treeRef.value) return;
  const el = treeRef.value.querySelector(`[data-node="${id}"]`);
  if (el) el.scrollIntoView({ block: "center" });
}

// 命中高亮：按查询词拆分文本为 {t,hit} 片段
function segs(text) {
  const s = String(text ?? "");
  const q = treeQuery.value;
  if (!q) return [{ t: s, hit: false }];
  const out = [];
  const lower = s.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  while (i < s.length) {
    const idx = lower.indexOf(ql, i);
    if (idx < 0) { out.push({ t: s.slice(i), hit: false }); break; }
    if (idx > i) out.push({ t: s.slice(i, idx), hit: false });
    out.push({ t: s.slice(idx, idx + q.length), hit: true });
    i = idx + q.length;
  }
  return out;
}

async function copyValue(row) {
  const text = row.type === "string" ? row.value : primitivePreview(row);
  try {
    await navigator.clipboard.writeText(text);
    props.showToast(t("toolbox.json.valueCopied"));
  } catch (e) {
    props.showToast(t("toolbox.json.copyFailed", { err: e }));
  }
}
</script>

<template>
  <div class="json-tool" :inert="!hydrated || undefined" :aria-busy="!hydrated" @keydown="onWorkspaceKeydown">
    <input ref="fileRef" type="file" accept=".json,.txt,.yaml,.yml,application/json,application/yaml,text/yaml" class="file-hide" @change="onFile" />

    <!-- 工具条：先选数据格式，再选该格式下的操作 -->
    <div class="bar">
      <div class="type-switch" :aria-label="t('toolbox.json.ariaDataFormat')">
        <button
          v-for="item in DATA_TYPES"
          :key="item.key"
          class="type-btn"
          :class="{ on: dataType === item.key }"
          @click="selectDataType(item.key)"
        >{{ item.label }}</button>
      </div>
      <div class="pills">
        <button
          v-for="m in modes"
          :key="m.key"
          class="pill"
          :class="{ on: mode === m.key }"
          :title="m.titleKey ? t(m.titleKey) : t(m.labelKey)"
          @click="mode = m.key"
        >{{ t(m.labelKey) }}</button>
      </div>
      <div class="bar-right">
        <div ref="histWrap" class="hist-wrap">
          <button class="act" :class="{ open: historyOpen }" @click="historyOpen = !historyOpen"><Icon name="clock" :size="14" />{{ t("toolbox.json.history") }}</button>
          <div v-if="historyOpen" class="hist-panel">
            <div class="hp-head">
              <b>{{ t("toolbox.json.history") }}</b>
              <button v-if="history.length" class="hp-clear" @click="clearHistory">{{ t("toolbox.json.clear") }}</button>
            </div>
            <div v-if="history.length" class="hp-list">
              <button v-for="(h, i) in history" :key="h.ts + '-' + i" class="hp-item" @click="restoreHistory(h)">
                <span class="hp-text">{{ preview(h.text) }}</span>
                <span class="hp-time">{{ relativeTime(h.ts) }}</span>
              </button>
            </div>
            <p v-else class="hp-empty">{{ t("toolbox.json.historyEmpty") }}</p>
          </div>
        </div>
        <button v-if="dataType === 'json'" class="act" :title="t('toolbox.json.maskTitle')" @click="maskSensitive"><Icon name="eye" :size="14" />{{ t("toolbox.json.mask") }}</button>
        <div v-if="dataType === 'json'" ref="mockWrap" class="hist-wrap">
          <button class="act" :class="{ open: mockOpen }" :title="t('toolbox.json.mockTitle')" @click="toggleMock"><Icon name="sparkles" :size="14" />AI Mock</button>
          <div v-if="mockOpen" class="mock-panel">
            <div class="hp-head"><b>{{ t("toolbox.json.mockPanelTitle") }}</b></div>
            <div class="mock-body">
              <p class="mock-tip">{{ t("toolbox.json.mockTip") }}</p>
              <textarea v-model="mockInstruction" class="mock-ta" spellcheck="false" :placeholder="t('toolbox.json.mockPlaceholder')"></textarea>
              <button class="mock-run" :disabled="mocking" @click="runMock">
                <Icon name="sparkles" :size="14" />{{ mocking ? t("toolbox.json.mockRunning") : t("toolbox.json.mockRun") }}
              </button>
            </div>
          </div>
        </div>
        <button class="act" @click="triggerImport"><Icon name="download" :size="14" />{{ t("toolbox.json.importFile") }}</button>
        <button class="act" @click="clearAll"><Icon name="trash" :size="14" />{{ t("toolbox.json.clear") }}</button>
        <button v-if="!isValidateMode" class="act primary" :class="{ done: copiedResult }" :disabled="!output" @click="copyResult"><Icon :name="copiedResult ? 'check' : 'copy'" :size="14" />{{ copiedResult ? t("toolbox.json.copied") : t("toolbox.json.copyResult") }}</button>
      </div>
    </div>

    <div v-if="dataType === 'json'" class="doc-tabs" :aria-label="t('toolbox.json.ariaDocTabs')">
      <div class="doc-tabs-scroll">
        <div
          v-for="tab in toolState.jsonWorkspace.tabs"
          :key="tab.id"
          class="doc-tab"
          :class="{ on: tab.id === toolState.jsonWorkspace.activeId }"
        >
          <input
            v-if="editingTabId === tab.id"
            :ref="setRenameRef"
            v-model="editingTitle"
            class="doc-tab-input"
            :aria-label="t('toolbox.json.ariaTabName')"
            @click.stop
            @keydown.enter.prevent="commitRename"
            @keydown.esc.prevent="cancelRename"
            @blur="commitRename"
          />
          <button
            v-else
            class="doc-tab-main"
            :title="tab.title"
            :aria-current="tab.id === toolState.jsonWorkspace.activeId ? 'page' : undefined"
            @click="switchJsonTab(tab.id)"
            @dblclick.stop="beginRename(tab)"
          >
            <Icon name="note" :size="13" />
            <span>{{ tab.title }}</span>
          </button>
          <button
            class="doc-tab-close icon-btn xs"
            :disabled="toolState.jsonWorkspace.tabs.length === 1"
            :aria-label="t('toolbox.json.closeTabAria', { title: tab.title })"
            :title="toolState.jsonWorkspace.tabs.length === 1 ? t('toolbox.json.lastTabShort') : t('toolbox.json.closeTabTitle')"
            @click.stop="closeTab(tab.id)"
          ><Icon name="x" :size="12" /></button>
        </div>
      </div>
      <button
        class="doc-tab-add icon-btn"
        :disabled="toolState.jsonWorkspace.tabs.length >= 10"
        :title="toolState.jsonWorkspace.tabs.length >= 10 ? t('toolbox.json.tabLimitShort') : t('toolbox.json.newTab')"
        :aria-label="t('toolbox.json.newTab')"
        @click="createTab()"
      ><Icon name="plus" :size="15" /></button>
    </div>

    <!-- 语法错误或转换错误；只有 JSON 语法错误提供 AI 修复 -->
    <div v-if="errorText" class="err-bar">
      <span class="err-msg">{{ errorText }}</span>
      <button v-if="canAiFix" class="ai-fix" :disabled="aiFixing" @click="aiRepair">
        <Icon name="sparkles" :size="14" />{{ aiFixing ? t("toolbox.json.aiFixingBtn") : t("toolbox.json.aiFixBtn") }}
      </button>
    </div>

    <!-- YAML 可疑写法提示（琥珀条，语法合法但通常是笔误） -->
    <div v-if="yamlWarnings.length" class="warn-bar">
      <Icon name="alert" :size="13" class="warn-ico" />
      <span v-for="(w, i) in yamlWarnings" :key="i" class="warn-item" :title="w.message">{{ t("toolbox.json.warnLine", { line: w.line, message: w.message }) }}</span>
    </div>

    <!-- 主体三栏 -->
    <div class="cols">
      <!-- 输入卡 -->
      <div class="pane">
        <div class="pane-head">
          <span class="pane-title">{{ inputTitle }}</span>
          <span class="spacer"></span>
          <button v-if="dataType === 'json'" class="switch-btn" :class="{ on: autoFormat }" :title="autoFormat ? t('toolbox.json.autoFormatOn') : t('toolbox.json.autoFormatOff')" @click="toggleAuto">
            <span class="sw-label">{{ t("toolbox.json.autoFormat") }}</span>
            <span class="sw-track"><span class="sw-knob"></span></span>
          </button>
        </div>
        <div class="editor-wrap">
          <div ref="gutterRef" class="gutter">
            <div
              v-for="n in lineNumbers"
              :key="n"
              class="ln"
              :class="{ 'ln-err': n === errorLine }"
            >{{ n }}</div>
          </div>
          <textarea
            ref="taRef"
            v-model="input"
            class="editor"
            spellcheck="false"
            :placeholder="inputPlaceholder"
            @scroll="onScroll"
            @keyup="updateCursor"
            @keydown.ctrl.enter.prevent="copyResult"
            @keydown.meta.enter.prevent="copyResult"
            @click="updateCursor"
            @blur="onBlur"
          ></textarea>
        </div>
        <div class="pane-foot">
          <span class="ff">{{ t("toolbox.json.length") }}: {{ charCount.toLocaleString() }}</span>
          <span class="ff-sep">|</span>
          <span class="ff">{{ t("toolbox.json.lines") }}: {{ lineCount }}</span>
          <span class="spacer"></span>
          <span class="ff">{{ t("toolbox.json.cursorPos", { line: cursor.line, col: cursor.col }) }}</span>
          <span class="ff">{{ t("toolbox.json.indent") }}:</span>
          <button class="mini" :class="{ on: indent === 2 }" @click="indent = 2">2</button>
          <button class="mini" :class="{ on: indent === 4 }" @click="indent = 4">4</button>
        </div>
      </div>

      <!-- 结果卡 -->
      <div class="pane">
        <div class="pane-head">
          <span class="pane-title">{{ t(resultTitle) }}</span>
          <template v-if="isTreeMode">
            <div class="tsearch">
              <Icon name="search" :size="13" />
              <input v-model="treeQuery" spellcheck="false" :placeholder="t('toolbox.json.treeSearch')" />
            </div>
            <span v-if="treeQuery" class="match-info">{{ matchCount ? (matchIndex + 1) + '/' + matchCount : '0/0' }}</span>
            <button class="mini" :disabled="!matchCount" :title="t('toolbox.json.prevMatch')" @click="gotoMatch(-1)">‹</button>
            <button class="mini" :disabled="!matchCount" :title="t('toolbox.json.nextMatch')" @click="gotoMatch(1)">›</button>
            <span class="spacer"></span>
            <label class="chk"><input v-model="showTypes" type="checkbox" />{{ t("toolbox.json.showTypes") }}</label>
            <button class="mini" @click="expandAll">{{ t("toolbox.json.expandAll") }}</button>
            <button class="mini" @click="collapseAll">{{ t("toolbox.json.collapseAll") }}</button>
          </template>
          <template v-else>
            <span class="spacer"></span>
            <span v-if="inputState === 'ok'" class="rs ok"><Icon name="check" :size="13" />{{ syntaxStatusText }}</span>
            <span v-else-if="inputState === 'bad'" class="rs bad"><Icon name="alert" :size="13" />{{ invalidStatusText }}</span>
          </template>
        </div>
        <div class="pane-body">
          <!-- 树视图 -->
          <template v-if="isTreeMode">
            <div v-if="treeRoot" ref="treeRef" class="tree">
              <div
                v-for="row in rows"
                :key="row.id"
                class="trow"
                :data-node="row.id"
                :class="{ 'is-match': matchedSet.has(row.id), 'is-current': row.id === currentMatchId }"
                :style="{ paddingLeft: (row.depth * 16 + 6) + 'px' }"
              >
                <span class="tw" :class="{ ghost: !row.expandable }" @click="row.expandable && toggle(row.id)">{{ row.expandable ? (row.isOpen ? '▾' : '▸') : '' }}</span>
                <span v-if="row.key !== null" class="tk"><span v-for="(s, i) in segs(String(row.key))" :key="i" :class="{ hl: s.hit }">{{ s.t }}</span><span class="colon">:</span></span>
                <span v-else class="tk root">{{ t("toolbox.json.rootObject") }}</span>
                <span v-if="row.type === 'object'" class="tsum">{{ row.isOpen ? '{' : '{ ' + row.size + ' }' }}</span>
                <span v-else-if="row.type === 'array'" class="tsum">{{ row.isOpen ? '[' : '[ ' + row.size + ' ]' }}</span>
                <span v-else class="tv" :class="'v-' + row.type" :title="t('toolbox.json.clickToCopy', { value: primitivePreview(row) })" @click="copyValue(row)"><template v-if="row.type === 'string'">"<span v-for="(s, i) in segs(row.value)" :key="i" :class="{ hl: s.hit }">{{ s.t }}</span>"</template><template v-else><span v-for="(s, i) in segs(primitivePreview(row))" :key="i" :class="{ hl: s.hit }">{{ s.t }}</span></template></span>
                <span v-if="showTypes" class="ttag" :class="'tt-' + row.type">{{ typeLabel(row.type, row.size) }}</span>
              </div>
            </div>
            <p v-else class="ph">{{ isEmpty ? emptyHint : (error?.kind === 'conversion' ? t("toolbox.json.treeConversionImpossible") : t("toolbox.json.treeFixFirst")) }}</p>
          </template>

          <!-- YAML 独立校验结果 -->
          <div v-else-if="isValidateMode && inputState === 'ok' && !isEmpty" class="validate-ok">
            <span class="validate-icon"><Icon name="check" :size="24" /></span>
            <b>{{ t("toolbox.json.syntaxOkYaml") }}</b>
            <span>{{ t("toolbox.json.docCount", { count: yamlParsed?.documentCount || 0 }) }}</span>
          </div>

          <!-- 格式化 / 转换输出 -->
          <template v-else>
            <div v-if="!isEmpty && outLines" class="hl-scroll">
              <div v-for="(line, li) in outLines" :key="li" class="hrow">
                <span class="hnum">{{ li + 1 }}</span>
                <span class="hcode"><span v-for="(t, ti) in line" :key="ti" :class="'tok-' + t.c">{{ t.t }}</span></span>
              </div>
            </div>
            <pre v-else-if="!isEmpty && output" class="output">{{ output }}</pre>
            <p v-else class="ph">{{ resultHint }}</p>
          </template>
        </div>
        <div v-if="!isTreeMode && !isValidateMode" class="pane-foot">
          <span class="ff">{{ t("toolbox.json.length") }}: {{ output.length.toLocaleString() }}</span>
          <span class="ff-sep">|</span>
          <span class="ff">{{ t("toolbox.json.lines") }}: {{ outLineCount }}</span>
        </div>
      </div>

      <!-- 右侧栏（模式切换只保留顶部 pill，避免与操作宫格重复） -->
      <aside class="side">
        <div class="side-card">
          <div class="side-title">{{ t("toolbox.json.statsTitle") }}</div>
          <div class="stat-rows">
            <div class="srow"><span>{{ t("toolbox.json.statChars") }}</span><b>{{ charCount.toLocaleString() }}</b></div>
            <div v-if="dataType === 'yaml'" class="srow"><span>{{ t("toolbox.json.statDocs") }}</span><b>{{ yamlParsed?.ok ? yamlParsed.documentCount : "-" }}</b></div>
            <div class="srow"><span>{{ t("toolbox.json.statDepth") }}</span><b>{{ stats ? stats.depth : "-" }}</b></div>
            <div class="srow"><span>{{ t("toolbox.json.statObjects") }}</span><b>{{ stats ? stats.objects : "-" }}</b></div>
            <div class="srow"><span>{{ t("toolbox.json.statArrays") }}</span><b>{{ stats ? stats.arrays : "-" }}</b></div>
            <div class="srow"><span>{{ t("toolbox.json.statKeys") }}</span><b>{{ stats ? stats.keys : "-" }}</b></div>
          </div>
        </div>
        <div class="side-card">
          <div class="side-title">{{ t("toolbox.json.samplesTitle") }}</div>
          <div class="samples">
            <button v-for="s in visibleSamples" :key="s.key" class="sample" @click="loadSample(s)">
              <Icon name="note" :size="14" />{{ t(s.labelKey) }}
            </button>
            <button class="sample sample-clear" @click="clearAll">{{ t("toolbox.json.clearInput") }}</button>
          </div>
        </div>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.json-tool { display: flex; flex-direction: column; height: 100%; min-height: 0; gap: 10px; }
.file-hide { display: none; }

/* 工具条 */
.bar { flex-shrink: 0; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.type-switch { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-1); background: var(--well); border: 1px solid var(--border); border-radius: var(--r-sm); }
.type-btn { padding: var(--sp-1) var(--sp-4); border: none; background: transparent; color: var(--text-weak); border-radius: var(--r-xs); font-size: var(--fs-md); font-weight: 600; cursor: pointer; transition: background 0.15s, color 0.15s, box-shadow 0.15s; }
.type-btn:hover { color: var(--text); background: var(--well-hover); }
.type-btn.on { color: var(--primary-hover); background: var(--card); box-shadow: var(--shadow); }
.type-btn:focus-visible, .pill:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: 1px; }
.pills { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pill { padding: 7px 16px; font-size: var(--fs-md); border: 1px solid var(--card-border); background: var(--card); color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.pill:hover { color: var(--text); border-color: var(--border-strong); }
.pill.on { background: var(--primary); border-color: var(--primary); color: var(--text-invert); font-weight: 600; }
.bar-right { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* JSON 文档标签：滚动区占满剩余宽度，新增按钮固定在右侧。 */
.doc-tabs {
  flex-shrink: 0;
  display: flex;
  align-items: stretch;
  min-width: 0;
  height: 36px;
  border-bottom: 1px solid var(--border-blue);
}
.doc-tabs-scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: stretch;
  gap: var(--sp-1);
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
}
.doc-tab {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  width: 160px;
  min-width: 112px;
  max-width: 160px;
  height: 36px;
  border: 1px solid transparent;
  border-bottom: 0;
  border-radius: var(--r-xs) var(--r-xs) 0 0;
  color: var(--text-weak);
  background: var(--well);
}
.doc-tab:hover { background: var(--well-hover); color: var(--text); }
.doc-tab.on {
  color: var(--primary-hover);
  background: var(--card);
  border-color: var(--border-blue);
  font-weight: 600;
}
.doc-tab-main {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-1) 0 var(--sp-3);
  border: 0;
  background: transparent;
  color: inherit;
  font-size: var(--fs-sm);
  cursor: pointer;
}
.doc-tab-main span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.doc-tab-input {
  flex: 1;
  min-width: 0;
  margin-left: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--primary);
  border-radius: var(--r-xs);
  outline: 0;
  color: var(--text);
  background: var(--card);
  font-size: var(--fs-sm);
}
.doc-tab-close {
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  padding: 0;
  display: grid;
  place-items: center;
  margin-right: var(--sp-1);
  color: var(--text-weak);
}
.doc-tab-close:hover:not(:disabled) { color: var(--danger); background: var(--danger-soft); }
.doc-tab-close:disabled { opacity: 0.35; cursor: default; }
.doc-tab-add {
  flex: 0 0 36px;
  width: 36px;
  height: 36px;
  padding: 0;
  display: grid;
  place-items: center;
  margin-left: var(--sp-2);
  border-radius: var(--r-xs) var(--r-xs) 0 0;
  color: var(--primary);
}
.doc-tab-add:disabled { opacity: 0.4; cursor: default; }
.doc-tab-main:focus-visible,
.doc-tab-close:focus-visible,
.doc-tab-add:focus-visible { outline: 2px solid var(--accent-soft-text); outline-offset: -2px; }

.act { display: inline-flex; align-items: center; gap: 6px; padding: 7px 12px; font-size: var(--fs-md); border: 1px solid var(--card-border); background: var(--card); color: var(--text); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.act:hover, .act.open { border-color: var(--border-blue); color: var(--primary-hover); }
.act.primary { background: var(--primary); color: var(--text-invert); border-color: var(--primary); }
.act.primary:hover { background: var(--primary-hover); border-color: var(--primary-hover); color: var(--text-invert); }
.act:disabled { opacity: 0.5; cursor: default; }
/* 复制结果成功反馈 */
.act.primary.done { background: var(--success-deep); border-color: var(--success-deep); }

/* 历史记录下拉 */
.hist-wrap { position: relative; }
.hist-panel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 320px; max-height: 320px; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); box-shadow: var(--shadow-pop, 0 8px 24px color-mix(in srgb, var(--text) 14%, transparent)); overflow: hidden; }
.hp-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; border-bottom: 1px solid var(--card-border); }
.hp-head b { font-size: var(--fs-md); }
.hp-clear { padding: 2px 8px; font-size: var(--fs-sm); border: none; background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; }
.hp-clear:hover { color: var(--danger); background: var(--danger-soft); }
.hp-list { overflow: auto; padding: 4px; }
.hp-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 8px 9px; border: none; background: transparent; border-radius: var(--r-sm); cursor: pointer; text-align: left; }
.hp-item:hover { background: var(--primary-soft); }
.hp-text { flex: 1; min-width: 0; font-size: var(--fs-sm); font-family: var(--font-mono); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hp-time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); }
.hp-empty { margin: 0; padding: 14px 12px; font-size: var(--fs-sm); color: var(--muted); }

/* AI mock 面板 */
.mock-panel { position: absolute; top: calc(100% + 6px); right: 0; z-index: 30; width: 340px; display: flex; flex-direction: column; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); box-shadow: var(--shadow-pop, 0 8px 24px color-mix(in srgb, var(--text) 14%, transparent)); overflow: hidden; }
.mock-body { display: flex; flex-direction: column; gap: 10px; padding: 12px; }
.mock-tip { margin: 0; font-size: var(--fs-sm); color: var(--muted); line-height: 1.5; }
.mock-ta { width: 100%; min-height: 76px; padding: 8px 10px; font-size: var(--fs-sm); font-family: inherit; line-height: 1.5; color: var(--text); background: var(--bg, var(--card)); border: 1px solid var(--card-border); border-radius: var(--r-sm); outline: none; resize: vertical; box-sizing: border-box; }
.mock-ta:focus { border-color: var(--border-blue); }
.mock-run { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 12px; font-size: var(--fs-sm); font-weight: 600; color: var(--text-invert); background: linear-gradient(135deg, var(--primary), var(--primary-hover)); border: none; border-radius: var(--r-sm); cursor: pointer; transition: opacity 0.15s; }
.mock-run:hover:not(:disabled) { opacity: 0.9; }
.mock-run:disabled { opacity: 0.6; cursor: default; }

.err-bar { flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 6px 8px 6px 12px; background: var(--danger-soft); border: 1px solid var(--border-danger); border-radius: var(--r-sm); }
.err-msg { flex: 1; min-width: 0; font-size: var(--fs-sm); color: var(--danger); font-family: var(--font-mono); word-break: break-word; }
.ai-fix { flex-shrink: 0; display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: var(--fs-sm); font-weight: 600; color: var(--text-invert); background: linear-gradient(135deg, var(--primary), var(--primary-hover)); border: none; border-radius: var(--r-sm); cursor: pointer; transition: opacity 0.15s; }
.ai-fix:hover:not(:disabled) { opacity: 0.9; }
.ai-fix:disabled { opacity: 0.6; cursor: default; }

/* YAML 可疑写法提示条（琥珀） */
.warn-bar { flex-shrink: 0; display: flex; align-items: flex-start; flex-wrap: wrap; gap: 4px 18px; padding: 6px 12px; background: var(--warn-soft); border: 1px solid var(--warn-border); border-radius: var(--r-sm); }
.warn-ico { flex-shrink: 0; margin-top: 1px; color: var(--warn-deep); }
.warn-item { font-size: var(--fs-xs); color: var(--warn-deep); line-height: 1.5; cursor: help; }

/* 主体三栏 */
.cols { flex: 1; min-height: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 220px; gap: 12px; }
/* 窄窗口适配：右侧栏（统计/示例）为辅助信息，窄屏逐步让位给两个编辑窗 */
@media (max-width: 1150px) {
  .cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 180px; }
}
@media (max-width: 980px) {
  .cols { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .cols > .side { display: none; }
}
.pane { min-width: 0; display: flex; flex-direction: column; border: 1px solid var(--card-border); border-radius: var(--r-md); background: var(--card); overflow: hidden; }
.pane-head { flex-shrink: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 44px; padding: 7px 12px; border-bottom: 1px solid var(--card-border); background: color-mix(in srgb, var(--text) 2%, transparent); }
.pane-title { font-size: var(--fs-base); font-weight: 600; white-space: nowrap; }
.spacer { flex: 1; }

/* 结果卡校验状态 */
.rs { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); font-weight: 600; }
.rs.ok { color: var(--success); }
.rs.bad { color: var(--danger); }

/* 自动格式化开关 */
.switch-btn { display: inline-flex; align-items: center; gap: 7px; padding: 0; background: none; border: none; cursor: pointer; }
.sw-label { font-size: var(--fs-sm); color: var(--muted); }
.sw-track { position: relative; width: 34px; height: 18px; border-radius: var(--r-pill); background: var(--border-strong); transition: background 0.15s; }
.sw-knob { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--text-invert); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2); transition: left 0.15s; }
.switch-btn.on .sw-track { background: var(--primary); }
.switch-btn.on .sw-knob { left: 18px; }
.switch-btn.on .sw-label { color: var(--primary-hover); }

/* 编辑器 */
.editor-wrap { flex: 1; min-height: 0; display: flex; overflow: hidden; }
.gutter { flex-shrink: 0; width: 44px; overflow: hidden; padding: 12px 0; text-align: right; background: color-mix(in srgb, var(--text) 3%, transparent); border-right: 1px solid var(--card-border); font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.6; color: var(--muted); user-select: none; }
.ln { padding: 0 8px; }
.ln-err { color: var(--danger); background: var(--danger-soft); font-weight: 700; }
.editor { flex: 1; min-width: 0; padding: 12px; border: none; outline: none; resize: none; font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.6; color: var(--text); background: transparent; white-space: pre; overflow: auto; }

/* 底部状态栏 */
.pane-foot { flex-shrink: 0; display: flex; align-items: center; gap: 10px; padding: 5px 12px; border-top: 1px solid var(--card-border); background: color-mix(in srgb, var(--text) 2%, transparent); font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-mono); }
.ff { white-space: nowrap; }
.ff-sep { color: var(--card-border); }

/* 结构视图工具条 */
.tsearch { display: inline-flex; align-items: center; gap: 5px; max-width: 170px; padding: 4px 9px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--card); color: var(--muted); }
.tsearch:focus-within { border-color: var(--primary); color: var(--primary); }
.tsearch input { flex: 1; min-width: 0; border: none; outline: none; background: transparent; font-size: var(--fs-sm); color: var(--text); }
.match-info { font-size: var(--fs-xs); color: var(--muted); font-family: var(--font-num); white-space: nowrap; }
.chk { display: inline-flex; align-items: center; gap: 5px; font-size: var(--fs-sm); color: var(--muted); cursor: pointer; white-space: nowrap; }
.chk input { cursor: pointer; }
.mini { padding: 4px 9px; font-size: var(--fs-xs); border: 1px solid var(--border-strong); background: var(--card); color: var(--muted); border-radius: var(--r-sm); cursor: pointer; line-height: 1.4; }
.mini:hover:not(:disabled) { border-color: var(--primary); color: var(--primary); }
.mini.on { background: var(--primary-soft); border-color: var(--border-blue); color: var(--primary-hover); font-weight: 600; }
.mini:disabled { opacity: 0.45; cursor: default; }

/* 结果 / 结构主体 */
.pane-body { flex: 1; min-height: 0; overflow: hidden; display: flex; flex-direction: column; }
.output { margin: 0; flex: 1; padding: 12px; font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.6; color: var(--text); overflow: auto; white-space: pre; }
.ph { margin: 0; padding: 16px; font-size: var(--fs-sm); color: var(--muted); }
.validate-ok { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-3); color: var(--success-deep); text-align: center; }
.validate-icon { width: 48px; height: 48px; display: grid; place-items: center; color: var(--success-deep); background: var(--success-soft); border: 1px solid var(--success-border); border-radius: var(--r-pill); }
.validate-ok b { font-size: var(--fs-lg); font-weight: 700; }
.validate-ok > span:last-child { font-size: var(--fs-sm); color: var(--muted); }

/* 高亮输出（行号 sticky，横向滚动时固定在左） */
.hl-scroll { flex: 1; min-height: 0; overflow: auto; padding: 12px 0; font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.6; }
.hrow { display: flex; min-width: max-content; }
.hnum { position: sticky; left: 0; flex-shrink: 0; width: 44px; padding-right: 10px; text-align: right; color: var(--muted); background: var(--card); user-select: none; }
.hcode { white-space: pre; padding-right: 12px; }
.tok-key { color: var(--primary-hover); }
.tok-str { color: var(--success); }
.tok-num { color: var(--primary); }
.tok-bool { color: var(--warn); }
.tok-null { color: var(--muted); font-style: italic; }
.tok-punct { color: var(--muted); }

/* 树 */
.tree { flex: 1; min-height: 0; overflow: auto; padding: 8px 4px; font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.9; }
.trow { display: flex; align-items: baseline; white-space: nowrap; border-radius: var(--r-xs); }
.trow:hover { background: color-mix(in srgb, var(--text) 3%, transparent); }
.trow.is-match { background: var(--primary-soft); }
.trow.is-current { background: var(--warn-border); }
.tw { flex-shrink: 0; width: 16px; text-align: center; color: var(--muted); cursor: pointer; user-select: none; }
.tw.ghost { cursor: default; }
.tk { color: var(--primary-hover); }
.tk.root { color: var(--text); font-weight: 600; }
.colon { color: var(--muted); margin: 0 4px 0 1px; }
.tsum { color: var(--muted); }
.tv { cursor: pointer; overflow: hidden; text-overflow: ellipsis; }
.tv:hover { text-decoration: underline; }
.v-string { color: var(--success); }
.v-number { color: var(--primary); }
.v-boolean { color: var(--primary); }
.v-null { color: var(--muted); }
.hl { background: var(--amber-light); color: var(--text-soft); border-radius: 2px; }

/* 类型标签 */
.ttag { margin-left: 8px; padding: 1px 7px; font-size: var(--fs-xs); border-radius: var(--r-xs); font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; white-space: nowrap; }
.tt-object { color: var(--muted); background: color-mix(in srgb, var(--text) 6%, transparent); }
.tt-array { color: var(--warn); background: var(--warn-tint); }
.tt-string { color: var(--success); background: var(--success-tint); }
.tt-number { color: var(--primary); background: var(--primary-soft); }
.tt-boolean { color: var(--primary-hover); background: var(--primary-soft); }
.tt-null { color: var(--muted); background: color-mix(in srgb, var(--text) 6%, transparent); }

/* 右侧栏 */
.side { min-width: 0; display: flex; flex-direction: column; gap: 10px; overflow: auto; }
.side-card { flex-shrink: 0; padding: 12px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); }
.side-title { margin-bottom: 10px; font-size: var(--fs-base); font-weight: 700; }
.stat-rows { display: flex; flex-direction: column; gap: 8px; }
.srow { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-sm); color: var(--muted); }
.srow b { font-size: var(--fs-md); color: var(--primary-hover); font-family: var(--font-num); }
.samples { display: flex; flex-direction: column; gap: 8px; }
.sample { display: flex; align-items: center; gap: 7px; width: 100%; padding: 8px 10px; font-size: var(--fs-sm); border: 1px solid var(--card-border); background: var(--card); color: var(--text); border-radius: var(--r-sm); cursor: pointer; text-align: left; transition: all 0.15s; }
.sample:hover { border-color: var(--border-blue); color: var(--primary-hover); background: var(--primary-soft); }
.sample-clear { justify-content: center; background: var(--primary-soft); border-color: transparent; color: var(--primary-hover); font-weight: 600; }
.sample-clear:hover { border-color: var(--border-blue); }
</style>
