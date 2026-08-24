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
import { i18n } from "./i18n/index.js";

describe("DB_TYPES", () => {
  it("contains four database types with default ports", () => {
    expect(DB_TYPES.map((t) => t.type)).toEqual(["mysql", "postgres", "sqlite", "oracle"]);
    expect(DB_TYPES.find((t) => t.type === "mysql").defaultPort).toBe(3306);
    expect(DB_TYPES.find((t) => t.type === "oracle").defaultPort).toBe(1521);
  });
});

describe("defaultConn", () => {
  it("mysql defaults to port 3306 and host localhost", () => {
    const c = defaultConn("mysql");
    expect(c.type).toBe("mysql");
    expect(c.host).toBe("localhost");
    expect(c.port).toBe(3306);
    expect(c.rememberPwd).toBe(true);
  });

  it("uses the correct default port per type", () => {
    expect(defaultConn("postgres").port).toBe(5432);
    expect(defaultConn("oracle").port).toBe(1521);
    expect(defaultConn("sqlite").port).toBe("");
  });

  it("falls back to mysql for missing type", () => {
    expect(defaultConn().type).toBe("mysql");
  });
});

describe("isOracleDriver", () => {
  it("detects oracle by name, ignoring case", () => {
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
  it("returns the fixed GitHub Release driver URL", () => {
    expect(driverInstallUrl()).toBe(
      "https://github.com/GitHub-lcb/ToolCove/releases/download/drivers/oracle-driver.zip"
    );
  });
});

describe("dialectHint", () => {
  it("gives each database its own dialect hints", () => {
    expect(dialectHint("mysql")).toBe(i18n.global.t("prompt.dbDialectMysql"));
    expect(dialectHint("mysql")).toContain("LIMIT");
    expect(dialectHint("postgres")).toContain("::type");
    expect(dialectHint("sqlite")).toContain("AUTOINCREMENT");
    expect(dialectHint("oracle")).toContain("FETCH FIRST");
    expect(dialectHint("oracle")).not.toContain("LIMIT n OFFSET");
  });
  it("falls back to standard SQL for unknown types", () => {
    expect(dialectHint("db2")).toBe(i18n.global.t("prompt.dbDialectFallback"));
    expect(dialectHint("")).toBe(i18n.global.t("prompt.dbDialectFallback"));
    expect(dialectHint(null)).toBe(i18n.global.t("prompt.dbDialectFallback"));
  });
});

describe("validateConn", () => {
  it("reports each missing mysql field in turn", () => {
    const errors = validateConn({ type: "mysql", host: "", port: 0, user: "", database: "" });
    expect(errors).toContain(i18n.global.t("toolbox.db.errNeedHost"));
    expect(errors).toContain(i18n.global.t("toolbox.db.errNeedPort"));
    expect(errors).toContain(i18n.global.t("toolbox.db.errNeedUser"));
    expect(errors).toContain(i18n.global.t("toolbox.db.errNeedDb"));
  });

  it("passes when mysql params are complete", () => {
    expect(
      validateConn({ type: "mysql", host: "localhost", port: 3306, user: "root", database: "demo" })
    ).toEqual([]);
  });

  it("sqlite only needs a file path", () => {
    expect(validateConn({ type: "sqlite", database: "C:/a.db" })).toEqual([]);
    expect(validateConn({ type: "sqlite", database: "  " })).toEqual([i18n.global.t("toolbox.db.errNeedSqliteFile")]);
  });

  it("oracle additionally requires service name and driver", () => {
    const base = { type: "oracle", host: "h", port: 1521, user: "u", database: "d" };
    expect(validateConn(base)).toEqual([
      i18n.global.t("toolbox.db.errNeedOracleService"),
      i18n.global.t("toolbox.db.errNeedOracleDriver"),
    ]);
    expect(
      validateConn({ ...base, oracleService: "ORCL", oracleDriver: "Oracle ODBC Driver" })
    ).toEqual([]);
  });

  it("oracle rejects non-oracle drivers like SQL Server", () => {
    const base = { type: "oracle", host: "h", port: 1521, user: "u", database: "d", oracleService: "ORCL" };
    expect(validateConn({ ...base, oracleDriver: "SQL Server" })).toEqual([
      i18n.global.t("toolbox.db.errBadOracleDriver", { driver: "SQL Server" }),
    ]);
    expect(validateConn({ ...base, oracleDriver: "ODBC Driver 17 for SQL Server" })).not.toEqual([]);
    // common oracle driver names (case-insensitive) all pass
    expect(validateConn({ ...base, oracleDriver: "oracle in instantclient_19_16" })).toEqual([]);
    expect(validateConn({ ...base, oracleDriver: "Oracle in instantclient_21_3" })).toEqual([]);
  });

  it("errors immediately when type is missing", () => {
    expect(validateConn({})).toEqual([i18n.global.t("toolbox.db.errNeedType")]);
  });
});

describe("connLabel", () => {
  it("prefers the custom name", () => {
    expect(connLabel({ name: "Test DB", host: "h", port: 1, database: "d" })).toBe("Test DB");
  });

  it("shows host:port/db by default", () => {
    expect(connLabel({ type: "mysql", host: "10.0.0.1", port: 3306, database: "demo_db" })).toBe(
      "10.0.0.1:3306/demo_db"
    );
  });

  it("sqlite shows the file path", () => {
    expect(connLabel({ type: "sqlite", database: "C:/data/app.db" })).toBe("C:/data/app.db");
  });

  it("falls back gracefully for null objects", () => {
    expect(connLabel(null)).toBeTruthy();
  });
});

describe("sanitizeForSave / hydrateConn", () => {
  it("drops the password when not remembered", () => {
    const conn = defaultConn("mysql");
    conn.rememberPwd = false;
    conn.password = "secret";
    const saved = sanitizeForSave(conn);
    expect(saved.password).toBe("");
    expect(hydrateConn(saved).password).toBe("");
  });

  it("keeps the password when remembered", () => {
    const conn = defaultConn("mysql");
    conn.password = "secret";
    expect(sanitizeForSave(conn).password).toBe("secret");
    expect(hydrateConn(conn).password).toBe("secret");
  });

  it("hydrates defaults for legacy configs", () => {
    const h = hydrateConn({ type: "postgres", host: "h" });
    expect(h.port).toBe(5432);
    expect(h.user).toBe("root");
  });

  it("does not mutate the original object", () => {
    const raw = { type: "mysql", host: "h" };
    hydrateConn(raw);
    expect(raw).toEqual({ type: "mysql", host: "h" });
  });
});

describe("pushHistory", () => {
  it("dedupes by moving repeated statements to the top", () => {
    const h1 = pushHistory([], "select 1");
    const h2 = pushHistory(h1, "select 2");
    const h3 = pushHistory(h2, "select 1");
    expect(h3.map((x) => x.sql)).toEqual(["select 1", "select 2"]);
  });

  it("ignores blank statements", () => {
    expect(pushHistory([{ sql: "a", ts: 1 }], "   ").length).toBe(1);
  });

  it("trims to the max size", () => {
    let list = [];
    for (let i = 0; i < 25; i++) list = pushHistory(list, `sql-${i}`, 10);
    expect(list.length).toBe(10);
    expect(list[0].sql).toBe("sql-24");
  });

  it("treats non-array input as empty history", () => {
    expect(pushHistory(null, "x").length).toBe(1);
  });
});

describe("toMarkdownTable", () => {
  it("renders a markdown table with a header row", () => {
    const md = toMarkdownTable(
      ["id", "name", "score"],
      [["1", "Alice", "95"], ["2", "Bob", "88"]]
    );
    expect(md).toBe(
      "| id | name | score |\n| --- | --- | --- |\n| 1 | Alice | 95 |\n| 2 | Bob | 88 |"
    );
  });

  it("renders null cells as NULL", () => {
    const md = toMarkdownTable(["a", "b"], [[null, "x"]]);
    expect(md).toContain("| NULL | x |");
  });

  it("escapes pipes and flattens newlines inside cells", () => {
    const md = toMarkdownTable(["a"], [["v|v\nline"]]);
    expect(md).toBe("| a |\n| --- |\n| v\\|v line |");
  });

  it("returns empty string for empty columns", () => {
    expect(toMarkdownTable([], [[1]])).toBe("");
  });

  it("outputs only header and separator for empty rows", () => {
    expect(toMarkdownTable(["a"], [])).toBe("| a |\n| --- |");
  });
});

describe("quoteIdent / quoteStr / sqlLiteral", () => {
  it("wraps mysql identifiers in backticks, doubling inner backticks", () => {
    expect(quoteIdent("user", "mysql")).toBe("`user`");
    expect(quoteIdent("we`ird", "mysql")).toBe("`we``ird`");
  });

  it("wraps other identifiers in double quotes, doubling inner quotes", () => {
    expect(quoteIdent("user", "postgres")).toBe('"user"');
    expect(quoteIdent('a"b', "sqlite")).toBe('"a""b"');
  });

  it("wraps string literals in single quotes and escapes them", () => {
    expect(quoteStr("O'Brien")).toBe("'O''Brien'");
    expect(quoteStr("123")).toBe("'123'");
  });

  it("turns null/undefined into NULL", () => {
    expect(sqlLiteral(null, "text")).toBe("NULL");
    expect(sqlLiteral(undefined, "number")).toBe("NULL");
  });

  it("outputs digits for number columns, NULL for blank, string otherwise", () => {
    expect(sqlLiteral("9007199254740993", "number")).toBe("9007199254740993");
    expect(sqlLiteral("", "number")).toBe("NULL");
    expect(sqlLiteral("abc", "number")).toBe("'abc'");
  });

  it("always quotes text columns", () => {
    expect(sqlLiteral("hello", "text")).toBe("'hello'");
    expect(sqlLiteral("3", "text")).toBe("'3'");
  });
});

describe("genUpdateSQL", () => {
  const cols = ["id", "name", "score"];
  const colTypes = ["number", "text", "number"];

  it("builds UPDATE by primary key, only changed columns", () => {
    const sql = genUpdateSQL("users", cols, ["1", "Alice", "95"], [1], colTypes, "mysql", ["id"]);
    expect(sql).toBe("UPDATE `users` SET `name` = 'Alice' WHERE `id` = 1");
  });

  it("returns null without a primary key", () => {
    expect(genUpdateSQL("users", cols, ["1", "Alice", "95"], [1], colTypes, "mysql", [])).toBeNull();
  });

  it("keeps primary key columns out of SET", () => {
    const sql = genUpdateSQL("users", cols, ["1", "Alice", "95"], [0, 1], colTypes, "mysql", ["id"]);
    expect(sql).toContain("SET `name` = 'Alice'");
    expect(sql).not.toContain("SET `id`");
  });

  it("builds AND conditions for composite primary keys", () => {
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

  it("returns null when no columns actually change", () => {
    expect(genUpdateSQL("users", cols, ["1", "Alice", "95"], [], colTypes, "mysql", ["id"])).toBeNull();
  });
});

describe("genInsertSQL / genDeleteSQL", () => {
  const cols = ["id", "name"];
  const colTypes = ["number", "text"];

  it("generates a full-row INSERT", () => {
    const sql = genInsertSQL("t", cols, ["5", "Eve"], colTypes, "mysql");
    expect(sql).toBe("INSERT INTO `t` (`id`, `name`) VALUES (5, 'Eve')");
  });

  it("generates a DELETE located by primary key", () => {
    const sql = genDeleteSQL("t", cols, ["5", "Eve"], colTypes, "mysql", ["id"]);
    expect(sql).toBe("DELETE FROM `t` WHERE `id` = 5");
  });

  it("returns null for DELETE without primary key", () => {
    expect(genDeleteSQL("t", cols, ["5", "Eve"], colTypes, "mysql", [])).toBeNull();
  });
});

describe("extractTable", () => {
  it("extracts the FROM table name (mysql backticks)", () => {
    expect(extractTable("SELECT * FROM `users` WHERE id = 1")).toBe("users");
  });

  it("keeps only the table name for schema.table", () => {
    expect(extractTable('SELECT a FROM "public"."orders"')).toBe("orders");
  });

  it("returns null without FROM", () => {
    expect(extractTable("SELECT 1")).toBeNull();
  });
});

describe("toCSV / toJSONExport", () => {
  it("writes BOM and header, NULL becomes empty", () => {
    const csv = toCSV(["id", "name"], [["1", "Alice"], ["2", null]]);
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv.replace("\uFEFF", "")).toBe("id,name\r\n1,Alice\r\n2,");
  });

  it("quotes CSV values containing commas/quotes/newlines", () => {
    const csv = toCSV(["a"], [[`x,"y"`], ["l1\nl2"]]);
    expect(csv.replace("\uFEFF", "")).toBe('a\r\n"x,""y"""\r\n"l1\nl2"');
  });

  it("exports JSON as an object array keyed by columns", () => {
    expect(toJSONExport(["id", "name"], [["1", "Alice"], ["2", null]])).toEqual([
      { id: "1", name: "Alice" },
      { id: "2", name: null },
    ]);
  });

  it("returns an empty array for empty results", () => {
    expect(toJSONExport(["a"], [])).toEqual([]);
  });
});

describe("pushFav / favLabel", () => {
  it("dedupes by SQL and keeps the custom name", () => {
    let favs = pushFav([], { sql: "select 1", name: "count" });
    favs = pushFav(favs, { sql: "select 2" });
    favs = pushFav(favs, { sql: "select 1", name: "count" });
    expect(favs.length).toBe(2);
    expect(favs[0].sql).toBe("select 1");
    expect(favs[0].name).toBe("count");
  });

  it("does not favorite blank statements", () => {
    expect(pushFav([{ sql: "a" }], { sql: "  " }).length).toBe(1);
  });

  it("favLabel uses the name or a truncated first line", () => {
    expect(favLabel({ name: "favorite", sql: "x" })).toBe("favorite");
    const long = "s".repeat(60);
    expect(favLabel({ sql: long })).toBe("s".repeat(40) + "…");
  });
});

describe("genDeleteByRowSQL", () => {
  it("builds DELETE on all columns when no primary key", () => {
    const sql = genDeleteByRowSQL("t", ["a", "b", "c"], [1, "x", null], ["number", "string", "string"], "mysql");
    expect(sql).toBe("DELETE FROM `t` WHERE `a` = 1 AND `b` = 'x' AND `c` IS NULL");
  });
  it("returns null for an empty row", () => {
    expect(genDeleteByRowSQL("t", [], [], [], "mysql")).toBeNull();
  });
});

describe("driver URL trust checks", () => {
  it("always trusts the fixed GitHub HTTPS URL", () => {
    expect(isTrustedDriverUrl()).toBe(true);
  });
  it("requires a 64-char hex SHA-256", () => {
    expect(isSha256("a".repeat(64))).toBe(true);
    expect(isSha256("g".repeat(64))).toBe(false);
    expect(isSha256("a".repeat(63))).toBe(false);
  });
});

describe("isReadOnlySql", () => {
  it("detects common read-only statements and comments", () => {
    expect(isReadOnlySql("SELECT * FROM t")).toBe(true);
    expect(isReadOnlySql("-- note\nSHOW TABLES")).toBe(true);
    expect(isReadOnlySql("WITH x AS (SELECT 1) SELECT * FROM x")).toBe(true);
  });
  it("flags write statements and write CTEs", () => {
    expect(isReadOnlySql("UPDATE t SET n = 1")).toBe(false);
    expect(isReadOnlySql("WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x")).toBe(false);
    expect(isReadOnlySql("CREATE TABLE t (id INT)")).toBe(false);
    expect(isReadOnlySql("SELECT * FROM t FOR UPDATE")).toBe(false);
    expect(isReadOnlySql("SELECT * INTO archived FROM t")).toBe(false);
    expect(isReadOnlySql("SELECT 1; /*!50000 DELETE FROM t */")).toBe(false);
  });
  it("does not misdetect write keywords inside strings", () => {
    expect(isReadOnlySql("SELECT 'delete from t' AS sample")).toBe(true);
  });
});
