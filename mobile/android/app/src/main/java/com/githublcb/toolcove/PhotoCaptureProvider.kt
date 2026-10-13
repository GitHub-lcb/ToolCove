package com.githublcb.toolcove

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import com.githublcb.toolcove.bridge.PhotoCaptureKit
import java.io.File
import java.io.FileNotFoundException

/**
 * 相机专用 `content://` 提供者：只暴露 `<cacheDir>/camera/capture-<时间戳>.jpg` 这一个形状的文件。
 *
 * 为什么不能复用 [ApkProvider]：那个是**只读**的（给安装器读安装包），而这里相机要**写**进来。
 * 写口子比读口子危险，所以约束从紧：
 *  - 文件名必须匹配 `capture-数字.jpg`（本应用生成），任何其它名字直接拒绝；
 *  - 落点必须解析回缓存目录内（canonical 前缀比对，挡住 `../` 之类）；
 *  - 只允许 openFile（相机拿 URI 读写字节），insert/update/delete/query 一概不支持。
 *
 * 权限面：exported=true 仅为让相机应用能通过 URI 授权访问；没有授权的应用连 openFile 都进不来
 * （grantUriPermissions + 单次 URI 授权只在本次 ACTION_IMAGE_CAPTURE 调用里生效）。
 */
class PhotoCaptureProvider : ContentProvider() {

    override fun onCreate(): Boolean = true

    override fun getType(uri: Uri): String = MIME_JPEG

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val name = uri.lastPathSegment ?: throw FileNotFoundException("缺少文件名")
        val cacheDir = context?.cacheDir ?: throw FileNotFoundException("无缓存目录")
        val file = PhotoCaptureKit.resolveCaptureFile(cacheDir, name)
        val flags = when (mode) {
            "r" -> ParcelFileDescriptor.MODE_READ_ONLY
            // 相机有的用 "w"、有的用 "wt"/"rw"：都归一成"可创建 + 可写"，truncate 语义照给
            "w" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            "wt" -> ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            "rw" -> ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE
            "rwt" -> ParcelFileDescriptor.MODE_READ_WRITE or ParcelFileDescriptor.MODE_CREATE or ParcelFileDescriptor.MODE_TRUNCATE
            else -> throw FileNotFoundException("不支持的模式：$mode")
        }
        return ParcelFileDescriptor.open(file, flags)
    }

    // 相机只通过 URI 读写字节，其余接口一概不支持——多一个能力就多一个攻击面
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException("不支持写入")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("不支持删除")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("不支持修改")

    private companion object {
        const val MIME_JPEG = "image/jpeg"
    }
}
