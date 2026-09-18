// E2E 公共设施：数据播种、AI 端点桩、启动 Agent 的固定动作。
//
// 为什么要桩 AI：Agent 是「模型决定下一步」的循环，真模型会让用例不确定。这里把
// /chat/completions 拦下来，按**预先排好的动作队列**逐个返回——被测的是应用，
// 不是模型的智力。约定：E2E_AI_BASE 必须是一个不会被真实解析的地址（127.0.0.1:9），
// 万一桩没生效，请求会立刻失败而不是打到公网。
import { expect } from "@playwright/test";

// 假端点：只要能通过 URL 校验即可。真正的请求由 Playwright 的 route 拦下，
// 不会出网；用 127.0.0.1 而不是 example.com 是为了万一拦截失效时立刻失败而不是打到公网。
// 注意不能用 127.0.0.1:9 这类端口——那是 Chrome 的受限端口（ERR_UNSAFE_PORT），fetch 会直接失败。
export const E2E_AI_BASE = "http://127.0.0.1:4321/e2e-ai/v1";
export const E2E_AI_KEY = "e2e-key";
export const E2E_AI_MODEL = "e2e-model";

/** 应用配置里的 AI 段落（browser 端 apiKey 是明文往返，见 platform/invoke.js）。 */
export const AI_SETTINGS = {
  ai: { baseUrl: E2E_AI_BASE, apiKey: E2E_AI_KEY, model: E2E_AI_MODEL, temperature: 0.7, enabled: true },
  // 默认策略：写类工具弹确认卡（这正是要测的路径）
  agent: { maxSteps: 12, retries: 1, requireConfirmation: "risky", disabledTools: [], disabledSkills: [] },
};

/**
 * 在页面加载前把数据写进 IndexedDB。
 * 存储契约来自 platform/kv.js：库名 toolcove、仓储名 kv，键即 load_data/save_data 的 key。
 *
 * ⚠️ 只在**本用例第一次加载**时播种。addInitScript 每次导航都会重跑，若无条件写入，
 * `page.reload()`（用例常用来验证「真的落盘了」）会把测试**自己刚写的数据覆盖回初始值**——
 * 实测表现为「创建后刷新就丢、删除后刷新又出现」，一度以为是应用没落盘。
 * 用 sessionStorage 做每页会话标记：首次导航播种，之后的 reload 不再动数据。
 */
export async function seedData(page, entries, { version = 1 } = {}) {
  await page.addInitScript(
    ([payload, dbVersion]) => {
      const MARK = "__e2e_seed_done__";
      try {
        if (sessionStorage.getItem(MARK) === "1") return;
        sessionStorage.setItem(MARK, "1");
      } catch {
        // sessionStorage 不可用时退化为「每次都播种」——保留旧行为，不因此报错
      }
      const request = indexedDB.open("toolcove", dbVersion);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
      };
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("kv", "readwrite");
        const store = tx.objectStore("kv");
        for (const [key, value] of payload) store.put(value, key);
        tx.oncomplete = () => {
          window.__E2E_SEEDED__ = true;
          db.close();
        };
      };
      request.onerror = () => {
        window.__E2E_SEED_ERROR__ = String(request.error);
      };
    },
    [Object.entries(entries), version]
  );
}

/** 带 AI 配置的常规播种（大多数用例只需要这一个）。 */
export async function seedWithAI(page, extra = {}) {
  await seedData(page, { settings: { ...AI_SETTINGS, ...extra } });
}

export const E2E_IPC_BASE = "http://127.0.0.1:4321/e2e-ipc";

/** 把排好的动作转成 OpenAI 兼容响应体。 */
function completionOf(content) {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion",
    model: E2E_AI_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** 从队列里取下一个动作，转成 assistant 正文。 */
function nextContent(queue) {
  const next = queue.length ? queue.shift() : null;
  return typeof next === "string" ? next : JSON.stringify(next ?? { type: "final", answer: "（E2E 队列已空）" });
}

/**
 * 桌面 IPC 替身：让 web 构建以「桌面形态」运行。
 *
 * 为什么需要它：file.* 这类工具标了 desktopOnly，浏览器端会被从注册表与工具箱里剔掉
 * （platform/env.js 的 isDesktop 是唯一真相源）。而写前预览、读后写门禁这些行为恰恰挂在
 * 这些工具上——不注入替身就永远测不到它们。
 *
 * 为什么这样做是可信的：应用自己的 platform/invoke.js 仍然在做真实判断与分发
 * （isDesktop 为真 → 直通 tauriCore.invoke），@tauri-apps/api 的 invoke 只是转发到
 * window.__TAURI_INTERNALS__.invoke。这里替换的正是**真实 IPC 边界**，被测的是生产代码路径，
 * 不需要为测试加任何分支。副作用是替身不做真实 IO：文件只存在于内存里。
 *
 * 用 page.exposeFunction 把桥接函数注入页面（而不是让页面 fetch 一个假地址）：不必占端口
 * （127.0.0.1:9 之类是 Chrome 受限端口，会 ERR_UNSAFE_PORT），事件类命令也能由 Node 侧登记。
 *
 * ⚠️ 桌面形态下**所有** IPC 都走这里：包括 AI（`ai_chat`）与存储（`load_data`/`save_data`）。
 * 前者不接管就会出现「AI 返回内容为空或格式无法识别」（请求发去了替身却没有应答），
 * 后者不接回 IndexedDB 就会出现「AI 未配置」并跳去设置页——两个坑都踩过。
 *
 * @param {Record<string,string>} files 初始文件内容（路径 → 文本）
 * @param {object} options
 * @param {string[]} [options.readFails] 列出的路径读取时报「文件不存在」
 * @param {any[]} [options.responses] AI 动作队列（桌面形态下 AI 走 IPC，队列必须建在这里）
 */
export async function seedDesktopIpc(page, files = {}, { readFails = [], responses = [], httpRoutes = {} } = {}) {
  const store = new Map(Object.entries(files));
  const ops = [];
  const callbacks = new Map();
  let nextId = 1;

  // ⚠️ 队列必须在 exposeFunction **之前**准备好：Playwright 的回调是首次调用时绑定的，
  // 之后再改闭包捕获的变量不会生效（第一次实现把队列留给 mockAI 去填，结果替身一直读到空队列，
  // 表现为「队列已空」的假答复）。
  const state = stateOf(page);
  state.queue = [...responses];
  state.calls = [];
  state.httpRoutes = httpRoutes;

  await page.exposeFunction("__e2eIpc", async (cmd, args = {}) => {
    ops.push({ cmd, args });
    const name = String(cmd);
    // AI：桌面端经 Rust 代理，浏览器端直接 fetch——两种形态共用同一份队列
    if (name === "ai_chat" || name === "ai_chat_stream") {
      state.calls.push({ messages: args?.messages || [], stream: name.endsWith("stream") });
      if (state.status && state.status !== 200) throw new Error(`AI 请求失败（${state.status}）`);
      return completionOf(nextContent(state.queue));
    }
    // 事件订阅：登记回调并返回唯一 id（恒返回同一 id 会让页面崩掉）
    if (name.includes("listen")) {
      const id = nextId++;
      callbacks.set(id, true);
      return id;
    }
    if (name.startsWith("plugin:event|unlisten")) {
      callbacks.delete(Number(args?.eventId ?? args?.id));
      return null;
    }
    const path = String(args?.path ?? args?.name ?? "");
    if (name === "file_tool_read_text") {
      if (readFails.includes(path) || !store.has(path)) {
        throw new Error(`无法读取文件：系统找不到指定的文件。 (os error 2) [${path}]`);
      }
      return { path, name: path.split("\\").pop(), size: store.get(path).length, text: store.get(path), encoding: "UTF-8", hasBom: false, lossy: false };
    }
    if (name === "file_tool_write_text") {
      store.set(path, String(args?.text ?? ""));
      return null;
    }
    if (name === "file_tool_inspect") {
      return (args?.paths || []).map((p) => ({ path: p, exists: store.has(p) }));
    }
    // 存储类命令：桌面端本来落 Rust 文件存储，替身必须接回 IndexedDB
    // ——用例的数据播种在 IndexedDB（platform/kv.js 的库名与仓储名）。
    if (name === "load_data") return readKv(page, args?.key);
    if (name === "save_data") {
      await writeKv(page, args?.key, args?.data ?? null);
      return null;
    }
    // HTTP：请求工具的用例要在**离线**下跑，所以这里按 url 后缀回放预置响应。
    // 被测的仍是生产代码路径（RequestToolView → platform/invoke → http_request）。
    if (name === "http_request") {
      const routes = state.httpRoutes || {};
      const url = String(args?.url ?? "");
      const match = Object.keys(routes).find((key) => url.endsWith(key) || url.includes(key));
      if (!match) {
        throw new Error(`请求失败：E2E 桩没有为 ${url} 配置响应`);
      }
      const route = routes[match];
      if (typeof route === "function") return route(args);
      return {
        status: route.status ?? 200,
        statusText: route.statusText ?? "OK",
        headers: route.headers ?? [["content-type", route.contentType ?? "application/json"]],
        body: route.body ?? "",
        durationMs: route.durationMs ?? 12,
        size: (route.body ?? "").length,
      };
    }
    // 其余桌面命令一律「成功但无内容」：本套用例只关心 AI、文件与存储链路
    return null;
  });

  await page.addInitScript(() => {
    window.__E2E_DESKTOP_OPS__ = [];
    let seq = 1;
    window.__TAURI_INTERNALS__ = {
      invoke: (cmd, args) => {
        window.__E2E_DESKTOP_OPS__.push({ cmd, args });
        return window.__e2eIpc(cmd, args ?? {});
      },
      transformCallback: () => seq++,
      unregisterCallback: () => {},
      convertFileSrc: (p) => p,
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    };
  });

  return {
    ops,
    files: store,
    /** 替身内存里某个文件的当前内容（断言写入确实发生） */
    file: (path) => (store.has(path) ? store.get(path) : null),
  };
}

// E2E 内部共享状态：挂在 page 对象上。桌面形态下请求由 Node 侧应答，队列必须在 Node 侧。
const PAGE_STATE = new WeakMap();
function stateOf(page) {
  if (!PAGE_STATE.has(page)) PAGE_STATE.set(page, { queue: [], calls: [], status: 200, delayMs: 0 });
  return PAGE_STATE.get(page);
}

/**
 * 读 IndexedDB 里的一个键（供用例断言"真的落盘了"）。
 * 注意要点：必须处理 onupgradeneeded（库里还没有 kv 仓储时要先建），
 * 且 get 要包 try/catch——库还没建立时 transaction 会直接抛，
 * 漏了这两点会表现为 evaluate 挂到超时（已经踩过一次）。
 */
export async function readKv(page, key) {
  return page.evaluate(
    (k) =>
      new Promise((resolve) => {
        const request = indexedDB.open("toolcove", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        };
        request.onerror = () => resolve([]);
        request.onsuccess = () => {
          const db = request.result;
          try {
            const get = db.transaction("kv", "readonly").objectStore("kv").get(k);
            get.onsuccess = () => resolve(get.result === undefined ? [] : get.result);
            get.onerror = () => resolve([]);
          } catch {
            resolve([]);
          }
        };
      }),
    key
  );
}

async function writeKv(page, key, data) {
  await page.evaluate(
    ([k, value]) =>
      new Promise((resolve) => {
        const request = indexedDB.open("toolcove", 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        };
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          try {
            const tx = db.transaction("kv", "readwrite");
            tx.objectStore("kv").put(JSON.parse(JSON.stringify(value ?? null)), k);
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
          } catch {
            resolve(false);
          }
        };
      }),
    [key, data]
  );
}

/** 替身收到的桌面调用（用于断言「预览一套、执行另一套」这类不一致）。 */
export async function desktopOps(page) {
  return page.evaluate(() => window.__E2E_DESKTOP_OPS__ || []);
}

/**
 * AI 端点桩。
 *
 * 两种形态共用同一份队列（挂在 page 状态上）：
 *  - 浏览器形态：应用直接 fetch baseUrl/chat/completions —— 由 route 拦截并按队列应答；
 *  - 桌面形态（seedDesktopIpc）：应用经 ai_chat IPC —— 由替身在 Node 侧按同一队列应答。
 *
 * @param {object} options
 * @param {any[]} options.responses 依次返回的内容：字符串直接当 assistant 正文，其余 JSON.stringify
 * @param {number} options.status 非 200 时让请求失败（用于测错误路径）
 */
export async function mockAI(page, { responses = [], status = 200, delayMs = 0 } = {}) {
  const state = stateOf(page);
  state.queue = [...responses];
  state.status = status;
  state.delayMs = delayMs;
  state.calls = [];
  await page.route("**/chat/completions", async (route) => {
    const body = route.request().postDataJSON?.() || {};
    state.calls.push({ messages: body.messages || [], stream: !!body.stream });
    if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
    if (state.status !== 200) {
      await route.fulfill({
        status: state.status,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: `e2e-mock-${state.status}` } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(completionOf(nextContent(state.queue))),
    });
  });
}

/** 桩实际收到的请求（用于断言 prompt 内容，例如技能是否注入、答案是否作为文本回灌）。 */
export async function aiCalls(page) {
  return stateOf(page).calls;
}

export const toolCall = (tool, args, id = "c1") => ({ type: "tool_call", id, tool, args });
export const final = (answer) => ({ type: "final", answer });

/** 启动一次 Agent 运行：填目标 → 回车。 */
export async function runGoal(page, goal) {
  const box = page.getByPlaceholder(/描述目标/);
  await box.fill(goal);
  await box.press("Enter");
}

/** 等待确认卡出现（写类工具的批准卡）。 */
export async function expectConfirmCard(page) {
  const card = page.locator(".confirm");
  await expect(card).toBeVisible();
  return card;
}

/** 等到运行结束（顶部状态芯片不再是「运行中/等待确认」）。 */
export async function expectRunFinished(page, status = /已完成/) {
  await expect(page.locator(".st-chip").first()).toHaveText(status, { timeout: 20_000 });
}
