package com.githublcb.toolcove.bridge

import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Base64

/**
 * JSON 值模型 + 解析/序列化 + 命令行分发。
 *
 * 为什么自己写而不用 Gson/Moshi：本工程刻意保持**零第三方依赖**（没有 androidx、没有网络库），
 * 少一层依赖就少一类「本地能编、换台机器编不过」的问题，离线构建也真正可行。
 * 需要处理的 JSON 只有两类：桥的入参（我们自己发的）与 AI 的请求体（OpenAI 兼容格式），
 * 范围可控；一旦发现不够用，再考虑引依赖。
 *
 * 这个文件**不 import 任何 Android 类**，因此能在 JVM 上直接单测（见 BridgeTest.kt）——
 * 原生桥最怕的就是"只能装机试"，把可测的部分全部放进这里。
 */
sealed class JsonValue {
    data class JStr(val value: String) : JsonValue()
    data class JNum(val value: Double) : JsonValue()
    data class JBool(val value: Boolean) : JsonValue()
    object JNull : JsonValue()
    data class JArr(val items: List<JsonValue>) : JsonValue()
    data class JObj(val fields: Map<String, JsonValue>) : JsonValue()

    fun asStringOrNull(): String? = (this as? JStr)?.value

    /** 取值并提供默认——桥的入参经常缺字段，缺了就按默认走，不抛异常。 */
    fun str(key: String, fallback: String = ""): String = (this as? JObj)?.fields?.get(key)?.asStringOrNull() ?: fallback
    fun num(key: String, fallback: Double = 0.0): Double = ((this as? JObj)?.fields?.get(key) as? JNum)?.value ?: fallback
    fun int(key: String, fallback: Int = 0): Int = num(key, fallback.toDouble()).toInt()
    fun bool(key: String, fallback: Boolean = false): Boolean = ((this as? JObj)?.fields?.get(key) as? JBool)?.value ?: fallback
    fun obj(key: String): JsonValue? = (this as? JObj)?.fields?.get(key)
    fun arr(key: String): List<JsonValue> = (this as? JObj)?.fields?.get(key).let { (it as? JArr)?.items } ?: emptyList()

    fun toJson(): String = when (this) {
        is JStr -> quote(value)
        is JNum -> if (value == value.toLong().toDouble()) value.toLong().toString() else value.toString()
        is JBool -> if (value) "true" else "false"
        JNull -> "null"
        is JArr -> items.joinToString(",", "[", "]") { it.toJson() }
        is JObj -> fields.entries.joinToString(",", "{", "}") { (k, v) -> "${quote(k)}:${v.toJson()}" }
    }

    companion object {
        fun of(value: Any?): JsonValue = when (value) {
            null -> JNull
            is JsonValue -> value
            is String -> JStr(value)
            is Boolean -> JBool(value)
            is Number -> JNum(value.toDouble())
            is Map<*, *> -> JObj(value.entries.associate { (k, v) -> k.toString() to of(v) })
            is List<*> -> JArr(value.map { of(it) })
            else -> JStr(value.toString())
        }

        private fun quote(text: String): String {
            val sb = StringBuilder(text.length + 2)
            sb.append('"')
            for (ch in text) {
                when (ch) {
                    '"' -> sb.append("\\\"")
                    '\\' -> sb.append("\\\\")
                    '\n' -> sb.append("\\n")
                    '\r' -> sb.append("\\r")
                    '\t' -> sb.append("\\t")
                    else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
                }
            }
            sb.append('"')
            return sb.toString()
        }
    }
}

/** 极简 JSON 解析器：够解析桥的入参即可；失败时抛 IllegalArgumentException。 */
class JsonReader(private val text: String) {
    private var pos = 0

    fun parse(): JsonValue {
        skipWhitespace()
        val value = readValue()
        skipWhitespace()
        return value
    }

    private fun skipWhitespace() {
        while (pos < text.length && text[pos].isWhitespace()) pos++
    }

    private fun readValue(): JsonValue {
        if (pos >= text.length) throw IllegalArgumentException("JSON 意外结束")
        return when (val ch = text[pos]) {
            '{' -> readObject()
            '[' -> readArray()
            '"' -> JsonValue.JStr(readString())
            't' -> readLiteral("true", JsonValue.JBool(true))
            'f' -> readLiteral("false", JsonValue.JBool(false))
            'n' -> readLiteral("null", JsonValue.JNull)
            else -> if (ch == '-' || ch.isDigit()) readNumber() else throw IllegalArgumentException("JSON 第 $pos 个字符无法识别：$ch")
        }
    }

    private fun readLiteral(literal: String, value: JsonValue): JsonValue {
        if (!text.startsWith(literal, pos)) throw IllegalArgumentException("期望 $literal")
        pos += literal.length
        return value
    }

    private fun readNumber(): JsonValue {
        val start = pos
        if (pos < text.length && text[pos] == '-') pos++
        while (pos < text.length && (text[pos].isDigit() || text[pos] == '.' || text[pos] == 'e' || text[pos] == 'E' || text[pos] == '+' || text[pos] == '-')) pos++
        return JsonValue.JNum(text.substring(start, pos).toDouble())
    }

    private fun readString(): String {
        pos++ // 跳过开引号
        val sb = StringBuilder()
        while (pos < text.length) {
            when (val ch = text[pos]) {
                '"' -> {
                    pos++
                    return sb.toString()
                }
                '\\' -> {
                    pos++
                    when (val esc = text[pos]) {
                        '"' -> sb.append('"')
                        '\\' -> sb.append('\\')
                        '/' -> sb.append('/')
                        'b' -> sb.append('\b')
                        'f' -> sb.append('\u000C')
                        'n' -> sb.append('\n')
                        'r' -> sb.append('\r')
                        't' -> sb.append('\t')
                        'u' -> {
                            sb.append(text.substring(pos + 1, pos + 5).toInt(16).toChar())
                            pos += 4
                        }
                        else -> throw IllegalArgumentException("无法识别的转义：\\$esc")
                    }
                    pos++
                }
                else -> {
                    sb.append(ch)
                    pos++
                }
            }
        }
        throw IllegalArgumentException("字符串没有结束引号")
    }

    private fun readObject(): JsonValue {
        pos++ // {
        val fields = LinkedHashMap<String, JsonValue>()
        skipWhitespace()
        if (pos < text.length && text[pos] == '}') {
            pos++
            return JsonValue.JObj(fields)
        }
        while (true) {
            skipWhitespace()
            val key = readString()
            skipWhitespace()
            if (pos >= text.length || text[pos] != ':') throw IllegalArgumentException("对象缺少冒号")
            pos++
            skipWhitespace()
            fields[key] = readValue()
            skipWhitespace()
            when {
                pos >= text.length -> throw IllegalArgumentException("对象没有结束")
                text[pos] == ',' -> pos++
                text[pos] == '}' -> {
                    pos++
                    return JsonValue.JObj(fields)
                }
                else -> throw IllegalArgumentException("对象里出现意外字符：${text[pos]}")
            }
        }
    }

    private fun readArray(): JsonValue {
        pos++ // [
        val items = ArrayList<JsonValue>()
        skipWhitespace()
        if (pos < text.length && text[pos] == ']') {
            pos++
            return JsonValue.JArr(items)
        }
        while (true) {
            skipWhitespace()
            items.add(readValue())
            skipWhitespace()
            when {
                pos >= text.length -> throw IllegalArgumentException("数组没有结束")
                text[pos] == ',' -> pos++
                text[pos] == ']' -> {
                    pos++
                    return JsonValue.JArr(items)
                }
                else -> throw IllegalArgumentException("数组里出现意外字符：${text[pos]}")
            }
        }
    }
}

/** HTTP 响应（桥对外的形状，与桌面端 Rust 代理保持一致）。 */
data class HttpResult(
    val status: Int,
    val statusText: String,
    val headers: List<Pair<String, String>>,
    val body: String,
    val durationMs: Long,
    val size: Int,
)

/** 原生能力接口：Kotlin 侧实现，Bridge 只依赖这个接口，因此能在 JVM 上替身测试。 */
interface NativeOps {
    fun httpRequest(args: JsonValue): HttpResult
    fun tcpCheck(args: JsonValue): Map<String, Any?>
    fun encrypt(plain: String): String
    fun decrypt(cipher: String): String
    /** 文件读写（手机端走 SAF）；为 null 时相关命令报"本平台不支持"。 */
    fun files(): FileAccess? = null
    /** 弹系统文件选择器并等待结果（返回空串表示用户取消/超时）。 */
    fun pickFile(mimeType: String): String = ""
}

/**
 * 桥的分发核心：与桌面端 platform/invoke 的命令名**完全同名**。
 * 名字一致是关键——src/ 里的 repository / sync / ai 一行都不用改。
 */
class Bridge(private val native: NativeOps) {

    fun dispatch(command: String, argsJson: String?): String {
        val args = try {
            if (argsJson.isNullOrBlank()) JsonValue.JObj(emptyMap()) else JsonReader(argsJson).parse()
        } catch (e: Exception) {
            return error("bad_args", "参数不是合法 JSON：${e.message}")
        }
        return try {
            when (command) {
                "http_request" -> JsonValue.of(httpResultMap(native.httpRequest(args))).toJson()
                "network_tcp_check" -> JsonValue.of(native.tcpCheck(args)).toJson()
                "encrypt_text" -> JsonValue.of(mapOf("cipher" to native.encrypt(args.str("plain")))).toJson()
                "decrypt_text" -> JsonValue.of(mapOf("plain" to native.decrypt(args.str("cipher")))).toJson()
                // ---- 文件（手机端走 SAF：path 是 content:// URI，与桌面端"字符串路径"同形）----
                "file_pick" -> JsonValue.of(mapOf("uri" to native.pickFile(args.str("mimeType", "*/*")))).toJson()
                "file_tool_read_text" -> readText(args)
                "file_tool_write_text" -> writeText(args)
                "file_tool_inspect" -> inspect(args)
                else -> error("unsupported", "手机端尚未实现该命令：$command")
            }
        } catch (e: Exception) {
            // 失败也返回**结构化结果**而不是抛出去：JS 侧按 __error 判定并显示原因，
            // 比"桥抛异常→WebView 收到一句 unclear 的报错"好排查得多。
            error("native_error", e.message ?: e.javaClass.simpleName)
        }
    }

    /** 文件读写需要 FileAccess；没有就明确说"本平台不支持"，而不是抛 NullPointerException。 */
    private fun files(): FileAccess = native.files() ?: throw IllegalStateException("当前平台不支持文件访问")

    /**
     * 读文本：形状与桌面端 file_tool_read_text 完全一致
     * （path / name / size / text / encoding / hasBom / lossy），前端不必分支。
     */
    private fun readText(args: JsonValue): String {
        val uri = args.str("path")
        require(uri.isNotEmpty()) { "缺少文件路径" }
        val bytes = files().readBytes(uri)
        val decoded = FileCodec.decode(bytes, args.str("encoding", "AUTO"))
        return JsonValue.of(
            mapOf(
                "path" to uri,
                "name" to FileCodec.displayName(uri),
                "size" to bytes.size,
                "text" to decoded.text,
                "encoding" to decoded.encoding,
                "hasBom" to decoded.hasBom,
                // lossy 让界面能提示"内容可能不完整"，而不是让人以为文件本来就是这样
                "lossy" to decoded.lossy,
            )
        ).toJson()
    }

    private fun writeText(args: JsonValue): String {
        val uri = args.str("path")
        require(uri.isNotEmpty()) { "缺少文件路径" }
        val text = args.str("text")
        val bytes = FileCodec.encode(text, args.str("encoding", "UTF-8"), args.bool("bom"))
        files().writeBytes(uri, bytes)
        // 桌面端写入返回 null；这里返回 null 值（JSON "null"），保持一致
        return JsonValue.JNull.toJson()
    }

    private fun inspect(args: JsonValue): String {
        val access = files()
        val items = args.arr("paths").map { value ->
            val uri = value.asStringOrNull() ?: ""
            val name = FileCodec.displayName(uri)
            val size = runCatching { access.sizeOf(uri) }.getOrNull()
            mapOf(
                "path" to uri,
                "name" to name,
                "size" to (size ?: 0L),
                "isFile" to (size != null),
                // SAF 的 URI 不代表真实目录（目录要另走 tree picker），如实标注而不是假装
                "isDirectory" to false,
                "exists" to (size != null),
            )
        }
        return JsonValue.of(items).toJson()
    }

    private fun httpResultMap(result: HttpResult): Map<String, Any?> = mapOf(
        "status" to result.status,
        "statusText" to result.statusText,
        // headers 用 [[name, value]] 形状：与 Rust 代理和浏览器实现一致，前端不必分支
        "headers" to result.headers.map { listOf(it.first, it.second) },
        "body" to result.body,
        "durationMs" to result.durationMs,
        "size" to result.size,
    )

    private fun error(code: String, message: String): String =
        JsonValue.JObj(mapOf("__error" to JsonValue.JStr(message), "__code" to JsonValue.JStr(code))).toJson()
}

/**
 * 基于 HttpURLConnection 的原生 HTTP 与原生 TCP 探测。
 *
 * 为什么需要它：WebView 里的 fetch 受 CORS 限制（目标站点不给跨域头就失败），
 * 而原生请求没有这个限制——AI 请求与云同步因此与桌面端等价；
 * TCP 探测也用 java.net.Socket 真握手，而不是浏览器那种"可达性"近似。
 */
class HttpNative(private val timeoutMs: Int = 30_000) : NativeOps {

    override fun httpRequest(args: JsonValue): HttpResult {
        val url = args.str("url")
        require(url.isNotEmpty()) { "缺少 url" }
        val method = args.str("method", "GET").uppercase()
        val started = System.currentTimeMillis()
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = args.int("timeoutMs", timeoutMs)
            readTimeout = args.int("timeoutMs", timeoutMs)
            instanceFollowRedirects = true
            // 有些站按 UA 拒绝空 UA 的请求，给一个中性的
            setRequestProperty("User-Agent", "ToolCove/1.0 (Android)")
            for (header in args.arr("headers")) {
                val pair = (header as? JsonValue.JArr)?.items ?: continue
                val name = pair.getOrNull(0)?.asStringOrNull() ?: continue
                val value = pair.getOrNull(1)?.asStringOrNull() ?: ""
                setRequestProperty(name, value)
            }
        }
        val body = args.str("body")
        if (body.isNotEmpty() && method != "GET" && method != "HEAD") {
            connection.doOutput = true
            connection.outputStream.use { it.write(body.toByteArray(StandardCharsets.UTF_8)) }
        }
        val status = connection.responseCode
        // 4xx/5xx 也要把响应体读出来：错误详情通常在体里，丢掉就没法排查
        val stream: InputStream = connection.errorStream ?: connection.inputStream
        val bytes = stream?.use { readAll(it) } ?: ByteArray(0)
        val headers = connection.headerFields.filterKeys { it != null }.flatMap { (k, v) -> (v ?: emptyList()).map { k to it } }
        return HttpResult(
            status = status,
            statusText = connection.responseMessage ?: "",
            headers = headers,
            body = String(bytes, StandardCharsets.UTF_8),
            durationMs = System.currentTimeMillis() - started,
            size = bytes.size,
        )
    }

    override fun tcpCheck(args: JsonValue): Map<String, Any?> {
        val host = args.str("host")
        val port = args.int("port", 0)
        require(host.isNotEmpty()) { "缺少 host" }
        require(port in 1..65535) { "端口不合法：$port" }
        val timeout = args.int("timeoutMs", 3000)
        val started = System.currentTimeMillis()
        return try {
            java.net.Socket().use { socket ->
                socket.connect(java.net.InetSocketAddress(host, port), timeout)
                mapOf("open" to true, "host" to host, "port" to port, "durationMs" to (System.currentTimeMillis() - started))
            }
        } catch (e: Exception) {
            // 连不上不是异常情况，是**检测结果**——如实返回 false + 原因
            mapOf("open" to false, "host" to host, "port" to port, "durationMs" to (System.currentTimeMillis() - started), "reason" to (e.message ?: e.javaClass.simpleName))
        }
    }

    // 加密由 Android Keystore 实现（KeystoreNative）；这里给纯 JVM 测试用的直通实现
    override fun encrypt(plain: String): String = plain
    override fun decrypt(cipher: String): String = cipher

    private fun readAll(stream: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8192)
        while (true) {
            val read = stream.read(buffer)
            if (read <= 0) break
            out.write(buffer, 0, read)
        }
        return out.toByteArray()
    }

    companion object {
        /** 供测试与调试：把字节转 Base64（与前端 bodyBase64 的约定一致）。 */
        fun base64(bytes: ByteArray): String = Base64.getEncoder().encodeToString(bytes)
    }
}
