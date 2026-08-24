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
import { i18n } from "./i18n/index.js";

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
    fields: [{ key: "name", label: "Name" }],
    hint: "",
    ownerId: "inst-1",
    imageUrl: "data:image/png;base64,xxx",
    ...over,
  };
}

describe("transition state machine", () => {
  it("legal transitions apply, illegal ones are ignored", () => {
    const t = { status: "idle" };
    transition(t, { type: "start" });
    expect(t.status).toBe("running");
    transition(t, { type: "done", result: {} });
    expect(t.status).toBe("done");
    transition(t, { type: "cancel" }); // cancel after done is illegal
    expect(t.status).toBe("done");
  });
  it("error / cancel transitions from running", () => {
    const t = { status: "running" };
    transition(t, { type: "error", error: new Error("x") });
    expect(t.status).toBe("error");
    const t2 = { status: "running" };
    transition(t2, { type: "cancel" });
    expect(t2.status).toBe("cancelled");
  });
});

describe("startExtractTask single-task exclusion", () => {
  it("later start cancels earlier one, old task cancelled", () => {
    const a = startExtractTask(baseConfig({ ownerId: "inst-1" }));
    const b = startExtractTask(baseConfig({ ownerId: "inst-2" }));
    expect(a.status).toBe("cancelled");
    expect(b.status).toBe("running");
    expect(getExtractTask()).toBe(b);
  });
  it("cancel does not go through onError (handlers.onError not called)", () => {
    const err = vi.fn();
    startExtractTask(baseConfig({ ownerId: "inst-1" }));
    h.handlers.onError = err;
    cancelExtractTask();
    expect(err).not.toHaveBeenCalled();
    expect(getExtractTask().status).toBe("cancelled");
  });
  it("onPartial updates partial, onDone sets done with result", () => {
    startExtractTask(baseConfig());
    h.handlers.onPartial({ name: "a" });
    expect(getExtractTask().partial).toEqual({ name: "a" });
    h.handlers.onDone({ name: "abc" });
    expect(getExtractTask().status).toBe("done");
    expect(getExtractTask().result).toEqual({ name: "abc" });
    expect(getExtractTask().partial).toBeNull();
  });
  it("clearExtractTask clears the task", () => {
    startExtractTask(baseConfig());
    clearExtractTask();
    expect(getExtractTask()).toBeNull();
  });
  it("task keeps imageUrl snapshot", () => {
    const t = startExtractTask(baseConfig({ imageUrl: "data:image/png;base64,abc" }));
    expect(t.imageUrl).toBe("data:image/png;base64,abc");
  });
});

describe("subscribe and owner registry", () => {
  it("subscribe notifies state changes, unsubscribe stops notifications", () => {
    const fn = vi.fn();
    const unsub = subscribe(fn);
    startExtractTask(baseConfig());
    expect(fn).toHaveBeenCalled();
    const calls = fn.mock.calls.length;
    unsub();
    cancelExtractTask();
    expect(fn.mock.calls.length).toBe(calls);
  });
  it("registerOwner/unregisterOwner maintain mounted instance set", () => {
    registerOwner("inst-1");
    registerOwner("inst-2");
    unregisterOwner("inst-1");
    expect(isOwnerMounted("inst-1")).toBe(false);
    expect(isOwnerMounted("inst-2")).toBe(true);
  });
});

describe("TASK_LABELS", () => {
  it("labels follow i18n templates", () => {
    expect(TASK_LABELS.running(12.3)).toBe(i18n.global.t("extract.taskRunning", { seconds: 12.3 }));
    expect(TASK_LABELS.done(5)).toBe(i18n.global.t("extract.taskDone", { count: 5 }));
    expect(TASK_LABELS.error).toBe(i18n.global.t("extract.taskError"));
  });
});
