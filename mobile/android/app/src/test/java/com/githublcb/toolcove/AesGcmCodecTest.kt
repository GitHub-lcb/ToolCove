package com.githublcb.toolcove

import com.githublcb.toolcove.bridge.AesGcmCodec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.SecureRandom
import javax.crypto.AEADBadTagException

/**
 * 加解密内核单测（纯 JVM）。
 *
 * 这些用例覆盖的是"密钥从哪来"之外的全部风险：格式、版本、IV 随机性、篡改检测、长度边界。
 * Android Keystore 那部分（密钥由系统保管）无法在 JVM 上测，但它只是"取一把 key"，
 * 真正的密码学行为都在 AesGcmCodec 里，所以这里测透了，装机只剩接线。
 */
class AesGcmCodecTest {

    private val key = AesGcmCodec.randomKey()
    private val otherKey = AesGcmCodec.randomKey()

    @Test
    fun `往返正确 含中文 换行 长文本与空串`() {
        val samples = listOf(
            "sk-1234567890abcdef",
            "hello",
            "中文密钥\uD83D\uDE00带表情",
            "第一行\n第二行\r\n第三行\t带制表",
            "",
            "x".repeat(10_000),
            "{\"nested\":{\"a\":[1,2,3]}}",
        )
        for (sample in samples) {
            val cipher = AesGcmCodec.encrypt(key, sample)
            assertEquals("往返失败：${sample.take(20)}", sample, AesGcmCodec.decrypt(key, cipher))
        }
    }

    @Test
    fun `密文带版本前缀 便于将来识别旧格式`() {
        val cipher = AesGcmCodec.encrypt(key, "x")
        assertTrue("应带 v1: 前缀：$cipher", cipher.startsWith("v1:"))
        assertFalse("不应该直接暴露明文", cipher.contains("x") && cipher.length < 8)
    }

    @Test
    fun `同一明文两次加密结果不同（IV 每次都随机）`() {
        val a = AesGcmCodec.encrypt(key, "same-plaintext")
        val b = AesGcmCodec.encrypt(key, "same-plaintext")
        assertNotEquals("复用 IV 会毁掉 GCM 的机密性", a, b)
        assertEquals("same-plaintext", AesGcmCodec.decrypt(key, a))
        assertEquals("same-plaintext", AesGcmCodec.decrypt(key, b))
    }

    @Test
    fun `密文被改动必须报错 而不是返回乱码`() {
        val cipher = AesGcmCodec.encrypt(key, "sensitive")
        // 改动最后一个字符（落在 tag 上）
        val tampered = cipher.dropLast(1) + if (cipher.last() == 'A') 'B' else 'A'
        val failed = runCatching { AesGcmCodec.decrypt(key, tampered) }
        assertTrue("篡改必须被发现", failed.isFailure)
    }

    @Test
    fun `换成另一把密钥解密必须失败`() {
        val cipher = AesGcmCodec.encrypt(key, "sensitive")
        val failed = runCatching { AesGcmCodec.decrypt(otherKey, cipher) }
        assertTrue(failed.isFailure)
        // GCM 校验失败的具体类型（不同 JDK 可能是 AEADBadTagException 的包装）
        val cause = failed.exceptionOrNull()
        assertTrue(
            "应是认证失败而不是解析错误：$cause",
            cause is AEADBadTagException || cause?.cause is AEADBadTagException || cause is javax.crypto.BadPaddingException,
        )
    }

    @Test
    fun `不认识的版本前缀要明确报错`() {
        val failed = runCatching { AesGcmCodec.decrypt(key, "v9:AAAA") }
        assertTrue(failed.isFailure)
        assertTrue(failed.exceptionOrNull()?.message?.contains("版本") == true)
    }

    @Test
    fun `密文不是合法 Base64 要明确报错`() {
        val failed = runCatching { AesGcmCodec.decrypt(key, "v1:这不是 base64!!!") }
        assertTrue(failed.isFailure)
        assertTrue(failed.exceptionOrNull()?.message?.contains("Base64") == true)
    }

    @Test
    fun `密文长度不足要报错（不能拿半截数据去解密）`() {
        val tooShort = "v1:" + java.util.Base64.getEncoder().encodeToString(ByteArray(8))
        val failed = runCatching { AesGcmCodec.decrypt(key, tooShort) }
        assertTrue(failed.isFailure)
        assertTrue(failed.exceptionOrNull()?.message?.contains("长度") == true)
    }

    @Test
    fun `随机密钥每次不同`() {
        assertNotEquals(
            java.util.Base64.getEncoder().encodeToString(AesGcmCodec.randomKey().encoded),
            java.util.Base64.getEncoder().encodeToString(AesGcmCodec.randomKey().encoded),
        )
    }

    // ---------- 与桥的对接：四类命令都要能过 ----------
    @Test
    fun `桥的加密命令走内核时也往返正确`() {
        // 用 Keystore 的替身（同一套 AesGcmCodec + 固定 key），验证命令层与内核的接线
        val native = object : com.githublcb.toolcove.bridge.NativeOps {
            override fun httpRequest(args: com.githublcb.toolcove.bridge.JsonValue) = throw UnsupportedOperationException()
            override fun tcpCheck(args: com.githublcb.toolcove.bridge.JsonValue) = emptyMap<String, Any?>()
            override fun encrypt(plain: String) = AesGcmCodec.encrypt(key, plain)
            override fun decrypt(cipher: String) = AesGcmCodec.decrypt(key, cipher)
        }
        val bridge = com.githublcb.toolcove.bridge.Bridge(native)
        val encrypted = bridge.dispatch("encrypt_text", """{"plain":"sk-abc"}""")
        assertTrue(encrypted.contains("v1:"))
        assertFalse("密文里不该出现明文", encrypted.contains("sk-abc"))

        // 取出密文再解回来（模拟 secure.js 的 enc: 往返）
        val cipher = Regex("\"cipher\":\"([^\"]+)\"").find(encrypted)?.groupValues?.get(1) ?: ""
        assertTrue(cipher.isNotEmpty())
        val decrypted = bridge.dispatch("decrypt_text", """{"cipher":"$cipher"}""")
        assertTrue(decrypted.contains("sk-abc"))
    }

    @Test
    fun `SecureRandom 注入可用（便于将来做确定性测试）`() {
        val deterministic = SecureRandom.getInstance("SHA1PRNG").apply { setSeed(42L) }
        val cipher = AesGcmCodec.encrypt(key, "x", deterministic)
        assertEquals("x", AesGcmCodec.decrypt(key, cipher))
    }
}
