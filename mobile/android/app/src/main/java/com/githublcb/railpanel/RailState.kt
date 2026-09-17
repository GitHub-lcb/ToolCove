package com.githublcb.railpanel

import android.content.Context
import android.content.Intent
import android.content.SharedPreferences

/**
 * 进度状态的唯一真源（native 侧）。
 *
 * 为什么需要它：悬浮窗和全屏页是**两个独立的 WebView**。
 *
 * 本来更省事的做法是只保留一个 WebView，在「悬浮窗」和「全屏页」之间搬来搬去（reparent）。
 * 这条路已经排除：WebView 跨窗口搬移没有任何官方保证，且社区实测是**不对称**的
 * （Activity → overlay 成功、反向失败，两边都不显示），一旦踩中就是「面板空白」这种
 * 无法自愈的故障。相反方向的代价也很明确：两个 WebView 各自持有 localStorage，
 * **WebView 不保证另一个 WebView 写入后立即读到**，而 `pauseTimers()` 是进程级全局的
 * （在 Activity 里调会把悬浮窗的 JS 定时器一起停掉），所以「实时同步」必须自己搭。
 *
 * 于是：两边都把状态回传到这里，由这里广播给另一边。
 *   - 持久化：SharedPreferences（比 WebView 的 localStorage 更可控，且卸载前一直在）；
 *   - 广播：一次性 BroadcastReceiver，**只在两边都活着时才有意义**，进程死了自然失效；
 *   - 冷启动：WebView 初始化时注入这里存的 JSON（见 RailBridge.inject），
 *     所以「面板里记的站」在杀掉进程重开后仍然在。
 *
 * 注意 revision 单调递增：接收方靠它丢弃「自己写出去的旧值」回声，避免两边互相覆盖。
 */
object RailState {
    private const val PREFS = "rail_state"
    private const val KEY_JSON = "json"
    private const val KEY_REV = "rev"

    /** 状态变更广播。只在本进程内有效（两边同进程，见 AndroidManifest 不写 android:process）。 */
    const val ACTION_STATE = "com.githublcb.railpanel.STATE"
    const val EXTRA_JSON = "json"

    @Volatile
    var revision: Long = 0
        private set

    private fun prefs(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /**
     * 记一份新状态。
     *
     * @return true = 确实变了（调用方据此决定要不要广播，避免回声循环）
     */
    @Synchronized
    fun write(context: Context, json: String): Boolean {
        if (json.isBlank()) return false
        val current = prefs(context).getString(KEY_JSON, null)
        if (current == json) return false
        revision += 1
        prefs(context).edit().putString(KEY_JSON, json).putLong(KEY_REV, revision).apply()
        return true
    }

    /** 当前状态；没有记录过就返回空串（前端会当成「全新一局」）。 */
    fun read(context: Context): String = prefs(context).getString(KEY_JSON, "") ?: ""

    /**
     * 前端初始化时要注入的那份状态。
     *
     * 只在**存在记录**时返回内容：空串让前端走自己的默认值，
     * 免得用一份空状态去覆盖用户刚在另一个窗口里记的东西。
     */
    fun initialFor(context: Context): String = read(context)

    /**
     * 把状态变更广播给「另一个 WebView」。
     *
     * 悬浮窗与全屏页是同一进程里的两个 WebView（见文件头），所以普通广播就够，
     * 不需要 LocalBroadcastManager（已废弃）。加 setPackage 限定包名，
     * 外部应用即使声明了同名 action 也发不进来。
     */
    fun broadcast(context: Context, json: String) {
        val intent = Intent(ACTION_STATE)
            .setPackage(context.packageName)
            .putExtra(EXTRA_JSON, json)
        context.sendBroadcast(intent)
    }
}
