import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("../../platform/invoke.js", () => ({ invoke: invokeMock }));

import {
  cancelRemote,
  fetchUserWorkflow,
  historyOf,
  interrupt,
  listModels,
  listUserWorkflows,
  probe,
  queueDelete,
  queueState,
  runJob,
  submitWorkflow,
} from "./comfyClient.js";

const json = (status, body) => ({ status, body: JSON.stringify(body) });
const BASE = "http://127.0.0.1:8188";

beforeEach(() => {
  invokeMock.mockReset();
});

function routeHttp(handlers) {
  invokeMock.mockImplementation(async (cmd, args) => {
    if (cmd !== "http_request") throw new Error("unexpected cmd " + cmd);
    const match = Object.entries(handlers).find(([needle]) => String(args.url).includes(needle));
    if (!match) throw new Error("unexpected url " + args.url);
    return typeof match[1] === "function" ? match[1](args) : match[1];
  });
}

describe("comfyClient：探活与列举", () => {
  it("probe 成功带版本号；HTTP 错误抽 error.message；传输异常原文透传", async () => {
    routeHttp({ "/system_stats": json(200, { system: { comfyui_version: "0.3.40" } }) });
    expect(await probe(BASE)).toEqual({ ok: true, version: "0.3.40", error: "" });

    routeHttp({ "/system_stats": json(500, { error: { message: "boom" } }) });
    expect(await probe(BASE)).toEqual({ ok: false, version: "", error: "HTTP 500：boom" });

    invokeMock.mockRejectedValue(new Error("连接被拒绝"));
    expect(await probe(BASE)).toEqual({ ok: false, version: "", error: "连接被拒绝" });
  });

  it("listModels 从全量 /object_info 收集各类模型；HTTP 错误与传输异常都降级为空清单", async () => {
    routeHttp({
      "/object_info": json(200, {
        CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } },
        UNETLoader: { input: { required: { unet_name: [["qwen.safetensors"]] } } },
        CLIPLoader: { input: { required: { clip_name: [["qwen3vl.safetensors"]] } } },
        VAELoader: { input: { required: { vae_name: [["qwen_vae.safetensors"]] } } },
      }),
    });
    const ok = await listModels(BASE);
    expect(ok.ok).toBe(true);
    expect(ok.models.checkpoints).toEqual([]);
    expect(ok.models.diffusionModels).toEqual(["qwen.safetensors"]);
    expect(ok.models.textEncoders).toEqual(["qwen3vl.safetensors"]);
    expect(ok.models.vaes).toEqual(["qwen_vae.safetensors"]);

    routeHttp({ "/object_info": json(500, { error: { message: "boom" } }) });
    expect(await listModels(BASE)).toMatchObject({ ok: false, error: "HTTP 500：boom" });

    invokeMock.mockRejectedValue(new Error("连接被拒绝"));
    expect(await listModels(BASE)).toMatchObject({ ok: false, error: "连接被拒绝" });
  });

  it("listUserWorkflows 读 /userdata 工作流目录；兼容字符串与对象两种条目", async () => {
    routeHttp({ "/userdata?dir=workflows": json(200, ["a.json", { name: "sub/b.json" }]) });
    expect(await listUserWorkflows(BASE)).toEqual({ ok: true, names: ["a.json", "sub/b.json"], error: "" });

    routeHttp({ "/userdata?dir=workflows": json(404, { error: "nope" }) });
    expect(await listUserWorkflows(BASE)).toMatchObject({ ok: false, names: [], error: "HTTP 404：nope" });
  });

  it("fetchUserWorkflow 整段编码 workflows/ 前缀（斜杠也必须编码）", async () => {
    routeHttp({ "/userdata/": json(200, { nodes: [], links: [] }) });
    expect(await fetchUserWorkflow(BASE, "（越狱版）a.json")).toEqual({
      ok: true,
      data: { nodes: [], links: [] },
      error: "",
    });
    expect(invokeMock.mock.calls[0][1].url).toBe(
      `${BASE}/userdata/${encodeURIComponent("workflows/（越狱版）a.json")}`
    );
    expect(invokeMock.mock.calls[0][1].url).toContain("workflows%2F");
  });
});

describe("comfyClient：提交与查询", () => {
  it("submitWorkflow 成功返回 promptId，body 带 prompt 与 client_id", async () => {
    routeHttp({ "/prompt": (args) => {
      const body = JSON.parse(args.body);
      expect(body.client_id).toBe("cid-1");
      expect(body.prompt["6"].inputs.text).toBe("猫");
      return json(200, { prompt_id: "pid-1", node_errors: {} });
    } });
    const result = await submitWorkflow(BASE, { "6": { class_type: "CLIPTextEncode", inputs: { text: "猫" } } }, "cid-1");
    expect(result).toEqual({ ok: true, promptId: "pid-1", nodeErrors: [], error: "" });
  });

  it("node_errors 非空判失败并摊平；HTTP 非 2xx 抽错误；缺 prompt_id 判失败", async () => {
    routeHttp({ "/prompt": json(200, { node_errors: { "3": { class_type: "KSampler", errors: [{ message: "非法值" }] } } }) });
    const bad = await submitWorkflow(BASE, {}, "cid");
    expect(bad.ok).toBe(false);
    expect(bad.nodeErrors).toEqual([{ node: "3", classType: "KSampler", message: "非法值" }]);

    routeHttp({ "/prompt": json(400, { error: { message: "bad prompt" } }) });
    expect((await submitWorkflow(BASE, {}, "cid")).error).toBe("HTTP 400：bad prompt");

    routeHttp({ "/prompt": json(200, { node_errors: {} }) });
    expect((await submitWorkflow(BASE, {}, "cid")).error).toContain("未返回任务 ID");
  });

  it("historyOf / queueState 的条目与错误形状", async () => {
    routeHttp({ "/history/pid": json(200, { pid: { outputs: {}, status: { status_str: "success" } } }) });
    const history = await historyOf(BASE, "pid");
    expect(history.ok).toBe(true);
    expect(history.entry.status.status_str).toBe("success");

    routeHttp({ "/history/empty": json(200, {}) });
    expect((await historyOf(BASE, "empty")).entry).toBeNull();

    routeHttp({ "/queue": json(200, { queue_running: [], queue_pending: [] }) });
    expect((await queueState(BASE)).ok).toBe(true);
  });
});

describe("comfyClient：取消", () => {
  it("运行中 → /interrupt；排队中 → /queue delete；不在队列 → gone", async () => {
    const calls = [];
    invokeMock.mockImplementation(async (cmd, args) => {
      calls.push([args.method, args.url, args.body]);
      if (args.url.endsWith("/queue") && args.method === "GET") return json(200, { queue_running: [[0, "run-1"]], queue_pending: [] });
      if (args.url.endsWith("/interrupt")) return json(200, {});
      throw new Error("unexpected " + args.url);
    });
    expect(await cancelRemote(BASE, "run-1")).toBe("interrupt");
    expect(calls.some(([, url]) => url.endsWith("/interrupt"))).toBe(true);

    calls.length = 0;
    invokeMock.mockImplementation(async (cmd, args) => {
      calls.push([args.method, args.url, args.body]);
      if (args.url.endsWith("/queue") && args.method === "GET") return json(200, { queue_running: [], queue_pending: [[1, "wait-1"]] });
      return json(200, {});
    });
    expect(await cancelRemote(BASE, "wait-1")).toBe("delete");
    expect(JSON.parse(calls.at(-1)[2])).toEqual({ delete: ["wait-1"] });

    invokeMock.mockImplementation(async (cmd, args) => json(200, { queue_running: [], queue_pending: [] }));
    expect(await cancelRemote(BASE, "gone-1")).toBe("gone");

    invokeMock.mockRejectedValue(new Error("断网"));
    expect(await cancelRemote(BASE, "x")).toBe("error");
  });

  it("interrupt / queueDelete 的 HTTP 错误处理", async () => {
    routeHttp({ "/interrupt": json(500, { error: "oops" }) });
    expect((await interrupt(BASE)).ok).toBe(false);
    routeHttp({ "/queue": json(403, {}) });
    expect((await queueDelete(BASE, "p")).ok).toBe(false);
  });
});

describe("comfyClient：runJob", () => {
  function fakeSocket() {
    const handlers = {};
    return {
      addEventListener: (type, fn) => {
        handlers[type] = fn;
      },
      emit: (type, data) => handlers[type]?.({ data }),
      close: vi.fn(),
    };
  }

  function happyTransport({ onHistory, socket } = {}) {
    let historyCalls = 0;
    const fetches = [];
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "media_fetch_stream") {
        fetches.push(args);
        return { name: args.name, path: `C:/media/${args.name}`, bytes: 2048 };
      }
      if (cmd !== "http_request") throw new Error("unexpected cmd " + cmd);
      if (args.url.endsWith("/prompt")) return json(200, { prompt_id: "pid-1", node_errors: {} });
      if (args.url.includes("/history/pid-1")) {
        historyCalls += 1;
        onHistory?.(historyCalls, socket);
        if (historyCalls < 2) return json(200, {});
        return json(200, {
          "pid-1": {
            outputs: {
              "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
              "10": { gifs: [{ filename: "v.mp4", subfolder: "", type: "output" }] },
            },
            status: { status_str: "success" },
          },
        });
      }
      if (args.url.endsWith("/queue")) return json(200, { queue_running: [], queue_pending: [] });
      throw new Error("unexpected url " + args.url);
    });
    return { fetches };
  }

  it("happy path：提交 → 轮询 → 流式落盘，WS 进度生效", async () => {
    const socket = fakeSocket();
    const progress = [];
    const { fetches } = happyTransport({
      socket,
      onHistory: (call) => {
        if (call === 1) socket.emit("message", JSON.stringify({ type: "progress", data: { value: 2, max: 10, prompt_id: "pid-1" } }));
      },
    });
    const result = await runJob({
      base: BASE,
      workflow: { "1": { class_type: "X", inputs: {} } },
      onProgress: (event) => progress.push(event),
      pollIntervalMs: 1,
      wsFactory: () => socket,
      nameFor: () => "fixed.png",
    });
    expect(result.status).toBe("done");
    expect(result.files.map((f) => f.name)).toEqual(["fixed.png", "fixed.png"]);
    expect(result.files.map((f) => f.kind)).toEqual(["image", "video"]);
    expect(result.failed).toEqual([]);
    expect(fetches.map((f) => f.url)).toEqual([
      `${BASE}/view?filename=a.png&subfolder=&type=output`,
      `${BASE}/view?filename=v.mp4&subfolder=&type=output`,
    ]);
    expect(progress.some((e) => e.status === "running" && e.step === 2 && e.max === 10)).toBe(true);
    expect(progress.some((e) => e.status === "downloading")).toBe(true);
    expect(socket.close).toHaveBeenCalled();
  });

  it("node_errors：不进入等待循环，直接回 nodeErrors", async () => {
    invokeMock.mockImplementation(async (cmd, args) => {
      if (args.url.endsWith("/prompt")) return json(200, { node_errors: { "3": { class_type: "KSampler", errors: [{ message: "非法值" }] } } });
      throw new Error("不该走到 " + args.url);
    });
    const result = await runJob({ base: BASE, workflow: {}, pollIntervalMs: 1, wsFactory: () => fakeSocket() });
    expect(result.status).toBe("error");
    expect(result.code).toBe("nodeErrors");
    expect(result.nodeErrors).toHaveLength(1);
  });

  it("执行错误 / 无输出 / 下载全失败 / 超时 / 取消 各有明确 code", async () => {
    // 执行错误
    invokeMock.mockImplementation(async (cmd, args) => {
      if (args.url.endsWith("/prompt")) return json(200, { prompt_id: "pid-1", node_errors: {} });
      return json(200, { "pid-1": { outputs: {}, status: { status_str: "error", messages: [["execution_error", { exception_message: "CUDA OOM" }]] } } });
    });
    let result = await runJob({ base: BASE, workflow: {}, pollIntervalMs: 1, wsFactory: () => fakeSocket() });
    expect(result.status).toBe("error");
    expect(result.code).toBe("execution");
    expect(result.error).toBe("CUDA OOM");

    // 无输出
    invokeMock.mockImplementation(async (cmd, args) => {
      if (args.url.endsWith("/prompt")) return json(200, { prompt_id: "pid-1", node_errors: {} });
      return json(200, { "pid-1": { outputs: {}, status: { status_str: "success" } } });
    });
    result = await runJob({ base: BASE, workflow: {}, pollIntervalMs: 1, wsFactory: () => fakeSocket() });
    expect(result.code).toBe("noOutputs");

    // 下载全失败
    invokeMock.mockImplementation(async (cmd, args) => {
      if (cmd === "media_fetch_stream") throw new Error("磁盘满");
      if (args.url.endsWith("/prompt")) return json(200, { prompt_id: "pid-1", node_errors: {} });
      return json(200, { "pid-1": { outputs: { "9": { images: [{ filename: "a.png" }] } }, status: { status_str: "success" } } });
    });
    result = await runJob({ base: BASE, workflow: {}, pollIntervalMs: 1, wsFactory: () => fakeSocket() });
    expect(result.code).toBe("downloadFailed");
    expect(result.failed[0].error).toBe("磁盘满");

    // 超时
    invokeMock.mockImplementation(async (cmd, args) => {
      if (args.url.endsWith("/prompt")) return json(200, { prompt_id: "pid-1", node_errors: {} });
      return json(200, {});
    });
    result = await runJob({ base: BASE, workflow: {}, pollIntervalMs: 1, timeoutMs: -1, wsFactory: () => fakeSocket() });
    expect(result.code).toBe("timeout");

    // 取消
    invokeMock.mockImplementation(async (cmd, args) => {
      if (args.url.endsWith("/prompt")) return json(200, { prompt_id: "pid-1", node_errors: {} });
      return json(200, {});
    });
    const controller = new AbortController();
    const promise = runJob({ base: BASE, workflow: {}, pollIntervalMs: 5, signal: controller.signal, wsFactory: () => fakeSocket() });
    controller.abort();
    result = await promise;
    expect(result.status).toBe("canceled");
    expect(result.promptId).toBe("pid-1");
  });

  it("wsFactory 抛错只上报 wsLost，不失败任务", async () => {
    happyTransport();
    const progress = [];
    const result = await runJob({
      base: BASE,
      workflow: {},
      onProgress: (event) => progress.push(event),
      pollIntervalMs: 1,
      wsFactory: () => {
        throw new Error("no ws");
      },
    });
    expect(result.status).toBe("done");
    expect(progress.some((e) => e.wsLost)).toBe(true);
  });
});
