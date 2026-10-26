// 手机端 App 入口。
//
// Phase 1 的定位：先把**地基**跑通并与桌面端共用同一套逻辑层——
//   · 平台判定（env.js 的 isMobile）与原生桥（bridge.js）
//   · i18n 字典（与桌面端同一份 JSON，因此词条永远不会两边漂移）
//   · 存储（platform/invoke 的浏览器实现：IndexedDB），于是 repository/sync 可直接复用
// 界面在这个阶段只是一屏接地气的「能力清单」，用来确认平台判定与桥接是否正确；
// 真正的页面（记录 / 工作台 / 工具 / Agent）在后续 Phase 逐个替换。
import { createApp, h } from "vue";
// 共享逻辑一律用相对路径：单测（根 vite 配置）与手机端构建都能解析
import { i18n, initLocale, warmFallbackLocale } from "../../src/i18n/index.js";
import { vDialog } from "../../src/ui/dialog.js";
import { vFieldError } from "../../src/ui/fieldError.js";
import { capabilities, isMobile, isDesktop, isBrowser } from "../../src/platform/env.js";
import { installNativeBridge } from "./platform/bridge.js";
import Shell from "./Shell.vue";
// 设计令牌先于手机端样式：shell.css 里的 --m-* 全是 tokens.css 的角色别名，
// 反过来引会让第一轮样式计算拿不到令牌值（未定义的 var 会让整条声明失效，而不是取空值）。
import "../../src/styles/tokens.css";
import "./styles/shell.css";

// 原生桥必须先接上：后面的存储/网络调用都经 platform/invoke 分发
installNativeBridge();

createApp({
  render: () => h(Shell, { capabilities, isMobile, isDesktop, isBrowser }),
})
  .use(i18n)
  // 与桌面同一个对话框语义实现：手机端也挂 v-dialog，不另写一份 role/焦点逻辑
  .directive("dialog", vDialog)
  .directive("field-error", vFieldError)
  .mount("#mobile-app");

// 语言与数据初始化不阻塞挂载（与桌面 main.js 相同的顺序：先落语言，再做重活）
initLocale()
  .then(() => warmFallbackLocale({ delayMs: 800 }))
  .catch(() => {});
