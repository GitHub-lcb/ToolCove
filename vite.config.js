import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async ({ mode }) => ({
  plugins: [vue()],

  // 静态站点（npm run build:web --mode web）：相对 base 让 dist/ 可部署到任意子路径
  // （GitHub Pages 项目页 / 自建目录）；桌面构建保持根路径不变。
  base: mode === "web" ? "./" : "/",

  // 单元测试（Vitest）：仅测纯函数逻辑，node 环境即可，无需 jsdom
  test: {
    environment: "node",
    // 手机端（mobile/app）的纯逻辑同样进单测：UI 会频繁重排，规则必须留在可测的纯函数里
    include: ["src/**/*.{test,spec}.js", "mobile/app/**/*.{test,spec}.js"],
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
  // 2. 端口分工（三条路径互不打架）：
  //    - `npm run dev`（浏览器）→ 1420，被占用时**自动往后滑**（1421、1422…），
  //      滑档是 Vite 默认行为，前提是不开 strictPort；
  //    - `npm run tauri dev` → 走 `dev:tauri`，钉死 1421 且 --strictPort。
  //      钉死是因为 tauri.conf.json 的 build.devUrl 是静态地址，端口一滑桌面窗口就会
  //      去加载一个没人听的地址（表现为白屏，且线索完全不显眼）；选 1421 而不是 1420，
  //      是为了让「浏览器 dev 已经占着 1420」时桌面 dev 照样能起；
  //    - 真机调试（TAURI_DEV_HOST）→ HMR websocket 单独用 1422，必须与上面的服务端口不同，
  //      否则手机连的是同一个 socket，热更新静默失效。
  server: {
    port: 1420,
    strictPort: false,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1422,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
