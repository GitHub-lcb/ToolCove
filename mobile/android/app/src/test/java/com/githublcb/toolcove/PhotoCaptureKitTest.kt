package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.PhotoCaptureKit
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.FileNotFoundException

/**
 * 拍照落点的安全边界单测（纯 JVM）。
 *
 * 这里测的是"相机被允许写到哪、以及写不进去时拒绝得干不干净"——
 * Provider 把它暴露给系统相机（一个不受我们控制的外部进程），文件名是唯一的把手：
 * 一旦形状校验松了，一个手改的 URI 就能把相机指到缓存目录之外的任意路径。
 */
class PhotoCaptureKitTest {

    @get:Rule
    val temp = TemporaryFolder()

    // ---------- 文件名形状 ----------
    @Test
    fun `名字是本应用生成的毫秒时间戳形状`() {
        val name = PhotoCaptureKit.newCaptureName(1_700_000_000_000L)
        assertEquals("capture-1700000000000.jpg", name)
        assertTrue(PhotoCaptureKit.isCaptureName(name))
    }

    @Test
    fun `只认 capture-数字_jpg，其余一律拒绝`() {
        assertTrue(PhotoCaptureKit.isCaptureName("capture-1700000000000.jpg"))
        assertFalse("后缀不对", PhotoCaptureKit.isCaptureName("capture-1700000000000.png"))
        assertFalse("前缀不对", PhotoCaptureKit.isCaptureName("photo-1700000000000.jpg"))
        assertFalse("非数字", PhotoCaptureKit.isCaptureName("capture-abcdefghij.jpg"))
        assertFalse("空名", PhotoCaptureKit.isCaptureName(""))
        assertFalse("带目录段", PhotoCaptureKit.isCaptureName("sub/capture-1700000000000.jpg"))
    }

    // ---------- 路径约束 ----------
    @Test
    fun `合法名字解析到缓存目录内的 camera 子目录`() {
        val cache = temp.newFolder("cache")
        val file = PhotoCaptureKit.resolveCaptureFile(cache, "capture-1700000000000.jpg")
        assertEquals(File(cache, "camera/capture-1700000000000.jpg").canonicalFile, file)
    }

    @Test
    fun `越界与非法名字必须抛 FileNotFoundException`() {
        val cache = temp.newFolder("cache")
        val bad = listOf("../x.jpg", "..%2Fx.jpg", "capture-1700000000000.jpg/../../x.jpg", "evil.jpg", "capture-1.jpg", "")
        for (name in bad) {
            val threw = try {
                PhotoCaptureKit.resolveCaptureFile(cache, name)
                false
            } catch (e: FileNotFoundException) {
                true
            }
            assertTrue("应拒绝：$name", threw)
        }
    }

    // ---------- 过期清理 ----------
    @Test
    fun `过期临时文件被清理，新鲜文件保留`() {
        val cache = temp.newFolder("cache")
        val dir = PhotoCaptureKit.captureDir(cache)
        val old = File(dir, "capture-1000000000000.jpg").apply { writeBytes(byteArrayOf(1)) }
        val fresh = File(dir, "capture-1700000000000.jpg").apply { writeBytes(byteArrayOf(1)) }
        old.setLastModified(1_700_000_000_000L - PhotoCaptureKit.MAX_AGE_MILLIS - 1000)
        fresh.setLastModified(1_700_000_000_000L - 1000)

        PhotoCaptureKit.pruneStale(cache, now = 1_700_000_000_000L)

        assertFalse("过期文件应删除", old.exists())
        assertTrue("新鲜文件应保留", fresh.exists())
    }

    @Test
    fun `目录不存在时清理不报错`() {
        PhotoCaptureKit.pruneStale(temp.newFolder("empty"), now = 1_700_000_000_000L)
    }
}
