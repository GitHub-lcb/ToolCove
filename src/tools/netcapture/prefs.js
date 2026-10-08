// 抓包工具的偏好持久化：程序路径、调试端口、URL 过滤。
//
// 为什么值得存：程序路径长、带空格、还藏在版本目录里（Qoder 就在
// `...\Qoder CN Launcher\Qoder CN Launcher.exe` 这种地方），每次手打既慢又容易打错，
// 而打错的表现是「启动失败」，很容易让人以为是工具坏了。
//
// 落点沿用工具箱资产（toolbox-netcapture-prefs.json），与其它工具的数据同级，
// 自动参与每日备份。saveToolbox 自带 200ms 防抖，边打字边写不会打爆磁盘。
//
// 不存的东西：抓到的请求。里面可能有敏感的响应体，而它每次抓都是新的一次会话，
// 存下来只是平白扩大落盘面。
import { loadToolbox, saveToolbox } from "../../toolboxStore.js";

export const PREFS_KEY = "netcapture-prefs";

export const DEFAULT_PREFS = { exePath: "", port: 9222, filterText: "", envText: "" };

// 上限是防「手滑把整段日志粘进来」。路径 1024 足够装下任何 Windows 路径。
const MAX_PATH = 1024;
const MAX_FILTER = 200;
const MAX_ENV_TEXT = 4096;

function text(value, max) {
  return String(value ?? "").trim().slice(0, max);
}

/**
 * 把「每行一个 KEY=VALUE」解析成对象。
 *
 * 为什么要这个输入框：有些应用**不接受命令行参数、只认环境变量**，
 * 而且这已经是实测到的第二种了（Qoder 的 CDP_PORT、WorkBuddy 的
 * WORKBUDDY_REMOTE_DEBUGGING_PORT）。没有这条通道，它们根本开不出调试端口。
 *
 * 解析不动就**整行丢掉**，不做猜测：把 `FOO` 当成 `FOO=""` 会让应用拿到一个
 * 空值的开关变量，行为难以预料（可能当成"已开启但端口为空"直接崩）。
 */
export function parseEnvText(input) {
  const out = {};
  for (const line of String(input ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    const value = trimmed.slice(at + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function port(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PREFS.port;
  const rounded = Math.round(n);
  if (rounded < 1 || rounded > 65535) return DEFAULT_PREFS.port;
  return rounded;
}

/** 归一化：磁盘上的东西可能来自旧版本、手改或损坏，这里一律收窄成可用形状。 */
export function normalizePrefs(input) {
  const source = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return {
    exePath: text(source.exePath, MAX_PATH),
    port: port(source.port),
    filterText: text(source.filterText, MAX_FILTER),
    envText: text(source.envText, MAX_ENV_TEXT),
  };
}

export async function loadPrefs() {
  const value = await loadToolbox(PREFS_KEY, { ...DEFAULT_PREFS });
  return normalizePrefs(value);
}

export function savePrefs(prefs, onError) {
  saveToolbox(PREFS_KEY, normalizePrefs(prefs), { onError });
}
