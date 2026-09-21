package com.githublcb.toolcove

import android.content.Context
import android.net.Uri
import com.githublcb.toolcove.bridge.UpdateKit
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * 原生侧的「下载并安装新 APK」。
 *
 * 安卓没有桌面端那套 Tauri updater，自动更新只能自己搭：**查清单 → 下包 → 校验 → 拉起系统安装页**。
 * 这一步只做后三件事（清单由前端读，走已有的 http_request 桥命令），因为它需要 Android 上下文。
 *
 * 安全判断全在 [UpdateKit] 里（可 JVM 单测），这里只负责照做与落地：
 *  - URL 必须过白名单，否则直接拒绝
 *  - 下载完必须校验 SHA-256，不过就删文件
 *  - 安装路径必须是本 App 缓存目录里的那个，不接受任意路径
 *
 * 覆盖安装能否成功还取决于**签名**：新包与已装包不同签名时系统会拒绝
 * （INSTALL_FAILED_UPDATE_INCOMPATIBLE），那时只能卸载重装。这一步不在我们能控制范围内，
 * 所以把结果如实返回，让界面说得清。
 */
class UpdateNative(
    private val context: Context,
    /** 由 Activity 提供：在 UI 线程拉起安装页。返回 false 表示当前没有可用 Activity。 */
    private val launchInstall: (Uri) -> Boolean,
    /** 同上，用于跳转「允许安装未知应用」的系统设置页。 */
    private val launchUnknownSources: () -> Boolean,
) {

    /** 当前安装包信息：前端用它比对清单里的版本。 */
    fun appInfo(): Map<String, Any?> {
        val info = runCatching {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, 0)
        }.getOrNull()
        val name = info?.versionName ?: ""
        val code = if (android.os.Build.VERSION.SDK_INT >= 28) info?.longVersionCode ?: 0L else (info?.versionCode ?: 0).toLong()
        return mapOf(
            "versionName" to name,
            "versionCode" to code,
            // 清单没给 versionCode 时前端用它兜底比较；这里同时给一个由 versionName 推导的值，
            // 保证两端（gradle 与本方法）在正常情况下算出同一个数
            "derivedCode" to UpdateKit.versionCode(name),
            "package" to context.packageName,
            // 能不能覆盖安装（用户是否授过"安装未知应用"）：没有权限时界面要先引导去设置，
            // 而不是点了"安装"什么反应都没有
            "canInstall" to canRequestInstalls(),
        )
    }

    private fun canRequestInstalls(): Boolean =
        runCatching { context.packageManager.canRequestPackageInstalls() }.getOrDefault(false)

    /**
     * 下载安装包到本 App 缓存目录，返回 { path, size }。
     * 校验失败或域名不合法时抛 IllegalStateException，由桥转成结构化错误给前端。
     */
    fun downloadApk(url: String, sha256: String): Map<String, Any?> {
        val target = url.trim()
        if (!UpdateKit.isAllowedUrl(target)) throw IllegalStateException("下载地址不在允许范围内，已拒绝下载")
        val path = UpdateKit.apkPathFor(context.cacheDir, "toolcove-update.apk")
        val file = File(path)
        val bytes = fetchBytes(target)
        if (!UpdateKit.verifySha256(bytes, sha256)) {
            file.delete()
            throw IllegalStateException("安装包校验失败（SHA-256 不匹配），已删除下载文件")
        }
        file.writeBytes(bytes)
        return mapOf("path" to file.absolutePath, "size" to bytes.size)
    }

    /** 重定向最多跟 5 次，避免被指到一个循环上把流量吃满。 */
    private fun fetchBytes(url: String): ByteArray {
        var current = url
        repeat(5) {
            val connection = (URL(current).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = 20_000
                readTimeout = 60_000
                instanceFollowRedirects = false
                setRequestProperty("User-Agent", "ToolCove/1.0 (Android)")
            }
            val status = connection.responseCode
            if (status in 300..399) {
                val next = connection.getHeaderField("Location")
                connection.disconnect()
                // 重定向也必须落在白名单内：否则白名单形同虚设（先给自己域名，再 302 到任意主机）
                if (next.isNullOrBlank() || !UpdateKit.isAllowedUrl(next)) {
                    throw IllegalStateException("下载被重定向到不允许的地址，已中止")
                }
                current = next
                return@repeat
            }
            if (status !in 200..299) {
                connection.disconnect()
                throw IllegalStateException("下载失败：HTTP $status")
            }
            val bytes = connection.inputStream.use { it.readBytes() }
            connection.disconnect()
            return bytes
        }
        throw IllegalStateException("下载重定向次数过多，已中止")
    }

    /**
     * 拉起系统安装页。走自己写的内容提供者（`content://` 授权 URI），
     * 理由有二：Android 7+ 禁止 file:// 暴露，而项目刻意零 androidx 依赖（不用 FileProvider）。
     */
    fun installApk(path: String): Map<String, Any?> {
        val file = UpdateKit.resolveApkFile(context.cacheDir, path)
            ?: return mapOf("ok" to false, "reason" to "bad_path")
        if (!canRequestInstalls()) {
            // 先把用户送到授权页；这一次点击的用途是"能装"，不是"装了"
            val launched = launchUnknownSources()
            return mapOf("ok" to false, "reason" to "need_unknown_sources", "launched" to launched)
        }
        val uri = Uri.parse("content://$AUTHORITY/${file.name}")
        val launched = launchInstall(uri)
        return mapOf("ok" to launched, "reason" to if (launched) "" else "no_activity")
    }

    companion object {
        /** 与 AndroidManifest 里 provider 的 authority 必须一致。 */
        const val AUTHORITY = "com.githublcb.toolcove.apk"
    }
}
