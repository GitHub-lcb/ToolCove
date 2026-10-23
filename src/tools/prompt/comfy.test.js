import { describe, expect, it } from "vitest";
import {
  buildTxt2ImgWorkflow,
  buildSplitTxt2ImgWorkflow,
  classifyHistoryOutputs,
  decideCancel,
  DEFAULT_COMFY_BASE,
  extractModels,
  fillMissingDefaults,
  historyErrorText,
  injectMapping,
  modelCount,
  newClientId,
  normalizeComfyBase,
  parseComfyWsMessage,
  parseWorkflowGraph,
  pickModelName,
  summarizeNodeErrors,
  uiToApiWorkflow,
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

describe("comfy：本机模型识别", () => {
  const OBJECT_INFO = {
    CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd_xl.safetensors"]] } } },
    UNETLoader: { input: { required: { unet_name: [["qwen_image_2.1.safetensors"]], weight_dtype: [["default", "fp8_e4m3fn"]] } } },
    UnetLoaderGGUF: { input: { required: { unet_name: [["qwen-image-2.1-Q8_0.gguf"]] } } },
    CLIPLoader: { input: { required: { clip_name: [["qwen3vl_8b.safetensors"]], type: [["qwen_image"]] } } },
    VAELoader: { input: { required: { vae_name: [["qwen_vae.safetensors", "pixel_space"]] } } },
    LoraLoader: { input: { required: { lora_name: [["turbo.safetensors"]], model: ["MODEL"], clip: ["CLIP"] } } },
  };

  it("按 loader 节点把 checkpoint / 扩散模型 / 文本编码器 / VAE / LoRA 分开收集", () => {
    const models = extractModels(OBJECT_INFO);
    expect(models.checkpoints).toEqual(["sd_xl.safetensors"]);
    expect(models.diffusionModels).toEqual(["qwen_image_2.1.safetensors", "qwen-image-2.1-Q8_0.gguf"]);
    expect(models.textEncoders).toEqual(["qwen3vl_8b.safetensors"]);
    expect(models.vaes).toEqual(["qwen_vae.safetensors", "pixel_space"]);
    expect(models.loras).toEqual(["turbo.safetensors"]);
    expect(modelCount(models)).toBe(7);
  });

  it("没有 checkpoint 但装了扩散模型时，不再误判为「本机没有模型」", () => {
    const models = extractModels({ ...OBJECT_INFO, CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } } });
    expect(models.checkpoints).toEqual([]);
    expect(modelCount(models)).toBe(6);
  });

  it("缺节点 / 空对象一律返回空清单，不抛错", () => {
    expect(modelCount(extractModels(null))).toBe(0);
    expect(modelCount(extractModels({}))).toBe(0);
  });
});

describe("comfy：界面格式 → API 格式", () => {
  const UI_WORKFLOW = {
    nodes: [
      {
        id: 451,
        type: "UnetLoaderGGUF",
        inputs: [{ name: "unet_name", type: "COMBO", widget: { name: "unet_name" }, link: null }],
        widgets_values: ["qwen-image-2.1-Q8_0.gguf"],
      },
      {
        id: 454,
        type: "VAELoader",
        inputs: [{ name: "vae_name", type: "COMBO", widget: { name: "vae_name" }, link: null }],
        widgets_values_named: { vae_name: "qwen_vae.safetensors" },
      },
      {
        id: 462,
        type: "KSampler",
        inputs: [
          { name: "model", type: "MODEL", link: 711 },
          { name: "vae", type: "VAE", link: 712 },
          { name: "seed", type: "INT", widget: { name: "seed" }, link: null },
        ],
        widgets_values: [42, "randomize", 20, 7, "euler", "normal", 1],
      },
    ],
    links: [
      [711, 451, 0, 462, 0, "MODEL"],
      [712, 454, 0, 462, 1, "VAE"],
    ],
  };

  it("widgets_values_named 优先；无名字时按 widget 顺序落在对应输入名上；链接转成 [节点, 槽位]", () => {
    const api = uiToApiWorkflow(UI_WORKFLOW);
    expect(api["451"]).toEqual({ class_type: "UnetLoaderGGUF", inputs: { unet_name: "qwen-image-2.1-Q8_0.gguf" } });
    expect(api["454"].inputs).toEqual({ vae_name: "qwen_vae.safetensors" });
    expect(api["462"].inputs.model).toEqual(["451", 0]);
    expect(api["462"].inputs.vae).toEqual(["454", 0]);
    expect(api["462"].inputs.seed).toBe(42);
  });

  it("转换结果可直接通过 API 格式解析并得到映射建议", () => {
    const ui = {
      nodes: [
        { id: 1, type: "CheckpointLoaderSimple", inputs: [{ name: "ckpt_name", widget: { name: "ckpt_name" }, link: null }], widgets_values: ["sd_xl.safetensors"] },
        { id: 2, type: "CLIPTextEncode", inputs: [{ name: "clip", type: "CLIP", link: 10 }, { name: "text", type: "STRING", widget: { name: "text" }, link: null }], widgets_values: ["a cat"] },
        { id: 3, type: "CLIPTextEncode", inputs: [{ name: "clip", type: "CLIP", link: 10 }, { name: "text", type: "STRING", widget: { name: "text" }, link: null }], widgets_values: ["lowres"] },
        { id: 4, type: "EmptyLatentImage", inputs: [{ name: "width", widget: { name: "width" }, link: null }, { name: "height", widget: { name: "height" }, link: null }], widgets_values: [1024, 1024] },
        {
          id: 5,
          type: "KSampler",
          inputs: [
            { name: "model", type: "MODEL", link: 11 },
            { name: "positive", type: "CONDITIONING", link: 12 },
            { name: "negative", type: "CONDITIONING", link: 13 },
            { name: "latent_image", type: "LATENT", link: 14 },
            { name: "seed", widget: { name: "seed" }, link: null },
          ],
          widgets_values: [7, "randomize", 20, 7, "euler", "normal", 1],
        },
      ],
      links: [
        [10, 1, 1, 2, 0, "CLIP"],
        [10, 1, 1, 3, 0, "CLIP"],
        [11, 1, 0, 5, 0, "MODEL"],
        [12, 2, 0, 5, 1, "CONDITIONING"],
        [13, 3, 0, 5, 2, "CONDITIONING"],
        [14, 4, 0, 5, 3, "LATENT"],
      ],
    };
    const parsed = parseWorkflowGraph(uiToApiWorkflow(ui));
    expect(parsed.ok).toBe(true);
    expect(parsed.suggestion.positive).toEqual({ node: "2", input: "text" });
    expect(parsed.suggestion.negative).toEqual({ node: "3", input: "text" });
    expect(parsed.suggestion.params).toEqual({ node: "5" });
    expect(parsed.suggestion.latent).toEqual({ node: "4" });
  });

  it("不是界面格式时返回 null，交给原有解析报错", () => {
    expect(uiToApiWorkflow(null)).toBeNull();
    expect(uiToApiWorkflow({ nodes: [] })).toBeNull();
    expect(uiToApiWorkflow(API_WORKFLOW)).toBeNull();
  });
});

describe("comfy：正负提示词落在同一个双输出文本节点", () => {
  const DUAL = {
    "1": { class_type: "CLIPLoader", inputs: { clip_name: "qwen3vl.safetensors", type: "qwen_image" } },
    "2": { class_type: "TextEncodeQwenImage21", inputs: { clip: ["1", 0], prompt: "a cat", negative_prompt: "" } },
    "3": {
      class_type: "KSampler",
      inputs: { seed: 1, steps: 20, cfg: 7, model: ["4", 0], positive: ["2", 0], negative: ["2", 1], latent_image: ["5", 0] },
    },
    "4": { class_type: "UNETLoader", inputs: { unet_name: "qwen.safetensors" } },
    "5": { class_type: "EmptyLatentImage", inputs: { width: 1024, height: 1024 } },
  };

  it("自动映射把负向指到 negative_prompt，而不是复用 prompt", () => {
    const parsed = parseWorkflowGraph(DUAL);
    expect(parsed.suggestion.positive).toEqual({ node: "2", input: "prompt" });
    expect(parsed.suggestion.negative).toEqual({ node: "2", input: "negative_prompt" });
  });

  it("正负都指向同一输入时跳过负向，避免覆盖正向", () => {
    const mapping = {
      positive: { node: "2", input: "prompt" },
      negative: { node: "2", input: "prompt" },
      params: { node: "3" },
      latent: { node: "5" },
    };
    const { workflow, skipped } = injectMapping(DUAL, mapping, { positive: "dog", negative: "lowres" });
    expect(workflow["2"].inputs.prompt).toBe("dog");
    expect(skipped).toContain("negative");
  });
});

describe("comfy：用 object_info 对齐界面格式的 widget 值", () => {
  const INFO = {
    SaveImage: {
      input: { required: { images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] } },
      input_order: { required: ["images", "filename_prefix"] },
    },
    EasyCache: {
      input: {
        required: {
          model: ["MODEL"],
          reuse_threshold: ["FLOAT", { default: 0.2 }],
          start_percent: ["FLOAT", { default: 0.15 }],
          end_percent: ["FLOAT", { default: 0.95 }],
          verbose: ["BOOLEAN", { default: false }],
        },
      },
      input_order: { required: ["model", "reuse_threshold", "start_percent", "end_percent", "verbose"] },
    },
    KSampler: {
      input: {
        required: {
          model: ["MODEL"],
          positive: ["CONDITIONING"],
          negative: ["CONDITIONING"],
          latent_image: ["LATENT"],
          seed: ["INT", { default: 0 }],
          steps: ["INT", { default: 20 }],
          cfg: ["FLOAT", { default: 7 }],
          sampler_name: [["euler", "dpmpp_2m"]],
          scheduler: [["normal", "karras"]],
          denoise: ["FLOAT", { default: 1 }],
        },
      },
      input_order: {
        required: ["model", "positive", "negative", "latent_image", "seed", "steps", "cfg", "sampler_name", "scheduler", "denoise"],
      },
    },
  };

  const UI = {
    nodes: [
      { id: 461, type: "SaveImage", inputs: [{ name: "images", link: 900 }], widgets_values: ["Qwen_image_2.1"] },
      { id: 500, type: "EasyCache", inputs: [], widgets_values: [0.2, 0.15, 0.95, false] },
      {
        id: 458,
        type: "KSampler",
        inputs: [
          { name: "model", link: 901 },
          { name: "positive", link: 902 },
          { name: "negative", link: 903 },
          { name: "latent_image", link: 904 },
        ],
        widgets_values: [123456, "fixed", 25, 4, "euler", "normal", 1],
      },
    ],
    links: [
      [900, 457, 0, 461, 0, "IMAGE"],
      [901, 451, 0, 458, 0, "MODEL"],
      [902, 452, 0, 458, 1, "CONDITIONING"],
      [903, 452, 1, 458, 2, "CONDITIONING"],
      [904, 456, 0, 458, 3, "LATENT"],
    ],
  };

  it("连线类型不占 widget 位；seed 后的 fixed/randomize 被丢弃；filename_prefix 正确落位", () => {
    const api = uiToApiWorkflow(UI, INFO);
    expect(api["461"].inputs).toEqual({ filename_prefix: "Qwen_image_2.1", images: ["457", 0] });
    expect(api["500"].inputs).toEqual({ reuse_threshold: 0.2, start_percent: 0.15, end_percent: 0.95, verbose: false });
    expect(api["458"].inputs).toMatchObject({
      seed: 123456,
      steps: 25,
      cfg: 4,
      sampler_name: "euler",
      scheduler: "normal",
      model: ["451", 0],
      positive: ["452", 0],
      negative: ["452", 1],
    });
    expect(api["458"].inputs).not.toHaveProperty("control_after_generate");
  });

  it("缺必填 widget 时用默认值补齐；已有值不覆盖；连线输入不补", () => {
    const { workflow, filled } = fillMissingDefaults(
      { "461": { class_type: "SaveImage", inputs: { images: ["457", 0] } }, "500": { class_type: "EasyCache", inputs: { verbose: true } } },
      INFO
    );
    expect(workflow["461"].inputs).toEqual({ images: ["457", 0], filename_prefix: "ComfyUI" });
    expect(workflow["500"].inputs).toMatchObject({ verbose: true, reuse_threshold: 0.2, start_percent: 0.15, end_percent: 0.95 });
    expect(filled).toContain("461.filename_prefix");
    expect(filled).not.toContain("461.images");
  });
});

describe("comfy：分体模型（UNET + CLIP + VAE）文生图", () => {
  it("按家族挑同源编码器：排除 minimax 的 32B，选 qwen3vl_8b_bf16", () => {
    const unet = "qwen_image_2.1_int8_convrot.safetensors";
    const clips = [
      "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
      "qwen3vl_8b_bf16.safetensors",
      "qwen3vl_8b_int8_convrot.safetensors",
    ];
    const vae = ["minimax_h3_video_vae_fp16.safetensors", "pixel_space", "qwen_image_2.1_vae_bf16.safetensors"];
    const picked = pickModelName(clips, { family: unet });
    expect(picked).toBe("qwen3vl_8b_bf16.safetensors");
    expect(pickModelName(vae, { family: unet })).toBe("qwen_image_2.1_vae_bf16.safetensors");
    expect(pickModelName(["minimax_h3_fl2va_pruned_int8.safetensors"], { family: unet })).toBe(
      "minimax_h3_fl2va_pruned_int8.safetensors"
    );
  });

  it("当前选择仍可用时不改动；列表为空返回空串", () => {
    expect(pickModelName(["a.safetensors", "b.safetensors"], { current: "b.safetensors" })).toBe("b.safetensors");
    expect(pickModelName([], { family: "x" })).toBe("");
  });

  it("GGUF 用 UnetLoaderGGUF；Qwen 编码器一个节点出正负两路", () => {
    const wf = buildSplitTxt2ImgWorkflow({
      unet: "qwen-image-2.1-Q8_0.gguf",
      clip: "qwen3vl_8b_bf16.safetensors",
      vae: "qwen_image_2.1_vae_bf16.safetensors",
      clipType: "qwen_image",
      encoder: "qwen",
      positive: "a cat",
      negative: "blurry",
      width: 832,
      height: 1216,
      steps: 25,
      cfg: 1,
      seed: 7,
    });
    expect(wf["1"]).toEqual({ class_type: "UnetLoaderGGUF", inputs: { unet_name: "qwen-image-2.1-Q8_0.gguf" } });
    expect(wf["2"].inputs).toEqual({ clip_name: "qwen3vl_8b_bf16.safetensors", type: "qwen_image" });
    expect(wf["4"].inputs).toMatchObject({ prompt: "a cat", negative_prompt: "blurry", clip: ["2", 0] });
    expect(wf["7"].inputs).toMatchObject({
      seed: 7,
      steps: 25,
      cfg: 1,
      model: ["1", 0],
      positive: ["4", 0],
      negative: ["4", 1],
      latent_image: ["5", 0],
    });
    expect(wf["8"].inputs.vae).toEqual(["3", 0]);
    expect(wf["9"].class_type).toBe("SaveImage");
  });

  it("非 GGUF 走 UNETLoader（带 weight_dtype）；无 Qwen 编码节点时退回两个 CLIPTextEncode", () => {
    const wf = buildSplitTxt2ImgWorkflow({ unet: "model.safetensors", clip: "c.safetensors", vae: "v.safetensors", encoder: "plain" });
    expect(wf["1"]).toEqual({ class_type: "UNETLoader", inputs: { unet_name: "model.safetensors", weight_dtype: "default" } });
    expect(wf["4"].class_type).toBe("CLIPTextEncode");
    expect(wf["6"].class_type).toBe("CLIPTextEncode");
    expect(wf["7"].inputs.positive).toEqual(["4", 0]);
    expect(wf["7"].inputs.negative).toEqual(["6", 0]);
  });
});
