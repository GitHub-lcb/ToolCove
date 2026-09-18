package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.Bridge
import com.githublcb.toolcove.bridge.FileAccess
import com.githublcb.toolcove.bridge.HttpNative
import com.githublcb.toolcove.bridge.HttpResult
import com.githublcb.toolcove.bridge.JsonValue
import com.githublcb.toolcove.bridge.NativeOps
import com.githublcb.toolcove.bridge.PickerQueue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/**
 * 文件命令与选择器队列的单测（纯 JVM）。
 *
 * SAF 的 Activity 交互没法在 JVM 上测，但**真正容易出错的部分都在这里**：
 * 命令的分发与返回形状、文本编解码的接线、以及"挂起等待/唤醒/超时/被顶掉"这些时序。
 * 装机只剩"选择器弹不弹得出来"。
 */
class FileAccessTest {

    /** 内存文件系统替身：键是 URI。 */
    private class FakeFiles(initial: Map<String, ByteArray> = emptyMap()) : FileAccess {
        val store = HashMap<String, ByteArray>(initial)
        override fun readBytes(uri: String): ByteArray = store[uri] ?: throw IllegalStateException("文件不存在：$uri")
        override fun writeBytes(uri: String, bytes: ByteArray) {
            store[uri] = bytes
        }
        override fun sizeOf(uri: String): Long = (store[uri]?.size ?: throw IllegalStateException("文件不存在：$uri")).toLong()
    }

    private class FakeNative(
        private val files: FileAccess?,
        private val pickResult: String = "",
    ) : NativeOps {
        override fun httpRequest(args: JsonValue) = HttpResult(200, "OK", emptyList(), "", 1, 0)
        override fun tcpCheck(args: JsonValue) = emptyMap<String, Any?>()
        override fun encrypt(plain: String) = plain
        override fun decrypt(cipher: String) = cipher
        override fun files(): FileAccess? = files
        override fun pickFile(mimeType: String) = pickResult
    }

    private fun bridgeWith(files: FileAccess?) = Bridge(FakeNative(files))

    // ---------- 读 ----------
    @Test
    fun `读文本的返回形状与桌面端一致`() {
        val files = FakeFiles(mapOf("content://x/order.json" to "{\"a\":1}".toByteArray(Charsets.UTF_8)))
        val out = bridgeWith(files).dispatch("file_tool_read_text", """{"path":"content://x/order.json"}""")
        // 前端读的是 path/name/size/text/encoding/hasBom/lossy —— 少一个字段界面就会显示空
        for (field in listOf("\"path\"", "\"name\"", "\"size\"", "\"text\"", "\"encoding\"", "\"hasBom\"", "\"lossy\"")) {
            assertTrue("缺少字段 $field：$out", out.contains(field))
        }
        assertTrue(out.contains("order.json"))
        assertTrue(out.contains("UTF-8"))
        assertTrue(out.contains("{\\\"a\\\":1}"))
    }

    @Test
    fun `读带 BOM 的文件会识别并去掉 BOM`() {
        val bom = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "内容".toByteArray(Charsets.UTF_8)
        val files = FakeFiles(mapOf("content://x/bom.txt" to bom))
        val out = bridgeWith(files).dispatch("file_tool_read_text", """{"path":"content://x/bom.txt","encoding":"AUTO"}""")
        assertTrue(out.contains("\"hasBom\":true"))
        assertTrue("BOM 不能留在正文里", !out.contains("\\uFEFF"))
    }

    @Test
    fun `读不存在的文件返回结构化错误 而不是崩掉`() {
        val out = bridgeWith(FakeFiles()).dispatch("file_tool_read_text", """{"path":"content://x/missing.txt"}""")
        assertTrue(out.contains("__error"))
        assertTrue("原因要带上：$out", out.contains("文件不存在"))
    }

    @Test
    fun `缺 path 参数要明确报错`() {
        val out = bridgeWith(FakeFiles()).dispatch("file_tool_read_text", """{}""")
        assertTrue(out.contains("__error"))
        assertTrue(out.contains("缺少文件路径"))
    }

    @Test
    fun `平台不支持文件访问时明确说明 而不是 NPE`() {
        val out = bridgeWith(null).dispatch("file_tool_read_text", """{"path":"content://x/a"}""")
        assertTrue(out.contains("__error"))
        assertTrue(out.contains("不支持文件访问"))
    }

    // ---------- 写 ----------
    @Test
    fun `写文本落盘并能读回（默认 UTF-8 无 BOM）`() {
        val files = FakeFiles()
        val bridge = bridgeWith(files)
        val wrote = bridge.dispatch("file_tool_write_text", """{"path":"content://x/new.txt","text":"第一行\n第二行"}""")
        assertEquals("null", wrote) // 与桌面端一致：写入成功返回 null
        val bytes = files.store["content://x/new.txt"]!!
        assertFalse("默认不该加 BOM", bytes.size >= 3 && bytes[0] == 0xEF.toByte())

        val read = bridge.dispatch("file_tool_read_text", """{"path":"content://x/new.txt"}""")
        assertTrue(read.contains("第一行"))
    }

    @Test
    fun `写文本可指定编码与 BOM（覆盖已有内容时不留残留）`() {
        val files = FakeFiles(mapOf("content://x/a.txt" to "很长很长的旧内容很长很长的旧内容".toByteArray(Charsets.UTF_8)))
        val bridge = bridgeWith(files)
        bridge.dispatch("file_tool_write_text", """{"path":"content://x/a.txt","text":"短","encoding":"UTF-8","bom":true}""")
        val bytes = files.store["content://x/a.txt"]!!
        // 新内容必须完全替换旧内容（SAF 的 "wt" 模式就是干这个的）
        val decoded = String(bytes, Charsets.UTF_8)
        assertTrue(decoded.endsWith("短"))
        assertFalse("旧内容残留说明没有截断", decoded.contains("旧内容"))
    }

    // ---------- inspect ----------
    @Test
    fun `inspect 返回每个 URI 的存在性与大小`() {
        val files = FakeFiles(mapOf("content://x/a.txt" to "12345".toByteArray()))
        val out = bridgeWith(files).dispatch("file_tool_inspect", """{"paths":["content://x/a.txt","content://x/missing"]}""")
        assertTrue(out.contains("\"exists\":true"))
        assertTrue(out.contains("\"exists\":false"))
        assertTrue(out.contains("\"size\":5"))
        // 手机端没有真实目录语义（目录要另走 tree picker），如实标注而不是假装
        assertTrue(out.contains("\"isDirectory\":false"))
    }

    // ---------- 选择器 ----------
    @Test
    fun `file_pick 返回原生给的 URI`() {
        val out = bridgeWith(FakeFiles()).let { Bridge(FakeNative(null, pickResult = "content://x/picked.txt")) }
            .dispatch("file_pick", """{"mimeType":"text/plain"}""")
        assertTrue(out.contains("content://x/picked.txt"))
    }

    @Test
    fun `用户取消时 file_pick 返回空串（前端据此当取消处理）`() {
        val out = bridgeWith(FakeFiles()).let { Bridge(FakeNative(null, pickResult = "")) }
            .dispatch("file_pick", """{"mimeType":"*/*"}""")
        assertTrue("空串是「取消」的信号，不该变成错误：$out", !out.contains("__error"))
        assertTrue(out.contains("\"uri\":\"\""))
    }

    @Test
    fun `等待中的选择请求能被唤醒`() {
        val queue = PickerQueue(defaultTimeoutMs = 5_000)
        val result = AtomicReference<String>("未设置")
        val started = CountDownLatch(1)
        val worker = Thread {
            started.countDown()
            result.set(queue.awaitSelection())
        }
        worker.start()
        assertTrue(started.await(2, TimeUnit.SECONDS))
        // 等它真的进入等待，再唤醒（否则测的是"还没开始就完成"）
        var waited = 0
        while (!queue.isPending && waited < 2_000) {
            Thread.sleep(10)
            waited += 10
        }
        assertTrue("调用方应处于等待状态", queue.isPending)
        queue.complete("content://x/chosen.txt")
        worker.join(2_000)
        assertEquals("content://x/chosen.txt", result.get())
    }

    @Test
    fun `超时返回空串 而不是永远卡住`() {
        val queue = PickerQueue()
        val started = System.currentTimeMillis()
        val result = queue.awaitSelection(timeoutMs = 200)
        val elapsed = System.currentTimeMillis() - started
        assertEquals("", result)
        assertTrue("应当超时返回，实际耗时 ${elapsed}ms", elapsed < 3_000)
        assertFalse(queue.isPending)
    }

    @Test
    fun `取消（complete null）立即结束等待`() {
        val queue = PickerQueue(defaultTimeoutMs = 30_000)
        val result = AtomicReference<String>("未设置")
        val worker = Thread { result.set(queue.awaitSelection()) }
        worker.start()
        var waited = 0
        while (!queue.isPending && waited < 2_000) {
            Thread.sleep(10)
            waited += 10
        }
        queue.complete(null)
        worker.join(2_000)
        assertEquals("", result.get())
    }

    @Test
    fun `并发请求时后者顶掉前者（都表现为取消 而不是排队）`() {
        val queue = PickerQueue(defaultTimeoutMs = 30_000)
        val first = AtomicReference<String>("未设置")
        val firstWorker = Thread { first.set(queue.awaitSelection()) }
        firstWorker.start()
        var waited = 0
        while (!queue.isPending && waited < 2_000) {
            Thread.sleep(10)
            waited += 10
        }
        // 第二个请求进来：第一个应立刻拿到空串
        val secondResult = AtomicReference<String>("未设置")
        val secondWorker = Thread { secondResult.set(queue.awaitSelection()) }
        secondWorker.start()
        firstWorker.join(2_000)
        assertEquals("被顶掉的请求应当表现为取消", "", first.get())

        waited = 0
        while (!queue.isPending && waited < 2_000) {
            Thread.sleep(10)
            waited += 10
        }
        queue.complete("content://x/second.txt")
        secondWorker.join(2_000)
        assertEquals("content://x/second.txt", secondResult.get())
    }

    @Test
    fun `没有等待者时 complete 是空操作`() {
        val queue = PickerQueue()
        queue.complete("content://x/late.txt") // 不该抛异常（迟到的 onActivityResult 很常见）
        assertFalse(queue.isPending)
    }

    @Test
    fun `HTTP 与 TCP 仍然不受文件能力影响`() {
        // 回归：把 NativeOps 扩成含文件能力后，原有命令不能坏
        val bridge = Bridge(HttpNative())
        val tcp = bridge.dispatch("network_tcp_check", """{"host":"127.0.0.1","port":9,"timeoutMs":300}""")
        assertFalse(tcp.contains("__error"))
        assertTrue(tcp.contains("\"open\":false"))
    }
}
