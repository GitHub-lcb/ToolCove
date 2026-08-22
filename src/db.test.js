import { describe, it, expect } from "vitest";
import {
  DB_TYPES,
  defaultConn,
  validateConn,
  connLabel,
  isOracleDriver,
  driverInstallUrl, isTrustedDriverUrl, isSha256, isReadOnlySql,
  dialectHint,
  sanitizeForSave,
  hydrateConn,
  pushHistory,
  toMarkdownTable,
  quoteIdent,
  quoteStr,
  sqlLiteral,
  genUpdateSQL,
  genInsertSQL,
  genDeleteSQL,
  genDeleteByRowSQL,
  extractTable,
  toCSV,
  toJSONExport,
  pushFav,
  favLabel,
} from "./db.js";

describe("DB_TYPES", () => {
  it("包含四种数据库且默认端口齐全", () => {
    expect(DB_TYPES.map((t) => t.type)).toEqual(["mysql", "postgres", "sqlite", "oracle"]);
    expect(DB_TYPES.find((t) => t.type === "mysql").defaultPort).toBe(3306);
    expect(DB_TYPES.find((t) => t.type === "oracle").defaultPort).toBe(1521);
  });
});

describe("defaultConn", () => {
  it("mysql 默认端口 3306、默认主机 localhost", () => {
    const c = defaultConn("mysql");
    expect(c.type).toBe("mysql");
    expect(c.host).toBe("localhost");
    expect(c.port).toBe(3306);
    expect(c.rememberPwd).toBe(true);
  });

  it("各类型默认端口正确", () => {
    expect(defaultConn("postgres").port).toBe(5432);
    expect(defaultConn("oracle").port).toBe(1521);
    expect(defaultConn("sqlite").port).toBe("");
  });

  it("缺省类型回退 mysql", () => {
    expect(defaultConn().type).toBe("mysql");
  });
});

describe("isOracleDriver", () => {
  it("按名称含 oracle 判断（忽略大小写）", () => {
    expect(isOracleDriver("Oracle ODBC Driver")).toBe(true);
    expect(isOracleDriver("oracle in instantclient_19_16")).toBe(true);
    expect(isOracleDriver("Easysoft ODBC-Oracle")).toBe(true);
    expect(isOracleDriver("SQL Server")).toBe(false);
    expect(isOracleDriver("ODBC Driver 17 for SQL Server")).toBe(false);
    expect(isOracleDriver("")).toBe(false);
    expect(isOracleDriver(null)).toBe(false);
  });
});

describe("driverInstallUrl", () => {
  it("固定返回 GitHub Release 驱动包地址", () => {
    expect(driverInstallUrl()).toBe(
      "https://github.com/GitHub-lcb/ToolCove/releases/download/drivers/oracle-driver.zip"
    );
  });
});

describe("dialectHint", () => {
  it("四种库各有专属方言要点", () => {
    expect(dialectHint("mysql")).toContain("反引号");
    expect(dialectHint("mysql")).toContain("LIMIT");
    expect(dialectHint("postgres")).toContain("::type");
    expect(dialectHint("sqlite")).toContain("AUTOINCREMENT");
    expect(dialectHint("oracle")).toContain("FETCH FIRST");
    expect(dialectHint("oracle")).not.toContain("LIMIT n OFFSET");
  });
  it("未知类型回退标准 SQL", () => {
    expect(dialectHint("db2")).toBe("标准 SQL 语法");
    expect(dialectHint("")).toBe("标准 SQL 语法");
    expect(dialectHint(null)).toBe("标准 SQL 语法");
  });
});

describe("validateConn", () => {
  it("mysql 缺主机/端口/用户/库时逐项报错", () => {
    const errors = validateConn({ type: "mysql", host: "", port: 0, user: "", database: "" });
    expect(errors).toContain("请填写主机地址");
    expect(errors).toContain("请填写端口");
    expect(errors).toContain("请填写用户名");
    expect(errors).toContain("请填写数据库名");
  });

  it("mysql 参数齐全时通过", () => {
    expect(
      validateConn({ type: "mysql", host: "localhost", port: 3306, user: "root", database: "demo" })
    ).toEqual([]);
  });

  it("sqlite 只需文件路径", () => {
    expect(validateConn({ type: "sqlite", database: "C:/a.db" })).toEqual([]);
    expect(validateConn({ type: "sqlite", database: "  " })).toEqual(["请选择 SQLite 数据库文件"]);
  });

  it("oracle 额外要求服务名与驱动", () => {
    const base = { type: "oracle", host: "h", port: 1521, user: "u", database: "d" };
    expect(validateConn(base)).toEqual([
      "请填写 Oracle 服务名（Service Name）",
      "请选择 Oracle ODBC 驱动",
    ]);
    expect(
      validateConn({ ...base, oracleService: "ORCL", oracleDriver: "Oracle ODBC Driver" })
    ).toEqual([]);
  });

  it("oracle 拒绝非 Oracle 驱动（如 SQL Server，会报无 DSN/SERVER）", () => {
    const base = { type: "oracle", host: "h", port: 1521, user: "u", database: "d", oracleService: "ORCL" };
    expect(validateConn({ ...base, oracleDriver: "SQL Server" })).toEqual([
      "「SQL Server」不是 Oracle ODBC 驱动，请选择 Oracle 相关驱动",
    ]);
    expect(validateConn({ ...base, oracleDriver: "ODBC Driver 17 for SQL Server" })).not.toEqual([]);
    // 常见 Oracle 驱动名（忽略大小写）均通过
    expect(validateConn({ ...base, oracleDriver: "oracle in instantclient_19_16" })).toEqual([]);
    expect(validateConn({ ...base, oracleDriver: "Oracle in instantclient_21_3" })).toEqual([]);
  });

  it("无类型直接报错", () => {
    expect(validateConn({})).toEqual(["请选择数据库类型"]);
  });
});

describe("connLabel", () => {
  it("自定义名优先", () => {
    expect(connLabel({ name: "测试库", host: "h", port: 1, database: "d" })).toBe("测试库");
  });

  it("默认展示 主机:端口/库", () => {
    expect(connLabel({ type: "mysql", host: "10.0.0.1", port: 3306, database: "demo_db" })).toBe(
      "10.0.0.1:3306/demo_db"
    );
  });

  it("sqlite 展示文件路径", () => {
    expect(connLabel({ type: "sqlite", database: "C:/data/app.db" })).toBe("C:/data/app.db");
  });

  it("空对象兜底", () => {
    expect(connLabel(null)).toBeTruthy();
  });
});

describe("sanitizeForSave / hydrateConn", () => {
  it("未记住密码时不保存密码，加载后密码为空", () => {
    const conn = defaultConn("mysql");
    conn.rememberPwd = false;
    conn.password = "secret";
    const saved = sanitizeForSave(conn);
    expect(saved.password).toBe("");
    expect(hydrateConn(saved).password).toBe("");
  });

  it("记住密码时密码保留", () => {
    const conn = defaultConn("mysql");
    conn.password = "secret";
    expect(sanitizeForSave(conn).password).toBe("secret");
    expect(hydrateConn(conn).password).toBe("secret");
  });

  it("加载旧配置自动补全默认字段", () => {
    const h = hydrateConn({ type: "postgres", host: "h" });
    expect(h.port).toBe(5432);
    expect(h.user).toBe("root");
  });

  it("hydrateConn 不改动原对象", () => {
    const raw = { type: "mysql", host: "h" };
    hydrateConn(raw);
    expect(raw).toEqual({ type: "mysql", host: "h" });
  });
});

describe("pushHistory", () => {
  it("去重置顶：重复语句移到最前", () => {
    const h1 = pushHistory([], "select 1");
    const h2 = pushHistory(h1, "select 2");
    const h3 = pushHistory(h2, "select 1");
    expect(h3.map((x) => x.sql)).toEqual(["select 1", "select 2"]);
  });

  it("空语句不记录", () => {
    expect(pushHistory([{ sql: "a", ts: 1 }], "   ").length).toBe(1);
  });

  it("按最大条数裁剪", () => {
    let list = [];
    for (let i = 0; i < 25; i++) list = pushHistory(list, `sql-${i}`, 10);
    expect(list.length).toBe(10);
    expect(list[0].sql).toBe("sql-24");
  });

  it("非数组入参视为空历史", () => {
    expect(pushHistory(null, "x").length).toBe(1);
  });
});

describe("toMarkdownTable", () => {
  it("生成带标题行的 Markdown 表格", () => {
    const md = toMarkdownTable(
      ["id", "name", "score"],
      [["1", "张三", "95"], ["2", "李四", "88"]]
    );
    expect(md).toBe(
      "| id | name | score |\n| --- | --- | --- |\n| 1 | 张三 | 95 |\n| 2 | 李四 | 88 |"
    );
  });

  it("null 单元格输出 NULL 文本", () => {
    const md = toMarkdownTable(["a", "b"], [[null, "x"]]);
    expect(md).toContain("| NULL | x |");
  });

  it("单元格内的竖线与换行转义/压平，不破坏表格结构", () => {
    const md = toMarkdownTable(["a"], [["v|v\nline"]]);
    expect(md).toBe("| a |\n| --- |\n| v\\|v line |");
  });

  it("空列名返回空字符串", () => {
    expect(toMarkdownTable([], [[1]])).toBe("");
  });

  it("无数据行时仅输出表头与分隔行", () => {
    expect(toMarkdownTable(["a"], [])).toBe("| a |\n| --- |");
  });
});

describe("quoteIdent / quoteStr / sqlLiteral", () => {
  it("mysql 标识符反引号包裹，内部反引号双写", () => {
    expect(quoteIdent("user", "mysql")).toBe("`user`");
    expect(quoteIdent("we`ird", "mysql")).toBe("`we``ird`");
  });

  it("其他库标识符双引号包裹，内部双引号双写", () => {
    expect(quoteIdent("user", "postgres")).toBe('"user"');
    expect(quoteIdent('a"b', "sqlite")).toBe('"a""b"');
  });

  it("字符串字面量单引号包裹并转义", () => {
    expect(quoteStr("O'Brien")).toBe("'O''Brien'");
    expect(quoteStr("123")).toBe("'123'");
  });

  it("null/undefined → NULL", () => {
    expect(sqlLiteral(null, "text")).toBe("NULL");
    expect(sqlLiteral(undefined, "number")).toBe("NULL");
  });

  it("number 列数字原样输出，空串视为 NULL，非数字回退字符串", () => {
    expect(sqlLiteral("9007199254740993", "number")).toBe("9007199254740993");
    expect(sqlLiteral("", "number")).toBe("NULL");
    expect(sqlLiteral("abc", "number")).toBe("'abc'");
  });

  it("text 列一律加引号", () => {
    expect(sqlLiteral("hello", "text")).toBe("'hello'");
    expect(sqlLiteral("3", "text")).toBe("'3'");
  });
});

describe("genUpdateSQL", () => {
  const cols = ["id", "name", "score"];
  const colTypes = ["number", "text", "number"];

  it("按主键定位生成 UPDATE，仅更新改动列", () => {
    const sql = genUpdateSQL("users", cols, ["1", "张三", "95"], [1], colTypes, "mysql", ["id"]);
    expect(sql).toBe("UPDATE `users` SET `name` = '张三' WHERE `id` = 1");
  });

  it("无主键返回 null（拒绝危险的全表更新）", () => {
    expect(genUpdateSQL("users", cols, ["1", "张三", "95"], [1], colTypes, "mysql", [])).toBeNull();
  });

  it("主键列不允许出现在 SET 中", () => {
    const sql = genUpdateSQL("users", cols, ["1", "张三", "95"], [0, 1], colTypes, "mysql", ["id"]);
    expect(sql).toContain("SET `name` = '张三'");
    expect(sql).not.toContain("SET `id`");
  });

  it("复合主键生成 AND 条件", () => {
    const sql = genUpdateSQL(
      "t",
      ["a", "b", "v"],
      ["1", "2", "x"],
      [2],
      ["number", "number", "text"],
      "postgres",
      ["a", "b"]
    );
    expect(sql).toBe('UPDATE "t" SET "v" = \'x\' WHERE "a" = 1 AND "b" = 2');
  });

  it("无有效改动列返回 null", () => {
    expect(genUpdateSQL("users", cols, ["1", "张三", "95"], [], colTypes, "mysql", ["id"])).toBeNull();
  });
});

describe("genInsertSQL / genDeleteSQL", () => {
  const cols = ["id", "name"];
  const colTypes = ["number", "text"];

  it("生成整行 INSERT", () => {
    const sql = genInsertSQL("t", cols, ["5", "王五"], colTypes, "mysql");
    expect(sql).toBe("INSERT INTO `t` (`id`, `name`) VALUES (5, '王五')");
  });

  it("生成主键定位 DELETE", () => {
    const sql = genDeleteSQL("t", cols, ["5", "王五"], colTypes, "mysql", ["id"]);
    expect(sql).toBe("DELETE FROM `t` WHERE `id` = 5");
  });

  it("DELETE 无主键返回 null", () => {
    expect(genDeleteSQL("t", cols, ["5", "王五"], colTypes, "mysql", [])).toBeNull();
  });
});

describe("extractTable", () => {
  it("提取 FROM 表名（mysql 反引号）", () => {
    expect(extractTable("SELECT * FROM `users` WHERE id = 1")).toBe("users");
  });

  it("schema.table 只取表名", () => {
    expect(extractTable('SELECT a FROM "public"."orders"')).toBe("orders");
  });

  it("无 FROM 返回 null", () => {
    expect(extractTable("SELECT 1")).toBeNull();
  });
});

describe("toCSV / toJSONExport", () => {
  it("CSV 带 BOM 与列名，NULL 输出空串", () => {
    const csv = toCSV(["id", "name"], [["1", "张三"], ["2", null]]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.replace("\uFEFF", "")).toBe("id,name\r\n1,张三\r\n2,");
  });

  it("CSV 含逗号/引号/换行的值加引号转义", () => {
    const csv = toCSV(["a"], [[`x,"y"`], ["l1\nl2"]]);
    expect(csv.replace("\uFEFF", "")).toBe('a\r\n"x,""y"""\r\n"l1\nl2"');
  });

  it("JSON 导出为对象数组（列名作键）", () => {
    expect(toJSONExport(["id", "name"], [["1", "张三"], ["2", null]])).toEqual([
      { id: "1", name: "张三" },
      { id: "2", name: null },
    ]);
  });

  it("空结果集返回空数组", () => {
    expect(toJSONExport(["a"], [])).toEqual([]);
  });
});

describe("pushFav / favLabel", () => {
  it("按 SQL 去重置顶并保留自定义名", () => {
    let favs = pushFav([], { sql: "select 1", name: "查数量" });
    favs = pushFav(favs, { sql: "select 2" });
    favs = pushFav(favs, { sql: "select 1", name: "查数量" });
    expect(favs.length).toBe(2);
    expect(favs[0].sql).toBe("select 1");
    expect(favs[0].name).toBe("查数量");
  });

  it("空语句不收藏", () => {
    expect(pushFav([{ sql: "a" }], { sql: "  " }).length).toBe(1);
  });

  it("favLabel：有名字用名字，无名字取 SQL 首行截断", () => {
    expect(favLabel({ name: "常用", sql: "x" })).toBe("常用");
    const long = "s".repeat(60);
    expect(favLabel({ sql: long })).toBe("s".repeat(40) + "…");
  });
});

describe("genDeleteByRowSQL", () => {
  it("无主键时按整行全列条件生成 DELETE", () => {
    const sql = genDeleteByRowSQL("t", ["a", "b", "c"], [1, "x", null], ["number", "string", "string"], "mysql");
    expect(sql).toBe("DELETE FROM `t` WHERE `a` = 1 AND `b` = 'x' AND `c` IS NULL");
  });
  it("空行返回 null", () => {
    expect(genDeleteByRowSQL("t", [], [], [], "mysql")).toBeNull();
  });
});

describe("驱动包可信校验", () => {
  it("固定 GitHub HTTPS 地址恒可信", () => {
    expect(isTrustedDriverUrl()).toBe(true);
  });
  it("SHA-256 必须是 64 位十六进制", () => {
    expect(isSha256("a".repeat(64))).toBe(true);
    expect(isSha256("g".repeat(64))).toBe(false);
    expect(isSha256("a".repeat(63))).toBe(false);
  });
});

describe("isReadOnlySql", () => {
  it("识别常见只读语句和注释", () => {
    expect(isReadOnlySql("SELECT * FROM t")).toBe(true);
    expect(isReadOnlySql("-- note\nSHOW TABLES")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
  });
  it("写语句及带写 CTE 一律要求确认", () => {
    expect(isReadOnlySql("UPDATE t SET n = 1")).toBe(false);
    expect(isReadOnlySql("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x")).toBe(false);
    expect(isReadOnlySql("CREATE TABLE t (id INT)")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR UPDATE")).toBe(false);
    expect(isReadOnlySql("SELECT * INTO archived FROM t")).toBe(false);
    expect(isReadOnlySql("SELECT 1; /*!50000 DELETE FROM t */")).toBe(false);
  });
  it("字符串中的写关键词不造成误判", () => {
    expect(isReadOnlySql("SELECT 'delete from t' AS sample")).toBe(true);
  });
});
