package com.githublcb.toolcove.bridge

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.Charset
import java.nio.charset.CodingErrorAction
import java.nio.charset.StandardCharsets

/**
 * 文本文件的编解码内核（**纯 JVM，不依赖 Android**）。
 *
 * 存在的理由：手机端没有"绝对路径"，文件要走 SAF（`content://` URI）。但"字节 ↔ 文本"
 * 这一层与存储方式无关，而且**必须与桌面端 Rust 侧语义一致**——否则同一个文件在两端
 * 读出来不一样（编码判定不同、BOM 处理不同），排查时会被误导。
 *
 * 这里镜像 src-tauri/src/file_tool.rs 的 decode_file_text / encode_file_text：
 *   · 编码集：UTF-8 / UTF-16LE / UTF-16BE / GBK（+ AUTO 自动判定）；
 *   · AUTO 判定顺序：BOM → 合法 UTF-8 → 零字节分布启发式（无 BOM 的 UTF-16）→ 兜底 GBK；
 *   · 返回 (文本, 实际编码, 是否有 BOM, 是否 lossy)——lossy 表示有字节无法解码、已被替换，
 *     界面据此提示"内容可能不完整"，而不是让人以为文件就是这样。
 */
object FileCodec {

    /** 与 Rust 侧一致的编码名（大写、连字符形式）。 */
    val SUPPORTED = listOf("UTF-8", "UTF-16LE", "UTF-16BE", "GBK")

    private val BOM_UTF8 = byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte())
    private val BOM_UTF16LE = byteArrayOf(0xFF.toByte(), 0xFE.toByte())
    private val BOM_UTF16BE = byteArrayOf(0xFE.toByte(), 0xFF.toByte())

    data class Decoded(val text: String, val encoding: String, val hasBom: Boolean, val lossy: Boolean)

    /** 按请求的编码解码；requested 传 "AUTO"（或空）即自动判定。 */
    fun decode(bytes: ByteArray, requested: String = "AUTO"): Decoded {
        val normalized = requested.trim().uppercase()
        val (encoding, bomLen) = if (normalized.isEmpty() || normalized == "AUTO") {
            detect(bytes)
        } else {
            require(normalized in SUPPORTED) { "不支持的文本编码：$requested" }
            normalized to 0
        }
        val content = bytes.copyOfRange(bomLen, bytes.size)
        val (text, lossy) = when (encoding) {
            "UTF-8" -> decodeWith(content, StandardCharsets.UTF_8)
            "UTF-16LE" -> decodeWith(content, StandardCharsets.UTF_16LE)
            "UTF-16BE" -> decodeWith(content, StandardCharsets.UTF_16BE)
            else -> {
                // GBK 在标准 JVM 与 Android 上都有；万一缺失则退回 UTF-8 并标记 lossy，
                // 而不是抛错——读文件失败比"内容可能不完整"更糟
                val gbk = runCatching { Charset.forName("GBK") }.getOrNull()
                if (gbk != null) decodeWith(content, gbk) else decodeWith(content, StandardCharsets.UTF_8)
            }
        }
        return Decoded(text, encoding, bomLen > 0, lossy)
    }

    /** 编码为字节。bom=true 时加上对应 BOM（只有 UTF-8 与 UTF-16 有）。 */
    fun encode(text: String, encoding: String = "UTF-8", bom: Boolean = false): ByteArray {
        val normalized = encoding.trim().uppercase().ifEmpty { "UTF-8" }
        require(normalized in SUPPORTED) { "不支持的文本编码：$encoding" }
        val charset = when (normalized) {
            "UTF-16LE" -> StandardCharsets.UTF_16LE
            "UTF-16BE" -> StandardCharsets.UTF_16BE
            "GBK" -> runCatching { Charset.forName("GBK") }.getOrElse { StandardCharsets.UTF_8 }
            else -> StandardCharsets.UTF_8
        }
        val body = text.toByteArray(charset)
        if (!bom) return body
        // GBK 没有 BOM 概念：写了反而会让别的程序读出错，所以显式忽略
        return when (normalized) {
            "UTF-8" -> BOM_UTF8 + body
            "UTF-16LE" -> BOM_UTF16LE + body
            "UTF-16BE" -> BOM_UTF16BE + body
            else -> body
        }
    }

    /** AUTO 判定：BOM → 合法 UTF-8 → 零字节启发式 → GBK。顺序与 Rust 侧一致。 */
    private fun detect(bytes: ByteArray): Pair<String, Int> {
        if (hasPrefix(bytes, BOM_UTF8)) return "UTF-8" to 3
        if (hasPrefix(bytes, BOM_UTF16LE)) return "UTF-16LE" to 2
        if (hasPrefix(bytes, BOM_UTF16BE)) return "UTF-16BE" to 2
        if (isValidUtf8(bytes)) return "UTF-8" to 0

        // 无 BOM 的 UTF-16：ASCII 文本里每隔一个字节就是 0，按这个分布判断字节序。
        // 只看前 4096 字节：大文件没必要全扫，而且样本越大越容易撞上巧合。
        val sample = bytes.copyOfRange(0, minOf(bytes.size, 4096))
        val pairs = sample.size / 2
        var evenZeros = 0
        var oddZeros = 0
        for (index in sample.indices) {
            if (sample[index] == 0.toByte()) {
                if (index % 2 == 0) evenZeros++ else oddZeros++
            }
        }
        // 与 Rust 的阈值一致（3/2）：奇数位大量为 0 → LE；偶数位大量为 0 → BE
        if (pairs > 2 && oddZeros * 3 > pairs * 2) return "UTF-16LE" to 0
        if (pairs > 2 && evenZeros * 3 > pairs * 2) return "UTF-16BE" to 0
        return "GBK" to 0
    }

    /**
     * 严格 UTF-8 校验（不合法就返回 false）。
     *
     * ⚠️ 不能用 `String(bytes, UTF_8)` 来判断：它会**把坏字节替换成 U+FFFD 而不报错**，
     * 于是任何字节序列都"看起来是合法 UTF-8"，AUTO 判定里"合法 UTF-8 → UTF-8"这一步就永远命中，
     * 后面的零字节启发式与 GBK 兜底全部失效——实测表现是「无 BOM 的 UTF-16 被当成 UTF-8，
     * 文本里夹着一堆 U+FFFD」。必须用 REPORT 策略让解码器真的抛错。
     * React 侧用的是 std::str::from_utf8，同样是严格的，两端语义在这里必须对齐。
     */
    private fun isValidUtf8(bytes: ByteArray): Boolean = runCatching {
        StandardCharsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
            .decode(ByteBuffer.wrap(bytes))
        true
    }.getOrElse { false }

    /**
     * 字节前缀比较。
     * Kotlin 的 ByteArray 没有 startsWith（那是 Rust/JS 的写法，编译期就会 Unresolved reference），
     * 自己判一下比转成 List/字符串再比更直接，也避免了无谓的拷贝。
     */
    private fun hasPrefix(bytes: ByteArray, prefix: ByteArray): Boolean {
        if (bytes.size < prefix.size) return false
        for (index in prefix.indices) if (bytes[index] != prefix[index]) return false
        return true
    }

    /**
     * 解码 + lossy 标记：用 REPLACE 策略，遇到坏字节不抛错而是替换并标记。
     *
     * lossy 的判定不能靠"解码抛错没有"：REPLACE 策略本来就不会抛。改用**比较**——
     * 严格解一次，失败即 lossy（这也与 Rust 侧 encoding_rs 的 had_errors 语义一致）。
     */
    private fun decodeWith(bytes: ByteArray, charset: Charset): Pair<String, Boolean> {
        val strict = charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT)
        val lossy = runCatching { strict.decode(ByteBuffer.wrap(bytes)) }.isFailure

        val relaxed = charset.newDecoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)
        val text = runCatching { relaxed.decode(ByteBuffer.wrap(bytes)).toString() }
            .getOrElse { String(bytes, charset) }
        return text to lossy
    }

    /**
     * 取文件名（SAF 的 URI 末段）。
     *
     * SAF 的 document id 有几层包装，都要剥掉才看得到真实文件名：
     *   1) **百分号编码**：`primary%3ADownload%2Forder.json` 里 `%2F` 才是路径分隔符；
     *   2) **卷前缀**：解码后是 `primary:Download/order.json`，文件名在最后一个 `:` 之后；
     *   3) 末段可能仍带扩展名之外的点号（如 document id `1234:order.json` → `order.json`）。
     * 顺序必须是「整体解码 → 去 query → 最后一个 `:` 之后 → 按 `/` 取末段」；
     * 少了任何一步都会把 `1234:order.json` 整段当成文件名（实测踩过两次，靠探针打出真实值才定案）。
     *
     * 兜底到整个 URI 而不是固定文案：实在解析不出名字时，把 URI 显示出来比"未命名"更有信息量
     * （用户还能据此判断是哪个目录下的文件）。
     */
    fun displayName(uriText: String, fallback: String = ""): String {
        val withoutQuery = uriText.substringBefore('?')
        val decoded = runCatching { java.net.URLDecoder.decode(withoutQuery, "UTF-8") }.getOrElse { withoutQuery }
        val last = decoded.substringAfterLast(':').trimEnd('/').substringAfterLast('/')
        if (last.isNotEmpty()) return last
        return fallback.ifEmpty { decoded.ifEmpty { "未命名" } }
    }
}
