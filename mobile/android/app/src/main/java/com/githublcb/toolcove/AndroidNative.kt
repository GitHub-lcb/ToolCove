package com.githublcb.toolcove

import android.content.Context
import com.githublcb.toolcove.bridge.DatabaseAccess
import com.githublcb.toolcove.bridge.FileAccess
import com.githublcb.toolcove.bridge.HttpNative
import com.githublcb.toolcove.bridge.JsonValue
import com.githublcb.toolcove.bridge.NativeOps
import com.githublcb.toolcove.bridge.PickerQueue

/**
 * 手机端的原生能力合集：HTTP / TCP / Keystore 加密 / SAF 文件。
 *
 * 为什么合成一个类：它对外的身份就是 bridge/NativeOps 的实现，四个能力是并列的。
 * 加密与文件的**具体实现**分别委托给 KeystoreNative（密钥由系统保管）与 SafFileAccess（ContentResolver），
 * 这样各自的关注点不混在一起，也便于单独替换。
 *
 * 文件选择器：SAF 是异步 Activity 流程，而桥是同步返回，中间用 PickerQueue 挂起等待。
 * 队列本身无 Android 依赖、可在 JVM 上测；这里只负责把"弹选择器"交给 Activity。
 */
class AndroidNative(
    context: Context,
    /** 由 Activity 提供：拉起系统选择器。返回 false 表示当前没有可用的 Activity（如已销毁）。 */
    private val launchPicker: (mimeType: String) -> Boolean,
) : NativeOps {

    private val http = HttpNative()
    private val keystore = KeystoreNative(http = http)
    private val files: FileAccess = SafFileAccess(context)
    private val databases: DatabaseAccess = SqliteAccess(context)
    private val picker = PickerQueue()

    override fun httpRequest(args: JsonValue) = http.httpRequest(args)
    override fun tcpCheck(args: JsonValue) = http.tcpCheck(args)
    override fun encrypt(plain: String) = keystore.encrypt(plain)
    override fun decrypt(cipher: String) = keystore.decrypt(cipher)
    override fun files(): FileAccess = files
    override fun databases(): DatabaseAccess = databases

    /**
     * 弹选择器并等待用户操作。
     * 超时（默认 2 分钟）或用户取消都返回空串——前端把空串当成"取消"处理，
     * 所以停住的选择器不会让界面卡死或报错。
     */
    override fun pickFile(mimeType: String): String {
        if (!launchPicker(mimeType.ifEmpty { "*/*" })) {
            throw IllegalStateException("当前无法打开文件选择器，请重试")
        }
        return picker.awaitSelection()
    }

    /** Activity 拿到选择结果后调用（用户取消传 null）。 */
    fun onPicked(uri: String?) {
        picker.complete(uri)
    }

    /** Activity 销毁时调用：让还在等待的请求立刻返回"取消"，避免线程白等到超时。 */
    fun cancelPending() {
        picker.complete(null)
    }
}
