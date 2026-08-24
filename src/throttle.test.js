// throttle.js 单测：首拍立即 + 窗口合并 + 窗口末补发
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { throttleFlush } from "./throttle.js";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("throttleFlush", () => {
  it("首拍立即执行", () => {
    const fn = vi.fn();
    const t = throttleFlush(fn, 200);
    t.flush("a");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("a");
    t.dispose();
  });

  it("窗口内合并，窗口末以最新参数补发一次", () => {
    const fn = vi.fn();
    const t = throttleFlush(fn, 200);
    t.flush("a"); // 首拍立即
    t.flush("b");
    t.flush("c");
    expect(fn).toHaveBeenCalledTimes(1); // 窗口内不再触发
    vi.advanceTimersByTime(200);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("c"); // 补发最新值
    t.dispose();
  });

  it("窗口结束后再次 flush 立即触发", () => {
    const fn = vi.fn();
    const t = throttleFlush(fn, 200);
    t.flush("a");
    vi.advanceTimersByTime(200);
    t.flush("b");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith("b");
    t.dispose();
  });

  it("dispose 清理定时器且不再触发", () => {
    const fn = vi.fn();
    const t = throttleFlush(fn, 200);
    t.flush("a");
    t.dispose();
    vi.advanceTimersByTime(500);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
