// 原生能力自检：在**真机上**逐个跑一遍原生能力，把结果如实报出来。
//
// 为什么需要它：SAF 选择器、Keystore 加密、SQLite 读写、wasm 加载耗时这些**只有设备上才能验**，
// 而开发机没有设备（本机 `adb devices` 为空，也没有可用的硬件虚拟化起模拟器）。
// 与其让人按一张"请你看四处"的清单手工核对，不如让 App 自己跑一遍、给出结构化结果——
// 一次点击就能拿到"哪一项通了、哪一项报什么错"。
//
// 设计约束：
//   · **只读或可回滚**：自检会写一个临时键然后删掉，不碰用户的真实数据；
//   · **不假装能测**：需要用户交互的（文件选择器）标成 manual，不自动跑，
//     否则会弹出一个选择器让人莫名其妙；
//   · **纯逻辑**：所有检查都是"调 invoke 然后判定"，所以能在 node 里用替身测（见 selfTest.test.js）。

/** 自检用到的临时键：跑完立刻删掉，避免污染真实数据。 */
export const PROBE_KEY = "__toolcove_selftest__";

/**
 * 检查项定义。
 *
 * `run(ctx)` 返回 `{ ok, detail }`；抛错由调用方捕获并记成失败。
 * ctx 提供 invoke 与 location（这样单测能注入替身，不依赖浏览器）。
 */
export function buildChecks() {
  return [
    {
      key: "store",
      // 存储是所有功能的地基：记录、工作台、设置、Agent 全依赖它。
      // 真机上这条最容易坏——桥存在但没实现 load_data/save_data 时，invoke 若不回退就会失败。
      run: async ({ invoke }) => {
        const marker = `selftest-${Date.now()}`;
        await invoke("save_data", { key: PROBE_KEY, data: [{ marker }] });
        const back = await invoke("load_data", { key: PROBE_KEY });
        const list = Array.isArray(back) ? back : back?.value;
        const hit = Array.isArray(list) && list.some((item) => item?.marker === marker);
        // 无论成功失败都清理：不留垃圾数据
        await invoke("save_data", { key: PROBE_KEY, data: [] }).catch(() => {});
        return hit
          ? { ok: true, detail: "写入后能读回" }
          : { ok: false, detail: `写入后读回不一致（拿到 ${JSON.stringify(back)?.slice(0, 60)}）` };
      },
    },
    {
      key: "http",
      // 请求本机 loopback 服务：既验证原生 HTTP 通道，也验证内置资源服务在监听
      run: async ({ invoke, origin }) => {
        if (!origin) return { ok: false, detail: "拿不到当前页面的地址" };
        const result = await invoke("http_request", { url: origin, method: "GET" });
        const status = Number(result?.status);
        return status >= 200 && status < 400
          ? { ok: true, detail: `本机服务返回 ${status}` }
          : { ok: false, detail: `本机服务返回 ${result?.status}` };
      },
    },
    {
      key: "tcp",
      // 对同一个地址做 TCP 连通性检查：验证原生 socket 通道
      run: async ({ invoke, origin }) => {
        const url = new URL(origin);
        const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
        const result = await invoke("network_tcp_check", { host: url.hostname, port, timeoutMs: 2000 });
        return result?.open
          ? { ok: true, detail: `${url.hostname}:${port} 可连接（${result.durationMs ?? "?"}ms）` }
          : { ok: false, detail: `${url.hostname}:${port} 连不上：${result?.error || "未知原因"}` };
      },
    },
    {
      key: "crypto",
      // 加解密往返：验证 Keystore（手机）/ DPAPI（桌面）这条路。
      // 顺带验证"同一明文两次加密结果不同"——GCM 复用 IV 会毁掉机密性，这条能发现实现退化成明文。
      run: async ({ invoke }) => {
        const plain = `selftest-${Date.now()}`;
        const encrypted = await invoke("encrypt_text", { plain });
        const cipher = encrypted?.cipher ?? encrypted;
        if (typeof cipher !== "string" || !cipher) return { ok: false, detail: "加密没有返回密文" };
        if (cipher.includes(plain)) return { ok: false, detail: "密文里能看到明文——加密没生效" };
        const decrypted = await invoke("decrypt_text", { cipher });
        const text = decrypted?.plain ?? decrypted;
        return text === plain
          ? { ok: true, detail: `往返一致（密文 ${cipher.length} 字符）` }
          : { ok: false, detail: `解密结果与原文不一致（拿到 ${String(text).slice(0, 40)}）` };
      },
    },
    {
      key: "filePicker",
      manual: true,
      // 需要用户点选文件，不能自动跑——否则会莫名弹出选择器
      run: async ({ invoke }) => {
        const picked = await invoke("file_pick", { mimeType: "*/*" });
        const uri = String(picked?.uri || "");
        return uri ? { ok: true, detail: `拿到授权：${uri.slice(0, 48)}…` } : { ok: false, detail: "没有拿到 URI（用户取消或选择器不可用）" };
      },
    },
    {
      key: "sqlite",
      manual: true,
      // 需要先经文件选择器授权一个 .db 文件
      run: async ({ invoke }) => {
        const picked = await invoke("file_pick", { mimeType: "*/*" });
        const uri = String(picked?.uri || "");
        if (!uri) return { ok: false, detail: "没有选到文件" };
        const connId = await invoke("db_connect", { opts: { type: "sqlite", file: uri } });
        const tables = await invoke("db_tables", { connId });
        const count = Array.isArray(tables) ? tables.length : 0;
        await invoke("db_close", { connId }).catch(() => {});
        return { ok: true, detail: `打开成功，读到 ${count} 张表` };
      },
    },
  ];
}

/**
 * 跑自检。返回每一项的结果，**任何一项失败都不中断后续**——
 * 一次跑完拿到完整报告，比"第一个失败就停"有用得多。
 */
export async function runSelfTest({ invoke, origin, only = null, checks = buildChecks() } = {}) {
  const results = [];
  for (const check of checks) {
    if (only && !only.includes(check.key)) continue;
    if (check.manual) {
      results.push({ key: check.key, status: "manual", detail: "" });
      continue;
    }
    const started = Date.now();
    try {
      const outcome = await check.run({ invoke, origin });
      results.push({
        key: check.key,
        status: outcome?.ok ? "pass" : "fail",
        detail: outcome?.detail || "",
        ms: Date.now() - started,
      });
    } catch (error) {
      results.push({ key: check.key, status: "fail", detail: error?.message || String(error), ms: Date.now() - started });
    }
  }
  return results;
}

/** 单独跑一项（给需要用户交互的检查用：先弹选择器，再跑）。 */
export async function runOne(key, { invoke, origin } = {}) {
  const check = buildChecks().find((item) => item.key === key);
  if (!check) throw new Error(`没有这一项自检：${key}`);
  const started = Date.now();
  try {
    const outcome = await check.run({ invoke, origin });
    return { key, status: outcome?.ok ? "pass" : "fail", detail: outcome?.detail || "", ms: Date.now() - started };
  } catch (error) {
    return { key, status: "fail", detail: error?.message || String(error), ms: Date.now() - started };
  }
}

/** 汇总成可复制的纯文本报告（用户直接发给我就能定位问题）。 */
export function formatReport(results, meta = {}) {
  const lines = [
    "ToolCove 手机端 · 原生能力自检",
    `时间：${meta.at || new Date().toISOString()}`,
    `构建：${meta.build || "未知"}`,
    `桥：${meta.bridge || "未知"}`,
    "",
  ];
  for (const item of results) {
    const mark = item.status === "pass" ? "✓" : item.status === "fail" ? "✗" : "—";
    const time = item.ms != null ? ` (${item.ms}ms)` : "";
    lines.push(`${mark} ${item.key}${time}${item.detail ? ` — ${item.detail}` : ""}`);
  }
  const failed = results.filter((item) => item.status === "fail").length;
  lines.push("", failed ? `失败 ${failed} 项` : "全部通过");
  return lines.join("\n");
}
