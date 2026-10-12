import { describe, expect, it } from "vitest";
import {
  buildTxt2ImgWorkflow,
  classifyHistoryOutputs,
  decideCancel,
  DEFAULT_COMFY_BASE,
  extractCheckpoints,
  historyErrorText,
  injectMapping,
  newClientId,
  normalizeComfyBase,
  parseComfyWsMessage,
  parseWorkflowGraph,
  summarizeNodeErrors,
  viewUrl,
  wsUrl,
} from "./comfy.js";

const API_WORKFLOW = {
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base.safetensors" }, _meta: { title: "加载模型" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "a cat", clip: ["4", 1] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "lowres", clip: ["4", 1] } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } },
  "3": {
    class_type: "KSampler",
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 7,
      sampler_name: "euler",
      scheduler: "normal",
      denoise: 1,
      model: ["4", 0],
      positive: ["6", 0],
      negative: ["7", 0],
      latent_image: ["5", 0],
    },
  },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
};

describe("ComfyUI：地址归一", () => {
  it("留空回默认；缺协议补 http://；去尾斜杠；https 保留", () => {
    expect(normalizeComfyBase("")).toBe(DEFAULT_COMFY_BASE);
    expect(normalizeComfyBase(null)).toBe(DEFAULT_COMFY_BASE);
    expect(normalizeComfyBase("127.0.0.1:8188")).toBe("http://127.0.0.1:8188");
    expect(normalizeComfyBase("http://192.168.1.5:8188///")).toBe("http://192.168.1.5:8188");
    expect(normalizeComfyBase("https://comfy.example.com")).toBe("https://comfy.example.com");
  });

  it("wsUrl 换协议", () => {
    expect(wsUrl("http://127.0.0.1:8188")).toBe("ws://127.0.0.1:8188/ws");
    expect(wsUrl("https://x")).toBe("wss://x/ws");
  });

  it("newClientId 非空且各不相同", () => {
    const a = newClientId();
    expect(a.length).toBeGreaterThan(4);
    expect(a).not.toBe(newClientId());
  });
});

describe("ComfyUI：内置文生图图构造", () => {
  it("标准 7 节点结构与链接正确", () => {
    const graph = buildTxt2ImgWorkflow({ checkpoint: "m.safetensors", positive: "猫", negative: "糊", seed: 7, width: 768, height: 1024 });
    expect(Object.keys(graph).sort()).toEqual(["3", "4", "5", "6", "7", "8", "9"]);
    expect(graph["4"].inputs.ckpt_name).toBe("m.safetensors");
    expect(graph["6"].inputs).toEqual({ text: "猫", clip: ["4", 1] });
    expect(graph["7"].inputs.text).toBe("糊");
    expect(graph["5"].inputs).toEqual({ width: 768, height: 1024, batch_size: 1 });
    expect(graph["3"].inputs.positive).toEqual(["6", 0]);
    expect(graph["3"].inputs.negative).toEqual(["7", 0]);
    expect(graph["3"].inputs.latent_image).toEqual(["5", 0]);
    expect(graph["3"].inputs.seed).toBe(7);
    expect(graph["8"].inputs.samples).toEqual(["3", 0]);
    expect(graph["9"].inputs.images).toEqual(["8", 0]);
  });

  it("数值脏输入被钳制而不是原样进图", () => {
    const graph = buildTxt2ImgWorkflow({ checkpoint: "m", seed: -3, steps: 0, denoise: Number.NaN });
    expect(graph["3"].inputs.seed).toBe(0);
    expect(graph["3"].inputs.steps).toBe(20);
    expect(graph["3"].inputs.denoise).toBe(1);
  });
});

describe("ComfyUI：checkpoint 提取", () => {
  it("单节点响应与全量 object_info 都能取到；缺失返回空数组", () => {
    const single = { CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors", "b.ckpt"], { tooltip: "" }] } } } };
    expect(extractCheckpoints(single)).toEqual(["a.safetensors", "b.ckpt"]);
    expect(extractCheckpoints({ CheckpointLoaderSimple: single.CheckpointLoaderSimple })).toEqual(["a.safetensors", "b.ckpt"]);
    expect(extractCheckpoints({})).toEqual([]);
    expect(extractCheckpoints(null)).toEqual([]);
  });
});

describe("ComfyUI：工作流解析与映射", () => {
  it("API 格式解析出节点清单与自动映射建议", () => {
    const parsed = parseWorkflowGraph(JSON.stringify(API_WORKFLOW));
    expect(parsed.ok).toBe(true);
    expect(parsed.nodes.map((n) => n.id).sort()).toEqual(["3", "4", "5", "6", "7", "9"]);
    expect(parsed.nodes.find((n) => n.id === "4").title).toBe("加载模型");
    expect(parsed.suggestion.positive).toEqual({ node: "6", input: "text" });
    expect(parsed.suggestion.negative).toEqual({ node: "7", input: "text" });
    expect(parsed.suggestion.params).toEqual({ node: "3" });
    expect(parsed.suggestion.latent).toEqual({ node: "5" });
  });

  it("界面格式（带 nodes/links）明确拒绝；坏 JSON / 空 / 错形状各有错误码", () => {
    expect(parseWorkflowGraph('{"nodes":[],"links":[]}').error).toBe("uiFormat");
    expect(parseWorkflowGraph("{oops").error).toBe("badJson");
    expect(parseWorkflowGraph("  ").error).toBe("empty");
    expect(parseWorkflowGraph({ a: { inputs: {} } }).error).toBe("badShape");
    expect(parseWorkflowGraph([1, 2]).error).toBe("badShape");
  });

  it("injectMapping：不改原对象、只写已存在键、自定义节点不被打坏", () => {
    const original = JSON.parse(JSON.stringify(API_WORKFLOW));
    const parsed = parseWorkflowGraph(API_WORKFLOW);
    const { workflow, skipped } = injectMapping(parsed.workflow, parsed.suggestion, {
      positive: "新的正向",
      negative: "新的负向",
      seed: 123,
    });
    expect(workflow["6"].inputs.text).toBe("新的正向");
    expect(workflow["7"].inputs.text).toBe("新的负向");
    expect(workflow["3"].inputs.seed).toBe(123);
    expect(original["6"].inputs.text).toBe("a cat");
    expect(parsed.workflow["6"].inputs.text).toBe("a cat");
    expect(skipped).toEqual([]);

    const custom = {
      "1": { class_type: "CustomSamplerNode", inputs: { noise_seed: 1, positive: ["2", 0] } },
      "2": { class_type: "CLIPTextEncode", inputs: { text: "t" } },
    };
    const customParsed = parseWorkflowGraph(custom);
    const result = injectMapping(customParsed.workflow, customParsed.suggestion, { positive: "p", seed: 9 });
    expect(result.workflow["1"].inputs.noise_seed).toBe(1); // 没有 seed 键就不硬塞
    expect(result.workflow["2"].inputs.text).toBe("p");
  });

  it("负向为空不注入（不覆盖工作流自带负向）；映射失效记 skipped", () => {
    const parsed = parseWorkflowGraph(API_WORKFLOW);
    const { workflow } = injectMapping(parsed.workflow, parsed.suggestion, { positive: "p", negative: "   " });
    expect(workflow["7"].inputs.text).toBe("lowres");

    const stale = injectMapping(parsed.workflow, { positive: { node: "不存在", input: "text" } }, { positive: "p" });
    expect(stale.skipped).toEqual(["positive"]);
  });

  it("overrideParams 打开才写采样参数与宽高，默认不动", () => {
    const parsed = parseWorkflowGraph(API_WORKFLOW);
    const defaults = injectMapping(parsed.workflow, parsed.suggestion, { positive: "p", steps: 8, width: 512 });
    expect(defaults.workflow["3"].inputs.steps).toBe(20);
    expect(defaults.workflow["5"].inputs.width).toBe(832);

    const overridden = injectMapping(
      parsed.workflow,
      parsed.suggestion,
      { positive: "p", steps: 8, cfg: 3, samplerName: "ddim", scheduler: "karras", denoise: 0.5, width: 512, height: 512 },
      { overrideParams: true }
    );
    expect(overridden.workflow["3"].inputs.steps).toBe(8);
    expect(overridden.workflow["3"].inputs.cfg).toBe(3);
    expect(overridden.workflow["3"].inputs.sampler_name).toBe("ddim");
    expect(overridden.workflow["3"].inputs.scheduler).toBe("karras");
    expect(overridden.workflow["3"].inputs.denoise).toBe(0.5);
    expect(overridden.workflow["5"].inputs.width).toBe(512);
    expect(overridden.workflow["5"].inputs.height).toBe(512);
  });
});

describe("ComfyUI：历史输出与取消", () => {
  it("classifyHistoryOutputs 扫全部输出：images 与 gifs(mp4) 混放、按扩展名分类、跳过未知", () => {
    const entry = {
      outputs: {
        "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
        "10": { gifs: [{ filename: "v.mp4", subfolder: "sub", type: "output", format: "video/h264-mp4" }] },
        "11": { images: [{ filename: "a.png", subfolder: "", type: "output" }, { filename: "note.txt", subfolder: "", type: "output" }] },
      },
    };
    const files = classifyHistoryOutputs(entry);
    expect(files).toEqual([
      { filename: "a.png", subfolder: "", type: "output", kind: "image" },
      { filename: "v.mp4", subfolder: "sub", type: "output", kind: "video" },
    ]);
  });

  it("viewUrl 带 filename/subfolder/type 三元组", () => {
    const url = viewUrl("http://127.0.0.1:8188", { filename: "a b.png", subfolder: "x/y", type: "output" });
    expect(url).toBe("http://127.0.0.1:8188/view?filename=a+b.png&subfolder=x%2Fy&type=output");
  });

  it("historyErrorText 只对 error 状态取 exception_message", () => {
    expect(historyErrorText({ status: { status_str: "success" } })).toBe("");
    const message = historyErrorText({
      status: { status_str: "error", messages: [["execution_error", { exception_message: "CUDA out of memory" }]] },
    });
    expect(message).toBe("CUDA out of memory");
  });

  it("decideCancel 按 /queue 判断 interrupt / delete / gone", () => {
    const queue = { queue_running: [[0, "pid-run"]], queue_pending: [[1, "pid-wait"]] };
    expect(decideCancel(queue, "pid-run")).toBe("interrupt");
    expect(decideCancel(queue, "pid-wait")).toBe("delete");
    expect(decideCancel(queue, "pid-missing")).toBe("gone");
    expect(decideCancel(null, "x")).toBe("gone");
  });

  it("summarizeNodeErrors 摊平为节点清单", () => {
    const rows = summarizeNodeErrors({ "3": { class_type: "KSampler", errors: [{ message: "值非法" }, { type: "required" }] } });
    expect(rows).toEqual([
      { node: "3", classType: "KSampler", message: "值非法" },
      { node: "3", classType: "KSampler", message: "required" },
    ]);
    expect(summarizeNodeErrors(null)).toEqual([]);
  });
});

describe("ComfyUI：WS 消息解析", () => {
  it("progress / executing / success / error / status 归一；未知与坏帧返回 null", () => {
    expect(parseComfyWsMessage(JSON.stringify({ type: "progress", data: { value: 3, max: 20, prompt_id: "p1", node: "3" } }))).toEqual({
      type: "progress",
      promptId: "p1",
      node: "3",
      value: 3,
      max: 20,
    });
    expect(parseComfyWsMessage(JSON.stringify({ type: "executing", data: { node: null, prompt_id: "p1" } }))).toEqual({
      type: "executing",
      promptId: "p1",
      node: null,
    });
    expect(parseComfyWsMessage(JSON.stringify({ type: "execution_success", data: { prompt_id: "p1" } }))).toEqual({ type: "success", promptId: "p1" });
    expect(parseComfyWsMessage(JSON.stringify({ type: "execution_error", data: { prompt_id: "p1", exception_message: "boom" } }))).toEqual({
      type: "error",
      promptId: "p1",
      message: "boom",
    });
    expect(parseComfyWsMessage(JSON.stringify({ type: "status", data: { status: { exec_info: { queue_remaining: 2 } } } }))).toEqual({
      type: "status",
      queueRemaining: 2,
    });
    expect(parseComfyWsMessage(JSON.stringify({ type: "crystools.monitor", data: {} }))).toBeNull();
    expect(parseComfyWsMessage("不是 JSON")).toBeNull();
    expect(parseComfyWsMessage(new Uint8Array([1, 2]))).toBeNull();
  });
});
