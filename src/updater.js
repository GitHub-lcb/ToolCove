import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { askConfirm } from "./confirm.js";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

// 防止启动自动检查与手动检查同时跑
let checking = false;

/**
 * 检查并安装更新（Tauri updater 插件，走 tauri.conf.json 里配置的 GitHub Releases 端点）。
 * silent=true：启动静默检查，无新版本/检查失败都不打扰用户；
 * silent=false：设置页手动检查，无论结果都给出提示。
 */
export async function checkForUpdate({ silent = true, showToast = () => {} } = {}) {
  if (!window.__TAURI_INTERNALS__ || checking) return;
  checking = true;
  try {
    const update = await check({ timeout: 10000 });
    if (!update) {
      if (!silent) showToast(t("common.updateLatest"));
      return;
    }
    const notes = (update.body || "").trim();
    const ok = await askConfirm({
      title: t("common.updateFound", { version: update.version }),
      message: (notes ? notes + "\n\n" : "") + t("common.updateMessage"),
      okText: t("common.updateNow"),
      cancelText: t("common.updateLater"),
      danger: false,
    });
    if (!ok) return;
    showToast(t("common.updateDownloading"));
    await update.downloadAndInstall();
    // Windows 下安装器会自动结束当前进程；兜底调用 relaunch 保证重启
    await relaunch();
  } catch (e) {
    if (!silent) showToast(t("common.updateFailed", { err: e?.message || e }));
  } finally {
    checking = false;
  }
}
