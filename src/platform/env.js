// 平台判定与能力清单：桌面（Tauri）/ 浏览器（静态站点）/ 手机端（安卓 App 或手机网页版）的唯一真相源。
//
// **"手机形态"与"有原生能力"是两件事**（1.3.2 的教训，两者混同过一次）：
//   · 手机形态（`isMobile`，构建期常量 `__MOBILE__`）：界面按手机重排（mobile/app/…）。
//     GitHub Pages 上给 iPhone 用的那份产物与 APK 里的是**同一份**（见 .github/workflows/pages.yml）。
//   · 原生桥（`hasNativeBridge`，运行时探测）：安卓壳真的注入了 `window.ToolCove.invoke`。
//     iOS 网页版没有壳，也就没有桥——它必须按**浏览器端**跑：能力如实报 false、命令走 fetch/IndexedDB。
// 早先这里把手机形态直接当成"有原生能力"（sqlite / secureStore / systemProxy / filePicker / cloudSync
// 一律报 true），于是 iPhone 上界面露出一批必然失败的入口（本地数据库、SAF 选择器、云同步），
// 照片工具也不会提示"凭据只存在浏览器本地"。
//
// 三种形态的判定顺序（手机端优先）：手机端由构建期常量标记，这样同一份 src/ 能在三个目标里各自正确。
// 约定：Node 单测环境无 window，按桌面处理，既有用例继续走 IPC 分支。
export const isMobile = typeof __MOBILE__ !== "undefined" && __MOBILE__ === true;
export const isDesktop = !isMobile && (typeof window === "undefined" || !!window.__TAURI_INTERNALS__);
export const isBrowser = !isMobile && !isDesktop;

// 版本（edition）判定：personal（个人版）/ enterprise（企业版），与上面的平台判定同构——
// 契约的 scope 字段按它投影出两个版本（见 docs/agent-workspace-plan.md「契约加 scope」）。
// 现在是常量开关：默认个人版；二期将从 settings 的企业服务器配置派生
// （isEnterprise = !!企业服务器配置）。globalThis.__TOOLCOVE_EDITION__ 是给测试
// 与二期企业配置留的钩子，用 typeof 判断，Node 单测环境（无 window）同样安全。
export const edition = typeof globalThis.__TOOLCOVE_EDITION__ === "string" ? globalThis.__TOOLCOVE_EDITION__ : "personal";
export const isEnterprise = edition === "enterprise";

/**
 * 版本过滤判据：个人版隐藏 enterprise 独占，企业版隐藏 personal 独占，both 两边都见。
 * 判据只写这一份（同 detectNativeBridge 的教训），画廊与 Agent 目录两处消费。
 * scope 缺省按 both 处理：引擎/业务数据动作（toolKey 为 agent/data）不属于任何工具契约。
 */
export function inEdition(scope) {
  return isEnterprise ? scope !== "personal" : scope !== "enterprise";
}

/**
 * 探测原生桥。**唯一判据**是 `invoke` 是个函数——不要判某个布尔属性（曾经的 `isMobile === true`）。
 * Kotlin 的 `@get:JavascriptInterface` 成员经 WebView 注入后在 JS 里是**方法**（函数对象），
 * 布尔属性在那个形状下恒为假，会让整个 App 静默降级成网页版。
 *
 * 之所以导出成函数而不是只给下面那个常量：两处的**时机**不同——env.js 要在模块求值时同步算出来
 * （能力矩阵是同步数据，不能等 Promise），而 mobile/app/platform/bridge.js 在启动时再算一次。
 * 判据只写这一份，避免"两处各判一次、迟早漂移"。
 */
export function detectNativeBridge(scope = typeof window === "undefined" ? undefined : window) {
  return !!scope && !!scope.ToolCove && typeof scope.ToolCove.invoke === "function";
}

/** 本页是否存在原生桥：模块求值时算一次（安卓壳在页面脚本之前就注入好了）。 */
export const hasNativeBridge = detectNativeBridge();

/** 手机形态且真的有原生桥 = 安卓 App。界面与能力都以此为准，而不是只看构建期常量。 */
export const isNativeMobile = isMobile && hasNativeBridge;

/**
 * 能力开关：UI 据此隐藏或降级不可用功能。
 * 手机端的取值不是「照抄桌面」而是**如实反映这台设备上能做成什么**（见 docs/mobile-app-plan.md §1）：
 *  - 依赖原生桥的能力（filePicker / sqlite / systemProxy / secureStore / cloudSync）只在
 *    **安卓 App**（`isNativeMobile`）里为真：iPhone 网页版与手机浏览器都拿不到它们；
 *  - multiWindow：安卓没有 Tauri 多窗口，工具改为全屏页面；
 *  - jdbc：安卓没有 JDBC → false，数据库能力改走 SQLite（capabilities.sqlite）；
 *  - rawPrint：TSPL 指令生成与预览可用，但 Windows RAW 打印队列不存在 → false；
 *  - icmpDiagnostics：WebView 无 ICMP/原始套接字 → false（只保留 TCP 连通性检测）。
 */
export const capabilities = {
  multiWindow: isDesktop, // 工具独立窗口与跨窗口消息
  nativeDialog: isDesktop, // 系统文件选择/保存对话框（手机端走 SAF，见 filePicker）
  localFile: isDesktop, // 本地文件读写与批量改名（file_tool_*）
  filePicker: isDesktop || isNativeMobile, // 文件选择：桌面=系统对话框，安卓=SAF；网页版用 <input type="file">
  jdbc: isDesktop, // JDBC 数据库工具
  sqlite: isDesktop || isNativeMobile, // SQLite 本地库（安卓用 android.database.sqlite）
  git: isDesktop, // 本地仓库 git pull
  systemProxy: isDesktop || isNativeMobile, // 原生 HTTP 代理（绕过 CORS）：安卓由 Kotlin 桥提供
  secureStore: isDesktop || isNativeMobile, // 系统密钥库：桌面=DPAPI，安卓=Android Keystore；网页版为本地明文
  updater: isDesktop, // 自动更新（手机端由应用商店/手动安装，暂不做）
  autostart: isDesktop, // 开机自启
  tray: isDesktop, // 系统托盘
  backup: true, // 数据备份/恢复：桌面=zip 落盘，手机=JSON 导出 + SAF 选文件恢复（见 mobile/app/backup.js）
  telemetryUpload: isDesktop,
  cloudSync: isDesktop || isNativeMobile, // 云同步：安卓依赖 Kotlin HTTP 桥（网页版受目标站 CORS 限制）
  imageStore: true, // 图片附件：浏览器/手机端落 IndexedDB
  aiRequest: true, // AI 请求：桌面经 Rust 代理、安卓经 Kotlin 桥、网页版直连
  rawPrint: isDesktop, // 标签机 RAW 打印（Windows 打印队列）
  icmpDiagnostics: isDesktop, // ping / traceroute / DNS 等网络诊断
  screenshot: isDesktop, // 截图：整屏捕获、全局热键、置顶贴图窗（Windows 原生）
};

export function desktopOnly(command) {
  const error = new Error(`「${command}」为桌面版能力，当前平台暂不提供`);
  error.code = "DESKTOP_ONLY";
  error.command = command;
  return error;
}
