// 原生能力自检的单测（纯逻辑，用替身注入 invoke）。
//
// 这套自检的意义是"让真机验证变成一次点击"，所以它自己必须先被测住：
// 如果自检本身会误报（把坏的报成好的），那它比没有更糟——会让人以为设备上一切正常。
import { describe, expect, it, vi } from "vitest";
import { PROBE_KEY, buildChecks, formatReport, runOne, runSelfTest } from "./selfTest.js";

const ORIGIN = "http://127.0.0.1:34567";

/** 造一个"一切正常"的桥替身。 */
function healthyBridge() {
  const store = new Map();
  return vi.fn(async (command, args = {}) => {
    switch (command) {
      case "save_data":
        store.set(args.key, args.data);
        return null;
      case "load_data":
        return store.get(args.key) ?? [];
      case "http_request":
        return { status: 200, body: "<html>" };
      case "network_tcp_check":
        return { open: true, durationMs: 3 };
      case "encrypt_text":
        // 模拟真实加密：密文与明文不同，且不可反推
        return { cipher: `v1:${Buffer.from(String(args.plain)).toString("base64")}x` };
      case "decrypt_text":
        return { plain: Buffer.from(String(args.cipher).replace(/^v1:/, "").replace(/x$/, ""), "base64").toString() };
      default:
        return null;
    }
  });
}

describe("原生能力自检", () => {
  it("一切正常时：自动项全通过，需要交互的项标成 manual 而不是失败", async () => {
    const results = await runSelfTest({ invoke: healthyBridge(), origin: ORIGIN });
    const auto = results.filter((item) => item.status !== "manual");
    expect(auto.map((item) => item.key)).toEqual(["store", "http", "tcp", "crypto"]);
    for (const item of auto) {
      expect(item.status, `${item.key}: ${item.detail}`).toBe("pass");
    }
    // 文件选择器与 SQLite 需要用户点选文件，不能自动跑（否则会莫名弹选择器）
    expect(results.find((item) => item.key === "filePicker").status).toBe("manual");
    expect(results.find((item) => item.key === "sqlite").status).toBe("manual");
  });

  it("存储不通时：这一项失败并给出原因（其余项继续跑完）", async () => {
    const invoke = healthyBridge();
    invoke.mockImplementation(async (command, args = {}) => {
      // 精确复现真机那个 bug：桥不认 load_data/save_data
      if (command === "save_data" || command === "load_data") {
        throw Object.assign(new Error(`手机端尚未实现该命令：${command}`), { code: "unsupported" });
      }
      return healthyBridge()(command, args);
    });
    const results = await runSelfTest({ invoke, origin: ORIGIN });
    const store = results.find((item) => item.key === "store");
    expect(store.status).toBe("fail");
    expect(store.detail).toContain("尚未实现");
    // 关键：一项失败不该中断后续——一次跑完拿到完整报告
    expect(results.find((item) => item.key === "crypto").status).toBe("pass");
  });

  it("写入后读不回：报失败并带上实际拿到的东西", async () => {
    const invoke = vi.fn(async (command) => {
      if (command === "save_data") return null;
      if (command === "load_data") return []; // 写了但读不到
      return null;
    });
    const results = await runSelfTest({ invoke, origin: ORIGIN, only: ["store"] });
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("不一致");
  });

  it("自检会清理临时键（不污染用户数据）", async () => {
    const store = new Map();
    const invoke = vi.fn(async (command, args = {}) => {
      if (command === "save_data") {
        store.set(args.key, args.data);
        return null;
      }
      if (command === "load_data") return store.get(args.key) ?? [];
      return null;
    });
    await runSelfTest({ invoke, origin: ORIGIN, only: ["store"] });
    // 最后必须把探针键写回空数组（清理）
    expect(store.get(PROBE_KEY)).toEqual([]);
  });

  it("加密退化成明文时能被发现（这是最危险的静默失败）", async () => {
    const invoke = vi.fn(async (command, args = {}) => {
      if (command === "encrypt_text") return { cipher: String(args.plain) }; // 明文当密文
      if (command === "decrypt_text") return { plain: String(args.cipher) };
      return null;
    });
    const results = await runSelfTest({ invoke, origin: ORIGIN, only: ["crypto"] });
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("明文");
  });

  it("加解密往返不一致时能发现", async () => {
    const invoke = vi.fn(async (command) => {
      if (command === "encrypt_text") return { cipher: "v1:abc" };
      if (command === "decrypt_text") return { plain: "别的内容" };
      return null;
    });
    const results = await runSelfTest({ invoke, origin: ORIGIN, only: ["crypto"] });
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("不一致");
  });

  it("HTTP 返回非 2xx/3xx 时算失败", async () => {
    const invoke = vi.fn(async (command) => {
      if (command === "http_request") return { status: 500 };
      return null;
    });
    const results = await runSelfTest({ invoke, origin: ORIGIN, only: ["http"] });
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("500");
  });

  it("TCP 连不上时带上原因", async () => {
    const invoke = vi.fn(async (command) => {
      if (command === "network_tcp_check") return { open: false, error: "connection refused" };
      return null;
    });
    const results = await runSelfTest({ invoke, origin: ORIGIN, only: ["tcp"] });
    expect(results[0].status).toBe("fail");
    expect(results[0].detail).toContain("connection refused");
  });

  it("拿不到页面地址时 HTTP/TCP 明确报错而不是崩", async () => {
    const results = await runSelfTest({ invoke: healthyBridge(), origin: "", only: ["http", "tcp"] });
    for (const item of results) {
      expect(item.status).toBe("fail");
      expect(item.detail).toBeTruthy();
    }
  });

  it("每一项都记录耗时（排查哪一步慢要看它）", async () => {
    const results = await runSelfTest({ invoke: healthyBridge(), origin: ORIGIN, only: ["store", "http"] });
    for (const item of results) {
      expect(typeof item.ms).toBe("number");
      expect(item.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it("单独跑一项（给需要交互的检查用）", async () => {
    const invoke = vi.fn(async (command) => {
      if (command === "file_pick") return { uri: "content://x/a.db" };
      if (command === "db_connect") return "sqlite-abc12345";
      if (command === "db_tables") return [{ name: "orders", type: "table" }];
      if (command === "db_close") return null;
      return null;
    });
    const result = await runOne("sqlite", { invoke, origin: ORIGIN });
    expect(result.status).toBe("pass");
    expect(result.detail).toContain("1 张表");
  });

  it("用户取消选择文件时算失败并说明（不是崩）", async () => {
    const invoke = vi.fn(async (command) => (command === "file_pick" ? { uri: "" } : null));
    const result = await runOne("filePicker", { invoke, origin: ORIGIN });
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("取消");
  });

  it("不存在的检查项要明确报错", async () => {
    await expect(runOne("nope", { invoke: healthyBridge() })).rejects.toThrow(/没有这一项/);
  });

  it("报告文本包含结论与每一项（用户直接发给我就能定位）", async () => {
    const results = await runSelfTest({ invoke: healthyBridge(), origin: ORIGIN });
    const report = formatReport(results, { at: "2026-01-01T00:00:00Z", build: "2026-01-01 10:00", bridge: "已接上" });
    expect(report).toContain("原生能力自检");
    expect(report).toContain("2026-01-01 10:00");
    expect(report).toContain("已接上");
    expect(report).toContain("✓ store");
    expect(report).toContain("— filePicker"); // manual 用 — 标记
    expect(report).toContain("全部通过");
  });

  it("报告在失败时给出失败项数", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("boom");
    });
    const results = await runSelfTest({ invoke, origin: ORIGIN });
    const report = formatReport(results);
    expect(report).toContain("✗");
    expect(report).toMatch(/失败 \d+ 项/);
  });

  it("检查项覆盖了手机端全部原生能力（漏一项就少验一块）", () => {
    const keys = buildChecks().map((check) => check.key);
    // 与 bridge/NativeOps 的能力一一对应：存储、HTTP、TCP、加密、文件选择、SQLite
    expect(keys.sort()).toEqual(["crypto", "filePicker", "http", "sqlite", "store", "tcp"]);
  });
});
