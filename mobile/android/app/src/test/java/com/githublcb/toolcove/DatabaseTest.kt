package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.Bridge
import com.githublcb.toolcove.bridge.DB_MAX_ROWS
import com.githublcb.toolcove.bridge.DatabaseAccess
import com.githublcb.toolcove.bridge.HttpResult
import com.githublcb.toolcove.bridge.JsonValue
import com.githublcb.toolcove.bridge.NativeOps
import com.githublcb.toolcove.bridge.QueryOutcome
import com.githublcb.toolcove.bridge.SqlKit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 数据库命令与 SQL 逻辑的单测（纯 JVM）。
 *
 * SQLiteDatabase 本身没法在 JVM 上跑，但**真正容易出错的部分都在这里**：
 * SQL 分类（rawQuery 与 execSQL 不能混用）、结果形状（前端按字段渲染表格）、
 * 类型映射（null / BLOB / REAL / INTEGER 各自不能混）。
 */
class DatabaseTest {

    /** 内存数据库替身：只记录调用并回放预置结果。 */
    private class FakeDb(
        private val outcome: QueryOutcome = QueryOutcome(
            columns = listOf(mapOf("name" to "id", "type" to "INTEGER", "pk" to true)),
            rows = listOf(listOf(1L), listOf(2L)),
            affected = -1,
            truncated = false,
            durationMs = 3,
        ),
        private val tables: List<String> = listOf("orders", "users"),
        private val columns: List<Map<String, Any?>> = listOf(mapOf("name" to "id", "type" to "INTEGER", "pk" to true)),
    ) : DatabaseAccess {
        val opened = ArrayList<JsonValue>()
        val closed = ArrayList<String>()
        val queries = ArrayList<String>()
        var failOpen = false

        override fun open(options: JsonValue): String {
            if (failOpen) throw IllegalStateException("无法打开数据库文件")
            opened.add(options)
            return "sqlite-test01"
        }

        override fun close(connId: String) {
            closed.add(connId)
        }

        override fun query(connId: String, sql: String): QueryOutcome {
            if (connId.isEmpty()) throw IllegalStateException("连接已断开，请重新连接")
            queries.add(sql)
            return outcome
        }

        override fun tables(connId: String) = tables.map { mapOf("name" to it, "type" to "table") }
        override fun columns(connId: String, table: String) = columns
        override fun test(options: JsonValue) = 7L
    }

    private class FakeNative(private val db: DatabaseAccess?) : NativeOps {
        override fun httpRequest(args: JsonValue) = HttpResult(200, "OK", emptyList(), "", 1, 0)
        override fun tcpCheck(args: JsonValue) = emptyMap<String, Any?>()
        override fun encrypt(plain: String) = plain
        override fun decrypt(cipher: String) = cipher
        override fun databases(): DatabaseAccess? = db
    }

    private fun bridge(db: DatabaseAccess?) = Bridge(FakeNative(db))

    // ---------- SQL 分类 ----------
    @Test
    fun `SELECT 与 PRAGMA 算查询 其余算执行`() {
        for (sql in listOf("SELECT 1", "select * from t", "  SELECT 1", "PRAGMA table_info(t)", "WITH x AS (SELECT 1) SELECT * FROM x", "EXPLAIN SELECT 1", "VALUES (1)")) {
            assertTrue("$sql 应算查询", SqlKit.isQuery(sql))
        }
        for (sql in listOf("INSERT INTO t VALUES (1)", "UPDATE t SET a=1", "DELETE FROM t", "CREATE TABLE t(a)", "DROP TABLE t", "BEGIN", "COMMIT")) {
            assertFalse("$sql 不应算查询", SqlKit.isQuery(sql))
        }
    }

    @Test
    fun `开头的注释不影响分类（真实粘贴的 SQL 常带注释）`() {
        assertTrue(SqlKit.isQuery("-- 查一下订单\nSELECT * FROM orders"))
        assertTrue(SqlKit.isQuery("/* 块注释 */ SELECT 1"))
        assertTrue(SqlKit.isQuery("-- 注释一\n/* 注释二 */\n  SELECT 1"))
        assertFalse(SqlKit.isQuery("-- 只有注释"))
        assertFalse(SqlKit.isQuery("/* 没闭合的块注释 SELECT 1"))
    }

    @Test
    fun `关键字大小写都认`() {
        assertEquals("SELECT", SqlKit.firstKeyword("select 1"))
        assertEquals("INSERT", SqlKit.firstKeyword("  InSeRt into t values(1)"))
        assertEquals("", SqlKit.firstKeyword("   "))
        assertEquals("", SqlKit.firstKeyword("123"))
    }

    // ---------- 类型映射 ----------
    @Test
    fun `值映射：null 保持 null 而不是空串`() {
        // 表格里 null 与 "" 是两回事，混了会让人误判数据
        assertEquals(null, SqlKit.normalizeValue(null))
        assertEquals("", SqlKit.normalizeValue(""))
    }

    @Test
    fun `值映射：BLOB 给占位文案而不是乱码`() {
        val blob = ByteArray(12)
        assertEquals("[BLOB 12 字节]", SqlKit.normalizeValue(blob))
    }

    @Test
    fun `值映射：整数转 Long 小数转 Double（精度不丢）`() {
        assertEquals(42L, SqlKit.normalizeValue(42))
        assertEquals(1.5, SqlKit.normalizeValue(1.5f))
        assertEquals(9007199254740993L, SqlKit.normalizeValue(9007199254740993L))
    }

    @Test
    fun `表与列的形状与桌面端一致`() {
        assertEquals(listOf(mapOf("name" to "users", "type" to "table")), SqlKit.tableRows(listOf("users")))
        val cols = SqlKit.columnRows(listOf(Triple("id", "INTEGER", true), Triple("name", "TEXT", false)))
        assertEquals("id", cols[0]["name"])
        assertEquals(true, cols[0]["pk"])
        assertEquals(false, cols[1]["pk"])
    }

    // ---------- 命令分发 ----------
    @Test
    fun `db_connect 返回连接句柄 并把参数原样交给实现`() {
        val db = FakeDb()
        val out = bridge(db).dispatch("db_connect", """{"opts":{"type":"sqlite","file":"/data/app/orders.db"}}""")
        assertTrue(out, out.contains("sqlite-test01"))
        assertEquals("/data/app/orders.db", db.opened.first().str("file"))
    }

    @Test
    fun `db_query 的返回形状与桌面端逐字段一致`() {
        val out = bridge(FakeDb()).dispatch("db_query", """{"connId":"c1","sql":"SELECT id FROM users"}""")
        for (field in listOf("\"columns\"", "\"rows\"", "\"affected\"", "\"truncated\"", "\"durationMs\"")) {
            assertTrue("缺少字段 $field：$out", out.contains(field))
        }
        // rows 必须是二维数组（前端按列顺序渲染表格）
        assertTrue("rows 形状不对：$out", out.contains("\"rows\":[[1],[2]]"))
        assertTrue(out.contains("\"durationMs\":3"))
    }

    @Test
    fun `db_query 缺 connId 或 SQL 要明确报错`() {
        val noConn = bridge(FakeDb()).dispatch("db_query", """{"sql":"SELECT 1"}""")
        assertTrue(noConn.contains("__error"))
        assertTrue(noConn.contains("connId"))

        val noSql = bridge(FakeDb()).dispatch("db_query", """{"connId":"c1","sql":"   "}""")
        assertTrue(noSql.contains("__error"))
        assertTrue(noSql.contains("SQL 为空"))
    }

    @Test
    fun `db_tables 与 db_columns 返回前端要的形状`() {
        val b = bridge(FakeDb())
        val tables = b.dispatch("db_tables", """{"connId":"c1"}""")
        assertTrue(tables, tables.contains("\"name\":\"orders\""))
        assertTrue(tables.contains("\"type\":\"table\""))

        val cols = b.dispatch("db_columns", """{"connId":"c1","table":"orders"}""")
        assertTrue(cols.contains("\"pk\":true"))
    }

    @Test
    fun `db_test 返回耗时（自检不改动用户的库）`() {
        val out = bridge(FakeDb()).dispatch("db_test", """{"opts":{"file":"/data/app/orders.db"}}""")
        assertTrue(out.contains("\"ok\":true"))
        assertTrue(out.contains("\"durationMs\":7"))
    }

    @Test
    fun `db_close 传对句柄且返回 null`() {
        val db = FakeDb()
        val out = bridge(db).dispatch("db_close", """{"connId":"sqlite-test01"}""")
        assertEquals("null", out)
        assertEquals(listOf("sqlite-test01"), db.closed)
    }

    @Test
    fun `平台不支持数据库时明确说明 而不是 NPE`() {
        val out = bridge(null).dispatch("db_tables", """{"connId":"c1"}""")
        assertTrue(out.contains("__error"))
        assertTrue(out.contains("不支持数据库访问"))
    }

    @Test
    fun `打开失败时把原因带出来`() {
        val db = FakeDb().apply { failOpen = true }
        val out = bridge(db).dispatch("db_connect", """{"opts":{"file":"/nope.db"}}""")
        assertTrue(out.contains("__error"))
        assertTrue(out.contains("无法打开数据库文件"))
    }

    @Test
    fun `未实现的 db 命令（多驱动相关）明确提示 而不是静默`() {
        // 手机端只有 SQLite：驱动列表、Oracle 驱动安装这类命令不该假装成功
        val out = bridge(FakeDb()).dispatch("db_drivers", """{}""")
        assertTrue(out.contains("__error"))
        assertTrue(out.contains("尚未实现"))
    }

    @Test
    fun `行数上限是常量且足够大`() {
        assertTrue("上限过小会让正常查询被截断", DB_MAX_ROWS >= 1000)
    }
}
