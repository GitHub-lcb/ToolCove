package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.DownloadKit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 云端照片下载的安全边界单测（纯 JVM）。
 *
 * 测的不是「能不能下载」，而是**拒绝哪些请求**：地址策略松掉 = 页面（或注入脚本）
 * 能让原生拉任意 URL 写进用户下载目录；文件名不净化 = 能把内容写到下载目录之外。
 */
class DownloadKitTest {

    // ---------- 地址策略 ----------
    @Test
    fun `只接受 https 与本机回环`() {
        assertTrue(DownloadKit.isAllowedUrl("https://s3-cn-south-1.qiniucs.com/luqian520/photos/a.jpg"))
        assertTrue(DownloadKit.isAllowedUrl("https://cdn.example.com/a.jpg?e=1&token=AK:sign"))
        // 本机补头转发（docs/photo-relay.md）走的是回环 http
        assertTrue(DownloadKit.isAllowedUrl("http://127.0.0.1:8127/"))
        assertTrue(DownloadKit.isAllowedUrl("http://localhost:8127/"))
    }

    @Test
    fun `拒绝 http 明文 file 与协议相对地址`() {
        assertFalse(DownloadKit.isAllowedUrl("http://cdn.example.com/a.jpg"))
        assertFalse(DownloadKit.isAllowedUrl("file:///etc/passwd"))
        assertFalse(DownloadKit.isAllowedUrl("//cdn.example.com/a.jpg"))
        assertFalse(DownloadKit.isAllowedUrl("https://"))
        assertFalse(DownloadKit.isAllowedUrl(""))
    }

    // ---------- 文件名净化 ----------
    @Test
    fun `去掉路径成分与控制字符`() {
        assertEquals("a.jpg", DownloadKit.safeFileName("../../a.jpg"))
        assertEquals("a.jpg", DownloadKit.safeFileName("photos\\2026\\a.jpg"))
        assertEquals("a_b.jpg", DownloadKit.safeFileName("a:b.jpg"))
        // 控制字符（NUL 之类）换成下划线，而不是直接删掉——删掉会让 `a\u0000.jpg` 与 `a.jpg` 撞成同名
        assertEquals("a_.jpg", DownloadKit.safeFileName("a\u0000.jpg"))
    }

    @Test
    fun `空名与纯点名回落到默认名`() {
        assertEquals("photo", DownloadKit.safeFileName(""))
        assertEquals("photo", DownloadKit.safeFileName(".."))
        assertEquals("photo", DownloadKit.safeFileName("/"))
        assertEquals("fallback.png", DownloadKit.safeFileName("", "fallback.png"))
    }

    @Test
    fun `超长名截断但不留空`() {
        val long = "x".repeat(400) + ".jpg"
        val safe = DownloadKit.safeFileName(long)
        assertTrue(safe.length <= 120)
        assertFalse(safe.isEmpty())
    }

    // ---------- 落盘位置 ----------
    @Test
    fun `图片进相册 其余进下载目录`() {
        // 真机反馈「下载完不知道文件在哪」：照片必须能在相册里找到
        assertTrue(DownloadKit.isImage("image/jpeg", "a.jpg"))
        assertTrue(DownloadKit.isImage("", "a.PNG"))
        assertTrue(DownloadKit.isImage("application/octet-stream", "a.heic"))
        assertFalse(DownloadKit.isImage("application/pdf", "a.pdf"))
        assertFalse(DownloadKit.isImage("application/octet-stream", "a.bin"))
        assertFalse(DownloadKit.isImage("video/mp4", "a.mp4"))
        assertEquals("ToolCove", DownloadKit.FOLDER)
    }

    // ---------- 重名 ----------
    @Test
    fun `重名补序号且保留扩展名`() {
        val taken = setOf("a.jpg", "a (1).jpg")
        assertEquals("a (2).jpg", DownloadKit.uniqueName("a.jpg") { it in taken })
        assertEquals("b.jpg", DownloadKit.uniqueName("b.jpg") { it in taken })
        assertEquals("noext (1)", DownloadKit.uniqueName("noext") { it == "noext" })
    }
}
