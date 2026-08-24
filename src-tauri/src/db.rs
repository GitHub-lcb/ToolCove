//! 数据库工具后端：连接并执行 SQL（MySQL / PostgreSQL / SQLite / Oracle-ODBC）。
//!
//! 所有连接由独立的「DB worker 线程」串行持有——ODBC 连接句柄绑定线程（非 Send），
//! 集中管理同时规避多线程并发访问同一连接的问题；前端命令只与 worker 通信。

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::OnceLock;
use std::time::Instant;
use tauri::Manager;

use odbc_api::{ConnectionOptions, Cursor, DataType, ResultSetMetadata};
use mysql::consts::ColumnType;
use mysql::prelude::Queryable;
use serde_json::{json, Value};

/// 单次查询最多返回的行数，超出截断并标记 truncated
const MAX_ROWS: usize = 1000;

/// 统一查询输出：(列名, 简化列类型, 行数据, 影响行数, 是否截断)。
/// 简化列类型取值：number / text / date / blob / other（数据编辑时判断值是否需要加引号）
type QueryOut = (Vec<String>, Vec<String>, Vec<Vec<Value>>, Option<u64>, bool);

/// 简化类型映射：MySQL 原生列类型 → number/text/date/blob
fn mysql_simplify(t: ColumnType) -> &'static str {
    match t {
        ColumnType::MYSQL_TYPE_TINY
        | ColumnType::MYSQL_TYPE_SHORT
        | ColumnType::MYSQL_TYPE_LONG
        | ColumnType::MYSQL_TYPE_INT24
        | ColumnType::MYSQL_TYPE_LONGLONG
        | ColumnType::MYSQL_TYPE_FLOAT
        | ColumnType::MYSQL_TYPE_DOUBLE
        | ColumnType::MYSQL_TYPE_DECIMAL
        | ColumnType::MYSQL_TYPE_NEWDECIMAL
        | ColumnType::MYSQL_TYPE_BIT
        | ColumnType::MYSQL_TYPE_YEAR => "number",
        ColumnType::MYSQL_TYPE_DATE
        | ColumnType::MYSQL_TYPE_NEWDATE
        | ColumnType::MYSQL_TYPE_DATETIME
        | ColumnType::MYSQL_TYPE_TIMESTAMP
        | ColumnType::MYSQL_TYPE_TIME => "date",
        ColumnType::MYSQL_TYPE_TINY_BLOB
        | ColumnType::MYSQL_TYPE_MEDIUM_BLOB
        | ColumnType::MYSQL_TYPE_LONG_BLOB
        | ColumnType::MYSQL_TYPE_BLOB
        | ColumnType::MYSQL_TYPE_GEOMETRY => "blob",
        _ => "text",
    }
}

/// 简化类型映射：ODBC DataType → number/text/date/blob
fn oracle_simplify(dt: &DataType) -> &'static str {
    match dt {
        DataType::Numeric { .. }
        | DataType::Decimal { .. }
        | DataType::Integer
        | DataType::SmallInt
        | DataType::BigInt
        | DataType::TinyInt
        | DataType::Float { .. }
        | DataType::Real
        | DataType::Double
        | DataType::Bit => "number",
        DataType::Date | DataType::Time { .. } | DataType::Timestamp { .. } => "date",
        DataType::Binary { .. } | DataType::Varbinary { .. } | DataType::LongVarbinary { .. } => {
            "blob"
        }
        _ => "text",
    }
}

/// 字符串字面量转义：SQL 单引号字符串中的 `'` 双写
fn sq(s: &str) -> String {
    s.replace('\'', "''")
}

/// 标识符转义：双引号包裹（SQLite PRAGMA / PostgreSQL 标识符），内部 `"` 双写
fn dq(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\"\""))
}

// ---------- 连接参数 ----------

#[derive(Debug, Clone)]
pub struct DbOpts {
    pub db_type: String,        // mysql / postgres / sqlite / oracle
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub database: String,       // 库名；sqlite 为文件路径
    pub oracle_driver: String,  // oracle：ODBC 驱动名
    pub oracle_service: String, // oracle：Service Name（服务名）
}

impl DbOpts {
    pub fn from_json(v: &Value) -> Result<Self, String> {
        let get = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let mut opts = Self {
            db_type: get("type").to_lowercase(),
            host: get("host"),
            port: v.get("port").and_then(Value::as_u64).unwrap_or(0) as u16,
            user: get("user"),
            password: get("password"),
            database: get("database"),
            oracle_driver: get("oracleDriver"),
            oracle_service: get("oracleService"),
        };
        // 缺省端口按类型补齐
        if opts.port == 0 {
            opts.port = match opts.db_type.as_str() {
                "mysql" => 3306,
                "postgres" => 5432,
                "oracle" => 1521,
                _ => 0,
            };
        }
        Ok(opts)
    }
}

// ---------- 连接与查询 ----------

enum DbConn {
    Mysql(mysql::Conn),
    Pg(postgres::Client),
    Sqlite(rusqlite::Connection),
    Oracle(odbc_api::Connection<'static>),
}

fn do_connect(o: &DbOpts) -> Result<DbConn, String> {
    match o.db_type.as_str() {
        "mysql" => connect_mysql(o),
        "postgres" => connect_pg(o),
        "sqlite" => connect_sqlite(o),
        "oracle" => connect_oracle(o),
        other => Err(format!("不支持的数据库类型：{other}")),
    }
}

fn connect_mysql(o: &DbOpts) -> Result<DbConn, String> {
    let opts = mysql::OptsBuilder::new()
        .ip_or_hostname(Some(o.host.as_str()))
        .tcp_port(o.port)
        .user(Some(o.user.as_str()))
        .pass(Some(o.password.as_str()))
        .db_name(Some(o.database.as_str()));
    mysql::Conn::new(opts)
        .map(DbConn::Mysql)
        .map_err(|e| format!("MySQL 连接失败：{e}"))
}

fn connect_pg(o: &DbOpts) -> Result<DbConn, String> {
    // libpq 连接串：值含空格/引号/反斜杠时用单引号包裹并转义
    fn kv(k: &str, v: &str) -> String {
        format!("{k}='{}'", v.replace('\\', "\\\\").replace('\'', "\\'"))
    }
    let conn_str = [
        kv("host", &o.host),
        kv("port", &o.port.to_string()),
        kv("user", &o.user),
        kv("password", &o.password),
        kv("dbname", &o.database),
    ]
    .join(" ");
    postgres::Client::connect(&conn_str, postgres::NoTls)
        .map(DbConn::Pg)
        .map_err(|e| format!("PostgreSQL 连接失败：{e}"))
}

fn connect_sqlite(o: &DbOpts) -> Result<DbConn, String> {
    if o.database.trim().is_empty() {
        return Err("请选择 SQLite 数据库文件".to_string());
    }
    rusqlite::Connection::open(&o.database)
        .map(DbConn::Sqlite)
        .map_err(|e| format!("SQLite 打开失败：{e}"))
}

// Oracle：ODBC 环境进程级复用（Connection 的生命周期绑定 Environment）
fn oracle_env() -> Result<&'static odbc_api::Environment, String> {
    static ENV: OnceLock<odbc_api::Environment> = OnceLock::new();
    if let Some(env) = ENV.get() {
        return Ok(env);
    }
    let env = odbc_api::Environment::new().map_err(|e| format!("初始化 ODBC 环境失败：{e}"))?;
    Ok(ENV.get_or_init(|| env))
}

/// ODBC 连接串花括号转义：值内的 `}` 需双写
fn odbc_escape(s: &str) -> String {
    s.replace('}', "}}")
}

/// 本机已安装的 ODBC 驱动名列表
fn installed_drivers(env: &odbc_api::Environment) -> Result<Vec<String>, String> {
    let drivers = env
        .drivers()
        .map_err(|e| format!("读取 ODBC 驱动列表失败：{e}"))?;
    Ok(drivers.into_iter().map(|d| d.description).collect())
}

/// 判断驱动名是否为 Oracle 相关（名称含 oracle，忽略大小写）
fn is_oracle_driver(name: &str) -> bool {
    name.to_ascii_lowercase().contains("oracle")
}

fn connect_oracle(o: &DbOpts) -> Result<DbConn, String> {
    if o.oracle_driver.trim().is_empty() {
        return Err("请选择 Oracle ODBC 驱动（需在本机安装 Oracle Instant Client 及 ODBC 驱动）".to_string());
    }
    if o.oracle_service.trim().is_empty() {
        return Err("请填写 Oracle Service Name（服务名）".to_string());
    }
    let env = oracle_env()?;
    // 前置校验驱动：必须真实存在且为 Oracle 相关，否则连接串会被其他驱动
    // （如 Windows 默认的 SQL Server）接管，报「没有提供任何 DSN 或 SERVER 关键字」
    let installed = installed_drivers(&env)?;
    let hit = installed.iter().find(|d| d.eq_ignore_ascii_case(&o.oracle_driver));
    let Some(driver) = hit else {
        let list = if installed.is_empty() {
            "（无）".to_string()
        } else {
            installed.join("、")
        };
        return Err(format!(
            "本机未安装 ODBC 驱动「{}」，已安装驱动：{}。请先安装 Oracle Instant Client 并注册其 ODBC 驱动",
            o.oracle_driver, list
        ));
    };
    if !is_oracle_driver(driver) {
        let oracles: Vec<&String> = installed.iter().filter(|d| is_oracle_driver(d)).collect();
        let list = if oracles.is_empty() {
            "（无，请先安装 Oracle Instant Client 的 ODBC 驱动）".to_string()
        } else {
            oracles.iter().map(|s| s.as_str()).collect::<Vec<_>>().join("、")
        };
        return Err(format!(
            "「{driver}」不是 Oracle ODBC 驱动，请选择 Oracle 相关驱动（本机已安装的 Oracle 驱动：{list}）"
        ));
    }
    let conn_str = format!(
        "Driver={{{}}};Dbq=//{}:{}/{};Uid={};Pwd={}",
        odbc_escape(driver),
        o.host,
        o.port,
        o.oracle_service,
        odbc_escape(&o.user),
        odbc_escape(&o.password),
    );
    env.connect_with_connection_string(&conn_str, ConnectionOptions::default())
        .map(DbConn::Oracle)
        .map_err(|e| format!("Oracle 连接失败：{e}"))
}

/// 统一查询入口：返回 (列名, 简化列类型, 行数据, 影响行数, 是否截断)。
/// 单元格统一转为字符串（保大整数/浮点精度），NULL 保持 null。
fn do_query(conn: &mut DbConn, sql: &str) -> Result<Value, String> {
    let started = Instant::now();
    let (columns, col_types, rows, affected, truncated) = match conn {
        DbConn::Mysql(c) => query_mysql(c, sql)?,
        DbConn::Pg(c) => query_pg(c, sql)?,
        DbConn::Sqlite(c) => query_sqlite(c, sql)?,
        DbConn::Oracle(c) => query_oracle(c, sql)?,
    };
    Ok(json!({
        "columns": columns,
        "colTypes": col_types,
        "rows": rows,
        "rowCount": rows.len(),
        "affected": affected,
        "truncated": truncated,
        "durationMs": started.elapsed().as_millis() as u64,
    }))
}

fn query_mysql(c: &mut mysql::Conn, sql: &str) -> Result<QueryOut, String> {
    let mut result = c.query_iter(sql).map_err(|e| format!("SQL 执行失败：{e}"))?;
    let mut columns: Vec<String> = Vec::new();
    let mut col_types: Vec<String> = Vec::new();
    for col in result.columns().as_ref() {
        columns.push(col.name_str().to_string());
        col_types.push(mysql_simplify(col.column_type()).to_string());
    }
    if columns.is_empty() {
        // 无结果集的语句（INSERT/UPDATE/DELETE/DDL）
        return Ok((columns, col_types, Vec::new(), Some(result.affected_rows()), false));
    }
    let mut rows = Vec::new();
    let mut truncated = false;
    for item in result.by_ref() {
        let row = item.map_err(|e| format!("读取结果失败：{e}"))?;
        if rows.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        let vals: Vec<Value> = row.unwrap().iter().map(mysql_value_to_json).collect();
        rows.push(vals);
    }
    Ok((columns, col_types, rows, None, truncated))
}

fn mysql_value_to_json(v: &mysql::Value) -> Value {
    match v {
        mysql::Value::NULL => Value::Null,
        mysql::Value::Bytes(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
        mysql::Value::Int(i) => Value::String(i.to_string()),
        mysql::Value::UInt(u) => Value::String(u.to_string()),
        mysql::Value::Float(f) => Value::String(f.to_string()),
        mysql::Value::Double(d) => Value::String(d.to_string()),
        mysql::Value::Date(y, m, d, h, mi, s, _us) => {
            let date = format!("{y:04}-{m:02}-{d:02}");
            let time = if *h == 0 && *mi == 0 && *s == 0 {
                String::new()
            } else {
                format!(" {h:02}:{mi:02}:{s:02}")
            };
            Value::String(format!("{date}{time}"))
        }
        mysql::Value::Time(neg, days, h, mi, s, _us) => {
            let sign = if *neg { "-" } else { "" };
            Value::String(format!("{sign}{days} 天 {h:02}:{mi:02}:{s:02}"))
        }
    }
}

fn query_pg(c: &mut postgres::Client, sql: &str) -> Result<QueryOut, String> {
    // simple_query 走文本协议：所有值天然为字符串表示，NULL 为 None。
    // 文本协议不带列类型（SimpleColumn 仅列名），colTypes 保守返回 text；
    // 数据编辑时的类型判断由 db_columns 元数据承担。
    let msgs = c.simple_query(sql).map_err(|e| format!("SQL 执行失败：{e}"))?;
    let mut columns: Vec<String> = Vec::new();
    let mut col_types: Vec<String> = Vec::new();
    let mut rows = Vec::new();
    let mut affected: Option<u64> = None;
    let mut truncated = false;
    for msg in msgs {
        match msg {
            postgres::SimpleQueryMessage::Row(row) => {
                if columns.is_empty() {
                    let names: Vec<String> = row
                        .columns()
                        .iter()
                        .map(|col| col.name().to_string())
                        .collect();
                    col_types = vec!["text".to_string(); names.len()];
                    columns = names;
                }
                if rows.len() >= MAX_ROWS {
                    truncated = true;
                    break;
                }
                let vals: Vec<Value> = (0..row.len())
                    .map(|i| match row.get(i) {
                        Some(s) => Value::String(s.to_string()),
                        None => Value::Null,
                    })
                    .collect();
                rows.push(vals);
            }
            postgres::SimpleQueryMessage::CommandComplete(n) => affected = Some(n),
            _ => {}
        }
    }
    Ok((columns, col_types, rows, affected, truncated))
}

fn query_sqlite(
    c: &mut rusqlite::Connection,
    sql: &str,
) -> Result<QueryOut, String> {
    let mut stmt = c.prepare(sql).map_err(|e| format!("SQL 解析失败：{e}"))?;
    let ncol = stmt.column_count();
    if ncol == 0 {
        drop(stmt);
        let n = c
            .execute(sql, [])
            .map_err(|e| format!("SQL 执行失败：{e}"))?;
        return Ok((Vec::new(), Vec::new(), Vec::new(), Some(n as u64), false));
    }
    let columns: Vec<String> = stmt
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    // 列类型在遍历行时按首个非 NULL 值推断
    let mut col_types = vec!["other".to_string(); ncol];
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut q = stmt.query([]).map_err(|e| format!("SQL 执行失败：{e}"))?;
    while let Some(row) = q.next().map_err(|e| format!("读取结果失败：{e}"))? {
        if rows.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        let mut vals = Vec::with_capacity(ncol);
        for i in 0..ncol {
            let vr = row.get_ref(i).map_err(|e| format!("读取结果失败：{e}"))?;
            if col_types[i] == "other" {
                col_types[i] = match vr {
                    rusqlite::types::ValueRef::Integer(_) | rusqlite::types::ValueRef::Real(_) => {
                        "number".to_string()
                    }
                    rusqlite::types::ValueRef::Text(_) => "text".to_string(),
                    rusqlite::types::ValueRef::Blob(_) => "blob".to_string(),
                    rusqlite::types::ValueRef::Null => "other".to_string(),
                };
            }
            vals.push(match vr {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(x) => Value::String(x.to_string()),
                rusqlite::types::ValueRef::Real(x) => Value::String(x.to_string()),
                rusqlite::types::ValueRef::Text(b) => {
                    Value::String(String::from_utf8_lossy(b).into_owned())
                }
                rusqlite::types::ValueRef::Blob(b) => Value::String(format!("0x{}", hex_bytes(b))),
            });
        }
        rows.push(vals);
    }
    Ok((columns, col_types, rows, None, truncated))
}

fn hex_bytes(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02X}")).collect()
}

fn query_oracle(
    c: &odbc_api::Connection<'static>,
    sql: &str,
) -> Result<QueryOut, String> {
    let cursor = c
        .execute(sql, (), None)
        .map_err(|e| format!("SQL 执行失败：{e}"))?;
    let Some(mut cursor) = cursor else {
        // 无结果集的语句（DML/DDL）
        return Ok((Vec::new(), Vec::new(), Vec::new(), None, false));
    };
    let ncol = cursor
        .num_result_cols()
        .map_err(|e| format!("读取结果集列数失败：{e}"))?;
    if ncol <= 0 {
        return Ok((Vec::new(), Vec::new(), Vec::new(), None, false));
    }
    let ncol = ncol as usize;
    let mut columns = Vec::with_capacity(ncol);
    let mut col_types = Vec::with_capacity(ncol);
    for i in 1..=ncol {
        match cursor.col_name(i as u16) {
            Ok(name) => columns.push(name),
            Err(_) => columns.push(format!("列{i}")),
        }
        col_types.push(match cursor.col_data_type(i as u16) {
            Ok(dt) => oracle_simplify(&dt).to_string(),
            Err(_) => "text".to_string(),
        });
    }
    let mut rows = Vec::new();
    let mut truncated = false;
    while let Some(mut row) = cursor
        .next_row()
        .map_err(|e| format!("读取结果失败：{e}"))?
    {
        if rows.len() >= MAX_ROWS {
            truncated = true;
            break;
        }
        let mut vals = Vec::with_capacity(ncol);
        for i in 1..=ncol {
            // 宽字符（UTF-16）读取：驱动负责把数据库字符集（如 ZHS16GBK）统一转为 UTF-16，
            // 窄字符 get_text 返回原始编码字节，再按 UTF-8 解析中文会出现乱码
            let mut buf = Vec::new();
            match row.get_wide_text(i as u16, &mut buf) {
                Ok(true) => vals.push(Value::String(String::from_utf16_lossy(&buf))),
                _ => vals.push(Value::Null),
            }
        }
        rows.push(vals);
    }
    Ok((columns, col_types, rows, None, truncated))
}

// ---------- 元数据查询（表清单 / 表结构） ----------

/// 表清单：[{ name, kind }]，kind 为 table / view
fn do_tables(conn: &mut DbConn) -> Result<Value, String> {
    let out = match conn {
        DbConn::Mysql(c) => tables_mysql(c)?,
        DbConn::Pg(c) => tables_pg(c)?,
        DbConn::Sqlite(c) => tables_sqlite(c)?,
        DbConn::Oracle(c) => tables_oracle(c)?,
    };
    Ok(Value::Array(out))
}

/// 表结构：[{ name, type, nullable, pk, comment }]
fn do_columns(conn: &mut DbConn, table: &str) -> Result<Value, String> {
    let out = match conn {
        DbConn::Mysql(c) => columns_mysql(c, table)?,
        DbConn::Pg(c) => columns_pg(c, table)?,
        DbConn::Sqlite(c) => columns_sqlite(c, table)?,
        DbConn::Oracle(c) => columns_oracle(c, table)?,
    };
    Ok(Value::Array(out))
}

/// 行数组 → 统一列信息对象（name 取第 0 列，其余字段按位置映射）
fn table_row_to_json(name: Value, kind: &str) -> Value {
    json!({ "name": name, "kind": kind })
}

fn tables_mysql(c: &mut mysql::Conn) -> Result<Vec<Value>, String> {
    let (_, _, rows, _, _) = query_mysql(
        c,
        "SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES \
         WHERE TABLE_SCHEMA = DATABASE() ORDER BY TABLE_NAME",
    )?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let kind = if r.get(1).and_then(Value::as_str) == Some("BASE TABLE") {
                "table"
            } else {
                "view"
            };
            table_row_to_json(r[0].clone(), kind)
        })
        .collect())
}

fn tables_pg(c: &mut postgres::Client) -> Result<Vec<Value>, String> {
    let (_, _, rows, _, _) = query_pg(
        c,
        "SELECT name, kind FROM ( \
            SELECT tablename AS name, 'table' AS kind FROM pg_tables WHERE schemaname = 'public' \
            UNION ALL \
            SELECT viewname AS name, 'view' AS kind FROM pg_views WHERE schemaname = 'public' \
         ) t ORDER BY name",
    )?;
    Ok(rows
        .into_iter()
        .map(|r| table_row_to_json(r[0].clone(), r[1].as_str().unwrap_or("table")))
        .collect())
}

fn tables_sqlite(c: &mut rusqlite::Connection) -> Result<Vec<Value>, String> {
    let (_, _, rows, _, _) = query_sqlite(
        c,
        "SELECT name, type FROM sqlite_master \
         WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )?;
    Ok(rows
        .into_iter()
        .map(|r| table_row_to_json(r[0].clone(), r[1].as_str().unwrap_or("table")))
        .collect())
}

fn tables_oracle(c: &odbc_api::Connection<'static>) -> Result<Vec<Value>, String> {
    let (_, _, rows, _, _) = query_oracle(
        c,
        "SELECT name, kind FROM ( \
            SELECT table_name AS name, 'table' AS kind FROM all_tables WHERE owner = USER \
            UNION ALL \
            SELECT view_name AS name, 'view' AS kind FROM all_views WHERE owner = USER \
         ) ORDER BY name",
    )?;
    Ok(rows
        .into_iter()
        .map(|r| table_row_to_json(r[0].clone(), r[1].as_str().unwrap_or("table")))
        .collect())
}

fn columns_mysql(c: &mut mysql::Conn, table: &str) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_COMMENT \
         FROM information_schema.COLUMNS \
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' ORDER BY ORDINAL_POSITION",
        sq(table)
    );
    let (_, _, rows, _, _) = query_mysql(c, &sql)?;
    Ok(rows
        .into_iter()
        .map(|r| {
            json!({
                "name": r[0],
                "type": r[1],
                "nullable": r[2].as_str() == Some("YES"),
                "pk": r[3].as_str() == Some("PRI"),
                "comment": r[4],
            })
        })
        .collect())
}

fn columns_pg(c: &mut postgres::Client, table: &str) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT column_name, data_type, is_nullable, COALESCE(column_default, '') \
         FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = '{}' ORDER BY ordinal_position",
        sq(table)
    );
    let (_, _, rows, _, _) = query_pg(c, &sql)?;
    // 主键列集合（information_schema 约束查询）
    let pk_sql = format!(
        "SELECT kcu.column_name FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name \
         WHERE tc.table_schema = 'public' AND tc.table_name = '{}' \
           AND tc.constraint_type = 'PRIMARY KEY'",
        sq(table)
    );
    let (_, _, pk_rows, _, _) = query_pg(c, &pk_sql)?;
    let pks: Vec<String> = pk_rows
        .iter()
        .filter_map(|r| r[0].as_str().map(String::from))
        .collect();
    Ok(rows
        .into_iter()
        .map(|r| {
            let name = r[0].as_str().unwrap_or("").to_string();
            json!({
                "name": r[0],
                "type": r[1],
                "nullable": r[2].as_str() == Some("YES"),
                "pk": pks.contains(&name),
                "comment": "",
            })
        })
        .collect())
}

fn columns_sqlite(c: &mut rusqlite::Connection, table: &str) -> Result<Vec<Value>, String> {
    // PRAGMA table_info 返回：cid, name, type, notnull, dflt_value, pk（pk>0 为主键）
    let sql = format!("PRAGMA table_info({})", dq(table));
    let mut stmt = c
        .prepare(&sql)
        .map_err(|e| format!("读取表结构失败：{e}"))?;
    let mut q = stmt
        .query([])
        .map_err(|e| format!("读取表结构失败：{e}"))?;
    let mut out = Vec::new();
    while let Some(row) = q.next().map_err(|e| format!("读取表结构失败：{e}"))? {
        out.push(json!({
            "name": row.get::<_, String>(1).unwrap_or_default(),
            "type": row.get::<_, String>(2).unwrap_or_default(),
            "nullable": row.get::<_, i64>(3).unwrap_or(0) == 0,
            "pk": row.get::<_, i64>(5).unwrap_or(0) > 0,
            "comment": "",
        }));
    }
    Ok(out)
}

fn columns_oracle(c: &odbc_api::Connection<'static>, table: &str) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT column_name, data_type, nullable, NVL(data_default, '') \
         FROM all_tab_columns WHERE owner = USER AND table_name = '{}' ORDER BY column_id",
        sq(table)
    );
    let (_, _, rows, _, _) = query_oracle(c, &sql)?;
    let pk_sql = format!(
        "SELECT acc.column_name FROM all_constraints ac \
         JOIN all_cons_columns acc ON ac.constraint_name = acc.constraint_name AND ac.owner = acc.owner \
         WHERE ac.owner = USER AND ac.table_name = '{}' AND ac.constraint_type = 'P'",
        sq(table)
    );
    let (_, _, pk_rows, _, _) = query_oracle(c, &pk_sql)?;
    let pks: Vec<String> = pk_rows
        .iter()
        .filter_map(|r| r[0].as_str().map(String::from))
        .collect();
    Ok(rows
        .into_iter()
        .map(|r| {
            let name = r[0].as_str().unwrap_or("").to_string();
            json!({
                "name": r[0],
                "type": r[1],
                "nullable": r[2].as_str() == Some("Y"),
                "pk": pks.contains(&name),
                "comment": "",
            })
        })
        .collect())
}

// ---------- 元数据查询（索引 / DDL） ----------

/// 按索引名合并列：已存在则追加列，否则新建分组（保留各库原始顺序）
fn merge_index(
    groups: &mut Vec<Value>,
    name: &str,
    unique: bool,
    col: &str,
    def: &str,
    comment: &str,
) {
    if let Some(g) = groups.iter_mut().find(|g| g["name"].as_str() == Some(name)) {
        if !col.is_empty() {
            g["columns"].as_array_mut().unwrap().push(json!(col));
        }
        if !def.is_empty() {
            g["def"] = json!(def);
        }
        if !comment.is_empty() {
            g["comment"] = json!(comment);
        }
    } else {
        groups.push(json!({
            "name": name,
            "unique": unique,
            "columns": if col.is_empty() { Value::Array(Vec::new()) } else { json!([col]) },
            "def": def,
            "comment": comment,
        }));
    }
}

/// 表索引：[{ name, unique, columns, def?, comment? }]，按索引名分组、列按位置排序
fn do_indexes(conn: &mut DbConn, table: &str) -> Result<Value, String> {
    let out = match conn {
        DbConn::Mysql(c) => indexes_mysql(c, table)?,
        DbConn::Pg(c) => indexes_pg(c, table)?,
        DbConn::Sqlite(c) => indexes_sqlite(c, table)?,
        DbConn::Oracle(c) => indexes_oracle(c, table)?,
    };
    Ok(Value::Array(out))
}

/// 表 DDL（CREATE TABLE 文本；PostgreSQL 为从元数据还原的重建语句）
fn do_ddl(conn: &mut DbConn, table: &str) -> Result<Value, String> {
    let out = match conn {
        DbConn::Mysql(c) => ddl_mysql(c, table)?,
        DbConn::Pg(c) => ddl_pg(c, table)?,
        DbConn::Sqlite(c) => ddl_sqlite(c, table)?,
        DbConn::Oracle(c) => ddl_oracle(c, table)?,
    };
    Ok(json!(out))
}

/// 按索引名补全「定义」列（MySQL/Oracle 由列清单反推，PG 直接用原生 CREATE INDEX）
fn fill_index_def(groups: &mut [Value], table: &str) {
    for g in groups {
        let name = g["name"].as_str().unwrap_or("").to_string();
        if name.is_empty() || !g["def"].as_str().map_or(true, |s| s.is_empty()) {
            continue;
        }
        let unique = g["unique"].as_bool().unwrap_or(false);
        let cols: Vec<&str> = g["columns"]
            .as_array()
            .map(|a| a.iter().filter_map(|c| c.as_str()).collect())
            .unwrap_or_default();
        let cols_str = cols.join(", ");
        let def = if name.eq_ignore_ascii_case("PRIMARY") {
            format!("PRIMARY KEY ({cols_str})")
        } else {
            format!(
                "CREATE {}INDEX {name} ON {table} ({cols_str})",
                if unique { "UNIQUE " } else { "" }
            )
        };
        g["def"] = json!(def);
    }
}

fn indexes_mysql(c: &mut mysql::Conn, table: &str) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE \
         FROM information_schema.STATISTICS \
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{}' \
         ORDER BY INDEX_NAME, SEQ_IN_INDEX",
        sq(table)
    );
    let (_, _, rows, _, _) = query_mysql(c, &sql)?;
    let mut groups: Vec<Value> = Vec::new();
    for r in &rows {
        let name = r[0].as_str().unwrap_or("").to_string();
        let unique = r[1].as_str() == Some("0");
        let col = r[2].as_str().unwrap_or("").to_string();
        let comment = r[3].as_str().unwrap_or("").to_string();
        merge_index(&mut groups, &name, unique, &col, "", &comment);
    }
    fill_index_def(&mut groups, table);
    Ok(groups)
}

fn indexes_pg(c: &mut postgres::Client, table: &str) -> Result<Vec<Value>, String> {
    let col_sql = format!(
        "SELECT i.relname AS index_name, ix.indisunique AS is_unique, a.attname AS column_name \
         FROM pg_class t \
         JOIN pg_index ix ON t.oid = ix.indrelid \
         JOIN pg_class i ON i.oid = ix.indexrelid \
         JOIN pg_attribute a ON a.attrelid = i.oid AND a.attnum = ANY(ix.indkey) \
         WHERE t.relname = '{}' AND t.relkind = 'r' \
         ORDER BY i.relname, a.attnum",
        sq(table)
    );
    let (_, _, rows, _, _) = query_pg(c, &col_sql)?;
    let mut groups: Vec<Value> = Vec::new();
    for r in &rows {
        let name = r[0].as_str().unwrap_or("").to_string();
        let unique = r[1].as_str() == Some("t");
        let col = r[2].as_str().unwrap_or("").to_string();
        merge_index(&mut groups, &name, unique, &col, "", "");
    }
    // 补充原生 CREATE INDEX 定义（含 WHERE/表达式等原始信息）
    let def_sql = format!(
        "SELECT indexname, indexdef FROM pg_indexes \
         WHERE schemaname = 'public' AND tablename = '{}' ORDER BY indexname",
        sq(table)
    );
    let (_, _, def_rows, _, _) = query_pg(c, &def_sql)?;
    for r in &def_rows {
        let name = r[0].as_str().unwrap_or("");
        let def = r[1].as_str().unwrap_or("");
        if let Some(g) = groups.iter_mut().find(|g| g["name"].as_str() == Some(name)) {
            g["def"] = json!(def);
        }
    }
    Ok(groups)
}

fn indexes_sqlite(c: &mut rusqlite::Connection, table: &str) -> Result<Vec<Value>, String> {
    // index_list: seq, name, unique, origin, partial；index_info: seqno, cid, name
    let list_sql = format!("PRAGMA index_list({})", dq(table));
    let (_, _, list_rows, _, _) = query_sqlite(c, &list_sql)?;
    let mut groups: Vec<Value> = Vec::new();
    for r in &list_rows {
        let name = r[1].as_str().unwrap_or("").to_string();
        let unique = r[2].as_str() == Some("1");
        let partial = r[4].as_str() == Some("1");
        let mut g = json!({
            "name": name,
            "unique": unique,
            "columns": Value::Array(Vec::new()),
            "def": "",
            "comment": "",
        });
        if partial {
            g["comment"] = json!("部分索引");
        }
        groups.push(g);
    }
    for g in &mut groups {
        let name = g["name"].as_str().unwrap_or("").to_string();
        let info_sql = format!("PRAGMA index_info({})", dq(&name));
        let (_, _, info_rows, _, _) = query_sqlite(c, &info_sql)?;
        let cols: Vec<Value> = info_rows.iter().map(|r| r[2].clone()).collect();
        g["columns"] = json!(cols);
    }
    fill_index_def(&mut groups, table);
    Ok(groups)
}

fn indexes_oracle(c: &odbc_api::Connection<'static>, table: &str) -> Result<Vec<Value>, String> {
    let sql = format!(
        "SELECT i.index_name, i.uniqueness, ic.column_name \
         FROM all_indexes i \
         JOIN all_ind_columns ic ON i.index_name = ic.index_name AND i.owner = ic.index_owner \
         WHERE i.owner = USER AND i.table_name = '{}' \
         ORDER BY i.index_name, ic.column_position",
        sq(table)
    );
    let (_, _, rows, _, _) = query_oracle(c, &sql)?;
    let mut groups: Vec<Value> = Vec::new();
    for r in &rows {
        let name = r[0].as_str().unwrap_or("").to_string();
        let unique = r[1].as_str() == Some("UNIQUE");
        let col = r[2].as_str().unwrap_or("").to_string();
        merge_index(&mut groups, &name, unique, &col, "", "");
    }
    fill_index_def(&mut groups, table);
    Ok(groups)
}

fn ddl_mysql(c: &mut mysql::Conn, table: &str) -> Result<String, String> {
    // SHOW CREATE TABLE 对视图同样可用，返回两列：Table, Create Table
    let sql = format!("SHOW CREATE TABLE `{}`", table.replace('`', "``"));
    let (_, _, rows, _, _) = query_mysql(c, &sql)?;
    rows.first()
        .and_then(|r| r.get(1).and_then(Value::as_str).map(String::from))
        .ok_or_else(|| format!("表不存在：{table}"))
}

/// PostgreSQL 列类型还原：information_schema.data_type → 可建表方言
fn pg_type_name(col_type: &str, len: &str, np: &str, ns: &str) -> String {
    match col_type {
        "character varying" if !len.is_empty() => format!("VARCHAR({len})"),
        "character varying" => "VARCHAR".to_string(),
        "character" if !len.is_empty() => format!("CHAR({len})"),
        "character" => "CHAR".to_string(),
        "numeric" if !np.is_empty() && !ns.is_empty() => format!("NUMERIC({np},{ns})"),
        "numeric" => "NUMERIC".to_string(),
        "timestamp with time zone" => "TIMESTAMPTZ".to_string(),
        "timestamp without time zone" => "TIMESTAMP".to_string(),
        "time with time zone" => "TIMETZ".to_string(),
        "time without time zone" => "TIME".to_string(),
        "double precision" => "DOUBLE PRECISION".to_string(),
        "boolean" => "BOOLEAN".to_string(),
        "text" => "TEXT".to_string(),
        "integer" => "INTEGER".to_string(),
        "bigint" => "BIGINT".to_string(),
        "smallint" => "SMALLINT".to_string(),
        "real" => "REAL".to_string(),
        "uuid" => "UUID".to_string(),
        "jsonb" => "JSONB".to_string(),
        "json" => "JSON".to_string(),
        "bytea" => "BYTEA".to_string(),
        "date" => "DATE".to_string(),
        "money" => "MONEY".to_string(),
        "inet" => "INET".to_string(),
        "interval" => "INTERVAL".to_string(),
        other => other.to_uppercase(),
    }
}

/// PostgreSQL DDL 还原：列 + 主键 + 索引（原始 DDL 不可直接取，按元数据重建）
fn ddl_pg(c: &mut postgres::Client, table: &str) -> Result<String, String> {
    // 视图：直接返回重建语句
    let view_sql = format!(
        "SELECT definition FROM pg_views WHERE schemaname = 'public' AND viewname = '{}'",
        sq(table)
    );
    let (_, _, view_rows, _, _) = query_pg(c, &view_sql)?;
    if let Some(r) = view_rows.first() {
        if let Some(def) = r[0].as_str() {
            return Ok(format!("CREATE VIEW {} AS\n{}", dq(table), def));
        }
    }
    let col_sql = format!(
        "SELECT column_name, data_type, COALESCE(character_maximum_length::text, ''), \
                COALESCE(numeric_precision::text, ''), COALESCE(numeric_scale::text, ''), \
                is_nullable, COALESCE(column_default, '') \
         FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = '{}' \
         ORDER BY ordinal_position",
        sq(table)
    );
    let (_, _, rows, _, _) = query_pg(c, &col_sql)?;
    if rows.is_empty() {
        return Err(format!("表不存在：{table}"));
    }
    // 主键约束名与列（按位置排序）
    let pk_sql = format!(
        "SELECT tc.constraint_name, kcu.column_name \
         FROM information_schema.table_constraints tc \
         JOIN information_schema.key_column_usage kcu \
           ON tc.constraint_name = kcu.constraint_name AND tc.constraint_schema = kcu.constraint_schema \
         WHERE tc.table_schema = 'public' AND tc.table_name = '{}' \
           AND tc.constraint_type = 'PRIMARY KEY' ORDER BY kcu.ordinal_position",
        sq(table)
    );
    let (_, _, pk_rows, _, _) = query_pg(c, &pk_sql)?;
    let pk_name = pk_rows
        .first()
        .and_then(|r| r[0].as_str().map(String::from))
        .unwrap_or_else(|| "pk".to_string());
    let pk_cols: Vec<&str> = pk_rows.iter().filter_map(|r| r[1].as_str()).collect();

    let mut inner: Vec<String> = Vec::new();
    for r in &rows {
        let name = r[0].as_str().unwrap_or("");
        let default = r[6].as_str().unwrap_or("");
        let not_null = r[5].as_str() == Some("NO");
        // 默认值为 nextval 的整数列还原为 SERIAL 家族（等价于原始建表写法）
        let serial = if default.starts_with("nextval(") {
            match r[1].as_str() {
                Some("integer") => Some("SERIAL"),
                Some("bigint") => Some("BIGSERIAL"),
                Some("smallint") => Some("SMALLSERIAL"),
                _ => None,
            }
        } else {
            None
        };
        let mut line = format!(
            "  {} {}",
            dq(name),
            serial.map(String::from).unwrap_or_else(|| pg_type_name(
                r[1].as_str().unwrap_or(""),
                r[2].as_str().unwrap_or(""),
                r[3].as_str().unwrap_or(""),
                r[4].as_str().unwrap_or(""),
            ))
        );
        if serial.is_none() && !default.is_empty() {
            line = format!("{line} DEFAULT {default}");
        }
        if not_null {
            line = format!("{line} NOT NULL");
        }
        inner.push(line);
    }
    if !pk_cols.is_empty() {
        let pks: Vec<String> = pk_cols.iter().map(|c| dq(c)).collect();
        inner.push(format!(
            "  CONSTRAINT {} PRIMARY KEY ({})",
            dq(&pk_name),
            pks.join(", ")
        ));
    }
    let mut out = format!("CREATE TABLE {} (\n{}\n);", dq(table), inner.join(",\n"));
    // 追加索引定义
    let idx_sql = format!(
        "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = '{}' ORDER BY indexname",
        sq(table)
    );
    let (_, _, idx_rows, _, _) = query_pg(c, &idx_sql)?;
    for r in &idx_rows {
        if let Some(def) = r[0].as_str() {
            out.push('\n');
            out.push_str(def);
            out.push(';');
        }
    }
    Ok(out)
}

fn ddl_sqlite(c: &mut rusqlite::Connection, table: &str) -> Result<String, String> {
    let (_, _, rows, _, _) = query_sqlite(c, &format!(
        "SELECT sql FROM sqlite_master WHERE type IN ('table','view') AND name = {}",
        dq(table)
    ))?;
    let mut out = rows
        .first()
        .and_then(|r| r[0].as_str().map(String::from))
        .ok_or_else(|| format!("表不存在：{table}"))?;
    // 追加该表的显式索引（自动索引的 sql 为 NULL，跳过）
    let (_, _, idx_rows, _, _) = query_sqlite(c, &format!(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = {} \
         AND sql IS NOT NULL ORDER BY name",
        dq(table)
    ))?;
    for r in &idx_rows {
        if let Some(s) = r[0].as_str() {
            out.push_str(";\n");
            out.push_str(s);
        }
    }
    Ok(out)
}

fn ddl_oracle(c: &odbc_api::Connection<'static>, table: &str) -> Result<String, String> {
    // DBMS_METADATA 按存储大小写匹配：默认大写，小写表名（加引号创建）回退原样
    let candidates = if table.to_uppercase() == table {
        vec![table.to_string()]
    } else {
        vec![table.to_uppercase(), table.to_string()]
    };
    for kind in ["TABLE", "VIEW"] {
        for name in &candidates {
            let sql = format!(
                "SELECT DBMS_METADATA.GET_DDL('{kind}', '{}') FROM dual",
                sq(name)
            );
            if let Ok((_, _, rows, _, _)) = query_oracle(c, &sql) {
                if let Some(r) = rows.first() {
                    if let Some(s) = r[0].as_str() {
                        if !s.trim().is_empty() {
                            return Ok(s.to_string());
                        }
                    }
                }
            }
        }
    }
    Err(format!(
        "获取表 DDL 失败（可能缺少 DBMS_METADATA 访问权限）：{table}"
    ))
}

// ---------- worker 线程（连接集中持有，规避 ODBC 句柄非 Send 限制） ----------

enum Msg {
    Test { opts: DbOpts, resp: Sender<Result<(bool, u64), String>> },
    Connect { opts: DbOpts, resp: Sender<Result<String, String>> },
    Query { id: String, sql: String, resp: Sender<Result<Value, String>> },
    Tables { id: String, resp: Sender<Result<Value, String>> },
    Columns { id: String, table: String, resp: Sender<Result<Value, String>> },
    Indexes { id: String, table: String, resp: Sender<Result<Value, String>> },
    Ddl { id: String, table: String, resp: Sender<Result<Value, String>> },
    Close { id: String },
    Drivers { resp: Sender<Result<Vec<String>, String>> },
}

static TX: OnceLock<Sender<Msg>> = OnceLock::new();

/// 启动 DB worker 线程（应用启动时调用一次）
pub fn init() {
    let (tx, rx) = channel::<Msg>();
    let _ = TX.set(tx);
    let _ = std::thread::Builder::new()
        .name("db-worker".to_string())
        .spawn(move || worker(rx));
}

fn send(msg: Msg) -> Result<(), String> {
    let tx = TX.get().ok_or("数据库服务未初始化")?;
    tx.send(msg).map_err(|_| "数据库线程已退出".to_string())
}

fn worker(rx: Receiver<Msg>) {
    let mut conns: HashMap<String, DbConn> = HashMap::new();
    let mut seq: u64 = 0;
    // 连接建立保留超时保护；连接失败不会产生数据库写入副作用。
    fn run_with_timeout<T: Send + 'static>(timeout: std::time::Duration, f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
        let (tx, rx) = channel();
        let handle = std::thread::spawn(move || {
            let _ = tx.send(f());
        });
        match rx.recv_timeout(timeout) {
            Ok(r) => r,
            Err(_) => {
                // 超时：子线程仍在运行，连接可能处于不确定状态，标记为需重连
                let _ = handle.thread().unpark();
                Err(format!("操作超时（{}s），连接可能已中断，请重新连接", timeout.as_secs()))
            }
        }
    }
    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Test { opts, resp } => {
                let started = Instant::now();
                let result = run_with_timeout(std::time::Duration::from_secs(15), move || {
                    do_connect(&opts).map(|_c| (true, started.elapsed().as_millis() as u64))
                });
                let _ = resp.send(result);
            }
            Msg::Connect { opts, resp } => {
                let result = run_with_timeout(std::time::Duration::from_secs(15), move || do_connect(&opts));
                let result = result.map(|conn| {
                    seq += 1;
                    let id = format!("c{seq}");
                    conns.insert(id.clone(), conn);
                    id
                });
                let _ = resp.send(result);
            }
            Msg::Query { id, sql, resp } => {
                // 驱动层没有统一可靠的取消 API，因此必须等待 SQL 真实结束。
                // 不能在 30 秒后仅停止等待，否则写 SQL 仍会在后台继续执行并误导用户。
                let result = match conns.remove(&id) {
                    Some(mut conn) => {
                        let result = do_query(&mut conn, &sql);
                        conns.insert(id, conn);
                        result
                    }
                    None => Err("连接不存在或已关闭，请重新连接".to_string()),
                };
                let _ = resp.send(result);
            }
            Msg::Tables { id, resp } => {
                let result = match conns.get_mut(&id) {
                    Some(conn) => do_tables(conn),
                    None => Err("连接不存在或已关闭，请重新连接".to_string()),
                };
                let _ = resp.send(result);
            }
            Msg::Columns { id, table, resp } => {
                let result = match conns.get_mut(&id) {
                    Some(conn) => do_columns(conn, &table),
                    None => Err("连接不存在或已关闭，请重新连接".to_string()),
                };
                let _ = resp.send(result);
            }
            Msg::Indexes { id, table, resp } => {
                let result = match conns.get_mut(&id) {
                    Some(conn) => do_indexes(conn, &table),
                    None => Err("连接不存在或已关闭，请重新连接".to_string()),
                };
                let _ = resp.send(result);
            }
            Msg::Ddl { id, table, resp } => {
                let result = match conns.get_mut(&id) {
                    Some(conn) => do_ddl(conn, &table),
                    None => Err("连接不存在或已关闭，请重新连接".to_string()),
                };
                let _ = resp.send(result);
            }
            Msg::Close { id } => {
                conns.remove(&id);
            }
            Msg::Drivers { resp } => {
                let _ = resp.send(list_drivers_inner());
            }
        }
    }
}

fn list_drivers_inner() -> Result<Vec<String>, String> {
    let env = odbc_api::Environment::new().map_err(|e| format!("初始化 ODBC 环境失败：{e}"))?;
    installed_drivers(&env)
}

/// 一键安装包解压后总大小上限（Instant Client Basic + ODBC 组件约 300MB，留余量）
const MAX_DRIVER_PKG: u64 = 1 << 30;

/// 校验并解压安装包到目标目录（防路径穿越与超限）
fn extract_driver_zip(zip_bytes: &[u8], install_dir: &Path) -> Result<(), String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes))
        .map_err(|e| format!("不是有效的 zip 安装包：{e}"))?;
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| format!("读取压缩包条目失败：{e}"))?;
        let name = entry.name().to_string();
        let is_dir = entry.is_dir();
        if name.starts_with('/') || name.starts_with('\\') || name.split(['/', '\\']).any(|s| s == "..") {
            return Err(format!("安装包含非法路径：{name}"));
        }
        total += entry.size();
        if total > MAX_DRIVER_PKG {
            return Err("安装包解压后过大（超过 1GB），已中止".to_string());
        }
        let out = install_dir.join(&name);
        if is_dir {
            std::fs::create_dir_all(&out).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut file = std::fs::File::create(&out).map_err(|e| format!("写入文件失败：{e}"))?;
        std::io::copy(&mut entry, &mut file).map_err(|e| format!("解压文件失败：{e}"))?;
    }
    Ok(())
}

/// 从内网合并包 zip 一键安装 Oracle ODBC 驱动：
/// 解压到 <数据目录>/oracle-driver/ → 提权运行 odbc_install.exe → 返回新注册的驱动名。
/// 合并包须为 Instant Client Basic + ODBC 组件的完整文件（含 odbc_install.exe）。
pub fn install_from_zip(zip_bytes: &[u8], data_dir: &Path) -> Result<String, String> {
    // 清理并重建安装目录
    let install_dir = data_dir.join("oracle-driver");
    if install_dir.exists() {
        std::fs::remove_dir_all(&install_dir).map_err(|e| format!("清理旧驱动目录失败：{e}"))?;
    }
    std::fs::create_dir_all(&install_dir).map_err(|e| format!("创建驱动目录失败：{e}"))?;

    // 记录安装前的 Oracle 驱动，便于安装后对比出新注册的驱动
    let env = oracle_env()?;
    let before: Vec<String> = installed_drivers(&env)?
        .into_iter()
        .filter(|d| is_oracle_driver(d))
        .collect();

    extract_driver_zip(zip_bytes, &install_dir)?;

    // 定位 odbc_install.exe（Instant Client ODBC 组件的驱动注册程序）
    let exe = find_odbc_install(&install_dir).ok_or_else(|| {
        "安装包内未找到 odbc_install.exe：请确认 zip 包含 Oracle Instant Client 的 ODBC 组件".to_string()
    })?;
    let exe_str = exe.to_string_lossy().replace('\'', "''");
    let work_str = exe
        .parent()
        .unwrap_or(&install_dir)
        .to_string_lossy()
        .replace('\'', "''");

    // 提权运行（UAC 由用户确认）；工作目录须为解压目录（odbc_install 相对路径加载 dll）
    let out = std::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &format!(
                "Start-Process -FilePath '{exe_str}' -WorkingDirectory '{work_str}' -Verb RunAs -Wait"
            ),
        ])
        .output()
        .map_err(|e| format!("启动安装程序失败：{e}"))?;
    if !out.status.success() {
        let msg = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!("提权安装失败（可能取消了 UAC 确认）：{msg}"));
    }

    // 对比驱动列表，返回新注册的 Oracle 驱动
    let after = installed_drivers(&env)?;
    let new: Vec<String> = after
        .into_iter()
        .filter(|d| is_oracle_driver(d) && !before.iter().any(|b| b.eq_ignore_ascii_case(d)))
        .collect();
    new.first()
        .cloned()
        .ok_or_else(|| "安装已执行但未检测到新驱动注册（请确认已允许 UAC 提权）".to_string())
}

/// 在目录树中查找 odbc_install.exe
fn find_odbc_install(dir: &Path) -> Option<PathBuf> {
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        let entries = std::fs::read_dir(&d).ok()?;
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p
                .file_name()
                .map_or(false, |n| n.eq_ignore_ascii_case("odbc_install.exe"))
            {
                return Some(p);
            }
        }
    }
    None
}

// ---------- 对外 API（供 lib.rs 的 tauri command 调用） ----------

pub fn test(opts: &Value) -> Result<Value, String> {
    let (tx, rx) = channel();
    send(Msg::Test { opts: DbOpts::from_json(opts)?, resp: tx })?;
    let (ok, ms) = rx.recv().map_err(|_| "数据库线程已退出".to_string())??;
    Ok(json!({ "ok": ok, "durationMs": ms }))
}

pub fn connect(opts: &Value) -> Result<String, String> {
    let (tx, rx) = channel();
    send(Msg::Connect { opts: DbOpts::from_json(opts)?, resp: tx })?;
    rx.recv().map_err(|_| "数据库线程已退出".to_string())?
}

pub fn query(conn_id: &str, sql: &str) -> Result<Value, String> {
    let (tx, rx) = channel();
    send(Msg::Query { id: conn_id.to_string(), sql: sql.to_string(), resp: tx })?;
    rx.recv().map_err(|_| "数据库线程已退出".to_string())?
}

pub fn tables(conn_id: &str) -> Result<Value, String> {
    let (tx, rx) = channel();
    send(Msg::Tables { id: conn_id.to_string(), resp: tx })?;
    rx.recv().map_err(|_| "数据库线程已退出".to_string())?
}

pub fn columns(conn_id: &str, table: &str) -> Result<Value, String> {
    let (tx, rx) = channel();
    send(Msg::Columns { id: conn_id.to_string(), table: table.to_string(), resp: tx })?;
    rx.recv().map_err(|_| "数据库线程已退出".to_string())?
}

pub fn indexes(conn_id: &str, table: &str) -> Result<Value, String> {
    let (tx, rx) = channel();
    send(Msg::Indexes { id: conn_id.to_string(), table: table.to_string(), resp: tx })?;
    rx.recv().map_err(|_| "数据库线程已退出".to_string())?
}

pub fn ddl(conn_id: &str, table: &str) -> Result<Value, String> {
    let (tx, rx) = channel();
    send(Msg::Ddl { id: conn_id.to_string(), table: table.to_string(), resp: tx })?;
    rx.recv().map_err(|_| "数据库线程已退出".to_string())?
}

pub fn close(conn_id: &str) -> Result<(), String> {
    send(Msg::Close { id: conn_id.to_string() })
}

pub fn list_drivers() -> Result<Vec<String>, String> {
    let (tx, rx) = channel();
    send(Msg::Drivers { resp: tx })?;
    rx.recv().map_err(|_| "数据库线程已退出".to_string())?
}

// ---------- 集成测试 ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(db_type: &str, database: &str) -> DbOpts {
        DbOpts {
            db_type: db_type.to_string(),
            host: "localhost".to_string(),
            port: 3306,
            user: String::new(),
            password: String::new(),
            database: database.to_string(),
            oracle_driver: String::new(),
            oracle_service: String::new(),
        }
    }

    /// SQLite 内存库全链路：建表 → 插入 → 查询 → 值类型校验（无需外部环境，常驻回归）
    #[test]
    fn sqlite_memory_full_flow() {
        let mut conn = do_connect(&opts("sqlite", ":memory:")).expect("SQLite 打开失败");
        do_query(&mut conn, "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL)")
            .expect("建表失败");
        let ins = do_query(&mut conn, "INSERT INTO t (name, score) VALUES ('张三', 98.5), ('李四', NULL)")
            .expect("插入失败");
        assert_eq!(ins["affected"], 2, "DML 应返回影响行数");

        let r = do_query(&mut conn, "SELECT id, name, score FROM t ORDER BY id").expect("查询失败");
        assert_eq!(r["rowCount"], 2);
        assert!(r["durationMs"].is_u64());
        let cols = r["columns"].as_array().unwrap();
        assert_eq!(
            cols.iter().map(|c| c.as_str().unwrap()).collect::<Vec<_>>(),
            vec!["id", "name", "score"]
        );
        // 列类型：id 整型 → number，name 文本 → text，score 实数 → number
        assert_eq!(
            r["colTypes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c.as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["number", "text", "number"]
        );
        assert_eq!(r["rows"][0], json!(["1", "张三", "98.5"]));
        assert_eq!(r["rows"][1][1], json!("李四"));
        assert_eq!(r["rows"][1][2], Value::Null, "NULL 应保持 null");

        // 非法 SQL 应报错
        assert!(do_query(&mut conn, "SELECT * FROM not_exist_table").is_err());
    }

    /// SQLite 内存库元数据查询：表清单（表/视图区分）+ 表结构（主键/可空标记）——无需外部环境，常驻回归
    #[test]
    fn sqlite_meta_full_flow() {
        let mut conn = do_connect(&opts("sqlite", ":memory:")).expect("SQLite 打开失败");
        do_query(
            &mut conn,
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, score REAL, memo TEXT)",
        )
        .expect("建表失败");
        do_query(&mut conn, "CREATE VIEW v_users AS SELECT id, name FROM users").expect("建视图失败");

        let t = do_tables(&mut conn).expect("表清单失败");
        let tables = t.as_array().unwrap();
        assert!(tables
            .iter()
            .any(|x| x["name"] == json!("users") && x["kind"] == json!("table")));
        assert!(tables
            .iter()
            .any(|x| x["name"] == json!("v_users") && x["kind"] == json!("view")));

        let c = do_columns(&mut conn, "users").expect("表结构失败");
        let cols = c.as_array().unwrap();
        assert_eq!(cols.len(), 4);
        let id = cols.iter().find(|x| x["name"] == json!("id")).unwrap();
        assert_eq!(id["pk"], true, "id 应标记为主键");
        let name = cols.iter().find(|x| x["name"] == json!("name")).unwrap();
        assert_eq!(name["nullable"], false, "name 为 NOT NULL");
        assert_eq!(name["type"], json!("TEXT"));
        // 不存在的表：SQLite PRAGMA 返回空集而非报错
        let missing = do_columns(&mut conn, "not_exist").expect("查询应成功");
        assert_eq!(missing.as_array().unwrap().len(), 0);
    }

    /// SQLite 内存库索引与 DDL 查询——无需外部环境，常驻回归
    #[test]
    fn sqlite_indexes_and_ddl() {
        let mut conn = do_connect(&opts("sqlite", ":memory:")).expect("SQLite 打开失败");
        do_query(
            &mut conn,
            "CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, name TEXT)",
        )
        .expect("建表失败");
        do_query(&mut conn, "CREATE UNIQUE INDEX idx_users_email ON users(email)").expect("建唯一索引失败");
        do_query(&mut conn, "CREATE INDEX idx_users_name ON users(name)").expect("建普通索引失败");

        // 索引清单：按索引名分组，唯一标记正确
        let ix = do_indexes(&mut conn, "users").expect("索引查询失败");
        let arr = ix.as_array().unwrap();
        assert_eq!(arr.len(), 2, "应返回 2 个索引");
        let email = arr.iter().find(|x| x["name"] == json!("idx_users_email")).unwrap();
        assert_eq!(email["unique"], true);
        assert_eq!(email["columns"], json!(["email"]), "索引列应有序返回");
        assert!(email["def"].as_str().unwrap().contains("UNIQUE"), "唯一索引定义应含 UNIQUE");
        let name = arr.iter().find(|x| x["name"] == json!("idx_users_name")).unwrap();
        assert_eq!(name["unique"], false);
        assert_eq!(name["columns"], json!(["name"]));
        // 无索引的表：空数组
        do_query(&mut conn, "CREATE TABLE empty_t (a TEXT)").unwrap();
        let empty = do_indexes(&mut conn, "empty_t").expect("索引查询应成功");
        assert_eq!(empty.as_array().unwrap().len(), 0);

        // DDL：含建表语句与索引语句；视图返回 CREATE VIEW
        let ddl = do_ddl(&mut conn, "users").expect("DDL 查询失败");
        let s = ddl.as_str().unwrap();
        assert!(s.contains("CREATE TABLE"), "DDL 应含建表语句，实际：{s}");
        assert!(s.contains("CREATE UNIQUE INDEX idx_users_email"), "DDL 应含唯一索引，实际：{s}");
        assert!(s.contains("CREATE INDEX idx_users_name"), "DDL 应含普通索引，实际：{s}");
        do_query(&mut conn, "CREATE VIEW v_users AS SELECT id, name FROM users").unwrap();
        let vddl = do_ddl(&mut conn, "v_users").expect("视图 DDL 失败");
        assert!(vddl.as_str().unwrap().contains("CREATE VIEW"));
        // 不存在的表：报错
        assert!(do_ddl(&mut conn, "not_exist").is_err());
    }

    /// MySQL 集成验证：需本机 MySQL 且有 DB_TEST_USER/DB_TEST_PASS/DB_TEST_DB 环境变量，缺省跳过。
    /// 用法：DB_TEST_USER=root DB_TEST_PASS=xxx DB_TEST_DB=demo cargo test mysql -- --ignored --nocapture
    #[test]
    #[ignore]
    fn mysql_real_connect_and_query() {
        let host = std::env::var("DB_TEST_HOST").unwrap_or_else(|_| "localhost".to_string());
        let user = std::env::var("DB_TEST_USER").expect("缺少 DB_TEST_USER");
        let pass = std::env::var("DB_TEST_PASS").unwrap_or_default();
        let db = std::env::var("DB_TEST_DB").unwrap_or_default();
        let mut o = opts("mysql", &db);
        o.host = host;
        o.user = user;
        o.password = pass;
        o.port = std::env::var("DB_TEST_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(3306);

        let mut conn = do_connect(&o).expect("MySQL 连接失败");
        // 诊断：列出本机数据库，便于确认 DB_TEST_DB 取值
        let dbs = do_query(&mut conn, "SHOW DATABASES").expect("SHOW DATABASES 失败");
        println!("本机数据库：{:?}", dbs["rows"]);
        assert!(!db.is_empty(), "请通过 DB_TEST_DB 指定一个存在的数据库");
        // 查询 + 值类型校验（含 NULL / 大整数保精度）
        let r = do_query(&mut conn, "SELECT 1 AS one, NULL AS n, '你好' AS s, 9007199254740993 AS big").expect("查询失败");
        assert_eq!(r["columns"], json!(["one", "n", "s", "big"]));
        assert_eq!(r["rows"][0][0], json!("1"));
        assert_eq!(r["rows"][0][1], Value::Null);
        assert_eq!(r["rows"][0][2], json!("你好"));
        assert_eq!(r["rows"][0][3], json!("9007199254740993"), "大整数应字符串化保精度");

        // DML 全链路：建临时表 → 插入 → 查回 → 删除
        do_query(&mut conn, "DROP TABLE IF EXISTS _db_tool_test").unwrap();
        do_query(&mut conn, "CREATE TABLE _db_tool_test (id INT PRIMARY KEY AUTO_INCREMENT, name VARCHAR(50))").unwrap();
        let ins = do_query(&mut conn, "INSERT INTO _db_tool_test (name) VALUES ('a'), ('b')").unwrap();
        assert_eq!(ins["affected"], 2);
        let q = do_query(&mut conn, "SELECT id, name FROM _db_tool_test ORDER BY id").unwrap();
        assert_eq!(q["rowCount"], 2);
        assert_eq!(q["rows"][1][1], json!("b"));
        // 列类型：id → number，name → text
        assert_eq!(
            q["colTypes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| c.as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["number", "text"]
        );

        // 元数据：表清单包含临时表，表结构 id 为主键
        let t = do_tables(&mut conn).unwrap();
        assert!(t
            .as_array()
            .unwrap()
            .iter()
            .any(|x| x["name"] == json!("_db_tool_test")));
        let c = do_columns(&mut conn, "_db_tool_test").unwrap();
        let id = c
            .as_array()
            .unwrap()
            .iter()
            .find(|x| x["name"] == json!("id"))
            .unwrap();
        assert_eq!(id["pk"], true, "MySQL 主键标记应生效");
        do_query(&mut conn, "DROP TABLE _db_tool_test").unwrap();
    }

    // ---------- 一键安装包解压 ----------

    /// 构造内存 zip：entries 为 (路径, 内容)；以 "/" 结尾视为目录
    fn make_zip(entries: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write;
        use zip::write::SimpleFileOptions;
        let mut buf = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut buf));
            for (name, content) in entries {
                if name.ends_with('/') {
                    w.add_directory(*name, SimpleFileOptions::default()).unwrap();
                } else {
                    w.start_file(*name, SimpleFileOptions::default()).unwrap();
                    w.write_all(content.as_bytes()).unwrap();
                }
            }
            w.finish().unwrap();
        }
        buf
    }

    #[test]
    fn extract_zip_rejects_path_traversal() {
        let dir = std::env::temp_dir().join("db-driver-extract-traversal");
        let _ = std::fs::remove_dir_all(&dir);
        // ../ 与绝对路径条目都必须被拒绝
        let evil = make_zip(&[("../evil.txt", "x")]);
        assert!(extract_driver_zip(&evil, &dir).is_err());
        let abs = make_zip(&[("/tmp/evil.txt", "x")]);
        assert!(extract_driver_zip(&abs, &dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_zip_ok_and_find_odbc_install() {
        let dir = std::env::temp_dir().join("db-driver-extract-ok");
        let _ = std::fs::remove_dir_all(&dir);
        let pkg = make_zip(&[
            ("ic/", ""),
            ("ic/odbc_install.exe", "MZ fake"),
            ("ic/oraocci19.dll", "dll"),
        ]);
        extract_driver_zip(&pkg, &dir).expect("正常包应解压成功");
        let exe = find_odbc_install(&dir).expect("应找到 odbc_install.exe");
        assert_eq!(exe.file_name().unwrap().to_str().unwrap(), "odbc_install.exe");
        assert!(dir.join("ic/oraocci19.dll").exists(), "普通文件应解压到子目录");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 非 zip 内容应报「不是有效的 zip」
    #[test]
    fn extract_zip_rejects_garbage() {
        let dir = std::env::temp_dir().join("db-driver-extract-garbage");
        let _ = std::fs::remove_dir_all(&dir);
        let err = extract_driver_zip(b"not a zip", &dir).unwrap_err();
        assert!(err.contains("不是有效的 zip"), "实际错误：{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// 测试数据库连接（建立后立即断开），返回耗时；失败返回 Err。
#[tauri::command]
pub fn db_test(opts: serde_json::Value) -> Result<serde_json::Value, String> {
    test(&opts)
}

/// 建立数据库连接，返回连接 id（后续 db_query/db_close 使用）
#[tauri::command]
pub fn db_connect(opts: serde_json::Value) -> Result<String, String> {
    connect(&opts)
}

/// 在已建立的连接上执行 SQL，返回 { columns, colTypes, rows, rowCount, affected, truncated, durationMs }
#[tauri::command]
pub fn db_query(conn_id: String, sql: String) -> Result<serde_json::Value, String> {
    query(&conn_id, &sql)
}

pub const ORACLE_DRIVER_MAX_BYTES: usize = 200 * 1024 * 1024;

pub fn trusted_driver_url(url: &reqwest::Url) -> bool {
    if url.scheme() == "https" {
        return true;
    }
    url.scheme() == "http"
        && matches!(url.host_str(), Some("localhost") | Some("127.0.0.1") | Some("::1"))
}

/// 下载 Oracle ODBC 驱动，校验传输协议、大小与 SHA-256 后才解压并提权注册。
#[tauri::command]
pub async fn db_install_oracle_driver(app: tauri::AppHandle, url: String, sha256: String) -> Result<String, String> {
    let url = reqwest::Url::parse(url.trim()).map_err(|e| format!("驱动地址无效：{e}"))?;
    if !trusted_driver_url(&url) {
        return Err("驱动地址必须使用 HTTPS；仅本机开发地址允许 HTTP".to_string());
    }
    let expected = sha256.trim().to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("请填写发布方提供的 64 位 SHA-256 校验值".to_string());
    }
    if url.as_str().is_empty() {
        return Err("请填写驱动安装包地址".to_string());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("创建下载客户端失败：{e}"))?;
    let resp = client.get(url.clone()).send().await.map_err(|e| format!("下载失败：{e}"))?;
    if !trusted_driver_url(resp.url()) {
        return Err("驱动下载重定向到了不可信地址，已拒绝继续".to_string());
    }
    let status = resp.status();
    if !status.is_success() {
        return Err(format!("下载失败：HTTP {status}"));
    }
    if resp.content_length().unwrap_or(0) > ORACLE_DRIVER_MAX_BYTES as u64 {
        return Err("驱动安装包超过 200 MB 限制".to_string());
    }
    let mut resp = resp;
    let mut bytes = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| format!("读取下载内容失败：{e}"))? {
        if bytes.len().saturating_add(chunk.len()) > ORACLE_DRIVER_MAX_BYTES {
            return Err("驱动安装包超过 200 MB 限制".to_string());
        }
        bytes.extend_from_slice(&chunk);
    }
    use sha2::{Digest, Sha256};
    let actual = format!("{:x}", Sha256::digest(&bytes));
    if actual != expected {
        return Err(format!("驱动包 SHA-256 校验失败：期望 {expected}，实际 {actual}"));
    }
    tauri::async_runtime::spawn_blocking(move || install_from_zip(&bytes, &dir))
        .await
        .map_err(|e| format!("安装任务异常：{e}"))?
}

/// 列出连接下的表/视图清单：[{ name, kind }]（kind: table / view）
#[tauri::command]
pub fn db_tables(conn_id: String) -> Result<serde_json::Value, String> {
    tables(&conn_id)
}

/// 列出表的列结构：[{ name, type, nullable, pk, comment }]
#[tauri::command]
pub fn db_columns(conn_id: String, table: String) -> Result<serde_json::Value, String> {
    columns(&conn_id, &table)
}

/// 列出表的索引：[{ name, unique, columns, def?, comment? }]（按索引名分组）
#[tauri::command]
pub fn db_indexes(conn_id: String, table: String) -> Result<serde_json::Value, String> {
    indexes(&conn_id, &table)
}

/// 获取表的建表 DDL 文本（PostgreSQL 为按元数据还原的重建语句）
#[tauri::command]
pub fn db_ddl(conn_id: String, table: String) -> Result<serde_json::Value, String> {
    ddl(&conn_id, &table)
}
/// 关闭数据库连接（幂等，连接不存在也返回成功）
#[tauri::command]
pub fn db_close(conn_id: String) -> Result<(), String> {
    close(&conn_id)
}

/// 枚举本机已安装的 ODBC 驱动（供 Oracle 连接选择驱动）
#[tauri::command]
pub fn db_drivers() -> Result<Vec<String>, String> {
    list_drivers()
}
