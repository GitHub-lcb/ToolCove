// TypeSafe（System One）传输层
//
// 为什么不复用 ai.js：那是 OpenAI 兼容的 /chat/completions，而 TypeSafe 是另一套形状——
// POST /v1/systemone，请求体是 { state, model, questions }，响应是 { answers, usage }。
// 两者除了都要 POST + Bearer 之外没有共同点，硬塞进 ai.js 只会让两边都难读。
//
// 桌面端经 Rust 命令 typesafe_eval 转发（与 ai_chat 同一动机：规避浏览器 CORS，
// 且 API Key 不经过 webview 的网络栈）；浏览器端直连同一端点（要求该端点允许 CORS）。
// 配置存放在 settings.typesafe：{ baseUrl, apiKey, model, enabled }
import { invoke } from "./platform/invoke.js";
import { isDesktop } from "./platform/env.js";
import { decryptValue } from "./secure.js";
import { normalizeTypeSafe } from "./settingsConfig.js";
import { i18n } from "./i18n/index.js";

const t = (key, params) => i18n.global.t(key, params);

/** 官方端点（baseUrl 含版本段，与 settings.ai 的约定一致，拼 /systemone）。 */
export const TYPESAFE_DEFAULT_BASE = "https://api.typesafe.ai/v1";
/** 默认模型别名（跟随旗舰模型，不写死版本号）。skillSuggest.js 的 SKILL_SUGGEST_MODEL 与此同值。 */
export const TYPESAFE_DEFAULT_MODEL = "jev-latest";

/** 评估端点地址：baseUrl 为空时落到官方端点，结尾斜杠容错。 */
export function typesafeUrl(baseUrl) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "") || TYPESAFE_DEFAULT_BASE;
  return `${base}/systemone`;
}

/**
 * 读 settings.typesafe。baseUrl 留空即用官方端点——用户只需要粘一个 key。
 * settings 读不到时返回默认值：设置未落盘不该让 Agent 崩。
 */
export async function loadTypeSafeConfig() {
  let settings = {};
  try {
    settings = (await invoke("load_data", { key: "settings" })) || {};
  } catch {
    settings = {};
  }
  // 归一交给 settingsConfig.normalizeTypeSafe：设置是用户可改的 JSON，形状与上限只在一处定义
  const c = normalizeTypeSafe(settings.typesafe);
  return {
    baseUrl: c.baseUrl || TYPESAFE_DEFAULT_BASE,
    apiKey: String((await decryptValue(c.apiKey)) || "").trim(),
    model: c.model,
    enabled: c.enabled,
  };
}

/** 是否可用：既要 key，也要用户显式开启。 */
export async function isTypeSafeConfigured() {
  const cfg = await loadTypeSafeConfig();
  return !!(cfg.enabled && cfg.apiKey);
}

/** 从错误体里挖出人能看懂的那句话；不是 JSON 就保留原文。 */
function errorMessage(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed?.error?.message || parsed?.message || parsed?.detail || text;
  } catch {
    return text;
  }
}

// 浏览器直连：请求体与错误文案与 Rust 侧逐字对齐，保证两端行为一致。
async function browserEval(args, signal) {
  const response = await fetch(typesafeUrl(args.baseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${String(args.apiKey).trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args.body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}：${errorMessage(text)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(t("toolbox.ai.errNonJson", { raw: text }));
  }
}

/**
 * 解析出给 suggestSkills 用的传输层。
 * 返回 null 表示「这次不走 TypeSafe」——调用方据此退回关键词匹配，而不是报错。
 * options：
 *  - typesafeTransport：显式注入（测试与自定义代理），优先级最高
 *  - typesafe: false：显式关闭，即使配置齐全也不走网络
 * 配置只读一次：读设置是 IPC，解析和调用分两次读会白白多一次往返。
 */
export async function resolveTypeSafeTransport(options = {}) {
  if (typeof options.typesafeTransport === "function") return options.typesafeTransport;
  if (options.typesafe === false) return null;
  const config = await loadTypeSafeConfig();
  if (!config.enabled || !config.apiKey) return null;
  return (body) => typesafeEval(body, { config });
}

/**
 * 发一次 System One 评估。body 即 { model, state, questions } 原样转发。
 * opts.config 可传入临时配置（设置页「测试连接」时先于保存生效）。
 */
export async function typesafeEval(body, opts = {}) {
  const cfg = opts.config || (await loadTypeSafeConfig());
  if (!cfg.apiKey) throw new Error(t("settings.typesafeErrNoKey"));
  const args = { baseUrl: cfg.baseUrl || TYPESAFE_DEFAULT_BASE, apiKey: cfg.apiKey, body };
  return isDesktop ? await invoke("typesafe_eval", args) : await browserEval(args, opts.signal);
}

/**
 * 测试连接：发一个最小的 System One 请求，把模型名与探针概率回给设置页。
 * 为什么不复用 ai.js 的 testAI：那边验的是 OpenAI 兼容端点，形状完全不同。
 * 这里必须**校验响应形状**——key 无效或网关异常时上游可能回 200 带一个空 answers，
 * 那样「测试通过」就成了假信号。
 */
export async function testTypeSafe(config) {
  const model = String(config?.model || "").trim() || TYPESAFE_DEFAULT_MODEL;
  const response = await typesafeEval(
    {
      model,
      state: "ping",
      questions: { probe: { type: "noul", instructions: "Is this text non-empty?" } },
    },
    { config },
  );
  const noul = Number(response?.answers?.probe?.noul);
  if (!Number.isFinite(noul)) throw new Error(t("settings.typesafeErrNoAnswer"));
  return { model: String(response?.model || model), noul };
}
