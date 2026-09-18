// 手机端（安卓 App）的构建配置。
//
// 与桌面/网页端的区别只有两点，都不改 `src/`：
//  1) `base: "./"`：产物要放进 APK 的 assets 并由本地服务托管，绝对路径会 404；
//  2) 入口是 `mobile/app/index.html`，输出到 `mobile/app/dist`（供安卓打包脚本取用）。
//
// 为什么不打单文件：旧 HUD 必须单文件，是因为 `file:///android_asset/` 是 opaque origin——
// ESM 跨文件 import 被 CORS 拒、crypto.subtle 可能不可用。新 App 改用「Kotlin 起本地 HTTP 服务 +
// WebView 加载 http://127.0.0.1:<port>/」，于是拿到安全上下文，可以正常懒加载 chunk 与 WASM。
// 详见 docs/mobile-app-plan.md §3.1（单文件方案保留为回退）。
import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const BUILD_STAMP = new Date().toISOString().replace(/\.\d+Z$/, "Z");

export default defineConfig({
  root: resolve(here, "app"),
  base: "./",
  plugins: [vue()],
  resolve: {
    // 共享代码用 `@/...` 引用仓库根：手机端目录层级较深，写相对路径容易算错（已经踩过一次）
    alias: { "@": resolve(here, "..") },
  },
  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
    // 让共享代码知道自己在手机端：与 platform/env.js 的判定配合（见 mobile/app/platform/env.js）
    __MOBILE__: JSON.stringify(true),
  },
  build: {
    // 产物落在 dist/mobile/app/：E2E 的静态服务器只服务 dist/（与网页端同一台服务器），
    // 于是移动视口用例可以走 /mobile/app/index.html 访问真实产物。
    // 安卓打包脚本取 dist/mobile/app/ 放进 APK assets，由本地服务托管。
    outDir: resolve(here, "..", "dist", "mobile", "app"),
    emptyOutDir: true,
    // 手机端首屏要求更严：主包压到 500KB 以下（桌面端是 552KB，这里更保守）
    chunkSizeWarningLimit: 500,
    target: "es2020",
  },
  server: {
    port: 1430,
    strictPort: true,
  },
});
