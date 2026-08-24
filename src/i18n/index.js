// i18n 基建：vue-i18n 实例 + 字典键工具 + 语言决议。
// 默认 zh-CN、回退 en-US；语言偏好（system | zh-CN | en-US）存 settings.json 的 ui.locale。
import { createI18n } from "vue-i18n";
import { invoke } from "@tauri-apps/api/core";
import zh from "./zh-CN.json";
import en from "./en-US.json";

export const i18n = createI18n({
  legacy: false,
  locale: "zh-CN",
  fallbackLocale: "en-US",
  messages: { "zh-CN": zh, "en-US": en },
});

// 平铺嵌套字典为点分键列表（测试用于校验中英键对齐）
export function flatKeys(dict, prefix = "") {
  return Object.entries(dict).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}.${k}` : k;
    return v && typeof v === "object" ? flatKeys(v, key) : [key];
  });
}

// 初始语言决议：显式指定优先；"system" 按系统语言前缀匹配，无匹配回退 en-US
export function resolveInitialLocale(preference, systemLocale) {
  if (preference === "zh-CN" || preference === "en-US") return preference;
  return String(systemLocale || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

const LOCALE_PREFS = ["system", "zh-CN", "en-US"];

// 偏好归一：非法值一律按「跟随系统」处理
export function normalizeLocalePref(pref) {
  return LOCALE_PREFS.includes(pref) ? pref : "system";
}

// 按偏好即时切换界面语言（供启动初始化与设置页切换共用）
export function applyLocale(pref) {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en-US";
  i18n.global.locale.value = resolveInitialLocale(normalizeLocalePref(pref), nav);
}

// 挂载前读 settings.json 的语言偏好落初始 locale；读取失败退回跟随系统，不阻断启动
export async function initLocale() {
  let pref = "system";
  try {
    if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
      const s = (await invoke("load_data", { key: "settings" })) || {};
      pref = s.ui?.locale || "system";
    }
  } catch (e) {}
  applyLocale(pref);
}
