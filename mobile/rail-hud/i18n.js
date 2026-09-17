// 手机版 HUD 的极简 i18n：只需要「按点分键取字符串 + 替换 {name} 占位符」。
//
// 不用 vue-i18n：手机端没有 Vue（整个 HUD 是原生 DOM + 直引 railTycoon.js），
// 为了 30 条文案引进一整个 i18n 运行时并不划算。这里缺的是复数/日期等能力，
// 而铁路大亨的文案里一个都不需要。
//
// 词条来源见 gen-i18n.mjs（从主程序字典抽取），本文件只负责查表与插值。

import { MESSAGES } from "./i18n.gen.js";

export const LOCALES = Object.keys(MESSAGES);
export const DEFAULT_LOCALE = "zh-CN";
const FALLBACK_LOCALE = "en-US";

let locale = DEFAULT_LOCALE;

/** 按「显式偏好优先，其次系统语言前缀」决议语言——与主程序 resolveInitialLocale 同一口径。 */
export function resolveLocale(preference, systemLocale) {
  if (LOCALES.includes(preference)) return preference;
  return String(systemLocale || "").toLowerCase().startsWith("zh") ? DEFAULT_LOCALE : FALLBACK_LOCALE;
}

export function setLocale(next) {
  if (LOCALES.includes(next)) locale = next;
  return locale;
}

export function getLocale() {
  return locale;
}

function lookup(dict, path) {
  return path.split(".").reduce((node, key) => (node == null ? undefined : node[key]), dict);
}

/**
 * 取一条文案并插值。
 *
 * 找不到键时**返回键名本身**而不是空串：手机端没有 SSR 单测兜底，
 * 空串会渲染成「什么都不显示」，而键名会明晃晃地出现在界面上——后者一眼可见。
 */
export function t(key, params) {
  const path = key.startsWith("toolbox.rail.") ? key.slice("toolbox.rail.".length) : key;
  const raw = lookup(MESSAGES[locale], path) ?? lookup(MESSAGES[FALLBACK_LOCALE], path);
  if (typeof raw !== "string") return key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/** 初始语言：URL 上的 ?lang= 优先（Android 侧按系统语言注入），其次 navigator.language。 */
export function initLocale(search = "") {
  const fromQuery = new URLSearchParams(search).get("lang");
  const nav = typeof navigator !== "undefined" ? navigator.language : "";
  setLocale(resolveLocale(fromQuery, nav));
  return locale;
}
