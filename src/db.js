// 数据库工具纯逻辑：类型元数据、连接参数校验、SQL 历史与连接配置管理。
// 持久化由上层（DbTool.vue）经 toolboxStore 走 load_data/save_data 落盘 AppData。

import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

// 支持的数据库类型元数据（顺序即表单下拉顺序）
export const DB_TYPES = [
  {
    type: "mysql",
    labelKey: "typeMysql",
    defaultPort: 3306,
    hostLabelKey: "hostLabel",
    dbLabelKey: "dbLabel",
    hintKey: "hintMysql",
  },
  {
    type: "postgres",
    labelKey: "typePostgres",
    defaultPort: 5432,
    hostLabelKey: "hostLabel",
    dbLabelKey: "dbLabel",
    hintKey: "hintPostgres",
  },
  {
    type: "sqlite",
    labelKey: "typeSqlite",
    defaultPort: null,
    hostLabelKey: "",
    dbLabelKey: "sqliteDbLabel",
    hintKey: "hintSqlite",
  },
  {
    type: "oracle",
    labelKey: "typeOracle",
    defaultPort: 1521,
    hostLabelKey: "hostLabel",
    dbLabelKey: "oracleDbLabel",
    hintKey: "hintOracle",
  },
];

const DEFAULT_PORTS = Object.fromEntries(DB_TYPES.map((t) => [t.type, t.defaultPort]));

/** 新连接的默认参数模板 */
export function defaultConn(type) {
  return {
    type: type || "mysql",
    name: "",
    host: "localhost",
    port: DEFAULT_PORTS[type] || "",
    user: "root",
    password: "",
    database: type === "sqlite" ? "" : "",
    rememberPwd: true,
    oracleDriver: "",
    oracleService: "",
  };
}

/** 判断 ODBC 驱动名是否为 Oracle 相关（名称含 oracle，忽略大小写） */
export function isOracleDriver(name) {
  return String(name || "").toLowerCase().includes("oracle");
}

// Oracle 驱动包：托管在 GitHub 固定 Release（tag drivers）资产（规格：Oracle 驱动分发）
export const DRIVER_INSTALL_URL = "https://github.com/GitHub-lcb/ToolCove/releases/download/drivers/oracle-driver.zip";

/** 驱动安装包完整地址（固定 GitHub Release 资产，入参仅为兼容旧调用签名保留） */
export function driverInstallUrl() {
  return DRIVER_INSTALL_URL;
}

/** 驱动下载地址可信校验：固定 GitHub HTTPS 地址恒可信 */
export function isTrustedDriverUrl() {
  try {
    return new URL(DRIVER_INSTALL_URL).protocol === "https:";
  } catch {
    return false;
  }
}

export function isSha256(value) {
  return /^[a-f0-9]{64}$/i.test(String(value || "").trim());
}

/** 保守识别只读 SQL。无法确定时按写操作处理，让调用方要求用户确认。 */
export function isReadOnlySql(sql) {
  const raw = String(sql || "");
  if (/\/\*!/.test(raw)) return false;
  const text = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\r\n]*/g, " ")
    .replace(/'(?:''|[^'])*'/g, "''")
    .trim();
  if (!text) return true;
  const first = (text.match(/^([a-z]+)/i) || [])[1]?.toUpperCase();
  if (["SHOW", "DESCRIBE", "DESC"].includes(first)) return true;
  if (first !== "SELECT" && first !== "WITH") return false;
  return !/\b(INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL|EXEC(?:UTE)?|VACUUM|ATTACH|DETACH|INTO|FOR\s+UPDATE)\b/i.test(text);
}

/** 各数据库方言要点（AI 生成/优化 SQL 时作为系统提示，避免默认按 MySQL 语法） */
export function dialectHint(type) {
  const hints = {
    mysql: t("prompt.dbDialectMysql"),
    postgres: t("prompt.dbDialectPostgres"),
    sqlite: t("prompt.dbDialectSqlite"),
    oracle: t("prompt.dbDialectOracle"),
  };
  return hints[type] || t("prompt.dbDialectFallback");
}

/**
 * 校验连接参数，返回错误信息数组（空数组 = 通过）。
 * sqlite 只需文件路径；oracle 额外要求服务名与 Oracle 相关 ODBC 驱动
 * （驱动被其他驱动如 SQL Server 处理会报「没有提供任何 DSN 或 SERVER 关键字」）。
 */
export function validateConn(conn) {
  const errors = [];
  const c = conn || {};
  const type = c.type;
  if (!type) return [t("toolbox.db.errNeedType")];
  if (type === "sqlite") {
    if (!String(c.database || "").trim()) errors.push(t("toolbox.db.errNeedSqliteFile"));
    return errors;
  }
  if (!String(c.host || "").trim()) errors.push(t("toolbox.db.errNeedHost"));
  if (!c.port) errors.push(t("toolbox.db.errNeedPort"));
  if (!String(c.user || "").trim()) errors.push(t("toolbox.db.errNeedUser"));
  if (!String(c.database || "").trim()) errors.push(t("toolbox.db.errNeedDb"));
  if (type === "oracle") {
    if (!String(c.oracleService || "").trim()) errors.push(t("toolbox.db.errNeedOracleService"));
    const driver = String(c.oracleDriver || "").trim();
    if (!driver) errors.push(t("toolbox.db.errNeedOracleDriver"));
    else if (!isOracleDriver(driver)) errors.push(t("toolbox.db.errBadOracleDriver", { driver }));
  }
  return errors;
}

/** 连接列表展示名：自定义名优先，否则「类型@主机:端口/库」 */
export function connLabel(conn) {
  const c = conn || {};
  if (String(c.name || "").trim()) return c.name.trim();
  if (c.type === "sqlite") return c.database || t("toolbox.db.sqliteFile");
  const port = c.port ? `:${c.port}` : "";
  return `${c.host || "?"}${port}/${c.database || ""}`;
}

/** 保存前处理：未勾选「记住密码」时不落盘密码 */
export function sanitizeForSave(conn) {
  const copy = { ...(conn || {}) };
  if (!copy.rememberPwd) copy.password = "";
  return copy;
}

/** 加载后补全：合入默认值；未记住密码时密码置空 */
export function hydrateConn(raw) {
  const base = defaultConn((raw && raw.type) || "mysql");
  const merged = { ...base, ...(raw || {}) };
  if (!merged.rememberPwd) merged.password = "";
  return merged;
}

/**
 * 追加一条 SQL 到历史：去重置顶 + 按最大条数裁剪。
 * 空语句不记录；返回新数组（不修改入参）。
 */
export function pushHistory(list, sql, max = 20) {
  const text = String(sql || "").trim();
  if (!text) return Array.isArray(list) ? list : [];
  const base = Array.isArray(list) ? list : [];
  return [{ sql: text, ts: Date.now() }, ...base.filter((h) => h && h.sql !== text)].slice(0, max);
}

/**
 * 将查询结果转为 Markdown 表格（首行为列名标题行，带分隔行）。
 * 单元格按界面显示值输出：null 输出 "NULL" 文本；单元格内的 | 与换行会被转义/压平，保证表格结构不被破坏。
 * 列名为空时返回空字符串。
 */
export function toMarkdownTable(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  if (!cols.length) return "";
  const rs = Array.isArray(rows) ? rows : [];
  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
  const cell = (v) => (v === null || v === undefined ? "NULL" : esc(v));
  const head = cols.map(esc).join(" | ");
  const sep = cols.map(() => "---").join(" | ");
  const lines = rs.map((r) => cols.map((_, i) => cell(r && r[i])).join(" | "));
  return [`| ${head} |`, `| ${sep} |`, ...lines.map((l) => `| ${l} |`)].join("\n");
}

// ---------- SQL 生成（数据编辑） ----------

/** 标识符引用：MySQL 反引号，其余双引号（内部同名符号双写转义） */
export function quoteIdent(name, dbType) {
  const s = String(name || "");
  if (dbType === "mysql") return "`" + s.replace(/`/g, "``") + "`";
  return '"' + s.replace(/"/g, '""') + '"';
}

/** 字符串字面量：单引号包裹，内部单引号双写 */
export function quoteStr(v) {
  return "'" + String(v).replace(/'/g, "''") + "'";
}

/**
 * 单元格值 → SQL 字面量。
 * null/undefined → NULL；number 列的空串视为 NULL、数字原样输出（保精度）；
 * 其余一律单引号包裹。
 */
export function sqlLiteral(v, colType) {
  if (v === null || v === undefined) return "NULL";
  if (colType === "number") {
    const s = String(v).trim();
    if (s === "") return "NULL";
    if (!Number.isNaN(Number(s))) return s;
  }
  return quoteStr(v);
}

/**
 * 生成 UPDATE SQL：仅更新 changedIdx 指出的列，WHERE 用主键定位整行。
 * pkCols：主键列名数组（来自表结构元数据）。无主键 / 无有效改动列返回 null。
 */
export function genUpdateSQL(table, columns, row, changedIdx, colTypes, dbType, pkCols) {
  const pks = (pkCols || []).filter((c) => columns.includes(c));
  if (!pks.length) return null;
  const setParts = [];
  for (const i of changedIdx || []) {
    const name = columns[i];
    if (!name || pks.includes(name)) continue; // 主键不允许改（避免 WHERE 与 SET 冲突）
    setParts.push(`${quoteIdent(name, dbType)} = ${sqlLiteral(row[i], (colTypes || [])[i])}`);
  }
  if (!setParts.length) return null;
  const whereParts = pks.map((c) => {
    const i = columns.indexOf(c);
    return `${quoteIdent(c, dbType)} = ${sqlLiteral(row[i], (colTypes || [])[i])}`;
  });
  return `UPDATE ${quoteIdent(table, dbType)} SET ${setParts.join(", ")} WHERE ${whereParts.join(" AND ")}`;
}

/** 生成 INSERT SQL：整行所有列插入（主键交给数据库处理时可先把主键单元格清空） */
export function genInsertSQL(table, columns, row, colTypes, dbType) {
  const names = columns.map((c) => quoteIdent(c, dbType)).join(", ");
  const vals = columns.map((c, i) => sqlLiteral(row[i], (colTypes || [])[i])).join(", ");
  return `INSERT INTO ${quoteIdent(table, dbType)} (${names}) VALUES (${vals})`;
}

/** 生成 DELETE SQL：WHERE 用主键定位；无主键返回 null */
export function genDeleteSQL(table, columns, row, colTypes, dbType, pkCols) {
  const pks = (pkCols || []).filter((c) => columns.includes(c));
  if (!pks.length) return null;
  const whereParts = pks.map((c) => {
    const i = columns.indexOf(c);
    return `${quoteIdent(c, dbType)} = ${sqlLiteral(row[i], (colTypes || [])[i])}`;
  });
  return `DELETE FROM ${quoteIdent(table, dbType)} WHERE ${whereParts.join(" AND ")}`;
}

/**
 * 生成 DELETE SQL（无主键降级）：用整行全部列作为 WHERE 条件定位。
 * NULL 列用 IS NULL；注意：表中存在完全相同的重复行时会被一次删除多条。
 */
export function genDeleteByRowSQL(table, columns, row, colTypes, dbType) {
  const conds = [];
  for (let i = 0; i < columns.length; i++) {
    const v = row[i];
    if (v === null || v === undefined) {
      conds.push(`${quoteIdent(columns[i], dbType)} IS NULL`);
    } else {
      conds.push(`${quoteIdent(columns[i], dbType)} = ${sqlLiteral(v, (colTypes || [])[i])}`);
    }
  }
  if (!conds.length) return null;
  return `DELETE FROM ${quoteIdent(table, dbType)} WHERE ${conds.join(" AND ")}`;
}

/**
 * 从 SQL 中提取第一个 FROM 表名（支持 schema.table 与引号包裹），
 * 仅取最后一段（去掉 schema 前缀），取不到返回 null。
 */
export function extractTable(sql) {
  const id = String.raw`(?:"[^"]+"|\`[^\`]+\`|'[^']+'|[\w$]+)`;
  const m = String(sql || "").match(new RegExp(`FROM\\s+(${id}(?:\\.${id})?)`, "i"));
  if (!m) return null;
  return m[1].split(".").pop().replace(/^[`"']|[`"']$/g, "");
}

// ---------- 导出（CSV / JSON） ----------

/** 结果集 → CSV：带 BOM（Excel 识别 UTF-8），NULL 输出空串，含逗号/引号/换行的值加引号转义 */
export function toCSV(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  if (!cols.length) return "";
  const rs = Array.isArray(rows) ? rows : [];
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const line = (arr) => arr.map(esc).join(",");
  const lines = [line(cols), ...rs.map((r) => line(cols.map((_, i) => (r && r[i] !== undefined ? r[i] : null))))];
  return "\uFEFF" + lines.join("\r\n");
}

/** 结果集 → JSON 对象数组（每行 { 列名: 值 }），直接 JSON.stringify 即可导出 */
export function toJSONExport(columns, rows) {
  const cols = Array.isArray(columns) ? columns : [];
  const rs = Array.isArray(rows) ? rows : [];
  return rs.map((r) =>
    Object.fromEntries(cols.map((c, i) => [c, r && r[i] !== undefined ? r[i] : null]))
  );
}

// ---------- SQL 收藏夹 ----------

/** 追加收藏：按 SQL 内容去重置顶 + 按最大条数裁剪；name 可空 */
export function pushFav(list, item, max = 50) {
  const sql = String((item && item.sql) || "").trim();
  if (!sql) return Array.isArray(list) ? list : [];
  const base = Array.isArray(list) ? list : [];
  return [
    { sql, name: String((item && item.name) || "").trim(), ts: Date.now() },
    ...base.filter((f) => f && f.sql !== sql),
  ].slice(0, max);
}

/** 收藏展示名：name 优先，否则取 SQL 首行前 40 字符 */
export function favLabel(fav) {
  if (fav && String(fav.name || "").trim()) return fav.name.trim();
  const sql = String((fav && fav.sql) || "").trim().split("\n")[0] || "";
  return sql.length > 40 ? sql.slice(0, 40) + "…" : sql;
}
