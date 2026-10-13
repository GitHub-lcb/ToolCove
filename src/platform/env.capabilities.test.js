// 平台判定的单测：四种形态（桌面 / 浏览器 / 安卓 App / 手机网页版）各自的能力矩阵必须与**现实**一致。
//
// 为什么值得单独测：能力矩阵决定界面上哪些入口会显示、哪些会隐藏。
// 写错一个值不会报错，只会让用户点到一个必然失败的按钮（或看不到本该有的功能），
// 而这类问题在 E2E 里很难覆盖到每个组合。
//
// ⚠️ 1.3.2 回归点：**"手机形态"不等于"有原生能力"**。
// iPhone 用的是 GitHub Pages 上的同一份手机产物（没有原生桥），过去因为只看构建期常量
// `__MOBILE__`，它的能力矩阵与安卓真机**一模一样**——本地数据库、SAF 选择器、云同步
// 全部报"可用"，点下去必然失败。下面的"手机网页版"用例就是钉死这一条的。
import { describe, expect, it, vi, afterEach } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

/**
 * 装载 env.js。
 *  - mobile：构建期常量 `__MOBILE__`（手机产物）
 *  - bridge：安卓壳注入的 `window.ToolCove`，**真机形状只有 invoke 一个方法**（没有布尔属性）
 */
async function loadEnv({ mobile = false, tauri = false, noWindow = false, bridge = false } = {}) {
  vi.stubGlobal("__MOBILE__", mobile ? true : undefined);
  if (noWindow) vi.stubGlobal("window", undefined);
  else if (tauri) vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  else if (bridge) vi.stubGlobal("window", { ToolCove: { invoke: () => "{}" } });
  else vi.stubGlobal("window", {});
  vi.resetModules();
  return import("./env.js");
}

/** 必须依赖原生桥的能力项：没有桥就必须为 false。 */
const NATIVE_ONLY = ["sqlite", "filePicker", "systemProxy", "secureStore", "cloudSync"];

describe("平台判定", () => {
  it("安卓 App（手机产物 + 原生桥）：isMobile 与 isNativeMobile 都为真", async () => {
    const env = await loadEnv({ mobile: true, bridge: true });
    expect(env.isMobile).toBe(true);
    expect(env.hasNativeBridge).toBe(true);
    expect(env.isNativeMobile).toBe(true);
    expect(env.isDesktop).toBe(false);
    expect(env.isBrowser).toBe(false);
  });

  it("手机网页版（手机产物、没有桥，如 iPhone 的 PWA）：仍是手机形态，但不是原生 App", async () => {
    const env = await loadEnv({ mobile: true });
    expect(env.isMobile).toBe(true, "界面仍按手机重排");
    expect(env.hasNativeBridge).toBe(false);
    expect(env.isNativeMobile).toBe(false);
    expect(env.isDesktop).toBe(false);
    expect(env.isBrowser).toBe(false);
  });

  it("桥的判据只看 invoke 是不是函数——布尔属性不算（真机形状）", async () => {
    vi.stubGlobal("__MOBILE__", true);
    // 这是**真机上不存在**的形状：Kotlin 的属性经 WebView 注入后是方法，不是布尔
    vi.stubGlobal("window", { ToolCove: { isMobile: true } });
    vi.resetModules();
    const env = await import("./env.js");
    expect(env.hasNativeBridge).toBe(false);
    expect(env.isNativeMobile).toBe(false);
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
    expect(env.hasNativeBridge).toBe(false);
  });
});

describe("能力矩阵", () => {
  it("安卓 App：安卓上做不到的三件事必须是 false（不能照抄桌面）", async () => {
    const { capabilities } = await loadEnv({ mobile: true, bridge: true });
    expect(capabilities.jdbc, "安卓没有 JDBC").toBe(false);
    expect(capabilities.rawPrint, "安卓没有 Windows RAW 打印队列").toBe(false);
    expect(capabilities.icmpDiagnostics, "WebView 无 ICMP/原始套接字").toBe(false);
    expect(capabilities.multiWindow, "安卓没有 Tauri 多窗口").toBe(false);
    expect(capabilities.tray).toBe(false);
    expect(capabilities.updater).toBe(false);
  });

  it("安卓 App：安卓能做的必须为 true（否则功能会被错误隐藏）", async () => {
    const { capabilities } = await loadEnv({ mobile: true, bridge: true });
    for (const key of NATIVE_ONLY) {
      expect(capabilities[key], `${key} 依赖原生桥，安卓 App 里必须有`).toBe(true);
    }
    expect(capabilities.aiRequest).toBe(true);
    expect(capabilities.imageStore).toBe(true);
    expect(capabilities.backup).toBe(true);
  });

  it("手机网页版（iPhone PWA / 手机浏览器）：依赖原生桥的能力必须**如实关掉**", async () => {
    const { capabilities } = await loadEnv({ mobile: true });
    for (const key of NATIVE_ONLY) {
      expect(capabilities[key], `${key} 在网页版拿不到，界面不该露出入口`).toBe(false);
    }
    // 纯 Web 能力不受影响：这些在网页版照常工作
    expect(capabilities.aiRequest, "AI 直连 fetch 可用（受目标站 CORS 限制）").toBe(true);
    expect(capabilities.imageStore, "图片落 IndexedDB").toBe(true);
    expect(capabilities.backup, "JSON 导出 + 文件选择恢复").toBe(true);
    // 桌面独占的仍然是 false
    expect(capabilities.updater).toBe(false);
    expect(capabilities.jdbc).toBe(false);
  });

  it("两种手机形态的差异**恰好**是依赖原生桥的那几项（多一项少一项都要显式改这里）", async () => {
    const app = await loadEnv({ mobile: true, bridge: true });
    const web = await loadEnv({ mobile: true });
    const differing = Object.keys(app.capabilities).filter((key) => app.capabilities[key] !== web.capabilities[key]);
    expect(differing.sort()).toEqual([...NATIVE_ONLY].sort());
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
      screenshot: true,
    });
  });

  it("桌面端：能力项的键集合固定（新增能力必须显式加进来）", async () => {
    // 键集合本身也是契约：前端用 capabilities.xxx 判断功能可见性，
    // 少一个键会让某个功能在桌面上莫名消失
    const { capabilities } = await loadEnv({ tauri: true });
    expect(Object.keys(capabilities).sort()).toEqual(
      [
        "aiRequest", "autostart", "backup", "cloudSync", "filePicker", "git", "icmpDiagnostics",
        "imageStore", "jdbc", "localFile", "multiWindow", "nativeDialog", "rawPrint", "screenshot",
        "secureStore", "sqlite", "systemProxy", "telemetryUpload", "tray", "updater",
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
    const { desktopOnly } = await loadEnv({ mobile: true, bridge: true });
    const error = desktopOnly("db_drivers");
    expect(error.code).toBe("DESKTOP_ONLY");
    expect(error.command).toBe("db_drivers");
    expect(error.message).not.toContain("浏览器版");
  });
});
