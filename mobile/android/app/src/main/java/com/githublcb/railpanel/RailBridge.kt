package com.githublcb.railpanel

import android.content.Context
import android.content.Intent
import android.webkit.JavascriptInterface
import android.widget.Toast

/**
 * HUD 页面与原生之间的桥（注入为 `window.railHudApi`）。
 *
 * 前端只需要四件事，这里就只开四个口子——`addJavascriptInterface` 暴露的方法
 * 在 API 17+ 虽然必须带 @JavascriptInterface 才能被调用，但多开一个就是一个攻击面，
 * 而这个页面的内容全部来自本地 assets。
 *
 * 文件相关的两个动作（导出/导入）不在悬浮窗里做，而是把用户送到全屏页：
 * 悬浮窗是 `FLAG_NOT_FOCUSABLE` 的，软键盘弹不出来；`<select>` 之类依赖
 * 子窗口的控件在 overlay 窗口里也不可靠（见 RailPanelService 的注释）。
 * 把「要打字 / 要看系统的界面」交给 Activity，是这套架构里明确的边界。
 */
class RailBridge(
    private val context: Context,
    /** 悬浮窗模式：导出/导入转交全屏页；全屏页模式：就地弹出面板。 */
    private val host: Host,
) {
    interface Host {
        /** 打开全屏页的导出/导入界面。 */
        fun openSupport(action: String)
        /**
         * 页面请求把面板收成一条 / 展开。
         *
         * 名字刻意不叫 setCollapsed：实现方（RailPanelService）自己就有一个同名私有方法，
         * 撞在一起会让 `setCollapsed(...)` 的解析在两者之间摇摆（Kotlin 会直接报
         * 「Overload resolution ambiguity」）。接口方法名带 Request 更贴事实——
         * 页面只是**请求**，真正改窗口尺寸的是原生侧。
         */
        fun onCollapseRequest(collapsed: Boolean)
        /**
         * 页面请求切换朝向（竖屏 / 横屏）。
         *
         * 悬浮窗 = 换窗口宽高；全屏页 = 改 Activity 的 requestedOrientation。
         * 实现方各自持久化，下次开窗口/重进页面时经 bootstrap 注入回页面。
         */
        fun onOrientationRequest(mode: String)
    }

    /**
     * 前端每次状态变化都会回调这里（录入、导入、清空都会）。
     * 写进 SharedPreferences 并广播给另一个 WebView。
     */
    @JavascriptInterface
    fun onStateChanged(json: String) {
        if (RailState.write(context, json)) RailState.broadcast(context, json)
    }

    /** 前端初始化完成后回调一次，原生据此确认页面已经能收消息。 */
    @JavascriptInterface
    fun ready(json: String) {
        if (json.isNotBlank()) onStateChanged(json)
    }

    /** 导出：交给全屏页显示 JSON（可复制、可存文件）。 */
    @JavascriptInterface
    fun saveFile(name: String, json: String) {
        SupportActivity.pendingExport = PendingText(name, json)
        host.openSupport(SupportActivity.ACTION_EXPORT)
    }

    /** 导入：交给全屏页选文件或粘贴。 */
    @JavascriptInterface
    fun pickFile() {
        host.openSupport(SupportActivity.ACTION_IMPORT)
    }

    /** 悬浮窗上的「收起成一条 / 展开」——只在 panel 模式由页面调用。 */
    @JavascriptInterface
    fun setCollapsed(collapsed: Boolean) {
        host.onCollapseRequest(collapsed)
    }

    /** 页面上的「竖屏 / 横屏」切换：归一后再交给宿主，脏字符串一律当竖屏。 */
    @JavascriptInterface
    fun setOrientation(mode: String) {
        host.onOrientationRequest(if (mode == ORIENT_LANDSCAPE) ORIENT_LANDSCAPE else ORIENT_PORTRAIT)
    }

    /** 前端要提示用户时用（悬浮窗里没有 toast 位置，交给原生）。 */
    @JavascriptInterface
    fun toast(message: String) {
        Toast.makeText(context, message, Toast.LENGTH_SHORT).show()
    }

    companion object {
        /** 朝向取值：与 mobile/rail-hud/main.js 的 bootstrap.orientation 逐字一致。 */
        const val ORIENT_PORTRAIT = "portrait"
        const val ORIENT_LANDSCAPE = "landscape"
    }
}

/** 跨 Activity 传递导出内容的一次性槽位（进程内，够用且不用 Parcelable）。 */
data class PendingText(val name: String, val json: String)
