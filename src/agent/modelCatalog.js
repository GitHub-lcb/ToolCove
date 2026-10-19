// 模型目录（纯数据 + 纯函数）：输入框右下角的模型选择器用它列出候选与服务商名。
//
// 只做展示与选择，不碰 ai.js 的请求组装：选择结果写回 settings.ai 后，下一次模型调用自然生效。
//
// 为什么按 baseUrl 认服务商，而不是按模型品牌列全量候选：
//   用户配的是一个 OpenAI 兼容端点，模型名能不能用由那家端点决定。把「DeepSeek 官方模型」
//   列给一个指向别处的端点，点下去只会 404。认不出的端点一律不给候选，只留「自定义模型名」，
//   并给一条去设置页配置的出口。
//
// ctx（上下文窗口）只在有公开事实时给出：DeepSeek 两个模型 128K、GPT-4o 系列 128K、
// Moonshot 按名字 8K/32K/128K、qwen-plus 128K。拿不准的一律留空，界面就不显示这个徽标——
// 宁可少一个数字，也不编一个。

// 服务商目录：设置页的厂商下拉、对话里的厂商识别、模型候选都吃这一份清单。
// baseUrl 已含版本段，请求时直接拼 /chat/completions 或 /models。
// models 只是「内置候选/默认模型」；真实列表以端点返回为准（设置页会自动拉取）。
export const PROVIDER_LIST = Object.freeze([
  // ---------- 国际 ----------
  {
    key: "openai",
    label: "OpenAI",
    labelKey: "settings.aiPresetOpenai",
    group: "global",
    baseUrl: "https://api.openai.com/v1",
    match: /api\.openai\.com/i,
    models: [
      { id: "gpt-4o-mini", ctx: "128K" },
      { id: "gpt-4o", ctx: "128K" },
    ],
  },
  {
    key: "anthropic",
    label: "Anthropic",
    labelKey: "settings.aiPresetAnthropic",
    group: "global",
    baseUrl: "https://api.anthropic.com/v1",
    match: /api\.anthropic\.com/i,
    models: [
      { id: "claude-sonnet-4-20250514", ctx: "200K" },
      { id: "claude-opus-4-20250514", ctx: "200K" },
    ],
  },
  {
    key: "gemini",
    label: "Google Gemini",
    labelKey: "settings.aiPresetGemini",
    group: "global",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    match: /generativelanguage\.googleapis\.com/i,
    models: [
      { id: "gemini-2.5-flash", ctx: "1M" },
      { id: "gemini-2.5-pro", ctx: "1M" },
    ],
  },
  {
    key: "xai",
    label: "xAI Grok",
    labelKey: "settings.aiPresetXai",
    group: "global",
    baseUrl: "https://api.x.ai/v1",
    match: /api\.x\.ai/i,
    models: [
      { id: "grok-3", ctx: "131K" },
      { id: "grok-3-mini", ctx: "131K" },
    ],
  },
  {
    key: "mistral",
    label: "Mistral",
    labelKey: "settings.aiPresetMistral",
    group: "global",
    baseUrl: "https://api.mistral.ai/v1",
    match: /api\.mistral\.ai/i,
    models: [
      { id: "mistral-large-latest", ctx: "128K" },
      { id: "codestral-latest" },
    ],
  },
  {
    key: "groq",
    label: "Groq",
    labelKey: "settings.aiPresetGroq",
    group: "global",
    baseUrl: "https://api.groq.com/openai/v1",
    match: /api\.groq\.com/i,
    models: [{ id: "llama-3.3-70b-versatile", ctx: "128K" }],
  },
  {
    key: "cerebras",
    label: "Cerebras",
    labelKey: "settings.aiPresetCerebras",
    group: "global",
    baseUrl: "https://api.cerebras.ai/v1",
    match: /api\.cerebras\.ai/i,
    models: [{ id: "llama-3.3-70b" }],
  },
  {
    key: "perplexity",
    label: "Perplexity",
    labelKey: "settings.aiPresetPerplexity",
    group: "global",
    baseUrl: "https://api.perplexity.ai",
    match: /api\.perplexity\.ai/i,
    models: [
      { id: "sonar", ctx: "128K" },
      { id: "sonar-pro", ctx: "200K" },
    ],
  },

  // ---------- 国内 ----------
  {
    key: "deepseek",
    label: "DeepSeek",
    labelKey: "settings.aiPresetDeepseek",
    group: "cn",
    baseUrl: "https://api.deepseek.com/v1",
    match: /deepseek\.com/i,
    models: [
      { id: "deepseek-chat", ctx: "128K" },
      { id: "deepseek-reasoner", ctx: "128K" },
    ],
  },
  {
    key: "dashscope",
    label: "DashScope",
    labelKey: "settings.aiPresetDashscope",
    group: "cn",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    match: /dashscope\.aliyuncs\.com/i,
    models: [
      { id: "qwen-plus", ctx: "128K" },
      { id: "qwen-max" },
      { id: "qwen-turbo" },
    ],
  },
  {
    key: "moonshot",
    label: "Moonshot",
    labelKey: "settings.aiPresetMoonshot",
    group: "cn",
    baseUrl: "https://api.moonshot.cn/v1",
    match: /moonshot\.(cn|ai)/i,
    models: [
      { id: "moonshot-v1-8k", ctx: "8K" },
      { id: "moonshot-v1-32k", ctx: "32K" },
      { id: "moonshot-v1-128k", ctx: "128K" },
    ],
  },
  {
    key: "zhipu",
    label: "Zhipu GLM",
    labelKey: "settings.aiPresetZhipu",
    group: "cn",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    match: /bigmodel\.cn/i,
    models: [
      { id: "glm-4-plus", ctx: "128K" },
      { id: "glm-4-flash", ctx: "128K" },
    ],
  },
  {
    key: "siliconflow",
    label: "SiliconFlow",
    labelKey: "settings.aiPresetSiliconflow",
    group: "cn",
    baseUrl: "https://api.siliconflow.cn/v1",
    match: /siliconflow\.(cn|com)/i,
    models: [{ id: "Qwen/Qwen2.5-7B-Instruct" }, { id: "deepseek-ai/DeepSeek-V3" }],
  },
  {
    key: "volcengine",
    label: "Volcengine Ark",
    labelKey: "settings.aiPresetVolcengine",
    group: "cn",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    match: /volces\.com/i,
    models: [{ id: "doubao-1-5-pro-32k-250115", ctx: "32K" }],
  },
  {
    key: "hunyuan",
    label: "Tencent Hunyuan",
    labelKey: "settings.aiPresetHunyuan",
    group: "cn",
    baseUrl: "https://api.hunyuan.cloud.tencent.com/v1",
    match: /hunyuan\.cloud\.tencent\.com/i,
    models: [{ id: "hunyuan-turbo" }],
  },
  {
    key: "spark",
    label: "iFlytek Spark",
    labelKey: "settings.aiPresetSpark",
    group: "cn",
    baseUrl: "https://spark-api-open.xf-yun.com/v1",
    match: /spark-api-open\.xf-yun\.com/i,
    models: [{ id: "generalv3.5" }],
  },
  {
    key: "yi",
    label: "01.AI Yi",
    labelKey: "settings.aiPresetYi",
    group: "cn",
    baseUrl: "https://api.lingyiwanwu.com/v1",
    match: /lingyiwanwu\.com/i,
    models: [{ id: "yi-lightning" }],
  },
  {
    key: "stepfun",
    label: "StepFun",
    labelKey: "settings.aiPresetStepfun",
    group: "cn",
    baseUrl: "https://api.stepfun.com/v1",
    match: /api\.stepfun\.com/i,
    models: [{ id: "step-2-16k", ctx: "16K" }],
  },
  {
    key: "modelscope",
    label: "ModelScope",
    labelKey: "settings.aiPresetModelscope",
    group: "cn",
    baseUrl: "https://api-inference.modelscope.cn/v1",
    match: /modelscope\.cn/i,
    models: [{ id: "Qwen/Qwen2.5-72B-Instruct" }],
  },
  {
    key: "qianfan",
    label: "Baidu Qianfan",
    labelKey: "settings.aiPresetQianfan",
    group: "cn",
    baseUrl: "https://qianfan.baidubce.com/v2",
    match: /qianfan\.baidubce\.com/i,
    models: [{ id: "ernie-4.0-turbo-8k", ctx: "8K" }],
  },
  {
    key: "baichuan",
    label: "Baichuan",
    labelKey: "settings.aiPresetBaichuan",
    group: "cn",
    baseUrl: "https://api.baichuan-ai.com/v1",
    match: /baichuan-ai\.com/i,
    models: [{ id: "Baichuan4" }],
  },

  // ---------- 聚合网关 ----------
  {
    key: "openrouter",
    label: "OpenRouter",
    labelKey: "settings.aiPresetOpenrouter",
    group: "gateway",
    baseUrl: "https://openrouter.ai/api/v1",
    match: /openrouter\.ai/i,
    models: [{ id: "openai/gpt-4o-mini", ctx: "128K" }],
  },
  {
    key: "together",
    label: "Together AI",
    labelKey: "settings.aiPresetTogether",
    group: "gateway",
    baseUrl: "https://api.together.xyz/v1",
    match: /api\.together\.xyz/i,
    models: [{ id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", ctx: "128K" }],
  },
  {
    key: "fireworks",
    label: "Fireworks",
    labelKey: "settings.aiPresetFireworks",
    group: "gateway",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    match: /api\.fireworks\.ai/i,
    models: [{ id: "accounts/fireworks/models/llama-v3p3-70b-instruct", ctx: "128K" }],
  },
  {
    key: "deepinfra",
    label: "DeepInfra",
    labelKey: "settings.aiPresetDeepinfra",
    group: "gateway",
    baseUrl: "https://api.deepinfra.com/v1/openai",
    match: /api\.deepinfra\.com/i,
    models: [{ id: "meta-llama/Llama-3.3-70B-Instruct", ctx: "128K" }],
  },
  {
    // OpenCode Zen / Go 订阅网关：Go 端点强制校验 x-opencode-session（缺失即 400），
    // 会话头已由本服务层与 Rust 代理自动补上，选预设后只需填 API Key 与模型名。
    key: "opencode",
    label: "OpenCode",
    labelKey: "settings.aiPresetOpencode",
    group: "gateway",
    baseUrl: "https://opencode.ai/zen/go/v1",
    match: /opencode\.ai/i,
    models: [{ id: "deepseek-v4.1-flash" }],
  },

  // ---------- 本地部署 ----------
  {
    // 本地 Ollama：Agent 首屏的零成本兜底，不需要第三方 key。
    // OpenAI 兼容端点接受任意非空密钥，而 isAIConfigured() 要求 apiKey 非空，故自带占位值。
    key: "ollama",
    label: "Ollama",
    labelKey: "settings.aiPresetOllama",
    group: "local",
    baseUrl: "http://localhost:11434/v1",
    match: /localhost:11434|127\.0\.0\.1:11434/i,
    apiKey: "ollama",
    models: [{ id: "qwen2.5:7b" }, { id: "llama3.1:8b" }],
  },
  {
    key: "lmstudio",
    label: "LM Studio",
    labelKey: "settings.aiPresetLmstudio",
    group: "local",
    baseUrl: "http://localhost:1234/v1",
    match: /localhost:1234|127\.0\.0\.1:1234/i,
    apiKey: "local",
    models: [{ id: "local-model" }],
  },
  {
    key: "vllm",
    label: "vLLM",
    labelKey: "settings.aiPresetVllm",
    group: "local",
    baseUrl: "http://localhost:8000/v1",
    match: /localhost:8000|127\.0\.0\.1:8000/i,
    apiKey: "local",
    models: [{ id: "local-model" }],
  },
  {
    key: "localai",
    label: "LocalAI",
    labelKey: "settings.aiPresetLocalai",
    group: "local",
    baseUrl: "http://localhost:8080/v1",
    match: /localhost:8080|127\.0\.0\.1:8080/i,
    apiKey: "local",
    models: [{ id: "local-model" }],
  },
]);

/** 厂商下拉的分组顺序与词条。 */
export const PROVIDER_GROUPS = Object.freeze([
  { key: "global", labelKey: "settings.aiProviderGroupGlobal" },
  { key: "cn", labelKey: "settings.aiProviderGroupCn" },
  { key: "gateway", labelKey: "settings.aiProviderGroupGateway" },
  { key: "local", labelKey: "settings.aiProviderGroupLocal" },
]);

/** 设置页/手机端预设：从同一份目录派生，避免设置页与对话弹层两套服务商。 */
export const AI_PRESETS = Object.freeze(
  PROVIDER_LIST.map((provider) => ({
    key: provider.key,
    labelKey: provider.labelKey,
    group: provider.group,
    baseUrl: provider.baseUrl,
    model: provider.models[0]?.id || "",
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
  }))
);

/** 推理档位：与设置页下拉的取值一一对应（少一项就会出现「这里选了、设置页不认」）。 */
export const EFFORT_OPTIONS = Object.freeze([
  { value: "", labelKey: "agent.effortDefault" },
  { value: "minimal", labelKey: "agent.effortMinimal" },
  { value: "low", labelKey: "agent.effortLow" },
  { value: "medium", labelKey: "agent.effortMedium" },
  { value: "high", labelKey: "agent.effortHigh" },
  { value: "xhigh", labelKey: "agent.effortXhigh" },
]);

const EFFORT_VALUES = new Set(EFFORT_OPTIONS.map((item) => item.value));

/** 认服务商：返回目录项或 null（自定义端点）。 */
export function providerFor(baseUrl) {
  const url = String(baseUrl ?? "").trim();
  if (!url) return null;
  return PROVIDER_LIST.find((provider) => provider.match.test(url)) || null;
}

/** 服务商显示名：认不出时给「自定义端点」，让人知道自己不在预设里。 */
export function providerLabel(baseUrl) {
  return providerFor(baseUrl)?.label || "自定义端点";
}

/** 当前端点的候选模型（永远不含「当前已配置但不在候选里」的模型，那个由调用方单独展示）。 */
export function modelsFor(baseUrl) {
  return (providerFor(baseUrl)?.models || []).map((model) => ({ ...model }));
}

/** 上下文窗口：认不出返回空串（界面据此不渲染徽标）。 */
export function contextWindowOf(baseUrl, model) {
  const id = String(model ?? "").trim();
  if (!id) return "";
  if (providerFor(baseUrl)?.key === "moonshot") {
    // Moonshot 的窗口写在模型名里：moonshot-v1-32k → 32K
    const match = /-(\d+)k$/i.exec(id);
    if (match) return `${match[1]}K`;
  }
  return modelsFor(baseUrl).find((item) => item.id === id)?.ctx || "";
}

/** 归一化档位：非法值按默认档处理（下拉里没有的 value 不该被带进请求体）。 */
export function normalizeEffort(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  return EFFORT_VALUES.has(raw) ? raw : "";
}

/** 档位 → 词条键；未知值按默认档。 */
export function effortLabelKey(value) {
  const effort = normalizeEffort(value);
  return EFFORT_OPTIONS.find((item) => item.value === effort)?.labelKey || "agent.effortDefault";
}

/** 档位是否短到能塞进胶囊（空档不显示，其余显示词条本身）。 */
export function effortBadgeKey(value) {
  return normalizeEffort(value) ? effortLabelKey(value) : "";
}
