package com.githublcb.toolcove.bridge

import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-GCM 加解密内核（**纯 JCE，不依赖 Android**）。
 *
 * 抽出来的理由：原生桥最容易变成"只能装机试"的黑盒。把密文格式与编解码逻辑放在这里，
 * 就能在 JVM 上把"往返正确、密文被改过要报错、长度边界、四类命令都要过一遍"全部测掉；
 * Android 侧只剩"密钥从哪来"（Keystore）。
 *
 * 密文格式：`v1:` + Base64(12 字节 IV ‖ 密文‖GCM tag)
 *   · 带版本前缀是为了将来换算法/换密钥时能识别旧数据，而不是解密失败后无从判断；
 *   · IV 每次加密都重新随机（GCM 复用 IV 会直接毁掉机密性，这是硬要求，不是优化）。
 *
 * 密钥来源由调用方注入：手机端是 Android Keystore，桌面端是 DPAPI——
 * 两端的**密文格式互不通用**（各自的密钥体系不同），但前端只关心 enc: 前缀那一层。
 */
object AesGcmCodec {

    private const val PREFIX = "v1:"
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128

    /** 加密：返回带版本前缀的 Base64。 */
    fun encrypt(key: SecretKey, plain: String, random: SecureRandom = SecureRandom()): String {
        val iv = ByteArray(IV_BYTES).also { random.nextBytes(it) }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        val sealed = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return PREFIX + Base64.getEncoder().encodeToString(iv + sealed)
    }

    /**
     * 解密。密文被改动、版本不认识、Base64 损坏都**抛异常**——
     * 绝不能让"解密失败"变成"返回一段乱码当密码用"（前端 secure.js 也是这个约定：
     * 解密失败向上抛，不把密文片段当可用密码继续请求或再次保存）。
     */
    fun decrypt(key: SecretKey, cipherText: String): String {
        require(cipherText.startsWith(PREFIX)) { "密文版本无法识别（期望 ${PREFIX} 前缀）" }
        val raw = try {
            Base64.getDecoder().decode(cipherText.removePrefix(PREFIX))
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("密文不是合法 Base64：${e.message}")
        }
        require(raw.size > IV_BYTES) { "密文长度不足（至少要有 IV 与 tag）" }
        val iv = raw.copyOfRange(0, IV_BYTES)
        val body = raw.copyOfRange(IV_BYTES, raw.size)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv))
        // GCM 校验失败会抛 AEADBadTagException —— 这正是我们要的"改动即报错"
        return String(cipher.doFinal(body), Charsets.UTF_8)
    }

    /** 生成一把临时 AES-256 密钥（JVM 测试与"Keystore 不可用时的兜底"用）。 */
    fun randomKey(random: SecureRandom = SecureRandom()): SecretKey {
        val bytes = ByteArray(32).also { random.nextBytes(it) }
        return javax.crypto.spec.SecretKeySpec(bytes, "AES")
    }
}
