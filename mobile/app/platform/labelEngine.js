// 标签排版引擎（手机端）：加载 label-core 的 WASM 产物并调用它。
//
// 这个模块的意义在于**手机端与桌面端跑的是同一份排版代码**：桌面端经 Tauri 命令
// `label_layout` 调 label-core，手机端经这里的 wasm `layout_json` 调同一个函数。
// 「所见即所打」因此不是"两端看起来一样"，而是同一份实现算出来的。
//
// 为什么不引 wasm-bindgen：它要一整套工具链（wasm-pack + JS 胶水生成 + 额外的 glue 文件），
// 而这里只需要「传 JSON 进去、拿 JSON 出来」。裸 `extern "C"` + 手写内存协议只要十几行，
// 产物也小。内存协议见 crates/label-core/src/wasm.rs 的文件头。
//
// 加载策略：**按需加载**——wasm 有 470KB，只有打开标签工具时才取（与工具按需加载同一原则）。

/** wasm 模块地址：由 Vite 作为静态资源处理（放 public/ 下，随 APK 一起打包）。 */
const WASM_URL = new URL("../../public/label-core.wasm", import.meta.url).href;

let enginePromise = null;

/**
 * 加载并实例化引擎（多次调用只加载一次）。
 * 失败时抛出可读原因——标签工具页据此提示"引擎加载失败"，而不是静默卡住。
 */
export function loadLabelEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      // 用 fetch + instantiateStreaming 的降级写法：某些 WebView 对 application/wasm 的
      // MIME 处理不一致，instantiateStreaming 会因此报错，退回 arrayBuffer 更稳。
      const response = await fetch(WASM_URL);
      if (!response.ok) throw new Error(`排版引擎加载失败（HTTP ${response.status}）`);
      const bytes = await response.arrayBuffer();
      const { instance } = await WebAssembly.instantiate(bytes, {});
      const api = instance.exports;
      for (const name of ["alloc", "dealloc", "last_len", "release_last", "layout_json"]) {
        if (typeof api[name] !== "function") throw new Error(`排版引擎缺少导出：${name}`);
      }
      return createEngine(api);
    })().catch((error) => {
      // 失败后清掉缓存：下次打开标签工具会重试，而不是永远拿到同一个 rejected promise
      enginePromise = null;
      throw error;
    });
  }
  return enginePromise;
}

/** 把裸导出包装成好用的接口（内存协议只在这里出现一次）。 */
function createEngine(api) {
  /** 调用一个导出函数：写入参数 JSON，读回结果 JSON，两侧内存都由这里管。 */
  function call(name, payload) {
    const input = new TextEncoder().encode(JSON.stringify(payload ?? {}));
    const inPtr = api.alloc(input.length);
    try {
      new Uint8Array(api.memory.buffer, inPtr, input.length).set(input);
      const outPtr = api[name](inPtr, input.length);
      const outLen = api.last_len();
      const text = new TextDecoder().decode(new Uint8Array(api.memory.buffer, outPtr, outLen));
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && typeof parsed.__error === "string") {
        throw new Error(parsed.__error);
      }
      return parsed;
    } finally {
      // ⚠️ 输入按长度释放；**结果由 wasm 侧按真实容量释放**（Vec 的容量可能大于长度，
      // 用长度去释放会触发分配器断言——这一点在 build-wasm.mjs 里踩过）。
      api.dealloc(inPtr, input.length);
      api.release_last();
    }
  }

  return {
    /** 排版：返回与桌面端 `label_layout` 完全同形的 Render（canvasW/items/source/issues…）。 */
    layout: (settings) => call("layout_json", settings),
    /** 只要 TSPL 指令文本（少构造预览模型）。 */
    source: (settings) => call("source_json", settings),
  };
}

/** 测试与排查用：重置缓存，让下次调用重新加载。 */
export function resetLabelEngine() {
  enginePromise = null;
}
