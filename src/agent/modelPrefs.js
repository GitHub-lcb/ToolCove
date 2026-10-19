// 模型选择的读写：输入框右下角的模型胶囊读/改当前配置（settings.ai）。
//
// 多模型方案：胶囊可以在已保存的多套配置之间切换（profileId），也可以改当前配置的模型名
// 与推理档位。为什么不复用 ai.js 的 loadAIConfig：那个函数会顺带解密 apiKey，而这里只需要
// 展示字段——为了在输入框里画一个模型名去解密密钥，既慢又扩大暴露面。
// 写入沿用 settings 的「读-合并-写」惯例：设置页表单与遥测/同步共用同一个 settings 文件。
import { invoke } from "../platform/invoke.js";
import { decryptValue } from "../secure.js";
import { listAIModels } from "../ai.js";
import { normalizeEffort } from "./modelCatalog.js";
import { activeProfile, normalizeAi, profileLabel, toStoredAi } from "./modelProfiles.js";

async function readSettings() {
  let settings = {};
  try {
    settings = await invoke("load_data", { key: "settings" });
  } catch {
    settings = {};
  }
  return settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
}

/** 对外展示形状：当前配置 + 可切换的配置列表（不包含密钥）。 */
function choiceOf(ai) {
  const active = activeProfile(ai);
  return {
    baseUrl: active?.baseUrl || "",
    model: active?.model || "",
    reasoningEffort: active?.reasoningEffort || "",
    enabled: ai.enabled,
    profileId: active?.id || "",
    profileName: active ? profileLabel(active) : "",
    profiles: ai.profiles.map((profile) => ({
      id: profile.id,
      name: profileLabel(profile),
      baseUrl: profile.baseUrl,
      model: profile.model,
    })),
  };
}

/** 读当前模型选择（只读展示字段；baseUrl 用于认服务商）。 */
export async function loadModelChoice() {
  const settings = await readSettings();
  return choiceOf(normalizeAi(settings.ai));
}

/**
 * 写入模型选择。支持三种 patch：profileId（切换配置）、model（改当前配置的模型）、
 * reasoningEffort（改当前配置的档位）。空模型名直接忽略——空模型会让下一次调用必然报
 * CONFIG 错，属于「界面把用户带进死胡同」。返回切换后的展示形状，调用方据此刷新胶囊。
 */
export async function saveModelChoice(patch = {}) {
  const settings = await readSettings();
  const ai = normalizeAi(settings.ai);
  let changed = false;

  if (Object.prototype.hasOwnProperty.call(patch, "profileId")) {
    const id = String(patch.profileId ?? "").trim();
    if (id && id !== ai.activeId && ai.profiles.some((profile) => profile.id === id)) {
      ai.activeId = id;
      changed = true;
    }
  }

  const active = activeProfile(ai);
  if (active && Object.prototype.hasOwnProperty.call(patch, "model")) {
    const model = String(patch.model ?? "").trim().slice(0, 128);
    if (model && model !== active.model) {
      active.model = model;
      changed = true;
    }
  }
  if (active && Object.prototype.hasOwnProperty.call(patch, "reasoningEffort")) {
    const effort = normalizeEffort(patch.reasoningEffort);
    if (effort !== active.reasoningEffort) {
      active.reasoningEffort = effort;
      changed = true;
    }
  }

  if (changed) {
    settings.ai = toStoredAi(ai);
    await invoke("save_data", { key: "settings", data: settings });
  }
  return choiceOf(ai);
}

/**
 * 供输入框模型弹层调用：按已保存配置从端点拉模型列表（GET /models）。
 * 这是用户显式打开弹层的动作，解密一次 Key 是可接受的成本——不把它缓存到视图层。
 */
export async function loadModelList({ profileId } = {}) {
  const settings = await readSettings();
  const ai = normalizeAi(settings.ai);
  const profile = profileId ? ai.profiles.find((p) => p.id === profileId) : activeProfile(ai);
  if (!profile) return [];
  const apiKey = (await decryptValue(profile.apiKey || "")).trim();
  return listAIModels({ baseUrl: profile.baseUrl, apiKey });
}
