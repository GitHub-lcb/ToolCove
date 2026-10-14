// 工具注册表守卫：**生成物必须与目录现状一致**。
//
// 为什么必须把这条变成红灯：注册模型改成「目录即注册」之后，清单是**扫出来的**。
// 忘了跑 `npm run gen:tools` 时，新工具不会出现在画廊 / Agent 目录 / 组件映射里，
// 而这件事在没有守卫时是完全静默的——界面只是少一个入口，任何测试都不会报错。
// 与项目既有做法一致：把「约定」变成红灯，而不是靠人记得。
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { checkRegistry, buildRegistry, ROOT } from "../../scripts/gen-tool-registry.mjs";
import { TOOL_CONTRACTS, CONTRACT_BY_KEY } from "../contracts/index.js";
import { TOOL_COMPONENT_LOADERS } from "../toolComponents.generated.js";
import { TOOL_EXECUTORS } from "../toolExecutors.generated.js";

describe("工具注册表生成物", () => {
  it("生成物与目录现状一致（改了目录就要跑 npm run gen:tools）", async () => {
    const { errors, stale } = await checkRegistry();
    expect(errors, `扫描/加载失败：${errors.join("; ")}`).toEqual([]);
    expect(stale, `与目录不一致的生成物：${stale.join(", ")}`).toEqual([]);
  });

  it("每个契约都有唯一 key、整数 order 与合法 scope", () => {
    const keys = TOOL_CONTRACTS.map((c) => c.key);
    expect(new Set(keys).size, "契约 key 必须唯一").toBe(keys.length);
    expect(CONTRACT_BY_KEY.size).toBe(keys.length);
    const orders = TOOL_CONTRACTS.map((c) => c.order);
    for (const [i, order] of orders.entries()) {
      expect(Number.isInteger(order), `契约 ${keys[i]} 的 order 必须是整数`).toBe(true);
    }
    expect(new Set(orders).size, "order 必须唯一").toBe(orders.length);
  });

  it("展示顺序 = order 升序（画廊顺序的单一真相源）", () => {
    const orders = TOOL_CONTRACTS.map((c) => c.order);
    expect(orders).toEqual([...orders].sort((a, b) => a - b));
  });

  it("每个契约都有界面加载器（注册表与组件映射一一对应）", () => {
    const loaderKeys = Object.keys(TOOL_COMPONENT_LOADERS).sort();
    const contractKeys = TOOL_CONTRACTS.map((c) => c.key).sort();
    expect(loaderKeys).toEqual(contractKeys);
    for (const key of loaderKeys) expect(typeof TOOL_COMPONENT_LOADERS[key], `${key} 的加载器应是函数`).toBe("function");
  });

  it("工具包形态：src/tools/<key> 目录名必须等于契约 key", async () => {
    const { entries } = await buildRegistry();
    const packaged = entries.filter((e) => e.pkg);
    expect(packaged.length, "至少要有一个已迁进工具包的工具（pdf 是试点）").toBeGreaterThan(0);
    for (const e of packaged) expect(e.pkg).toBe(e.key);
  });

  it("已迁进工具包的执行器不会与手写区撞键（catalog.test.js 另有键集合的强约束）", () => {
    expect(typeof TOOL_EXECUTORS).toBe("object");
    for (const [name, impl] of Object.entries(TOOL_EXECUTORS)) {
      expect(typeof impl.execute, `${name} 的 execute 应是函数`).toBe("function");
    }
  });

  it("扫描规模合理（注册表空转不能假装全绿）", () => {
    expect(TOOL_CONTRACTS.length).toBeGreaterThanOrEqual(27);
    expect(fs.existsSync(path.join(ROOT, "src/tools/pdf/contract.js"))).toBe(true);
  });
});
