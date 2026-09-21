package com.githublcb.toolcove

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.githublcb.toolcove.bridge.UpdateKit
import java.io.File
import java.io.FileNotFoundException

/**
 * 只读暴露 `<cacheDir>/apk/` 下的安装包，给系统安装器一个合法的 `content://` URI。
 *
 * 为什么不直接用 `androidx.core.content.FileProvider`：项目刻意零 androidx 依赖
 * （见 app/build.gradle 顶部说明），为一个"分享一个文件"的需求引入整条 core-ktx 不值当，
 * 也多一类"本地能编、换台机器编不过"的风险。这里自己写，能力反而更小：
 *  - 只读（openFile 只接受 MODE_READ_ONLY，任何写请求抛异常）
 *  - 只认缓存目录下的 apk 子目录，且只按**文件名**取（不接受路径段，越界一律 FileNotFoundException）
 *  - 不提供 insert/update/delete —— 安装器只需要读，多一个能力就多一个攻击面
 */
class ApkProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = MIME_APK

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        if (mode != MODE_READ_ONLY) throw FileNotFoundException("本提供者只读：$mode")
        val name = uri.lastPathSegment ?: throw FileNotFoundException("缺少文件名")
        val cache = context?.cacheDir ?: throw FileNotFoundException("无缓存目录")
        val root = File(cache, UpdateKit.APK_DIR).canonicalFile
        val file = runCatching { File(root, name).canonicalFile }.getOrNull()
            ?: throw FileNotFoundException("路径不合法")
        // 名字里带了目录段（或被解析成上级目录）就拒绝：File(root, name) 本身不保证不越界
        if (!file.path.startsWith(root.path + File.separator) || !file.isFile) {
            throw FileNotFoundException("文件不存在或不可读")
        }
        return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    // 以下都是抽象接口的必需实现，本提供者一概不支持——安装器只需要读文件
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException("不支持写入")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("不支持删除")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("不支持修改")

    private companion object {
        const val MIME_APK = "application/vnd.android.package-archive"
        const val MODE_READ_ONLY = "r"
    }
}
