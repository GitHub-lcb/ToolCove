package com.githublcb.railpanel

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * 主界面：全屏 HUD + 悬浮面板的开关与权限引导。
 *
 * 为什么不给这个 Activity 用 WebView 做主界面：它首先要回答的是
 * 「悬浮窗权限给没给、服务起没起」——这两件事是原生状态，页面里既读不到也改不了
 * （canDrawOverlays 要 Context，去设置页要 Intent）。所以这里是原生 UI，
 * 「完整 HUD」按一下再进 HUD WebView 页。
 *
 * 权限这块的三个坑（都来自 Android 的实际行为，不是风格问题）：
 *   - SYSTEM_ALERT_WINDOW 是 **app-op 特殊权限**，`requestPermissions()` 申请不了，
 *     只能把用户送到设置页。而且那个页面**不保证返回 result**，所以必须在 onResume
 *     重新查一次 canDrawOverlays，而不是等 onActivityResult。
 *   - POST_NOTIFICATIONS 拒了**不影响**前台服务运行，只是通知不进通知栏
 *     （系统「正在运行的应用」里仍然看得到、也仍然能停掉它）。所以这里只提示、不阻塞。
 *   - 跳授权页要 try/catch ActivityNotFoundException：部分 ROM 没有这个页面。
 */
class MainActivity : Activity() {

    private lateinit var statusText: TextView
    private lateinit var permissionButton: Button
    private lateinit var toggleButton: Button
    private lateinit var batteryText: TextView

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            // 面板里改了状态，这里只需要刷新一下「运行中」的提示（HUD 页自己会收状态）
            refresh()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(stateReceiver, IntentFilter(RailState.ACTION_STATE), RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(stateReceiver, IntentFilter(RailState.ACTION_STATE))
        }
    }

    override fun onResume() {
        super.onResume()
        // 授权页不保证回 result，回到前台必须重查一次——这是这条权限唯一的可靠信号
        refresh()
    }

    override fun onDestroy() {
        runCatching { unregisterReceiver(stateReceiver) }
        super.onDestroy()
    }

    // ── 界面 ─────────────────────────────────────────────────────────

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), dp(20))
            setBackgroundColor(if (isDark()) Color.parseColor("#0d1117") else Color.parseColor("#f6f8fa"))
        }

        root.addView(title(getString(R.string.app_name), 22f))
        root.addView(body(getString(R.string.intro)))
        root.addView(space(16))

        statusText = body("")
        root.addView(statusText)
        root.addView(space(12))

        permissionButton = actionButton(getString(R.string.grant_overlay)) { requestOverlayPermission() }
        root.addView(permissionButton)
        root.addView(space(8))

        toggleButton = actionButton(getString(R.string.start_panel)) { togglePanel() }
        root.addView(toggleButton)
        root.addView(space(8))

        root.addView(
            actionButton(getString(R.string.open_full)) {
                startActivity(Intent(this, HudActivity::class.java))
            },
        )
        root.addView(space(8))

        val notifButton = actionButton(getString(R.string.grant_notifications)) { requestNotificationPermission() }
        notifButton.visibility = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) View.VISIBLE else View.GONE
        root.addView(notifButton)
        root.addView(space(20))

        root.addView(sectionTitle(getString(R.string.section_battery)))
        batteryText = body(getString(R.string.battery_hint))
        root.addView(batteryText)
        root.addView(space(8))
        root.addView(actionButton(getString(R.string.open_battery_settings)) { openBatterySettings() })
        root.addView(space(20))

        root.addView(sectionTitle(getString(R.string.section_notes)))
        root.addView(body(getString(R.string.notes_body)))

        val scroll = ScrollView(this).apply { addView(root) }
        return scroll
    }

    private fun title(text: String, size: Float) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(if (isDark()) Color.WHITE else Color.parseColor("#1f2328"))
        setPadding(0, 0, 0, dp(8))
    }

    private fun sectionTitle(text: String) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        setTextColor(if (isDark()) Color.parseColor("#e6edf3") else Color.parseColor("#1f2328"))
        setPadding(0, 0, 0, dp(6))
    }

    private fun body(text: String) = TextView(this).apply {
        this.text = text
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f)
        setLineSpacing(dp(4).toFloat(), 1f)
        setTextColor(if (isDark()) Color.parseColor("#9aa4b0") else Color.parseColor("#5c6672"))
    }

    private fun actionButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        gravity = Gravity.CENTER
        layoutParams = LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
        )
        setOnClickListener { onClick() }
    }

    private fun space(dp: Int) = View(this).apply { layoutParams = LinearLayout.LayoutParams(1, dp(dp)) }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()

    private fun isDark() = (resources.configuration.uiMode and
        android.content.res.Configuration.UI_MODE_NIGHT_MASK) == android.content.res.Configuration.UI_MODE_NIGHT_YES

    // ── 状态刷新 ─────────────────────────────────────────────────────

    private fun refresh() {
        val granted = Settings.canDrawOverlays(this)
        val running = isPanelRunning()
        statusText.text = when {
            !granted -> getString(R.string.status_denied)
            running -> getString(R.string.status_running)
            else -> getString(R.string.status_granted)
        }
        permissionButton.visibility = if (granted) View.GONE else View.VISIBLE
        toggleButton.text = getString(
            when {
                !granted -> R.string.grant_overlay
                running -> R.string.stop_panel
                else -> R.string.start_panel
            },
        )
    }

    /**
     * 面板是否在运行。
     *
     * 没有「查询服务状态」的公开 API。本来想用一个进程内静态标志，但它会被系统回收
     * 进程这件事骗到：进程回来后面板其实还在跑，按钮却显示「开启」，点一下就变成了
     * 「关掉再开」——用户会以为面板坏了。
     *
     * 这里改用「前台服务的常驻通知还在不在」判断：前台服务必然带着一条通知，
     * 通知在 = 服务在。这是没有公开 API 时最接近事实的判据。
     */
    private fun isPanelRunning(): Boolean {
        val manager = getSystemService(NotificationManager::class.java) ?: return false
        return manager.activeNotifications.any { it.id == RailPanelService.NOTIFICATION_ID }
    }

    // ── 动作 ─────────────────────────────────────────────────────────

    private fun requestOverlayPermission() {
        val intent = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName"))
        try {
            startActivity(intent)
        } catch (e: Exception) {
            // 少数 ROM 没有这个页面，退到应用详情页
            runCatching {
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }.onFailure { Toast.makeText(this, R.string.no_settings_page, Toast.LENGTH_LONG).show() }
        }
    }

    private fun togglePanel() {
        if (!Settings.canDrawOverlays(this)) {
            requestOverlayPermission()
            return
        }
        if (isPanelRunning()) {
            stopService(Intent(this, RailPanelService::class.java))
        } else {
            // 只能启动服务、不能直接 startForeground（那不是 Activity 能调的 API）
            startForegroundService(Intent(this, RailPanelService::class.java))
        }
        // 服务是异步起来的，通知要等 startForeground 之后才出现；
        // 立刻刷新会读到旧状态，所以给一小段延迟再刷一次
        refresh()
        toggleButton.postDelayed({ refresh() }, 500)
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), REQUEST_NOTIFICATIONS)
    }

    private fun openBatterySettings() {
        val power = getSystemService(Context.POWER_SERVICE) as PowerManager
        // 已经在白名单里就没什么可引导的了，直接说清状态
        if (power.isIgnoringBatteryOptimizations(packageName)) {
            Toast.makeText(this, R.string.battery_already_ok, Toast.LENGTH_SHORT).show()
            return
        }
        runCatching {
            startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
        }.onFailure { requestOverlayPermission() }
    }

    companion object {
        private const val REQUEST_NOTIFICATIONS = 101
    }
}

/**
 * 全屏 HUD 页：就是那个 WebView 页面，只是铺满屏幕。
 *
 * 与悬浮面板是**两个独立的 WebView**（同一份资产、同一份数据）。
 * 它们之间的同步走 RailState 的广播，不用「搬移同一个 WebView」那条路——
 * 那条路没有官方保证，且实测反向搬移会两个窗口都不显示（见 RailState 头注）。
 */
class HudActivity : Activity() {
    private var web: WebView? = null
    private lateinit var bridge: RailBridge

    private val stateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val json = intent.getStringExtra(RailState.EXTRA_JSON) ?: return
            val escaped = org.json.JSONObject.quote(json)
            web?.evaluateJavascript("window.railHud && window.railHud.applyStateJSON($escaped)", null)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        bridge = RailBridge(this, host)
        web = RailWebView(this, RailState.initialFor(this), "full", bridge)
        setContentView(web)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(stateReceiver, IntentFilter(RailState.ACTION_STATE), RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            registerReceiver(stateReceiver, IntentFilter(RailState.ACTION_STATE))
        }
    }

    /**
     * 全屏页里导出/导入就地弹原生界面（它是 Activity，没有 overlay 窗口那些限制）。
     */
    private val host = object : RailBridge.Host {
        override fun openSupport(action: String) {
            startActivity(Intent(this@HudActivity, SupportActivity::class.java).setAction(action))
        }

        override fun onCollapseRequest(collapsed: Boolean) {
            // 全屏页不是悬浮窗，没有「收成一条」这回事
        }
    }

    /**
     * ⚠️ 这里**故意不调用** `web?.onPause()` / `pauseTimers()`。
     *
     * `pauseTimers()` 是**进程级全局**的：它会停掉所有 WebView 的 JS 定时器，
     * 包括悬浮面板那个实例——面板的录入、广播同步全靠 JS，停掉就等于面板假死。
     * 这是「两个 WebView」架构最容易踩、且只在真机上才暴露的坑。
     */
    override fun onDestroy() {
        runCatching { unregisterReceiver(stateReceiver) }
        (web?.parent as? ViewGroup)?.removeView(web)
        web?.destroy()
        web = null
        super.onDestroy()
    }
}
