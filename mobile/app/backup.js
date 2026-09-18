// 手机端的数据备份与恢复。
//
// 与桌面端的关系：桌面端把 app_data_dir 下的 *.json 与图片打成 **zip** 写到用户选的路径；
// 手机端没有"任意路径写"，数据在 IndexedDB 里，所以做法是：
//   · 备份 → 把所有键读出来打包成一个 **JSON 文件**，用浏览器下载（用户可存到网盘/传电脑）
//   · 恢复 → 经系统文件选择器（SAF）选一个备份文件，解析后写回 IndexedDB
//
// 格式刻意用 JSON 而不是 zip：手机端要少一层依赖（JS 里造 zip 要么引库、要么手写），
// 而备份的实质是"一堆键值对"，JSON 足够且**人能读懂**——出问题时可以直接打开看。
// 图片是 base64 存在同一个键里，所以不需要额外处理二进制。
//
// 文件头带 format/version：将来换格式时能识别旧文件，而不是解出一堆乱码。
import { kvGet, kvKeys, kvSet } from "../../src/platform/kv.js";

export const BACKUP_FORMAT = "toolcove-mobile-backup";
export const BACKUP_VERSION = 1;

/** 不参与备份的键（瞬时状态、缓存）。 */
const SKIP_KEYS = new Set(["__e2e_seed_mark"]);

/** 生成备份对象（纯数据，便于单测）。 */
export async function buildBackup() {
  const keys = (await kvKeys()).filter((key) => !SKIP_KEYS.has(key));
  const entries = {};
  let missing = 0;
  for (const key of keys) {
    const value = await kvGet(key);
    // 读不到的键跳过并计数：备份里出现 null 会让恢复时误删真实数据
    if (value === null || value === undefined) {
      missing += 1;
      continue;
    }
    entries[key] = value;
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    // 记录来源平台：桌面端的 zip 备份不能直接在这里恢复，反之亦然——
    // 写明来源，恢复时才能给出"这不是手机端备份"的可读提示
    platform: "android",
    entries,
    stats: { keys: Object.keys(entries).length, missing },
  };
}

/** 备份对象的校验（纯函数，便于单测）。 */
export function validateBackup(payload) {
  if (!payload || typeof payload !== "object") return { ok: false, reason: "notObject" };
  if (payload.format !== BACKUP_FORMAT) {
    // 桌面端的 zip 解出来不会是 JSON；若用户选错了文件，这里给出明确原因
    return { ok: false, reason: payload.format ? "wrongFormat" : "notBackup" };
  }
  if (typeof payload.version !== "number") return { ok: false, reason: "noVersion" };
  if (payload.version > BACKUP_VERSION) return { ok: false, reason: "tooNew" };
  if (!payload.entries || typeof payload.entries !== "object") return { ok: false, reason: "noEntries" };
  return { ok: true, keys: Object.keys(payload.entries).length };
}

/** 恢复：把备份里的键写回存储。返回写入的键数与跳过数。 */
export async function applyBackup(payload) {
  const check = validateBackup(payload);
  if (!check.ok) throw new Error(check.reason);
  let written = 0;
  for (const [key, value] of Object.entries(payload.entries)) {
    if (SKIP_KEYS.has(key)) continue;
    await kvSet(key, value);
    written += 1;
  }
  return { written, total: check.keys };
}

/** 触发下载（手机上走系统下载/分享）。 */
export function downloadBackup(payload, filename = "toolcove-backup.json") {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  // 立刻 revoke 会让某些 WebView 来不及取数据，留一段时间
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** 恢复前的提示文案参数（纯函数：让人知道这次恢复会覆盖什么）。 */
export function describeBackup(payload) {
  const check = validateBackup(payload);
  if (!check.ok) return { ok: false, reason: check.reason, keys: 0, createdAt: "" };
  return { ok: true, reason: "", keys: check.keys, createdAt: String(payload.createdAt || "") };
}
