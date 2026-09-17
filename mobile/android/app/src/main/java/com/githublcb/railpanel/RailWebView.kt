package com.githublcb.railpanel

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.view.View
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * HUD 页面的 WebView 封装。悬浮窗和全屏页各持有一个实例，配置必须完全一致——
 * 两边是同一个页面（assets/index.html），配置漂移会变成「同样的操作在面板里行、在全屏页里不行」。
 *
 * 三个必须显式打开的开关（默认值都是关闭的，漏一个就是白屏或数据不落盘）：
 *   - javaScriptEnabled：默认 false。整个 HUD 是 JS 渲染的。
 *   - domStorageEnabled：默认 false。进度状态也写一份在 localStorage 里。
 *   - allowFileAccess：targetSdk 30+ 默认 false。
 *
 * ⚠️ 不要在这里（或任何生命周期里）调用 `pauseTimers()`：它是**进程级全局**的，
 * 会把另一个 WebView 的 JS 定时器一起停掉。这是「两个 WebView」架构最典型的事故。
 */
@SuppressLint("SetJavaScriptEnabled")
class RailWebView(
    context: Context,
    initialJson: String,
    mode: String,
    bridge: RailBridge,
    /** 当前朝向（portrait / landscape）：页面据此摆版面、决定切换按钮写的是哪个目标方向。 */
    orientation: String = RailBridge.ORIENT_PORTRAIT,
) : WebView(context) {

    init {
        settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            @Suppress("DEPRECATION")
            allowFileAccess = true
            textZoom = 100 // 不让系统字体缩放把算好的版面撑破
        }
        // 页面内部不需要跳外链；真要跳交给系统浏览器，免得把面板变成浏览器
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean = url.startsWith("http")
        }
        setBackgroundColor(Color.TRANSPARENT)
        addJavascriptInterface(bridge, "railHudApi")
        loadHud(initialJson, mode, orientation)
    }

    /**
     * 加载页面，并把「初始状态 / 模式 / 语言」注入进去。
     *
     * 为什么初始状态由原生注入、而不是让页面自己去读：
     *   - 页面在 file:// 下读不到 SharedPreferences；
     *   - localStorage 在「刚装完」和「另一个窗口刚改过」这两种情况下都不等于真源。
     * 注入一份权威值，直接消掉一整类竞态。
     *
     * 注入方式必须是**内容拼接**而不是先 evaluateJavascript：
     * evaluateJavascript 是异步的，写在 loadUrl 之前会打到一个还不存在的文档上，
     * 写在之后又不能保证早于页面的 DOMContentLoaded（正是它的正常执行时机）。
     * 所以这里把整份 HTML 读进来，在 <head> 之后插一段 bootstrap 脚本，再用
     * loadDataWithBaseURL 以 file 源加载——同源（baseUrl 保持 file:///android_asset/），
     * localStorage 归属不变，而 bootstrap 保证先于页面脚本执行。
     * 产物是单文件（样式与脚本都已内联），没有相对资源要解析，所以这种加载方式没有副作用。
     */
    private fun loadHud(initialJson: String, mode: String, orientation: String) {
        val bootstrap = JSONObject()
            .put("state", initialJson)
            .put("mode", mode)
            .put("lang", java.util.Locale.getDefault().language)
            .put("orientation", orientation)
            .toString()

        val html = try {
            context.assets.open(ASSET_NAME).bufferedReader().use { it.readText() }
        } catch (e: Exception) {
            // 资产缺失是打包事故，直接显示出来比白屏好排查得多
            loadDataWithBaseURL(BASE_URL, errorHtml(e.message), "text/html", "utf-8", null)
            return
        }

        val script = "<script>window.__railBootstrap=$bootstrap;</script>"
        val injected = if (html.contains("<head>")) {
            html.replaceFirst("<head>", "<head>$script")
        } else {
            script + html
        }
        loadDataWithBaseURL(BASE_URL, injected, "text/html", "utf-8", null)
    }

    private fun errorHtml(message: String?) = """
        <!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
        <body style="font:14px/1.5 sans-serif;padding:16px">
        <b>面板资源缺失</b><p>$ASSET_NAME 没能从 APK 里读出来。</p>
        <pre style="white-space:pre-wrap;color:#a00">${message ?: ""}</pre></body>
    """.trimIndent()

    companion object {
        /**
         * 单文件产物的资产名（见 mobile/rail-hud/build.mjs）。
         *
         * baseUrl 用 file 源而不是 https://appassets…：产物里所有资源都已内联，
         * 不存在需要按源解析的相对请求，所以不需要 WebViewAssetLoader（也就不需要 androidx）。
         * 而 file 源能让 localStorage 有一个稳定的归属，进度不会因为换个加载方式就消失。
         */
        const val ASSET_NAME = "index.html"
        const val BASE_URL = "file:///android_asset/"
    }
}
