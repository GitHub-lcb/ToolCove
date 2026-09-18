package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.AssetPath
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 内置资源服务的路径/MIME/响应头逻辑单测（纯 JVM）。
 *
 * 这段逻辑此前埋在 AssetsServer 里**完全没有测试**，而它恰好是两类事故的所在地：
 *   · **路径穿越**（安全）：必须在**解码之后**判断 `..`，否则 `%2e%2e%2f` 能绕过去；
 *   · **候选前缀顺序**（可用性）：曾经因为假设错了一种资源布局，打出过 645KB 的**空壳包**
 *     ——装上能启动、打开是白屏。顺序必须显式可测，而不是散在 try/catch 里靠猜。
 */
class AssetPathTest {

    // ---------- 常规路径 ----------
    @Test
    fun `根路径与空路径都落到 index_html`() {
        assertEquals("index.html", AssetPath.resolve("/"))
        assertEquals("index.html", AssetPath.resolve(""))
        assertEquals("index.html", AssetPath.resolve("/index.html"))
    }

    @Test
    fun `目录请求补 index_html`() {
        assertEquals("assets/index.html", AssetPath.resolve("/assets/"))
        assertEquals("a/b/index.html", AssetPath.resolve("/a/b/"))
    }

    @Test
    fun `无扩展名的路径当作目录式路由`() {
        // 前端将来加路由时，刷新 /settings 不该 404
        assertEquals("settings/index.html", AssetPath.resolve("/settings"))
        assertEquals("a/b/index.html", AssetPath.resolve("/a/b"))
    }

    @Test
    fun `带扩展名的路径原样保留`() {
        assertEquals("assets/index-BAwxhALA.js", AssetPath.resolve("/assets/index-BAwxhALA.js"))
        assertEquals("label-core.wasm", AssetPath.resolve("/label-core.wasm"))
        assertEquals("styles/shell.css", AssetPath.resolve("/styles/shell.css"))
    }

    @Test
    fun `query 与 hash 都要去掉`() {
        assertEquals("index.html", AssetPath.resolve("/index.html?v=2"))
        assertEquals("a.js", AssetPath.resolve("/a.js#frag"))
        assertEquals("a.js", AssetPath.resolve("/a.js?v=1#frag"))
    }

    @Test
    fun `百分号编码会被解码（中文文件名与空格）`() {
        assertEquals("订单.json", AssetPath.resolve("/%E8%AE%A2%E5%8D%95.json"))
        assertEquals("a b.js", AssetPath.resolve("/a%20b.js"))
    }

    // ---------- 穿越防护（安全） ----------
    @Test
    fun `明文穿越必须被拦住`() {
        assertEquals(AssetPath.FORBIDDEN, AssetPath.resolve("/../secret"))
        assertEquals(AssetPath.FORBIDDEN, AssetPath.resolve("/a/../../b"))
        assertEquals(AssetPath.FORBIDDEN, AssetPath.resolve("../../etc/passwd"))
    }

    @Test
    fun `编码后的穿越也要拦住（必须在解码之后判断）`() {
        // 这是最容易漏的一种：先判断再解码的话，%2e%2e%2f 会绕过去
        assertEquals("编码的 .. 必须被拦", AssetPath.FORBIDDEN, AssetPath.resolve("/%2e%2e%2fsecret"))
        assertEquals(AssetPath.FORBIDDEN, AssetPath.resolve("/%2E%2E/secret"))
        assertEquals(AssetPath.FORBIDDEN, AssetPath.resolve("/a/%2e%2e/%2e%2e/b"))
    }

    @Test
    fun `反斜杠也拦（不依赖平台细节）`() {
        // Android 的 assets 用 / 分隔，..\foo 其实跳不出去；但拦住比解释为什么安全更省心
        assertEquals(AssetPath.FORBIDDEN, AssetPath.resolve("/..\\secret"))
        assertTrue(AssetPath.isTraversal("a\\b"))
    }

    @Test
    fun `正常路径不会被误判为穿越`() {
        assertFalse(AssetPath.isTraversal("index.html"))
        assertFalse(AssetPath.isTraversal("assets/index.js"))
        // 名字里含两个点但不是 .. 段
        assertFalse(AssetPath.isTraversal("a..b/c.js"))
        assertFalse(AssetPath.isTraversal(".../x"))
    }

    @Test
    fun `坏编码不致命（解码失败用原文）`() {
        // 一个坏编码不该让整个请求崩掉；结果不合法也没关系，readAsset 会 404
        val result = AssetPath.resolve("/%E4%B8")
        assertTrue("不该抛异常", result.isNotEmpty())
    }

    // ---------- 候选前缀顺序（白屏事故） ----------
    @Test
    fun `候选顺序：web 前缀优先，然后是裸路径与双层兜底`() {
        val candidates = AssetPath.candidatesFor("index.html")
        assertEquals(listOf("web/index.html", "index.html", "web/web/index.html"), candidates)
        // 顺序不能变：AGP 合并 assets 时保留 web 这一级，先试它命中率最高
        assertEquals("web/index.html", candidates.first())
    }

    @Test
    fun `候选覆盖三种可能的资源布局（换 AGP 版本也不白屏）`() {
        val candidates = AssetPath.candidatesFor("assets/a.js")
        // 三种布局：保留一级目录名 / 不保留 / 保留两层
        assertTrue(candidates.contains("web/assets/a.js"))
        assertTrue(candidates.contains("assets/a.js"))
        assertTrue(candidates.contains("web/web/assets/a.js"))
        assertEquals(3, candidates.size)
    }

    // ---------- MIME ----------
    @Test
    fun `wasm 的 MIME 必须是 application wasm`() {
        // 报错的话 instantiateStreaming 会直接拒绝加载——标签引擎就废了
        assertEquals("application/wasm", AssetPath.mimeOf("label-core.wasm"))
        assertEquals("application/wasm", AssetPath.mimeOf("a/b/LABEL.WASM"))
    }

    @Test
    fun `js 与 mjs 都要能被当模块执行`() {
        for (path in listOf("a.js", "a.mjs", "assets/index-BAwxhALA.js")) {
            assertEquals(path, "text/javascript; charset=utf-8", AssetPath.mimeOf(path))
        }
    }

    @Test
    fun `文本类型带 utf-8 中文才不会乱码`() {
        assertEquals("text/html; charset=utf-8", AssetPath.mimeOf("index.html"))
        assertEquals("text/css; charset=utf-8", AssetPath.mimeOf("shell.css"))
        assertEquals("application/json; charset=utf-8", AssetPath.mimeOf("zh-CN.json"))
        assertEquals("text/plain; charset=utf-8", AssetPath.mimeOf("README.md"))
    }

    @Test
    fun `图片与字体类型`() {
        assertEquals("image/png", AssetPath.mimeOf("a.png"))
        assertEquals("image/jpeg", AssetPath.mimeOf("a.jpg"))
        assertEquals("image/jpeg", AssetPath.mimeOf("a.jpeg"))
        assertEquals("image/webp", AssetPath.mimeOf("a.webp"))
        assertEquals("image/svg+xml", AssetPath.mimeOf("a.svg"))
        assertEquals("image/x-icon", AssetPath.mimeOf("favicon.ico"))
        assertEquals("font/woff2", AssetPath.mimeOf("a.woff2"))
    }

    @Test
    fun `未知扩展名回落 octet-stream（不瞎猜）`() {
        assertEquals("application/octet-stream", AssetPath.mimeOf("a.bin"))
        assertEquals("application/octet-stream", AssetPath.mimeOf("noextension"))
        assertEquals("application/octet-stream", AssetPath.mimeOf(""))
    }

    @Test
    fun `大小写不敏感`() {
        assertEquals("text/html; charset=utf-8", AssetPath.mimeOf("INDEX.HTML"))
        assertEquals("image/png", AssetPath.mimeOf("A.PNG"))
    }

    // ---------- 响应头 ----------
    @Test
    fun `响应头包含长度 类型 与 no-cache`() {
        val head = AssetPath.responseHead(200, "text/html; charset=utf-8", 1234, cors = true)
        assertTrue(head.startsWith("HTTP/1.1 200 OK\r\n"))
        assertTrue("Content-Length 必须是真实字节数", head.contains("Content-Length: 1234\r\n"))
        assertTrue(head.contains("Content-Type: text/html; charset=utf-8\r\n"))
        // 前端产物带内容哈希但 index.html 不带：不 no-cache 会出现"升级后仍旧页面"
        assertTrue(head.contains("Cache-Control: no-cache\r\n"))
        assertTrue(head.contains("Access-Control-Allow-Origin: *\r\n"))
        assertTrue("头部必须以空行结束", head.endsWith("\r\n\r\n"))
    }

    @Test
    fun `HEAD 请求：长度为 0 时仍要写真实长度`() {
        // HEAD 的 body 是空的，但 Content-Length 必须是被请求文件的真实大小，
        // 否则浏览器会以为文件是空的（前端据此判断资源是否存在）
        val head = AssetPath.responseHead(200, "text/javascript; charset=utf-8", 4567, cors = true)
        assertTrue(head.contains("Content-Length: 4567\r\n"))
    }

    @Test
    fun `各状态码的 reason 正确`() {
        assertTrue(AssetPath.responseHead(200, "text/plain", 0, false).startsWith("HTTP/1.1 200 OK"))
        assertTrue(AssetPath.responseHead(204, "text/plain", 0, false).startsWith("HTTP/1.1 204 No Content"))
        assertTrue(AssetPath.responseHead(404, "text/plain", 0, false).startsWith("HTTP/1.1 404 Not Found"))
        assertTrue(AssetPath.responseHead(405, "text/plain", 0, false).startsWith("HTTP/1.1 405 Method Not Allowed"))
    }

    @Test
    fun `不开 CORS 时没有那个头`() {
        val head = AssetPath.responseHead(404, "text/plain", 0, cors = false)
        assertFalse(head.contains("Access-Control-Allow-Origin"))
    }
}
