// extractTask.js 单测：状态机/单任务互斥/订阅退订/取消不走 onError/owner 注册表
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  startExtractTask,
  getExtractTask,
  cancelExtractTask,
  clearExtractTask,
  subscribe,
  registerOwner,
  unregisterOwner,
  isOwnerMounted,
  transition,
  TASK_LABELS,
} from "./extractTask.js";

// mock 流式提取：捕获 handlers 供测试驱动
const h = vi.hoisted(() => ({ handlers: null }));
vi.mock("./ai.js", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    aiExtractStream: vi.fn((images, fields, opts, handlers) => {
      h.handlers = handlers;
      return { stop: vi.fn() };
    }),
    aiExtractManyStream: vi.fn((images, fields, opts, handlers) => {
      h.handlers = handlers;
      return { stop: vi.fn() };
    }),
    aiExtractGroupsStream: vi.fn((images, groups, opts, handlers) => {
      h.handlers = handlers;
      return { stop: vi.fn() };
    }),
  };
});

beforeEach(() => {
  h.handlers = null;
  clearExtractTask();
  unregisterOwner("inst-1");
  unregisterOwner("inst-2");
});

function baseConfig(over = {}) {
  return {
    mode: "single",
    images: ["data:image/png;base64,xxx"],
    fields: [{ key: "name", label: "名称" }],
    hint: "",
    ownerId: "inst-1",
    imageUrl: "data:image/png;base64,xxx",
    ...over,
  };
}

describe("transition 状态机", () => {
  it("合法流转与非法流转静默", () => {
    const t = { status: "idle" };
    transition(t, { type: "start" });
    expect(t.status).toBe("running");
    transition(t, { type: "done", result: {} });
    expect(t.status).toBe("done");
    transition(t, { type: "cancel" }); // done 后 cancel 非法
    expect(t.status).toBe("done");
  });
  it("start 后 error / cancel 流转", () => {
    const t = { status: "running" };
    transition(t, { type: "error", error: new Error("x") });
    expect(t.status).toBe("error");
    const t2 = { status: "running" };
    transition(t2, { type: "cancel" });
    expect(t2.status).toBe("cancelled");
  });
});

describe("startExtractTask 单任务互斥", () => {
  it("后启动取消先启动，旧任务 cancelled", () => {
    const a = startExtractTask(baseConfig({ ownerId: "inst-1" }));
    const b = startExtractTask(baseConfig({ ownerId: "inst-2" }));
    expect(a.status).toBe("cancelled");
    expect(b.status).toBe("running");
    expect(getExtractTask()).toBe(b);
  });
  it("取消不走 onError（cancel 后 handlers.onError 未被调用）", () => {
    const err = vi.fn();
    startExtractTask(baseConfig({ ownerId: "inst-1" }));
    h.handlers.onError = err;
    cancelExtractTask();
    expect(err).not.toHaveBeenCalled();
    expect(getExtractTask().status).toBe("cancelled");
  });
  it("onPartial 推进任务 partial，onDone 置 done 与 result", () => {
    startExtractTask(baseConfig());
    h.handlers.onPartial({ name: "张" });
    expect(getExtractTask().partial).toEqual({ name: "张" });
    h.handlers.onDone({ name: "张三" });
    expect(getExtractTask().status).toBe("done");
    expect(getExtractTask().result).toEqual({ name: "张三" });
    expect(getExtractTask().partial).toBeNull();
  });
  it("clearExtractTask 清空任务", () => {
    startExtractTask(baseConfig());
    clearExtractTask();
    expect(getExtractTask()).toBeNull();
  });
  it("任务携带 imageUrl 快照", () => {
    const t = startExtractTask(baseConfig({ imageUrl: "data:image/png;base64,abc" }));
    expect(t.imageUrl).toBe("data:image/png;base64,abc");
  });
});

describe("订阅与 owner 注册表", () => {
  it("subscribe 通知状态变化，退订后不再收到", () => {
    const fn = vi.fn();
    const unsub = subscribe(fn);
    startExtractTask(baseConfig());
    expect(fn).toHaveBeenCalled();
    const calls = fn.mock.calls.length;
    unsub();
    cancelExtractTask();
    expect(fn.mock.calls.length).toBe(calls);
  });
  it("registerOwner/unregisterOwner 维护挂载实例集合", () => {
    registerOwner("inst-1");
    registerOwner("inst-2");
    unregisterOwner("inst-1");
    expect(isOwnerMounted("inst-1")).toBe(false);
    expect(isOwnerMounted("inst-2")).toBe(true);
  });
});

describe("TASK_LABELS", () => {
  it("文案格式", () => {
    expect(TASK_LABELS.running(12.3)).toContain("12.3");
    expect(TASK_LABELS.done(5)).toBe("✓ 识别完成 5 行");
    expect(TASK_LABELS.error).toBe("识别失败");
  });
});
