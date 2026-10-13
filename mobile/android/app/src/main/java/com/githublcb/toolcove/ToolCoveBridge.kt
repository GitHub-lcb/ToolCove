package com.githublcb.toolcove

import android.webkit.JavascriptInterface
import com.githublcb.toolcove.bridge.Bridge

/**
 * WebView 与 JS 之间的唯一接口：只暴露 `invoke` 一个方法。
 *
 * JS 侧（mobile/app/platform/bridge.js）的契约：
 *   window.ToolCove.invoke(cmd, argsJson) -> 返回 JSON 字符串；失败时返回 {"__error": "..."}
 *
 * ⚠️ 为什么**不放**一个布尔属性（如 `isMobile`）：
 * 曾用 `@get:JavascriptInterface val isMobile` 暴露"桥可用"标记，但 WebView 的注入把
 * Java/Kotlin 方法映射成 JS **方法**——`window.ToolCove.isMobile` 是个函数对象，
 * JS 里 `=== true` 恒为假，于是真机上桥被静默判为"不存在"，整个 App 跑在浏览器降级路径
 * （检查更新 CORS 失败、密钥不加密、AI 请求受跨域限制），而所有自动化测试都看不见
 * （E2E 桥替身种了真机上不存在的 `isMobile: true` 形状）。
 * 现在的判据是"`invoke` 是不是函数"——这既可验证也不会被注入语义欺骗。
 *
 * 这个类只做转发，逻辑全在 Bridge 里（那部分无 Android 依赖，能在 JVM 上单测）。
 */
class ToolCoveBridge(private val bridge: Bridge) {

    @JavascriptInterface
    fun invoke(cmd: String, argsJson: String): String = bridge.dispatch(cmd, argsJson)
}
