package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.FileCodec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.charset.Charset

/**
 * 文本编解码内核单测（纯 JVM）。
 *
 * 这一层必须**与桌面端 Rust 侧语义一致**：同一个文件在两端读出来不一样（编码判定不同、
 * BOM 处理不同），排查时会被误导。所以用例覆盖判定顺序与各种边界，等价于给"两端一致"上锁。
 */
class FileCodecTest {

    private val gbk: Charset? = runCatching { Charset.forName("GBK") }.getOrNull()

    // ---------- UTF-8 ----------
    @Test
    fun `UTF-8 无 BOM 往返`() {
        val text = "第一行\nsecond line\t混合 content"
        val bytes = FileCodec.encode(text, "UTF-8")
        val decoded = FileCodec.decode(bytes)
        assertEquals(text, decoded.text)
        assertEquals("UTF-8", decoded.encoding)
        assertFalse(decoded.hasBom)
        assertFalse(decoded.lossy)
    }

    @Test
    fun `UTF-8 带 BOM 要识别并去掉`() {
        val bytes = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + "带 BOM 的内容".toByteArray(Charsets.UTF_8)
        val decoded = FileCodec.decode(bytes)
        assertEquals("带 BOM 的内容", decoded.text)
        assertEquals("UTF-8", decoded.encoding)
        assertTrue(decoded.hasBom)
        // BOM 不能被当成内容开头（否则界面上会多一个看不见的字符）
        assertFalse(decoded.text.startsWith("\uFEFF"))
    }

    @Test
    fun `写回时可选是否带 BOM`() {
        val withBom = FileCodec.encode("x", "UTF-8", bom = true)
        assertArrayEquals(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte(), 'x'.code.toByte()), withBom)
        assertArrayEquals(byteArrayOf('x'.code.toByte()), FileCodec.encode("x", "UTF-8", bom = false))
    }

    // ---------- UTF-16 ----------
    @Test
    fun `UTF-16LE 与 BE 带 BOM 都能识别`() {
        for (encoding in listOf("UTF-16LE", "UTF-16BE")) {
            val text = "UTF-16 中文 abc"
            val bytes = FileCodec.encode(text, encoding, bom = true)
            val decoded = FileCodec.decode(bytes)
            assertEquals(encoding, decoded.encoding)
            assertEquals(text, decoded.text)
            assertTrue(decoded.hasBom)
        }
    }

    @Test
    fun `无 BOM 的 UTF-16 靠零字节分布判定字节序`() {
        // ⚠️ 样本要让「奇数位零字节」占绝对多数：
        //   · 纯 ASCII 的 UTF-16 是合法 UTF-8（0x00 合法），会先命中 UTF-8 判定；
        //   · 中文的 UTF-16 第二字节非零（如 '中' = 2D 4E），比例不够会被判成 GBK。
        // 这条用「ASCII 为主 + 少量中文」的样本，正是启发式设计的目标场景（与 Rust 侧同一阈值）。
        val text = "hello 中文 world 这里是测试样本 hello world"
        val le = text.toByteArray(Charsets.UTF_16LE)
        val be = text.toByteArray(Charsets.UTF_16BE)
        assertEquals("UTF-16LE", FileCodec.decode(le).encoding)
        assertEquals("UTF-16BE", FileCodec.decode(be).encoding)
        assertEquals(text, FileCodec.decode(le).text)
        assertEquals(text, FileCodec.decode(be).text)
    }

    @Test
    fun `纯 ASCII 的 UTF-16 会被判成 UTF-8（与桌面端一致 刻意记录）`() {
        // 这不是 bug：无 BOM 时的短文本本就是歧义的，两端都按"合法 UTF-8 优先"处理。
        // 写成用例是为了让这个行为**可见**——将来要改就得两端一起改。
        val ascii = "hello world test".toByteArray(Charsets.UTF_16LE)
        assertEquals("UTF-8", FileCodec.decode(ascii).encoding)
    }

    // ---------- GBK ----------
    @Test
    fun `GBK 内容会被判定为 GBK 而不是 UTF-8 乱码`() {
        if (gbk == null) return // 个别 JVM 没有 GBK，跳过而不是误报失败
        val text = "中文内容测试"
        val bytes = text.toByteArray(gbk)
        val decoded = FileCodec.decode(bytes)
        assertEquals("GBK", decoded.encoding)
        assertEquals(text, decoded.text)
        assertFalse("GBK 内容应该解得出来，不该 lossy", decoded.lossy)
    }

    @Test
    fun `指定 GBK 解码时不做自动判定`() {
        if (gbk == null) return
        val bytes = "中文".toByteArray(gbk)
        assertEquals("中文", FileCodec.decode(bytes, "GBK").text)
    }

    // ---------- 显式编码与错误 ----------
    @Test
    fun `指定不支持的编码要明确报错`() {
        val failed = runCatching { FileCodec.decode("x".toByteArray(), "SHIFT-JIS") }
        assertTrue(failed.isFailure)
        assertTrue(failed.exceptionOrNull()?.message?.contains("不支持") == true)
    }

    @Test
    fun `编码名大小写与空格都能容忍`() {
        val bytes = "abc".toByteArray(Charsets.UTF_8)
        assertEquals("UTF-8", FileCodec.decode(bytes, " utf-8 ").encoding)
        assertEquals("UTF-8", FileCodec.decode(bytes, "auto").encoding)
        assertEquals("UTF-8", FileCodec.decode(bytes, "").encoding)
    }

    @Test
    fun `坏字节不抛错 而是替换并标记 lossy`() {
        // 0xFF 单独出现是**非法 UTF-8**（0xC3 0x28 其实是合法的：0x28 是合法续字节，别拿它当坏数据）
        val broken = byteArrayOf('a'.code.toByte(), 0xFF.toByte(), 'b'.code.toByte())
        val decoded = FileCodec.decode(broken, "UTF-8")
        assertTrue("内容不合法时只是内容不合法，不该让读文件失败", decoded.text.startsWith("a"))
        assertTrue("要如实标记 lossy，界面才能提示内容可能不完整", decoded.lossy)
    }

    @Test
    fun `合法内容不会被误标 lossy`() {
        val decoded = FileCodec.decode("完全合法 utf8 中文".toByteArray(Charsets.UTF_8), "UTF-8")
        assertFalse("误标 lossy 会让用户以为文件坏了", decoded.lossy)
    }

    // ---------- 边界 ----------
    @Test
    fun `空文件与纯 BOM 文件`() {
        assertEquals("", FileCodec.decode(ByteArray(0)).text)
        assertEquals("", FileCodec.decode(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())).text)
    }

    @Test
    fun `单字节与超短输入不会崩在启发式上`() {
        assertEquals("a", FileCodec.decode(byteArrayOf('a'.code.toByte())).text)
        // 2 字节的 0x00 0x41：pairs 只有 1，不该被误判成 UTF-16（Rust 侧要求 pairs > 2）
        val short = byteArrayOf(0x00, 'A'.code.toByte())
        assertTrue(FileCodec.decode(short).encoding.isNotEmpty())
    }

    @Test
    fun `大文本往返不丢内容`() {
        val text = buildString { repeat(5000) { append("行 $it 中文\n") } }
        assertEquals(text, FileCodec.decode(FileCodec.encode(text, "UTF-8")).text)
    }

    @Test
    fun `GBK 没有 BOM 概念 写了也不加`() {
        if (gbk == null) return
        val bytes = FileCodec.encode("中文", "GBK", bom = true)
        assertFalse("给 GBK 加 BOM 会让别的程序读错", bytes.size >= 2 && bytes[0] == 0xEF.toByte() && bytes[1] == 0xBB.toByte())
    }

    // ---------- 文件名 ----------
    @Test
    fun `从 SAF URI 里取显示名`() {
        // SAF 的 document id：真实路径分隔符是被编码成 %2F 的，必须先整体解码再取末段
        assertEquals("order.json", FileCodec.displayName("content://com.android.providers.downloads/document/primary%3ADownload%2Forder.json"))
        assertEquals("order.json", FileCodec.displayName("content://x/document/1234%3Aorder.json"))
        assertEquals("a.txt", FileCodec.displayName("content://x/a.txt?query=1"))
        // 带中文的文件名（编码后解码）
        assertEquals("订单.json", FileCodec.displayName("content://x/document/primary%3A%E8%AE%A2%E5%8D%95.json"))
        // 只有 URI 本身取不出任何末段时（空串、纯 scheme）才兜底
        assertEquals("x", FileCodec.displayName("content://x/"))
        assertEquals("自定义", FileCodec.displayName("", fallback = "自定义"))
        assertEquals("未命名", FileCodec.displayName(""))
    }
}
