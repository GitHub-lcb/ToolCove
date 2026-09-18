import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;

// 构建指纹：注入到前端，用于回答「我现在打开的到底是哪一次构建」。
// 起因是一次真实排查——改了确认卡却没在界面上看到，无法判断是代码没生效还是实例是旧的。
const BUILD_STAMP = new Date().toISOString().replace(/\.\d+Z$/, "Z");

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [vue()],

  define: {
    __BUILD_STAMP__: JSON.stringify(BUILD_STAMP),
  },

  // 静态站点（npm run build:web --mode web）：相对 base 让 dist/ 可部署到任意子路径
  // （GitHub Pages 项目页 / 自建目录）；桌面构建保持根路径不变。
  base: mode === "web" ? "./" : "/",

  // 单元测试（Vitest）：仅测纯函数逻辑，node 环境即可，无需 jsdom
  test: {
    environment: "node",
    // mobile/ 下是铁路大亨手机版 HUD（悬浮窗 + 网页版共用），纯 JS 逻辑同样进单测
    include: ["src/**/*.{test,spec}.js", "mobile/**/*.{test,spec}.js"],
    // 默认 5s / 10s 在 CI 共享机器上会把「整包字典编译」（i18n）与「重组件装载」
    // （render 测试的 beforeAll）直接判超时——那是环境慢，不是断言失败，却会卡死发版。
    // 统一放宽到 20s：慢机器只会变慢，不会变红。断言标准不变。
    testTimeout: 20000,
    hookTimeout: 20000,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
