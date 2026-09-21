package com.githublcb.toolcove.bridge

import java.io.File
import java.security.MessageDigest

/**
 * 自动更新的原生侧纯逻辑：下载域白名单、SHA-256 校验、安装包路径约束、versionCode 推导。
 *
 * 为什么单独拆出来（而不是写在 UpdateNative 里）：这四条全是**安全判断**，
 * 而安全判断必须能在电脑上测——它们一旦写进带 Android 依赖的类里，就只能靠装机验证，
 * 而"装一次试试"恰恰是发现这类问题最贵的方式。
 *
 * 四条各自的理由：
 *  - **下载域白名单**：清单是从网络取的，被改过的清单可以把 App 指向任意 URL；
 *    只认 GitHub 的 Release 下载域，等于把"从哪拿包"这件事钉死在自己仓库上
 *  - **必须校验 SHA-256**：不校验就装，等于"资产被替换"或中间人即任意代码执行
 *  - **安装路径必须落在自己的缓存目录内**：桥对 WebView 半可信，
 *    `../../` 之类的路径能把安装器指到任意可读文件上
 *  - **versionCode 推导与 build.gradle 同一套规则**：两边不一致会出现"清单说更新、
 *    安卓却按更旧的包拒绝安装"，这是最难排查的一种失败
 */
object UpdateKit {

    /** 允许取包的host：只有本仓库 Release 的下载链路（含重定向后的 CDN 域）。 */
    private val ALLOWED_HOSTS = setOf(
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "codeload.github.com",
    )

    /** 更新清单的固定地址：安卓自己的通道，刻意不蹭桌面占用的 `releases/latest`。 */
    const val MANIFEST_URL = "https://github.com/GitHub-lcb/ToolCove/releases/download/apk-latest/apk.json"

    /** 缓存目录下的子目录名：安装包只认这里。 */
    const val APK_DIR = "apk"

    /**
     * 是否允许从该 URL 下载。三件事都要成立：https、host 在白名单、能解析成 URI。
     * 返回 false 时调用方必须拒绝，而不是"记个日志继续下载"。
     */
    fun isAllowedUrl(url: String): Boolean {
        val trimmed = url.trim()
        if (!trimmed.startsWith("https://")) return false
        val host = runCatching { java.net.URI(trimmed).host }.getOrNull()?.lowercase() ?: return false
        return host in ALLOWED_HOSTS
    }

    /** 小写十六进制的 SHA-256。 */
    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    /**
     * 校验：期望值缺失时返回 false —— "没给哈希"不等于"不用校验"。
     * 长度或字符合法性有问题同样算失败，别把畸形值当成匹配。
     */
    fun verifySha256(bytes: ByteArray, expected: String): Boolean {
        val want = expected.trim().lowercase()
        if (want.length != 64 || !want.all { it in '0'..'9' || it in 'a'..'f' }) return false
        return sha256Hex(bytes) == want
    }

    /**
     * 把 JS 传来的路径钉在 `<cacheDir>/apk/` 里面。
     * 用规范路径比较而不是字符串前缀：`/x/apk/../secret` 字符串上以前缀开头，规范化后就跑出去了。
     */
    fun resolveApkFile(cacheDir: File, path: String): File? {
        val root = File(cacheDir, APK_DIR).canonicalFile
        val file = runCatching { File(path).canonicalFile }.getOrNull() ?: return null
        if (!file.isFile) return null
        if (!file.path.startsWith(root.path + File.separator)) return null
        return file
    }

    /** 版本号 → 数字段（缺位补 0，非数字段算 0）。 */
    fun versionParts(version: String): List<Int> {
        val parts = version.trim().split(".").map { it.takeWhile { c -> c.isDigit() }.toIntOrNull() ?: 0 }
        return if (parts.isEmpty()) listOf(0, 0, 0) else (parts + listOf(0, 0, 0)).subList(0, 3)
    }

    /** 与 app/build.gradle 里 versionCode 的编码保持一致：1.2.3 → 10203。 */
    fun versionCode(version: String): Int {
        val parts = versionParts(version)
        return parts[0] * 10000 + parts[1] * 100 + parts[2]
    }

    /** 缓存目录下的安装包绝对路径（下载时用它，不给 JS 自由裁量权）。 */
    fun apkPathFor(cacheDir: File, fileName: String): String {
        // 只取文件名部分：传入 "a/b/../../x.apk" 也只拿 "x.apk"
        val safe = fileName.trim().substringAfterLast('/').substringAfterLast('\\')
        val dir = File(cacheDir, APK_DIR).apply { mkdirs() }
        return File(dir, if (safe.isEmpty()) "update.apk" else safe).absolutePath
    }
}
