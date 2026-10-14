import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeToolPrefill, setToolPrefill } from "./toolPrefill.js";

// node 环境没有 localStorage：用内存 stub 模拟（含可注入异常的写入/读取钩子）
function stubStorage() {
  const map = new Map();
  const stub = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
  vi.stubGlobal("localStorage", stub);
  return stub;
}

afterEach(() => vi.unstubAllGlobals());

describe("toolPrefill 一次性预填交接", () => {
  it("写入后可读，读一次即删（第二次读为 null）", () => {
    stubStorage();
    setToolPrefill("pdf", { kind: "open-file", path: "/tmp/a.pdf" });
    expect(consumeToolPrefill("pdf")).toEqual({ kind: "open-file", path: "/tmp/a.pdf" });
    expect(consumeToolPrefill("pdf")).toBeNull();
  });

  it("按工具 key 隔离：读 pdf 不影响 json 的载荷", () => {
    stubStorage();
    setToolPrefill("pdf", { kind: "open-file", path: "/tmp/a.pdf" });
    setToolPrefill("json", { kind: "open-file", path: "/tmp/b.json" });
    expect(consumeToolPrefill("pdf")).toEqual({ kind: "open-file", path: "/tmp/a.pdf" });
    expect(consumeToolPrefill("json")).toEqual({ kind: "open-file", path: "/tmp/b.json" });
  });

  it("没有预填返回 null；解析失败也返回 null 且条目已删", () => {
    const stub = stubStorage();
    expect(consumeToolPrefill("pdf")).toBeNull();
    stub.setItem("tc.toolPrefill.pdf", "{oops");
    expect(consumeToolPrefill("pdf")).toBeNull();
    expect(stub.getItem("tc.toolPrefill.pdf")).toBeNull();
  });

  it("隐私模式（setItem 抛错）不炸，读侧抛错也按 null 处理", () => {
    vi.stubGlobal("localStorage", {
      setItem: () => {
        throw new Error("denied");
      },
      getItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    });
    expect(() => setToolPrefill("pdf", { kind: "open-file", path: "/x" })).not.toThrow();
    expect(consumeToolPrefill("pdf")).toBeNull();
  });
});
