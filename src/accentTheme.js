// 自定义主题色（Pro 功能 theme-custom）：以预设色系覆盖主题强调变量。
// 深浅两套主题共用同一强调色系：内联 style 的优先级高于样式表内的两套
// @media (prefers-color-scheme) 定义，因此按当前主题选对应补丁即可同时生效。
// 变量清单与 App.vue 样式保持一致（primary 系为组件实际使用的主色 token）。

export const ACCENT_VARS = [
  "--primary", "--primary-hover", "--primary-light", "--primary-bright",
  "--primary-soft", "--primary-soft-hover",
  "--grad-brand", "--grad-selected", "--grad-promo",
  "--accent", "--accent-hover", "--accent-deep", "--accent-light",
  "--accent-soft", "--accent-border", "--accent-soft-text", "--accent-tint",
  "--accent-soft-deep", "--accent-soft-deep-hover", "--accent-border-deep",
  "--border-blue",
];

export const ACCENT_STORAGE_KEY = "tc.accent";

export const ACCENT_PRESETS = [
  {
    key: "teal",
    labelKey: "pro.accentTeal",
    light: {
      "--primary": "#0d8a7f", "--primary-hover": "#0a6e65", "--primary-light": "#2fb3a4",
      "--primary-bright": "#5cd4c3", "--primary-soft": "#e2f5f1", "--primary-soft-hover": "#cdece6",
      "--grad-brand": "linear-gradient(135deg, #0d8a7f, #2fb3a4 55%, #79d4c8)",
      "--grad-selected": "linear-gradient(135deg, #eef9f7, #d9f1ec)",
      "--grad-promo": "linear-gradient(150deg, #f2fbf9, #dff3ef)",
      "--accent": "#0d8a7f", "--accent-hover": "#0a6e65", "--accent-deep": "#0a6e65",
      "--accent-light": "#2fb3a4", "--accent-soft": "#e2f5f1", "--accent-border": "#b5e5dc",
      "--accent-soft-text": "#0d8a7f", "--accent-tint": "#eef9f7",
      "--accent-soft-deep": "#e2f5f1", "--accent-soft-deep-hover": "#cdece6",
      "--accent-border-deep": "#b5e5dc", "--border-blue": "#b5e5dc",
    },
    dark: {
      "--primary": "#2cb0a4", "--primary-hover": "#45c6ba", "--primary-light": "#45c6ba",
      "--primary-bright": "#7fe0d3", "--primary-soft": "#123a36", "--primary-soft-hover": "#0f2e2b",
      "--grad-brand": "linear-gradient(135deg, #0f6e63, #2cb0a4 55%, #7fe0d3)",
      "--grad-selected": "linear-gradient(135deg, #123a36, #0f2e2b)",
      "--grad-promo": "linear-gradient(150deg, #122724, #0e1f1d)",
      "--accent": "#2cb0a4", "--accent-hover": "#45c6ba", "--accent-deep": "#45c6ba",
      "--accent-light": "#7fe0d3", "--accent-soft": "#123a36", "--accent-border": "#1e4a45",
      "--accent-soft-text": "#7fe0d3", "--accent-tint": "#0d211f",
      "--accent-soft-deep": "#123a36", "--accent-soft-deep-hover": "#0f2e2b",
      "--accent-border-deep": "#1e4a45", "--border-blue": "#1e4a45",
    },
  },
  {
    key: "violet",
    labelKey: "pro.accentViolet",
    light: {
      "--primary": "#8250df", "--primary-hover": "#6d3fd0", "--primary-light": "#a17ef5",
      "--primary-bright": "#c9b6f9", "--primary-soft": "#f1eafd", "--primary-soft-hover": "#e6dbfb",
      "--grad-brand": "linear-gradient(135deg, #8250df, #a17ef5 55%, #c9b6f9)",
      "--grad-selected": "linear-gradient(135deg, #f6f1fe, #ece2fc)",
      "--grad-promo": "linear-gradient(150deg, #f8f4fe, #eee5fc)",
      "--accent": "#8250df", "--accent-hover": "#6d3fd0", "--accent-deep": "#6d3fd0",
      "--accent-light": "#a17ef5", "--accent-soft": "#f1eafd", "--accent-border": "#cdbaf6",
      "--accent-soft-text": "#8250df", "--accent-tint": "#f6f1fe",
      "--accent-soft-deep": "#f1eafd", "--accent-soft-deep-hover": "#e6dbfb",
      "--accent-border-deep": "#cdbaf6", "--border-blue": "#cdbaf6",
    },
    dark: {
      "--primary": "#a88cf4", "--primary-hover": "#bc9ffd", "--primary-light": "#bc9ffd",
      "--primary-bright": "#d5c5fb", "--primary-soft": "#2a2144", "--primary-soft-hover": "#221a38",
      "--grad-brand": "linear-gradient(135deg, #6f4fd0, #a88cf4 55%, #d5c5fb)",
      "--grad-selected": "linear-gradient(135deg, #2a2144, #221a38)",
      "--grad-promo": "linear-gradient(150deg, #241b3c, #1c1530)",
      "--accent": "#a88cf4", "--accent-hover": "#bc9ffd", "--accent-deep": "#bc9ffd",
      "--accent-light": "#d5c5fb", "--accent-soft": "#2a2144", "--accent-border": "#3d2f63",
      "--accent-soft-text": "#d5c5fb", "--accent-tint": "#1c1530",
      "--accent-soft-deep": "#2a2144", "--accent-soft-deep-hover": "#221a38",
      "--accent-border-deep": "#3d2f63", "--border-blue": "#3d2f63",
    },
  },
  {
    key: "amber",
    labelKey: "pro.accentAmber",
    light: {
      "--primary": "#bc4c00", "--primary-hover": "#a04000", "--primary-light": "#e0823d",
      "--primary-bright": "#f0a468", "--primary-soft": "#fdefe4", "--primary-soft-hover": "#fbe2cf",
      "--grad-brand": "linear-gradient(135deg, #bc4c00, #e0823d 55%, #f0a468)",
      "--grad-selected": "linear-gradient(135deg, #fef6ee, #fbe8d8)",
      "--grad-promo": "linear-gradient(150deg, #fdf4ea, #fae7d2)",
      "--accent": "#bc4c00", "--accent-hover": "#a04000", "--accent-deep": "#a04000",
      "--accent-light": "#e0823d", "--accent-soft": "#fdefe4", "--accent-border": "#f2c9a8",
      "--accent-soft-text": "#bc4c00", "--accent-tint": "#fef6ee",
      "--accent-soft-deep": "#fdefe4", "--accent-soft-deep-hover": "#fbe2cf",
      "--accent-border-deep": "#f2c9a8", "--border-blue": "#f2c9a8",
    },
    dark: {
      "--primary": "#d07a21", "--primary-hover": "#e08a3c", "--primary-light": "#e08a3c",
      "--primary-bright": "#f0b072", "--primary-soft": "#3a2714", "--primary-soft-hover": "#2f1f10",
      "--grad-brand": "linear-gradient(135deg, #9c4a00, #d07a21 55%, #f0b072)",
      "--grad-selected": "linear-gradient(135deg, #3a2714, #2f1f10)",
      "--grad-promo": "linear-gradient(150deg, #2e2010, #241a0c)",
      "--accent": "#d07a21", "--accent-hover": "#e08a3c", "--accent-deep": "#e08a3c",
      "--accent-light": "#f0b072", "--accent-soft": "#3a2714", "--accent-border": "#5a3a1a",
      "--accent-soft-text": "#f0b072", "--accent-tint": "#241a0c",
      "--accent-soft-deep": "#3a2714", "--accent-soft-deep-hover": "#2f1f10",
      "--accent-border-deep": "#5a3a1a", "--border-blue": "#5a3a1a",
    },
  },
];

/** 解析当前应使用的补丁：themeMode(system|light|dark) + prefers-color-scheme */
export function resolveAccentPatch(presetKey, themeMode, prefersDark) {
  const preset = ACCENT_PRESETS.find((p) => p.key === presetKey);
  if (!preset) return null;
  const isDark = themeMode === "dark" || (themeMode === "system" && prefersDark);
  return isDark ? preset.dark : preset.light;
}

let appliedVars = [];

/** 应用主题色（覆盖到 documentElement 内联样式）；非浏览器环境为 no-op */
export function applyAccent(presetKey, themeMode = "system", prefersDark = false) {
  if (typeof document === "undefined") return false;
  const patch = resolveAccentPatch(presetKey, themeMode, prefersDark);
  if (!patch) return false;
  const style = document.documentElement.style;
  for (const [name, value] of Object.entries(patch)) {
    style.setProperty(name, value);
  }
  appliedVars = Object.keys(patch);
  return true;
}

/** 重置为默认主题（移除所有覆盖变量） */
export function resetAccent() {
  if (typeof document === "undefined") return;
  const style = document.documentElement.style;
  for (const name of appliedVars.length ? appliedVars : ACCENT_VARS) {
    style.removeProperty(name);
  }
  appliedVars = [];
}

/** 读取持久化的主题色 key（localStorage），无则返回 null */
export function loadAccentKey() {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(ACCENT_STORAGE_KEY);
  const key = raw && ACCENT_PRESETS.some((p) => p.key === raw) ? raw : null;
  return key;
}

/** 持久化主题色选择 */
export function saveAccentKey(key) {
  if (typeof localStorage === "undefined") return;
  localStorage.setItem(ACCENT_STORAGE_KEY, key);
}
