<script setup>
// 数据库工具（手机端）：**只有 SQLite**。
//
// 为什么不提供 MySQL / PostgreSQL / Oracle：安卓没有 JDBC，这不是"暂时没做"而是平台上不存在。
// 界面上如实标注，而不是摆出选项让人点了报错——后者比没有更让人困惑。
//
// 与桌面端共用同一套命令名与返回形状（db_connect / db_query / db_tables / db_columns / db_close），
// 所以渲染逻辑的口径一致：结果 { columns, rows, affected, truncated, durationMs }，
// rows 是**二维数组**（按列顺序渲染表格）。
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { invoke } from "../../../src/platform/invoke.js";
import { nativeAvailable, pickFile } from "../platform/bridge.js";

const { t } = useI18n();

const dbFile = ref("");
const connId = ref("");
const busy = ref(false);
const error = ref("");
const notice = ref("");
const sql = ref("");
const result = ref(null); // { columns, rows, affected, truncated, durationMs }
const tables = ref([]);
const columnsOf = ref({}); // table -> columns[]
const expanded = ref({});
const tab = ref("query"); // query | structure

const connected = computed(() => !!connId.value);
const ready = computed(() => nativeAvailable());

/** 选一个 .db 文件：走 SAF 授权，与文件工具同一条路径。 */
async function pickDatabase() {
  error.value = "";
  try {
    // SQLite 文件没有统一的 MIME，用 */* 并靠扩展名判断（provider 常报 application/octet-stream）
    const uri = await pickFile("*/*");
    if (!uri) return; // 用户取消：不是错误
    dbFile.value = uri;
    await connect();
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

async function connect() {
  if (busy.value) return;
  error.value = "";
  notice.value = "";
  if (!dbFile.value.trim()) {
    error.value = t("mobile.dbNeedFile");
    return;
  }
  busy.value = true;
  try {
    connId.value = await invoke("db_connect", { opts: { type: "sqlite", file: dbFile.value.trim() } });
    notice.value = t("toolbox.db.connected");
    result.value = null;
    await loadTables();
  } catch (e) {
    connId.value = "";
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

async function disconnect() {
  const id = connId.value;
  connId.value = "";
  tables.value = [];
  columnsOf.value = {};
  result.value = null;
  if (!id) return;
  try {
    await invoke("db_close", { connId: id });
  } catch {
    /* 断开失败不值得打扰用户：本地句柄已经丢了 */
  }
}

async function loadTables() {
  if (!connected.value) return;
  try {
    tables.value = (await invoke("db_tables", { connId: connId.value })) || [];
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

async function toggleTable(table) {
  const next = { ...expanded.value, [table.name]: !expanded.value[table.name] };
  expanded.value = next;
  if (!next[table.name] || columnsOf.value[table.name]) return;
  try {
    const cols = (await invoke("db_columns", { connId: connId.value, table: table.name })) || [];
    columnsOf.value = { ...columnsOf.value, [table.name]: cols };
  } catch (e) {
    error.value = e?.message || String(e);
  }
}

async function run() {
  if (busy.value) return;
  error.value = "";
  notice.value = "";
  if (!connected.value) {
    error.value = t("toolbox.db.needConnect");
    return;
  }
  const statement = sql.value.trim();
  if (!statement) {
    error.value = t("mobile.dbSqlEmpty");
    return;
  }
  busy.value = true;
  try {
    result.value = await invoke("db_query", { connId: connId.value, sql: statement });
    // DDL/DML 之后表结构可能变了，顺手刷新（失败不打扰：查询本身已经成功）
    if (!result.value?.columns?.length) loadTables();
  } catch (e) {
    result.value = null;
    error.value = e?.message || String(e);
  } finally {
    busy.value = false;
  }
}

/** 点表名 → 生成 SELECT 并执行（手机上最常用的动作，省去手打表名）。 */
async function openTable(table) {
  sql.value = `SELECT * FROM ${table.name} LIMIT 100`;
  tab.value = "query";
  await run();
}

/** 单元格显示：null 与空串必须能区分开（数据里这两者含义完全不同）。 */
const cellText = (value) => {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
};

const isNull = (value) => value === null || value === undefined;

const copied = ref("");
async function copyResult() {
  if (!result.value?.rows?.length) return;
  const header = result.value.columns.map((c) => c.name).join("\t");
  const body = result.value.rows.map((row) => row.map(cellText).join("\t")).join("\n");
  try {
    await navigator.clipboard.writeText(`${header}\n${body}`);
    copied.value = t("toolbox.db.copiedRows");
    setTimeout(() => (copied.value = ""), 2000);
  } catch {
    error.value = t("toolbox.db.copyFailed");
  }
}
</script>

<template>
  <section class="m-tool" data-tool="db">
    <p v-if="!ready" class="m-err" data-role="no-bridge">{{ t("mobile.dbNeedApp") }}</p>

    <!-- 连接：手机端只支持 SQLite，这一点写在界面上 -->
    <div class="m-card">
      <div class="m-card-head">
        <b>{{ t("toolbox.db.typeSqlite") }}</b>
        <span class="m-zone" :data-on="connected" data-role="conn-state">
          {{ connected ? t("toolbox.db.connected") : t("toolbox.db.notConnected") }}
        </span>
      </div>
      <p class="m-hint-sm" data-role="sqlite-note">{{ t("mobile.dbSqliteOnly") }}</p>
      <div class="m-actions">
        <button class="m-btn primary" :disabled="busy || !ready" data-role="pick-db" @click="pickDatabase">
          {{ t("mobile.dbPickFile") }}
        </button>
        <button v-if="connected" class="m-btn danger" data-role="disconnect" @click="disconnect">{{ t("toolbox.db.disconnect") }}</button>
      </div>
      <label class="m-field">
        <span>{{ t("toolbox.db.sqliteFile") }}</span>
        <input v-model="dbFile" spellcheck="false" data-role="db-file" :placeholder="t('mobile.dbFilePh')" />
      </label>
      <div class="m-actions">
        <button class="m-btn" :disabled="busy || !ready || connected" data-role="connect" @click="connect">{{ t("mobile.dbConnect") }}</button>
      </div>
    </div>

    <template v-if="connected">
      <div class="m-chips">
        <button class="m-chip" :class="{ on: tab === 'query' }" data-tab="query" @click="tab = 'query'">{{ t("mobile.dbQuery") }}</button>
        <button class="m-chip" :class="{ on: tab === 'structure' }" data-tab="structure" @click="tab = 'structure'">{{ t("mobile.dbStructure") }}</button>
      </div>

      <!-- 查询 -->
      <template v-if="tab === 'query'">
        <label class="m-field">
          <span>SQL</span>
          <textarea v-model="sql" rows="4" spellcheck="false" :placeholder="t('toolbox.db.sqlPlaceholder')" data-role="sql"></textarea>
        </label>
        <div class="m-actions">
          <button class="m-btn primary" :disabled="busy" data-role="run" @click="run">
            {{ busy ? t("toolbox.db.running") : t("toolbox.db.run") }}
          </button>
          <button class="m-btn" :disabled="!result?.rows?.length" data-role="copy-result" @click="copyResult">{{ t("toolbox.db.copyTable") }}</button>
        </div>

        <!-- 结果 -->
        <div v-if="result" class="m-card" data-role="result">
          <div class="m-card-head">
            <b>{{ result.columns.length ? t("mobile.dbResult") : t("toolbox.db.done") }}</b>
            <span class="m-zone" data-role="result-meta">
              {{ result.columns.length ? t("mobile.dbRows", { n: result.rows.length }) : t("toolbox.db.affectedRows", { count: result.affected }) }}
              · {{ t("toolbox.db.costMs", { ms: result.durationMs }) }}
            </span>
          </div>
          <p v-if="result.truncated" class="m-err" data-role="truncated">{{ t("mobile.dbTruncated", { n: result.rows.length }) }}</p>

          <!-- 表格：手机上横向滚动，不折行（折行会让列对不齐、更难读） -->
          <div v-if="result.columns.length" class="m-table-wrap">
            <table class="m-table" data-role="table">
              <thead>
                <tr>
                  <th v-for="col in result.columns" :key="col.name">{{ col.name }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(row, rowIndex) in result.rows" :key="rowIndex">
                  <td v-for="(cell, cellIndex) in row" :key="cellIndex" :class="{ 'm-null': isNull(cell) }">{{ cellText(cell) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="m-hint-sm">{{ t("toolbox.db.resultEmpty") }}</p>
        </div>
      </template>

      <!-- 表结构 -->
      <template v-else>
        <p v-if="!tables.length" class="m-hint-sm" data-role="no-tables">{{ t("mobile.dbNoTables") }}</p>
        <ul v-else class="m-list" data-role="tables">
          <li v-for="table in tables" :key="table.name" class="m-item" :data-table="table.name">
            <button class="m-item-main" data-role="table-name" @click="toggleTable(table)">
              <span class="m-item-title">{{ table.name }}</span>
              <span v-if="columnsOf[table.name]" class="m-item-sub">{{ t("mobile.dbCols", { n: columnsOf[table.name].length }) }}</span>
            </button>
            <div class="m-item-ops">
              <button class="m-op" data-role="open-table" @click="openTable(table)">{{ t("mobile.dbOpenTable") }}</button>
            </div>
            <ul v-if="expanded[table.name] && columnsOf[table.name]" class="m-stats" data-role="columns">
              <li v-for="col in columnsOf[table.name]" :key="col.name">
                <b>{{ col.name }}<span v-if="col.pk" class="m-pk">PK</span></b>
                <span>{{ col.type || "—" }}</span>
              </li>
            </ul>
          </li>
        </ul>
      </template>
    </template>

    <p v-if="error" class="m-err" data-role="error">{{ error }}</p>
    <p v-if="notice" class="m-ok" data-role="notice">{{ notice }}</p>
    <p v-if="copied" class="m-ok">{{ copied }}</p>
  </section>
</template>
