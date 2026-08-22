// i18n 基建：vue-i18n 实例 + 字典键工具 + 初始语言决议
// 默认 zh-CN、回退 en-US；语言偏好（system | zh-CN | en-US）由设置页写入 settings.json（M3）
import { createI18n } from "vue-i18n";
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

// 挂载前按系统语言落初始 locale（M3 接入设置偏好后改为读 settings.json）
export function initLocale() {
  const nav = typeof navigator !== "undefined" ? navigator.language : "en-US";
  i18n.global.locale.value = resolveInitialLocale("system", nav);
  return Promise.resolve();
}
