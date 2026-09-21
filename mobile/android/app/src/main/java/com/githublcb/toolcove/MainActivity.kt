package com.githublcb.toolcove

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import com.githublcb.toolcove.bridge.Bridge

/**
 * 唯一 Activity：全屏 WebView + 本地资源服务。
 *
 * 与上一代手机端（铁路大亨悬浮面板）的差别是定位不同：那是 TYPE_APPLICATION_OVERLAY 悬浮窗，
 * 这是**正常的全屏应用**——所以没有悬浮窗权限、没有前台服务、没有通知，manifest 也干净得多。
 *
 * 启动顺序很关键：先起本地服务拿到基地址，再加载页面。起不来就**如实显示错误**，
 * 而不是留一个白屏（白屏是最难排查的失败形态）。
 */
class MainActivity : Activity() {

    private var webView: WebView? = null
    private var server: AssetsServer? = null
    private var native: AndroidNative? = null
    /** 文件选择请求码：固定值即可，只有一处使用。 */
    private val pickFileRequest = 1001

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val container = FrameLayout(this)
        val view = WebView(this)
        webView = view
        container.addView(
            view,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        setContentView(container)

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true // localStorage/IndexedDB 的开关，数据层要用
            databaseEnabled = true
            // 允许 http://127.0.0.1 下的混合内容（页面本身是 http，无混合问题；预留给将来 https 化）
            mixedContentMode = WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE
            // 不让 WebView 自己缩放：布局由前端的 viewport 负责（scale=1 时字体更可控）
            setSupportZoom(false)
            builtInZoomControls = false
            // 明确不带 UA 里的 "wv" 标识之外的额外伪装：保持真实，便于排查
        }
        WebView.setWebContentsDebuggingEnabled(true) // 侧载调试：chrome://inspect 可连

        view.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                // 把前端日志转到 logcat，装机排查时不必连调试器
                android.util.Log.i("ToolCoveWeb", "${message.message()} @${message.lineNumber()}")
                return true
            }
        }
        view.webViewClient = WebViewClient()

        // 原生桥：命令名与桌面端 platform/invoke 完全同名（http_request / network_tcp_check /
        // encrypt_text / decrypt_text / file_pick / file_tool_read_text …），
        // 所以 src/ 里的 repository、sync、ai 一行都不用改。
        // 只暴露两个成员（isMobile 与 invoke），且只服务本地页面——多一个成员就多一个攻击面。
        // 三个"要弹系统界面"的动作都以回调形式注入原生能力层：桥的工作线程不是 UI 线程，
        // startActivity 必须回 UI 线程执行；返回 false 表示当前没有可用的 Activity（如已销毁）。
        // 写成具名参数而不是尾随 lambda：Kotlin 只允许一个尾随 lambda，三个只能具名。
        val ops = AndroidNative(
            context = applicationContext,
            launchPicker = { mime -> onUi { startActivityForResult(documentIntent(mime), pickFileRequest) } },
            launchInstall = { uri -> onUi { startActivity(installIntent(uri)) } },
            launchUnknownSources = { onUi { startActivity(unknownSourcesIntent()) } },
        )
        native = ops
        view.addJavascriptInterface(ToolCoveBridge(Bridge(ops)), "ToolCove")

        val base = try {
            AssetsServer(assets).also { server = it }.start()
        } catch (e: Exception) {
            showStartupError(e)
            return
        }
        // 把 assets 的实际布局写进日志：装机后 `adb logcat -s ToolCove` 一眼能看出资源有没有打进包
        android.util.Log.i("ToolCove", "assets: ${server?.describeLayout()}")
        android.util.Log.i("ToolCove", "serving at $base")
        view.loadUrl("$base/index.html")
    }

    /** 在 UI 线程发起一个系统界面，返回是否成功（桥的工作线程不能直接 startActivity）。 */
    private fun onUi(block: () -> Unit): Boolean {
        var launched = false
        runOnUiThread { launched = runCatching(block).isSuccess }
        return launched
    }

    /** 文件选择器：拿持久读/写权限，否则选完离开本次会话就再也读不到那个文件。 */
    private fun documentIntent(mimeType: String) = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = mimeType.ifBlank { "*/*" }
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    /**
     * 系统安装页。授权 URI 只对这一次调用有效（不 grant 持久权限）：
     * 安装包是本 App 自己下的临时文件，给久了等于留一条长期可读的口子。
     */
    private fun installIntent(uri: Uri) = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }

    /** 用户还没授过"安装未知应用"时，把他送到该 App 的授权设置页——而不是点了安装没反应。 */
    private fun unknownSourcesIntent() = Intent(
        android.provider.Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
        Uri.parse("package:$packageName"),
    ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)

    /** 本地服务起不来时给出可读原因（端口被占、assets 缺失等），而不是白屏。 */
    private fun showStartupError(error: Exception) {
        val text = TextView(this).apply {
            text = getString(R.string.startup_failed, error.message ?: error.javaClass.simpleName)
            setPadding(48, 96, 48, 48)
            textSize = 16f
        }
        setContentView(text)
    }

    /**
     * 系统返回键：网页内先入栈历史，到栈底才交给系统退出。
     * 前端不需要为「返回」做任何特殊处理——它只是普通的 history 前进/后退。
     */
    @Deprecated("Deprecated in API 33, still the correct hook for WebView back handling")
    override fun onBackPressed() {
        val view = webView
        if (view != null && view.canGoBack()) {
            view.goBack()
            return
        }
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    /**
     * 文件选择器的结果。
     *
     * 用户取消时 resultCode 不是 RESULT_OK、data 为 null —— 这两种情况都要**把空结果交回去**，
     * 让挂起等待的桥线程立刻返回空串（前端表现为"取消"），而不是白等到超时。
     */
    @Deprecated("Deprecated in API 30+, startActivityForResult is still the simplest hook here")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == pickFileRequest) {
            val uri: Uri? = if (resultCode == RESULT_OK) data?.data else null
            if (uri != null) {
                // 把持久读/写权限真的接下来：不调用的话，离开本次会话后就再也读不到这个文件
                runCatching {
                    contentResolver.takePersistableUriPermission(
                        uri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
                    )
                }
                android.util.Log.i("ToolCove", "picked: $uri")
            } else {
                android.util.Log.i("ToolCove", "file pick cancelled")
            }
            native?.onPicked(uri?.toString())
            return
        }
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onDestroy() {
        // 让还在等选择器的请求立刻结束，避免线程白等到超时
        native?.cancelPending()
        native = null
        webView?.apply {
            loadUrl("about:blank")
            destroy()
        }
        webView = null
        server?.stop()
        server = null
        super.onDestroy()
    }
}
