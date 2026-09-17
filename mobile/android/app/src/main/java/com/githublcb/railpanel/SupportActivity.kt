package com.githublcb.railpanel

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Toast

/**
 * 导出 / 导入页。
 *
 * 它是「悬浮窗做不了的事」的容器：面板是 FLAG_NOT_FOCUSABLE 的（不抢游戏焦点，
 * 代价是软键盘弹不出来），`<select>` 与文件选择器这类依赖子窗口的控件在 overlay 窗口里
 * 也不可靠。所以凡是**要打字 / 要弹系统界面**的动作，一律把用户送到这里来做。
 *
 * 这里仍然复用同一个 HUD 页面（只是 mode=full），而不是另写一套原生表单：
 * 导入的校验规则（kind 不对就拒绝、非法值归一、越界提示清掉）只有一份，
 * 放在页面里才不会出现「原生导入和页面导入行为不一致」。
 *
 * 文件选择走 ACTION_OPEN_DOCUMENT（SAF），不申请任何存储权限：
 * 拿到的是用户明确授权的那一个文件的一次性访问权。
 */
class SupportActivity : Activity() {

    private var web: WebView? = null

    private val host = object : RailBridge.Host {
        override fun openSupport(action: String) {
            // 已经在这一页里了
        }

        override fun onCollapseRequest(collapsed: Boolean) {
            // 这里不是悬浮窗
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = getString(
            when (intent?.action) {
                ACTION_EXPORT -> R.string.export_title
                ACTION_RECORDS -> R.string.records_title
                ACTION_RESET -> R.string.reset_confirm_title
                else -> R.string.import_title
            },
        )

        // 悬浮窗转交过来的导出内容优先：它可能比 SharedPreferences 里的更新
        // （面板刚落了一笔、广播还没写完盘）。RailBridge.saveFile 会把 JSON 放进这个槽位。
        val pending = pendingExport
        val bootstrapState = if (intent?.action == ACTION_EXPORT && pending != null) pending.json else RailState.read(this)

        val view = RailWebView(this, bootstrapState, "full", RailBridge(this, host))
        web = view
        setContentView(
            view,
            ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )

        // 页面初始化完成后，把「要打开哪张卡」告诉它。
        // 用 postDelayed 而不是等 onPageFinished：页面是内联脚本，加载完就已经渲染好了，
        // 而这两个函数只是打开一个弹层，早一点晚一点都不会错——反而等回调会引入
        // 「页面已渲染但原生还没收到回调」的空窗期，用户会看到一次闪动。
        view.postDelayed({
            when (intent?.action) {
                ACTION_EXPORT -> evaluate("window.railHudExport && window.railHudExport()")
                ACTION_IMPORT -> evaluate("window.railHudImport && window.railHudImport()")
                ACTION_RECORDS -> evaluate("window.railHudRecords && window.railHudRecords()")
                // 清空用**原生**对话框，不经过页面：确认之后直接调页面的 confirmReset()。
                // 这样两条入口（页内弹层 / 原生对话框）最终都落到同一段执行逻辑，
                // 不会出现「原生清了、页面还留着旧记录」这种分叉。
                ACTION_RESET -> confirmReset()
            }
            pendingExport = null
        }, 350)
    }

    /**
     * 「清空全部 16 站」的原生确认框。
     *
     * 为什么用原生 AlertDialog 而不是页内弹层：悬浮窗里页内弹层的按钮会压在手势导航条上、
     * 点了没反应（真机反馈），所以面板把清空整件事转交到这里；既然已经在 Activity 里了，
     * 用一个原生对话框比再加载一层页面更直接，也不受 WebView 子窗口那类问题的牵连。
     */
    private fun confirmReset() {
        AlertDialog.Builder(this)
            .setTitle(R.string.reset_confirm_title)
            .setMessage(R.string.reset_confirm_body)
            .setNegativeButton(R.string.reset_cancel) { dialog, _ -> dialog.dismiss() }
            .setPositiveButton(R.string.reset_ok) { dialog, _ ->
                evaluate("window.railHud && window.railHud.confirmReset()")
                dialog.dismiss()
            }
            .setOnDismissListener {
                // 确认框关掉就没什么可做的了，回到面板（用户按返回键即可）
            }
            .show()
    }

    private fun evaluate(script: String) = web?.evaluateJavascript(script, null)

    /**
     * 页面点了「选择文件…」→ 原生弹 SAF 选择器 → 把内容灌回页面。
     * 解析与应用留在页面里，原生只负责「拿到那段文本」。
     */
    fun pickFile() {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/json"
            putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/json", "text/plain", "*/*"))
        }
        runCatching { startActivityForResult(intent, REQUEST_PICK) }
            .onFailure { Toast.makeText(this, R.string.no_file_picker, Toast.LENGTH_LONG).show() }
    }

    @Deprecated("startActivityForResult 在这个只有两个页面、且不需要生命周期回调的场景里够用")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQUEST_PICK || resultCode != RESULT_OK) return
        val uri: Uri = data?.data ?: return
        val text = runCatching {
            contentResolver.openInputStream(uri)?.bufferedReader()?.use { it.readText() }
        }.getOrNull()
        if (text.isNullOrBlank()) {
            Toast.makeText(this, R.string.file_read_failed, Toast.LENGTH_LONG).show()
            return
        }
        // 灌回页面：校验与归一都在那边（只有一份规则）
        val escaped = org.json.JSONObject.quote(text)
        evaluate("window.railHud && window.railHud.applyImportText($escaped)")
    }

    override fun onDestroy() {
        (web?.parent as? ViewGroup)?.removeView(web)
        web?.destroy()
        web = null
        super.onDestroy()
    }

    companion object {
        const val ACTION_EXPORT = "com.githublcb.railpanel.EXPORT"
        const val ACTION_IMPORT = "com.githublcb.railpanel.IMPORT"

        /**
         * 面板转交过来的另两件事。悬浮窗里不能开页内弹层（按钮会压在手势导航条上、
         * 点了没反应），所以「全部记录」和「清空确认」也走到这一页来做。
         *
         * ⚠️ 这四个字符串必须与 mobile/rail-hud/main.js 顶部的 ACTION_* 常量逐字一致：
         * 它们是 JS 与原生之间唯一的协议，写错不会编译报错，只会「点了没反应」。
         */
        const val ACTION_RECORDS = "com.githublcb.railpanel.RECORDS"
        const val ACTION_RESET = "com.githublcb.railpanel.RESET"

        private const val REQUEST_PICK = 201

        /**
         * 悬浮窗转交过来的导出内容（进程内一次性槽位）。
         *
         * 悬浮窗自己是 FLAG_NOT_FOCUSABLE 的，没法在那里显示可复制的 JSON，
         * 所以它把内容放到这里再拉起本页。用静态字段而不是 Intent extra：
         * JSON 可能上百 KB，塞进 Intent 会撞上 Binder 事务大小限制（~1MB）并且很难排查。
         */
        var pendingExport: PendingText? = null
    }
}
