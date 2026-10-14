package com.githublcb.toolcove.bridge

/**
 * 云端照片下载的纯逻辑：下载地址策略 + 文件名净化。
 *
 * 拆出来单独放的理由与 UpdateKit 一样——这两条都是**安全判断**，
 * 而安全判断必须能在电脑上测；写进带 Android 依赖的类里就只能靠装机验证，
 * 而「装一次试试」是发现这类问题最贵的方式。
 *
 *  1. **地址策略**：桥对 WebView 是半可信的，不限制的话页面（或注入的脚本）
 *     能让原生去下载任意 URL 并写进用户的下载目录；
 *  2. **文件名净化**：`../../x` 之类能把内容写到下载目录之外。
 */
object DownloadKit {

    /** 单文件上限：给「误点一个巨物」留个刹车（照片远达不到）。 */
    const val MAX_BYTES = 200L * 1024 * 1024

    /**
     * 是否允许下载该地址。只认 https；另放行 http 回环——那是
     * 「本机补头转发」的场景（见 docs/photo-relay.md）。
     */
    fun isAllowedUrl(url: String): Boolean {
        val text = url.trim()
        if (text.startsWith("https://")) return text.removePrefix("https://").substringBefore('/').isNotBlank()
        return text.startsWith("http://127.0.0.1") ||
            text.startsWith("http://localhost") ||
            text.startsWith("http://[::1]")
    }

    /** 净化文件名：取末段、去掉路径分隔符与控制字符、不许以点开头、空则给默认名。 */
    fun safeFileName(name: String, fallback: String = "photo"): String {
        val base = name.trim().substringAfterLast('/').substringAfterLast('\\')
        val cleaned = base.map { ch -> if (ch.code < 32 || ch in "\\/:*?\"<>|") '_' else ch }.joinToString("")
        val trimmed = cleaned.trim().trimStart('.')
        return if (trimmed.isEmpty()) fallback else trimmed.take(120)
    }

    /** 图片一律进相册（Pictures），其余进下载目录——用户在相册里找照片，不在文件管理器里找。 */
    fun isImage(mimeType: String, fileName: String): Boolean {
        if (mimeType.startsWith("image/")) return true
        if (mimeType.isNotEmpty() && mimeType != "application/octet-stream") return false
        return fileName.substringAfterLast('.', "").lowercase() in setOf("jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "bmp")
    }

    /** 落盘用的子目录名（相册里就是这个名字的相簿）。 */
    const val FOLDER = "ToolCove"

    /** 重名时补 (1)(2)…，避免把下载目录里已有的同名文件悄悄覆盖掉。 */
    fun uniqueName(name: String, taken: (String) -> Boolean): String {
        if (!taken(name)) return name
        val dot = name.lastIndexOf('.')
        val stem = if (dot > 0) name.substring(0, dot) else name
        val ext = if (dot > 0) name.substring(dot) else ""
        var index = 1
        while (index < 1000) {
            val candidate = "$stem ($index)$ext"
            if (!taken(candidate)) return candidate
            index += 1
        }
        return name
    }
}
