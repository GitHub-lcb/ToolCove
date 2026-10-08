// CDP 抓包核心（零依赖，纯 ESM）。
//
// 为什么用 CDP 而不是传统抓包：CDP 就是 DevTools 网络面板的底层协议，能拿到
// 完整的 URL / 方法 / 请求头 / POST 体 / 响应体，但**不需要安装根证书、不做 TLS
// 中间人**，也只影响目标应用自己的流量。
//
// 两个必须记住的约束（都是踩出来的）：
//  1) 调试端口只能在**启动时**用 --remote-debugging-port 传入，已运行的进程无法附加。
//     所以抓某个应用前，必须带参数重启它。
//  2) 浏览器级 Target.setAutoAttach 不会为**已经存在**的 target 补发
//     attachedToTarget，必须逐个直连它们的 WebSocket（见 scripts/verify-netcapture.mjs）。
//     后开的弹窗（Electron BrowserWindow / <webview>）用轮询 /json/list 兜住。
const DEFAULT_TIMEOUT = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 轮询 /json/version 直到调试端口就绪。Electron 冷启动可能要十几秒。 */
export async function waitForEndpoint(port, { timeoutMs = DEFAULT_TIMEOUT, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("aborted");
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const info = await res.json();
        if (info.webSocketDebuggerUrl) return info;
      }
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  throw new Error(
    `等待调试端口 127.0.0.1:${port} 超时（${timeoutMs}ms）。应用必须以 --remote-debugging-port=${port} 启动。` +
    (lastError ? ` 最后一次错误：${lastError.message}` : ""),
  );
}

/** 列出调试端口上已存在的 target。 */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`列出 target 失败：HTTP ${res.status}`);
  const list = await res.json();
  return Array.isArray(list) ? list : [];
}

// 要接上去的目标类型。
//
// `iframe` 必须在这里，而且是被真实的抓包现场逼进来的：
// Qoder 的「专属活动权益」签到弹窗是一个 type=**iframe** 的 target
// （https://openapi.qoder.com.cn/growth-page/activity-iframe），
// 所有签到/积分请求都从它发出。早期版本这里只有 page 和 webview，
// 结果主界面附加成功、一条请求都没有——看起来像"工具坏了"，其实是漏了这一类。
//
// service_worker / background_page / extension 不接：它们会产生大量与用户
// 操作无关的后台请求，把真正要看的那条淹掉。需要时再按需放开。
const CAPTURED_TYPES = new Set(["page", "webview", "iframe"]);

/** 供测试与调用方确认过滤规则（Rust 侧 netcapture.rs 有一份等价列表，改动要同步）。 */
export const capturedTargetTypes = () => [...CAPTURED_TYPES];

// ── 极简 CDP 客户端 ─────────────────────────────────────────────────────────
class CdpClient {
  constructor(ws, targetId) {
    this.ws = ws;
    this.targetId = targetId;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.closed = false;
    ws.addEventListener("message", (ev) => this.#onMessage(String(ev.data)));
    ws.addEventListener("close", () => this.#finish(new Error("CDP 连接已关闭")));
    ws.addEventListener("error", () => this.#finish(new Error("CDP 连接出错")));
  }

  static async connect(url, targetId, { timeoutMs = 10000 } = {}) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("连接 CDP WebSocket 超时")), timeoutMs);
      ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("CDP WebSocket 连接失败")); }, { once: true });
    });
    return new CdpClient(ws, targetId);
  }

  #onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id !== undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(msg.error.message || "CDP 调用失败"));
      else entry.resolve(msg.result);
      return;
    }
    for (const fn of this.listeners) {
      try { fn(msg); } catch { /* 单个订阅者出错不能影响其他订阅者 */ }
    }
  }

  #finish(err) {
    if (this.closed) return;
    this.closed = true;
    for (const { reject } of this.pending.values()) reject(err);
    this.pending.clear();
  }

  get isClosed() { return this.closed; }

  /**
   * @param {string} [sessionId] 子会话 id。开了 flatten 的 Target.setAutoAttach 之后，
   *   子目标（比如新冒出来的 iframe）的命令都要带上它，走的是同一条 WebSocket。
   */
  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const envelope = { id, method, params };
        if (sessionId) envelope.sessionId = sessionId;
        this.ws.send(JSON.stringify(envelope));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close() {
    this.closed = true;
    try { this.ws.close(); } catch {}
  }
}

// ── 脱敏与解析 ──────────────────────────────────────────────────────────────
const REDACT_HEADERS = new Set(["cookie", "authorization", "set-cookie", "x-api-key", "proxy-authorization"]);
export const REDACTED = "<已脱敏>";

function redactHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    out[name] = REDACT_HEADERS.has(name.toLowerCase()) ? REDACTED : value;
  }
  return out;
}

/**
 * 从上线的请求头里挑出鉴权相关的那些。
 *
 * 现在合并逻辑已经把**全部**上线头并进 requestHeaders，这个函数不再是主路径；
 * 留着是因为它把「哪些头算凭据」这件事收在一处，测试也钉着它——
 * 将来若要单独处理凭据（比如脱敏展示），不用重新推一遍规则。
 *
 * 包含 Cookie：ExtraInfo 里的 cookie 是真正上线的值，确实有站点靠它鉴权。
 */
export function pickCredentialHeader(wireHeaders) {
  const out = {};
  for (const [name, value] of Object.entries(wireHeaders || {})) {
    const lower = name.toLowerCase();
    // ":path" / ":method" 这类伪头不是真头
    if (lower.startsWith(":")) continue;
    if (lower === "authorization" || lower === "proxy-authorization" || lower === "cookie" || /-token$|^x-.*-(key|auth|token)$/.test(lower)) {
      out[name] = value;
    }
  }
  return Object.keys(out).length ? out : null;
}

function safeParse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed); } catch { return trimmed; }
  }
  // 值里允许 '='：base64 令牌常带 = 填充（token=abc==），早期版本把它挡在外面，
  // 结果这类表单体整条当纯文本返回，看着像「没抓到内容」。只排除分隔符与空白。
  if (/^[\w.+%-]+=[^&\s]*(?:&[\w.+%-]+=[^&\s]*)*$/.test(trimmed)) {
    const pairs = {};
    for (const kv of trimmed.split("&")) {
      // 只按**第一个** = 切：split("=") 会把 token=a=b 截成 token=a，后半截丢掉
      const at = kv.indexOf("=");
      const k = at >= 0 ? kv.slice(0, at) : kv;
      const v = at >= 0 ? kv.slice(at + 1) : "";
      if (k) pairs[decodeURIComponent(k)] = decodeURIComponent(v);
    }
    return pairs;
  }
  return trimmed;
}

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return { host: u.host, origin: u.origin, path: u.pathname + u.search };
  } catch {
    return { host: "", origin: "", path: String(raw || "") };
  }
}

export { redactHeaders, safeParse, safeUrl };

/**
 * 开始抓包。
 *
 * @param {object} options
 * @param {number} options.port              应用调试端口
 * @param {() => Promise<Array<object>>} [options.probe]
 *        枚举 target 的函数。默认用本页的 fetch 实现；
 *        **Tauri 窗口里必须注入**——CDP 的 HTTP 端点不返回 CORS 头，
 *        带 Origin 的 fetch 会被浏览器拒掉（实测 "TypeError: Failed to fetch"），
 *        哪怕目标应用加了 --remote-allow-origins 也不行（那个开关只管 WebSocket）。
 *        桌面端因此由 Rust 的 netcapture_probe 代查，这里只负责把结果递过来。
 * @param {RegExp} [options.urlFilter]       只保留匹配的 http(s) URL
 * @param {string[]} [options.methods]       只保留这些方法
 * @param {boolean} [options.captureBodies]  是否拉取请求/响应体
 * @param {(req: CapturedRequest) => void} options.onRequest 每条请求**完成后**回调
 * @param {(t: {targetId,title,url,type}) => void} [options.onTarget]
 * @param {(msg: string) => void} [options.onLog]
 * @param {AbortSignal} [options.signal]
 */
export async function startCapture(options) {
  const {
    port, probe, urlFilter, methods = ["GET", "POST", "PUT", "PATCH", "DELETE"],
    captureBodies = true, onRequest, onTarget, onLog, signal,
  } = options;

  const enumerate = probe || (() => listTargets(port));

  const clients = new Map();
  const pending = new Map();
  // 子会话 id -> 它代表的 target id。开了 flatten 的 autoAttach 之后，
  // 子目标的网络事件带的是 sessionId 而不是独立的 WebSocket，得靠这张表找回是谁发的。
  const sessionTargets = new Map();
  let seq = 0;
  let stopped = false;

  const matches = (url) => {
    if (!url || !/^https?:/i.test(url)) return false;
    if (urlFilter) {
      try { return urlFilter.test(url); } catch { return false; }
    }
    return true;
  };

  async function handleEvent(client, msg) {
    // 子会话（新冒出来的 iframe 等）的事件带 sessionId，要据此找回它属于哪个 target；
    // 没有 sessionId 的就是这条连接自己的事件。
    const targetId = (msg.sessionId && sessionTargets.get(msg.sessionId)) || client.targetId;

    // 浏览器主动告知「新子目标出现了」。这是在它**开始加载之前**就收到的，
    // 所以立刻开 Network 域就能抓到它的第一个请求——轮询做不到这一点。
    if (msg.method === "Target.attachedToTarget") {
      const info = msg.params?.targetInfo || {};
      const sessionId = msg.params?.sessionId;
      if (!sessionId || !info.targetId) return;
      if (!CAPTURED_TYPES.has(info.type)) return;
      sessionTargets.set(sessionId, info.targetId);
      onTarget?.({ targetId: info.targetId, title: info.title, url: info.url, type: info.type });
      client.send("Network.enable", {
        maxTotalBufferSize: 32 * 1024 * 1024,
        maxResourceBufferSize: 16 * 1024 * 1024,
      }, sessionId).catch((err) => {
        onLog?.(`子目标「${info.title || info.url || info.targetId}」未响应 Network.enable：${err.message}`);
      });
      return;
    }
    if (msg.method === "Target.detachedFromTarget") {
      if (msg.params?.sessionId) sessionTargets.delete(msg.params.sessionId);
      return;
    }

    if (msg.method === "Network.requestWillBeSent") {
      const { requestId, request, type } = msg.params;
      if (!matches(request.url) || !methods.includes(String(request.method || "").toUpperCase())) return;
      const u = safeUrl(request.url);
      pending.set(`${targetId}:${requestId}`, {
        id: ++seq,
        method: String(request.method || "GET").toUpperCase(),
        url: request.url,
        host: u.host,
        origin: u.origin,
        path: u.path,
        status: 0,
        type: type || "Other",
        requestHeaders: redactHeaders(request.headers),
        responseHeaders: {},
        requestBody: captureBodies ? safeParse(request.postData) : null,
        responseBody: null,
        error: "",
        startedAt: Date.now(),
        targetTitle: "",
      });
      return;
    }
    if (msg.method === "Network.requestWillBeSentExtraInfo") {
      // 这一步是抓包工具**能不能拿到登录凭据**的分水岭。
      //
      // requestWillBeSent 给的是「应用层设的头」。凡是应用层之后才加上的头——
      // Electron 主进程用 session.webRequest.onBeforeSendHeaders 注入的鉴权头、
      // Service Worker 加的头——都不在里面。想拿到它们只能看 ExtraInfo。
      //
      // 实测 Qoder 正是这种情况：签到弹窗的 JS 里通篇没有 "authorization" 字样，
      // fetch 还写了 credentials:"omit"，但接口仍然能正常返回账号数据——
      // 说明 token 是主进程在网络层注入的。
      //
      // 这里**不脱敏**：ExtraInfo 是唯一能看到凭据的地方，脱敏了就等于没抓。
      // 风险由「只连你自己启动的那个应用」来兜（见文件头说明）。
      const rec = pending.get(`${targetId}:${msg.params.requestId}`);
      if (!rec) return;
      const wire = msg.params.headers || {};
      rec.wireHeaders = { ...wire };
      // 把**只在网络层出现**的头并进来，而不只是凭据。
      //
      // 起因是一个实测到的差异：Qoder 的真实请求还带着 cosy-* 一组头
      // （cosy-machineid / cosy-machinetoken / cosy-version …），它们只存在于 ExtraInfo。
      // 早先这里只并凭据头，其余全丢——于是工具发出去的请求和真实请求不一样，
      // 服务端给出的视图也就可能不一样（实测疑似因此把「可领取」读成了「不可领取」，
      // 导致本该签到的日子被跳过）。
      //
      // 复制真实请求的头是这一层唯一正确的做法：工具要复现的就是「那个应用发出的那个请求」。
      // 伪头（:path 之类）不能带；浏览器特征头由描述生成器统一滤掉。
      for (const [name, value] of Object.entries(wire)) {
        if (name.startsWith(":")) continue;
        if (rec.requestHeaders[name] === undefined) rec.requestHeaders[name] = value;
      }
      return;
    }
    if (msg.method === "Network.responseReceived") {
      const rec = pending.get(`${targetId}:${msg.params.requestId}`);
      if (!rec) return;
      rec.status = Number(msg.params.response?.status) || 0;
      rec.type = msg.params.type || rec.type;
      rec.responseHeaders = redactHeaders(msg.params.response?.headers);
      return;
    }
    if (msg.method === "Network.loadingFinished" || msg.method === "Network.loadingFailed") {
      const key = `${targetId}:${msg.params.requestId}`;
      const rec = pending.get(key);
      if (!rec) return;
      pending.delete(key);
      if (msg.method === "Network.loadingFailed") {
        rec.error = msg.params.canceled ? "已取消" : (msg.params.errorText || "请求失败");
      } else if (captureBodies) {
        try {
          // 必须带上 sessionId：子会话的请求体只能通过它所属的会话去取，
          // 用父会话发过去会报「找不到这个 requestId」，响应体就永远是「不可用」。
          const { body, base64Encoded } = await client.send("Network.getResponseBody", { requestId: msg.params.requestId }, msg.sessionId);
          rec.responseBody = base64Encoded ? "<base64 内容未解码>" : safeParse(body);
        } catch {
          rec.responseBody = "<响应体不可用（超出缓冲或目标已关闭）>";
        }
      }
      onRequest?.(rec);
    }
  }

  async function attach(target) {
    // Rust 侧字段名是 wsUrl，CDP 原始接口是 webSocketDebuggerUrl，两种都认
    const wsUrl = target?.webSocketDebuggerUrl || target?.wsUrl;
    if (stopped || !wsUrl || !target?.id) return;
    if (!CAPTURED_TYPES.has(target.type)) return;
    if (clients.has(target.id)) return;
    try {
      const client = await CdpClient.connect(wsUrl, target.id);
      // 先挂监听再开 Network 域：顺序反了，早到的网络事件会被直接丢掉。
      client.on((msg) => { handleEvent(client, msg); });
      clients.set(target.id, client);
      onTarget?.({ targetId: target.id, title: target.title, url: target.url, type: target.type });
      // 这里**刻意不 await**：实测 Qoder 里有一个空 URL 的隐藏 target，它对 Network.enable
      // 根本不回包，await 下去整个抓包就卡死在这里（前面已经附上的 target 白等）。
      // 不响应通常只影响那一个窗口，不该拖垮整场抓包，所以失败只记日志。
      client.send("Network.enable", {
        maxTotalBufferSize: 32 * 1024 * 1024,
        maxResourceBufferSize: 16 * 1024 * 1024,
      }).catch((err) => {
        onLog?.(`target「${target.title || target.url || target.id}」未响应 Network.enable：${err.message}`);
      });

      // 让浏览器在**新建子目标的瞬间**通知我们，而不是靠轮询去发现。
      //
      // 这是实测逼出来的：弹窗是个新建的 iframe，从创建到发出第一个接口请求只有约 200ms，
      // 而轮询最快也要等一个周期——结果就是「拿到了后面的 POST，却漏掉前面的 GET」，
      // 表现为「明明发过这个请求，列表里就是没有」。
      // 用户看到的是工具时灵时不灵，实际是竞态。
      //
      // 只对 page / webview 开：iframe 一般不会再有子目标，开了是白开。
      // flatten:true 让子会话的消息走同一条 WebSocket（带 sessionId），省掉一套转发。
      if (target.type === "page" || target.type === "webview") {
        client.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
        }).catch(() => {
          // 少数 Electron 版本不支持，退回轮询即可，不是致命问题
        });
      }
    } catch (err) {
      onLog?.(`无法连接 target「${target.title || target.url}」：${err.message}`);
    }
  }

  async function sweep() {
    let targets = [];
    try {
      targets = await enumerate();
    } catch (err) {
      onLog?.(`枚举 target 失败：${err.message}`);
      return;
    }
    for (const t of targets) await attach(t);
    const alive = new Set(targets.map((t) => t.id));
    for (const [id, client] of clients) {
      if (!alive.has(id) || client.isClosed) {
        client.close();
        clients.delete(id);
      }
    }
  }

  await sweep();

  const timer = setInterval(() => {
    if (stopped) return;
    sweep().catch(() => {});
  }, 600);

  const onAbort = () => stop();
  signal?.addEventListener("abort", onAbort, { once: true });

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    signal?.removeEventListener("abort", onAbort);
    for (const client of clients.values()) client.close();
    clients.clear();
  }

  return {
    stop,
    get targetCount() { return clients.size; },
    attachNewTargets: sweep,
  };
}