// 多模型配置：settings.ai = { enabled, activeId, profiles: [...] }。
// 一套配置 = 一个 OpenAI 兼容端点（baseUrl + apiKey + model + 温度/推理档位），
// 用户可以存多套并在输入框右下角切换；旧版单模型扁平字段自动迁移成一条配置。
//
// 本模块是纯函数：apiKey 原样保留（落盘时是密文），这里不解密也不发请求。
import { normalizeEffort } from "./modelCatalog.js";

export const PROFILE_MAX = 12;
const ID_MAX = 64;
const NAME_MAX = 48;
const URL_MAX = 512;
const MODEL_MAX = 128;
const KEY_MAX = 1024;

let fallbackSeq = 0;

/** 配置 id：只用于本地引用，不暴露给模型。 */
export function newProfileId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {
    // 旧 WebView 没有 randomUUID：落到时间戳 + 序号
  }
  fallbackSeq += 1;
  return `model-${Date.now().toString(36)}-${fallbackSeq}`;
}

const str = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

/** 单条配置归一；全空记录返回 null（旧库占位与表单草稿都靠这条判断）。 */
function profileFrom(raw, index = 0) {
  const p = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const name = str(p.name, NAME_MAX).trim();
  const baseUrl = str(p.baseUrl, URL_MAX).trim();
  const apiKey = str(p.apiKey, KEY_MAX);
  const model = str(p.model, MODEL_MAX).trim();
  if (!name && !baseUrl && !apiKey && !model) return null;
  const temperature = Number.isFinite(Number(p.temperature))
    ? Math.min(Math.max(Number(p.temperature), 0), 1)
    : 0.7;
  return {
    id: str(p.id, ID_MAX).trim() || `model-${index + 1}`,
    name,
    baseUrl,
    apiKey,
    model,
    temperature,
    reasoningEffort: normalizeEffort(p.reasoningEffort),
  };
}

/**
 * settings.ai 归一：profiles 优先；没有 profiles 时把旧版扁平字段迁成一条。
 * activeId 失效时回退到第一条——永远给界面一个确定的「当前模型」。
 */
export function normalizeAi(raw) {
  const a = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const seen = new Set();
  let profiles = (Array.isArray(a.profiles) ? a.profiles : [])
    .map((item, index) => profileFrom(item, index))
    .filter((item) => {
      if (!item || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, PROFILE_MAX);

  if (!profiles.length) {
    const legacy = profileFrom({ ...a, id: a.id || "default" }, 0);
    if (legacy) profiles = [legacy];
  }

  const activeId = profiles.some((p) => p.id === a.activeId) ? String(a.activeId) : profiles[0]?.id || "";
  return { enabled: a.enabled === true, activeId, profiles };
}

/** 当前使用的配置；没有配置返回 null。 */
export function activeProfile(ai) {
  const profiles = Array.isArray(ai?.profiles) ? ai.profiles : [];
  return profiles.find((p) => p.id === ai?.activeId) || profiles[0] || null;
}

/** 展示名：用户命名优先，其次模型名。 */
export function profileLabel(profile) {
  const p = profile && typeof profile === "object" ? profile : {};
  return String(p.name || p.model || "").trim();
}

/**
 * 落盘形状：profiles + activeId，并**镜像当前配置到旧扁平字段**。
 * 镜像有两个用处：手改 settings.json 的旧格式仍能读；旧版代码/手机端即使只认扁平字段，
 * 也不会在切换到另一套配置后继续用上一套。唯一真相仍是 profiles.activeId。
 */
export function toStoredAi(ai) {
  const profiles = Array.isArray(ai?.profiles) ? ai.profiles : [];
  const active = activeProfile({ ...ai, profiles });
  const out = { enabled: ai?.enabled === true, activeId: active?.id || "", profiles };
  if (active) {
    out.baseUrl = active.baseUrl;
    out.apiKey = active.apiKey;
    out.model = active.model;
    out.temperature = active.temperature;
    out.reasoningEffort = active.reasoningEffort;
  }
  return out;
}
