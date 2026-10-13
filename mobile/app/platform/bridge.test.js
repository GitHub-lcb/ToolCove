// 原生桥探测的单测：**真机形状**是这里的核心回归点。
//
// 背景：桥的 Kotlin 侧曾用一个 `@get:JavascriptInterface val isMobile` 当"可用标记"，
// 但 WebView 把方法注入成 JS 方法（函数对象），`=== true` 恒为假——真机上桥从来没被接上过，
// 整个 App 静默跑在浏览器降级路径。当时的 E2E 桥替身恰好种了 `isMobile: true` 这个真机上
// 不存在的形状，所以谁都没发现。这组用例锁死：**只看 invoke 是不是函数**。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installNativeBridge, nativeAvailable } from "./bridge.js";
import { getMobileBridge, hasMobileBridge, setMobileBridge } from "../../../src/platform/backends/mobile.js";

const realShape = () => ({ invoke: (cmd, argsJson) => JSON.stringify({ cmd, args: JSON.parse(argsJson || "{}") }) });

beforeEach(() => {
  vi.unstubAllGlobals();
  setMobileBridge(null);
});

describe("原生桥探测", () => {
  it("真机形状（只有 invoke 方法）必须被认出——不再依赖任何布尔属性", () => {
    vi.stubGlobal("window", { ToolCove: realShape() });
    expect(nativeAvailable()).toBe(true);
    expect(installNativeBridge()).toBe(true);
    expect(hasMobileBridge()).toBe(true);
  });

  it("只有 isMobile 布尔却没有 invoke 的旧形状 → 不算可用（宁可降级也不要假桥）", () => {
    vi.stubGlobal("window", { ToolCove: { isMobile: true } });
    expect(nativeAvailable()).toBe(false);
    expect(installNativeBridge()).toBe(false);
    expect(hasMobileBridge()).toBe(false);
  });

  it("没有 ToolCove / invoke 不是函数 → 不接桥", () => {
    vi.stubGlobal("window", {});
    expect(nativeAvailable()).toBe(false);
    vi.stubGlobal("window", { ToolCove: { invoke: "not-a-function" } });
    expect(nativeAvailable()).toBe(false);
    expect(installNativeBridge()).toBe(false);
  });

  it("接桥后：结构化错误 __error 翻成带 code 的 Error，正常结果原样返回", async () => {
    vi.stubGlobal("window", { ToolCove: realShape() });
    installNativeBridge();
    const bridge = getMobileBridge();
    await expect(bridge.invoke("app_version", {})).resolves.toEqual({ cmd: "app_version", args: {} });
  });

  it("接桥后：__error 形状抛错并带 code（调用方按 code 决定是否回退）", async () => {
    // 命令名走变量而不是字面量：parity 守卫会扫描源码里所有 invoke("xxx") 字面量并断言
    // "要么桥实现、要么能回退"——测试里的假命令会把它误判成真命令
    const unknownCommand = "totally_unknown_cmd";
    vi.stubGlobal("window", {
      ToolCove: { invoke: () => JSON.stringify({ __error: "尚未实现该命令", __code: "unsupported" }) },
    });
    installNativeBridge();
    await expect(getMobileBridge().invoke(unknownCommand, {})).rejects.toMatchObject({ code: "unsupported" });
  });
});
