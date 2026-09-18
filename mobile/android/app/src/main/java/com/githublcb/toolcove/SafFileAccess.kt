package com.githublcb.toolcove

import android.content.ContentResolver
import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import com.githublcb.toolcove.bridge.FileAccess

/**
 * SAF 的 ContentResolver 实现。
 *
 * 这一层刻意做得极薄：真正的逻辑（文本编解码、命令分发、形状映射）都在无 Android 依赖的
 * bridge/ 里，这里只负责"按 URI 读写字节"。
 *
 * 两个 SAF 特有的注意点：
 *  1) 读要用 `ContentResolver.openInputStream`，不能当普通文件路径——`content://` 不是路径；
 *  2) 文件大小要查 `OpenableColumns.SIZE`，而不是 `File.length()`（后者对 URI 无意义）。
 *     查不到时返回 -1，由调用方当作"未知"，而不是当成 0 字节文件。
 */
class SafFileAccess(private val context: Context) : FileAccess {

    private val resolver: ContentResolver get() = context.contentResolver

    override fun readBytes(uri: String): ByteArray {
        val parsed = Uri.parse(uri)
        return resolver.openInputStream(parsed)?.use { it.readBytes() }
            ?: throw IllegalStateException("无法读取该文件（授权可能已失效，请重新选择）")
    }

    override fun writeBytes(uri: String, bytes: ByteArray) {
        val parsed = Uri.parse(uri)
        // "wt" 会**截断**已有内容：SAF 的默认写入是覆盖，但某些 provider 需要显式模式，
        // 不写 "t" 会出现"新内容比旧内容短时尾部残留"的经典 bug
        resolver.openOutputStream(parsed, "wt")?.use { it.write(bytes) }
            ?: throw IllegalStateException("无法写入该文件（授权可能已失效，请重新选择）")
    }

    override fun sizeOf(uri: String): Long {
        val parsed = Uri.parse(uri)
        resolver.query(parsed, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val index = cursor.getColumnIndex(OpenableColumns.SIZE)
                if (index >= 0 && !cursor.isNull(index)) return cursor.getLong(index)
            }
        }
        // 查不到就报错，让上层按"读不到"处理；返回 0 会被误当成空文件
        throw IllegalStateException("无法读取文件大小")
    }
}
