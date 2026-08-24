// AI 模型前端服务层
// 通过 Rust 命令 ai_chat 透传到 OpenAI 兼容的 /chat/completions（规避浏览器 CORS）。
// 配置存放在 settings.ai：{ baseUrl, apiKey, model, temperature, enabled }
import { invoke, Channel } from "@tauri-apps/api/core";
import { decryptValue } from "./secure.js";
import { parsePartialJson } from "./streamJson.js";
import { throttleFlush } from "./throttle.js";

// 常见服务商预设（baseUrl 已含 /v1 等版本段，直接拼 /chat/completions）
export const AI_PRESETS = [
  { key: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  { key: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  { key: "moonshot", label: "Moonshot / Kimi", baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  { key: "dashscope", label: "阿里通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: "qwen-plus" },
  { key: "siliconflow", label: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", model: "Qwen/Qwen2.5-7B-Instruct" },
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
  if (!cfg.baseUrl) throw new Error("未配置 AI 接口地址（在右上角设置里填写）");
  if (!cfg.apiKey) throw new Error("未配置 AI API Key（在右上角设置里填写）");
  if (!cfg.model) throw new Error("未配置 AI 模型名称（在右上角设置里填写）");

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
      if (!cfg.baseUrl) throw new Error("未配置 AI 接口地址（在右上角设置里填写）");
      if (!cfg.apiKey) throw new Error("未配置 AI API Key（在右上角设置里填写）");
      if (!cfg.model) throw new Error("未配置 AI 模型名称（在右上角设置里填写）");
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
  if (raw && raw.raw) throw new Error("接口返回非 JSON：" + raw.raw);
  throw new Error("AI 返回内容为空或格式无法识别");
}

// 测试连接：用当前（或临时）配置发一条极短消息，验证 key/地址/模型是否可用
export async function testAI(config) {
  const reply = await aiChat(
    [{ role: "user", content: "回复两个字：可用" }],
    { config, temperature: 0 },
  );
  return reply || "（空回复）";
}

// ---------- 识图提取（流式） ----------
// system 模板：单条/批量/分组三段原文（不得合并，各有特殊指令）
function buildExtractSystem(kind, fieldsOrGroups) {
  if (kind === "groups") {
    const groupLines = fieldsOrGroups
      .map((g) => {
        const fieldLines = g.fields
          .map((f) => {
            let line = `  - ${f.key}（${f.label}）`;
            if (f.desc) line += `：${f.desc}`;
            if (f.bool) line += "（布尔值 true/false，图中勾选/是为 true，无法判断填 false）";
            return line;
          })
          .join("\n");
        return `- ${g.key}（${g.title}）：数组，每个元素代表表中一行，字段：\n${fieldLines}`;
      })
      .join("\n");
    return (
      "你是信息提取助手。用户的截图中可能包含下列【一张或多张】表格，请先判断图中实际出现了哪几张表，" +
      "再把每张表的每一行数据提取为一个 JSON 对象。最终严格只输出一个 JSON 对象，" +
      "key 为表名，value 为该表的行数组；图中没有出现的表返回空数组 []。" +
      "不要输出任何解释、前后缀或代码块围栏。表定义如下：\n" +
      groupLines +
      "\n\n要求：只提取图中真实存在的数据行，不要编造；表头行、占位提示行（如‘还没有数据’）不算数据行；" +
      "某字段识别不到就填空字符串（布尔字段填 false）。" +
      "表的数据不一定以规范表格形式出现：若图中存在备注/说明类的合并单元格或自由文本段落，" +
      "其内容能明确对应某张表的字段（例如提到 .sql 脚本文件名与责任人→属于数据库脚本表），" +
      "也要逐条拆分为该表的行提取，对应不上的字段留空、其余说明可放入备注字段；但仍不得凭空编造。" +
      "特别注意表格中的【跨行合并单元格】：若某列的一个单元格在视觉上跨越了多行，" +
      "说明它的内容同时适用于这几行，这几行的该字段都要填入相同内容；" +
      "严格按每行的上下边界判断各列内容属于哪一行，不要把内容错位到相邻行。"
    );
  }
  const fieldLines = fieldsOrGroups
    .map((f) => {
      let line = `- ${f.key}（${f.label}）`;
      if (f.desc) line += `：${f.desc}`;
      if (Array.isArray(f.enum) && f.enum.length) {
        line += `（只能取以下之一：${f.enum.join(" / ")}，无法判断则留空）`;
      }
      return line;
    })
    .join("\n");
  const head =
    kind === "many"
      ? "你是信息提取助手。用户提供的截图中可能包含【多条】记录（如列表或表格）。" +
        "请为图中每一条记录提取为一个 JSON 对象，最终严格只输出一个 JSON 数组，"
      : "你是信息提取助手。请从用户提供的截图中提取信息，严格只输出一个 JSON 对象，";
  const tail =
    kind === "many"
      ? "\n\n要求：数组每个元素的 key 必须与上面一致；只提取图中真实存在的条目，不要编造；" +
        "某字段识别不到就填空字符串。" +
        "特别注意表格中的【跨行合并单元格】：若某列的一个单元格在视觉上跨越了多行，" +
        "说明它的内容同时适用于这几行，这几行的该字段都要填入相同内容；" +
        "严格按每行的上下边界判断各列内容属于哪一行，不要把内容错位到相邻行。"
      : "\n\n要求：JSON 的 key 必须与上面一致；未能从图中识别到的字段填空字符串 \"\"；" +
        "不要编造图中不存在的内容。";
  return (
    head +
    "不要输出任何解释、前后缀或 ```json 代码块围栏。字段定义如下：\n" +
    fieldLines +
    tail
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
            row[f.key] = v === true || /^(true|是|y|yes|1|✓|√)$/i.test(String(v == null ? "" : v).trim());
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
  if (!list.length) throw new Error("请先提供截图");
  return list;
}

// 单条：识别 1 条，onPartial/onDone 回传对象（仅含声明字段）
export function aiExtractStream(images, fields, opts = {}, handlers = {}) {
  if (!Array.isArray(fields) || !fields.length) throw new Error("未定义要提取的字段");
  const content = [{ type: "text", text: opts.hint || "请从这张截图中提取上述字段，只返回 JSON。" }];
  for (const url of listOf(images)) content.push({ type: "image_url", image_url: { url } });
  const messages = [
    { role: "system", content: buildExtractSystem("single", fields) },
    { role: "user", content },
  ];
  return extractStreamImpl(messages, opts, handlers, (v) => filterExtractValue(v, fields));
}

// 批量：识别多条，onPartial/onDone 回传对象数组（已过滤空白行）
export function aiExtractManyStream(images, fields, opts = {}, handlers = {}) {
  if (!Array.isArray(fields) || !fields.length) throw new Error("未定义要提取的字段");
  const content = [{ type: "text", text: opts.hint || "请把截图中的每一条记录提取为数组元素，只返回 JSON 数组。" }];
  for (const url of listOf(images)) content.push({ type: "image_url", image_url: { url } });
  const messages = [
    { role: "system", content: buildExtractSystem("many", fields) },
    { role: "user", content },
  ];
  return extractStreamImpl(messages, opts, handlers, (v) => filterExtractMany(v, fields));
}

// 分组：截图含多张表，onPartial/onDone 回传 { 表key: 行数组 }
export function aiExtractGroupsStream(images, groups, opts = {}, handlers = {}) {
  if (!Array.isArray(groups) || !groups.length) throw new Error("未定义要提取的分组");
  const content = [{ type: "text", text: opts.hint || "请识别截图中出现的表格并按表分组提取每一行，只返回 JSON 对象。" }];
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
  if (!input) throw new Error("没有需要修复的内容");
  const system =
    "你是 JSON 修复助手。用户会给你一段格式不正确的 JSON 文本，" +
    "请修复其中的语法错误（缺失或多余的引号 / 逗号 / 括号、单引号、尾随逗号、注释、" +
    "未转义字符、Python 风格的 True/False/None 等），在【尽最大可能保留原始数据与结构】" +
    "的前提下使其成为合法 JSON。不要新增、删减或臆造字段值。" +
    "严格只输出修复后的 JSON 本身，不要输出任何解释、前后缀或 ```json 代码块围栏。";
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
  if (!tpl) throw new Error("没有作为模板的 JSON");
  const system =
    "你是测试数据生成助手。用户会给你一段作为结构模板的 JSON，以及一段生成要求。" +
    "请生成全新的、真实感强的虚构 mock 数据：" +
    "①默认保持模板的字段名与层级结构不变，仅替换字段的值；" +
    "②生成的值要符合字段名的语义（如 name 是姓名、email 是邮箱、date 是日期）并与原值类型一致；" +
    "③如果用户要求生成多条、改变数量或增删字段，则按要求调整；" +
    "④不要使用真实个人隐私（真实手机号/身份证/银行卡），用明显虚构的样例。" +
    "严格只输出生成后的 JSON 本身，不要输出任何解释、前后缀或 ```json 代码块围栏。";
  const userMsg =
    "【结构模板】\n" + tpl +
    "\n\n【生成要求】\n" + (instruction.trim() || "保持原结构，生成一条全新的合理示例数据。");
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
  if (!text) throw new Error("AI 未返回内容");
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
    throw new Error("AI 返回内容无法解析为 JSON：" + s.slice(0, 120));
  }
}
