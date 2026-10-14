package com.githublcb.toolcove

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import com.githublcb.toolcove.bridge.DownloadKit
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 把云端照片下载到系统的「下载」目录。
 *
 * 为什么走原生而不是让 WebView 自己下：WebView 里的 `a[download]` 默认没人处理
 * （要么什么都不发生，要么把图片当网页打开），而照片动辄两三兆——
 * 让 Kotlin 直接抓字节落盘，既不经过 JS 的 base64，也不占 WebView 内存。
 *
 * 落盘位置：Android 10+ 用 MediaStore.Downloads（写 `Download/ToolCove/`，无需任何权限）；
 * 更旧的系统退到 App 专属外部目录（同样不需要权限）。
 *
 * 安全边界在 [DownloadKit] 里（地址策略、文件名净化），这里只负责照做。
 */
class DownloadNative(private val context: Context) {

    fun download(url: String, headers: Map<String, String>, fileName: String): Map<String, Any?> {
        val target = url.trim()
        if (!DownloadKit.isAllowedUrl(target)) {
            throw IllegalStateException("下载地址不被允许（只接受 https 或本机回环地址）")
        }
        val name = DownloadKit.safeFileName(fileName)
        val bytes = fetchBytes(target, headers)
        return save(name, bytes, mimeOf(name)) + mapOf<String, Any?>("size" to bytes.size)
    }

    /** 重定向最多跟 5 次；每次都要重新过地址策略，否则「先给合法地址、再 302 到任意主机」就绕过去了。 */
    private fun fetchBytes(url: String, headers: Map<String, String>): ByteArray {
        var current = url
        repeat(5) {
            val connection = (URL(current).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 20_000
                readTimeout = 60_000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "ToolCove/1.0 (Android)")
                headers.forEach { (name, value) -> setRequestProperty(name, value) }
            }
            val status = connection.responseCode
            if (status in 300..399) {
                val next = connection.getHeaderField("Location")
                connection.disconnect()
                if (next.isNullOrBlank() || !DownloadKit.isAllowedUrl(next)) {
                    throw IllegalStateException("下载被重定向到不允许的地址，已中止")
                }
                current = next
                return@repeat
            }
            if (status !in 200..299) {
                connection.disconnect()
                throw IllegalStateException("下载失败：HTTP $status")
            }
            val bytes = connection.inputStream.use { stream ->
                val buffer = ByteArray(64 * 1024)
                val out = java.io.ByteArrayOutputStream()
                while (true) {
                    val read = stream.read(buffer)
                    if (read <= 0) break
                    out.write(buffer, 0, read)
                    if (out.size() > DownloadKit.MAX_BYTES) {
                        throw IllegalStateException("文件超过 ${DownloadKit.MAX_BYTES / 1024 / 1024}MB，已中止")
                  }
                }
                out.toByteArray()
            }
            connection.disconnect()
            return bytes
        }
        throw IllegalStateException("下载重定向次数过多，已中止")
    }

    /**
     * 落盘。
     *
     * **图片进相册**（MediaStore.Images，相簿名 ToolCove），其余进下载目录——
     * 真机反馈「下载完了不知道文件在哪」：照片在相册里找才符合直觉，
     * 丢进 Download/ 反而是让人去文件管理器里刨。
     *
     * 返回值里的 kind/folder/name 是给界面拼"短文案"用的：
     * 之前直接把完整路径塞进提示，路径太长把界面挤坏了。
     */
    private fun save(name: String, bytes: ByteArray, mime: String): Map<String, Any?> {
        val toGallery = DownloadKit.isImage(mime, name)
        val relative = (if (toGallery) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS) +
            "/" + DownloadKit.FOLDER

        if (Build.VERSION.SDK_INT >= 29) {
            val collection = if (toGallery) {
                MediaStore.Images.Media.EXTERNAL_CONTENT_URI
            } else {
                MediaStore.Downloads.EXTERNAL_CONTENT_URI
            }
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, relative)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val resolver = context.contentResolver
            val uri = resolver.insert(collection, values)
                ?: throw IllegalStateException("无法在$relative 下创建文件")
            resolver.openOutputStream(uri)?.use { it.write(bytes) }
                ?: throw IllegalStateException("无法写入$relative")
            values.clear()
            values.put(MediaStore.MediaColumns.IS_PENDING, 0)
            resolver.update(uri, values, null, null)
            return mapOf(
                "ok" to true,
                "name" to name,
                "kind" to if (toGallery) "image" else "file",
                "folder" to DownloadKit.FOLDER,
                "uri" to uri.toString(),
                // 兼容旧字段：短标签，不再是完整路径
                "location" to relative,
            )
        }

        val dir = context.getExternalFilesDir(if (toGallery) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS)
            ?: context.filesDir
        val target = File(dir, name)
        target.writeBytes(bytes)
        return mapOf(
            "ok" to true,
            "name" to name,
            "kind" to if (toGallery) "image" else "file",
            "folder" to DownloadKit.FOLDER,
            "uri" to "",
            "location" to relative,
        )
    }

    private fun mimeOf(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "webp" -> "image/webp"
        "gif" -> "image/gif"
        "heic" -> "image/heic"
        "mp4" -> "video/mp4"
        "pdf" -> "application/pdf"
        else -> "application/octet-stream"
    }
}
