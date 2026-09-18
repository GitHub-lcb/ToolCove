package com.githublcb.toolcove

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import com.githublcb.toolcove.bridge.AesGcmCodec
import com.githublcb.toolcove.bridge.HttpNative
import com.githublcb.toolcove.bridge.JsonValue
import com.githublcb.toolcove.bridge.NativeOps
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
/**
 * Android 端的原生能力实现：HTTP / TCP 沿用它（HttpNative），
 * **加密这一段换成 Android Keystore**——密钥由系统保管，应用进程拿不到裸密钥字节。
 *
 * 与桌面端的关系：桌面用 DPAPI、手机用 Keystore，都是"由操作系统保管密钥"，
 * 因此**两端的密文互不通用**（各自的密钥体系不同）。前端只关心 `enc:` 前缀那一层，
 * 所以这个差异对 src/ 不可见。
 *
 * 密钥一旦被系统清除（卸载重装、清应用数据、用户改锁屏导致密钥失效），
 * 解密会失败——这时按 secure.js 的约定**向上抛错**，而不是返回明文或空串：
 * 让用户重新填一次密钥，比"悄悄降级成明文密钥"安全得多。
 */
class KeystoreNative(
    private val alias: String = DEFAULT_ALIAS,
    private val http: HttpNative = HttpNative(),
) : NativeOps {

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }

        // 首次使用：生成一把 AES-256，并**明确不要用户认证**——
        // 后台同步也要读它，要求每次解锁会让云同步在后台直接失败。
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build()
        )
        return generator.generateKey()
    }

    override fun encrypt(plain: String): String {
        require(plain.isNotEmpty()) { "待加密内容为空" }
        return AesGcmCodec.encrypt(secretKey(), plain)
    }

    override fun decrypt(cipher: String): String {
        require(cipher.isNotEmpty()) { "待解密内容为空" }
        return AesGcmCodec.decrypt(secretKey(), cipher)
    }

    // HTTP 与 TCP 直接复用桥里那份实现（同一套形状，前端不必分支）
    override fun httpRequest(args: JsonValue) = http.httpRequest(args)
    override fun tcpCheck(args: JsonValue) = http.tcpCheck(args)

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val DEFAULT_ALIAS = "toolcove.secrets.v1"
    }
}
