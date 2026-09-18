package com.githublcb.toolcove

import android.content.res.AssetManager
import com.githublcb.toolcove.bridge.AssetPath
import java.io.BufferedOutputStream
import java.io.InputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
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
/**
 * 资源读取的抽象：`path → 字节`，读不到返回 null。
 *
 * 抽出来的理由：`AssetManager` 是 Android 类，绑死它就没法在 JVM 上测这个服务的**真实 HTTP 行为**——
 * 而这是**启动路径**（起不来或 404 就是白屏）。注入之后，JVM 测试可以用内存里的假资源
 * 起一个真服务、发真请求，把状态码/头/体/并发/关闭全部验一遍。
 */
interface AssetReader {
    fun read(path: String): ByteArray?

    /**
     * 列出目录下的条目名（`AssetManager.list` 支持；不支持时返回空）。
     *
     * 存在的理由：前端产物带**内容哈希**（`label-core-fHyB_A5r.wasm`、`index-BAwxhALA.js`），
     * 所以"探测某个确切文件名"永远会报 missing——那样的启动诊断是**假警报**，比没有更糟。
     * 按目录列举才能如实回答"资源到底有没有打进去"。
     */
    fun list(path: String): List<String> = emptyList()
}

class AssetsServer(private val reader: AssetReader) {

    /** 便捷构造：直接从 APK 的 assets 读（真机路径）。 */
    constructor(assets: AssetManager) : this(object : AssetReader {
        override fun read(path: String): ByteArray? = try {
            assets.open(path).use { it.readBytes() }
        } catch (_: Exception) {
            null
        }

        override fun list(path: String): List<String> = try {
            assets.list(path)?.toList() ?: emptyList()
        } catch (_: Exception) {
            emptyList()
        }
    })

    private var server: ServerSocket? = null

    /**
     * 处理线程池。
     *
     * ⚠️ 这里曾经是 `newFixedThreadPool(4)` + `ServerSocket(0, 8, ...)`，实测**并发 24 个请求时
     * 有 4 个被 `Connection reset`**——backlog(8) + 线程(4) 之外的连接被系统直接重置。
     * 这不是理论问题：WebView 加载一个页面会并发拉 index.html、多个 JS chunk、CSS、wasm，
     * 而每个响应都带 `Connection: close`（不能复用连接），所以并发连接数就是资源数。
     * 一旦被重置，表现就是"资源加载失败"——白屏或功能缺失，且构建完全正常。
     * 现在给足余量：浏览器对单主机通常限 6 个连接，16 线程 + 64 backlog 绰绰有余。
     */
    private val pool = Executors.newFixedThreadPool(16)
    @Volatile private var running = false

    /** 启动并返回基地址（形如 http://127.0.0.1:34567）。失败时抛异常，让调用方如实报错。 */
    fun start(): String {
        val socket = ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"))
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
                val requestLine = readRequestHead(socket.getInputStream()) ?: return
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

    /**
     * 启动时把 assets 的真实布局打进日志：装机排查时一眼能看出资源是否打进去了。
     *
     * ⚠️ 不能探测带内容哈希的确切文件名（`label-core-fHyB_A5r.wasm` 这种）——名字每次构建都变，
     * 探测它只会永远报 missing，那是**假警报**，会把人引到错误方向。
     * 所以：入口文件按候选前缀探测（名字固定），其余按**目录列举**判断"有没有这类资源"。
     */
    fun describeLayout(): String {
        val entry = AssetPath.candidatesFor("index.html").firstOrNull { reader.read(it) != null }
        val parts = mutableListOf("entry=${entry ?: "missing"}")
        // 列举可能的资源目录（同样按候选前缀：AGP 是否保留 web 目录不由我们决定）
        for (dir in AssetPath.candidatesFor("assets")) {
            val entries = reader.list(dir)
            if (entries.isEmpty()) continue
            val js = entries.count { it.endsWith(".js") }
            val css = entries.count { it.endsWith(".css") }
            val wasm = entries.count { it.endsWith(".wasm") }
            val locale = entries.count { it.contains("-") && it.endsWith(".js") && (it.startsWith("zh") || it.startsWith("en")) }
            parts += "$dir: ${entries.size} 项（js $js / css $css / wasm $wasm / locale $locale）"
        }
        if (parts.size == 1) parts += "资源目录未找到（list 不支持或产物没打进去）"
        return parts.joinToString("；")
    }

    /**
     * 读取请求头，返回请求行（第一行）。
     *
     * ⚠️ 必须**读到空行为止**（把整个请求头读完），不能只读请求行就撒手：
     * 关闭一个还有未读数据的 socket 会让内核发 **RST**，客户端在读取响应时会撞上
     * `Connection reset`。浏览器因为 Content-Length 能提前停止读取，多数时候无感——
     * 但这是实打实的缺陷：并发拉资源时表现为偶发的资源加载失败（而构建完全正常）。
     * 这一点是并发测试抓出来的（24 个并发请求里有 1 个报 Connection reset）。
     *
     * 上限 8192 字符：异常超长请求直接丢弃，不撑内存。
     */
    private fun readRequestHead(input: InputStream): String? {
        val first = StringBuilder()
        var total = 0
        var isFirstLine = true
        while (true) {
            val line = readLine(input)
            if (line == null) {
                // EOF：有请求行就照常处理（有些客户端不发送结尾空行）
                return if (first.isEmpty()) null else first.toString()
            }
            total += line.length + 2
            if (total > 8192) return null
            if (isFirstLine) {
                first.append(line)
                isFirstLine = false
            }
            // 空行 = 请求头结束，剩下的（请求体）本服务不需要
            if (line.isEmpty()) return first.toString()
        }
    }

    /** 读一行（不含 CRLF）。EOF 时返回 null。 */
    private fun readLine(input: InputStream): String? {
        val line = StringBuilder()
        while (true) {
            val b = input.read()
            if (b == -1) return if (line.isEmpty()) null else line.toString()
            if (b == '\n'.code) return line.toString()
            if (b != '\r'.code) line.append(b.toChar())
            if (line.length > 8192) return null // 防御异常超长单行
        }
    }

    /**  URL 路径 → assets 内的相对路径；规则与穿越防护见 bridge/AssetPath（那部分有单测）。 */
    private fun resolvePath(rawPath: String): String = AssetPath.resolve(rawPath)

    private fun readAsset(path: String): ByteArray? {
        if (path == AssetPath.FORBIDDEN) return null
        // 候选前缀顺序由 AssetPath 给出并可测：Android 打包 assets 时会按源集结构决定
        // 是否保留一级目录名，与其假设它一定是哪一种，不如按候选顺序找——找到就用，都不中才 404。
        // （这样即使以后 Gradle/AGP 改了合并规则，也不至于变成「装了但白屏」。）
        for (candidate in AssetPath.candidatesFor(path)) {
            reader.read(candidate)?.let { return it }
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
        val out = BufferedOutputStream(socket.getOutputStream())
        out.write(AssetPath.responseHead(status, contentType, contentLength, cors).toByteArray(Charsets.UTF_8))
        if (body.isNotEmpty()) out.write(body)
        out.flush()
    }

    private fun mimeOf(path: String): String = AssetPath.mimeOf(path)
}
