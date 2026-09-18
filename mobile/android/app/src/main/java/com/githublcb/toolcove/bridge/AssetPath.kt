package com.githublcb.toolcove.bridge

/**
 * 内置资源服务的**纯逻辑**部分：URL 路径 → assets 路径、扩展名 → MIME、候选前缀顺序。
 *
 * 为什么抽出来：这段逻辑此前埋在 AssetsServer 里，**完全没有测试**——而它恰好是
 * 两类事故的所在地：
 *   1) **路径穿越**（安全）：`..` 必须被拦住，且要在**解码之后**判断，
 *      否则 `%2e%2e%2f` 这类编码能绕过去；
 *   2) **候选前缀顺序**（可用性）：Android 打包 assets 时会按源集结构决定是否保留一级目录名，
 *      曾经因为假设错了一种，打出过 645KB 的**空壳包**——装上能启动、打开是白屏。
 *      所以候选顺序必须显式可测，而不是散在 try/catch 里靠猜。
 *
 * 无 Android 依赖 → 可用纯 JVM 测（与 bridge 里其它部分一致）。
 */
object AssetPath {

    /** 穿越防护的哨兵值：调用方据此返回 404（而不是去 open 一个危险路径）。 */
    const val FORBIDDEN = "__forbidden__"

    /**
     * 读取资源时的候选前缀顺序。
     *
     * 顺序有讲究：`web/` 优先——因为 `app/build.gradle` 的 syncWebAssets 把产物放在
     * `build/generated/webAssets/web` 下，而 AGP 合并 assets 时会保留 `web` 这一级。
     * 后面两个是兜底：万一以后 AGP 改了合并规则（不保留目录名 / 保留两层），也不至于白屏。
     */
    fun candidatesFor(path: String): List<String> = listOf("web/$path", path, "web/web/$path")

    /**
     * URL 路径 → assets 内的相对路径。
     *
     * 规则：
     *   · 去掉 query 与 hash；百分号解码（解码失败则用原文，不让一个坏编码把请求打死）；
     *   · 去前导 `/`；空路径 → `index.html`；
     *   · 以 `/` 结尾 → 补 `index.html`（目录请求）；
     *   · **不含点且不是 index.html** → 当作目录式路由，补 `/index.html`
     *     （这样前端将来加路由时刷新页面不会 404）；
     *   · 最后做穿越检查：按 `/` 切分后任一段等于 `..` 就返回 [FORBIDDEN]。
     */
    fun resolve(rawPath: String): String {
        val withoutQuery = rawPath.substringBefore('?').substringBefore('#')
        val decoded = try {
            java.net.URLDecoder.decode(withoutQuery, "UTF-8")
        } catch (_: Exception) {
            withoutQuery
        }
        var path = decoded.removePrefix("/")
        if (path.isEmpty()) path = "index.html"
        if (path.endsWith("/")) path += "index.html"
        if (!path.contains('.') && !path.endsWith("index.html")) path += "/index.html"
        if (isTraversal(path)) return FORBIDDEN
        return path
    }

    /**
     * 是否包含向上跳目录的段。
     *
     * 只按 `/` 切分：assets 的路径分隔符就是 `/`，反斜杠在 Android 上是普通字符
     * （`..\foo` 只会被当成一个不存在的文件名，不会跳出目录）。
     * 反斜杠也一并拦掉是为了**不依赖那个平台细节**——拦住比解释为什么安全更省心。
     */
    fun isTraversal(path: String): Boolean =
        path.split('/').any { it == ".." } || path.contains('\\')

    /** 扩展名 → Content-Type。MIME 报错会让浏览器拒绝执行（尤其 wasm 必须是 application/wasm）。 */
    fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
        "html" -> "text/html; charset=utf-8"
        "js", "mjs" -> "text/javascript; charset=utf-8"
        "css" -> "text/css; charset=utf-8"
        "json" -> "application/json; charset=utf-8"
        // wasm 的 MIME 必须是 application/wasm，否则 instantiateStreaming 会拒绝
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

    /**
     * HTTP 响应头。
     *
     * 抽出来是为了能测：Content-Length 必须等于**真实字节数**（HEAD 请求传 0 时也要写真实长度，
     * 否则浏览器会以为文件是空的）；Cache-Control 统一 no-cache——前端产物带内容哈希，
     * 但 index.html 不带，不 no-cache 会出现"升级后仍是旧页面"。
     */
    fun responseHead(status: Int, contentType: String, contentLength: Int, cors: Boolean): String {
        val reason = when (status) {
            200 -> "OK"
            204 -> "No Content"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            else -> "OK"
        }
        return buildString {
            append("HTTP/1.1 $status $reason\r\n")
            append("Content-Type: $contentType\r\n")
            append("Content-Length: $contentLength\r\n")
            append("Cache-Control: no-cache\r\n")
            if (cors) append("Access-Control-Allow-Origin: *\r\n")
            append("Connection: close\r\n\r\n")
        }
    }
}
