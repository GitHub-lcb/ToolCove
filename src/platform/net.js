// 浏览器端 HTTP：fetch 直连，返回结构与 Rust http_request 对齐（status/headers/body/bodyBase64/durationMs/size）。
// 受同源策略约束：目标接口必须允许 CORS（含预检），否则会被浏览器拦截；桌面端走原生代理不受此限。
function bytesToBase64(bytes) {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function browserHttpRequest(args = {}) {
  const target = String(args.url || "").trim();
  if (!target) throw new Error("请输入请求 URL");
  if (!/^https?:\/\//i.test(target)) throw new Error("URL 需以 http:// 或 https:// 开头");

  const method = String(args.method || "GET").toUpperCase();
  const headers = new Headers();
  for (const item of Array.isArray(args.headers) ? args.headers : []) {
    const [key, value] = Array.isArray(item) ? item : [item?.name, item?.value];
    if (key && String(key).trim()) headers.set(String(key).trim(), String(value ?? ""));
  }
  const hasBody = args.body != null && args.body !== "" && method !== "GET" && method !== "HEAD";
  const limit = Math.min(Math.max(Number(args.timeoutMs ?? args.timeout_ms) || 30000, 1000), 120000);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limit);
  const started = Date.now();
  try {
    const response = await fetch(target, {
      method,
      headers,
      body: hasBody ? args.body : undefined,
      signal: controller.signal,
      redirect: "follow",
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const payload = {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers.entries()],
      durationMs: Date.now() - started,
      size: bytes.byteLength,
    };
    // 与 Rust 侧一致：合法 UTF-8 返回文本；二进制另附 bodyBase64 供原样落盘
    try {
      payload.body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      payload.body = new TextDecoder("utf-8").decode(bytes);
      payload.bodyBase64 = bytesToBase64(bytes);
    }
    return payload;
  } catch (error) {
    if (error && error.name === "AbortError") throw new Error(`请求超时（${limit}ms）`);
    throw new Error(`请求失败：${(error && error.message) || error}`);
  } finally {
    clearTimeout(timer);
  }
}
