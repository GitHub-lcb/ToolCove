// 平台判定的单测：三端（桌面 / 浏览器 / 手机）各自的能力矩阵必须与**现实**一致。
//
// 为什么值得单独测：能力矩阵决定界面上哪些入口会显示、哪些会隐藏。
// 写错一个值不会报错，只会让用户点到一个必然失败的按钮（或看不到本该有的功能），
// 而这类问题在 E2E 里很难覆盖到每个组合。
import { describe, expect, it, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadEnv({ mobile = false, tauri = false, noWindow = false } = {}) {
  // 构建期常量：手机端由 mobile/vite.mobile.config.js 注入，其它目标不存在该常量
  vi.stubGlobal("__MOBILE__", mobile ? true : undefined);
  if (noWindow) vi.stubGlobal("window", undefined);
  else vi.stubGlobal("window", tauri ? { __TAURI_INTERNALS__: {} } : {});
  vi.resetModules();
  return import("./env.js");
}

describe("平台判定", () => {
  it("手机端：isMobile 为真，且不会同时被当成桌面或浏览器", async () => {
    const env = await loadEnv({ mobile: true, tauri: true });
    expect(env.isMobile).toBe(true);
    expect(env.isDesktop).toBe(false);
    expect(env.isBrowser).toBe(false);
  });

  it("桌面端（有 Tauri 内部对象）不受手机标记影响", async () => {
    const env = await loadEnv({ tauri: true });
    expect(env.isMobile).toBe(false);
    expect(env.isDesktop).toBe(true);
    expect(env.isBrowser).toBe(false);
  });

  it("浏览器端（无 Tauri）判定为 browser", async () => {
    const env = await loadEnv({});
    expect(env.isMobile).toBe(false);
    expect(env.isDesktop).toBe(false);
    expect(env.isBrowser).toBe(true);
  });

  it("Node 单测环境（无 window）按桌面处理——既有用例依赖这个约定", async () => {
    const env = await loadEnv({ noWindow: true });
    expect(env.isDesktop).toBe(true);
    expect(env.isBrowser).toBe(false);
  });
});

describe("能力矩阵", () => {
  it("手机端：安卓上做不到的三件事必须是 false（不能照抄桌面）", async () => {
    const { capabilities } = await loadEnv({ mobile: true, tauri: true });
    expect(capabilities.jdbc, "安卓没有 JDBC").toBe(false);
    expect(capabilities.rawPrint, "安卓没有 Windows RAW 打印队列").toBe(false);
    expect(capabilities.icmpDiagnostics, "WebView 无 ICMP/原始套接字").toBe(false);
    expect(capabilities.multiWindow, "安卓没有 Tauri 多窗口").toBe(false);
    expect(capabilities.tray).toBe(false);
    expect(capabilities.updater).toBe(false);
  });

  it("手机端：安卓能做的必须为 true（否则功能会被错误隐藏）", async () => {
    const { capabilities } = await loadEnv({ mobile: true, tauri: true });
    expect(capabilities.sqlite, "本地 SQLite 可用").toBe(true);
    expect(capabilities.filePicker, "文件选择走 SAF").toBe(true);
    expect(capabilities.systemProxy, "HTTP 由原生桥代理").toBe(true);
    expect(capabilities.secureStore, "密钥走 Android Keystore").toBe(true);
    expect(capabilities.cloudSync).toBe(true);
    expect(capabilities.aiRequest).toBe(true);
    expect(capabilities.imageStore).toBe(true);
  });

  it("桌面端：能力矩阵全量快照（手机端的改造不能动到桌面）", async () => {
    const { capabilities } = await loadEnv({ tauri: true });
    // ⚠️ 这里刻意用**全量快照**而不是抽查几项：手机端重做期间我改过 4 个能力的表达式
    // （systemProxy / secureStore / backup / cloudSync 从 `isDesktop` 改成 `isDesktop || isMobile`），
    // 当时抽查的用例恰好没覆盖这几个——虽然逐项验算后桌面取值确实没变，
    // 但"没被覆盖"意味着下次真改坏了也没人知道。全量快照让任何一项的变化都必须显式改这里。
    expect(capabilities).toEqual({
      multiWindow: true,
      nativeDialog: true,
      localFile: true,
      filePicker: true,
      jdbc: true,
      sqlite: true,
      git: true,
      systemProxy: true,
      secureStore: true,
      updater: true,
      autostart: true,
      tray: true,
      backup: true,
      telemetryUpload: true,
      cloudSync: true,
      imageStore: true,
      aiRequest: true,
      rawPrint: true,
      icmpDiagnostics: true,
    });
  });

  it("桌面端：能力项的键集合固定（新增能力必须显式加进来）", async () => {
    // 键集合本身也是契约：前端用 capabilities.xxx 判断功能可见性，
    // 少一个键会让某个功能在桌面上莫名消失
    const { capabilities } = await loadEnv({ tauri: true });
    expect(Object.keys(capabilities).sort()).toEqual(
      [
        "aiRequest", "autostart", "backup", "cloudSync", "filePicker", "git", "icmpDiagnostics",
        "imageStore", "jdbc", "localFile", "multiWindow", "nativeDialog", "rawPrint", "secureStore",
        "sqlite", "systemProxy", "telemetryUpload", "tray", "updater",
      ].sort()
    );
  });

  it("浏览器端：桌面独占能力全关，纯 Web 能力保留", async () => {
    const { capabilities } = await loadEnv({});
    expect(capabilities.jdbc).toBe(false);
    expect(capabilities.localFile).toBe(false);
    expect(capabilities.rawPrint).toBe(false);
    expect(capabilities.imageStore).toBe(true);
    expect(capabilities.aiRequest).toBe(true);
  });

  it("desktopOnly 错误按平台中性表述（手机端不该提示「浏览器版暂不提供」）", async () => {
    const { desktopOnly } = await loadEnv({ mobile: true, tauri: true });
    const error = desktopOnly("db_drivers");
    expect(error.code).toBe("DESKTOP_ONLY");
    expect(error.command).toBe("db_drivers");
    expect(error.message).not.toContain("浏览器版");
  });
});
