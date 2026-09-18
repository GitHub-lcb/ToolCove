package com.githublcb.toolcove

import android.content.res.AssetManager
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * 把 APK 内置的前端产物用 **loopback HTTP** 托管，WebView 加载 http://127.0.0.1:<随机端口>/。
 *
 * 为什么不直接 file:///android_asset/index.html —— 这是本工程的一个关键决定：
 *   · `file://` 是 **opaque origin**（不透明来源）：`crypto.subtle` 在部分 WebView 上不可用，
 *     而 PDF 去加密、云同步端到端加密都依赖它；
 *   · 该来源下 `<script type="module">` 的跨文件 import 会被 CORS 拒绝，前端就只能打成
 *     单文件 IIFE（牺牲懒加载与 WASM 按需加载）；
 *   · 换成 http://127.0.0.1 后是**安全上下文**，ESM、WebCrypto、WASM 全部正常。
 *
 * 安全性：只绑 127.0.0.1（外部网络不可达）、端口随机、只服务 assets/web 下的文件、
 * 路径做了 `..` 穿越防护。不监听任何公网地址，也不提供服务端逻辑。
 */
class AssetsServer(private val assets: AssetManager) {

    private var server: ServerSocket? = null
    private val pool = Executors.newFixedThreadPool(4)
    @Volatile private var running = false

    /** 启动并返回基地址（形如 http://127.0.0.1:34567）。失败时抛异常，让调用方如实报错。 */
    fun start(): String {
        val socket = ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"))
        server = socket
        running = true
        thread(name = "toolcove-assets", isDaemon = true) {
            while (running && !socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    break // 关闭时 accept 会抛，正常退出
                }
                pool.execute { handle(client) }
            }
        }
        return "http://127.0.0.1:${socket.localPort}"
    }

    fun stop() {
        running = false
        try {
            server?.close()
        } catch (_: Exception) {
        }
        pool.shutdownNow()
    }

    private fun handle(client: Socket) {
        try {
            client.use { socket ->
                socket.soTimeout = 5_000
                val requestLine = readRequestLine(socket.getInputStream()) ?: return
                val parts = requestLine.split(' ')
                if (parts.size < 2) return
                val method = parts[0]
                val rawPath = parts[1]
                // 预检请求：本服务不做跨域，但仍要如实回应，避免前端拿到「没有响应」这种模糊失败
                if (method == "OPTIONS") {
                    respond(socket, 204, "text/plain", ByteArray(0), cors = true)
                    return
                }
                if (method != "GET" && method != "HEAD") {
                    respond(socket, 405, "text/plain", "method not allowed".toByteArray(), cors = true)
                    return
                }
                val path = resolvePath(rawPath)
                val bytes = readAsset(path)
                if (bytes == null) {
                    respond(socket, 404, "text/plain", "not found: $path".toByteArray(), cors = true)
                    return
                }
                respond(socket, 200, mimeOf(path), if (method == "HEAD") ByteArray(0) else bytes, cors = true, contentLength = bytes.size)
            }
        } catch (_: Exception) {
            // 单个请求失败不影响服务；前端会看到网络错误并自行重试
        }
    }

    /** 启动时把 assets 的真实布局打进日志：装机排查时一眼能看出资源是否打进去了。 */
    fun describeLayout(): String {
        val probes = listOf("index.html", "assets", "web/index.html", "web/assets")
        val result = probes.joinToString(", ") { probe ->
            val ok = try {
                assets.open(probe).use { true }
            } catch (_: Exception) {
                false
            }
            "$probe=${if (ok) "ok" else "missing"}"
        }
        return result
    }

    private fun readRequestLine(input: InputStream): String? {
        val line = StringBuilder()
        while (true) {
            val b = input.read()
            if (b == -1) return if (line.isEmpty()) null else line.toString()
            if (b == '\n'.code) return line.toString().trim()
            if (b != '\r'.code) line.append(b.toChar())
            if (line.length > 8192) return null // 防御异常超长请求行
        }
    }

    /**  URL 路径 → assets 内的相对路径；目录请求回落 index.html，未知扩展名不乱编码。 */
    private fun resolvePath(rawPath: String): String {
        val withoutQuery = rawPath.substringBefore('?').substringBefore('#')
        val decoded = try {
            URLDecoder.decode(withoutQuery, "UTF-8")
        } catch (_: Exception) {
            withoutQuery
        }
        var path = decoded.removePrefix("/")
        if (path.isEmpty()) path = "index.html"
        if (path.endsWith("/")) path += "index.html"
        // 目录式路由（无扩展名且不带斜杠）也回落 index.html，支持前端将来加路由
        if (!path.contains('.') && !path.endsWith("index.html")) path += "/index.html"
        // 穿越防护：规范化后不允许出现 ..
        if (path.split('/').any { it == ".." }) return "__forbidden__"
        return path
    }

    private fun readAsset(path: String): ByteArray? {
        if (path == "__forbidden__") return null
        // 依次尝试几种前缀：Android 打包 assets 时会按源集结构决定是否保留一级目录名，
        // 与其假设它一定是哪一种，不如按候选顺序找——找到就用，都不中才 404。
        // （这样即使以后 Gradle/AGP 改了合并规则，也不至于变成「装了但白屏」。）
        val candidates = listOf("web/$path", path, "web/web/$path")
        for (candidate in candidates) {
            try {
                return assets.open(candidate).use { it.readBytes() }
            } catch (_: Exception) {
                // 试下一个候选
            }
        }
        return null
    }

    private fun respond(
        socket: Socket,
        status: Int,
        contentType: String,
        body: ByteArray,
        cors: Boolean,
        contentLength: Int = body.size,
    ) {
        val reason = when (status) {
            200 -> "OK"
            204 -> "No Content"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            else -> "OK"
        }
        val head = buildString {
            append("HTTP/1.1 $status $reason\r\n")
            append("Content-Type: $contentType\r\n")
            append("Content-Length: $contentLength\r\n")
            // 前端产物带内容哈希，但 index.html 不带：统一 no-cache，避免升级后仍旧页面
            append("Cache-Control: no-cache\r\n")
            if (cors) append("Access-Control-Allow-Origin: *\r\n")
            append("Connection: close\r\n\r\n")
        }
        val out = BufferedOutputStream(socket.getOutputStream())
        out.write(head.toByteArray(Charsets.UTF_8))
        if (body.isNotEmpty()) out.write(body)
        out.flush()
    }

    private fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json" -> "application/json; charset=utf-8"
        "wasm" -> "application/wasm"
        "svg" -> "image/svg+xml"
        "png" -> "image/png"
        "jpg", "jpeg" -> "image/jpeg"
        "webp" -> "image/webp"
        "ico" -> "image/x-icon"
        "woff2" -> "font/woff2"
        "txt", "md" -> "text/plain; charset=utf-8"
        else -> "application/octet-stream"
    }
}
