// AI 模型前端服务层
// 通过 Rust 命令 ai_chat 透传到 OpenAI 兼容的 /chat/completions（规避浏览器 CORS）。
// 配置存放在 settings.ai：{ baseUrl, apiKey, model, temperature, enabled }
import { invoke, Channel } from "@tauri-apps/api/core";
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

// 核心：发起一次对话补全。messages 为 [{role, content}] 数组。
// 返回助手回复的纯文本；出错时 throw Error(message)。
// opts：{ model, temperature, config }（config 可传入临时配置，用于「测试连接」时先于保存生效）
export async function aiChat(messages, opts = {}) {
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
  const raw = await invoke("ai_chat", args);
  return extractContent(raw);
}

// 便捷：单轮提问。system 可选系统提示词。
export async function aiComplete(prompt, opts = {}) {
  const messages = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  messages.push({ role: "user", content: prompt });
  return aiChat(messages, opts);
}

// 流式对话：SSE 增量经 Channel 实时推给 onDelta；结束触发 onDone；出错触发 onError(err)。
// 立即返回 { stop }，stop() 关闭 Channel，后端感知发送失败即中止生成。
// 未配置时配置错误也走 onError（不 throw），保证调用方统一走回调分支。
export function aiChatStream(messages, opts = {}, handlers = {}) {
  const channel = new Channel();
  const stop = () => {
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
  (async () => {
    try {
      const cfg = opts.config || (await loadAIConfig());
      if (!cfg.baseUrl) throw new Error(t("toolbox.ai.errNoBaseUrl"));
      if (!cfg.apiKey) throw new Error(t("toolbox.ai.errNoApiKey"));
      if (!cfg.model) throw new Error(t("toolbox.ai.errNoModel"));
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
      await invoke("ai_chat_stream", { ...args, channel });
    } catch (e) {
      handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
    }
  })();
  return { stop };
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
