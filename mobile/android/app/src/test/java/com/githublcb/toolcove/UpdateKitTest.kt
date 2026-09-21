package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.UpdateKit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * 自动更新的安全边界单测（纯 JVM）。
 *
 * 这里测的不是"能不能更新"，而是**拒绝哪些请求**。四条规则一旦松掉，后果分别是：
 *  1. 任意 URL 下载 → 清单被改就能让 App 拉任意文件去装
 *  2. 不校验哈希 → 资产被替换 / 中间人 = 任意代码执行
 *  3. 安装路径不约束 → 桥（对 WebView 半可信）能把安装器指到任意可读文件
 *  4. versionCode 与 gradle 不一致 → "清单说有新版本、安卓按更旧的包拒绝安装"
 */
class UpdateKitTest {

    // ---------- 下载域白名单 ----------
    @Test
    fun `只认 GitHub Release 下载域`() {
        assertTrue(UpdateKit.isAllowedUrl("https://github.com/o/r/releases/download/apk-v1.1.0/a.apk"))
        assertTrue(UpdateKit.isAllowedUrl("https://objects.githubusercontent.com/x/y/z"))
        assertTrue(UpdateKit.isAllowedUrl("https://release-assets.githubusercontent.com/x"))
        assertFalse("自有域名之外一律拒绝", UpdateKit.isAllowedUrl("https://example.com/a.apk"))
        assertFalse(UpdateKit.isAllowedUrl("https://github.com.evil.test/x"))
        assertFalse(UpdateKit.isAllowedUrl("ftp://github.com/a.apk"))
        assertFalse("必须是 https", UpdateKit.isAllowedUrl("http://github.com/a.apk"))
        assertFalse(UpdateKit.isAllowedUrl(""))
        assertFalse(UpdateKit.isAllowedUrl("https:///broken"))
    }

    // ---------- SHA-256 ----------
    @Test
    fun `哈希计算与安卓侧一致的十六进制形式`() {
        // 空串的 SHA-256 是公开常量，用它核对"小写、64 位、无前缀"
        assertEquals(
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            UpdateKit.sha256Hex(ByteArray(0)),
        )
    }

    @Test
    fun `校验通过要求完整匹配，缺哈希等于不通过`() {
        val bytes = "toolcove".toByteArray()
        val good = UpdateKit.sha256Hex(bytes)
        assertTrue(UpdateKit.verifySha256(bytes, good))
        assertTrue("大小写不敏感", UpdateKit.verifySha256(bytes, good.uppercase()))
        assertFalse("没给哈希不能当成免检", UpdateKit.verifySha256(bytes, ""))
        assertFalse(UpdateKit.verifySha256(bytes, good.dropLast(1)))
        assertFalse(UpdateKit.verifySha256(bytes, "0".repeat(64)))
        assertFalse(UpdateKit.verifySha256("别的内容".toByteArray(), good))
    }

    // ---------- 安装路径约束 ----------
    @Test
    fun `安装包只能在 cache 目录的 apk 子目录里`() {
        val cache = File(System.getProperty("java.io.tmpdir"), "tc-update-test-${System.nanoTime()}")
        val dir = File(cache, UpdateKit.APK_DIR).apply { mkdirs() }
        val apk = File(dir, "update.apk").apply { writeBytes("x".toByteArray()) }
        assertNotNull(UpdateKit.resolveApkFile(cache, apk.absolutePath))

        val outside = File(cache, "secret.apk").apply { writeBytes("y".toByteArray()) }
        assertNull("目录外的文件一律拒绝", UpdateKit.resolveApkFile(cache, outside.absolutePath))

        val sibling = File(cache.parentFile, "tc-update-victim.apk").apply { writeBytes("z".toByteArray()) }
        assertNull(UpdateKit.resolveApkFile(cache, sibling.absolutePath))
        assertNull("不存在的路径不返回文件", UpdateKit.resolveApkFile(cache, File(dir, "nope.apk").absolutePath))

        cache.deleteRecursively()
        sibling.delete()
    }

    @Test
    fun `拼接式逃逸路径不能越过目录边界`() {
        val cache = File(System.getProperty("java.io.tmpdir"), "tc-update-escape-${System.nanoTime()}")
        val dir = File(cache, UpdateKit.APK_DIR).apply { mkdirs() }
        File(dir, "real.apk").writeBytes("x".toByteArray())
        // 字符串上以 <cache>/apk/ 开头，规范化之后就跑到外面去了——所以必须比规范路径
        val tricky = File(dir, "real.apk").absolutePath + "/../../evil"
        assertNull(UpdateKit.resolveApkFile(cache, tricky))
        cache.deleteRecursively()
    }

    @Test
    fun `下载落点由原生决定，文件名里的目录穿越会被剥掉`() {
        val cache = File(System.getProperty("java.io.tmpdir"), "tc-update-name-${System.nanoTime()}")
        val path = UpdateKit.apkPathFor(cache, "../../evil.apk")
        assertTrue(path.replace('\\', '/').contains("/${UpdateKit.APK_DIR}/evil.apk"))
        assertFalse("不允许出现 .. 段", File(path).normalize().path.contains(".."))
        cache.deleteRecursively()
    }

    // ---------- versionCode ----------
    @Test
    fun `versionCode 编码与 gradle 脚本一致`() {
        assertEquals(10000, UpdateKit.versionCode("1.0.0"))
        assertEquals(10100, UpdateKit.versionCode("1.1.0"))
        assertEquals(10203, UpdateKit.versionCode("1.2.3"))
        assertEquals(110000, UpdateKit.versionCode("11.0.0"))
        // 缺位补 0：清单里写 "1.2" 也算 1.2.0
        assertEquals(10200, UpdateKit.versionCode("1.2"))
        assertEquals(0, UpdateKit.versionCode(""))
    }

    @Test
    fun `更新清单地址是安卓自己的通道，不含 releases-latest`() {
        // 桌面端 updater 占用了 releases/latest/download/latest.json，安卓抢它就会断掉所有人的自动更新
        assertTrue(UpdateKit.MANIFEST_URL.startsWith("https://github.com/"))
        assertTrue(UpdateKit.MANIFEST_URL.contains("/releases/download/apk-latest/"))
        assertFalse(UpdateKit.MANIFEST_URL.contains("releases/latest"))
    }
}
