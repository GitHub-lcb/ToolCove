// 浏览器键值存储单测：Node 环境无 indexedDB/localStorage，落到内存后端（最终兜底路径）。
import { describe, it, expect } from "vitest";
import { kvGet, kvSet, kvDelete, kvKeys } from "./kv.js";

describe("kv 内存兜底后端", () => {
  it("缺失键返回 undefined", async () => {
    await expect(kvGet("kv-none")).resolves.toBeUndefined();
  });

  it("结构化值往返（对象/数组/数字）", async () => {
    await kvSet("kv-obj", { a: [1, "x", { b: true }] });
    await kvSet("kv-num", 0);
    await expect(kvGet("kv-obj")).resolves.toEqual({ a: [1, "x", { b: true }] });
    // 0 属于合法值，不能被当成缺失
    await expect(kvGet("kv-num")).resolves.toBe(0);
  });

  it("删除后回到缺失态，keys 同步反映", async () => {
    await kvSet("kv-del", "v");
    expect(await kvKeys()).toContain("kv-del");
    await kvDelete("kv-del");
    await expect(kvGet("kv-del")).resolves.toBeUndefined();
    expect(await kvKeys()).not.toContain("kv-del");
  });

  it("键名归一化为字符串", async () => {
    await kvSet(42, "answer");
    await expect(kvGet("42")).resolves.toBe("answer");
  });
});
