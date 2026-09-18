// 语言包装配：首屏只打包**当前语言**，另一种在启动后台懒加载。
//
// 为什么值得这么做：两份字典合计 231 KB（压成一行后），占入口 chunk 的 41.9%，而任何人只需要其中一份。
// 实测首屏脚本合计 989 KB，其中语言包约 231 KB —— 这是首屏最大的一块静态成本。
//
// 时序（关键）：locale 的决议必须**同步**完成才能在首屏用上字典，所以：
//   1. 先按「显式偏好 → 系统语言 → zh-CN」定下语言，同步取该语言的静态包；
//   2. 另一份语言包在启动后台加载（applyLocale 也会触发），
//      于是启动时读到的偏好即使与第 1 步猜的不同，也只是晚几十毫秒生效，而不是先渲染一堆词条 key。
// 这样既省了一半字典，又不需要「先渲染 key 再补齐」那种闪烁方案。
import { createI18n } from "vue-i18n";
import zh from "./zh-CN.json";

export const LOCALES = ["zh-CN", "en-US"];
export const DEFAULT_LOCALE = "zh-CN";

// 静态包只有 zh-CN 是编译期常量；en-US 走动态 import（Vite 会切成独立 chunk，不进首屏）
const staticPacks = { "zh-CN": zh };

/** 动态加载某个语言包；已加载过则直接返回。失败返回 null（调用方决定降级策略）。 */
export async function loadLocaleMessages(locale) {
  if (staticPacks[locale]) return staticPacks[locale];
  try {
    const mod = locale === "en-US" ? await import("./en-US.json") : null;
    if (!mod) return null;
    staticPacks[locale] = mod.default || mod;
    return staticPacks[locale];
  } catch {
    return null;
  }
}

export const i18n = createI18n({
  legacy: false,
  locale: DEFAULT_LOCALE,
  // 回退语言刻意留空：字典是按需加载的，vue-i18n 会在需要时重新求值（见下方说明）
  fallbackLocale: DEFAULT_LOCALE,
  messages: { "zh-CN": zh },
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

/** 系统语言（Node 单测环境没有 navigator，退回 en-US） */
function systemLocale() {
  if (typeof navigator !== "undefined" && navigator.language) return navigator.language;
  if (typeof Intl !== "undefined" && Intl.DateTimeFormat) return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  return "en-US";
}

/**
 * 设定界面语言。字典没加载时同步返回 false，并在后台加载完成后重试一次
 * ——调用方（启动流程）据此决定要不要 await。
 */
export function applyLocale(pref) {
  const target = resolveInitialLocale(normalizeLocalePref(pref), systemLocale());
  if (i18n.global.availableLocales.includes(target)) {
    i18n.global.locale.value = target;
    return Promise.resolve(true);
  }
  return loadLocaleMessages(target).then((messages) => {
    if (!messages) return false;
    i18n.global.setLocaleMessage(target, messages);
    i18n.global.locale.value = target;
    return true;
  });
}

/**
 * 挂载前定下初始语言并备好字典。
 * 先从「同步能拿到的线索」猜一次（内存里的偏好 → 系统语言），让首屏就用上字典；
 * 真正的偏好存在 settings.json，读盘后若与猜测不同再切（此时另一份字典按需加载）。
 *
 * 注意：**预热不在这里做**。它在 mount 之前排期，会被算进首屏字节（实测把刚省下的 116KB 又付了回去），
 * 所以预热交给 main.js 在挂载后再排（见 warmFallbackLocale）。
 */
export async function initLocale() {
  applyLocale(cachedPref() || "system");
  let pref = "system";
  try {
    // 走平台层读设置：桌面端落 Rust 文件存储、浏览器端落 IndexedDB，两条路都要读。
    // 早先这里用 window.__TAURI_INTERNALS__ 把关，于是浏览器端**从来不读语言偏好**
    // ——E2E 的「英文偏好」用例抓到的真实缺陷。
    const { invoke } = await import("../platform/invoke.js");
    const s = (await invoke("load_data", { key: "settings" })) || {};
    pref = s.ui?.locale || "system";
  } catch {
    // 读不到设置就跟随系统：语言不是启动的硬依赖
  }
  rememberPref(pref);
  await applyLocale(pref);
}

/**
 * 预热另一种语言包：用户切语言时才不用等。
 *
 * 时机是刻意的：**挂载之后 + 至少 1.5 秒**。踩过两次：
 *   1) 在 mount 之前排期 → 直接被算进首屏字节；
 *   2) 用 requestIdleCallback 从 0 开始等空闲 → 应用启动那一刻就可能空闲，仍在首屏范围内。
 * 1.5 秒后首屏早已绘制完成，这份包不会再计进首屏成本；而用户真要切语言通常也要几秒之后。
 * 慢网络（2g）下直接跳过——首屏字节比「切语言快一点」重要。
 */
export function warmFallbackLocale({ delayMs = 1500 } = {}) {
  const slowNetwork = typeof navigator !== "undefined" && /(^|-)2g$/.test(String(navigator.connection?.effectiveType || ""));
  if (slowNetwork) return;
  const warm = () => {
    const active = String(i18n.global.locale.value || DEFAULT_LOCALE);
    void loadLocaleMessages(active === "zh-CN" ? "en-US" : "zh-CN");
  };
  setTimeout(warm, delayMs);
}

const PREF_CACHE_KEY = "tc.localePref";

/** 上次用过的偏好（只做首屏猜测用，权威值仍在 settings.json）。读不到就返回空。 */
function cachedPref() {
  try {
    const value = typeof localStorage !== "undefined" ? localStorage.getItem(PREF_CACHE_KEY) : null;
    return LOCALE_PREFS.includes(value) ? value : "";
  } catch {
    return "";
  }
}

function rememberPref(pref) {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(PREF_CACHE_KEY, normalizeLocalePref(pref));
  } catch {
    // 隐私模式写不进去：下次启动重新猜即可，无副作用
  }
}
