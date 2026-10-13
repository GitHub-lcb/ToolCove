package com.githublcb.toolcove

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Looper
import android.provider.MediaStore
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.TextView
import com.githublcb.toolcove.bridge.Bridge
import com.githublcb.toolcove.bridge.PhotoCaptureKit

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
    /** 网页 `<input type="file">` 的请求码：与桥的 1001 分开，两条路径互不干扰。 */
    private val webChooserRequest = 1002
    /** 等待中的网页文件选择回调；同一时刻只允许一个（旧的回调必须先撤销，否则 WebView 会一直等）。 */
    private var webChooserCallback: ValueCallback<Array<Uri>>? = null
    /** 拍照落点（capture 路径专用）：相机把照片写进这个 URI，结果返回时还原成它。 */
    private var captureTarget: Uri? = null

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

            /**
             * `<input type="file">` 的落点。此前没有实现这个回调，网页里的文件输入是**死的**——
             * 照片工具的「拍照 / 从相册选」两个按钮点了没有任何反应，而 WebView 不会报错，
             * 是最难从日志发现的一类失败。
             *
             * 两条路径：
             *  · capture（`<input capture>`）：自己发 ACTION_IMAGE_CAPTURE，EXTRA_OUTPUT 指向
             *    本应用缓存目录（PhotoCaptureProvider）。照片不经系统相册中转，原始字节直接
             *    交给网页——与"选文件"的语义一致，也避免相册里多一份来源不明的副本。
             *  · 其余：参数原样交给系统选择器（相册 / 文件管理器），多选由 WebView 自带。
             */
            override fun onShowFileChooser(
                webView: WebView,
                callback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                // 上一个请求还挂着就先撤销（连续点两次时 WebView 会复用同一个回调槽）
                webChooserCallback?.onReceiveValue(null)
                webChooserCallback = callback
                captureTarget = null

                val wantsCapture = Build.VERSION.SDK_INT >= 30 && fileChooserParams.isCaptureEnabled
                if (wantsCapture) {
                    val target = createCaptureTarget(fileChooserParams)
                    if (target != null) {
                        return try {
                            captureTarget = target
                            startActivityForResult(captureIntent(target), webChooserRequest)
                            true
                        } catch (e: Exception) {
                            // 没有相机应用等：退回系统选择器，而不是让按钮点了没反应
                            android.util.Log.w("ToolCove", "capture intent failed: $e")
                            captureTarget = null
                            launchSystemChooser(fileChooserParams, callback)
                        }
                    }
                }
                return launchSystemChooser(fileChooserParams, callback)
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

    /**
     * 在 UI 线程发起一个系统界面，返回是否成功（桥的工作线程不能直接 startActivity）。
     *
     * 必须等 UI 线程真的跑完再返回：`runOnUiThread` 是 post，旧写法 post 完立刻读 `launched`，
     * 在桥的工作线程上恒为 false——选择器其实已经弹了，却回「当前无法打开文件选择器」，
     * 文件 / 数据库 / 备份恢复入口全部白忙一场。
     */
    private fun onUi(block: () -> Unit): Boolean {
        if (Looper.myLooper() == Looper.getMainLooper()) return runCatching(block).isSuccess
        var launched = false
        val done = java.util.concurrent.CountDownLatch(1)
        runOnUiThread {
            try {
                launched = runCatching(block).isSuccess
            } finally {
                done.countDown()
            }
        }
        // 等不到 UI 线程回话就判失败（宁可报"打不开"也不要谎报"已打开"）
        return done.await(5, java.util.concurrent.TimeUnit.SECONDS) && launched
    }

    /** 文件选择器：拿持久读/写权限，否则选完离开本次会话就再也读不到那个文件。 */
    private fun documentIntent(mimeType: String) = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = mimeType.ifBlank { "*/*" }
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
    }

    /** 交回空结果并撤下等待中的回调：页面表现为「取消」，而不是永远转圈。返回 false 给 WebView。 */
    private fun failChooser(callback: ValueCallback<Array<Uri>>): Boolean {
        webChooserCallback = null
        callback.onReceiveValue(null)
        return false
    }

    /** 交给系统选择器（相册 / 文件管理器）。 */
    private fun launchSystemChooser(params: WebChromeClient.FileChooserParams, callback: ValueCallback<Array<Uri>>): Boolean {
        return try {
            startActivityForResult(params.createIntent(), webChooserRequest)
            true
        } catch (e: Exception) {
            android.util.Log.w("ToolCove", "file chooser failed: $e")
            failChooser(callback)
        }
    }

    /**
     * 拍照落点（缓存目录内的 capture-<时间戳>.jpg）。返回 null 表示建不出来，调用方退回系统选择器。
     * 顺手清理过期的拍照临时文件——上传与否都以时间为界，缓存不无限涨。
     */
    private fun createCaptureTarget(params: WebChromeClient.FileChooserParams): Uri? {
        // 只接管"拍照取图"：视频录制落点是另一种文件形状，交给系统选择器，不在这里硬撑
        val acceptsImages = params.acceptTypes.isEmpty() || params.acceptTypes.any { it.startsWith("image/") }
        if (params.acceptTypes.any { it.startsWith("video/") } || !acceptsImages) return null
        return runCatching {
            val now = System.currentTimeMillis()
            PhotoCaptureKit.pruneStale(cacheDir, now)
            PhotoCaptureKit.captureDir(cacheDir)
            Uri.parse("content://${PhotoCaptureKit.AUTHORITY}/capture/${PhotoCaptureKit.newCaptureName(now)}")
        }.getOrNull()
    }

    /** capture 意图。clipData 授权是对部分 OEM 相机的兼容路径（只看 EXTRA_OUTPUT 会拿不到写权限）。 */
    private fun captureIntent(target: Uri) = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
        putExtra(MediaStore.EXTRA_OUTPUT, target)
        clipData = android.content.ClipData.newRawUri("capture", target)
        addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_READ_URI_PERMISSION)
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
        if (requestCode == webChooserRequest) {
            val callback = webChooserCallback ?: return
            webChooserCallback = null
            val target = captureTarget
            captureTarget = null
            val uris: Array<Uri>? = when {
                // 拍照路径：相机把字节写进我们的 EXTRA_OUTPUT（data 里不带 URI），
                // 空文件按"取消"处理——交回一个空 URI 会让网页拿到 0 字节照片。
                target != null -> if (resultCode == RESULT_OK && captureHasBytes(target)) arrayOf(target) else null
                else -> WebChromeClient.FileChooserParams.parseResult(resultCode, data)
            }
            android.util.Log.i("ToolCove", "web chooser result: ${uris?.size ?: 0} file(s)")
            callback.onReceiveValue(uris)
            return
        }
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

    /** 相机是否真的写进了内容（有的相机 RESULT_OK 但文件为空）。 */
    private fun captureHasBytes(target: Uri): Boolean {
        val name = target.lastPathSegment ?: return false
        return runCatching { PhotoCaptureKit.resolveCaptureFile(cacheDir, name).length() > 0L }.getOrDefault(false)
    }

    override fun onDestroy() {
        // 让还在等选择器的请求立刻结束，避免线程白等到超时
        native?.cancelPending()
        native = null
        // 网页侧等待中的文件选择同样要撤销，否则页面以为用户还没选完
        webChooserCallback?.onReceiveValue(null)
        webChooserCallback = null
        captureTarget = null
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
