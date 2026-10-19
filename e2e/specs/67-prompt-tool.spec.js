// 提示词工具 E2E（桌面形态）。
//
// 真实能力（Rust prompt_media 的落盘/流式下载、repository 落盘、ComfyUI 协议解析）都有单测；
// 这里验**这条接线**：库 CRUD/筛选/置顶/导入导出 → 变量填充与复制 → 三种生成后端
// （云端生图走 prompt_image_generate、ComfyUI 文生图/自定义工作流走 http_request + 轮询）
// → 进度/取消/节点错误/历史重跑 → 浏览器形态降级。
//
// 必须走 seedDesktopIpc：工具标了 desktopOnly，浏览器形态会被注册表过滤掉；
// ComfyUI 的 JSON API 用 httpRoutes 回放（生产代码路径是 platform/invoke → http_request），
// 页面级的 media_* / prompt_image_generate / 保存对话框在 addInitScript 里拦截并记账。
import { expect, test } from "@playwright/test";
import { desktopOps, readKv, seedData, seedDesktopIpc } from "../helpers.js";

// 1×1 透明 PNG：图片卡片的 dataURL 前缀断言只需要它
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const API_WORKFLOW = {
  "3": {
    class_type: "KSampler",
    inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: "euler", scheduler: "normal", denoise: 1, model: ["4", 0], positive: ["12", 0], negative: ["13", 0], latent_image: ["5", 0] },
  },
  "4": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl_base_1.0.safetensors" } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 832, height: 1216, batch_size: 1 } },
  "12": { class_type: "CLIPTextEncode", inputs: { text: "旧文本", clip: ["4", 1] } },
  "13": { class_type: "CLIPTextEncode", inputs: { text: "旧负向", clip: ["4", 1] } },
  "9": { class_type: "SaveImage", inputs: { filename_prefix: "x", images: ["3", 0] } },
};

const IMAGE_RESULT = {
  outputs: { "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } },
  status: { status_str: "success" },
};
const IMAGE_VIDEO_RESULT = {
  outputs: {
    "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
    "10": { gifs: [{ filename: "v.mp4", subfolder: "", type: "output" }] },
  },
  status: { status_str: "success" },
};

function makeScenario(overrides = {}) {
  return {
    historyCalls: 0,
    historyAfter: 2,
    historyResult: null,
    promptResponse: { prompt_id: "pid-1", node_errors: {} },
    queue: { queue_running: [], queue_pending: [] },
    interruptCalls: 0,
    queueDeletes: [],
    promptBody: null,
    ...overrides,
  };
}

function comfyRoutes(scenario) {
  // 注意：helpers 只在「对象路由」上补默认 status，函数路由必须自带完整响应形状
  return {
    "/system_stats": { body: JSON.stringify({ system: { comfyui_version: "0.3.40" } }) },
    "/object_info": {
      body: JSON.stringify({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [["sd_xl_base_1.0.safetensors"]] } } } }),
    },
    "/prompt": (args) => {
      try {
        scenario.promptBody = JSON.parse(args?.body ?? "{}");
      } catch {
        scenario.promptBody = null;
      }
      return { status: 200, body: JSON.stringify(scenario.promptResponse) };
    },
    "/history": () => {
      scenario.historyCalls += 1;
      if (scenario.historyResult && scenario.historyCalls >= scenario.historyAfter) {
        return { status: 200, body: JSON.stringify({ "pid-1": scenario.historyResult }) };
      }
      return { status: 200, body: "{}" };
    },
    "/queue": (args) => {
      if (String(args?.method ?? "").toUpperCase() === "POST") {
        try {
          scenario.queueDeletes.push(JSON.parse(args?.body ?? "{}"));
        } catch {
          scenario.queueDeletes.push({});
        }
        return { status: 200, body: "{}" };
      }
      return { status: 200, body: JSON.stringify(scenario.queue) };
    },
    "/interrupt": () => {
      scenario.interruptCalls += 1;
      return { status: 200, body: "{}" };
    },
  };
}

/**
 * prompt 工具的桌面替身：repository/toolbox 落 IndexedDB（seedDesktopIpc 的 load/save_data），
 * ComfyUI JSON 走 httpRoutes，页面级命令（生图/媒体/保存框）在页面里拦截并记入 __promptCalls。
 */
async function stubPrompt(page, { scenario = makeScenario(), seeds = {}, savePath = "C:\\tmp\\out.json" } = {}) {
  await seedData(page, { settings: { telemetry: { prompted: true, enabled: false } }, ...seeds });
  await seedDesktopIpc(page, {}, { httpRoutes: comfyRoutes(scenario) });
  await page.addInitScript(
    (payload) => {
      window.__promptCalls = [];
      window.__promptOutcome = "ok";
      const original = window.__TAURI_INTERNALS__.invoke;
      window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
        const name = String(cmd);
        if (name === "plugin:dialog|save") return Promise.resolve(payload.savePath);
        if (name === "prompt_image_generate") {
          window.__promptCalls.push({ cmd: name, args: args || {} });
          if (window.__promptOutcome === "auth") return Promise.reject(new Error("HTTP 401：invalid api key"));
          return Promise.resolve({ files: [{ name: "p20261010-120000-0001.png", bytes: 68 }], count: 1, durationMs: 900 });
        }
        if (name.startsWith("media_")) {
          window.__promptCalls.push({ cmd: name, args: args || {} });
          if (name === "media_read_b64") return Promise.resolve(payload.pngB64);
          if (name === "media_fetch_stream") return Promise.resolve({ name: args?.name, path: "C:\\media\\" + String(args?.name ?? ""), bytes: 2048 });
          if (name === "media_path") return Promise.resolve("C:\\media\\" + String(args?.name ?? ""));
          return Promise.resolve(null);
        }
        return original(cmd, args);
      };
    },
    { pngB64: PNG_B64, savePath }
  );
  return scenario;
}

const promptCalls = (page, cmd) =>
  page.evaluate((name) => (window.__promptCalls || []).filter((call) => call.cmd === name).map((call) => call.args), cmd);

const openTool = async (page) => {
  await page.goto("/?tool=prompt");
  await page.locator(".tool-prompt").waitFor({ state: "visible", timeout: 15_000 });
};

const R1 = { id: "r1", title: "猫猫肖像", positive: "portrait of {{名字}}", negative: "", target: "image", category: "摄影", tags: ["写实"], note: "", pinned: false, createdAt: 1, updatedAt: 100 };
const R2 = { id: "r2", title: "动画场景", positive: "anime {{场景}}", negative: "", target: "image", category: "动漫", tags: ["二次元"], note: "", pinned: false, createdAt: 2, updatedAt: 300 };
const R3 = { id: "r3", title: "置顶条目", positive: "pin", negative: "", target: "video", category: "", tags: [], note: "", pinned: true, createdAt: 3, updatedAt: 50 };

test.describe("工具（提示词）", () => {
  test("空库 → 内置示例一键加入 → 落盘（刷新仍在）", async ({ page }) => {
    await stubPrompt(page);
    await openTool(page);
    await expect(page.locator('[data-role="lib-empty"]')).toBeVisible();
    await expect(page.locator('[data-role="lib-sample-add"]')).toHaveCount(6);
    await page.locator('[data-role="lib-sample-add-all"]').click();
    await expect(page.locator('[data-role="lib-row"]')).toHaveCount(6);
    await expect.poll(async () => ((await readKv(page, "prompts")) || []).length).toBe(6);

    await page.reload();
    await page.locator(".tool-prompt").waitFor({ state: "visible" });
    await expect(page.locator('[data-role="lib-row"]')).toHaveCount(6);
    await expect(page.locator('[data-role="lib-empty"]')).toHaveCount(0);
  });

  test("新建 → 编辑 → 删除 → 撤销，全程落盘", async ({ page }) => {
    await stubPrompt(page);
    await openTool(page);
    await page.locator('[data-role="lib-new"]').click();
    await page.locator('[data-role="lib-title"]').fill("测试提示词");
    await page.locator('[data-role="lib-positive"]').fill("一只{{动物}}在屋顶");
    await page.locator('[data-role="lib-negative"]').fill("lowres");
    await page.locator('[data-role="lib-cat-input"]').fill("测试");
    await page.locator('[data-role="lib-tags-input"]').fill("猫 屋顶");
    await page.locator('[data-role="lib-save"]').click();
    const row = page.locator(".lib-row", { hasText: "测试提示词" });
    await expect(row).toBeVisible();
    await expect(row.locator('[data-role="lib-badge-vars"]')).toContainText("1 个变量");

    await row.locator('[data-role="lib-edit"]').click();
    await page.locator('[data-role="lib-title"]').fill("改名了");
    await page.locator('[data-role="lib-save"]').click();
    await expect(page.locator(".lib-row", { hasText: "改名了" })).toBeVisible();

    await page.locator(".lib-row", { hasText: "改名了" }).locator('[data-role="lib-del"]').click();
    await expect(page.locator(".cf-box")).toBeVisible();
    await page.locator(".cf-btn.ok").click();
    await expect(page.locator(".lib-row", { hasText: "改名了" })).toHaveCount(0);
    await page.locator(".toast-act").click();
    await expect(page.locator(".lib-row", { hasText: "改名了" })).toBeVisible();

    await page.reload();
    await page.locator(".tool-prompt").waitFor({ state: "visible" });
    await expect(page.locator(".lib-row", { hasText: "改名了" })).toBeVisible();
  });

  test("搜索 / 分类筛选 / 置顶排序（刷新后保持）", async ({ page }) => {
    await stubPrompt(page, { seeds: { prompts: [R1, R2, R3] } });
    await openTool(page);
    await expect(page.locator('[data-role="lib-row"]')).toHaveCount(3);
    await expect(page.locator(".lib-row").first()).toContainText("置顶条目");

    await page.locator('[data-role="lib-search"]').fill("动画");
    await expect(page.locator('[data-role="lib-row"]')).toHaveCount(1);
    await expect(page.locator(".lib-row").first()).toContainText("动画场景");

    await page.locator('[data-role="lib-search"]').fill("");
    await page.locator('[data-role="lib-cat"]').selectOption({ label: "摄影" });
    await expect(page.locator('[data-role="lib-row"]')).toHaveCount(1);
    await expect(page.locator(".lib-row").first()).toContainText("猫猫肖像");

    await page.locator('[data-role="lib-cat"]').selectOption({ label: "全部分类" });
    await page.locator(".lib-row", { hasText: "猫猫肖像" }).locator('[data-role="lib-pin"]').click();
    await expect(page.locator(".lib-row").first()).toContainText("猫猫肖像");
    await page.reload();
    await page.locator(".tool-prompt").waitFor({ state: "visible" });
    await expect(page.locator(".lib-row").first()).toContainText("猫猫肖像");
  });

  test("变量填充：缺变量提示 → 填好后复制成稿", async ({ page }) => {
    await stubPrompt(page, { seeds: { prompts: [R1] } });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await openTool(page);
    await page.locator('[data-role="lib-row"]').click();
    await expect(page.locator('[data-role="gen-positive"]')).toHaveValue("portrait of {{名字}}");
    await expect(page.locator('[data-role="gen-var-名字"]')).toBeVisible();
    await expect(page.locator('[data-role="gen-var-missing"]')).toBeVisible();

    await page.locator('[data-role="gen-var-名字"]').fill("阿狸");
    await expect(page.locator('[data-role="gen-var-missing"]')).toHaveCount(0);
    await page.locator('[data-role="gen-copy-positive"]').click();
    await expect(page.locator(".toast")).toContainText("已复制");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe("portrait of 阿狸");
  });

  test("导入（含重复与坏 JSON）与导出（内容可解析）", async ({ page }) => {
    await stubPrompt(page, { seeds: { prompts: [R1] }, savePath: "C:\\tmp\\toolcove-prompts.json" });
    await openTool(page);
    await page.locator('[data-role="lib-import"]').click();
    const payload = JSON.stringify({
      format: "toolcove-prompts",
      version: 1,
      prompts: [
        { title: "猫猫肖像", positive: "portrait of {{名字}}" },
        { title: "导入的新条目", positive: "a brand new prompt", target: "video" },
      ],
    });
    await page.locator('[data-role="imp-text"]').fill(payload);
    await page.locator('[data-role="imp-apply"]').click();
    await expect(page.locator(".toast")).toContainText("已导入 1 条，跳过 1 条");
    await expect(page.locator('[data-role="lib-row"]')).toHaveCount(2);

    await page.locator('[data-role="lib-import"]').click();
    await page.locator('[data-role="imp-text"]').fill("{oops");
    await page.locator('[data-role="imp-apply"]').click();
    await expect(page.locator('[data-role="imp-error"]')).toContainText("不是有效的 JSON");
    await page.locator('[data-role="imp-cancel"]').click();

    await page.locator('[data-role="lib-export"]').click();
    await expect
      .poll(async () => {
        const ops = await desktopOps(page);
        return ops.filter((op) => op.cmd === "export_file").length;
      })
      .toBe(1);
    const ops = await desktopOps(page);
    const exported = ops.find((op) => op.cmd === "export_file");
    expect(exported.args.path).toBe("C:\\tmp\\toolcove-prompts.json");
    const parsed = JSON.parse(exported.args.content);
    expect(parsed.format).toBe("toolcove-prompts");
    expect(parsed.count).toBe(2);
  });

  test("云端生图成功：结果预览 + 历史落条", async ({ page }) => {
    const seeds = {
      prompts: [R1],
      "toolbox-prompt-config": {
        v: { cloud: { baseUrl: "https://img.example.com/v1", apiKey: "sk-test", model: "img-model", size: "1024x1024", n: 1, sendNegative: true }, comfy: {} },
      },
    };
    await stubPrompt(page, { seeds });
    await openTool(page);
    await page.locator('[data-role="lib-row"]').click();
    await expect(page.locator('[data-role="gen-cloud-state"]')).toContainText("img-model");
    await page.locator('[data-role="gen-positive"]').fill("一只在屋顶的猫");
    await page.locator('[data-role="gen-negative"]').fill("lowres");
    await page.locator('[data-role="gen-run"]').click();
    await expect(page.locator('[data-role="gen-result"]')).toBeVisible({ timeout: 15_000 });
    const args = (await promptCalls(page, "prompt_image_generate"))[0];
    expect(args.prompt).toBe("一只在屋顶的猫");
    expect(args.negativePrompt).toBe("lowres");
    expect(args.model).toBe("img-model");
    // 桌面端图片走 **asset 协议**（src/platform/image.js 的 imageSrc 分支），
    // 不是 base64 data URL——base64 是浏览器/手机端落 IndexedDB 时的降级路径。
    // 所以这里断言的是「拿到一个 asset.localhost 的 URL」这个**平台差异本身**，
    // 它比断言某个具体字符串更能说明代码走对了分支。
    await expect(page.locator('[data-role="gen-result"] img')).toHaveAttribute("src", /^http:\/\/asset\.localhost\//);

    await page.locator('[data-role="tab-history"]').click();
    await expect(page.locator('[data-role="hist-row"]')).toHaveCount(1);
    await expect(page.locator('[data-role="hist-row"] .badge')).toContainText("完成");
    // toolboxStore 有 200ms 防抖：落盘断言用轮询而不是立即读
    await expect
      .poll(async () => {
        const history = await readKv(page, "toolbox-prompt-history");
        return history?.v?.[0]?.status ?? "";
      })
      .toBe("done");
    const history = await readKv(page, "toolbox-prompt-history");
    expect(history.v[0].files).toHaveLength(1);
  });

  test("云端生图失败：鉴权文案 + 历史记失败", async ({ page }) => {
    const seeds = {
      prompts: [R1],
      "toolbox-prompt-config": {
        v: { cloud: { baseUrl: "https://img.example.com/v1", apiKey: "sk-bad", model: "img-model" }, comfy: {} },
      },
    };
    await stubPrompt(page, { seeds });
    await openTool(page);
    await page.locator('[data-role="lib-row"]').click();
    await page.evaluate(() => {
      window.__promptOutcome = "auth";
    });
    await page.locator('[data-role="gen-run"]').click();
    await expect(page.locator('[data-role="gen-error"]')).toContainText("鉴权失败", { timeout: 15_000 });
    await page.locator('[data-role="tab-history"]').click();
    await expect(page.locator('[data-role="hist-row"] .badge')).toContainText("失败");
  });

  test("ComfyUI 探活与 checkpoint 列举", async ({ page }) => {
    await stubPrompt(page, { seeds: { prompts: [R1] } });
    await openTool(page);
    await page.locator('[data-role="gen-backend-builtin"]').click();
    await expect(page.locator('[data-role="comfy-state"]')).toContainText("已连接 0.3.40");
    await expect(page.locator('[data-role="comfy-checkpoint"]')).toHaveValue("sd_xl_base_1.0.safetensors");
  });

  test("内置文生图：提交体带填充后的提示词，结果图 + 视频卡片", async ({ page }) => {
    const scenario = makeScenario({ historyResult: IMAGE_VIDEO_RESULT });
    await stubPrompt(page, { scenario, seeds: { prompts: [R1] } });
    await openTool(page);
    await page.locator('[data-role="lib-row"]').click();
    await page.locator('[data-role="gen-backend-builtin"]').click();
    await expect(page.locator('[data-role="comfy-state"]')).toContainText("已连接");
    await page.locator('[data-role="gen-var-名字"]').fill("阿狸");
    await page.locator('[data-role="gen-run"]').click();
    await expect(page.locator('[data-role="gen-result"]')).toBeVisible({ timeout: 20_000 });

    expect(scenario.promptBody.prompt["6"].inputs.text).toBe("portrait of 阿狸");
    expect(scenario.promptBody.client_id).toBeTruthy();
    await expect(page.locator(".pm-card")).toHaveCount(2);
    // 图片 src 走 asset 协议（见上方「云端生图成功」一例的说明）；
    // browser 形态才会是 data:image/png;base64,。
    await expect(page.locator('.pm-card[data-role$=".png"] img')).toHaveAttribute("src", /^http:\/\/asset\.localhost\//);
    // 视频卡片：内联 video + 打开/定位/另存为三个保底动作
    await expect(page.locator('.pm-card[data-role$=".mp4"] video')).toHaveCount(1);
    await expect(page.locator('.pm-card[data-role$=".mp4"] .pm-actions button')).toHaveCount(3);
    const downloads = await promptCalls(page, "media_fetch_stream");
    expect(downloads).toHaveLength(2);
  });

  test("取消：运行中弹确认 → 打断当前任务", async ({ page }) => {
    const scenario = makeScenario({ queue: { queue_running: [[0, "pid-1"]], queue_pending: [] } });
    await stubPrompt(page, { scenario, seeds: { prompts: [R1] } });
    await openTool(page);
    await page.locator('[data-role="lib-row"]').click();
    await page.locator('[data-role="gen-backend-builtin"]').click();
    await expect(page.locator('[data-role="comfy-state"]')).toContainText("已连接");
    await page.locator('[data-role="gen-run"]').click();
    await page.locator('[data-role="gen-cancel"]').waitFor({ state: "visible", timeout: 15_000 });
    await page.locator('[data-role="gen-cancel"]').click();
    await expect(page.locator(".cf-box")).toContainText("打断");
    await page.locator(".cf-btn.ok").click();
    await expect.poll(() => scenario.interruptCalls).toBe(1);
    await expect(page.locator(".toast")).toContainText("已取消");
    await page.locator('[data-role="tab-history"]').click();
    await expect(page.locator('[data-role="hist-row"] .badge')).toContainText("已取消");
  });

  test("node_errors：逐节点错误清单", async ({ page }) => {
    const scenario = makeScenario({ promptResponse: { node_errors: { "3": { class_type: "KSampler", errors: [{ message: "值非法" }] } } } });
    await stubPrompt(page, { scenario, seeds: { prompts: [R1] } });
    await openTool(page);
    await page.locator('[data-role="lib-row"]').click();
    await page.locator('[data-role="gen-backend-builtin"]').click();
    await expect(page.locator('[data-role="comfy-state"]')).toContainText("已连接");
    await page.locator('[data-role="gen-run"]').click();
    await expect(page.locator('[data-role="gen-err-nodes"]')).toContainText("#3 (KSampler)：值非法");
    await expect(page.locator('[data-role="gen-error"]')).toContainText("工作流校验未通过");
  });

  test("自定义工作流：导入 → 映射 → 注入提示词提交", async ({ page }) => {
    const scenario = makeScenario({ historyResult: IMAGE_RESULT });
    await stubPrompt(page, { scenario, seeds: { prompts: [R1] } });
    await openTool(page);
    await page.locator('[data-role="tab-settings"]').click();
    await page.locator('[data-role="wf-import"]').click();
    await page.locator('[data-role="wf-name"]').fill("测试工作流");
    await page.locator('[data-role="wf-text"]').fill(JSON.stringify(API_WORKFLOW));
    await page.locator('[data-role="wf-apply"]').click();
    await expect(page.locator('[data-role="wf-map-positive"]')).toHaveValue("12");
    await expect(page.locator('[data-role="wf-map-negative"]')).toHaveValue("13");
    await page.locator('[data-role="wf-save"]').click();
    await expect(page.locator('[data-role="wf-row"]')).toContainText("测试工作流");

    await page.locator('[data-role="tab-gen"]').click();
    await page.locator('[data-role="gen-backend-workflow"]').click();
    await page.locator('[data-role="wf-select"]').selectOption({ index: 1 });
    await page.locator('[data-role="gen-positive"]').fill("注入的新文本");
    await page.locator('[data-role="gen-negative"]').fill("注入的新负向");
    await page.locator('[data-role="gen-run"]').click();
    await expect(page.locator('[data-role="gen-result"]')).toBeVisible({ timeout: 20_000 });
    expect(scenario.promptBody.prompt["12"].inputs.text).toBe("注入的新文本");
    expect(scenario.promptBody.prompt["13"].inputs.text).toBe("注入的新负向");
  });

  test("历史重跑：按原提示词与参数再次提交", async ({ page }) => {
    const scenario = makeScenario({ historyResult: IMAGE_RESULT });
    const record = {
      id: "pg-old",
      ts: Date.now() - 60_000,
      status: "done",
      backend: "comfy",
      mode: "txt2img",
      promptId: "pid-0",
      positive: "重跑猫",
      negative: "",
      params: { checkpoint: "sd_xl_base_1.0.safetensors", width: 1024, height: 1024, steps: 20, cfg: 7, sampler: "euler", scheduler: "normal", denoise: 1, seedMode: "random", seed: 0 },
      files: [],
      error: "",
      durationMs: 3000,
    };
    await stubPrompt(page, { scenario, seeds: { "toolbox-prompt-history": { v: [record] } } });
    await openTool(page);
    await page.locator('[data-role="tab-history"]').click();
    await page.locator('[data-role="hist-toggle"]').click();
    await page.locator('[data-role="hist-rerun"]').click();
    await expect(page.locator('[data-role="gen-result"]')).toBeVisible({ timeout: 20_000 });
    expect(scenario.promptBody.prompt["6"].inputs.text).toBe("重跑猫");
  });

  test("工具页可从工具箱搜到", async ({ page }) => {
    await stubPrompt(page);
    await page.goto("/");
    await page.locator(".nav-item", { hasText: "本地工具" }).click();
    const box = page.locator(".lt-search input");
    await box.waitFor({ state: "visible", timeout: 10_000 });
    await box.fill("提示词");
    await expect(page.locator(".lt-tool .lt-name", { hasText: /^提示词$/ })).toHaveCount(1);
  });

  test("浏览器形态：直达链接显示桌面专属说明，工具箱里不出现该卡片", async ({ page }) => {
    await page.goto("/?tool=prompt");
    await expect(page.locator('[data-role="desktop-error"]')).toContainText("仅在桌面端可用");

    await page.goto("/");
    await page.locator(".nav-item", { hasText: "本地工具" }).click();
    const box = page.locator(".lt-search input");
    await box.waitFor({ state: "visible", timeout: 10_000 });
    await box.fill("提示词");
    await expect(page.locator(".lt-tool .lt-name", { hasText: /^提示词$/ })).toHaveCount(0);
  });
});
