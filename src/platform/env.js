// 平台判定与能力清单：桌面（Tauri）/ 浏览器（静态站点）/ 手机端（安卓 App）的唯一真相源。
//
// 三种形态的判定顺序（手机端优先）：手机端由构建期常量 `__MOBILE__` 标记（见 mobile/vite.mobile.config.js），
// 这样同一份 src/ 能在三个目标里各自正确——桌面端与网页端的行为一字不变。
// 约定：Node 单测环境无 window，按桌面处理，既有用例继续走 IPC 分支。
export const isMobile = typeof __MOBILE__ !== "undefined" && __MOBILE__ === true;
export const isDesktop = !isMobile && (typeof window === "undefined" || !!window.__TAURI_INTERNALS__);
export const isBrowser = !isMobile && !isDesktop;

/**
 * 能力开关：UI 据此隐藏或降级不可用功能。
 * 手机端的取值不是「照抄桌面」而是**如实反映安卓上能做成什么**（见 docs/mobile-app-plan.md §1）：
 *  - multiWindow：安卓没有 Tauri 多窗口，工具改为全屏页面；
 *  - jdbc：安卓没有 JDBC → false，数据库能力改走 SQLite（capabilities.sqlite）；
 *  - rawPrint：TSPL 指令生成与预览可用，但 Windows RAW 打印队列不存在 → false；
 *  - icmpDiagnostics：WebView 无 ICMP/原始套接字 → false（只保留 TCP 连通性检测）。
 */
export const capabilities = {
  multiWindow: isDesktop, // 工具独立窗口与跨窗口消息
  nativeDialog: isDesktop, // 系统文件选择/保存对话框（手机端走 SAF，见 filePicker）
  localFile: isDesktop, // 本地文件读写与批量改名（file_tool_*）
  filePicker: isDesktop || isMobile, // 文件选择：桌面=系统对话框，手机=SAF
  jdbc: isDesktop, // JDBC 数据库工具
  sqlite: isDesktop || isMobile, // SQLite 本地库（手机端用 android.database.sqlite）
  git: isDesktop, // 本地仓库 git pull
  systemProxy: isDesktop || isMobile, // 原生 HTTP 代理（绕过 CORS）：手机端由 Kotlin 桥提供
  secureStore: isDesktop || isMobile, // 系统密钥库：桌面=DPAPI，手机=Android Keystore
  updater: isDesktop, // 自动更新（手机端由应用商店/手动安装，暂不做）
  autostart: isDesktop, // 开机自启
  tray: isDesktop, // 系统托盘
  backup: true, // 数据备份/恢复：桌面=zip 落盘，手机=JSON 导出 + SAF 选文件恢复（见 mobile/app/backup.js）
  telemetryUpload: isDesktop,
  cloudSync: isDesktop || isMobile, // 云同步：手机端依赖 Kotlin HTTP 桥
  imageStore: true, // 图片附件：浏览器/手机端落 IndexedDB
  aiRequest: true, // AI 请求：桌面经 Rust 代理、手机经 Kotlin 桥、浏览器直连
  rawPrint: isDesktop, // 标签机 RAW 打印（Windows 打印队列）
  icmpDiagnostics: isDesktop, // ping / traceroute / DNS 等网络诊断
};

export function desktopOnly(command) {
  const error = new Error(`「${command}」为桌面版能力，当前平台暂不提供`);
  error.code = "DESKTOP_ONLY";
  error.command = command;
  return error;
}
