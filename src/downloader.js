// 下载器工具的纯逻辑层（无 Vue、无 IO）：URL 解析、文件名推导、分片计划推导、
// 进度/速度/耗时格式化、队列状态机。
//
// 单独成文件是为了能在 node 环境跑单测（与 src/jsonSchema.js 同样的理由）：
// 队列推进与"这一项该显示什么"是真正会出错的部分，不该只能靠点界面验证。

/** 队列项状态。running/paused 由前端持有，resumable 来自原生侧的断点探测。 */
export const ITEM_STATE = {
  waiting: "waiting",
  running: "running",
  paused: "paused",
  done: "done",
  error: "error",
};

/** 线程数范围，与 Rust 侧 clamp_conns 保持一致。 */
export const MIN_CONNS = 1;
export const MAX_CONNS = 32;
export const DEFAULT_CONNS = 8;

export function clampConns(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_CONNS;
  return Math.min(MAX_CONNS, Math.max(MIN_CONNS, n));
}

/**
 * 把「网页地址」改写成「文件下载地址」。
 *
 * 为什么需要：HuggingFace 系站点的文件页地址是 `/blob/xxx`，但那返回的是 HTML 预览页，
 * 真正下文件要用 `/resolve/xxx`。用户几乎总是直接从浏览器地址栏复制，粘进来就下不了——
 * 实测 15 GB 的模型就是这么失败的。能在入队时改掉，就不要让用户去读报错。
 *
 * 识别不了的就原样返回：由原生侧按 Content-Type 兜底并给出可读原因。
 */
export function normalizeDownloadUrl(url) {
  const value = String(url ?? "").trim();
  if (!value) return value;
  // 目录列表页（/tree/）没法自动猜是哪个文件，交给报错路径说明
  if (/\/tree\//i.test(value)) return value;
  // 只改路径里那一段，别动 query（?download=1 之类要保留）
  return value.replace(/\/blob\//i, "/resolve/");
}

/**
 * 从粘贴的多行文本里取出 URL。
 *
 * 为什么允许行内多余内容：用户经常从浏览器地址栏或日志里整段复制，
 * 里面混着引号、逗号、说明文字。只认行首的 http(s) 开头，剩下的整行丢掉。
 */
export function parseUrlList(text) {
  const out = [];
  const seen = new Set();
  for (const raw of String(text ?? "").split(/[\r\n]+/)) {
    const line = raw.trim().replace(/^["'`]+|["'`,;]+$/g, "").trim();
    if (!line) continue;
    const match = /^(https?:\/\/\S+)/i.exec(line);
    if (!match) continue;
    const url = normalizeDownloadUrl(match[1]);
    // 同一地址重复粘贴只留一条：同一个文件分两次下会白占一倍带宽
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

const UNSAFE_NAME = /[\\/:*?"<>|]/g;

function percentDecode(input) {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/**
 * 从 URL 猜文件名。
 *
 * 关键是要先剥掉主机段——只按 "/" 切最后一段的话，"https://a.com/" 会把域名
 * 当成文件名存下来（这是 Rust 侧同名函数被单测抓出来的同一个坑，前端保持一致）。
 */
export function fileNameFromUrl(url) {
  const withoutQuery = String(url ?? "").split(/[?#]/)[0] || "";
  const afterScheme = withoutQuery.includes("://") ? withoutQuery.split("://")[1] : withoutQuery;
  const slash = afterScheme.indexOf("/");
  const path = slash === -1 ? "" : afterScheme.slice(slash);
  const segments = path.split("/").filter(Boolean);
  const name = percentDecode(segments.length ? segments[segments.length - 1] : "")
    .replace(UNSAFE_NAME, "")
    .trim();
  return name || "download.bin";
}

/** 探测结果里的文件名优先（服务端 Content-Disposition 比 URL 可靠）。 */
export function resolveFileName(probe, url) {
  const fromProbe = String(probe?.fileName ?? "").replace(UNSAFE_NAME, "").trim();
  return fromProbe || fileNameFromUrl(url);
}

/**
 * 分片计划（与 Rust 侧 plan_parts 同一套均分规则）。
 *
 * 放在前端也算一遍是为了让"线程数 = 几"在界面上能立刻画出来，
 * 不必等原生侧探测完才知道。真正的切片仍以原生侧为准。
 */
export function planParts(total, conns) {
  const size = Math.max(0, Math.trunc(Number(total) || 0));
  if (size === 0) return [];
  const n = clampConns(conns);
  const base = Math.floor(size / n);
  const extra = size % n;
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < n; i += 1) {
    const len = base + (i < extra ? 1 : 0);
    if (len === 0) continue;
    parts.push({ start: cursor, end: cursor + len - 1, want: len });
    cursor += len;
  }
  return parts;
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

/**
 * 字节数转可读体积。
 *
 * 只有纯字节数才不取整——1.5 KB 抹成 "2 KB" 是把真实进度说错了，
 * 而 GB/TB 上再加小数位又是在装精度。
 */
export function formatBytes(bytes, keepDecimals = 1) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value === 0) return `0 ${UNITS[0]}`;
  const index = Math.min(UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const scaled = value / 1024 ** index;
  const decimals = index === 0 ? 0 : keepDecimals;
  return `${scaled.toFixed(decimals)} ${UNITS[index]}`;
}

export function formatSpeed(bytesPerSecond) {
  const value = Math.max(0, Number(bytesPerSecond) || 0);
  if (value === 0) return `0 ${UNITS[0]}/s`;
  return `${formatBytes(value)}/s`;
}

export function formatPercent(done, total) {
  const t = Math.max(0, Number(total) || 0);
  if (t === 0) return "0%";
  const ratio = Math.min(1, Math.max(0, (Number(done) || 0) / t));
  return `${(ratio * 100).toFixed(ratio >= 0.999 ? 0 : 1)}%`;
}

/** 剩余时间。速度为 0 或总量未知时返回空串——显示"未知"比显示"0 秒"诚实。 */
export function formatEta(done, total, bytesPerSecond) {
  const t = Math.max(0, Number(total) || 0);
  const d = Number(done) || 0;
  const speed = Number(bytesPerSecond) || 0;
  if (t === 0 || speed <= 0 || d >= t) return "";
  const seconds = Math.round((t - d) / speed);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

/** 队列项 id。用序号而不是 URL——URL 重复粘贴时序号稳定，键不会打架。 */
export function makeItemId(index) {
  return `dl-${index}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 新建一个队列项。 */
export function createItem(url, index, dir) {
  return {
    id: makeItemId(index),
    url,
    fileName: fileNameFromUrl(url),
    dest: dir,
    state: ITEM_STATE.waiting,
    downloaded: 0,
    total: 0,
    speed: 0,
    conns: DEFAULT_CONNS,
    resumable: false,
    error: "",
    probing: false,
  };
}

/** 应用原生侧进度事件（不可变更新，Vue 响应式友好）。 */
export function applyProgress(item, payload) {
  return {
    ...item,
    downloaded: Math.max(0, Number(payload?.downloaded) || 0),
    total: Math.max(0, Number(payload?.total) || 0),
    speed: Math.max(0, Number(payload?.speed) || 0),
    conns: clampConns(payload?.conns ?? item.conns),
    state: ITEM_STATE.running,
  };
}

export function applyProbe(item, probe) {
  const total = Math.max(0, Number(probe?.total) || 0);
  return {
    ...item,
    fileName: resolveFileName(probe, item.url),
    total,
    // 服务端不支持 Range 时前端就直说，免得用户调线程数以为在加速
    ranges: Boolean(probe?.ranges),
    state: item.state === ITEM_STATE.done ? ITEM_STATE.done : ITEM_STATE.waiting,
  };
}

/** 队列里下一个该启动的项：第一个 waiting 的。 */
export function nextWaiting(items) {
  return items.find((item) => item.state === ITEM_STATE.waiting) || null;
}

/** 是否还有未完成的工作（用于判断能否关窗/退出）。 */
export function hasActiveWork(items) {
  return items.some((item) => item.state === ITEM_STATE.running || item.state === ITEM_STATE.waiting);
}

/** 队列总进度（按字节加权，而不是按项数平均——大文件不该被小文件稀释）。 */
export function queueProgress(items) {
  let downloaded = 0;
  let total = 0;
  for (const item of items) {
    downloaded += Math.max(0, item.downloaded || 0);
    total += Math.max(0, item.total || 0);
  }
  return { downloaded, total };
}

/** 汇总速度：正在下的那几项之和（done/error 的速度已归零，不重复计入）。 */
export function queueSpeed(items) {
  return items.reduce((sum, item) => sum + (item.state === ITEM_STATE.running ? Math.max(0, item.speed || 0) : 0), 0);
}

/** 校验保存目录：空、相对路径、含非法字符都要拦在启动前。 */
export function validateDest(dir, fileName) {
  const value = String(dir ?? "").trim();
  if (!value) return { ok: false, reason: "empty" };
  if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(value)) return { ok: false, reason: "relative" };
  if (/<|>|\||"|\*|\?/.test(value)) return { ok: false, reason: "illegal" };
  if (fileName && /[\\/:*?"<>|]/.test(fileName)) return { ok: false, reason: "name" };
  return { ok: true, reason: "" };
}

/** 把目录与文件名拼成完整目标路径（Windows 下统一用反斜杠）。 */
export function joinDest(dir, fileName) {
  const base = String(dir ?? "").replace(/[\\/]+$/, "");
  const name = String(fileName ?? "").trim();
  if (!base) return name;
  return `${base}\\${name}`;
}

/** 批量条目按文件名去重：同名文件连下会互相覆盖，只保留第一条。 */
export function dedupeByFileName(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item.fileName.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
