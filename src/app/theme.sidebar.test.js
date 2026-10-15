// 侧边栏折叠状态的单测（theme.js）。
//
// 为什么值得锁：导航重构把这行代码从 `ref(true)`（默认收起）改成读本机偏好，
// 「默认展开」是这次改版的核心结论之一——默认收起等于把历史与工作面藏起来，
// 是 ChatGPT 桌面端重设计踩过、并被官方专门修复的坑。这条断言就是那个结论的哨兵。
//
// 环境说明：单测跑在 node 环境（见 vite.config.js），没有 localStorage。
// 与 accentTheme.test.js 同一手法，手工挂一个最小实现到 globalThis，用完删掉。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getSidebarCollapsed, setSidebarCollapsed } from "./theme.js";

const KEY = "tc.sidebar.collapsed";

describe("侧边栏折叠状态", () => {
  let store;
  let broken;
  beforeEach(() => {
    store = {};
    broken = false;
    globalThis.localStorage = {
      getItem: (k) => {
        if (broken) throw new Error("denied");
        return k in store ? store[k] : null;
      },
      setItem: (k, v) => {
        if (broken) throw new Error("denied");
        store[k] = String(v);
      },
      removeItem: (k) => {
        if (broken) throw new Error("denied");
        delete store[k];
      },
    };
  });
  afterEach(() => {
    delete globalThis.localStorage;
  });

  it("默认展开（没存过任何偏好时返回 false）", () => {
    expect(getSidebarCollapsed()).toBe(false);
  });

  it("存过收起就保持收起；再展开时清掉键而不是写 0", () => {
    expect(setSidebarCollapsed(true)).toBe(true);
    expect(store[KEY]).toBe("1");
    expect(getSidebarCollapsed()).toBe(true);

    expect(setSidebarCollapsed(false)).toBe(false);
    // 清键：磁盘上不留「显式展开」这种与默认值等价的状态
    expect(KEY in store).toBe(false);
    expect(getSidebarCollapsed()).toBe(false);
  });

  it("只认严格 true：其余值一律当展开（脏值不该把侧边栏锁死）", () => {
    expect(setSidebarCollapsed("1")).toBe(false);
    expect(setSidebarCollapsed(1)).toBe(false);
    expect(setSidebarCollapsed(undefined)).toBe(false);
    expect(getSidebarCollapsed()).toBe(false);
  });

  it("键值被外部写脏时按展开处理", () => {
    store[KEY] = "yes";
    expect(getSidebarCollapsed()).toBe(false);
  });

  it("localStorage 不可用（隐私模式）时不抛错，退化为本次会话内有效", () => {
    broken = true;
    expect(() => getSidebarCollapsed()).not.toThrow();
    expect(getSidebarCollapsed()).toBe(false);
    // 返回值仍是用户意图，只是没落盘
    expect(() => setSidebarCollapsed(true)).not.toThrow();
    expect(setSidebarCollapsed(true)).toBe(true);
  });
});
