// ComfyUI 集成的纯逻辑：地址归一、内置文生图图构造、自定义工作流解析与注入、
// 历史输出分类、WS 消息解析、取消决策。与视图解耦（不 import Vue/Tauri），node 环境可直接单测。

export const DEFAULT_COMFY_BASE = "http://127.0.0.1:8188";

export const SAMPLER_OPTIONS = [
  "euler",
  "euler_ancestral",
  "dpmpp_2m",
  "dpmpp_2m_sde",
  "dpmpp_3m_sde",
  "ddim",
  "uni_pc",
  "lcm",
];
export const SCHEDULER_OPTIONS = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"];

const VIDEO_EXTS = new Set(["mp4", "webm", "mov"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp"]);

/** ComfyUI 地址归一：留空回默认，缺协议补 http://，去尾斜杠。 */
export function normalizeComfyBase(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return DEFAULT_COMFY_BASE;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  return withScheme.replace(/\/+$/, "");
}

/** http(s) 地址 → ws(s) 地址（ComfyUI /ws 需要 ws:// 协议）。 */
export function wsUrl(base) {
  return `${normalizeComfyBase(base).replace(/^http/i, "ws")}/ws`;
}

export function newClientId() {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    /* 环境不支持则退随机串 */
  }
  return `tc-${Date.now().toString(36)}-${Math.floor(Math.random() * 36 ** 6).toString(36)}`;
}

function deepClone(value) {
  try {
    if (typeof structuredClone === "function") return structuredClone(value);
  } catch {
    /* 含不可克隆值时退回 JSON 路径 */
  }
  return JSON.parse(JSON.stringify(value));
}

/**
 * 内置文生图：标准 7 节点 API 图（CheckpointLoaderSimple → 正/负 CLIPTextEncode →
 * EmptyLatentImage → KSampler → VAEDecode → SaveImage）。节点 id 固定，便于 e2e 断言。
 */
export function buildTxt2ImgWorkflow({
  checkpoint,
  positive = "",
  negative = "",
  width = 1024,
  height = 1024,
  steps = 20,
  cfg = 7,
  seed = 0,
  samplerName = "euler",
  scheduler = "normal",
  denoise = 1,
  batchSize = 1,
  filenamePrefix = "ToolCove",
} = {}) {
  return {
    "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: String(checkpoint ?? "") } },
    "6": { class_type: "CLIPTextEncode", inputs: { text: String(positive ?? ""), clip: ["4", 1] } },
    "7": { class_type: "CLIPTextEncode", inputs: { text: String(negative ?? ""), clip: ["4", 1] } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: { width: Math.trunc(width) || 1024, height: Math.trunc(height) || 1024, batch_size: Math.max(1, Math.trunc(batchSize) || 1) },
    },
    "3": {
      class_type: "KSampler",
      inputs: {
        seed: Math.max(0, Math.trunc(Number(seed) || 0)),
        steps: Math.max(1, Math.trunc(Number(steps) || 20)),
        cfg: Number(cfg) || 7,
        sampler_name: String(samplerName || "euler"),
        scheduler: String(scheduler || "normal"),
        denoise: Number.isFinite(Number(denoise)) ? Number(denoise) : 1,
        model: ["4", 0],
        positive: ["6", 0],
        negative: ["7", 0],
        latent_image: ["5", 0],
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["3", 0], vae: ["4", 2] } },
    "9": { class_type: "SaveImage", inputs: { filename_prefix: String(filenamePrefix || "ToolCove"), images: ["8", 0] } },
  };
}

/**
 * 分体式模型（UNET + CLIP + VAE 分开加载）的文生图工作流。
 * 这是 ComfyUI 里「直接可用」的等价写法：CONF 里的单模型 checkpoint 只是其中一种打包方式，
 * 用 Qwen-Image 这类分体模型时 ComfyUI 自己也是这么连的。
 * encoder：qwen 时用 TextEncodeQwenImage21（一个节点出 positive/negative 两路），
 * 否则退回标准 CLIPTextEncode 两个节点。
 */
export function buildSplitTxt2ImgWorkflow({
  unet = "",
  clip = "",
  vae = "",
  clipType = "qwen_image",
  encoder = "qwen",
  positive = "",
  negative = "",
  width = 1024,
  height = 1024,
  steps = 20,
  cfg = 7,
  seed = 0,
  samplerName = "euler",
  scheduler = "normal",
  denoise = 1,
  batchSize = 1,
  filenamePrefix = "ToolCove",
} = {}) {
  const unetName = String(unet ?? "");
  const isGguf = /\.gguf$/i.test(unetName);
  const graph = {
    "1": {
      class_type: isGguf ? "UnetLoaderGGUF" : "UNETLoader",
      inputs: isGguf
        ? { unet_name: unetName }
        : { unet_name: unetName, weight_dtype: "default" },
    },
    "2": { class_type: "CLIPLoader", inputs: { clip_name: String(clip ?? ""), type: String(clipType || "qwen_image") } },
    "3": { class_type: "VAELoader", inputs: { vae_name: String(vae ?? "") } },
    "5": {
      class_type: "EmptyLatentImage",
      inputs: {
        width: Math.trunc(width) || 1024,
        height: Math.trunc(height) || 1024,
        batch_size: Math.max(1, Math.trunc(batchSize) || 1),
      },
    },
  };
  const sampler = {
    seed: Math.max(0, Math.trunc(Number(seed) || 0)),
    steps: Math.max(1, Math.trunc(Number(steps) || 20)),
    cfg: Number(cfg) || 7,
    sampler_name: String(samplerName || "euler"),
    scheduler: String(scheduler || "normal"),
    denoise: Number.isFinite(Number(denoise)) ? Number(denoise) : 1,
    model: ["1", 0],
    latent_image: ["5", 0],
  };
  if (encoder === "qwen") {
    graph["4"] = {
      class_type: "TextEncodeQwenImage21",
      inputs: {
        clip: ["2", 0],
        prompt: String(positive ?? ""),
        negative_prompt: String(negative ?? ""),
        resolution: Math.max(Math.trunc(width) || 1024, Math.trunc(height) || 1024),
      },
    };
    sampler.positive = ["4", 0];
    sampler.negative = ["4", 1];
  } else {
    graph["4"] = { class_type: "CLIPTextEncode", inputs: { text: String(positive ?? ""), clip: ["2", 0] } };
    graph["6"] = { class_type: "CLIPTextEncode", inputs: { text: String(negative ?? ""), clip: ["2", 0] } };
    sampler.positive = ["4", 0];
    sampler.negative = ["6", 0];
  }
  graph["7"] = { class_type: "KSampler", inputs: sampler };
  graph["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  graph["9"] = { class_type: "SaveImage", inputs: { filename_prefix: String(filenamePrefix || "ToolCove"), images: ["8", 0] } };
  return graph;
}

function comboList(node, key) {
  const spec = node?.input?.required?.[key] ?? node?.input?.optional?.[key];
  const list = Array.isArray(spec) ? spec[0] : null;
  if (!Array.isArray(list)) return [];
  return list.filter((name) => typeof name === "string" && name.trim());
}

// 各类模型对应的加载节点与输入键：ComfyUI 没有统一的"模型列表"接口，
// 只能从 /object_info 里按 loader 节点的 combo 取值反推本机实际可用的模型。
const MODEL_SOURCES = [
  { kind: "checkpoints", classType: "CheckpointLoaderSimple", input: "ckpt_name" },
  { kind: "diffusionModels", classType: "UNETLoader", input: "unet_name" },
  { kind: "diffusionModels", classType: "UnetLoaderGGUF", input: "unet_name" },
  { kind: "textEncoders", classType: "CLIPLoader", input: "clip_name" },
  { kind: "vaes", classType: "VAELoader", input: "vae_name" },
  { kind: "loras", classType: "LoraLoader", input: "lora_name" },
  { kind: "loras", classType: "LoraLoaderModelOnly", input: "lora_name" },
];

/**
 * 扫本机全部模型：checkpoints / diffusionModels / textEncoders / vaes / loras。
 * 同 kind 多来源（UNETLoader 与 UnetLoaderGGUF）合并去重；未装对应节点则为空数组。
 */
export function extractModels(objectInfo) {
  const models = { checkpoints: [], diffusionModels: [], textEncoders: [], vaes: [], loras: [] };
  for (const source of MODEL_SOURCES) {
    const list = comboList(objectInfo?.[source.classType], source.input);
    for (const name of list) {
      if (!models[source.kind].includes(name)) models[source.kind].push(name);
    }
  }
  return models;
}

/** CLIPLoader 支持的 type 取值（qwen_image / stable_diffusion / wan …）。 */
export function extractClipTypes(objectInfo) {
  return comboList(objectInfo?.CLIPLoader, "type");
}

// 其他模型家族的标记词：同目录下常混装多套模型，选型时必须排除，否则会拿 minimax 的
// 32B 编码器去配 qwen 的 UNET（hidden 5120 vs 4096，运行时直接炸）。
const FOREIGN_FAMILIES = ["minimax", "h3", "wan", "hunyuan", "flux", "sd3", "sdxl", "ltxv", "cosmos", "mochi", "audio", "video", "pixel_space"];
// 量化/精度后缀：不参与"家族"判断，但原生精度稍微加分。
const QUANT_TOKENS = ["int8", "int4", "convrot", "gguf", "q8_0", "q6_k", "q5_k", "q4_k", "awq", "nvfp4", "fp8", "fp16", "bf16", "uc", "pruned"];

function familyTokens(name) {
  return String(name ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && /[a-z]/.test(token) && !QUANT_TOKENS.includes(token));
}

/**
 * 从同目录的模型列表里挑一个与基准模型同家族的：
 * 共享家族词加分、命中其他家族词重扣分、原生精度优先。current 仍然可用时保持不动。
 */
export function pickModelName(list, { current = "", family = "" } = {}) {
  const names = (Array.isArray(list) ? list : []).filter((name) => typeof name === "string" && name.trim());
  if (!names.length) return "";
  if (current && names.includes(current)) return current;
  const wanted = familyTokens(family);
  let best = names[0];
  let bestScore = -Infinity;
  for (const name of names) {
    const lower = name.toLowerCase();
    let score = 0;
    for (const token of wanted) if (lower.includes(token)) score += 2;
    for (const token of FOREIGN_FAMILIES) if (lower.includes(token)) score -= 3;
    if (/bf16|fp16/.test(lower)) score += 1;
    if (score > bestScore) {
      best = name;
      bestScore = score;
    }
  }
  return best;
}

export function modelCount(models) {
  return Object.values(models || {}).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
}

const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN"]);
const SEED_CONTROL = new Set(["fixed", "increment", "decrement", "randomize"]);

/** object_info 里该输入是不是前端组件（而不是连线槽）。 */
function isWidgetSpec(spec) {
  if (!Array.isArray(spec) || !spec.length) return false;
  if (Array.isArray(spec[0])) return true; // 老格式 combo：[[可选值...], 元信息]
  if (spec[0] === "COMBO") return true;
  if (!WIDGET_TYPES.has(spec[0])) return false;
  return spec[1]?.forceInput !== true;
}

/** 该节点在 object_info 里的 widget 输入名顺序（连线类型会被剔除）。 */
function widgetInputNames(classType, objectInfo) {
  const info = objectInfo?.[classType];
  if (!info) return [];
  const spec = info.input ?? {};
  const names = [];
  for (const group of ["required", "optional"]) {
    const order = info.input_order?.[group] ?? Object.keys(spec[group] ?? {});
    for (const name of order) {
      const item = spec[group]?.[name];
      if (isWidgetSpec(item)) names.push(name);
    }
  }
  return names;
}

/**
 * 补齐工作流里缺失的、有默认值的 widget 输入。
 * 界面格式转换会丢掉节点上不存在的 widget（如 SaveImage 的 filename_prefix），
 * 缺必填输入会让 ComfyUI 直接 400；有 object_info 时用默认值兜底。
 */
export function fillMissingDefaults(workflow, objectInfo) {
  const graph = deepClone(workflow ?? {});
  const filled = [];
  for (const [id, node] of Object.entries(graph)) {
    const info = objectInfo?.[node?.class_type];
    if (!info) continue;
    node.inputs = node.inputs ?? {};
    for (const group of ["required", "optional"]) {
      const spec = info.input?.[group] ?? {};
      for (const [name, item] of Object.entries(spec)) {
        if (name in node.inputs || !isWidgetSpec(item)) continue;
        const fallback = item?.[1]?.default;
        if (fallback === undefined) continue;
        node.inputs[name] = fallback;
        filled.push(`${id}.${name}`);
      }
    }
  }
  return { workflow: graph, filled };
}

/**
 * 界面格式（ComfyUI「保存」默认产物，含 nodes/links）→ API 格式。
 * 优先用 widgets_values_named（新版前端会写出输入名）；没有时按 object_info 的
 * widget 输入顺序对齐 widgets_values（含 control_after_generate 这种纯前端值）；
 * 都拿不到时退回节点自带的 widget 标记。links 形如
 * [linkId, originId, originSlot, targetId, targetSlot, type]。
 * 无法识别时返回 null，由调用方报原有的界面格式错误。
 */
export function uiToApiWorkflow(data, objectInfo = null) {
  if (!data || !Array.isArray(data.nodes) || !Array.isArray(data.links)) return null;
  const linkMap = new Map();
  for (const link of data.links) {
    if (!Array.isArray(link) || link.length < 3) continue;
    linkMap.set(link[0], [String(link[1]), Number(link[2]) || 0]);
  }
  const out = {};
  for (const node of data.nodes) {
    if (!node || typeof node.type !== "string" || node.id == null) continue;
    const inputs = {};
    const values = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    if (node.widgets_values_named && typeof node.widgets_values_named === "object") {
      Object.assign(inputs, node.widgets_values_named);
    } else if (objectInfo && widgetInputNames(node.type, objectInfo).length) {
      const names = widgetInputNames(node.type, objectInfo);
      const hasControl = names.includes("control_after_generate");
      let index = 0;
      for (const name of names) {
        if (index >= values.length) break;
        inputs[name] = values[index];
        index += 1;
        // KSampler 的 seed 后面跟一个纯前端值（fixed/randomize…），不属于任何输入。
        if (!hasControl && /seed/i.test(name) && SEED_CONTROL.has(values[index])) index += 1;
      }
    } else if (Array.isArray(node.inputs)) {
      const widgetInputs = node.inputs.filter((input) => input && input.widget && typeof input.name === "string");
      widgetInputs.forEach((input, index) => {
        if (values[index] !== undefined) inputs[input.name] = values[index];
      });
    }
    for (const input of Array.isArray(node.inputs) ? node.inputs : []) {
      if (!input || typeof input.name !== "string" || input.link == null) continue;
      const origin = linkMap.get(input.link);
      if (origin) inputs[input.name] = origin;
    }
    out[String(node.id)] = {
      class_type: node.type,
      inputs,
      ...(typeof node.title === "string" && node.title.trim() ? { _meta: { title: node.title.trim() } } : {}),
    };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 解析导入的自定义工作流（必须是 API 格式：每个值有 class_type + inputs）。
 * 界面格式（带 nodes/links 数组）明确报错——两者混用时改动会被 ComfyUI 静默丢弃。
 * 同时给出自动映射建议：Sampler 节点的 positive/negative 链接反查文本节点，
 * 参数节点 = 该 Sampler，latent 节点 = 带 width+height 的节点。
 */
export function parseWorkflowGraph(source) {
  let data = source;
  if (typeof source === "string") {
    if (!source.trim()) return { ok: false, error: "empty", workflow: null, nodes: [], suggestion: null };
    try {
      data = JSON.parse(source);
    } catch (error) {
      return { ok: false, error: "badJson", workflow: null, nodes: [], suggestion: null, detail: String(error?.message ?? error) };
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, error: "badShape", workflow: null, nodes: [], suggestion: null };
  }
  if (Array.isArray(data.nodes) && Array.isArray(data.links)) {
    return { ok: false, error: "uiFormat", workflow: null, nodes: [], suggestion: null };
  }
  const entries = Object.entries(data);
  if (!entries.length) return { ok: false, error: "badShape", workflow: null, nodes: [], suggestion: null };
  const nodes = [];
  for (const [id, node] of entries) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      return { ok: false, error: "badShape", workflow: null, nodes: [], suggestion: null };
    }
    if (typeof node.class_type !== "string" || !node.inputs || typeof node.inputs !== "object") {
      return { ok: false, error: "badShape", workflow: null, nodes: [], suggestion: null };
    }
    const textKey = Object.entries(node.inputs).find(([, value]) => typeof value === "string")?.[0] ?? "";
    nodes.push({
      id,
      classType: node.class_type,
      title: typeof node._meta?.title === "string" ? node._meta.title : "",
      inputKeys: Object.keys(node.inputs),
      textKey,
      raw: node,
    });
  }
  return { ok: true, error: "", workflow: data, nodes, suggestion: suggestMapping(nodes) };
}

/**
 * 文本节点上该写哪个输入：正向取 prompt / positive / 第一个非负向字符串输入；
 * 负向优先 negative_prompt（如 TextEncodeQwenImage21 一个节点同时带正负两路）。
 */
export function textInputFor(node, side = "positive") {
  const keys = Object.entries(node?.raw?.inputs ?? {})
    .filter(([, value]) => typeof value === "string")
    .map(([key]) => key);
  if (!keys.length) return "";
  const negativeKey = keys.find((key) => /negative/i.test(key));
  if (side === "negative" && negativeKey) return negativeKey;
  return keys.find((key) => key === "prompt") ?? keys.find((key) => /positive/i.test(key)) ?? keys.find((key) => key !== negativeKey) ?? keys[0];
}

function linkTarget(nodes, link, side) {
  if (!Array.isArray(link)) return null;
  const node = nodes.find((item) => item.id === String(link[0]));
  if (!node) return null;
  const input = textInputFor(node, side);
  return input ? { node: node.id, input } : null;
}

function suggestMapping(nodes) {
  const sampler = nodes.find((item) => /sampler/i.test(item.classType));
  const latent =
    nodes.find((item) => /latent/i.test(item.classType) && item.inputKeys.includes("width") && item.inputKeys.includes("height")) ||
    nodes.find((item) => item.inputKeys.includes("width") && item.inputKeys.includes("height"));
  return {
    positive: sampler ? linkTarget(nodes, sampler.raw.inputs.positive, "positive") : null,
    negative: sampler ? linkTarget(nodes, sampler.raw.inputs.negative, "negative") : null,
    params: sampler ? { node: sampler.id } : null,
    latent: latent ? { node: latent.id } : null,
  };
}

/**
 * 把提示词/参数注入工作流（深拷贝，原对象零改动）。只写节点**已存在**的输入键，
 * 不存在一律跳过并记入 skipped——自定义节点（如 noise_seed）不能被硬塞种子打坏。
 * positive 必注入；negative 仅非空时注入（不覆盖工作流自带负向）；
 * seed 仅在映射了参数节点时注入（随机/固定由调用方决定值）；其余采样参数与宽高在
 * overrideParams 打开时才写（默认不覆盖用户工作流自己的参数）。
 */
export function injectMapping(workflow, mapping, values = {}, { overrideParams = false } = {}) {
  const graph = deepClone(workflow || {});
  const skipped = [];
  const setInput = (entry, key, value) => {
    if (!entry?.node) return false;
    const node = graph[entry.node];
    if (!node || typeof node !== "object" || !node.inputs || typeof node.inputs !== "object") {
      skipped.push(key);
      return false;
    }
    const inputName = entry.input || "text";
    if (typeof node.inputs[inputName] !== "string") {
      skipped.push(key);
      return false;
    }
    node.inputs[inputName] = String(value ?? "");
    return true;
  };
  setInput(mapping?.positive, "positive", values.positive);
  // 正负映射到同一节点同一输入时（单文本节点一个 text 输入），写负向会把正向覆盖掉，只能跳过。
  const sameTarget =
    mapping?.positive?.node &&
    mapping?.negative?.node === mapping.positive.node &&
    (mapping.negative.input || "text") === (mapping.positive.input || "text");
  if (String(values.negative ?? "").trim()) {
    if (sameTarget) skipped.push("negative");
    else setInput(mapping?.negative, "negative", values.negative);
  }

  const paramsNode = mapping?.params?.node ? graph[mapping.params.node] : null;
  const paramsInputs = paramsNode && typeof paramsNode === "object" ? paramsNode.inputs : null;
  const writeParam = (key, value) => {
    if (!paramsInputs || !(key in paramsInputs)) {
      skipped.push(key);
      return;
    }
    paramsInputs[key] = value;
  };
  if (paramsInputs && values.seed != null) writeParam("seed", Math.max(0, Math.trunc(Number(values.seed) || 0)));
  if (overrideParams && paramsInputs) {
    if (values.steps != null) writeParam("steps", Math.max(1, Math.trunc(Number(values.steps) || 20)));
    if (values.cfg != null) writeParam("cfg", Number(values.cfg) || 7);
    if (values.denoise != null) writeParam("denoise", Number(values.denoise));
    if (values.samplerName) writeParam("sampler_name", String(values.samplerName));
    if (values.scheduler) writeParam("scheduler", String(values.scheduler));
  }
  if (overrideParams && mapping?.latent?.node) {
    const latent = graph[mapping.latent.node];
    if (latent?.inputs && typeof latent.inputs === "object") {
      if ("width" in latent.inputs && values.width != null) latent.inputs.width = Math.trunc(Number(values.width) || 1024);
      if ("height" in latent.inputs && values.height != null) latent.inputs.height = Math.trunc(Number(values.height) || 1024);
    }
  }
  return { workflow: graph, skipped };
}

function extOf(filename) {
  const match = String(filename ?? "").toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  return match ? match[1] : "";
}

/**
 * 扫 /history 条目里全部节点的输出，按扩展名分类成 image/video。
 * 不假设输出键名：核心 SaveImage 在 images 键、VHS_VideoCombine 把 mp4 放 gifs 键，扫全量最稳。
 */
export function classifyHistoryOutputs(entry) {
  const files = [];
  const seen = new Set();
  const outputs = entry?.outputs && typeof entry.outputs === "object" ? entry.outputs : {};
  for (const nodeOutput of Object.values(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== "object") continue;
    for (const value of Object.values(nodeOutput)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (!item || typeof item !== "object" || typeof item.filename !== "string" || !item.filename) continue;
        const ext = extOf(item.filename);
        const kind = VIDEO_EXTS.has(ext) ? "video" : IMAGE_EXTS.has(ext) ? "image" : "";
        if (!kind) continue;
        const subfolder = String(item.subfolder ?? "");
        const type = String(item.type ?? "output");
        const key = `${type}/${subfolder}/${item.filename}`;
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({ filename: item.filename, subfolder, type, kind });
      }
    }
  }
  return files;
}

/** /view 取文件 URL（filename/subfolder/type 三元组是 ComfyUI 的定位方式）。 */
export function viewUrl(base, file) {
  const query = new URLSearchParams({
    filename: String(file?.filename ?? ""),
    subfolder: String(file?.subfolder ?? ""),
    type: String(file?.type ?? "output"),
  });
  return `${normalizeComfyBase(base)}/view?${query.toString()}`;
}

/** /history 条目是否失败，以及失败信息（status.messages 里抽 exception_message）。 */
export function historyErrorText(entry) {
  const status = entry?.status;
  if (!status || status.status_str !== "error") return "";
  const messages = Array.isArray(status.messages) ? status.messages : [];
  const parts = [];
  for (const item of messages) {
    const message = Array.isArray(item) ? item[1] : item;
    if (message && typeof message === "object" && message.exception_message) parts.push(String(message.exception_message));
  }
  return parts.join("；");
}

/** /queue 响应 → 该 prompt 的取消方式：interrupt（运行中）/ delete（排队中）/ gone（已不在队列）。 */
export function decideCancel(queue, promptId) {
  const has = (list) =>
    Array.isArray(list) && list.some((item) => Array.isArray(item) && String(item[1]) === String(promptId));
  if (has(queue?.queue_running)) return "interrupt";
  if (has(queue?.queue_pending)) return "delete";
  return "gone";
}

/** /queue 响应 → 排队中任务数（用于「排队中 N 个」提示）。 */
export function queuePendingCount(queue) {
  return Array.isArray(queue?.queue_pending) ? queue.queue_pending.length : 0;
}

/** ComfyUI /ws 消息归一。非 JSON / 二进制帧 / 未知类型一律 null（调用方忽略）。 */
export function parseComfyWsMessage(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object" || typeof data.type !== "string") return null;
  const payload = data.data && typeof data.data === "object" ? data.data : {};
  switch (data.type) {
    case "progress":
      return { type: "progress", promptId: String(payload.prompt_id ?? ""), node: payload.node ?? null, value: Number(payload.value) || 0, max: Number(payload.max) || 0 };
    case "executing":
      return { type: "executing", promptId: String(payload.prompt_id ?? ""), node: payload.node ?? null };
    case "execution_success":
      return { type: "success", promptId: String(payload.prompt_id ?? "") };
    case "execution_error":
      return { type: "error", promptId: String(payload.prompt_id ?? ""), message: String(payload.exception_message ?? "") };
    case "execution_cached":
      return { type: "cached", promptId: String(payload.prompt_id ?? "") };
    case "executed":
      return { type: "executed", promptId: String(payload.prompt_id ?? ""), node: payload.node ?? null };
    case "status":
      return { type: "status", queueRemaining: Number(payload?.status?.exec_info?.queue_remaining) || 0 };
    default:
      return null;
  }
}

/** /prompt 的 node_errors → 可读列表（节点 #id (class)：信息）。 */
export function summarizeNodeErrors(nodeErrors) {
  const out = [];
  if (!nodeErrors || typeof nodeErrors !== "object") return out;
  for (const [node, info] of Object.entries(nodeErrors)) {
    const classType = String(info?.class_type ?? "");
    const list = Array.isArray(info?.errors) ? info.errors : [];
    if (!list.length) {
      out.push({ node, classType, message: "" });
      continue;
    }
    for (const error of list) {
      out.push({ node, classType, message: String(error?.message ?? error?.type ?? "") });
    }
  }
  return out;
}
