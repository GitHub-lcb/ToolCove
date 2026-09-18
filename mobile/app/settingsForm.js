// 手机端设置页的纯逻辑：形状归一、校验、预设匹配、同步状态文案。
//
// 为什么抽出来：设置页最容易出的问题是**静默丢失**——
// 桌面端专门用 mergeSettingsSnapshot 合并快照，就是因为「表单只渲染 ai/ui，
// 保存时把 sync/telemetry 整段覆盖掉」踩过坑。手机端沿用同一套语义，
// 并把判断放在可单测的纯函数里（组件只负责渲染与调用）。

/**
 * 桌面端与手机端共用的设置形状（键名必须与桌面一致，否则两端读同一份 settings 会互相丢字段）。
 * 只列手机端会渲染的字段；其余字段靠 mergeSettingsSnapshot 原样带过去。
 */
export function emptySettings() {
  return {
    ai: { baseUrl: "", apiKey: "", model: "", temperature: 0.7, reasoningEffort: "", enabled: false },
    ui: { density: "compact", hiddenModules: [], locale: "system" },
  };
}

const isPlainObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/**
 * 把磁盘上的 settings 归一成表单形状。
 * 注意 apiKey 传进来时应已解密（decryptValue 是异步的，放在组件里做）。
 */
export function formFromSettings(raw, { decryptedKey = "" } = {}) {
  const s = isPlainObject(raw) ? raw : {};
  const ai = isPlainObject(s.ai) ? s.ai : {};
  const ui = isPlainObject(s.ui) ? s.ui : {};
  return {
    ai: {
      baseUrl: String(ai.baseUrl || ""),
      apiKey: String(decryptedKey || ""),
      model: String(ai.model || ""),
      temperature: typeof ai.temperature === "number" && Number.isFinite(ai.temperature) ? ai.temperature : 0.7,
      reasoningEffort: String(ai.reasoningEffort || ""),
      enabled: !!ai.enabled,
    },
    ui: {
      density: ui.density === "comfort" ? "comfort" : "compact",
      hiddenModules: Array.isArray(ui.hiddenModules) ? [...ui.hiddenModules] : [],
      locale: ["system", "zh-CN", "en-US"].includes(ui.locale) ? ui.locale : "system",
    },
  };
}

/**
 * 表单校验：只在启用 AI 时校验必填项。
 * 返回 { ok, errors }，errors 的键是字段名——界面按字段显示，不做「一个红字概括所有问题」。
 */
export function validateSettings(form) {
  const errors = {};
  const ai = form?.ai || {};
  if (ai.enabled) {
    if (!String(ai.baseUrl || "").trim()) errors.baseUrl = "settings.errAiBase";
    if (!String(ai.apiKey || "").trim()) errors.apiKey = "settings.errAiKey";
    if (!String(ai.model || "").trim()) errors.model = "settings.errAiModel";
    // 地址必须是 http(s)：写个域名漏协议是最常见的配置错误
    const url = String(ai.baseUrl || "").trim();
    if (url && !/^https?:\/\//i.test(url)) errors.baseUrl = "settings.errAiBase";
  }
  const temperature = ai.temperature;
  if (temperature !== undefined && temperature !== null && temperature !== "" && !Number.isFinite(Number(temperature))) {
    errors.temperature = "settings.errAiTemperature";
  }
  return { ok: Object.keys(errors).length === 0, errors };
}

/** 去掉末尾斜杠：用户粘 baseUrl 时常带上，留着会拼出 //chat/completions。 */
export function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

/** 预设匹配：用来在界面上高亮「当前用的是哪个预设」，匹配不上返回 null（自定义）。 */
export function matchPreset(baseUrl, presets = []) {
  const target = normalizeBaseUrl(baseUrl).toLowerCase();
  if (!target) return null;
  return presets.find((preset) => normalizeBaseUrl(preset.baseUrl).toLowerCase() === target) || null;
}

/** 推理强度可选项（与桌面端一致：留空表示不指定）。 */
export const REASONING_EFFORTS = Object.freeze(["", "low", "medium", "high"]);

/** 云同步状态 → 文案键。**键在 sync.* 命名空间下**（桌面端就是这么放的），
 *  未知状态也要有说法，不能显示空白。 */
export function syncStatusKey(status) {
  const table = {
    disabled: "sync.statusDisabled",
    idle: "sync.statusIdle",
    syncing: "sync.statusSyncing",
    error: "sync.statusError",
    revoked: "sync.statusRevoked",
  };
  return table[status] || "sync.statusIdle";
}

/** 配对码/密码的可用性判断：先本地拦掉明显不合法的输入，别等请求失败。
 *  文案沿用桌面端已有的 sync.err* 键，不另造一套。 */
export function validateJoinInput({ collectionId, code, password } = {}) {
  const errors = {};
  if (!String(collectionId || "").trim()) errors.collectionId = "sync.errNotFound";
  if (!String(code || "").trim()) errors.code = "sync.errBadCode";
  if (!String(password || "").trim()) errors.password = "sync.errShortPw";
  return { ok: Object.keys(errors).length === 0, errors };
}
