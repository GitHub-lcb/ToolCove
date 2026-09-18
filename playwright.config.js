// Playwright 配置：只跑 web 构建产物（纯静态站点，不需要 Tauri）。
//
// 为什么从 web 端起步：桌面端要 tauri-driver + WebView2 驱动，CI 上装起来重、慢；
// 而三条最痛的回归（写前预览 / 提问卡 / 技能库）都是视图层行为，静态站点即可覆盖。
//
// 复跑：npm run test:e2e
import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT || 4321);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e/specs",
  // 用例之间不共享状态（每个 test 独立 context，IndexedDB 从零开始），所以可以并行
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 30_000,
  expect: { timeout: 7_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
  },
  // 用系统 Chrome 而不是下载 Playwright 自带 chromium：
  //  - 本机与 CI 都不必再拉一份 ~150MB 的浏览器；windows/macos 的 GH runner 自带 Chrome。
  //  - 需要时可用 E2E_CHANNEL=chromium 切回自带内核（例如要固定内核版本复现渲染问题）。
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], channel: process.env.E2E_CHANNEL || "chrome" } }],
  webServer: {
    // 先构建静态站点再起静态服务器：E2E 永远跑在真实产物上，避免「源码对、产物旧」
    command: `npm run build:web && node e2e/server.mjs dist`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    stdout: "pipe",
  },
});
