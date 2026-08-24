import { describe, it, expect, vi, beforeEach } from "vitest";

// updater.js 依赖 Tauri 插件与确认弹窗，全部 mock 掉，只测流程编排逻辑
vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));
vi.mock("./confirm.js", () => ({ askConfirm: vi.fn() }));

import { checkForUpdate } from "./updater.js";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { askConfirm } from "./confirm.js";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.window = { __TAURI_INTERNALS__: {} };
});

function mockUpdate(overrides = {}) {
  return {
    version: "0.2.0",
    body: "修复若干问题",
    downloadAndInstall: vi.fn().mockResolvedValue(),
    ...overrides,
  };
}

describe("checkForUpdate", () => {
  it("非 Tauri 环境直接返回，不发起检查", async () => {
    globalThis.window = {};
    await checkForUpdate({ silent: false });
    expect(check).not.toHaveBeenCalled();
  });

  it("无新版本：静默检查不打扰用户", async () => {
    check.mockResolvedValue(null);
    const showToast = vi.fn();
    await checkForUpdate({ silent: true, showToast });
    expect(showToast).not.toHaveBeenCalled();
  });

  it("无新版本：手动检查提示已是最新", async () => {
    check.mockResolvedValue(null);
    const showToast = vi.fn();
    await checkForUpdate({ silent: false, showToast });
    expect(showToast).toHaveBeenCalledWith(t("common.updateLatest"));
  });

  it("有新版本但用户取消：不下载安装、不重启", async () => {
    check.mockResolvedValue(mockUpdate());
    askConfirm.mockResolvedValue(false);
    const update = await check();
    await checkForUpdate({ silent: true });
    expect(askConfirm).toHaveBeenCalledTimes(1);
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("确认弹窗携带版本号与更新说明", async () => {
    check.mockResolvedValue(mockUpdate({ version: "1.2.3", body: "新功能上线" }));
    askConfirm.mockResolvedValue(false);
    await checkForUpdate({ silent: true });
    const opts = askConfirm.mock.calls[0][0];
    expect(opts.title).toBe(t("common.updateFound", { version: "1.2.3" }));
    expect(opts.message).toContain("新功能上线");
    expect(opts.okText).toBe(t("common.updateNow"));
    expect(opts.danger).toBe(false);
  });

  it("更新说明为空时弹窗文案不带多余空行", async () => {
    check.mockResolvedValue(mockUpdate({ body: "  " }));
    askConfirm.mockResolvedValue(false);
    await checkForUpdate({ silent: true });
    const opts = askConfirm.mock.calls[0][0];
    expect(opts.message.startsWith(t("common.updateMessage"))).toBe(true);
  });

  it("用户确认：下载安装后重启", async () => {
    const update = mockUpdate();
    check.mockResolvedValue(update);
    askConfirm.mockResolvedValue(true);
    const showToast = vi.fn();
    await checkForUpdate({ silent: true, showToast });
    expect(showToast).toHaveBeenCalledWith(t("common.updateDownloading"));
    expect(update.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
  });

  it("检查失败：静默模式不打扰，手动模式提示错误", async () => {
    check.mockRejectedValue(new Error("网络超时"));
    const silentToast = vi.fn();
    await checkForUpdate({ silent: true, showToast: silentToast });
    expect(silentToast).not.toHaveBeenCalled();

    const manualToast = vi.fn();
    await checkForUpdate({ silent: false, showToast: manualToast });
    expect(manualToast).toHaveBeenCalledWith(t("common.updateFailed", { err: "网络超时" }));
  });

  it("并发检查去重：检查进行中再次调用直接返回", async () => {
    let resolveCheck;
    check.mockImplementation(() => new Promise((r) => (resolveCheck = r)));
    const first = checkForUpdate({ silent: true });
    await checkForUpdate({ silent: false });
    resolveCheck(null);
    await first;
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("失败后检查锁复位，允许再次检查", async () => {
    check.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(null);
    await checkForUpdate({ silent: true });
    await checkForUpdate({ silent: true });
    expect(check).toHaveBeenCalledTimes(2);
  });
});
