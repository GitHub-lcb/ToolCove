// 平台适配层单测：浏览器端命令实现 + 桌面端直通。
// 说明：Node 环境下 isDesktop 为 true，因此 invoke() 走直通分支；
// 浏览器端实现通过 browserHandlers 直接驱动（kv 在 Node 下自动落到内存后端）。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "desktop-ok"), Channel: undefined }));

import { invoke, browserHandlers, createChannel } from "./invoke.js";

describe("invoke 桌面直通", () => {
  it("Node/桌面环境下调用原生 invoke", async () => {
    await expect(invoke("db_query", { sql: "select 1" })).resolves.toBe("desktop-ok");
  });

  it("桌面环境缺少 Channel 导出时给出明确错误", () => {
    expect(() => createChannel()).toThrow(/仅桌面端/);
  });
});

describe("browserHandlers 存储语义", () => {
  it("save/load 往返，缺失键返回空数组（对齐 Rust 约定）", async () => {
    await browserHandlers.save_data({ key: "platform-test", data: { items: [1, 2] } });
    await expect(browserHandlers.load_data({ key: "platform-test" })).resolves.toEqual({ items: [1, 2] });
    await expect(browserHandlers.load_data({ key: "platform-test-missing" })).resolves.toEqual([]);
  });

  it("图片附件存 base64，缺失时抛「图片不存在」", async () => {
    await browserHandlers.save_image({ name: "shot.png", dataB64: "AAAA" });
    await expect(browserHandlers.load_image({ name: "shot.png" })).resolves.toBe("AAAA");
    await browserHandlers.delete_image({ name: "shot.png" });
    await expect(browserHandlers.load_image({ name: "shot.png" })).rejects.toThrow("图片不存在");
  });

  it("加密在浏览器端为明文往返，enc: 前缀协议仍自洽", async () => {
    const cipher = await browserHandlers.encrypt_text({ plain: "sk-test" });
    expect(cipher).toBe("sk-test");
    await expect(browserHandlers.decrypt_text({ cipher })).resolves.toBe("sk-test");
  });

  it("遥测与自动备份在浏览器端静默跳过", async () => {
    await expect(browserHandlers.telemetry_submit({ events: [{}] })).resolves.toBeUndefined();
    await expect(browserHandlers.auto_backup({ stamp: "2026-09-10" })).resolves.toBe("");
  });

  it("版本化读写：修订号一致才写入，不一致拒绝（对齐 Rust 乐观锁语义）", async () => {
    await browserHandlers.save_data({ key: "platform-ver", data: [{ id: "a" }] });
    const { data, revision } = await browserHandlers.load_data_versioned({ key: "platform-ver" });
    expect(data).toEqual([{ id: "a" }]);
    expect(revision).toBeTruthy();

    await browserHandlers.save_data_versioned({ key: "platform-ver", data: [{ id: "a" }, { id: "b" }], expected_revision: revision });
    await expect(browserHandlers.load_data({ key: "platform-ver" })).resolves.toEqual([{ id: "a" }, { id: "b" }]);

    await expect(
      browserHandlers.save_data_versioned({ key: "platform-ver", data: [], expected_revision: revision })
    ).rejects.toThrow(/已被其他页面/);
  });

  it("版本化读写在键缺失时以空数组为基准（与桌面端一致）", async () => {
    const { data, revision } = await browserHandlers.load_data_versioned({ key: "platform-ver-missing" });
    expect(data).toEqual([]);
    await expect(
      browserHandlers.save_data_versioned({ key: "platform-ver-missing", data: [1], expected_revision: revision })
    ).resolves.toBeTruthy();
  });

  it("落盘前归一化为普通值：非结构化克隆的载荷（响应式代理/函数）不会写坏 IndexedDB", async () => {
    // 浏览器实测缺陷：视图传入 Vue 响应式代理 → IDBObjectStore.put 抛 DataCloneError
    const reactiveish = [{ id: "a", nested: { k: 1 } }];
    reactiveish.fn = () => {}; // 函数不可结构化克隆，作为代理的等价替身
    await browserHandlers.save_data({ key: "platform-plain", data: reactiveish });
    const stored = await browserHandlers.load_data({ key: "platform-plain" });
    expect(() => structuredClone(stored)).not.toThrow();
    expect(stored).toEqual([{ id: "a", nested: { k: 1 } }]);

    const { revision } = await browserHandlers.load_data_versioned({ key: "platform-plain" });
    await browserHandlers.save_data_versioned({ key: "platform-plain", data: reactiveish, expected_revision: revision });
    const after = await browserHandlers.load_data({ key: "platform-plain" });
    expect(() => structuredClone(after)).not.toThrow();
  });
});

describe("未实现的命令", () => {
  it("Node 环境直通，浏览器环境才需要拦截（此处仅验证处理器清单）", () => {
    expect(Object.keys(browserHandlers)).toEqual([
      "load_data",
      "save_data",
      "load_data_versioned",
      "save_data_versioned",
      "save_image",
      "load_image",
      "delete_image",
      "export_file",
      "export_file_b64",
      "http_request",
      "encrypt_text",
      "decrypt_text",
      "telemetry_submit",
      "auto_backup",
    ]);
  });
});
