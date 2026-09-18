package com.githublcb.toolcove

import android.webkit.JavascriptInterface
import com.githublcb.toolcove.bridge.Bridge

/**
 * WebView 与 JS 之间的唯一接口。
 *
 * 刻意只有**两个** @JavascriptInterface 成员：多暴露一个就是一个攻击面。
 * JS 侧（mobile/app/platform/bridge.js）的契约：
 *   window.ToolCove.isMobile          —— 属性，true 表示在安卓壳里（桥可用）
 *   window.ToolCove.invoke(cmd, json) —— 返回 JSON 字符串；失败时返回 {"__error": "..."}
 *
 * 这个类只做转发，逻辑全在 Bridge 里（那部分无 Android 依赖，能在 JVM 上单测）。
 */
class ToolCoveBridge(private val bridge: Bridge) {

    /**
     * JS 侧用 `window.ToolCove.isMobile === true` 判断桥是否可用。
     * ⚠️ 必须是**属性**而不是方法：Kotlin 的 `val isMobile` 生成的 getter 名是 `isMobile()`
     * 而不是 `getIsMobile()`，WebView 注入到 JS 后才正好是属性 `isMobile`——写成 `fun isMobile()`
     * 就会变成 JS 里的方法，`=== true` 永远为假（桥会被当成不可用，静默降级）。
     */
    @get:JavascriptInterface
    val isMobile: Boolean = true

    @JavascriptInterface
    fun invoke(cmd: String, argsJson: String): String = bridge.dispatch(cmd, argsJson)
}
