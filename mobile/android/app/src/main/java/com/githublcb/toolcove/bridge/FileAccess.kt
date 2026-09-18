package com.githublcb.toolcove.bridge

/**
 * 文件内容的读写抽象。
 *
 * 存在的理由：SAF 的读写走 Android 的 ContentResolver，那部分在 JVM 上没法测；
 * 但"命令分发 → 编解码 → 形状映射"这部分可以测。把两者用接口隔开，
 * 桥的逻辑就能用替身完整跑一遍（见 BridgeTest 里的 FakeFiles）。
 *
 * `uri` 是字符串形式的 `content://` URI——与桌面端"路径是字符串"的形状保持一致，
 * 所以前端 platform/invoke 的调用方式不用改。
 */
interface FileAccess {
    fun readBytes(uri: String): ByteArray
    fun writeBytes(uri: String, bytes: ByteArray)
    /** 文件大小；查不到时抛异常（由调用方翻成可读错误）。 */
    fun sizeOf(uri: String): Long
}

/**
 * 弹系统文件选择器的**挂起队列**。
 *
 * 为什么需要它：SAF 是异步 Activity 流程（弹选择器 → 用户操作 → onActivityResult 回调），
 * 而桥的 `invoke` 是**同步返回字符串**。这里的做法是：调用 `pick()` 的线程挂起等待，
 * Activity 拿到结果后 `complete()` 唤醒它；超时或用户取消则返回空串。
 *
 * 关键在于它**无 Android 依赖**，所以"等待/唤醒/超时/被顶掉"这些容易出错的时序能在 JVM 上测掉；
 * Activity 那边只剩"把结果塞进来"这一行。
 *
 * 并发策略：同时只允许一个待处理请求——第二个请求会顶掉第一个（第一个返回空串，
 * 表现为"用户取消"）。手机上同时点两次"选择文件"是可能的，顶掉比排队更符合直觉。
 */
class PickerQueue(private val defaultTimeoutMs: Long = 120_000) {

    private val lock = Object()
    private var pending: Pending? = null

    private class Pending(val timeoutMs: Long) {
        var result: String? = null
        var done = false
    }

    /** 当前是否有等待中的选择请求（Activity 据此决定要不要忽略迟到的回调）。 */
    val isPending: Boolean
        get() = synchronized(lock) { pending != null }

    /**
     * 挂起等待用户选择，返回 URI；超时或被顶掉返回空串。
     * ⚠️ 必须在**非 UI 线程**调用（WebView 的 JS 桥线程正是非 UI 线程）。
     */
    fun awaitSelection(timeoutMs: Long = defaultTimeoutMs): String {
        val current = Pending(timeoutMs)
        synchronized(lock) {
            // 顶掉前一个：它会被唤醒并拿到空串，表现为"取消"
            pending?.let { previous ->
                previous.result = null
                previous.done = true
                (lock as Object).notifyAll()
            }
            pending = current
        }
        val deadline = System.currentTimeMillis() + timeoutMs
        synchronized(lock) {
            while (!current.done) {
                val remain = deadline - System.currentTimeMillis()
                if (remain <= 0) break
                try {
                    (lock as Object).wait(remain)
                } catch (_: InterruptedException) {
                    break
                }
            }
            if (pending === current) pending = null
            return current.result ?: ""
        }
    }

    /** Activity 拿到结果（或用户取消，传 null）后调用；没有等待者时是空操作。 */
    fun complete(uri: String?) {
        synchronized(lock) {
            val current = pending ?: return
            current.result = uri
            current.done = true
            (lock as Object).notifyAll()
        }
    }
}
