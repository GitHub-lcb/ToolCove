// 安卓端自动更新：读清单 → 比版本 → 下包 → 校验 → 拉起系统安装页。
//
// 为什么桌面有的这套安卓要另写一遍：桌面用的是 Tauri updater 插件（`latest.json` + 签名校验 +
// 静默替换），安卓没有对应的东西，只能自己搭这条链。两边的**通道也刻意分开**：
// 桌面占用了 `releases/latest/download/latest.json`，安卓读的是 `apk-latest` 这个固定通道 ——
// 抢同一个标记会让所有 Windows 用户静默收不到更新（见 mobile-release.yml 里那道护栏）。
//
// 这里只做「判断」，动手的部分在原生侧（UpdateNative）：域名白名单、SHA-256 校验、
// 安装路径约束都在 Kotlin 里兜底，JS 这一层即使被改也不能绕过它们。
//
// 不 import Vue / Tauri：可在 node 环境直接单测，浏览器形态（E2E）也能跑。
import { invoke } from "../../../src/platform/invoke.js";

/** 安卓更新清单的固定地址（不是 releases/latest，那条属于桌面）。 */
export const APK_MANIFEST_URL = "https://github.com/GitHub-lcb/ToolCove/releases/download/apk-latest/apk.json";
/** 清单太旧也当没更新：超过这个体积基本可以断定拿错了文件。 */
const MAX_APK_BYTES = 200 * 1024 * 1024;

const text = (value) => (typeof value === "string" ? value : "");

/**
 * 解析并**严格校验**清单。任一字段不合要求就返回 null，让上层报"清单不可用"而不是继续。
 * 校验这三样是因为清单是唯一的外部输入，而它决定"下哪个文件、要不要装"：
 *  - url 必须 https（原生侧还会再查域名白名单，这里先把明显不能用的挡掉）
 *  - sha256 必须是 64 位十六进制：缺哈希就不该有"免检"这条路
 *  - version 必须是 x.y.z 形状：比较逻辑建立在它之上
 */
export function parseManifest(raw) {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const version = text(value.version).trim();
  const url = text(value.url).trim();
  const sha256 = text(value.sha256).trim().toLowerCase();
  if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
  if (!url.startsWith("https://")) return null;
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const size = Number(value.size);
  if (Number.isFinite(size) && (size <= 0 || size > MAX_APK_BYTES)) return null;
  const versionCode = Number(value.versionCode);
  return {
    version,
    url,
    sha256,
    size: Number.isFinite(size) ? size : 0,
    versionCode: Number.isInteger(versionCode) && versionCode > 0 ? versionCode : 0,
    notes: text(value.notes).trim(),
  };
}

/** 版本串比较：逐段数字比。返回 1 / 0 / -1。段数不等时缺位补 0。 */
export function compareVersions(a, b) {
  const left = text(a).split(".").map((part) => parseInt(part, 10) || 0);
  const right = text(b).split(".").map((part) => parseInt(part, 10) || 0);
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * 该不该更新。四种结论都要**看得见**：
 *  - `uptodate`：已是最新（含清单版本等于当前 —— 同版本重装没意义，安卓还会拒）
 *  - `available`：有新版
 *  - `unknown`：拿不到当前版本（浏览器形态），此时不谎报"已是最新"
 *  - `invalid`：清单读不到或不合法。**必须单独报出来**：发版时忘了更新通道，
 *    界面若显示"已是最新"，用户会一直停在旧版本而没人知道
 * 版本名相同而 versionCode 递增（同一版本号重发包）也算有新版，否则这种包永远装不上去。
 */
export function decideUpdate(manifest, current) {
  const parsed = manifest ? parseManifest(manifest) : null;
  if (!parsed) return { state: "invalid" };
  const name = text(current?.versionName);
  if (!name.trim()) return { state: "unknown", target: parsed.version };
  let order = compareVersions(parsed.version, name);
  if (order === 0 && parsed.versionCode > 0 && Number(current?.code) > 0) {
    order = parsed.versionCode > Number(current.code) ? 1 : -1;
  }
  return order > 0 ? { state: "available", target: parsed.version } : { state: "uptodate", target: parsed.version };
}

/**
 * 取清单。两种失败要分开：
 *  - **非 2xx（404 最常见）→ 返回 null**，让上层判成"清单不可用"。这通常意味着还没发布
 *    或通道地址被改过，与"网络不通"是两回事，报法也不同
 *  - **网络层抛错 → 继续抛出**，界面显示失败原因（DNS、超时、离线）
 */
export async function fetchManifest(url = APK_MANIFEST_URL) {
  const result = await invoke("http_request", { method: "GET", url, timeoutMs: 15000 });
  const status = Number(result?.status || 0);
  if (status < 200 || status > 299) return null;
  return parseManifest(result?.body);
}

/** 当前版本（原生给）。浏览器形态没有包概念，返回空串由上层判"未知"。 */
export async function currentVersion() {
  const info = await invoke("app_version", {}).catch(() => null);
  return {
    versionName: text(info?.versionName),
    code: Number.isFinite(Number(info?.versionCode)) ? Number(info.versionCode) : 0,
    canInstall: info?.canInstall === true,
    supported: !!info && text(info.versionName) !== "",
  };
}

/**
 * 下载并校验新包（原生侧做白名单与 SHA-256，失败会抛错）。
 * 返回 { path, size }。
 */
export function downloadApk(manifest) {
  const parsed = parseManifest(manifest);
  if (!parsed) return Promise.reject(new Error("更新清单不可用"));
  return invoke("update_download", { url: parsed.url, sha256: parsed.sha256 });
}

/** 拉起系统安装页。返回 { ok, reason }，reason 交给界面映射文案。 */
export function installApk(path) {
  return invoke("update_install", { path: text(path) });
}
