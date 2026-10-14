// 提示词工具·云端生图的纯逻辑：生成配置归一、请求地址、媒体命名、错误→i18n 键。
// 与视图解耦（不 import Vue/Tauri），node 环境可直接单测。

export const SIZE_OPTIONS = ["1024x1024", "1024x1536", "1536x1024", "768x768", "512x512"];

export const DEFAULT_GEN_CONFIG = Object.freeze({
  cloud: { baseUrl: "", apiKey: "", model: "", size: "1024x1024", n: 1, sendNegative: true },
  comfy: {
    baseUrl: "http://127.0.0.1:8188",
    checkpoint: "",
    steps: 20,
    cfg: 7,
    sampler: "euler",
    scheduler: "normal",
    denoise: 1,
    width: 1024,
    height: 1024,
    seedMode: "random",
    seed: 0,
    workflowId: "",
    overrideParams: false,
  },
});

const MEDIA_EXTS = new Set(["png", "jpg", "webp", "gif", "bmp", "mp4", "webm", "mov"]);
const EXT_ALIAS = { jpeg: "jpg", "svg+xml": "svg" };
const MIME_OF = {
  png: "image/png",
  jpg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  bmp: "image/bmp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

const clampInt = (value, min, max, fallback) => {
  const num = Math.trunc(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const clampNum = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
};

const trimBase = (value) => String(value ?? "").trim().replace(/\/+$/, "");

/** 生成配置归一：任意脏输入都收敛成完整形状（保存前与读取后各过一遍）。 */
export function normalizeGenConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const cloud = src.cloud && typeof src.cloud === "object" ? src.cloud : {};
  const comfy = src.comfy && typeof src.comfy === "object" ? src.comfy : {};
  return {
    cloud: {
      baseUrl: trimBase(cloud.baseUrl),
      apiKey: String(cloud.apiKey ?? "").trim(),
      model: String(cloud.model ?? "").trim(),
      size: SIZE_OPTIONS.includes(cloud.size) ? cloud.size : DEFAULT_GEN_CONFIG.cloud.size,
      n: clampInt(cloud.n, 1, 4, 1),
      sendNegative: cloud.sendNegative !== false,
    },
    comfy: {
      baseUrl: trimBase(comfy.baseUrl) || DEFAULT_GEN_CONFIG.comfy.baseUrl,
      checkpoint: String(comfy.checkpoint ?? "").trim(),
      steps: clampInt(comfy.steps, 1, 150, DEFAULT_GEN_CONFIG.comfy.steps),
      cfg: clampNum(comfy.cfg, 0, 30, DEFAULT_GEN_CONFIG.comfy.cfg),
      sampler: String(comfy.sampler ?? "").trim() || DEFAULT_GEN_CONFIG.comfy.sampler,
      scheduler: String(comfy.scheduler ?? "").trim() || DEFAULT_GEN_CONFIG.comfy.scheduler,
      denoise: clampNum(comfy.denoise, 0, 1, DEFAULT_GEN_CONFIG.comfy.denoise),
      width: clampInt(comfy.width, 64, 4096, DEFAULT_GEN_CONFIG.comfy.width),
      height: clampInt(comfy.height, 64, 4096, DEFAULT_GEN_CONFIG.comfy.height),
      seedMode: comfy.seedMode === "fixed" ? "fixed" : "random",
      seed: Math.max(0, Math.trunc(Number(comfy.seed) || 0)),
      workflowId: String(comfy.workflowId ?? "").trim(),
      overrideParams: Boolean(comfy.overrideParams),
    },
  };
}

/** 云端生图是否已具备最小配置（baseUrl/apiKey/model 三件套）。 */
export function cloudConfigReady(cloud) {
  const config = cloud && typeof cloud === "object" ? cloud : {};
  return Boolean(trimBase(config.baseUrl) && String(config.apiKey ?? "").trim() && String(config.model ?? "").trim());
}

export function buildImagesUrl(baseUrl) {
  const base = trimBase(baseUrl);
  return base ? `${base}/images/generations` : "";
}

/** 扩展名归一：接受裸扩展名 / MIME / URL，未知一律回退（默认 png）。 */
export function normalizeExt(input, fallback = "png") {
  const raw = String(input ?? "").trim().toLowerCase();
  let ext = "";
  if (/^[a-z0-9]{1,6}$/.test(raw)) {
    ext = raw;
  } else {
    const mime = raw.match(/(?:image|video)\/([a-z0-9+.-]{1,12})/);
    if (mime) ext = mime[1];
    else {
      const url = raw.match(/\.([a-z0-9]{1,5})(?:[?#]|$)/);
      if (url) ext = url[1];
    }
  }
  ext = EXT_ALIAS[ext] || ext;
  return MEDIA_EXTS.has(ext) ? ext : fallback;
}

/** 生成媒体文件名：p<yyyymmdd-hhmmss>-<4位36进制随机>.<ext>（时间戳保证大致有序，随机位防同秒撞名）。 */
export function mediaName(ext, now = Date.now(), rand = Math.random) {
  const date = new Date(now);
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const stamp = [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
  const roll = Math.min(1 - 1e-9, Math.max(0, Number(rand()) || 0));
  const suffix = Math.floor(roll * 36 ** 4).toString(36).padStart(4, "0");
  return `p${stamp}-${suffix}.${normalizeExt(ext)}`;
}

export function mimeOfName(name) {
  return MIME_OF[normalizeExt(name, "")] || "application/octet-stream";
}

export function isVideoName(name) {
  return mimeOfName(name).startsWith("video/");
}

export function dataUrl(name, b64) {
  return `data:${mimeOfName(name)};base64,${String(b64 ?? "")}`;
}

/** 生成失败 → i18n 键。分类对齐 ai.js aiErrorCodeOf，但只产出键，不产文案。 */
export function genErrorKeyOf(error) {
  const message = typeof error === "string" ? error : String(error?.message ?? error ?? "");
  if (/未配置|not configured/i.test(message)) return "toolbox.prompt.errConfig";
  if (/未返回图片|no images?/i.test(message)) return "toolbox.prompt.errNoImages";
  const status = message.match(/\bHTTP\s+(\d{3})\b/i);
  if (status) {
    const code = Number(status[1]);
    if (code === 401 || code === 403) return "toolbox.prompt.errAuth";
    if (code === 429) return "toolbox.prompt.errRate";
    if (code >= 500) return "toolbox.prompt.errServer";
    return "toolbox.prompt.errHttp";
  }
  if (/超时|timeout|timed out/i.test(message)) return "toolbox.prompt.errTimeout";
  if (/连接|connect|refused|unreachable|dns|network|error sending request/i.test(message)) {
    return "toolbox.prompt.errNetwork";
  }
  return "toolbox.prompt.errTransport";
}
