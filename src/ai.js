// AI 模型前端服务层
// 桌面端经 Rust 命令 ai_chat/ai_chat_stream 透传到 OpenAI 兼容的 /chat/completions（规避浏览器 CORS）；
// 浏览器端直连同一端点（要求该端点允许 CORS）。
// 配置存放在 settings.ai：{ baseUrl, apiKey, model, temperature, enabled }
import { invoke, createChannel } from "./platform/invoke.js";
import { isDesktop } from "./platform/env.js";
import { decryptValue } from "./secure.js";
import { parsePartialJson } from "./streamJson.js";
import { throttleFlush } from "./throttle.js";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

// 常见服务商预设（baseUrl 已含 /v1 等版本段，直接拼 /chat/completions）
export const AI_PRESETS = [
  { key: "openai", labelKey: "settings.aiPresetOpenai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { key: "deepseek", labelKey: "settings.aiPresetDeepseek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { key: "moonshot", labelKey: "settings.aiPresetMoonshot", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { key: "dashscope", labelKey: "settings.aiPresetDashscope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { key: "siliconflow", labelKey: "settings.aiPresetSiliconflow", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
  // 本地 Ollama：Agent 首屏的零成本兜底，不需要第三方 key。
  // Ollama 的 OpenAI 兼容端点接受任意非空密钥，而 isAIConfigured() 要求 apiKey 非空，故自带占位值。
  { key: "ollama", labelKey: "settings.aiPresetOllama", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", apiKey: "ollama" },
];

// 读取 settings.ai 配置
export async function loadAIConfig() {
  let s = {};
  try {
    s = (await invoke("load_data", { key: "settings" })) || {};
  } catch (e) {
    s = {};
  }
  const a = s.ai || {};
  return {
    baseUrl: (a.baseUrl || "").trim().replace(/\/$/, ""),
    apiKey: (await decryptValue(a.apiKey || "")).trim(),
    model: (a.model || "").trim(),
    temperature: typeof a.temperature === "number" ? a.temperature : 0.7,
    reasoningEffort: (a.reasoningEffort || "").trim(),
    enabled: !!a.enabled,
  };
}

// 是否已完成基本配置（地址 + 密钥 + 模型）
export async function isAIConfigured() {
  const c = await loadAIConfig();
  return !!(c.baseUrl && c.apiKey && c.model);
}

// 组装请求参数：校验配置 + 推理档位/温度二选一（两端实现共用，保证行为一致）
async function buildRequestArgs(messages, opts) {
  const cfg = opts.config || (await loadAIConfig());
  if (!cfg.baseUrl) throw new Error(t("toolbox.ai.errNoBaseUrl"));
  if (!cfg.apiKey) throw new Error(t("toolbox.ai.errNoApiKey"));
  if (!cfg.model) throw new Error(t("toolbox.ai.errNoModel"));

  // 推理档位：优先取 opts，其次配置。设了推理档位就不再传 temperature（推理模型只接受默认温度）。
  const reasoningEffort = (opts.reasoningEffort ?? cfg.reasoningEffort ?? "").trim();
  const args = {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: opts.model || cfg.model,
    messages,
  };
  if (reasoningEffort) {
    args.reasoningEffort = reasoningEffort;
  } else {
    args.temperature = typeof opts.temperature === "number" ? opts.temperature : cfg.temperature;
  }
  return args;
}

// ---------- 浏览器直连实现（桌面端由 Rust 代理，见 ai.rs）----------
// 请求体与错误文案与 Rust 侧逐字对齐，保证两端行为一致。
function buildBrowserBody(args, stream) {
  const body = { model: args.model, messages: args.messages };
  if (stream) body.stream = true;
  if (typeof args.temperature === "number") body.temperature = args.temperature;
  const effort = String(args.reasoningEffort || "").trim();
  if (effort) body.reasoning_effort = effort;
  return body;
}

async function browserFetchCompletion(args, body, signal) {
  const response = await fetch(`${String(args.baseUrl).trim().replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${String(args.apiKey).trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = (parsed && parsed.error && parsed.error.message) || text;
    } catch {
      /* 非 JSON 错误体：保留原文 */
    }
    throw new Error(`HTTP ${response.status}：${message}`);
  }
  return response;
}

async function browserChat(args) {
  const response = await browserFetchCompletion(args, buildBrowserBody(args, false));
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // 与 Rust 一致：非 JSON 响应交给 extractContent 报 errNonJson
    return { raw: text };
  }
}

/** 解析一行 SSE（`data: ` 前缀），返回增量文本；空行/[DONE]/非 JSON/无 content 返回 null。 */
export function parseSseLine(line) {
  const raw = String(line ?? "").trimEnd();
  if (!raw.startsWith("data:")) return null;
  const data = raw.slice(5).trim();
  if (!data || data === "[DONE]") return null;
  try {
    const content = JSON.parse(data)?.choices?.[0]?.delta?.content;
    return typeof content === "string" && content ? content : null;
  } catch {
    return null;
  }
}

// 浏览器流式：fetch + ReadableStream 逐行解析 SSE；stop() abort 请求
// （与桌面端关闭 Channel 的语义一致：主动停止后不再回调 onDelta/onDone/onError）。
function browserChatStream(args, handlers) {
  const controller = new AbortController();
  (async () => {
    try {
      const response = await browserFetchCompletion(args, buildBrowserBody(args, true), controller.signal);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          const delta = parseSseLine(line);
          if (delta !== null) handlers.onDelta?.(delta);
        }
      }
      handlers.onDone?.();
    } catch (error) {
      if (controller.signal.aborted) return;
      handlers.onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  })();
  return { stop: () => controller.abort() };
}

// 核心：发起一次对话补全。messages 为 [{role, content}] 数组。
// 返回助手回复的纯文本；出错时 throw Error(message)。
// opts：{ model, temperature, config, onUsage }（config 可传入临时配置，用于「测试连接」时先于保存生效；
//       onUsage(usage) 收到本次调用的 token 用量，仅在服务端返回 usage 时触发）
export async function aiChat(messages, opts = {}) {
  const args = await buildRequestArgs(messages, opts);
  const raw = isDesktop ? await invoke("ai_chat", args) : await browserChat(args);
  if (typeof opts.onUsage === "function") {
    const usage = extractUsage(raw);
    if (usage) {
      try {
        opts.onUsage(usage);
      } catch {
        /* 计量回调异常不影响主流程 */
      }
    }
  }
  return extractContent(raw);
}

// 便捷：单轮提问。system 可选系统提示词。
export async function aiComplete(prompt, opts = {}) {
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  return aiChat(messages, opts);
}

// 流式对话：SSE 增量实时推给 onDelta；结束触发 onDone；出错触发 onError(err)。
// 桌面端经 Channel 推送（stop() 关闭 Channel，后端感知发送失败即中止生成）；
// 浏览器端走 fetch 流（stop() abort 请求）。两端 stop 语义一致：停止后不再有任何回调。
// 未配置时配置错误也走 onError（不 throw），保证调用方统一走回调分支。
export function aiChatStream(messages, opts = {}, handlers = {}) {
  let stop = () => {};
  (async () => {
    try {
      const args = await buildRequestArgs(messages, opts);
      if (!isDesktop) {
        stop = browserChatStream(args, handlers).stop;
        return;
      }
      const channel = createChannel();
      stop = () => {
        try {
          channel.close();
        } catch {
          /* 忽略 */
        }
      };
      channel.onmessage = (payload) => {
        try {
          if (payload && typeof payload.delta === "string") {
            handlers.onDelta?.(payload.delta);
          } else if (payload && payload.done) {
            handlers.onDone?.();
          } else if (payload && payload.error) {
            handlers.onError?.(new Error(String(payload.error)));
          }
        } catch (e) {
          /* 回调异常不中断流 */
        }
      };
      await invoke("ai_chat_stream", { ...args, channel });
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return { stop: () => stop() };
}

// 从 OpenAI 兼容响应里取出 token 用量；缺失或非法返回 null。
// 只有非流式路径带 usage —— 流式要在请求体加 stream_options.include_usage 并从 SSE 里另取一帧。
export function extractUsage(raw) {
  const u = raw && raw.usage;
  if (!u || typeof u !== "object" || Array.isArray(u)) return null;
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.trunc(Number(v)) : 0);
  const promptTokens = n(u.prompt_tokens);
  const completionTokens = n(u.completion_tokens);
  return { promptTokens, completionTokens, totalTokens: n(u.total_tokens) || promptTokens + completionTokens };
}

// 从 OpenAI 兼容响应里取出文本内容
function extractContent(raw) {
  const choice = raw && raw.choices && raw.choices[0];
  const msg = choice && choice.message;
  const content = msg && msg.content;
  if (typeof content === "string") return content.trim();
  // 兼容部分服务把 content 拆成数组片段
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === "string" ? c : c.text || "")).join("").trim();
  }
  if (raw && raw.raw) throw new Error(t("toolbox.ai.errNonJson", { raw: raw.raw }));
  throw new Error(t("toolbox.ai.errEmptyReply"));
}

// 测试连接：用当前（或临时）配置发一条极短消息，验证 key/地址/模型是否可用
export async function testAI(config) {
  const reply = await aiChat(
    [{ role: "user", content: t("prompt.testReply") }],
    { config, temperature: 0 },
  );
  return reply || t("toolbox.ai.emptyReply");
}

// ---------- 识图提取（流式） ----------
// system 模板：单条/批量/分组三段原文（不得合并，各有特殊指令）；提示词文案走 prompt.extract* 键
function buildExtractSystem(kind, fieldsOrGroups) {
  if (kind === "groups") {
    const groupLines = fieldsOrGroups
      .map((g) => {
        const fieldLines = g.fields
          .map((f) => {
            let line = "  " + t("prompt.extractFieldLine", { key: f.key, label: f.label });
            if (f.desc) line += t("prompt.extractFieldDesc", { desc: f.desc });
            if (f.bool) line += t("prompt.extractFieldBool");
            return line;
          })
          .join("\n");
        return t("prompt.extractGroupLine", { key: g.key, title: g.title }) + "\n" + fieldLines;
      })
      .join("\n");
    return (
      t("prompt.extractGroupsHead") + "\n" +
      groupLines +
      "\n\n" + t("prompt.extractGroupsTail")
    );
  }
  const fieldLines = fieldsOrGroups
    .map((f) => {
      let line = t("prompt.extractFieldLine", { key: f.key, label: f.label });
      if (f.desc) line += t("prompt.extractFieldDesc", { desc: f.desc });
      if (Array.isArray(f.enum) && f.enum.length) {
        line += t("prompt.extractFieldEnum", { values: f.enum.join(" / ") });
      }
      return line;
    })
    .join("\n");
  const head = kind === "many" ? t("prompt.extractManyHead") : t("prompt.extractSingleHead");
  const tail = kind === "many" ? t("prompt.extractManyTail") : t("prompt.extractSingleTail");
  return (
    head +
    t("prompt.extractFieldsIntro") + "\n" +
    fieldLines +
    "\n\n" + tail
  );
}

// 字段过滤（与旧版行为一致）：仅保留声明字段，enum 校验不通过则清空
function filterExtractValue(obj, fields) {
  const result = {};
  for (const f of fields) {
    let v = obj ? obj[f.key] : "";
    if (v === undefined || v === null) v = "";
    if (Array.isArray(v)) v = v.join("\n");
    else if (typeof v === "object") v = JSON.stringify(v);
    else v = String(v).trim();
    if (Array.isArray(f.enum) && f.enum.length && v && !f.enum.includes(v)) v = "";
    result[f.key] = v;
  }
  return result;
}

function filterExtractMany(list, fields) {
  return (Array.isArray(list) ? list : [list])
    .map((obj) => filterExtractValue(obj, fields))
    .filter((row) => Object.values(row).some((v) => v));
}

function filterExtractGroups(parsed, groups) {
  const out = {};
  for (const g of groups) {
    const raw = parsed && Array.isArray(parsed[g.key]) ? parsed[g.key] : [];
    out[g.key] = raw
      .map((obj) => {
        const row = {};
        for (const f of g.fields) {
          let v = obj ? obj[f.key] : "";
          if (f.bool) {
            row[f.key] = v === true || /^(true|\u662f|y|yes|1|✓|√)$/i.test(String(v == null ? "" : v).trim());
            continue;
          }
          if (v === undefined || v === null) v = "";
          if (Array.isArray(v)) v = v.join("\n");
          else if (typeof v === "object") v = JSON.stringify(v);
          else v = String(v).trim();
          row[f.key] = v;
        }
        return row;
      })
      .filter((row) => g.fields.some((f) => !f.bool && row[f.key]));
  }
  return out;
}

// 流式提取共用实现：delta 累积 → throttleFlush（首拍+窗口合并）→ parsePartialJson →
// 字段过滤 → onPartial；流结束 parseJSONLoose 最终解析 → onDone。
function extractStreamImpl(messages, opts, handlers, filterFn) {
  const throttle = throttleFlush((text) => {
    const r = parsePartialJson(text);
    if (!r.ok || (typeof r.value !== "object" && !Array.isArray(r.value))) return;
    handlers.onPartial?.(filterFn(r.value));
  }, 200);
  let full = "";
  const handle = aiChatStream(messages, opts, {
    onDelta: (d) => {
      full += d;
      throttle.flush(full);
    },
    onDone: () => {
      throttle.dispose();
      try {
        handlers.onDone?.(filterFn(parseJSONLoose(full)));
      } catch (e) {
        handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    },
    onError: (e) => {
      throttle.dispose();
      handlers.onError?.(e);
    },
  });
  return {
    stop: () => {
      throttle.dispose();
      handle.stop();
    },
  };
}

function listOf(images) {
  const list = Array.isArray(images) ? images.filter(Boolean) : [images].filter(Boolean);
  if (!list.length) throw new Error(t("prompt.extractErrNoImages"));
  return list;
}

// 单条：识别 1 条，onPartial/onDone 回传对象（仅含声明字段）
export function aiExtractStream(images, fields, opts = {}, handlers = {}) {
  if (!Array.isArray(fields) || !fields.length) throw new Error(t("prompt.extractErrNoFields"));
  const content = [{ type: "text", text: opts.hint || t("prompt.extractHintSingle") }];
  for (const url of listOf(images)) content.push({ type: "image_url", image_url: { url } });
  const messages = [
    { role: "system", content: buildExtractSystem("single", fields) },
    { role: "user", content },
  ];
  return extractStreamImpl(messages, opts, handlers, (v) => filterExtractValue(v, fields));
}

// 批量：识别多条，onPartial/onDone 回传对象数组（已过滤空白行）
export function aiExtractManyStream(images, fields, opts = {}, handlers = {}) {
  if (!Array.isArray(fields) || !fields.length) throw new Error(t("prompt.extractErrNoFields"));
  const content = [{ type: "text", text: opts.hint || t("prompt.extractHintMany") }];
  for (const url of listOf(images)) content.push({ type: "image_url", image_url: { url } });
  const messages = [
    { role: "system", content: buildExtractSystem("many", fields) },
    { role: "user", content },
  ];
  return extractStreamImpl(messages, opts, handlers, (v) => filterExtractMany(v, fields));
}

// 分组：截图含多张表，onPartial/onDone 回传 { 表key: 行数组 }
export function aiExtractGroupsStream(images, groups, opts = {}, handlers = {}) {
  if (!Array.isArray(groups) || !groups.length) throw new Error(t("prompt.extractErrNoGroups"));
  const content = [{ type: "text", text: opts.hint || t("prompt.extractHintGroups") }];
  for (const url of listOf(images)) content.push({ type: "image_url", image_url: { url } });
  const messages = [
    { role: "system", content: buildExtractSystem("groups", groups) },
    { role: "user", content },
  ];
  return extractStreamImpl(messages, opts, handlers, (v) => filterExtractGroups(v, groups));
}

// ---------- JSON 修复 ----------
// 把一段“格式不正确”的 JSON 交给 AI 修复为合法 JSON，返回紧凑合法 JSON 字符串。
// 内部用 parseJSONLoose 二次校验，确保返回的一定能被 JSON.parse；失败则 throw。
export async function aiRepairJson(brokenText, opts = {}) {
  const input = String(brokenText || "").trim();
  if (!input) throw new Error(t("toolbox.ai.errNoRepairInput"));
  const system = t("prompt.repairSystem");
  const text = await aiChat(
    [
      { role: "system", content: system },
      { role: "user", content: input },
    ],
    { config: opts.config, model: opts.model, temperature: 0 },
  );
  const obj = parseJSONLoose(text); // 容忍围栏并二次校验合法性
  return JSON.stringify(obj);
}

// ---------- AI mock 数据 ----------
// 以一段（已脱敏的）JSON 为结构模板，按用户的自然语言指令生成全新的虚构 mock 数据。
// 保持原有字段名与层级结构，仅替换值（除非用户明确要求增删字段/改数量）。
// instruction：用户描述要 mock 成什么样（如“生成 3 条电商订单、金额在 100~500”）；为空时按字段含义造合理假数据。
export async function aiMockJson(templateText, instruction = "", opts = {}) {
  const tpl = String(templateText || "").trim();
  if (!tpl) throw new Error(t("toolbox.ai.errNoMockTemplate"));
  const system = t("prompt.mockSystem");
  const userMsg =
    t("prompt.mockTplHead", { json: tpl }) +
    "\n\n" + t("prompt.mockReqHead") + "\n" +
    (instruction.trim() || t("prompt.mockDefaultReq"));
  const text = await aiChat(
    [
      { role: "system", content: system },
      { role: "user", content: userMsg },
    ],
    { config: opts.config, model: opts.model, temperature: typeof opts.temperature === "number" ? opts.temperature : 0.7 },
  );
  const obj = parseJSONLoose(text);
  return JSON.stringify(obj);
}

// 宽松解析 AI 返回的 JSON：容忍代码块围栏、前后缀文本
function parseJSONLoose(text) {
  if (!text) throw new Error(t("toolbox.ai.errNoReply"));
  let s = String(text).trim();
  // 去掉 ```json ... ``` 围栏
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try {
    return JSON.parse(s);
  } catch (e) {
    // 退而求其次：截取最外层的 [...] 或 {...}
    const candidates = [];
    const ab = s.indexOf("[");
    const ae = s.lastIndexOf("]");
    if (ab >= 0 && ae > ab) candidates.push(s.slice(ab, ae + 1));
    const ob = s.indexOf("{");
    const oe = s.lastIndexOf("}");
    if (ob >= 0 && oe > ob) candidates.push(s.slice(ob, oe + 1));
    // 若对象更靠前（非数组）则优先解析对象
    if (candidates.length === 2 && ob >= 0 && ob < ab) candidates.reverse();
    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch (e2) {
        /* try next */
      }
    }
    throw new Error(t("toolbox.ai.errParseJson", { text: s.slice(0, 120) }));
  }
}
