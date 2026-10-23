// ComfyUI IO 编排层：探活、列举、提交、轮询/WS、取消、结果落盘。
//
// 纪律（改这里之前先读）：
// 1. 桌面端一切 HTTP 都经 invoke("http_request")（Rust 原生代理绕 CORS——ComfyUI 默认不发
//    CORS 头，浏览器 fetch 会被拦；本工具桌面独占，天然规避）。
// 2. http_request 超时硬顶 120s——这里所有请求都必须是秒回型。生成等待靠轮询 + WS，
//    结果字节走 media_fetch_stream（流式命令，无此限制）。**严禁把 /view 下载改回 http_request**，
//    大视频必然爆内存。
import { invoke } from "../../platform/invoke.js";
import { mediaName, normalizeExt } from "./promptGen.js";
import {
  classifyHistoryOutputs,
  decideCancel,
  extractClipTypes,
  extractModels,
  historyErrorText,
  newClientId,
  normalizeComfyBase,
  parseComfyWsMessage,
  queuePendingCount,
  summarizeNodeErrors,
  viewUrl,
  wsUrl,
} from "./comfy.js";

const QUICK_TIMEOUT_MS = 15000;
const POLL_INTERVAL_MS = 1500;
const JOB_TIMEOUT_MS = 30 * 60 * 1000;

const transportMessage = (error) => String(error?.message ?? error ?? "");

async function requestJson(base, path, { method = "GET", body = null, timeoutMs = QUICK_TIMEOUT_MS } = {}) {
  const response = await invoke("http_request", {
    method,
    url: `${normalizeComfyBase(base)}${path}`,
    headers: body == null ? [] : [["Content-Type", "application/json"]],
    body: body == null ? "" : JSON.stringify(body),
    timeoutMs,
  });
  const status = Number(response?.status) || 0;
  const text = String(response?.body ?? "");
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  return { status, text, data };
}

function errorTextOf(data, text) {
  const message = data?.error?.message ?? data?.error ?? data?.message;
  if (typeof message === "string" && message.trim()) return message.trim().slice(0, 300);
  const raw = String(text ?? "").trim();
  return raw ? raw.replace(/\s+/g, " ").slice(0, 300) : "";
}

/** 探活（/system_stats）。返回 { ok, version, error }。 */
export async function probe(base) {
  try {
    const { status, data, text } = await requestJson(base, "/system_stats");
    if (status < 200 || status >= 300) return { ok: false, version: "", error: `HTTP ${status}：${errorTextOf(data, text)}` };
    return { ok: true, version: String(data?.system?.comfyui_version ?? ""), error: "" };
  } catch (error) {
    return { ok: false, version: "", error: transportMessage(error) };
  }
}

/**
 * 本机全部模型（checkpoint / 扩散模型 / 文本编码器 / VAE / LoRA）。
 * 全量 /object_info 体积可达数 MB，单独放宽超时，仍远低于 http_request 的 120s 硬顶。
 */
export async function listModels(base) {
  const empty = extractModels(null);
  try {
    const { status, data, text } = await requestJson(base, "/object_info", { timeoutMs: 30000 });
    if (status < 200 || status >= 300) {
      return { ok: false, models: empty, classTypes: [], clipTypes: [], error: `HTTP ${status}：${errorTextOf(data, text)}` };
    }
    return {
      ok: true,
      models: extractModels(data),
      classTypes: Object.keys(data ?? {}),
      clipTypes: extractClipTypes(data),
      error: "",
    };
  } catch (error) {
    return { ok: false, models: empty, classTypes: [], clipTypes: [], error: transportMessage(error) };
  }
}

/** 全量节点定义：界面格式转 API 格式、补默认值都要用；失败静默降级。 */
export async function fetchObjectInfo(base) {
  try {
    const { status, data, text } = await requestJson(base, "/object_info", { timeoutMs: 30000 });
    if (status < 200 || status >= 300) {
      return { ok: false, data: null, error: `HTTP ${status}：${errorTextOf(data, text)}` };
    }
    return { ok: true, data, error: "" };
  } catch (error) {
    return { ok: false, data: null, error: transportMessage(error) };
  }
}

/** 本机 ComfyUI 已保存的工作流名（/userdata 路由，子目录以 / 分隔）。 */
export async function listUserWorkflows(base) {
  try {
    const { status, data, text } = await requestJson(base, "/userdata?dir=workflows&recurse=true");
    if (status < 200 || status >= 300) {
      return { ok: false, names: [], error: `HTTP ${status}：${errorTextOf(data, text)}` };
    }
    const list = Array.isArray(data) ? data : [];
    const names = list
      .map((item) => (typeof item === "string" ? item : item?.name))
      .filter((name) => typeof name === "string" && name.trim());
    return { ok: true, names, error: "" };
  } catch (error) {
    return { ok: false, names: [], error: transportMessage(error) };
  }
}

/**
 * 读本机工作流原文（界面格式；调用方用 uiToApiWorkflow 转换）。
 * 注意：/userdata/{file} 的 {file} 是 aiohttp 的单段路径参数，必须整段编码
 * （`workflows/x.json` → `workflows%2Fx.json`），否则带斜杠的路径会 404。
 */
export async function fetchUserWorkflow(base, name) {
  const path = encodeURIComponent(`workflows/${String(name ?? "").replace(/^\/+/, "")}`);
  try {
    const { status, data, text } = await requestJson(base, `/userdata/${path}`);
    if (status < 200 || status >= 300) {
      return { ok: false, data: null, error: `HTTP ${status}：${errorTextOf(data, text)}` };
    }
    return { ok: true, data, error: "" };
  } catch (error) {
    return { ok: false, data: null, error: transportMessage(error) };
  }
}


/** 提交任务（POST /prompt，秒回）。返回 { ok, promptId, nodeErrors, error }。 */
export async function submitWorkflow(base, workflow, clientId) {
  const { status, data, text } = await requestJson(base, "/prompt", {
    method: "POST",
    body: { prompt: workflow, client_id: clientId },
  });
  if (status < 200 || status >= 300) {
    return { ok: false, promptId: "", nodeErrors: [], error: `HTTP ${status}：${errorTextOf(data, text)}` };
  }
  const nodeErrors = summarizeNodeErrors(data?.node_errors);
  if (nodeErrors.length) return { ok: false, promptId: "", nodeErrors, error: "" };
  const promptId = String(data?.prompt_id ?? "");
  if (!promptId) {
    const detail = errorTextOf(data, "");
    return { ok: false, promptId: "", nodeErrors: [], error: `HTTP ${status}：${detail || "未返回任务 ID"}` };
  }
  return { ok: true, promptId, nodeErrors: [], error: "" };
}

/** /history/{id} 条目（任务完成前为 null）。 */
export async function historyOf(base, promptId) {
  const { status, data, text } = await requestJson(base, `/history/${encodeURIComponent(promptId)}`);
  if (status < 200 || status >= 300) {
    return { ok: false, entry: null, error: `HTTP ${status}：${errorTextOf(data, text)}` };
  }
  return { ok: true, entry: data && typeof data === "object" ? data[promptId] ?? null : null, error: "" };
}

/** /queue 原始数据（含 queue_running / queue_pending）。 */
export async function queueState(base) {
  const { status, data, text } = await requestJson(base, "/queue");
  if (status < 200 || status >= 300) {
    return { ok: false, data: null, error: `HTTP ${status}：${errorTextOf(data, text)}` };
  }
  return { ok: true, data: data && typeof data === "object" ? data : {}, error: "" };
}

export async function interrupt(base) {
  const { status, data, text } = await requestJson(base, "/interrupt", { method: "POST" });
  if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}：${errorTextOf(data, text)}` };
  return { ok: true, error: "" };
}

export async function queueDelete(base, promptId) {
  const { status, data, text } = await requestJson(base, "/queue", {
    method: "POST",
    body: { delete: [String(promptId)] },
  });
  if (status < 200 || status >= 300) return { ok: false, error: `HTTP ${status}：${errorTextOf(data, text)}` };
  return { ok: true, error: "" };
}

/**
 * 取消远端任务：在队列中 → 删除排队项；正在执行 → /interrupt（全局打断，调用方必须先过确认）。
 * 返回 "interrupt" | "delete" | "gone" | "error"。
 */
export async function cancelRemote(base, promptId) {
  try {
    const queue = await queueState(base);
    if (!queue.ok) return "error";
    const action = decideCancel(queue.data, promptId);
    if (action === "interrupt") {
      const result = await interrupt(base);
      return result.ok ? "interrupt" : "error";
    }
    if (action === "delete") {
      const result = await queueDelete(base, promptId);
      return result.ok ? "delete" : "error";
    }
    return "gone";
  } catch {
    return "error";
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener?.("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** WS 进度通道（尽力而为）：连不上/断开只上报 wsLost，不失败任务。 */
function connectWs(base, clientId, promptId, onProgress, wsFactory) {
  let socket = null;
  let done = false;
  try {
    socket = wsFactory(`${wsUrl(base)}?clientId=${encodeURIComponent(clientId)}`);
  } catch {
    onProgress({ wsLost: true });
    return { close() {} };
  }
  try {
    socket.addEventListener("message", (event) => {
      const message = parseComfyWsMessage(typeof event?.data === "string" ? event.data : "");
      if (!message) return;
      const mine = !message.promptId || message.promptId === promptId;
      if (!mine) return;
      if (message.type === "progress") onProgress({ status: "running", step: message.value, max: message.max });
      else if (message.type === "execution_error") onProgress({ wsError: message.message });
      else if (message.type === "status") onProgress({ pending: message.queueRemaining });
    });
    socket.addEventListener("error", () => {
      if (!done) onProgress({ wsLost: true });
    });
    socket.addEventListener("close", () => {
      if (!done) onProgress({ wsLost: true });
    });
  } catch {
    onProgress({ wsLost: true });
  }
  return {
    close() {
      done = true;
      try {
        socket?.close?.();
      } catch {
        /* 关闭失败不影响任务结果 */
      }
    },
  };
}

async function fetchOutput(base, file, name) {
  const saved = await invoke("media_fetch_stream", { url: viewUrl(base, file), name });
  return { name: String(saved?.name ?? name), path: String(saved?.path ?? ""), bytes: Number(saved?.bytes) || 0 };
}

/** 结果下载（历史「重试下载」也走这里）：/view → media/ 流式落盘。 */
export async function downloadOutput(base, file, name) {
  return fetchOutput(base, file, name);
}

/**
 * 跑一次生成任务：提交 → （WS 进度 + 轮询真值）→ 结果流式落盘。
 * 返回 { status: "done" | "error" | "canceled", promptId, files, failed, nodeErrors, code, error, durationMs }。
 * 取消：调用方 abort(signal) 并另行 cancelRemote()——这里只负责停下等待。
 */
export async function runJob({
  base,
  workflow,
  onProgress = () => {},
  signal = null,
  wsFactory = (url) => new WebSocket(url),
  nameFor = (file) => mediaName(normalizeExt(file.filename)),
  pollIntervalMs = POLL_INTERVAL_MS,
  timeoutMs = JOB_TIMEOUT_MS,
} = {}) {
  const started = Date.now();
  const clientId = newClientId();
  const elapsed = () => Date.now() - started;
  let submitted;
  try {
    submitted = await submitWorkflow(base, workflow, clientId);
  } catch (error) {
    return { status: "error", promptId: "", files: [], failed: [], nodeErrors: [], code: "transport", error: transportMessage(error), durationMs: elapsed() };
  }
  if (!submitted.ok) {
    return {
      status: "error",
      promptId: "",
      files: [],
      failed: [],
      nodeErrors: submitted.nodeErrors,
      code: submitted.nodeErrors.length ? "nodeErrors" : "submit",
      error: submitted.error,
      durationMs: elapsed(),
    };
  }
  const promptId = submitted.promptId;
  onProgress({ status: "running", promptId, pending: 0, step: 0, max: 0 });
  const ws = connectWs(base, clientId, promptId, onProgress, wsFactory);
  try {
    let iteration = 0;
    for (;;) {
      if (signal?.aborted) return { status: "canceled", promptId, files: [], failed: [], nodeErrors: [], code: "", error: "", durationMs: elapsed() };
      if (elapsed() > timeoutMs) {
        return { status: "error", promptId, files: [], failed: [], nodeErrors: [], code: "timeout", error: "", durationMs: elapsed() };
      }
      await delay(pollIntervalMs, signal);
      if (signal?.aborted) return { status: "canceled", promptId, files: [], failed: [], nodeErrors: [], code: "", error: "", durationMs: elapsed() };
      iteration += 1;
      let entry = null;
      try {
        const history = await historyOf(base, promptId);
        entry = history.entry;
      } catch {
        // 单次查询失败（如 ComfyUI 正在重启）不终止任务，等下一拍
      }
      if (entry) {
        const errorText = historyErrorText(entry);
        if (errorText) {
          return { status: "error", promptId, files: [], failed: [], nodeErrors: [], code: "execution", error: errorText, durationMs: elapsed() };
        }
        const files = classifyHistoryOutputs(entry);
        if (!files.length) {
          return { status: "error", promptId, files: [], failed: [], nodeErrors: [], code: "noOutputs", error: "", durationMs: elapsed() };
        }
        const downloaded = [];
        const failed = [];
        for (let index = 0; index < files.length; index += 1) {
          if (signal?.aborted) {
            return { status: "canceled", promptId, files: downloaded, failed, nodeErrors: [], code: "", error: "", durationMs: elapsed() };
          }
          onProgress({ status: "downloading", index: index + 1, total: files.length });
          const file = files[index];
          try {
            const saved = await fetchOutput(base, file, nameFor(file));
            downloaded.push({ ...file, name: saved.name, bytes: saved.bytes });
          } catch (error) {
            failed.push({ ...file, name: "", error: transportMessage(error) });
          }
        }
        if (!downloaded.length) {
          return { status: "error", promptId, files: [], failed, nodeErrors: [], code: "downloadFailed", error: "", durationMs: elapsed() };
        }
        return { status: "done", promptId, files: downloaded, failed, nodeErrors: [], code: "", error: "", durationMs: elapsed() };
      }
      if (iteration % 4 === 0) {
        try {
          const queue = await queueState(base);
          if (queue.ok) onProgress({ pending: queuePendingCount(queue.data) });
        } catch {
          // 排队数只是展示，失败不处理
        }
      }
    }
  } finally {
    ws.close();
  }
}
