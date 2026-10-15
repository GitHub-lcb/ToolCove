// 演示投递通道单测：冷启动（存储交接、读一次就删）与热路径（工具已开着时实时送达）
// 是本层最容易出错的两件事——前者漏删会让下次手开工具复活旧脚本，后者漏做会让
// 「AI 打开工具」打在旧状态上（这正是 toolPrefill 已知的那个坑）。
//
// node 环境没有 localStorage/IndexedDB，platform/kv 会退到内存后端——正好用来验一次性语义。
import { beforeEach, describe, expect, it } from "vitest";
import { notifySignal, onDemoSignal, resetDemoLinkForTest, sendDemo, subscribeDemo, takeDemo, toolWindowLabel } from "./toolDemoLink.js";

const script = [{ anchor: "input", action: "fill", value: "x", captionKey: "toolbox.demo.step_fill" }];

beforeEach(() => {
  resetDemoLinkForTest();
});

describe("冷启动交接", () => {
  it("投递后再取回同一份脚本，且只能取一次", async () => {
    const sent = await sendDemo({ toolKey: "kb-only-once", action: "table.convert", runId: "r1", script });
    expect(sent).toBe(true);
    const taken = await takeDemo("kb-only-once");
    expect(taken.toolKey).toBe("kb-only-once");
    expect(taken.runId).toBe("r1");
    expect(taken.script).toEqual(script);
    // 读一次就删：否则用户下次手动开同一个工具会莫名其妙重播上次的演示
    expect(await takeDemo("kb-only-once")).toBeNull();
  });

  it("空脚本不投递（没有可演的步骤就不该占用交接位）", async () => {
    expect(await sendDemo({ toolKey: "kb-empty", script: [] })).toBe(false);
    expect(await takeDemo("kb-empty")).toBeNull();
  });

  it("缺 toolKey 时直接拒绝，而不是写一个谁都不认的键", async () => {
    expect(await sendDemo({ script })).toBe(false);
  });
});

describe("热路径：工具已经开着", () => {
  it("已挂载的订阅者立刻收到脚本", async () => {
    const seen = [];
    subscribeDemo("kb-live", (payload) => seen.push(payload));
    await sendDemo({ toolKey: "kb-live", action: "table.parse", runId: "r2", script });
    expect(seen).toHaveLength(1);
    expect(seen[0].action).toBe("table.parse");
  });

  it("订阅者只收自己工具的脚本", async () => {
    const seen = [];
    subscribeDemo("kb-a", () => seen.push("a"));
    subscribeDemo("kb-b", () => seen.push("b"));
    await sendDemo({ toolKey: "kb-b", script });
    expect(seen).toEqual(["b"]);
  });

  it("取消订阅后不再收到", async () => {
    const seen = [];
    const off = subscribeDemo("kb-undo", () => seen.push(1));
    off();
    await sendDemo({ toolKey: "kb-undo", script });
    expect(seen).toEqual([]);
  });

  it("单个订阅者抛错不影响其它订阅者（投递是增强，不是主流程）", async () => {
    const seen = [];
    subscribeDemo("kb-err", () => {
      throw new Error("boom");
    });
    subscribeDemo("kb-err", () => seen.push("ok"));
    await expect(sendDemo({ toolKey: "kb-err", script })).resolves.toBe(true);
    expect(seen).toEqual(["ok"]);
  });
});

describe("回程：ready / done 回执", () => {
  it("done 回执带步数与是否被跳过", async () => {
    const seen = [];
    onDemoSignal((signal) => seen.push(signal));
    notifySignal("done", { toolKey: "table", runId: "r3", steps: 3, skipped: true });
    expect(seen).toEqual([{ kind: "done", toolKey: "table", runId: "r3", steps: 3, skipped: true }]);
  });

  it("未知 kind 一律忽略（防止有人拿它当通用事件总线用）", () => {
    const seen = [];
    onDemoSignal((signal) => seen.push(signal));
    notifySignal("whatever", { runId: "r4" });
    expect(seen).toEqual([]);
  });

  it("取消订阅后不再收到回执", () => {
    const seen = [];
    const off = onDemoSignal(() => seen.push(1));
    off();
    notifySignal("ready", { runId: "r5" });
    expect(seen).toEqual([]);
  });
});

describe("窗口标签", () => {
  it("与 Tauri capability 里的 tool-<key> 命名一致", () => {
    expect(toolWindowLabel("table")).toBe("tool-table");
  });
});
