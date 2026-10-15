// 主题（浅色 / 深色 / 跟随系统）的唯一真相源。
//
// 为什么需要这个模块：旧实现的主题**完全由 CSS 媒体查询决定**，
// 而 localStorage.themeMode 只设置了三样东西——窗口主题、colorScheme、强调色补丁。
// 后果是审计实测到的一条真实缺陷：**浏览器端手动切深色不改变任何颜色**，
// 桌面端也只有窗口边框跟着变；CSS 变量一个字都没变。
//
// 现在改成"属性驱动"：
//   <html data-theme="dark|light">  显式指定
//   <html> 上无此属性                跟随系统（CSS 媒体查询接管）
// 两套深色变量的取值必须一致（见 styles/tokens.css 的说明与注释）。
//
// 同时把密度档（紧凑/舒适）也挂到 <html> 上。旧实现绑在 .shell 上，
// 而独立工具窗口（ToolWindow.vue 的 .tool-win）不在 .shell 内，
// 于是"界面密度"设置对工具窗口完全无效。
const THEME_KEY = "themeMode";
const DENSITY_KEY = "density";
// 侧边栏收起状态。刻意与主题/密度同住 localStorage 而**不落 settings.json**：
// 它必须在首帧同步可读。落 settings.json 就得 await 一次 load_data，那意味着外壳先按
// 「展开」画出来、拿到值再收起——用户每次启动都看见侧边栏闪一下。
// 同理，它是纯本机显示偏好（换台设备不该跟着走），与 density 是同一类东西。
const SIDEBAR_KEY = "tc.sidebar.collapsed";

/**
 * 侧边栏是否收起。默认**展开**——这是本次导航重构的硬要求：
 * 导航默认折成图标栏等于把历史与工作面藏起来（ChatGPT 桌面端重设计踩过的坑，
 * 官方随后专门修复）。只有用户自己收起来过，才保持收起。
 */
export function getSidebarCollapsed() {
  try {
    return localStorage.getItem(SIDEBAR_KEY) === "1";
  } catch {
    return false;
  }
}

export function setSidebarCollapsed(value) {
  const next = value === true;
  try {
    if (next) localStorage.setItem(SIDEBAR_KEY, "1");
    else localStorage.removeItem(SIDEBAR_KEY);
  } catch {
    /* 隐私模式下写不进去：只影响本次会话 */
  }
  return next;
}

/** 读用户选择的主题模式：system | light | dark */
export function getThemeMode() {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}

export function setThemeMode(mode) {
  const next = mode === "light" || mode === "dark" ? mode : "system";
  try {
    if (next === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, next);
  } catch {
    /* 隐私模式下 localStorage 不可用：只在本次会话生效 */
  }
  syncThemeAttribute(next);
  return next;
}

/** 把主题模式投影到 <html data-theme>；system 时移除属性，交给媒体查询 */
export function syncThemeAttribute(mode = getThemeMode()) {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (mode === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", mode);
  root.style.colorScheme = mode === "system" ? "light dark" : mode;
  // 启动兜底背景（index.html 内联的那条）已完成使命，摘掉避免与新主题打架
  root.removeAttribute("data-boot-theme");
}

/** 首帧前调用：与 index.html 的内联脚本互为保险 */
export function applyThemeAttribute() {
  syncThemeAttribute();
}

/** 读密度档：compact（默认）| comfort */
export function getDensity() {
  try {
    return localStorage.getItem(DENSITY_KEY) === "comfort" ? "comfort" : "compact";
  } catch {
    return "compact";
  }
}

export function setDensity(value) {
  const next = value === "comfort" ? "comfort" : "compact";
  try {
    if (next === "compact") localStorage.removeItem(DENSITY_KEY);
    else localStorage.setItem(DENSITY_KEY, next);
  } catch {
    /* 同上 */
  }
  syncDensityAttribute(next);
  return next;
}

export function syncDensityAttribute(value = getDensity()) {
  if (typeof document === "undefined") return;
  // 用属性而不是类名：:root[data-density="comfort"] 的优先级稳定，
  // 且不必依赖某个具体容器（旧实现依赖 .shell，工具窗口拿不到）。
  if (value === "comfort") document.documentElement.setAttribute("data-density", "comfort");
  else document.documentElement.removeAttribute("data-density");
}

/** 三种模式的切换顺序（顶栏按钮用） */
export const THEME_CYCLE = ["system", "light", "dark"];

export function nextThemeMode(current) {
  const i = THEME_CYCLE.indexOf(current);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length];
}

/** 当前生效的深色与否（跟随系统时要查媒体查询） */
export function isDarkEffective(mode = getThemeMode()) {
  if (mode === "dark") return true;
  if (mode === "light") return false;
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}
