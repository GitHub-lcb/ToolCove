package com.githublcb.toolcove.bridge

/**
 * 数据库访问抽象（手机端实现为 android.database.sqlite，JVM 测试用替身）。
 *
 * 与桌面端的对应关系：桌面端有 4 种驱动（SQLite / MySQL / PostgreSQL / Oracle），
 * **手机端只有 SQLite**——安卓没有 JDBC，Oracle 驱动更是不可能（62MB + Windows 依赖）。
 * 所以这里的接口刻意做成"只够 SQLite 用"的形状，而不是假装支持多驱动：
 * 假装支持的后果是界面上出现一堆点了就报错的选项。
 *
 * `connId` 是连接句柄（与桌面端同名同义）：前端 db_connect 拿到它，后续命令都带上。
 */
interface DatabaseAccess {
    /** 打开连接，返回句柄。失败抛异常（由调用方翻成可读错误）。 */
    fun open(options: JsonValue): String
    fun close(connId: String)
    /** 执行 SQL；返回 { columns, rows, affected, truncated, durationMs } 形状的数据。 */
    fun query(connId: String, sql: String): QueryOutcome
    fun tables(connId: String): List<Map<String, Any?>>
    fun columns(connId: String, table: String): List<Map<String, Any?>>
    /** 连接自检（不执行 SQL）：返回耗时毫秒。 */
    fun test(options: JsonValue): Long
}

/**
 * 一次查询的结果。
 *
 * 字段与桌面端 Rust 侧逐一对齐（columns / rows / affected / truncated / durationMs）——
 * 前端 DbTool 直接按这些字段渲染表格与分页，少一个就会显示空白。
 */
data class QueryOutcome(
    val columns: List<Map<String, Any?>>,
    val rows: List<List<Any?>>,
    val affected: Int,
    val truncated: Boolean,
    val durationMs: Long,
)

/** 行数上限：超过就截断并置 truncated（前端据此提示"还有更多"）。 */
const val DB_MAX_ROWS = 5000

/**
 * SQL 分类与结果整形——**纯逻辑，不依赖 Android**。
 *
 * 抽出来的理由：手机端数据库工具真正容易出错的是"这句 SQL 算不算查询""结果怎么整形"
 * "SQLite 的类型怎么映射到 JSON"，而这些都能在 JVM 上测。Android 侧只剩
 * `SQLiteDatabase.rawQuery/execSQL` 的转发。
 */
object SqlKit {

    /**
     * 判断是否返回结果集的语句。
     * SQLite 的 `executeSQL` 与 `rawQuery` 不能混用：把 SELECT 交给 execSQL 会抛异常，
     * 把 INSERT 交给 rawQuery 会得到空游标——所以必须先分类。
     */
    fun isQuery(sql: String): Boolean {
        val head = firstKeyword(sql)
        return head in setOf("SELECT", "PRAGMA", "WITH", "EXPLAIN", "VALUES")
    }

    /** 取首个关键字：跳过注释与空白，并大写化。 */
    fun firstKeyword(sql: String): String {
        val cleaned = stripLeadingComments(sql).trimStart()
        val match = Regex("^[A-Za-z_]+").find(cleaned) ?: return ""
        return match.value.uppercase()
    }

    /**
     * 去掉开头的空白与注释（`--` 行注释与块注释）。
     * 不做这一步的话，`-- 查一下` 换行后的 SELECT 会被当成非查询语句。
     *
     * ⚠️ 注意本文件里不能出现"块注释的结束符号"字面量（哪怕在注释里）——
     * 它会提前终止外层注释，导致后面的代码被当成注释吞掉（编译期报 Unclosed comment，踩过一次）。
     */
    fun stripLeadingComments(sql: String): String {
        var text = sql
        while (true) {
            val trimmed = text.trimStart()
            when {
                trimmed.startsWith("--") -> {
                    val end = trimmed.indexOf('\n')
                    if (end < 0) return ""
                    text = trimmed.substring(end + 1)
                }
                trimmed.startsWith("/*") -> {
                    val end = trimmed.indexOf("*/")
                    if (end < 0) return ""
                    text = trimmed.substring(end + 2)
                }
                else -> return trimmed
            }
        }
    }

    /**
     * 把 SQLite 的值映射成可 JSON 化的形状。
     *
     * 规则（与桌面端 SQLite 驱动保持一致）：
     *   · null → null（不是空串：表格里 null 与 "" 是两回事）
     *   · BLOB → 占位文案而不是乱码（手机上也没法直接看二进制）
     *   · REAL → 数字（保留小数，别转成字符串）
     *   · INTEGER → Long（金额/ID 精度不能丢）
     */
    fun normalizeValue(raw: Any?): Any? = when (raw) {
        null -> null
        is ByteArray -> "[BLOB ${raw.size} 字节]"
        is Int -> raw.toLong()
        is Float -> raw.toDouble()
        is Number, is String, is Boolean -> raw
        else -> raw.toString()
    }

    /** 表名列表 → 前端要的 { name, type } 形状（type 固定 table，与桌面端一致）。 */
    fun tableRows(names: List<String>): List<Map<String, Any?>> = names.map { mapOf("name" to it, "type" to "table") }

    /**
     * 列信息 → 前端要的 { name, type, pk } 形状。
     * `pk` 由调用方给出（SQLite 要查 `PRAGMA table_info` 的第 6 列）。
     */
    fun columnRows(columns: List<Triple<String, String, Boolean>>): List<Map<String, Any?>> =
        columns.map { (name, type, pk) -> mapOf("name" to name, "type" to type, "pk" to pk) }

    /**
     * 表名是否合法。
     *
     * ⚠️ 这是**注入面**：`PRAGMA table_info(<表名>)` 不支持占位符参数，只能拼字符串，
     * 所以表名必须先校验。校验规则刻意保守——只允许常规标识符，
     * 宁可拒绝一个带引号/空格的怪表名，也不能把用户输入直接拼进 SQL。
     * （这条以前只写在 SqliteAccess 里、没有测试，等于安全约束没人守。）
     */
    fun isValidTableName(table: String): Boolean = Regex("^[A-Za-z_][A-Za-z0-9_]*$").matches(table)

    /**
     * 生成连接句柄。
     *
     * 前缀 `sqlite-` 让日志与错误信息一眼看出是哪种连接（将来若支持别的引擎也不会混淆）；
     * 只取 UUID 前 8 位是为了可读——句柄只在内存里用，不需要全局唯一性到 32 位。
     */
    fun connectionId(): String = "sqlite-" + java.util.UUID.randomUUID().toString().take(8)

    /** 连接不存在时的统一错误文案（前端按它提示"请重新连接"）。 */
    const val NO_CONNECTION = "连接已断开，请重新连接"
}
