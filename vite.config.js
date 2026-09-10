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
    include: ["src/**/*.{test,spec}.js"],
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
