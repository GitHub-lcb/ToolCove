package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.Bridge
import com.githublcb.toolcove.bridge.HttpNative
import com.githublcb.toolcove.bridge.HttpResult
import com.githublcb.toolcove.bridge.JsonReader
import com.githublcb.toolcove.bridge.JsonValue
import com.githublcb.toolcove.bridge.NativeOps
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 桥的核心逻辑单测（纯 JVM，不需要设备/模拟器）。
 *
 * 为什么值得写：原生桥最容易变成"只能装机试"的黑盒，一处拼错就要来回装包。
 * 把 JSON 解析、命令分发、HTTP 响应映射、TCP 结果形状放在无 Android 依赖的代码里测，
 * 装机只剩"WebView 与 JS 接线"这一件事要验。
 */
class BridgeTest {

    /** 替身原生实现：桥的测试只关心分发与形状，不真的联网。 */
    private class FakeNative(
        private val http: HttpResult = HttpResult(200, "OK", listOf("content-type" to "application/json"), """{"ok":true}""", 12, 11),
        private val tcp: Map<String, Any?> = mapOf("open" to true, "host" to "example.com", "port" to 443, "durationMs" to 5),
    ) : NativeOps {
        var lastHttpArgs: JsonValue? = null
        var lastTcpArgs: JsonValue? = null
        override fun httpRequest(args: JsonValue): HttpResult {
            lastHttpArgs = args
            return http
        }
        override fun tcpCheck(args: JsonValue): Map<String, Any?> {
            lastTcpArgs = args
            return tcp
        }
        override fun encrypt(plain: String) = "enc:$plain"
        override fun decrypt(cipher: String) = cipher.removePrefix("enc:")
    }

    private fun bridge(native: NativeOps = FakeNative()) = Bridge(native)

    // ---------- JSON ----------
    @Test
    fun `解析对象 数组 字符串与数字`() {
        val parsed = JsonReader("""{"a":"x","b":[1,2.5],"c":true,"d":null,"e":{"f":"g"}}""").parse()
        assertEquals("x", parsed.str("a"))
        assertEquals(2, parsed.arr("b").size)
        assertTrue(parsed.bool("c"))
        assertEquals("g", parsed.obj("e")?.str("f"))
        assertEquals("", parsed.str("missing"))
    }

    @Test
    fun `转义与反转义往返`() {
        val original = "换行\n引号\"反斜杠\\制表\t中文"
        val json = JsonValue.JObj(mapOf("k" to JsonValue.JStr(original))).toJson()
        assertEquals(original, JsonReader(json).parse().str("k"))
    }

    @Test
    fun `非法 JSON 不会让桥崩掉 而是返回结构化错误`() {
        val out = bridge().dispatch("http_request", "{不是 JSON")
        assertTrue("应带 __error：$out", out.contains("__error"))
        assertTrue(out.contains("bad_args"))
    }

    @Test
    fun `空参数按默认值走`() {
        val out = bridge().dispatch("http_request", null)
        assertTrue(out.contains("\"status\":200"))
    }

    // ---------- 命令分发 ----------
    @Test
    fun `http_request 的返回形状与桌面端一致`() {
        val out = bridge().dispatch("http_request", """{"url":"https://x/y"}""")
        // headers 是 [[name, value]]：与 Rust 代理、浏览器实现同形，前端不必分支
        assertTrue(out, out.contains("\"headers\":[[\"content-type\",\"application/json\"]]"))
        assertTrue(out.contains("\"status\":200"))
        assertTrue(out.contains("\"durationMs\":12"))
        assertTrue(out.contains("\"size\":11"))
    }

    @Test
    fun `http_request 把参数原样交给原生实现`() {
        val fake = FakeNative()
        bridge(fake).dispatch("http_request", """{"url":"https://api.example.com/v1/chat","method":"POST","body":"{}"}""")
        assertEquals("https://api.example.com/v1/chat", fake.lastHttpArgs?.str("url"))
        assertEquals("POST", fake.lastHttpArgs?.str("method"))
        assertEquals("{}", fake.lastHttpArgs?.str("body"))
    }

    @Test
    fun `network_tcp_check 返回可达性与耗时`() {
        val out = bridge().dispatch("network_tcp_check", """{"host":"example.com","port":443}""")
        assertTrue(out.contains("\"open\":true"))
        assertTrue(out.contains("\"port\":443"))
    }

    @Test
    fun `加密命令往返（替身是明文，真实实现走 Keystore）`() {
        val encrypted = bridge().dispatch("encrypt_text", """{"plain":"sk-secret"}""")
        assertTrue(encrypted.contains("enc:sk-secret"))
        val decrypted = bridge().dispatch("decrypt_text", """{"cipher":"enc:sk-secret"}""")
        assertTrue(decrypted.contains("sk-secret"))
    }

    @Test
    fun `未实现的命令给出明确提示 而不是静默失败`() {
        val out = bridge().dispatch("file_tool_read_text", """{"path":"/x"}""")
        assertTrue(out.contains("__error"))
        assertTrue(out, out.contains("尚未实现"))
    }

    @Test
    fun `原生抛错时桥把它翻成结构化错误`() {
        val failing = object : NativeOps {
            override fun httpRequest(args: JsonValue): HttpResult = throw IllegalStateException("连接被拒绝")
            override fun tcpCheck(args: JsonValue) = emptyMap<String, Any?>()
            override fun encrypt(plain: String) = plain
            override fun decrypt(cipher: String) = cipher
        }
        val out = bridge(failing).dispatch("http_request", """{"url":"https://x"}""")
        assertTrue(out.contains("__error"))
        assertTrue("原因要带上：$out", out.contains("连接被拒绝"))
        assertTrue(out.contains("native_error"))
    }

    // ---------- TCP ----------
    @Test
    fun `TCP 探测连不上时返回 open false 与原因 而不是抛异常`() {
        val http = HttpNative()
        // 保留端口/不可路由地址：连不上是**结果**，不是崩溃
        val result = http.tcpCheck(JsonReader("""{"host":"127.0.0.1","port":9,"timeoutMs":300}""").parse())
        assertEquals(false, result["open"])
        assertTrue(result["durationMs"] is Long)
    }

    @Test
    fun `TCP 参数不合法时给出可读原因`() {
        val http = HttpNative()
        val failed = runCatching { http.tcpCheck(JsonReader("""{"host":"127.0.0.1","port":0}""").parse()) }
        assertTrue(failed.isFailure)
        assertTrue(failed.exceptionOrNull()?.message?.contains("端口") == true)
    }

    // ---------- 组合：桥 + TCP ----------
    @Test
    fun `桥对 TCP 失败也返回结果而不是错误对象`() {
        val out = Bridge(HttpNative()).dispatch("network_tcp_check", """{"host":"127.0.0.1","port":9,"timeoutMs":300}""")
        assertFalse("TCP 失败是检测结果，不该变成 __error：$out", out.contains("__error"))
        assertTrue(out.contains("\"open\":false"))
    }
}
