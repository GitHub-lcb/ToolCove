// 平台判定与能力清单：桌面（Tauri）与浏览器（静态站点）的唯一真相源。
// 约定：Node 单测环境无 window，按桌面处理，既有用例继续走 IPC 分支。
export const isDesktop = typeof window === "undefined" || !!window.__TAURI_INTERNALS__;
export const isBrowser = !isDesktop;

/** 能力开关：UI 据此隐藏或降级桌面独占功能。 */
export const capabilities = {
  multiWindow: isDesktop, // 工具独立窗口与跨窗口消息
  nativeDialog: isDesktop, // 系统文件选择/保存对话框
  localFile: isDesktop, // 本地文件读写与批量改名（file_tool_*）
  jdbc: isDesktop, // JDBC 数据库工具
  git: isDesktop, // 本地仓库 git pull
  systemProxy: isDesktop, // 原生 HTTP 代理（绕过 CORS）
  secureStore: isDesktop, // DPAPI 加密存储（浏览器端密钥为明文，见 invoke.js）
  updater: isDesktop, // 自动更新
  autostart: isDesktop, // 开机自启
  tray: isDesktop, // 系统托盘
  backup: isDesktop, // 数据备份/恢复（zip 落盘）
  telemetryUpload: isDesktop,
  cloudSync: isDesktop, // 云同步依赖原生代理；浏览器端待服务端开放 CORS
  imageStore: true, // 图片附件：浏览器端落 IndexedDB
  aiRequest: true, // AI 请求：桌面经 Rust 代理，浏览器直连（端点需允许 CORS）
};

export function desktopOnly(command) {
  const error = new Error(`「${command}」为桌面版能力，浏览器版暂不提供`);
  error.code = "DESKTOP_ONLY";
  error.command = command;
  return error;
}
