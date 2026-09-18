package com.githublcb.toolcove

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.BufferedInputStream
import java.net.InetSocketAddress
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * 内置资源服务的**真实 HTTP 行为**测试（纯 JVM）。
 *
 * 为什么值得单独测：这是**启动路径**——服务起不来、或资源找不到，表现就是白屏
 * （而构建是"成功"的）。以前只测了纯逻辑（AssetPath），请求解析、状态码、响应头、
 * 并发、关闭这些**只有起真服务才能验**。
 *
 * 做法：把资源读取注入成内存里的假资源（`AssetReader`），起真服务、发真 socket 请求。
 * 这样测的是与真机**同一条代码路径**，只有"资源从哪来"不同。
 */
class AssetsServerTest {

    /** 内存资源：模拟 APK 里的 assets（注意用真实的 `assets/assets/` 布局）。 */
    private val files = mapOf(
        "index.html" to "<!doctype html><div id=app></div>".toByteArray(),
        "assets/index-Ab12Cd.js" to "console.log(1)".toByteArray(),
        "assets/label-core-Xy98Z.wasm" to ByteArray(64) { 0x00 },
        "assets/shell-De34Fg.css" to "body{}".toByteArray(),
    )

    /** 假资源读取器：read 查表，list 按前缀列举（模拟 AssetManager.list 的行为）。 */
    private fun readerOf(map: Map<String, ByteArray>) = object : AssetReader {
        override fun read(path: String): ByteArray? = map[path]
        override fun list(path: String): List<String> {
            val prefix = if (path.isEmpty()) "" else "$path/"
            return map.keys.filter { it.startsWith(prefix) && !it.removePrefix(prefix).contains('/') }
                .map { it.removePrefix(prefix) }
        }
    }

    private lateinit var server: AssetsServer
    private var base = ""
    private var port = 0

    @Before
    fun setUp() {
        server = AssetsServer(readerOf(files))
        base = server.start()
        port = base.substringAfterLast(':').toInt()
    }

    @After
    fun tearDown() {
        server.stop()
    }

    /** 发一个原始 HTTP 请求并解析响应。用裸 socket 是为了能测 OPTIONS/HEAD 这些 HttpURLConnection 不支持的。 */
    private class Response(val status: Int, val headers: Map<String, String>, val body: ByteArray) {
        fun header(name: String) = headers[name.lowercase()]
    }

    private fun request(method: String, path: String, host: String = "127.0.0.1"): Response {
        java.net.Socket().use { socket ->
            socket.connect(InetSocketAddress("127.0.0.1", port), 3000)
            socket.soTimeout = 3000
            val out = socket.getOutputStream()
            out.write("$method $path HTTP/1.1\r\nHost: $host\r\nConnection: close\r\n\r\n".toByteArray())
            out.flush()

            val input = BufferedInputStream(socket.getInputStream())
            val head = StringBuilder()
            while (true) {
                val b = input.read()
                if (b == -1) break
                head.append(b.toChar())
                if (head.endsWith("\r\n\r\n")) break
            }
            val lines = head.toString().split("\r\n").filter { it.isNotEmpty() }
            val status = lines.first().split(' ')[1].toInt()
            val headers = lines.drop(1)
                .mapNotNull { line ->
                    val index = line.indexOf(':')
                    if (index < 0) null else line.substring(0, index).trim().lowercase() to line.substring(index + 1).trim()
                }
                .toMap()
            val body = input.readBytes()
            return Response(status, headers, body)
        }
    }

    // ---------- 基本请求 ----------
    @Test
    fun `根路径返回 index_html`() {
        val response = request("GET", "/")
        assertEquals(200, response.status)
        assertTrue(String(response.body).contains("id=app"))
        assertTrue("HTML 必须带 utf-8 否则中文乱码", response.header("content-type")!!.contains("text/html"))
        assertTrue(response.header("content-type")!!.contains("utf-8"))
    }

    @Test
    fun `内容长度必须等于真实字节数（否则浏览器会截断或空等）`() {
        val response = request("GET", "/index.html")
        // 解析成 Int 再比：直接比字符串会撞上 assertEquals 的重载解析（String? 参数）
        val declared = response.header("content-length")?.toInt()
        assertEquals("content-length 应为真实字节数", files["index.html"]!!.size, declared)
        assertEquals(files["index.html"]!!.size, response.body.size)
    }

    @Test
    fun `前端产物按真实布局能找到（assets 前缀）`() {
        // 真实 APK 里 chunk 在 assets/assets/ 下，请求路径是 /assets/xxx.js
        val response = request("GET", "/assets/index-Ab12Cd.js")
        assertEquals(200, response.status)
        assertEquals("console.log(1)", String(response.body))
        assertTrue(response.header("content-type")!!.startsWith("text/javascript"))
    }

    @Test
    fun `wasm 的 MIME 是 application wasm（错了 instantiateStreaming 会拒绝）`() {
        val response = request("GET", "/assets/label-core-Xy98Z.wasm")
        assertEquals(200, response.status)
        assertEquals("wasm 的 MIME", "application/wasm", response.header("content-type") ?: "")
        assertEquals(64, response.body.size)
    }

    @Test
    fun `所有响应都带 no-cache（否则升级后仍是旧页面）`() {
        for (path in listOf("/", "/index.html", "/assets/shell-De34Fg.css", "/missing.js")) {
            assertEquals("$path 应带 no-cache", "no-cache", request("GET", path).header("cache-control") ?: "")
        }
    }

    @Test
    fun `找不到的资源返回 404 并说明路径`() {
        val response = request("GET", "/nope.js")
        assertEquals(404, response.status)
        assertTrue(String(response.body).contains("nope.js"))
    }

    // ---------- 方法与预检 ----------
    @Test
    fun `HEAD 返回头与真实长度但没有响应体`() {
        val response = request("HEAD", "/index.html")
        assertEquals(200, response.status)
        // 关键：body 空但 Content-Length 是真实大小——浏览器据此判断资源是否存在
        assertEquals(0, response.body.size)
        assertEquals("HEAD 也要写真实长度", files["index.html"]!!.size, response.header("content-length")?.toInt())
    }

    @Test
    fun `OPTIONS 返回 204（前端拿到明确响应而不是模糊失败）`() {
        val response = request("OPTIONS", "/")
        assertEquals(204, response.status)
        assertEquals("OPTIONS 的 content-length 应为 0", "0", response.header("content-length") ?: "")
    }

    @Test
    fun `POST 返回 405（本服务不提供服务端逻辑）`() {
        val response = request("POST", "/")
        assertEquals(405, response.status)
        assertTrue(String(response.body).contains("method not allowed"))
    }

    // ---------- 安全 ----------
    @Test
    fun `路径穿越返回 404 而不是文件内容`() {
        for (path in listOf("/../secret", "/%2e%2e%2fsecret", "/a/../../b", "/..%5csecret")) {
            val response = request("GET", path)
            assertEquals("$path 必须被拦", 404, response.status)
            assertFalse("不能泄露任何文件内容", String(response.body).contains("id=app"))
        }
    }

    // ---------- 绑定与并发 ----------
    @Test
    fun `只绑 127_0_0_1（外部网络不可达）`() {
        assertTrue("基地址必须是 loopback", base.startsWith("http://127.0.0.1:"))
        // 端口是随机的（0 让系统分配），不该是固定值
        assertTrue("端口应在动态范围内", port in 1024..65535)
    }

    @Test
    fun `并发请求都能正确响应（WebView 会并发拉资源）`() {
        val count = 24
        val pool = Executors.newFixedThreadPool(8)
        val latch = CountDownLatch(count)
        val failures = java.util.concurrent.ConcurrentLinkedQueue<String>()
        repeat(count) { index ->
            pool.execute {
                try {
                    val path = if (index % 2 == 0) "/index.html" else "/assets/index-Ab12Cd.js"
                    val response = request("GET", path)
                    if (response.status != 200) failures.add("$path → ${response.status}")
                } catch (e: Exception) {
                    failures.add("异常：${e.message}")
                } finally {
                    latch.countDown()
                }
            }
        }
        assertTrue("并发请求应在 15s 内跑完", latch.await(15, TimeUnit.SECONDS))
        pool.shutdownNow()
        assertTrue("并发下有失败：$failures", failures.isEmpty())
    }

    @Test
    fun `stop 之后端口释放（重启应用不会撞端口）`() {
        val local = AssetsServer(readerOf(files))
        val address = local.start()
        val localPort = address.substringAfterLast(':').toInt()
        local.stop()
        // 停掉之后同端口应当能再绑上（说明 socket 真的关了）
        java.net.ServerSocket().use { probe ->
            probe.reuseAddress = true
            probe.bind(InetSocketAddress("127.0.0.1", localPort))
            assertTrue(probe.isBound)
        }
    }

    @Test
    fun `重复 stop 不抛异常（Activity 销毁路径会调）`() {
        val local = AssetsServer(readerOf(files))
        local.start()
        local.stop()
        local.stop()
    }

    // ---------- 启动诊断 ----------
    @Test
    fun `describeLayout 按目录列举报告真实布局（不猜带哈希的文件名）`() {
        val layout = server.describeLayout()
        // 入口文件名字固定，按候选前缀探测
        assertTrue("应报告入口命中：$layout", layout.contains("entry=index.html"))
        // 其余按目录列举——带内容哈希的文件名每次构建都变，猜它只会误报 missing
        assertTrue("应列举资源目录：$layout", layout.contains("assets: 3 项"))
        assertTrue("应分类统计：$layout", layout.contains("js 1") && layout.contains("wasm 1") && layout.contains("css 1"))
    }

    @Test
    fun `describeLayout 在资源缺失时如实报告（且不抛异常）`() {
        val empty = AssetsServer(readerOf(emptyMap()))
        val layout = empty.describeLayout()
        assertTrue(layout, layout.contains("entry=missing"))
        assertTrue("应说明为什么没有目录信息：$layout", layout.contains("资源目录未找到"))
    }

    @Test
    fun `describeLayout 支持不列举的读取器（真机 AssetManager 之外的实现）`() {
        // list 有默认实现（返回空），所以只实现 read 的读取器不该崩
        val readOnly = AssetsServer(object : AssetReader {
            override fun read(path: String): ByteArray? = if (path == "index.html") ByteArray(1) else null
        })
        val layout = readOnly.describeLayout()
        assertTrue(layout, layout.contains("entry=index.html"))
        assertTrue("应提示拿不到目录信息：$layout", layout.contains("资源目录未找到"))
    }

    // ---------- 请求行解析的边界 ----------
    @Test
    fun `超长请求行被丢弃而不是撑爆内存`() {
        java.net.Socket().use { socket ->
            socket.connect(InetSocketAddress("127.0.0.1", port), 3000)
            socket.soTimeout = 3000
            val out = socket.getOutputStream()
            // 超过 8192 字符的请求行：服务端应当丢弃连接（读不到响应）
            out.write(("GET /" + "a".repeat(9000) + " HTTP/1.1\r\n\r\n").toByteArray())
            out.flush()
            val read = try {
                socket.getInputStream().read()
            } catch (_: Exception) {
                -1
            }
            assertEquals("超长请求行应被丢弃（不返回响应）", -1, read)
        }
    }

    @Test
    fun `空请求（连上就断开）不会让服务崩`() {
        java.net.Socket().use { socket ->
            socket.connect(InetSocketAddress("127.0.0.1", port), 3000)
        }
        // 服务仍然正常工作
        assertEquals(200, request("GET", "/").status)
    }
}
