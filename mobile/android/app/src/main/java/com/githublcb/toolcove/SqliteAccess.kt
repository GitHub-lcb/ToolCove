package com.githublcb.toolcove

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import com.githublcb.toolcove.bridge.DB_MAX_ROWS
import com.githublcb.toolcove.bridge.DatabaseAccess
import com.githublcb.toolcove.bridge.JsonValue
import com.githublcb.toolcove.bridge.QueryOutcome
import com.githublcb.toolcove.bridge.SqlKit
import java.util.concurrent.ConcurrentHashMap

/**
 * 手机端的数据库实现：**只有 SQLite**（android.database.sqlite）。
 *
 * 为什么不做 MySQL / PostgreSQL / Oracle：安卓没有 JDBC。这不是"暂时没做"，
 * 而是平台上不存在——所以界面上如实标注，而不是摆出选项让人点了报错。
 *
 * 连接参数（与桌面端 SQLite 驱动同形）：`{ type: "sqlite", file: "<路径或 content:// URI>" }`。
 * 用 `content://` 时走 SAF 授权（用户经选择器挑一个 .db 文件），普通路径则要求应用可访问。
 *
 * 这一层刻意做薄：SQL 分类与结果整形都在 bridge/SqlKit（纯逻辑、可 JVM 测），
 * 这里只负责 SQLiteDatabase 的调用与游标遍历。
 */
class SqliteAccess(private val context: Context) : DatabaseAccess {

    private val connections = ConcurrentHashMap<String, SQLiteDatabase>()

    override fun open(options: JsonValue): String {
        val file = options.str("file").trim()
        require(file.isNotEmpty()) { "请选择或填写 SQLite 文件" }
        val connId = SqlKit.connectionId()
        // OPEN_READWRITE 而不带 CREATE：路径写错时应当明确报错，而不是悄悄建一个空库
        val db = SQLiteDatabase.openDatabase(file, null, SQLiteDatabase.OPEN_READWRITE)
        connections[connId] = db
        return connId
    }

    override fun close(connId: String) {
        connections.remove(connId)?.close()
    }

    override fun query(connId: String, sql: String): QueryOutcome {
        val db = connections[connId] ?: throw IllegalStateException(SqlKit.NO_CONNECTION)
        val started = System.currentTimeMillis()
        // 分类决定走 rawQuery 还是 execSQL：混用会抛异常或得到空游标（见 SqlKit.isQuery 的注释）
        if (!SqlKit.isQuery(sql)) {
            db.execSQL(sql)
            return QueryOutcome(emptyList(), emptyList(), affected = -1, truncated = false, durationMs = System.currentTimeMillis() - started)
        }

        db.rawQuery(sql, null).use { cursor ->
            val columns = cursor.columnNames.map { name ->
                // SQLite 的游标不直接给列类型；用 NULL 字段判断（前端只拿它做展示）
                mapOf<String, Any?>("name" to name, "type" to "", "pk" to false)
            }
            val rows = ArrayList<List<Any?>>()
            var truncated = false
            while (cursor.moveToNext()) {
                if (rows.size >= DB_MAX_ROWS) {
                    truncated = true
                    break
                }
                rows.add(
                    (0 until cursor.columnCount).map { index ->
                        val value: Any? = when (cursor.getType(index)) {
                            android.database.Cursor.FIELD_TYPE_NULL -> null
                            android.database.Cursor.FIELD_TYPE_INTEGER -> cursor.getLong(index)
                            android.database.Cursor.FIELD_TYPE_FLOAT -> cursor.getDouble(index)
                            android.database.Cursor.FIELD_TYPE_BLOB -> cursor.getBlob(index)
                            else -> cursor.getString(index)
                        }
                        SqlKit.normalizeValue(value)
                    }
                )
            }
            return QueryOutcome(columns, rows, affected = -1, truncated = truncated, durationMs = System.currentTimeMillis() - started)
        }
    }

    override fun tables(connId: String): List<Map<String, Any?>> {
        val db = connections[connId] ?: throw IllegalStateException(SqlKit.NO_CONNECTION)
        val names = ArrayList<String>()
        db.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name", null).use { cursor ->
            while (cursor.moveToNext()) names.add(cursor.getString(0))
        }
        return names.map { mapOf("name" to it, "type" to "table") }
    }

    override fun columns(connId: String, table: String): List<Map<String, Any?>> {
        val db = connections[connId] ?: throw IllegalStateException(SqlKit.NO_CONNECTION)
        // 表名不能参数化（PRAGMA 不支持占位符），所以必须先校验，否则就是注入面
        require(SqlKit.isValidTableName(table)) { "表名不合法：$table" }
        val result = ArrayList<Triple<String, String, Boolean>>()
        db.rawQuery("PRAGMA table_info($table)", null).use { cursor ->
            val nameIndex = cursor.getColumnIndex("name")
            val typeIndex = cursor.getColumnIndex("type")
            val pkIndex = cursor.getColumnIndex("pk")
            while (cursor.moveToNext()) {
                result.add(
                    Triple(
                        cursor.getString(nameIndex) ?: "",
                        cursor.getString(typeIndex) ?: "",
                        // pk 列是"主键序号"（0 表示不是主键），不是布尔值
                        (if (pkIndex >= 0) cursor.getInt(pkIndex) else 0) > 0,
                    )
                )
            }
        }
        return SqlKit.columnRows(result)
    }

    override fun test(options: JsonValue): Long {
        val file = options.str("file").trim()
        require(file.isNotEmpty()) { "请选择或填写 SQLite 文件" }
        val started = System.currentTimeMillis()
        // 只读打开做一次轻量查询：自检不该改动用户的库
        SQLiteDatabase.openDatabase(file, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT count(*) FROM sqlite_master", null).use { it.moveToFirst() }
        }
        return System.currentTimeMillis() - started
    }
}
