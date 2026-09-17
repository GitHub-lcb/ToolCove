package com.githublcb.railpanel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import android.widget.Toast

/**
 * 悬浮面板的前台服务：把 HUD 压在其他应用（游戏）之上。
 *
 * 生命周期：MainActivity 在用户点「开启悬浮面板」时 startForegroundService，
 * 在 onStartCommand 里**立刻** startForeground（Android 规定 5 秒内，否则 ANR），
 * 然后才 addView。用户从通知或面板里关掉时 stopSelf。
 *
 * 几个必须写对、写错了只在真机上才暴露的点：
 *
 *  1) **窗口类型只能是 TYPE_APPLICATION_OVERLAY**（2038）。TYPE_PHONE / TYPE_SYSTEM_ALERT
 *     等旧类型从 Android 8.0 起对三方应用全部失效，用了就是 BadTokenException。
 *
 *  2) **FLAG_NOT_FOCUSABLE 要加**：不加就会把游戏的输入焦点抢过来，玩家在面板外点游戏会没反应。
 *     它隐含 FLAG_NOT_TOUCH_MODAL，所以面板外的触摸照常落到游戏上。
 *     代价是面板里的输入框拿不到软键盘——所以本面板**不放任何输入控件**
 *     （`<select>` 之类依赖子窗口的控件在 overlay 窗口里也不可靠），
 *     要打字/要选文件都走全屏页。这是刻意划的边界，不是没做完。
 *
 *  3) **FLAG_HARDWARE_ACCELERATED 要加**：WindowManager 直接 addView 的窗口不会自动获得
 *     硬件加速，不加则整个 WebView 走软件渲染，掉帧且部分内容画不出来。
 *
 *  4) **不要设 params.alpha < 1**：Android 12 起有「不受信任的触摸」规则
 *     （TYPE_APPLICATION_OVERLAY 不属于 trusted 窗口），它针对的是
 *     FLAG_NOT_TOUCHABLE 的穿透窗口；本面板是可触摸窗口，不受那条规则影响，
 *     但也没有任何豁免可蹭——真正的解法是**把面板做小、可拖、可收成一条**，
 *     少遮挡就少冲突。收起态就是为这个存在的。
 *
 *  5) **绝不在 Activity 生命周期里调 WebView.pauseTimers()**：它是进程级全局的，
 *     会把这块面板里的 JS 定时器一起停掉（见 RailState 的头注）。
 *
 * 与另一个 WebView 的同步：收到 RailState.ACTION_STATE 广播就 evaluateJavascript
 * 调页面的 window.railHud.applyStateJSON，页面自己抑制回声（不回传给原生）。
 */
class RailPanelService : Service(), RailBridge.Host {

    private lateinit var windowManager: WindowManager
    private var panel: FrameLayout? = null
    private var webView: WebView? = null
    private var params: WindowManager.LayoutParams? = null
    private var collapsed = false

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val json = intent.getStringExtra(RailState.EXTRA_JSON) ?: return
            pushState(json)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        registerReceiver(stateReceiver, IntentFilter(RailState.ACTION_STATE), RECEIVER_NOT_EXPORTED)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // 必须先 startForeground，再碰任何窗口——顺序反了在 Android 12+ 会直接被系统掐掉
        startForeground(NOTIFICATION_ID, buildNotification())

        // 权限可能在这一刻已被撤销（用户随时可以从通知栏进设置关掉悬浮窗）
        if (!Settings.canDrawOverlays(this)) {
            Toast.makeText(this, getString(R.string.overlay_denied_toast), Toast.LENGTH_LONG).show()
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_TOGGLE) {
            applyCollapsed(!collapsed)
            return START_STICKY
        }
        showPanel()
        return START_STICKY
    }

    override fun onDestroy() {
        unregisterReceiver(stateReceiver)
        panel?.let { view ->
            (view.getChildAt(0) as? WebView)?.let { web ->
                // 顺序要求：先从 view 树里摘掉，再 destroy
                view.removeView(web)
                web.destroy()
            }
            runCatching { windowManager.removeView(view) }
        }
        panel = null
        webView = null
        super.onDestroy()
    }

    // ── 面板 ─────────────────────────────────────────────────────────

    private fun showPanel() {
        if (panel != null) return

        val web = RailWebView(this, RailState.initialFor(this), if (collapsed) MODE_BAR else MODE_PANEL, RailBridge(this, this))
        webView = web

        val container = FrameLayout(this)
        container.addView(
            web,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT),
        )
        // 抓手：只有这一条 18dp 的窄条负责拖动。
        // 不给 WebView 挂 OnTouchListener——那会和它自己的滚动手势打架，
        // 结果是要么拖不动、要么点不准按钮。
        val handle = buildHandle()
        container.addView(
            handle,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, dp(HANDLE_HEIGHT_DP), Gravity.TOP),
        )

        val layoutParams = WindowManager.LayoutParams(
            if (collapsed) dp(BAR_WIDTH_DP) else dp(PANEL_WIDTH_DP),
            if (collapsed) dp(BAR_HEIGHT_DP) else dp(PANEL_HEIGHT_DP),
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            // 只保留这三个，**不要**再加 FLAG_LAYOUT_IN_SCREEN：
            // 它让窗口按整屏（含系统栏区域）布局，在 gravity = TOP|START 下会造成
            // 窗口的实际位置与触摸投递区域错位——表现就是浮窗「看得见、点不着」。
            // 面板本来就会被 clampToScreen 钳在屏幕内，不需要它来贴边。
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
            PixelFormat.TRANSLUCENT,
        ).apply {
            // 显式写死 TOP|START：位置完全由 x/y 决定，配合 clampToScreen 保证面板始终在屏内。
            // 「可见却点不着」最常见的两个成因就是重力与 LAYOUT_IN_SCREEN 不一致导致的
            // 窗口位置与触摸投递区域错位，所以这两处都不留默认值。
            gravity = Gravity.TOP or Gravity.START
            val saved = restorePosition()
            x = saved.first
            y = saved.second
            // 刘海/挖孔屏：让窗口可以延伸到短边，否则面板可能被系统推离我们计算的位置
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }

        try {
            windowManager.addView(container, layoutParams)
        } catch (e: Exception) {
            // 权限被撤销时就是这里抛 BadTokenException("permission denied for window type 2038")。
            // 不要循环重试——引导用户回授权页，然后停掉服务。
            Toast.makeText(this, getString(R.string.overlay_denied_toast), Toast.LENGTH_LONG).show()
            stopSelf()
            return
        }
        panel = container
        params = layoutParams
    }

    /** 顶部的拖动窄条：中间一条短横杠做视觉暗示，整条都是拖拽区。 */
    private fun buildHandle(): View {
        val bar = TextView(this).apply {
            text = "⋯"
            setTextColor(Color.argb(150, 128, 128, 128))
            gravity = Gravity.CENTER
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            background = GradientDrawable().apply {
                setColor(Color.argb(40, 128, 128, 128))
                cornerRadius = dp(4).toFloat()
            }
        }
        bar.setOnTouchListener(DragListener())
        return bar
    }

    /**
     * 拖动 + 点击（点一下 = 在「展开」和「收成一条」之间切换）。
     *
     * 用 scaledTouchSlop 而不是硬编码 10px：这个阈值随屏幕密度变化，
     * 写死数字在高密度屏上会把「手抖了一下的点击」判成拖动。
     */
    private inner class DragListener : View.OnTouchListener {
        private var startX = 0
        private var startY = 0
        private var touchX = 0f
        private var touchY = 0f
        private var dragging = false
        private val slop = ViewConfiguration.get(this@RailPanelService).scaledTouchSlop

        override fun onTouch(view: View, event: MotionEvent): Boolean {
            val lp = params ?: return false
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    startX = lp.x
                    startY = lp.y
                    touchX = event.rawX
                    touchY = event.rawY
                    dragging = false
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - touchX
                    val dy = event.rawY - touchY
                    if (!dragging && (Math.abs(dx) > slop || Math.abs(dy) > slop)) dragging = true
                    if (dragging) {
                        lp.x = startX + dx.toInt()
                        lp.y = startY + dy.toInt()
                        clampToScreen(lp)
                        runCatching { windowManager.updateViewLayout(panel, lp) }
                    }
                    return true
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    if (dragging) savePosition(lp.x, lp.y) else applyCollapsed(!collapsed)
                    return true
                }
            }
            return false
        }
    }

    /**
     * 把面板钳在屏幕内。
     *
     * 注意**不加 FLAG_LAYOUT_NO_LIMITS**：加了窗口就能跑到屏幕外，
     * 那时用户既看不到面板也拿不回来（除非改代码）。这里宁可让它贴边，
     * 也不要一个「消失在屏幕外」的状态。
     */
    private fun clampToScreen(lp: WindowManager.LayoutParams) {
        val metrics = resources.displayMetrics
        lp.x = lp.x.coerceIn(-dp(8), metrics.widthPixels - dp(40))
        lp.y = lp.y.coerceIn(0, metrics.heightPixels - dp(24))
    }

    private fun applyCollapsed(next: Boolean) {
        if (collapsed == next && panel != null) return
        collapsed = next
        val lp = params ?: return
        lp.width = dp(if (next) BAR_WIDTH_DP else PANEL_WIDTH_DP)
        lp.height = dp(if (next) BAR_HEIGHT_DP else PANEL_HEIGHT_DP)
        clampToScreen(lp)
        runCatching { windowManager.updateViewLayout(panel, lp) }
        evaluate("window.railHud && window.railHud.setMode('${if (next) MODE_BAR else MODE_PANEL}')")
        saveCollapsed(next)
    }

    // ── RailBridge.Host ──────────────────────────────────────────────

    /**
     * 面板里的导出/导入转交全屏页。
     *
     * 面板是 FLAG_NOT_FOCUSABLE 的，软键盘弹不出来；`<select>`、文件选择器这些
     * 依赖子窗口/PopupWindow 的控件在 overlay 窗口里也不可靠。所以「要打字、要弹系统界面」
     * 的动作一律交给 Activity——这是边界，不是待办。
     */
    override fun openSupport(action: String) {
        val intent = Intent(this, SupportActivity::class.java)
            .setAction(action)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
    }

    override fun onCollapseRequest(collapsed: Boolean) = applyCollapsed(collapsed)

    // ── 跨窗口同步 ───────────────────────────────────────────────────

    private fun pushState(json: String) {
        val escaped = org.json.JSONObject.quote(json)
        evaluate("window.railHud && window.railHud.applyStateJSON($escaped)")
    }

    private fun evaluate(script: String) {
        webView?.evaluateJavascript(script, null)
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        // 旋屏后屏幕变小可能把面板留在界外，重新钳一次
        params?.let {
            clampToScreen(it)
            runCatching { windowManager.updateViewLayout(panel, it) }
        }
    }

    // ── 通知与持久化 ─────────────────────────────────────────────────

    private fun buildNotification(): Notification {
        ensureChannel()
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val toggle = PendingIntent.getService(
            this,
            1,
            Intent(this, RailPanelService::class.java).setAction(ACTION_TOGGLE),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_rail)
            .setContentTitle(getString(R.string.notif_title))
            .setContentText(getString(R.string.notif_text))
            // PRIORITY_LOW 是前台服务通知的下限（再低系统不接受）
            .setPriority(Notification.PRIORITY_LOW)
            .setOngoing(true)
            .setContentIntent(open)
            .addAction(
                Notification.Action.Builder(null, getString(R.string.notif_toggle), toggle).build(),
            )
            .build()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.notif_channel), NotificationManager.IMPORTANCE_LOW).apply {
                description = getString(R.string.notif_channel_desc)
                setShowBadge(false)
            },
        )
    }

    private fun prefs() = getSharedPreferences(PREFS, MODE_PRIVATE)

    private fun savePosition(x: Int, y: Int) {
        prefs().edit().putInt(KEY_X, x).putInt(KEY_Y, y).apply()
    }

    /** 没存过位置就放右上角：那里最不容易压住游戏里的操作区。 */
    private fun restorePosition(): Pair<Int, Int> {
        val metrics = resources.displayMetrics
        val defaultX = metrics.widthPixels - dp(PANEL_WIDTH_DP) - dp(8)
        val defaultY = dp(96)
        return prefs().getInt(KEY_X, defaultX) to prefs().getInt(KEY_Y, defaultY)
    }

    private fun saveCollapsed(value: Boolean) = prefs().edit().putBoolean(KEY_COLLAPSED, value).apply()

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        const val ACTION_TOGGLE = "com.githublcb.railpanel.TOGGLE"

        const val MODE_PANEL = "panel"
        const val MODE_BAR = "bar"

        /**
         * 面板尺寸。360dp 宽正好是「一排三个类型按钮 + 一排四个提示按钮」不换行的下限；
         * 高度 272dp 是按 styles.css 里 panel 段算出来的：顶栏 18 + 结论 62 + 进度 20 +
         * 录入两行 88 + 间距，再加一点余量。改这里要同时改那边的注释，否则会出现
         * 「面板里看不见结论」这种只在真机上才发现的问题。
         */
        private const val PANEL_WIDTH_DP = 360
        private const val PANEL_HEIGHT_DP = 272
        private const val BAR_WIDTH_DP = 360
        private const val BAR_HEIGHT_DP = 46
        private const val HANDLE_HEIGHT_DP = 18

        private const val CHANNEL_ID = "rail_panel"

        /**
         * 前台服务的通知 ID。
         *
         * 公开：MainActivity 靠「这条通知还在不在」判断面板是否在运行——
         * 没有查询服务状态的公开 API，而进程内静态标志会被系统回收进程这件事骗到。
         */
        const val NOTIFICATION_ID = 4711
        private const val PREFS = "rail_panel"
        private const val KEY_X = "x"
        private const val KEY_Y = "y"
        private const val KEY_COLLAPSED = "collapsed"
    }
}
