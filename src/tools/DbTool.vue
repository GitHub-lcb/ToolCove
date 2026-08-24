<script setup>
import { ref, computed, onMounted, onBeforeUnmount, nextTick, inject } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import Icon from "../Icon.vue";
import DbConnModal from "./DbConnModal.vue";
import DbTableTree from "./DbTableTree.vue";
import DbDetailModal from "./DbDetailModal.vue";
import { relativeTime } from "../shared.js";
import { askConfirm } from "../confirm.js";
import { aiComplete, aiChat, isAIConfigured } from "../ai.js";
import { loadToolbox, saveToolbox, flushToolbox } from "../toolboxStore.js";
import { saveSecureToolbox, flushSecureToolbox, protectDbConnections, restoreDbConnections } from "../secureToolbox.js";
import {
  DB_TYPES, defaultConn, validateConn, connLabel, isOracleDriver, driverInstallUrl, isTrustedDriverUrl, isSha256, isReadOnlySql, dialectHint,
  sanitizeForSave, hydrateConn, pushHistory, toMarkdownTable,
  quoteIdent, genUpdateSQL, genInsertSQL, genDeleteSQL, genDeleteByRowSQL, extractTable,
  toCSV, toJSONExport, pushFav, favLabel,
} from "../db.js";

const props = defineProps({
  showToast: { type: Function, default: () => {} },
});

const HIST_MAX = 20;
const isTauri = !!window.__TAURI_INTERNALS__;

const typeMeta = (t) => DB_TYPES.find((x) => x.type === t) || DB_TYPES[0];

// ---------- 连接管理 ----------
const conns = ref([]); // [{ id, type, name, host, port, user, password, database, rememberPwd, oracleDriver, oracleService }]
const editing = ref(null); // 编辑中的表单副本；null = 不显示表单
const editingNew = ref(false); // 新建 or 编辑已有
const connState = ref({}); // { [id]: { connecting, connected, error } }
const activeConnId = ref(""); // 当前已连接的连接 id
const collapsed = ref(false); // 连接管理面板收起（给 SQL 工作区更大空间）
const allDrivers = ref([]); // 本机全部 ODBC 驱动
const oracleDrivers = computed(() => allDrivers.value.filter(isOracleDriver)); // Oracle 相关（仅这些可用于 Oracle 连接）
const driverUrl = ref(""); // HTTPS 更新服务器地址（资产化存储；拼装完整 zip 地址由 driverInstallUrl 处理）
const driverSha256 = ref("");
const installingDriver = ref(false);

// 活动连接：activeConnId 存的是 Rust 侧连接 id（c1/c2...），与前端列表 id（c+时间戳）不同体系，
// 需经 connState[c.id].connId 反查才能拿到连接配置（类型/名称，决定 SQL 方言）
const activeConn = computed(() => {
  if (!activeConnId.value) return null;
  return conns.value.find((c) => (connState.value[c.id] || {}).connId === activeConnId.value) || null;
});
const currentLabel = computed(() => (activeConn.value ? connLabel(activeConn.value) : "未连接"));
// 已连接：以真实连接状态为准（重启恢复的旧 connId 不视为已连接）
const connected = computed(() => !!activeConn.value && !!connState.value[activeConn.value.id]?.connected);

// 恢复连接列表、上次活动连接、SQL 草稿与面板状态（数据资产化：走 load_data/save_data 落盘 AppData）
async function loadConns() {
  const raw = await loadToolbox("db-conns", []);
  const hasPlainPassword = Array.isArray(raw) && raw.some((item) => item?.rememberPwd && item.password && !String(item.password).startsWith("enc:"));
  const restored = await restoreDbConnections(raw);
  conns.value = (Array.isArray(restored) ? restored : []).map((item) => hydrateConn(item));
  if (hasPlainPassword) {
    try {
      await saveConns(conns.value);
    } catch (e) {
      props.showToast("旧连接密码加密迁移失败，本次未写入明文：" + e);
    }
  }
  const s = await loadToolbox("db", {});
  if (typeof s.sql === "string") sql.value = s.sql;
  if (typeof s.collapsed === "boolean") collapsed.value = s.collapsed;
  if (conns.value.some((c) => c.id === s.activeConnId)) activeConnId.value = s.activeConnId;
}
async function saveConns(list = conns.value) {
  saveSecureToolbox(
    "db-conns",
    list.map((c) => sanitizeForSave(c)),
    protectDbConnections,
    (e) => props.showToast("连接配置加密失败：" + e)
  );
  await flushSecureToolbox("db-conns");
}
function persistStore() {
  saveToolbox("db", { sql: sql.value, activeConnId: activeConnId.value, collapsed: collapsed.value });
}
function toggleCollapsed() {
  collapsed.value = !collapsed.value;
  persistStore();
}

function startEdit(conn) {
  editingNew.value = !conn;
  editing.value = conn ? hydrateConn({ ...conn }) : defaultConn("mysql");
}
function cancelEdit() {
  editing.value = null;
}
async function saveConn() {
  const errors = validateConn(editing.value);
  if (errors.length) {
    props.showToast(errors[0]);
    return;
  }
  const form = { ...editing.value };
  let next;
  if (editingNew.value) {
    form.id = "c" + Date.now().toString(36) + Math.random().toString(16).slice(2, 5);
    next = [form, ...conns.value];
  } else {
    const idx = conns.value.findIndex((c) => c.id === form.id);
    next = [...conns.value];
    if (idx >= 0) next[idx] = form;
  }
  try {
    await saveConns(next);
  } catch (e) {
    return props.showToast("连接配置保存失败，未写入明文密码：" + e);
  }
  conns.value = next;
  cancelEdit();
  props.showToast("连接配置已保存");
}

async function removeConn(conn) {
  if (!conn) return;
  // 用 Rust 侧 connId 关闭（与前端本地 id 区分），避免连接泄漏
  const cid = connState.value[conn.id]?.connId;
  if (cid) {
    try { await invoke("db_close", { connId: cid }); } catch { /* 忽略 */ }
    if (activeConnId.value === cid) activeConnId.value = "";
  }
  connState.value = { ...connState.value, [conn.id]: undefined };
  const next = conns.value.filter((c) => c.id !== conn.id);
  try {
    await saveConns(next);
  } catch (e) {
    return props.showToast("删除连接失败：" + e);
  }
  conns.value = next;
  props.showToast("连接已删除");
}

async function pickSqliteFile() {
  if (!isTauri) return props.showToast("请使用桌面端选择文件");
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3"] }],
  });
  if (typeof picked === "string" && picked) editing.value.database = picked;
}

async function loadDrivers() {
  if (!isTauri) return;
  try {
    allDrivers.value = await invoke("db_drivers");
  } catch { /* 无 ODBC 环境不阻塞界面 */ }
}

// ODBC 原始错误转可读文案：Oracle 连接被其他驱动（如 SQL Server）接管时给出明确指引
function friendlyDbError(e, type) {
  const msg = String(e);
  if (type === "oracle" && /SQL Server/.test(msg)) {
    return `${msg}（连接串被 SQL Server 驱动处理：请在表单中重新选择 Oracle 相关 ODBC 驱动）`;
  }
  return msg;
}

// 从内网服务器一键安装 Oracle ODBC 驱动（下载合并包 → 解压 → 提权注册）
async function installDriver() {
  const url = driverInstallUrl(driverUrl.value);
  if (!url) return props.showToast("请填写驱动服务器地址");
  if (!isTrustedDriverUrl(url)) return props.showToast("驱动地址必须使用 HTTPS；仅本机开发地址允许 HTTP");
  if (!isSha256(driverSha256.value)) return props.showToast("请填写发布方提供的 64 位 SHA-256 校验值");
  if (!isTauri) return props.showToast("请使用桌面端安装驱动");
  installingDriver.value = true;
  try {
    const name = await invoke("db_install_oracle_driver", { url, sha256: driverSha256.value.trim() });
    saveToolbox("db-driver-url", driverUrl.value.trim());
    saveToolbox("db-driver-sha256", driverSha256.value.trim());
    allDrivers.value = await invoke("db_drivers");
    editing.value.oracleDriver = name;
    props.showToast(`驱动安装成功：${name}，可测试连接`);
  } catch (e) {
    props.showToast(friendlyDbError(e, "oracle"));
  } finally {
    installingDriver.value = false;
  }
}

// 选中连接：已连接则切换为活动连接（不关其他连接，支持多连接并存）；
// 未连接则自动建立连接
async function selectConn(conn) {
  if (!isTauri) return props.showToast("数据库工具需要桌面端运行");
  const st = connState.value[conn.id] || {};
  if (st.connecting) return;
  // 已连接：直接设为活动（用 Rust 侧 connId），加载其表结构
  if (st.connected) {
    const cid = st.connId || conn.id;
    activeConnId.value = cid;
    closeAllTabs();
    error.value = "";
    persistStore();
    loadTables();
    return;
  }
  connState.value = { ...connState.value, [conn.id]: { ...st, connecting: true, error: "" } };
  try {
    const connId = await invoke("db_connect", { opts: conn });
    activeConnId.value = connId;
    connState.value = { ...connState.value, [conn.id]: { connected: true, connecting: false, error: "", connId } };
    closeAllTabs();
    error.value = "";
    persistStore();
    props.showToast(`已连接 ${connLabel(conn)}`);
    loadTables();
  } catch (e) {
    connState.value = { ...connState.value, [conn.id]: { connected: false, connecting: false, error: String(e) } };
    props.showToast(friendlyDbError(e, conn.type));
  }
}

async function testEditingConn() {
  const errors = validateConn(editing.value);
  if (errors.length) return props.showToast(errors[0]);
  if (!isTauri) return props.showToast("数据库工具需要桌面端运行");
  const form = editing.value;
  const st = connState.value.__testing || {};
  connState.value = { ...connState.value, __testing: { ...st, connecting: true } };
  try {
    const r = await invoke("db_test", { opts: form });
    props.showToast(`连接成功，耗时 ${r.durationMs} ms`);
  } catch (e) {
    props.showToast(friendlyDbError(e, form.type));
  } finally {
    const cur = connState.value.__testing || {};
    connState.value = { ...connState.value, __testing: { ...cur, connecting: false } };
  }
}

async function disconnect() {
  if (!activeConnId.value) return;
  try { await invoke("db_close", { connId: activeConnId.value }); } catch { /* 忽略 */ }
  activeConnId.value = "";
  meta.value = { tables: [], columns: {}, loading: false, error: "" };
  tableFilter.value = "";
  expanded.value = {};
  closeAllTabs();
  persistStore();
  props.showToast("已断开连接");
}

// ---------- 表结构树 ----------
// meta：当前连接的表清单与列信息；columns 按表名懒加载缓存
const meta = ref({ tables: [], columns: {}, loading: false, error: "" });
const expanded = ref({}); // { [表名]: true } 展开中的表
const loadingCols = ref({}); // { [表名]: true } 正在加载列信息
const tableFilter = ref(""); // 表名过滤（不区分大小写）
const sqlTextarea = ref(null);
const sqlGutterRef = ref(null);
const sqlErrLine = ref(0); // 报错行号（从错误文本解析 "line N"，0 = 无）

// SQL 编辑器行号（与 textarea 滚动同步）
const sqlLineCount = computed(() => sql.value.split("\n").length);
function syncSqlGutter() {
  const ta = sqlTextarea.value;
  const g = sqlGutterRef.value;
  if (ta && g) g.scrollTop = ta.scrollTop;
}
function parseErrLine(text) {
  const m = String(text || "").match(/line\s+(\d+)/i);
  return m ? Number(m[1]) : 0;
}

// ---------- SQL 自动补全（表名 / 列名） ----------
// 触发：FROM/JOIN/INTO/UPDATE/TABLE 关键字后提示表名；`表名.` 后提示列名（未加载列懒加载）
const suggest = ref({ show: false, list: [], index: 0, start: 0, end: 0, mode: "table" });
let suggestTimer = null;

// 从光标前文本推断补全上下文；返回 { mode, table?, prefix } 或 null
function suggestContext(before) {
  const word = before.match(/[`"'\w$]+$/);
  const prefix = word ? word[0] : "";
  const beforeWord = word ? before.slice(0, before.length - prefix.length) : before;
  // 列名上下文：`表名.` 或 表名. 前缀（引号包裹的表名也支持）
  const dot = before.match(/([`"'\w$]+)\.([`"'\w$]*)$/);
  if (dot) {
    return {
      mode: "column",
      table: dot[1].replace(/^[`"']|[`"']$/g, ""),
      prefix: dot[2].replace(/^[`"']/, ""),
      start: before.length - dot[0].length + dot[1].length + 1,
    };
  }
  // 表名上下文：FROM/JOIN/INTO/UPDATE/TABLE 关键字后
  if (/(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+["'`]?$/i.test(beforeWord)) {
    return { mode: "table", prefix: prefix.replace(/^[`"']/, ""), start: before.length - prefix.length };
  }
  return null;
}

function showSuggest(ctx, list, end) {
  if (!list.length) return closeSuggest();
  suggest.value = { show: true, list, index: 0, start: ctx.start, end, mode: ctx.mode };
}

function closeSuggest() {
  if (suggest.value.show) suggest.value = { ...suggest.value, show: false };
}

async function updateSuggest() {
  const ta = sqlTextarea.value;
  if (!ta) return;
  const pos = ta.selectionStart;
  const before = sql.value.slice(0, pos);
  const ctx = suggestContext(before);
  if (!ctx) return closeSuggest();
  if (ctx.mode === "table") {
    const list = meta.value.tables
      .filter((t) => (t.name || "").toLowerCase().startsWith(ctx.prefix.toLowerCase()))
      .map((t) => ({ name: t.name, kind: t.kind === "view" ? "视图" : "表" }));
    showSuggest(ctx, list, pos);
    return;
  }
  // 列名：表列未缓存时懒加载（尽量给出）
  let cols = meta.value.columns[ctx.table];
  if (!cols) {
    try {
      cols = (await invoke("db_columns", { connId: activeConnId.value, table: ctx.table })) || [];
      meta.value = { ...meta.value, columns: { ...meta.value.columns, [ctx.table]: cols } };
    } catch {
      return closeSuggest();
    }
  }
  const list = cols
    .filter((c) => (c.name || "").toLowerCase().startsWith(ctx.prefix.toLowerCase()))
    .map((c) => ({ name: c.name, type: c.type }));
  showSuggest(ctx, list, pos);
}

// 防抖触发：输入/点击/移动光标后重算
function scheduleSuggest() {
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(updateSuggest, 120);
}

// 补全应用：替换当前词为方言化标识符，光标落在词尾
function applySuggest() {
  const s = suggest.value;
  if (!s.show || !s.list.length) return;
  const ident = quoteIdent(s.list[s.index].name, activeConn.value?.type);
  sql.value = sql.value.slice(0, s.start) + ident + sql.value.slice(s.end);
  const np = s.start + ident.length;
  nextTick(() => {
    const ta = sqlTextarea.value;
    if (!ta) return;
    ta.focus();
    ta.selectionStart = ta.selectionEnd = np;
  });
  closeSuggest();
}

// 键盘：↑↓ 选择、Enter/Tab 补全、Esc 关闭；无候选时 Tab 走缩进
function onSqlKeydown(e) {
  const s = suggest.value;
  if (s.show) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      s.index = (s.index + 1) % s.list.length;
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      s.index = (s.index - 1 + s.list.length) % s.list.length;
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      applySuggest();
      return;
    }
    if (e.key === "Escape") {
      closeSuggest();
      return;
    }
  }
  if (e.key === "Tab") onSqlTab(e);
  else scheduleSuggest();
}

// 过滤后的表清单：按名称包含匹配；展开状态与列缓存按表名，不受过滤影响
const filteredTables = computed(() => {
  const kw = tableFilter.value.trim().toLowerCase();
  if (!kw) return meta.value.tables;
  return meta.value.tables.filter((t) => (t.name || "").toLowerCase().includes(kw));
});
// 按表/视图分组（Navicat 对象树：分组标题 + 计数）
const tableGroups = computed(() => ({
  table: filteredTables.value.filter((t) => t.kind !== "view"),
  view: filteredTables.value.filter((t) => t.kind === "view"),
}));

// 查询前 100 行的方言：Oracle 用 FETCH FIRST，其余用 LIMIT
function limitClause(dbType) {
  return dbType === "oracle" ? "FETCH FIRST 100 ROWS ONLY" : "LIMIT 100";
}

// 加载当前连接的表/视图清单
async function loadTables() {
  if (!activeConnId.value) {
    meta.value = { tables: [], columns: {}, loading: false, error: "" };
    return;
  }
  // 连接切换后，旧连接的标签页与编辑上下文一并失效
  closeAllTabs();
  meta.value = { ...meta.value, loading: true, error: "" };
  try {
    const tables = await invoke("db_tables", { connId: activeConnId.value });
    meta.value = { tables: tables || [], columns: {}, loading: false, error: "" };
    expanded.value = {};
  } catch (e) {
    meta.value = { tables: [], columns: {}, loading: false, error: String(e) };
  }
}

// 展开/收起表节点；首次展开时懒加载列结构
function toggleTable(t) {
  expanded.value = { ...expanded.value, [t.name]: !expanded.value[t.name] };
  if (expanded.value[t.name] && !meta.value.columns[t.name] && !loadingCols.value[t.name]) {
    loadColumns(t.name);
  }
}

async function loadColumns(table) {
  loadingCols.value = { ...loadingCols.value, [table]: true };
  try {
    const cols = await invoke("db_columns", { connId: activeConnId.value, table });
    meta.value = { ...meta.value, columns: { ...meta.value.columns, [table]: cols || [] } };
  } catch (e) {
    props.showToast(String(e));
  } finally {
    loadingCols.value = { ...loadingCols.value, [table]: false };
  }
}

// 点表名：填充 SELECT 到编辑器（不执行），并展开列结构看字段；双击打开表数据标签
function onTreeNameClick(t) {
  sql.value = `SELECT * FROM ${quoteIdent(t.name, activeConn.value?.type)} ${limitClause(activeConn.value?.type)}`;
  if (!expanded.value[t.name]) toggleTable(t);
  props.showToast("SELECT 已填入编辑器，Ctrl+Enter 执行（双击表名打开表数据）");
}

// ---------- 表树右键菜单（全局 openCtxMenu，App.vue provide） ----------
const openCtxMenu = inject("openCtxMenu");
function onTreeCtx(e, t) {
  openCtxMenu(e, [
    { label: "打开表数据", icon: "database", fn: () => quickQuery(t) },
    { label: "生成 SELECT 模板", icon: "note", fn: () => genSelectTemplate(t) },
    { label: "生成 INSERT 模板", icon: "plus", fn: () => genInsertTemplate(t) },
    { label: "生成 UPDATE 模板", icon: "edit", fn: () => genUpdateTemplate(t) },
    { label: "查看索引", icon: "layers", fn: () => openDetail(t, "indexes") },
    { label: "查看 DDL", icon: "note", fn: () => openDetail(t, "ddl") },
    { label: "复制表名", icon: "copy", fn: () => copyTableName(t) },
  ]);
}
function onColCtx(e, t, c) {
  openCtxMenu(e, [
    { label: "插入列名到编辑器", icon: "edit", fn: () => insertColumn(c.name) },
    { label: "复制列名", icon: "copy", fn: () => copyTableName({ name: c.name }) },
    { label: "生成 WHERE 条件", icon: "filter", fn: () => genWhereCond(c.name) },
  ]);
}

// ---------- 表详情（索引 / DDL） ----------
// detail：{ table, tab, loading, error, indexes, ddl, loaded }，双 Tab 各自懒加载、切换不重复请求
const detail = ref(null);
async function openDetail(t, tab) {
  detail.value = {
    table: t.name,
    tab,
    loading: false,
    error: "",
    indexes: [],
    ddl: "",
    loaded: { indexes: false, ddl: false },
  };
  await loadDetailTab(tab);
}
async function loadDetailTab(tab) {
  const d = detail.value;
  if (!d || d.loaded[tab]) return;
  d.loading = true;
  d.error = "";
  try {
    if (tab === "indexes") {
      d.indexes = (await invoke("db_indexes", { connId: activeConnId.value, table: d.table })) || [];
    } else {
      d.ddl = (await invoke("db_ddl", { connId: activeConnId.value, table: d.table })) || "";
    }
    d.loaded[tab] = true;
  } catch (e) {
    d.error = String(e);
  } finally {
    d.loading = false;
  }
}
function switchDetailTab(tab) {
  detail.value.tab = tab;
  loadDetailTab(tab);
}
async function copyDetailDDL() {
  const ok = await copyText(detail.value.ddl);
  props.showToast(ok ? "DDL 已复制" : "复制失败");
}
function useDetailDDL() {
  sql.value = detail.value.ddl;
  detail.value = null;
  props.showToast("DDL 已填入编辑器");
}
function tableIdent(t) {
  return quoteIdent(t.name, activeConn.value?.type);
}
function genSelectTemplate(t) {
  sql.value = `SELECT * FROM ${tableIdent(t)} WHERE 1=1`;
  props.showToast("SELECT 模板已填入编辑器");
}
function genInsertTemplate(t) {
  const cols = (meta.value.columns[t.name] || []).filter((c) => !c.pk);
  if (!cols.length) return props.showToast("请先展开表加载列信息");
  const names = cols.map((c) => quoteIdent(c.name, activeConn.value?.type)).join(", ");
  const vals = cols.map(() => "?").join(", ");
  sql.value = `INSERT INTO ${tableIdent(t)} (${names}) VALUES (${vals});`;
  props.showToast("INSERT 模板已填入编辑器（? 替换为实际值）");
}
function genUpdateTemplate(t) {
  const cols = (meta.value.columns[t.name] || []).filter((c) => !c.pk);
  const pks = (meta.value.columns[t.name] || []).filter((c) => c.pk);
  if (!cols.length || !pks.length) return props.showToast("需要主键与列信息（先展开表），才能生成 UPDATE 模板");
  const sets = cols.map((c) => `${quoteIdent(c.name, activeConn.value?.type)} = ?`).join(",\n  ");
  const where = pks.map((c) => `${quoteIdent(c.name, activeConn.value?.type)} = ?`).join(" AND ");
  sql.value = `UPDATE ${tableIdent(t)}\nSET ${sets}\nWHERE ${where};`;
  props.showToast("UPDATE 模板已填入编辑器（? 替换为实际值）");
}
async function copyTableName(t) {
  const ok = await copyText(t.name);
  props.showToast(ok ? `已复制：${t.name}` : "复制失败");
}
function genWhereCond(col) {
  sql.value += (sql.value.trim() ? (/\bWHERE\b/i.test(sql.value) ? "\n  AND " : "\nWHERE ") : "WHERE ") + `${quoteIdent(col, activeConn.value?.type)} = ?`;
  props.showToast("WHERE 条件已追加到编辑器");
}

// 双击列名：把带引号的列名插入 SQL 编辑器光标处
function insertColumn(name) {
  const ident = quoteIdent(name, activeConn.value?.type);
  const ta = sqlTextarea.value;
  const pos = ta && typeof ta.selectionStart === "number" ? ta.selectionStart : sql.value.length;
  sql.value = sql.value.slice(0, pos) + ident + sql.value.slice(pos);
  nextTick(() => {
    if (ta) {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = pos + ident.length;
    }
  });
}

// ---------- 标签页系统（Navicat 式：表数据 / 查询结果各占一个标签） ----------
// 标签：{ id, kind: 'table'|'query', title, table, sql, result, pageState, lastSql,
//         editMeta, editingCell, cellDraft, editingNewRow, newRowDraft, selectedRows,
//         filterMode, filterDraft, running }
let tabSeq = 0;
function makeTab(kind, title) {
  return {
    id: (kind === "table" ? "t" : "q") + ++tabSeq + Date.now().toString(36).slice(-3),
    kind,
    title,
    table: "",
    sql: "",
    result: null,
    pageState: { sql: "", offset: 0, sortable: false, pageable: false },
    lastSql: "",
    editMeta: null,
    editingCell: null,
    cellDraft: "",
    editingNewRow: false,
    newRowDraft: {},
    selectedRows: new Set(),
    filterMode: false,
    filterDraft: {},
    running: false,
  };
}
const tabs = ref([]);
const activeTabId = ref("");
const activeTab = computed(() => tabs.value.find((t) => t.id === activeTabId.value) || null);

// SQL 摘要：压空白后截取前 24 字符（查询标签标题）
function summarizeSql(s) {
  const one = String(s || "").replace(/\s+/g, " ").trim();
  return one.length > 24 ? one.slice(0, 24) + "…" : one;
}

// 打开/激活表数据标签：同表只开一个，双击表名触发（Navicat 操作习惯）
async function quickQuery(t) {
  if (!connected.value) return;
  let tb = tabs.value.find((x) => x.kind === "table" && x.table === t.name);
  if (!tb) {
    tb = makeTab("table", t.name);
    tb.table = t.name;
    tb.sql = `SELECT * FROM ${quoteIdent(t.name, activeConn.value?.type)} ${limitClause(activeConn.value?.type)}`;
    tabs.value.push(tb);
  }
  activeTabId.value = tb.id;
  await runSql(tb.sql, { targetId: tb.id, record: false });
}

function switchTab(id) {
  if (activeTabId.value === id) return;
  activeTabId.value = id;
  error.value = "";
  sqlErrLine.value = 0;
}
function closeTab(id) {
  const i = tabs.value.findIndex((t) => t.id === id);
  if (i < 0) return;
  tabs.value.splice(i, 1);
  if (activeTabId.value === id) {
    const next = tabs.value[i] || tabs.value[i - 1];
    activeTabId.value = next ? next.id : "";
  }
}
function closeOtherTabs(id) {
  tabs.value = tabs.value.filter((t) => t.id === id);
  activeTabId.value = id;
}
function closeAllTabs() {
  tabs.value = [];
  activeTabId.value = "";
}
function onTabCtx(e, t) {
  openCtxMenu(e, [
    { label: "关闭标签", icon: "x", fn: () => closeTab(t.id) },
    { label: "关闭其他标签", icon: "minus", fn: () => closeOtherTabs(t.id) },
    { label: "关闭全部标签", icon: "trash", fn: () => closeAllTabs() },
  ]);
}

// ---------- SQL 执行 ----------
const sql = ref("");
const running = ref(false);
const error = ref("");
const history = ref([]); // [{ sql, ts }]
const showHistory = ref(false);
const PAGE = 100; // 前端分页步长（与 quickQuery 的 LIMIT 一致）
const sqlHeight = ref(160); // SQL 编辑器高度（可拖拽分隔条调整，双击重置）
const dragging = ref(false);
let dragStartY = 0;
let dragStartH = 0;

// 拖拽分隔条：调整 SQL 编辑器与结果区高度
function onResizeDown(e) {
  dragging.value = true;
  dragStartY = e.clientY;
  dragStartH = sqlHeight.value;
  document.addEventListener("mousemove", onResizeMove);
  document.addEventListener("mouseup", onResizeUp);
}
function onResizeMove(e) {
  const delta = e.clientY - dragStartY;
  sqlHeight.value = Math.min(420, Math.max(96, dragStartH + delta));
}
function onResizeUp() {
  dragging.value = false;
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeUp);
}
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWinKey);
  document.removeEventListener("mousemove", onResizeMove);
  document.removeEventListener("mouseup", onResizeUp);
  flushToolbox(); // 卸载前冲刷全部待写数据，避免视图切换丢失
});

const canRun = computed(() => connected.value && !running.value && sql.value.trim() !== "");

// 简单 SELECT 才可安全追加 LIMIT/OFFSET/ORDER BY（无分号、无 LIMIT/ORDER BY）
function simpleSelect(sqlText) {
  return /^\s*SELECT\b/i.test(sqlText) && !/;/m.test(sqlText) && !/\bLIMIT\b/i.test(sqlText) && !/\bORDER\s+BY\b/i.test(sqlText);
}
// 剥离尾部 LIMIT n（排序时把 ORDER BY 插在 LIMIT 前）
function stripLimit(sqlText) {
  const m = sqlText.match(/(.*?)\s+LIMIT\s+\d+\s*$/is);
  return m ? m[1] : sqlText;
}

// 执行 SQL：结果写入目标标签（targetId 指定时刷新该标签；否则复用当前查询标签，无则新建）。
// record=false 表示内部刷新（表数据/排序/过滤），不写入历史
async function runSql(selectedText, opts = {}) {
  const { targetId, record = true } = opts;
  if (!connected.value) return props.showToast("请先选择并连接数据库");
  const exec = (selectedText && selectedText.trim()) ? selectedText.trim() : sql.value.trim();
  if (!exec) return;
  if (!isTauri) return props.showToast("数据库工具需要桌面端运行");
  if (record && !isReadOnlySql(exec)) {
    const ok = await askConfirm({
      title: "执行写 SQL",
      message: "该语句可能修改数据库数据或结构。执行后无法由本工具自动撤销，确认继续吗？",
      okText: "确认执行",
      cancelText: "取消",
      danger: true,
    });
    if (!ok) return;
  }
  let target = targetId ? tabs.value.find((t) => t.id === targetId) : null;
  if (!target) {
    // 当前是查询标签则复用（Navicat 查询窗口行为），否则新建查询标签
    target = activeTab.value?.kind === "query" ? activeTab.value : makeTab("query", summarizeSql(exec));
    if (!tabs.value.includes(target)) tabs.value.push(target);
    activeTabId.value = target.id;
    target.sql = exec;
    target.title = summarizeSql(exec);
  }
  target.running = true;
  running.value = true;
  error.value = "";
  sqlErrLine.value = 0;
  target.result = null;
  target.pageState = { sql: exec, offset: 0, sortable: simpleSelect(exec), pageable: simpleSelect(exec) };
  try {
    const r = await invoke("db_query", { connId: activeConnId.value, sql: exec });
    target.result = r;
    target.lastSql = exec;
    if (record) {
      history.value = pushHistory(history.value, exec, HIST_MAX);
      saveToolbox("db-history", history.value);
    }
    await refreshEditability(target);
  } catch (e) {
    error.value = String(e);
    sqlErrLine.value = parseErrLine(error.value);
  } finally {
    target.running = false;
    running.value = false;
  }
}

// Ctrl+Enter 执行：有选区只执行选中片段，无选区执行全文
function onRunSql() {
  const ta = sqlTextarea.value;
  if (ta && typeof ta.selectionStart === "number" && ta.selectionStart !== ta.selectionEnd) {
    const sel = sql.value.slice(ta.selectionStart, ta.selectionEnd);
    if (sel.trim()) return runSql(sel);
  }
  runSql();
}

// 加载更多：追加 LIMIT/OFFSET 续查并拼接结果（仅简单 SELECT 可用）
async function loadMore() {
  const t = activeTab.value;
  const st = t?.pageState;
  if (!t || !st?.pageable || !t.result || t.running) return;
  const off = st.offset + t.result.rows.length;
  const sqlText = `${st.sql} LIMIT ${PAGE} OFFSET ${off}`;
  t.running = true;
  running.value = true;
  try {
    const r = await invoke("db_query", { connId: activeConnId.value, sql: sqlText });
    if (!r.columns || !r.columns.length) {
      props.showToast("没有更多数据了");
      return;
    }
    t.result = { ...t.result, rows: [...t.result.rows, ...(r.rows || [])], truncated: r.truncated || t.result.truncated };
    st.offset = off;
  } catch (e) {
    props.showToast(String(e));
  } finally {
    t.running = false;
    running.value = false;
  }
}

// 列头排序：剥离 LIMIT 后拼 ORDER BY 重新执行，刷新当前标签（简单 SELECT 可用）
async function sortBy(col) {
  const t = activeTab.value;
  const st = t?.pageState;
  if (!t || !st?.sortable || !st.sql) return;
  const dir = st.sortDir === col && st.sortAsc ? "DESC" : "ASC";
  const sqlText = `${stripLimit(st.sql)} ORDER BY ${quoteIdent(col, activeConn.value?.type)} ${dir}`;
  st.sortDir = col;
  st.sortAsc = dir === "ASC";
  await runSql(sqlText, { targetId: t.id, record: false });
  if (error.value) t.sql = st.sql; // 排序失败还原标签内部 SQL
}

function useHistory(h) {
  sql.value = h.sql;
  showHistory.value = false;
  showFavs.value = false;
  persistStore();
}

// ---------- 数据编辑 ----------
// 结果集来自单表查询且列元数据已加载时才可编辑；更新/删除还需主键。
// 全部编辑状态挂在标签页上（activeTab.*），切换标签互不干扰
let cellCanceled = false; // Esc 取消后抑制随后的 blur 保存

const canEdit = computed(() => !!activeTab.value?.editMeta && !!activeTab.value?.result && activeTab.value.result.columns.length > 0);
const canEditRows = computed(() => canEdit.value && activeTab.value.editMeta.pk.length > 0);
// 无主键表也可删除：降级为整行全列条件定位（可能删掉完全相同的重复行）
const canDeleteRows = computed(() => canEdit.value);

// 查询结果就绪后评估可编辑性：提取来源表 → 取列元数据（缺失则懒加载）
async function refreshEditability(target) {
  if (!target) return;
  target.editingCell = null;
  target.editingNewRow = false;
  target.selectedRows = new Set();
  target.editMeta = null;
  if (!connected.value || !target.result || !target.result.columns.length) return;
  const table = extractTable(target.lastSql);
  if (!table) return;
  let cols = meta.value.columns[table];
  if (!cols) {
    try {
      cols = (await invoke("db_columns", { connId: activeConnId.value, table })) || [];
      meta.value = { ...meta.value, columns: { ...meta.value.columns, [table]: cols } };
    } catch { return; } // 元数据获取失败不阻塞结果展示
  }
  if (!cols.length) return;
  target.editMeta = {
    table,
    pk: cols.filter((c) => c.pk).map((c) => c.name),
    cols,
  };
}

// 双击单元格进入编辑（仅当表有主键可生成 UPDATE）
function startCellEdit(ri, ci) {
  const t = activeTab.value;
  if (!t || !canEditRows.value) return;
  cellCanceled = false;
  t.editingCell = { row: ri, col: ci };
  const v = t.result.rows[ri][ci];
  t.cellDraft = v === null || v === undefined ? "" : String(v);
}

// Esc 取消：置标志防止随后 blur 误保存
function cancelCellEdit() {
  cellCanceled = true;
  if (activeTab.value) activeTab.value.editingCell = null;
}

// Enter / 失焦保存：值未变直接退出；否则按主键定位生成 UPDATE 并刷新当前标签
async function saveCellEdit() {
  if (cellCanceled) {
    cellCanceled = false;
    return;
  }
  const t = activeTab.value;
  const ec = t?.editingCell;
  if (!ec) return;
  const oldV = t.result.rows[ec.row][ec.col];
  const oldS = oldV === null || oldV === undefined ? "" : String(oldV);
  const draft = t.cellDraft;
  t.editingCell = null;
  if (oldS === draft) return; // 值未变
  const columns = t.result.columns;
  const row = [...t.result.rows[ec.row]];
  row[ec.col] = draft;
  const sqlText = genUpdateSQL(
    t.editMeta.table, columns, row, [ec.col],
    t.result.colTypes, activeConn.value?.type, t.editMeta.pk
  );
  if (!sqlText) return props.showToast("该列不可更新（无主键或为主键列）");
  try {
    await invoke("db_query", { connId: activeConnId.value, sql: sqlText });
    props.showToast("已更新 1 行");
    await runSql(t.sql, { targetId: t.id, record: false });
  } catch (e) {
    props.showToast(String(e));
  }
}

function toggleSelect(ri) {
  const t = activeTab.value;
  if (!t) return;
  const s = new Set(t.selectedRows);
  if (s.has(ri)) s.delete(ri);
  else s.add(ri);
  t.selectedRows = s;
}

// 删除勾选行：有主键按主键定位；无主键降级为整行全列条件（提示可能删多行）
async function deleteSelected() {
  const t = activeTab.value;
  if (!t) return;
  const rows = [...t.selectedRows];
  if (!rows.length) return props.showToast("请先勾选要删除的行");
  const byPk = t.editMeta.pk.length > 0;
  const ok = await askConfirm({
    title: "删除选中行",
    message: byPk
      ? `将删除 ${rows.length} 行数据，此操作不可撤销。确定继续吗？`
      : `该表无主键，将按整行值匹配删除（${rows.length} 行，若有完全相同的重复行会一并删除）。确定继续吗？`,
    okText: "删除",
  });
  if (!ok) return;
  let done = 0;
  try {
    for (const ri of rows) {
      const sqlText = byPk
        ? genDeleteSQL(
            t.editMeta.table, t.result.columns, t.result.rows[ri],
            t.result.colTypes, activeConn.value?.type, t.editMeta.pk
          )
        : genDeleteByRowSQL(
            t.editMeta.table, t.result.columns, t.result.rows[ri],
            t.result.colTypes, activeConn.value?.type
          );
      if (!sqlText) return props.showToast("无法生成删除语句");
      await invoke("db_query", { connId: activeConnId.value, sql: sqlText });
      done++;
    }
    props.showToast(`已删除 ${done} 行`);
    await runSql(t.sql, { targetId: t.id, record: false });
  } catch (e) {
    props.showToast(String(e));
  }
}

// 添加行：弹出整行输入，确认后生成 INSERT
function startAddRow() {
  const t = activeTab.value;
  if (!t || !canEdit.value) return;
  t.editingNewRow = true;
  const draft = {};
  for (const c of t.editMeta.cols) draft[c.name] = "";
  t.newRowDraft = draft;
}

async function saveNewRow() {
  const t = activeTab.value;
  if (!t) return;
  const columns = t.result.columns;
  const vals = columns.map((name) => t.newRowDraft[name]);
  const sqlText = genInsertSQL(
    t.editMeta.table, columns, vals,
    t.result.colTypes, activeConn.value?.type
  );
  t.editingNewRow = false;
  try {
    await invoke("db_query", { connId: activeConnId.value, sql: sqlText });
    props.showToast("已插入 1 行");
    await runSql(t.sql, { targetId: t.id, record: false });
  } catch (e) {
    props.showToast(String(e));
  }
}

// ---------- AI 辅助 ----------
// 三种模式：gen（自然语言生成 SQL）/ explain（解释报错）/ optimize（优化建议）
const aiMode = ref(""); // "" = 面板关闭
const aiPrompt = ref(""); // 自然语言需求描述
const aiLoading = ref(false);
const aiError = ref("");
const aiReply = ref("");

async function ensureAI() {
  const ok = await isAIConfigured();
  if (!ok) props.showToast("请先在右上角设置里配置 AI 接口（地址 / Key / 模型）");
  return ok;
}

// 表结构上下文：表清单 + 已加载的列信息，帮助 AI 生成贴合实际库的 SQL
function schemaContext() {
  const parts = [];
  if (meta.value.tables.length) {
    parts.push("当前库的表：" + meta.value.tables.map((t) => `${t.name}（${t.kind}）`).join("、"));
  }
  for (const [table, cols] of Object.entries(meta.value.columns)) {
    parts.push(`表 ${table} 的列：` + cols.map((c) => `${c.name} ${c.type}${c.pk ? " 主键" : ""}${c.nullable ? "" : " NOT NULL"}`).join("，"));
  }
  return parts.join("\n");
}

// 自然语言 → SQL（把 AI 回复中的代码块围栏剥掉）
function cleanSQLBlock(text) {
  const m = String(text || "").match(/```(?:sql)?\s*\n([\s\S]*?)\n?```/i);
  return (m ? m[1] : String(text || "")).trim();
}

// 打开「AI 生成 SQL」面板（不立即请求，等用户输入描述）
function openAIGen() {
  aiMode.value = "gen";
  aiError.value = "";
  aiReply.value = "";
}

// 方言上下文：已连接时返回「类型 + 方言要点」，未连接返回 null（AI 需先连接才能按对应方言生成）
function dialectContext() {
  const conn = activeConn.value;
  if (!conn) return null;
  return `${typeMeta(conn.type).label}：${dialectHint(conn.type)}`;
}

async function aiGenSQL() {
  if (!aiPrompt.value.trim()) return props.showToast("请描述你要生成的 SQL 需求");
  const dialect = dialectContext();
  if (!dialect) return props.showToast("请先连接数据库，AI 才能按对应方言生成 SQL");
  if (!(await ensureAI())) return;
  aiLoading.value = true;
  aiError.value = "";
  aiReply.value = "";
  try {
    const ctx = schemaContext();
    const sys =
      "你是资深 DBA 与 SQL 专家。根据用户的中文需求生成一条 SQL 语句，" +
      "只输出 SQL 本身，不要任何解释、前后缀或代码块围栏。" +
      `目标数据库方言：${dialect}。` +
      (ctx ? `\n当前库结构参考：\n${ctx}` : "");
    aiReply.value = await aiComplete(aiPrompt.value, { system: sys, temperature: 0.2 });
  } catch (e) {
    aiError.value = String(e);
  } finally {
    aiLoading.value = false;
  }
}

// 生成的 SQL 填入编辑器（剥掉围栏与解释）
function useAISQL() {
  sql.value = cleanSQLBlock(aiReply.value);
  persistStore();
  props.showToast("已填入编辑器，Ctrl+Enter 执行");
}

// 解释最近一次报错
async function aiExplainError() {
  if (!error.value) return;
  if (!(await ensureAI())) return;
  aiMode.value = "explain";
  aiLoading.value = true;
  aiError.value = "";
  aiReply.value = "";
  try {
    const dialect = dialectContext();
    const sys =
      "你是资深 DBA。用户会给出数据库类型（如未给出则按 SQL 本身推断）、SQL 语句与报错信息。" +
      "用中文解释报错原因，指出具体问题所在，并给出修复后的 SQL（如需要）。保持简洁。";
    const prompt = [
      dialect ? `数据库：${dialect}` : "",
      `SQL：\n${activeTab.value?.lastSql || sql.value}`,
      `报错：\n${error.value}`,
    ]
      .filter(Boolean)
      .join("\n");
    aiReply.value = await aiChat([{ role: "user", content: prompt }], { system: sys });
  } catch (e) {
    aiError.value = String(e);
  } finally {
    aiLoading.value = false;
  }
}

// 当前 SQL 优化建议
async function aiOptimize() {
  if (!sql.value.trim()) return props.showToast("请先输入要优化的 SQL");
  if (!(await ensureAI())) return;
  aiMode.value = "optimize";
  aiLoading.value = true;
  aiError.value = "";
  aiReply.value = "";
  try {
    const dialect = dialectContext();
    const sys =
      "你是资深 DBA。分析用户给出的 SQL：指出潜在性能问题（如全表扫描、缺少索引、N+1 查询、不必要的回表等），" +
      "给出可落地的优化建议，必要时给出改写后的 SQL。改写时严格遵守目标数据库方言，不要换成 MySQL 语法。" +
      `用中文分点输出，保持简洁。${dialect ? `目标数据库方言：${dialect}` : ""}`;
    aiReply.value = await aiComplete(sql.value, { system: sys, temperature: 0.3 });
  } catch (e) {
    aiError.value = String(e);
  } finally {
    aiLoading.value = false;
  }
}

// ---------- 导出 / 收藏夹 / .sql 导入 ----------
const favs = ref([]); // [{ sql, name, ts }]
const showFavs = ref(false);

async function loadFavs() {
  const list = await loadToolbox("db-favs", []);
  favs.value = (Array.isArray(list) ? list : []).slice(0, 50);
}
function saveFavs() {
  saveToolbox("db-favs", favs.value);
}

// 收藏当前编辑器里的 SQL（去重置顶）
function addFav() {
  if (!sql.value.trim()) return props.showToast("没有可收藏的 SQL");
  favs.value = pushFav(favs.value, { sql: sql.value });
  saveFavs();
  props.showToast("已收藏，可在收藏夹里快速取用");
}

function useFav(f) {
  sql.value = f.sql;
  showFavs.value = false;
  persistStore();
}

// 取消收藏
function removeFav(f) {
  favs.value = favs.value.filter((x) => x.sql !== f.sql);
  saveFavs();
}

// 导出当前标签结果集：CSV（带 BOM，Excel 可直开）/ JSON 对象数组
async function exportResult(fmt) {
  const t = activeTab.value;
  if (!t?.result || !t.result.columns.length) return props.showToast("没有可导出的数据");
  if (!isTauri) return props.showToast("导出需要桌面端运行");
  const { columns, rows } = t.result;
  const content =
    fmt === "csv"
      ? toCSV(columns, rows)
      : JSON.stringify(toJSONExport(columns, rows), null, 2);
  const ext = fmt === "csv" ? "csv" : "json";
  const base = t.editMeta?.table || "query-result";
  const path = await saveDialog({
    defaultPath: `${base}-${Date.now().toString().slice(-6)}.${ext}`,
    filters: [{ name: fmt.toUpperCase(), extensions: [ext] }],
  });
  if (typeof path !== "string" || !path) return; // 用户取消
  try {
    await invoke("export_file", { path, content });
    props.showToast(`已导出 ${rows.length} 行到 ${path.split(/[\\/]/).pop()}`);
  } catch (e) {
    props.showToast(String(e));
  }
}

// 导入 .sql 文件：读入后填入编辑器（不自动执行，由用户确认）
async function importSQL() {
  if (!isTauri) return props.showToast("导入需要桌面端运行");
  const picked = await openDialog({
    multiple: false,
    filters: [{ name: "SQL", extensions: ["sql"] }],
  });
  if (typeof picked !== "string" || !picked) return;
  try {
    sql.value = await invoke("read_text_file", { path: picked });
    persistStore();
    props.showToast("已导入 .sql 文件，Ctrl+Enter 执行");
  } catch (e) {
    props.showToast(String(e));
  }
}

// 单元格：NULL 特殊样式；超长截断 + 悬浮完整内容
function cellText(v) {
  return v === null || v === undefined ? "NULL" : String(v);
}
function isNull(v) {
  return v === null || v === undefined;
}
// 数字列右对齐（colTypes 由 Rust 侧按列返回 number/string）
function isNumCol(ci) {
  return (activeTab.value?.result?.colTypes || [])[ci] === "number";
}

// 结果过滤行：按列输入 LIKE 条件重新查询（仅简单 SELECT 可用），状态挂在当前标签
function startFilter() {
  const t = activeTab.value;
  if (!t) return;
  t.filterMode = true;
  const d = {};
  for (const c of t.result?.columns || []) d[c] = "";
  t.filterDraft = d;
}
function escapeLike(v) {
  return v.replace(/%/g, "\\%").replace(/_/g, "\\_");
}
async function applyFilter() {
  const t = activeTab.value;
  const st = t?.pageState;
  if (!t || !st?.sortable) return props.showToast("当前结果不支持条件过滤（请用简单 SELECT）");
  const conds = (t.result?.columns || [])
    .filter((c) => (t.filterDraft[c] || "").trim() !== "")
    .map((c) => `${quoteIdent(c, activeConn.value?.type)} LIKE '%${escapeLike(t.filterDraft[c].trim())}%'`);
  if (!conds.length) return props.showToast("请至少填一个过滤条件");
  const sqlText = `${stripLimit(st.sql)} WHERE ${conds.join(" AND ")}`;
  t.filterMode = false;
  t.sql = sqlText;
  await runSql(sqlText, { targetId: t.id, record: false });
}

// SQL 编辑器 Tab 键插入两个空格（不跳出编辑器）
function onSqlTab(e) {
  e.preventDefault();
  const ta = e.target;
  const { selectionStart: s, selectionEnd: en, value } = ta;
  sql.value = value.slice(0, s) + "  " + value.slice(en);
  nextTick(() => {
    ta.selectionStart = ta.selectionEnd = s + 2;
  });
}

// ---------- 复制 ----------
// 剪贴板写入：Clipboard API 优先，WebView2 降级 textarea + execCommand
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

// 一键复制当前标签结果集（Markdown 表格，含列名标题行）
async function copyResult() {
  const t = activeTab.value;
  if (!t?.result) return;
  const text = toMarkdownTable(t.result.columns, t.result.rows);
  if (!text) return props.showToast("没有可复制的内容");
  const ok = await copyText(text);
  props.showToast(ok ? `已复制 ${t.result.rows.length} 行数据（含标题）` : "复制失败，请手动选择复制");
}

// 点击单元格复制单值：NULL 复制空字符串（与 Navicat 等工具一致），toast 提示 + 单元格闪绿反馈
const copiedCell = ref(null); // { ri, ci } 最近复制的单元格
let copiedCellTimer = null;
async function copyCell(v, ri, ci) {
  const text = v === null || v === undefined ? "" : String(v);
  const ok = await copyText(text);
  if (!ok) return props.showToast("复制失败");
  copiedCell.value = { ri, ci };
  clearTimeout(copiedCellTimer);
  copiedCellTimer = setTimeout(() => (copiedCell.value = null), 600);
  props.showToast(text ? `已复制：${text.length > 30 ? text.slice(0, 30) + "…" : text}` : "已复制（NULL 空值）");
}

onMounted(async () => {
  await loadConns();
  const h = await loadToolbox("db-history", []);
  history.value = (Array.isArray(h) ? h : []).slice(0, HIST_MAX);
  await loadFavs();
  driverUrl.value = await loadToolbox("db-driver-url", "");
  driverSha256.value = await loadToolbox("db-driver-sha256", "");
  await loadDrivers();
  // 恢复的活动连接若未建立，自动重连
  if (activeConnId.value && isTauri) {
    const conn = activeConn.value;
    if (conn) selectConn(conn);
  }
  // 配置类弹窗：禁点遮罩关闭，仅 Esc 可关（连接表单）
  window.addEventListener("keydown", onWinKey);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onWinKey);
  flushSecureToolbox();
  flushToolbox(); // 卸载前冲刷全部待写数据，避免视图切换丢失
});
function onWinKey(e) {
  if (e.key === "Escape" && editing.value) cancelEdit();
  else if (e.key === "Escape" && detail.value) detail.value = null;
}
</script>

<template>
  <div class="dbtool" :class="{ collapsed }">
    <!-- 左栏：连接管理 -->
    <aside class="conn-pane">
      <div class="pane-head">
        <b>连接管理</b>
        <span class="pane-ops">
          <button class="mini-btn" @click="startEdit(null)"><Icon name="plus" :size="13" />新建</button>
          <button class="mini-btn icon" title="收起连接管理，给 SQL 工作区更大空间" @click="toggleCollapsed"><Icon name="chevrons-left" :size="14" /></button>
        </span>
      </div>

      <div class="conn-list">
        <div
          v-for="c in conns"
          :key="c.id"
          class="conn-item"
          :class="{ on: activeConnId === c.id }"
          @click="selectConn(c)"
        >
          <span class="dot" :class="connState[c.id]?.connected ? 'dot-on' : connState[c.id]?.connecting ? 'dot-busy' : 'dot-off'"></span>
          <div class="ci-main">
            <span class="ci-name">{{ connLabel(c) }}</span>
            <span class="ci-sub">
              {{ typeMeta(c.type).label }}<template v-if="connState[c.id]?.error"> · 连接失败</template>
            </span>
          </div>
          <span class="ci-ops">
            <button class="mini-btn" title="编辑" @click.stop="startEdit(c)"><Icon name="edit" :size="13" /></button>
            <button class="mini-btn danger" title="删除" @click.stop="removeConn(c)"><Icon name="trash" :size="13" /></button>
          </span>
        </div>
        <p v-if="!conns.length" class="pane-empty">还没有连接配置，点「新建」添加一个吧</p>
      </div>

      <!-- 表结构树：点表快捷查询前 100 行，展开看列，双击列名插入 SQL（详见 DbTableTree） -->
      <DbTableTree
        v-if="connected"
        :meta="meta"
        v-model:table-filter="tableFilter"
        :filtered-tables="filteredTables"
        :table-groups="tableGroups"
        :expanded="expanded"
        :loading-cols="loadingCols"
        :active-conn="activeConn"
        :toggle-table="toggleTable"
        :on-tree-name-click="onTreeNameClick"
        :quick-query="quickQuery"
        :on-tree-ctx="onTreeCtx"
        :open-detail="openDetail"
        :on-col-ctx="onColCtx"
        :insert-column="insertColumn"
        :load-tables="loadTables"
      />
    </aside>

    <!-- 连接编辑弹窗：配置类弹窗，禁点遮罩关闭，Esc 取消（详见 DbConnModal） -->
    <DbConnModal
      v-if="editing"
      :editing="editing"
      :editing-new="editingNew"
      :oracle-drivers="oracleDrivers"
      v-model:driver-url="driverUrl"
      v-model:driver-sha256="driverSha256"
      :installing-driver="installingDriver"
      @pick-file="pickSqliteFile"
      @refresh-drivers="loadDrivers"
      @install-driver="installDriver"
      @cancel="cancelEdit"
      @test="testEditingConn"
      @save="saveConn"
    />

    <!-- 表详情弹窗：索引 / DDL 双 Tab，懒加载（只读查看，可点遮罩或 Esc 关闭）（详见 DbDetailModal） -->
    <DbDetailModal
      v-if="detail"
      :detail="detail"
      :switch-detail-tab="switchDetailTab"
      :copy-detail-ddl="copyDetailDDL"
      :use-detail-ddl="useDetailDDL"
      @close="detail = null"
    />

    <!-- 右栏：SQL 工作区 -->
    <section class="work">
      <div class="work-head">
        <button v-if="collapsed" class="btn ghost sm" title="展开连接管理" @click="toggleCollapsed"><Icon name="chevrons-right" :size="14" />连接管理</button>
        <span class="cur-state" :class="{ on: connected }">
          <span class="dot" :class="connected ? 'dot-on' : 'dot-off'"></span>
          {{ connected ? "已连接" : "未连接" }}
        </span>
        <span class="cur-name" :title="currentLabel">{{ currentLabel }}</span>
        <span class="spacer"></span>
        <button v-if="connected" class="btn ghost sm" @click="disconnect">断开</button>
      </div>

      <div class="sql-area">
        <div class="sql-editor" :style="{ height: sqlHeight + 'px' }">
          <div ref="sqlGutterRef" class="sql-gutter" aria-hidden="true">
            <div v-for="n in sqlLineCount" :key="n" class="sql-ln" :class="{ err: n === sqlErrLine }">{{ n }}</div>
          </div>
          <textarea
            ref="sqlTextarea"
            v-model="sql"
            class="sql-input"
            spellcheck="false"
            placeholder="输入 SQL，Ctrl+Enter 执行（选中片段则只执行选中部分）；FROM/JOIN 后提示表名，表名. 后提示列名"
            @keydown.ctrl.enter.prevent="onRunSql"
            @keydown.meta.enter.prevent="onRunSql"
            @keydown="onSqlKeydown"
            @input="scheduleSuggest"
            @click="scheduleSuggest"
            @scroll="syncSqlGutter"
          ></textarea>
          <!-- 补全浮层：编辑器内底部，↑↓ 选择 Enter/Tab 补全 Esc 关闭 -->
          <div v-if="suggest.show" class="sql-suggest">
            <button
              v-for="(it, i) in suggest.list"
              :key="it.name"
              type="button"
              class="sg-item"
              :class="{ on: i === suggest.index }"
              @mousedown.prevent="suggest.index = i; applySuggest()"
            >
              <span class="sg-name">{{ it.name }}</span>
              <span v-if="it.kind" class="sg-tag">{{ it.kind }}</span>
              <span v-else-if="it.type" class="sg-tag">{{ it.type }}</span>
            </button>
          </div>
        </div>
        <div class="resizer" :class="{ dragging }" title="拖拽调整编辑区高度，双击重置" @mousedown="onResizeDown" @dblclick="sqlHeight = 160"></div>
        <div class="sql-bar">
          <button class="btn primary sm" :disabled="!canRun" @click="onRunSql">
            <span v-if="running" class="spinner"></span>{{ running ? "执行中…" : "执行" }}
            <kbd>Ctrl+Enter</kbd>
          </button>
          <button class="btn ghost sm ai" title="用自然语言描述需求，AI 生成 SQL" @click="openAIGen"><Icon name="sparkles" :size="13" />AI 生成</button>
          <button class="btn ghost sm ai" title="让 AI 分析当前 SQL 的性能优化建议" :disabled="!sql.trim()" @click="aiOptimize"><Icon name="sparkles" :size="13" />优化建议</button>
          <button class="btn ghost sm" @click="sql = ''">清空</button>
          <button class="btn ghost sm" @click="showHistory = !showHistory; if (showHistory) showFavs = false">历史<template v-if="history.length">（{{ history.length }}）</template></button>
          <button class="btn ghost sm" title="收藏当前 SQL" :disabled="!sql.trim()" @click="addFav">收藏</button>
          <button class="btn ghost sm" @click="showFavs = !showFavs; if (showFavs) showHistory = false">收藏夹<template v-if="favs.length">（{{ favs.length }}）</template></button>
          <button class="btn ghost sm" title="导入 .sql 文件到编辑器" @click="importSQL"><Icon name="download" :size="13" />导入 .sql</button>
          <span class="spacer"></span>
        </div>
      </div>

      <!-- SQL 历史 -->
      <div v-if="showHistory" class="hist">
        <div v-for="(h, i) in history" :key="i" class="hist-item" @click="useHistory(h)">
          <code class="hist-sql">{{ h.sql }}</code>
          <span class="hist-time">{{ relativeTime(h.ts) }}</span>
        </div>
        <p v-if="!history.length" class="pane-empty">还没有执行记录</p>
      </div>

      <!-- SQL 收藏夹 -->
      <div v-if="showFavs" class="hist favs">
        <div v-for="(f, i) in favs" :key="i" class="hist-item" :title="f.sql" @click="useFav(f)">
          <code class="hist-sql">{{ favLabel(f) }}</code>
          <span class="hist-time">{{ relativeTime(f.ts) }}</span>
          <button class="mini-btn icon danger" title="取消收藏" @click.stop="removeFav(f)"><Icon name="trash" :size="11" /></button>
        </div>
        <p v-if="!favs.length" class="pane-empty">还没有收藏的 SQL，执行前点「收藏」即可保存</p>
      </div>

      <!-- AI 辅助面板：生成 SQL / 报错解释 / 优化建议 -->
      <div v-if="aiMode" class="ai-panel">
        <div class="ai-head">
          <b>{{ aiMode === "gen" ? "AI 生成 SQL" : aiMode === "explain" ? "AI 解释报错" : "AI 优化建议" }}</b>
          <span v-if="aiMode === 'gen'" class="ai-tip">描述需求时可用表名/列名，AI 会参考当前库结构</span>
          <span class="spacer"></span>
          <button class="mini-btn" @click="aiMode = ''"><Icon name="x" :size="12" />关闭</button>
        </div>
        <textarea
          v-if="aiMode === 'gen'"
          v-model="aiPrompt"
          class="ai-input"
          spellcheck="false"
          placeholder="例如：查询 users 表近 7 天注册且状态为 1 的用户，按注册时间倒序，只取 id、姓名、邮箱"
          @keydown.ctrl.enter.prevent="aiGenSQL"
        ></textarea>
        <div v-if="aiMode === 'gen'" class="ai-ops">
          <button class="btn primary sm" :disabled="aiLoading || !aiPrompt.trim()" @click="aiGenSQL">
            <span v-if="aiLoading" class="spinner dark"></span>{{ aiLoading ? "生成中…" : "生成 SQL" }}
            <kbd>Ctrl+Enter</kbd>
          </button>
        </div>
        <div v-if="aiLoading" class="ai-state">AI 思考中…</div>
        <div v-else-if="aiError" class="ai-state err">{{ aiError }}</div>
        <div v-else-if="aiReply" class="ai-reply">
          <pre>{{ aiReply }}</pre>
          <div v-if="aiMode === 'gen'" class="ai-ops">
            <button class="btn solid sm" @click="useAISQL">填入编辑器</button>
          </div>
        </div>
      </div>

      <!-- 结果区：Navicat 式多标签（表数据 / 查询结果） -->
      <div class="result-area">
        <!-- 标签栏：切换 / 关闭 / 右键菜单 -->
        <div v-if="tabs.length" class="tab-bar">
          <button
            v-for="t in tabs"
            :key="t.id"
            class="db-tab"
            :class="{ on: t.id === activeTabId }"
            :title="t.kind === 'table' ? `表数据：${t.table}` : `查询：${t.sql}`"
            @click="switchTab(t.id)"
            @contextmenu.prevent="onTabCtx($event, t)"
          >
            <Icon :name="t.kind === 'table' ? 'database' : 'note'" :size="13" />
            <span v-if="t.running" class="tab-spin"></span>
            <span class="db-tab-title">{{ t.title }}</span>
            <span class="db-tab-x" title="关闭标签" @click.stop="closeTab(t.id)"><Icon name="x" :size="11" /></span>
          </button>
          <span class="tab-bar-tip">双击左侧表名打开表数据</span>
        </div>
        <div v-if="error" class="err">
          <span class="err-tag">SQL 执行失败</span>
          <span class="err-msg" :title="error">{{ error }}</span>
          <span class="spacer"></span>
          <button class="btn ghost sm ai" title="让 AI 解释报错原因并给出修复建议" @click="aiExplainError"><Icon name="sparkles" :size="13" />AI 解释</button>
        </div>
        <div v-else-if="activeTab && activeTab.result" class="result">
          <div class="result-meta">
            <span v-if="activeTab.kind === 'table'" class="tab-src">表数据</span>
            <span>耗时 <b>{{ activeTab.result.durationMs }}</b> ms</span>
            <span v-if="activeTab.result.rowCount">已显示 <b>{{ activeTab.result.rows.length }}</b> 行</span>
            <span v-if="activeTab.result.truncated" class="trunc">已截断（最多 1000 行）</span>
            <span v-else-if="activeTab.result.affected !== null && activeTab.result.affected !== undefined">影响 <b>{{ activeTab.result.affected }}</b> 行</span>
            <span class="spacer"></span>
            <span v-if="canEdit" class="edit-ops">
              <span class="edit-hint" :title="canEditRows ? '双击单元格可修改，修改后自动按主键 UPDATE' : '该表无主键，仅支持添加行'">
                {{ activeTab.editMeta.table }}<template v-if="canEditRows"> · 双击改值</template>
              </span>
              <button v-if="canEdit" class="btn ghost sm" title="插入一行新数据" @click="startAddRow"><Icon name="plus" :size="13" />添加行</button>
              <button v-if="canDeleteRows" class="btn ghost sm danger" :disabled="!activeTab.selectedRows.size" @click="deleteSelected">
                删除选中<template v-if="activeTab.selectedRows.size">（{{ activeTab.selectedRows.size }}）</template>
              </button>
            </span>
            <span class="meta-sep"></span>
            <button v-if="activeTab.pageState.sortable" class="btn ghost sm" :class="{ on: activeTab.filterMode }" title="按列值过滤当前结果（LIKE 模糊匹配）" @click="activeTab.filterMode ? (activeTab.filterMode = false) : startFilter()"><Icon name="search" :size="13" />过滤</button>
            <span class="meta-sep"></span>
            <button class="btn ghost sm" title="导出为 CSV（带 BOM，Excel 可直接打开）" @click="exportResult('csv')"><Icon name="download" :size="13" />CSV</button>
            <button class="btn ghost sm" title="导出为 JSON 对象数组" @click="exportResult('json')"><Icon name="download" :size="13" />JSON</button>
            <button class="btn ghost sm" title="复制为 Markdown 表格（含列名）" @click="copyResult">
              <Icon name="copy" :size="13" />复制表格
            </button>
          </div>
          <div v-if="activeTab.result.columns.length" class="tbl-wrap" title="Shift+滚轮 或 拖动底部滚动条 横向滚动；首列（勾选/行号）固定">
            <!-- 过滤行：每列输入值，Enter 应用 / Esc 取消 -->
            <div v-if="activeTab.filterMode" class="filter-row">
              <div v-for="c in activeTab.result.columns" :key="c" class="filter-cell">
                <input
                  v-model="activeTab.filterDraft[c]"
                  class="cell-input"
                  :placeholder="c"
                  title="LIKE 模糊匹配，Enter 应用"
                  @keydown.enter.prevent="applyFilter"
                  @keydown.esc.prevent="activeTab.filterMode = false"
                />
              </div>
              <button class="btn primary sm" :disabled="activeTab.running" @click="applyFilter"><Icon name="search" :size="13" />应用</button>
              <button class="btn ghost sm" @click="activeTab.filterMode = false">取消</button>
            </div>
            <table class="tbl">
              <thead>
                <tr>
                  <th v-if="canEdit" class="chk-col"></th>
                  <th class="rowno-col" title="行号">#</th>
                  <th v-for="col in activeTab.result.columns" :key="col">
                    <span
                      class="th-sort"
                      :class="{ sortable: activeTab.pageState.sortable, asc: activeTab.pageState.sortDir === col && activeTab.pageState.sortAsc, desc: activeTab.pageState.sortDir === col && !activeTab.pageState.sortAsc }"
                      :title="activeTab.pageState.sortable ? '点击按此列排序' : col"
                      @click="sortBy(col)"
                    >{{ col }}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <!-- 添加行：整行输入，Enter 保存 / Esc 取消 -->
                <tr v-if="activeTab.editingNewRow" class="new-row">
                  <td v-if="canEdit" class="chk-col" @click.stop>
                    <button class="row-cancel" title="取消添加（Esc）" @click="activeTab.editingNewRow = false"><Icon name="x" :size="12" /></button>
                  </td>
                  <td class="rowno-col"></td>
                  <td v-for="name in activeTab.result.columns" :key="name">
                    <input
                      v-model="activeTab.newRowDraft[name]"
                      class="cell-input"
                      :placeholder="activeTab.editMeta.cols.find((c) => c.name === name)?.type || ''"
                      @keydown.enter.prevent="saveNewRow"
                      @keydown.esc.prevent="activeTab.editingNewRow = false"
                    />
                  </td>
                </tr>
                <tr
                  v-for="(row, ri) in activeTab.result.rows"
                  :key="ri"
                  :class="{ sel: activeTab.selectedRows.has(ri) }"
                >
                  <td v-if="canEdit" class="chk-col" @click.stop>
                    <input
                      type="checkbox"
                      :checked="activeTab.selectedRows.has(ri)"
                      :title="canDeleteRows ? '勾选后点「删除选中」' : ''"
                      @change="toggleSelect(ri)"
                    />
                  </td>
                  <td class="rowno-col" title="行号">{{ ri + 1 }}</td>
                  <td
                    v-for="(cell, ci) in row"
                    :key="ci"
                    :class="{ nul: isNull(cell), num: isNumCol(ci), editing: activeTab.editingCell && activeTab.editingCell.row === ri && activeTab.editingCell.col === ci, copied: copiedCell && copiedCell.ri === ri && copiedCell.ci === ci }"
                    :title="canEditRows
                      ? (isNull(cell) ? 'NULL' : cellText(cell)) + '（点击复制，双击编辑）'
                      : (isNull(cell) ? 'NULL' : cellText(cell)) + '（点击复制）'"
                    @click="copyCell(cell, ri, ci)"
                    @dblclick="startCellEdit(ri, ci)"
                  >
                    <input
                      v-if="activeTab.editingCell && activeTab.editingCell.row === ri && activeTab.editingCell.col === ci"
                      v-model="activeTab.cellDraft"
                      class="cell-input"
                      autofocus
                      @click.stop
                      @keydown.enter.prevent="saveCellEdit"
                      @keydown.esc.prevent="cancelCellEdit"
                      @blur="saveCellEdit"
                    />
                    <template v-else>{{ cellText(cell) }}</template>
                  </td>
                </tr>
              </tbody>
            </table>
            <!-- 加载更多：简单 SELECT 且已取满一页时显示 -->
            <div v-if="activeTab.pageState.pageable && activeTab.result.rows.length >= PAGE" class="more-bar">
              <button class="btn ghost sm" :disabled="activeTab.running" @click="loadMore">
                <Icon name="chevron" :size="13" />{{ activeTab.running ? "加载中…" : `加载更多（已显示 ${activeTab.result.rows.length} 行）` }}
              </button>
            </div>
          </div>
          <div v-else class="done-tip">执行成功</div>
        </div>
        <div v-else class="result-empty">
          <p>双击左侧表名打开表数据，或在编辑器中执行 SQL，结果将显示在这里</p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.dbtool { display: grid; grid-template-columns: 280px 1fr; gap: 14px; height: 100%; min-height: 0; transition: grid-template-columns 0.22s ease, gap 0.22s ease; }
.dbtool.collapsed { grid-template-columns: 0 1fr; gap: 0; }
/* 收起时左栏淡出：visibility 延迟到淡出结束后再隐藏，避免残留键盘焦点与屏幕阅读器可访问性 */
.dbtool.collapsed .conn-pane { overflow: hidden; opacity: 0; visibility: hidden; pointer-events: none; transition: opacity 0.22s ease, visibility 0s linear 0.22s; }

/* ============ 左栏：连接管理（面板化，Navicat 式对象树） ============ */
.conn-pane { display: flex; flex-direction: column; min-height: 0; gap: 10px; padding: 12px 10px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-md); box-shadow: var(--shadow); transition: opacity 0.22s ease, visibility 0s; }
.pane-head { display: flex; align-items: center; justify-content: space-between; padding: 0 6px; }
.pane-head b { font-size: var(--fs-md); font-weight: 700; }
.pane-ops { display: inline-flex; align-items: center; gap: 6px; }
.mini-btn { display: inline-flex; align-items: center; gap: 3px; padding: 4px 8px; font-size: var(--fs-sm); border: 1px solid var(--border-strong); background: var(--card); color: var(--muted); border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; }
.mini-btn:hover { color: var(--primary); border-color: var(--primary); }
.mini-btn.danger:hover { color: var(--danger); border-color: var(--danger); }
/* 纯图标按钮：padding 0 + grid 居中，避免 UA 默认 padding 偏移 */
.mini-btn.icon { width: 26px; height: 26px; padding: 0; display: grid; place-items: center; }

.conn-list { display: flex; flex-direction: column; gap: 4px; overflow: auto; max-height: 44%; flex-shrink: 0; }
.conn-item { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid transparent; background: transparent; border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; text-align: left; }
.conn-item:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.conn-item.on { background: var(--accent-soft); border-color: var(--accent-border); }
.ci-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.ci-name { font-size: var(--fs-md); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ci-sub { font-size: var(--fs-xs); color: var(--muted); }
.ci-ops { display: none; align-items: center; gap: 2px; }
.conn-item:hover .ci-ops { display: inline-flex; }

/* 连接状态点 */
.dot { width: 8px; height: 8px; flex-shrink: 0; border-radius: 50%; }
.dot-on { background: var(--success); box-shadow: 0 0 0 3px color-mix(in srgb, var(--success) 15%, transparent); }
.dot-off { background: var(--border-strong); }
.dot-busy { background: var(--warn); animation: pulse 1s ease-in-out infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

.pane-empty { margin: 6px 2px; font-size: var(--fs-sm); color: var(--muted); line-height: var(--lh-body); }

/* ============ 右栏：SQL 工作区 ============ */
.work { display: flex; flex-direction: column; min-height: 0; gap: 10px; position: relative; }
.work-head { display: flex; align-items: center; gap: 10px; flex-shrink: 0; }
.cur-state { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--muted); }
.cur-state.on { color: var(--success); }
.cur-name { font-size: var(--fs-md); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 320px; }
.spacer { flex: 1; }

/* 按钮 */
.btn { display: inline-flex; align-items: center; gap: 5px; padding: 7px 14px; font-size: var(--fs-md); font-weight: 600; border-radius: var(--r-sm); cursor: pointer; transition: all 0.15s; border: 1px solid transparent; }
.btn.primary { background: var(--primary); color: var(--text-invert); }
.btn.primary:hover:not(:disabled) { background: var(--primary-hover); }
.btn.primary:disabled { opacity: 0.55; cursor: default; }
.btn.solid { background: var(--card); color: var(--text); border-color: var(--border-strong); }
.btn.solid:hover { border-color: var(--primary); color: var(--primary); }
.btn.ghost { background: transparent; color: var(--muted); }
.btn.ghost:hover { color: var(--primary); background: var(--primary-soft); }
.btn.sm { padding: 5px 10px; font-size: var(--fs-sm); }
kbd { padding: 1px 5px; font-size: var(--fs-xs); font-family: var(--font-mono); background: rgba(15, 23, 42, 0.06); border-radius: var(--r-xs); font-weight: 400; }

/* SQL 编辑区 */
.sql-area { display: flex; flex-direction: column; gap: 8px; flex-shrink: 0; }
/* SQL 编辑器：行号 gutter + 输入区（高度由拖拽条控制） */
.sql-editor { display: flex; border: 1px solid var(--border-strong); border-radius: var(--r-sm); overflow: hidden; background: var(--card); transition: border-color 0.15s; }
.sql-editor:focus-within { border-color: var(--primary); }
.sql-gutter { flex-shrink: 0; width: 40px; overflow: hidden; padding: 10px 0; text-align: right; background: var(--card-soft); border-right: 1px solid var(--border); user-select: none; }
.sql-ln { padding: 0 8px; font-family: var(--font-mono); font-size: var(--fs-md); line-height: var(--lh-tight); color: var(--faint); }
.sql-ln.err { color: var(--danger-deep); font-weight: 700; background: var(--danger-soft); }
.sql-input { flex: 1; min-width: 0; height: 100%; padding: 10px 12px; font-family: var(--font-mono); font-size: var(--fs-md); line-height: var(--lh-tight); border: none; background: transparent; color: var(--text); resize: none; outline: none; box-sizing: border-box; }
/* 补全浮层：编辑器内底部悬浮卡片 */
.sql-editor { position: relative; }
.sql-suggest {
  position: absolute; left: 44px; right: 8px; bottom: 6px; z-index: 5;
  max-height: 176px; overflow-y: auto; padding: 4px;
  background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm);
  box-shadow: 0 8px 24px rgba(16, 24, 40, 0.16);
  display: flex; flex-direction: column; gap: 1px;
}
.sg-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 5px 9px; border: none; background: none; border-radius: var(--r-xs); font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--text); text-align: left; cursor: pointer; transition: background 0.1s; }
.sg-item:hover, .sg-item.on { background: var(--primary-soft); }
.sg-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sg-tag { flex-shrink: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--muted); background: var(--well); border-radius: var(--r-pill); padding: 0 7px; }
/* 拖拽分隔条 */
.resizer { flex-shrink: 0; height: 5px; margin: 0 -2px; cursor: row-resize; border-radius: var(--r-pill); transition: background 0.15s; }
.resizer:hover, .resizer.dragging { background: var(--primary); }
.sql-bar { display: flex; align-items: center; gap: 6px; }
.spinner { width: 12px; height: 12px; border: 2px solid rgba(255, 255, 255, 0.4); border-top-color: var(--text-invert); border-radius: 50%; animation: spin 0.7s linear infinite; }
.spinner.dark { border-color: var(--border-strong); border-top-color: var(--primary); }
@keyframes spin { to { transform: rotate(360deg); } }

/* ============ AI 辅助面板 ============ */
.btn.ai { color: var(--accent); }
.btn.ai:hover:not(:disabled) { color: var(--accent); background: var(--accent-soft); }
/* AI 面板：右侧抽屉浮层，不挤压 SQL/结果区 */
.ai-panel {
  position: absolute; top: 0; right: 0; bottom: 0; z-index: 20;
  width: 400px; max-width: 80%;
  display: flex; flex-direction: column; gap: 8px; padding: 12px 14px;
  background: var(--card); border-left: 1px solid var(--accent-border);
  box-shadow: -12px 0 32px rgba(16, 24, 40, 0.12);
  animation: aiSlideIn 0.18s ease;
}
@keyframes aiSlideIn {
  from { transform: translateX(24px); opacity: 0; }
  to { transform: none; opacity: 1; }
}
.ai-head { display: flex; align-items: center; gap: 8px; }
.ai-head b { font-size: var(--fs-md); font-weight: 700; }
.ai-tip { font-size: var(--fs-xs); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ai-input { width: 100%; min-height: 64px; padding: 8px 10px; font-size: var(--fs-md); line-height: var(--lh-body); border: 1px solid var(--border-strong); background: var(--bg); color: var(--text); border-radius: var(--r-sm); resize: vertical; outline: none; transition: border-color 0.15s; }
.ai-input:focus { border-color: var(--accent); }
.ai-ops { display: flex; gap: 6px; }
.ai-state { font-size: var(--fs-sm); color: var(--muted); }
.ai-state.err { color: var(--danger); }
.ai-reply { display: flex; flex-direction: column; gap: 8px; flex: 1; min-height: 0; overflow: auto; padding: 10px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-sm); }
.ai-reply pre { margin: 0; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: var(--lh-body); white-space: pre-wrap; word-break: break-all; color: var(--text); }

/* SQL 历史 */
.hist { display: flex; flex-direction: column; gap: 2px; max-height: 180px; overflow: auto; padding: 6px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); flex-shrink: 0; }
.hist-item { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: var(--r-xs); cursor: pointer; transition: background 0.15s; }
.hist-item:hover { background: color-mix(in srgb, var(--text) 4%, transparent); }
.hist-sql { flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hist-time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--muted); }
/* 收藏夹列表内的图标按钮更紧凑 */
.hist .mini-btn.icon { width: 20px; height: 20px; }

/* 结果区 */
.result-area { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 6px; }

/* ============ 标签栏（Navicat 式多标签） ============ */
.tab-bar { display: flex; align-items: center; gap: 3px; flex-shrink: 0; padding: 5px 6px; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); overflow-x: auto; }
.tab-bar::-webkit-scrollbar { height: 6px; }
.tab-bar::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: var(--r-pill); }
.db-tab { display: inline-flex; align-items: center; gap: 5px; padding: 4px 6px 4px 9px; border: 1px solid transparent; background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; white-space: nowrap; font-size: var(--fs-sm); transition: all 0.15s; flex-shrink: 0; }
.db-tab:hover { background: var(--well); color: var(--text); }
.db-tab.on { background: var(--primary-soft); color: var(--primary); border-color: color-mix(in srgb, var(--primary) 22%, transparent); font-weight: 600; }
.db-tab .icon { color: var(--faint); }
.db-tab.on .icon { color: var(--primary); }
.db-tab-title { max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
.db-tab-x { display: grid; place-items: center; width: 16px; height: 16px; border-radius: var(--r-xs); color: var(--faint); transition: all 0.15s; }
.db-tab-x:hover { background: var(--danger-soft); color: var(--danger-deep); }
.db-tab.on .db-tab-x { color: var(--primary); }
.tab-spin { width: 10px; height: 10px; border: 2px solid var(--border-strong); border-top-color: var(--primary); border-radius: 50%; animation: spin 0.7s linear infinite; flex-shrink: 0; }
.tab-bar-tip { margin-left: auto; padding-right: 4px; font-size: var(--fs-xs); color: var(--faint); white-space: nowrap; }
.tab-src { display: inline-flex; align-items: center; padding: 0 8px; font-size: var(--fs-xs); font-weight: 600; color: var(--accent-deep); background: var(--accent-soft); border-radius: var(--r-pill); line-height: 1.8; }
.err { display: flex; align-items: flex-start; gap: 8px; padding: 8px 12px; background: var(--danger-soft); border: 1px solid color-mix(in srgb, var(--danger) 25%, transparent); border-radius: var(--r-sm); color: var(--danger); font-size: var(--fs-sm); }
.err-tag { flex-shrink: 0; font-weight: 700; }
.err-msg { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: var(--lh-body); }
.result { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
.result-meta { display: flex; align-items: center; gap: 14px; flex-shrink: 0; font-size: var(--fs-sm); color: var(--muted); flex-wrap: wrap; row-gap: 6px; }
.result-meta .meta-sep { width: 1px; height: 16px; background: var(--border); flex-shrink: 0; }
.result-meta b { font-weight: 700; color: var(--text); }
.trunc { color: var(--warn); font-weight: 600; }

.tbl-wrap { flex: 1; min-height: 0; overflow: auto; background: var(--card); border: 1px solid var(--card-border); border-radius: var(--r-sm); }
/* 表格固定布局：列多时自动均分宽度，全部列都在视野内（长内容截断，title 看全文） */
.tbl { border-collapse: collapse; width: 100%; table-layout: fixed; font-family: var(--font-mono); font-size: var(--fs-xs); }
.tbl th { position: sticky; top: 0; z-index: 1; padding: 7px 12px; font-weight: 700; text-align: left; background: var(--primary-soft); color: var(--primary); border-bottom: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tbl td { padding: 6px 12px; border-bottom: 1px solid var(--border); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); cursor: copy; }
/* 斑马纹（Navicat 数据网格习惯；sticky 列保持自身底色） */
.tbl tbody tr:nth-child(even) td:not(.chk-col):not(.rowno-col) { background: color-mix(in srgb, var(--text) 1.8%, transparent); }
.tbl tbody tr:hover td { background: color-mix(in srgb, var(--text) 3%, transparent); }
.tbl tbody tr:hover td:nth-child(even) { background: color-mix(in srgb, var(--text) 4%, transparent); }
.tbl td:hover { background: var(--primary-soft); }
.tbl td.nul { color: var(--muted); font-style: italic; }
/* 数字列右对齐（专业工具惯例） */
.tbl td.num { text-align: right; font-variant-numeric: tabular-nums; }
/* 复制成功反馈：单元格短暂绿色闪烁 */
.tbl td.copied { animation: cellCopied 0.6s ease; }
@keyframes cellCopied {
  0% { background: color-mix(in srgb, var(--success) 30%, transparent); }
  100% { background: transparent; }
}
/* 行号列 */
.rowno-col { width: 44px; padding: 6px 8px !important; text-align: right; color: var(--faint) !important; user-select: none; background: color-mix(in srgb, var(--text) 2%, transparent); }
.tbl thead .rowno-col { background: var(--primary-soft); }
/* 固定首列（勾选 + 行号）：横向滚动时始终可见，勾选/定位不迷路 */
.chk-col, .rowno-col { position: sticky; left: 0; z-index: 1; }
.tbl thead .chk-col, .tbl thead .rowno-col { z-index: 2; }
.tbl tbody tr.sel .chk-col, .tbl tbody tr.sel .rowno-col { background: var(--danger-soft); }
.tbl tbody tr.new-row .chk-col, .tbl tbody tr.new-row .rowno-col { background: var(--primary-soft); }
/* 横向滚动条加粗显眼（WebKit），Shift+滚轮可横滚 */
.tbl-wrap { scrollbar-width: auto; scrollbar-color: var(--border-strong) transparent; }
.tbl-wrap::-webkit-scrollbar { height: 12px; width: 12px; }
.tbl-wrap::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: var(--r-pill); border: 2px solid var(--card); }
.tbl-wrap::-webkit-scrollbar-thumb:hover { background: var(--muted); }
.tbl-wrap::-webkit-scrollbar-track { background: var(--card-soft); }
/* 可排序表头：hover 变色 + 方向指示 */
.th-sort { cursor: default; }
.th-sort.sortable { cursor: pointer; }
.th-sort.sortable:hover { color: var(--accent-hover); }
.th-sort.asc::after { content: " ↑"; font-size: var(--fs-xs); }
.th-sort.desc::after { content: " ↓"; font-size: var(--fs-xs); }
/* 过滤行 */
.filter-row { display: flex; align-items: flex-end; gap: 6px; padding: 8px; border-bottom: 1px solid var(--border); background: var(--card-soft); flex-wrap: wrap; }
.filter-cell { flex: 0 1 160px; min-width: 90px; }
.filter-cell .cell-input { min-width: 100%; }
.filter-row .btn { flex-shrink: 0; }
/* 加载更多 */
.more-bar { display: flex; justify-content: center; padding: 10px; border-top: 1px solid var(--border); }

/* ============ 数据编辑 ============ */
.edit-ops { display: inline-flex; align-items: center; gap: 6px; }
.edit-hint { font-size: var(--fs-xs); color: var(--muted); max-width: 200px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.btn.danger { color: var(--danger); }
.btn.danger:hover:not(:disabled) { background: var(--danger-soft); }
.btn:disabled { opacity: 0.5; cursor: default; }
.chk-col { width: 30px; padding: 0 4px; text-align: center; }
.chk-col input { accent-color: var(--primary); cursor: pointer; }
/* 添加行模式：取消按钮 */
.row-cancel { width: 20px; height: 20px; padding: 0; display: grid; place-items: center; border: none; background: transparent; color: var(--muted); border-radius: var(--r-xs); cursor: pointer; transition: all 0.15s; }
.row-cancel:hover { color: var(--danger-deep); background: var(--danger-soft); }
.tbl tr.sel td { background: var(--danger-soft); }
.cell-input { width: 100%; min-width: 56px; padding: 2px 6px; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--text); border: 1px solid var(--primary); background: var(--card); border-radius: var(--r-xs); outline: none; }
td.editing { padding: 3px 5px; max-width: none; }
tr.new-row td { background: var(--primary-soft); }

.done-tip { display: inline-flex; align-items: center; gap: 6px; align-self: flex-start; padding: 8px 14px; font-size: var(--fs-md); color: var(--success-deep); background: color-mix(in srgb, var(--success) 8%, transparent); border-radius: var(--r-sm); }
.result-empty { flex: 1; display: flex; align-items: center; justify-content: center; border: 1px dashed var(--border-strong); border-radius: var(--r-sm); }
.result-empty p { margin: 0; font-size: var(--fs-md); color: var(--muted); }

/* 窄窗口：连接栏压窄 */
@media (max-width: 900px) {
  .dbtool { grid-template-columns: 230px 1fr; }
}
</style>
