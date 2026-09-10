// P0 真服务验收：真实 server/sync-server.js（HTTP 回环）+ 生产装配链路
// （真实配对 → 真实 PBKDF2 派生 → 真实 WebCrypto 加解密 → 真实 HTTP 推拉）。
// 只把「桌面平台命令」替成内存实现：数据落内存 store，http_request 走真 fetch。
// 验收目标与计划 4.5 一致：A 建速记 → 同步 → B 拉到；A 删速记 → B 侧记录消失。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSyncServer } from "../../server/sync-server.js";

const PASSWORD = "toolcove-test-pass";
const realSetTimeout = globalThis.setTimeout;

const hv = vi.hoisted(() => {
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const revisionOf = (v) => "r" + (JSON.stringify(v ?? null) ?? "null").length;
  return { device: null, clone, revisionOf };
});

vi.mock("@tauri-apps/api/core", () => ({
  Channel: undefined,
  invoke: vi.fn(async (cmd, args = {}) => {
    const d = hv.device;
    if (!d) throw new Error("realServer-test：未设置当前设备");
    if (cmd === "load_data") return d.store.has(args.key) ? hv.clone(d.store.get(args.key)) : [];
    if (cmd === "load_data_versioned") {
      const value = d.store.has(args.key) ? d.store.get(args.key) : [];
      return { data: hv.clone(value), revision: hv.revisionOf(value) };
    }
    if (cmd === "save_data") {
      d.store.set(args.key, hv.clone(args.data));
      return undefined;
    }
    if (cmd === "save_data_versioned") {
      const current = d.store.has(args.key) ? d.store.get(args.key) : [];
      if (hv.revisionOf(current) !== String(args.expected_revision ?? "")) {
        throw new Error("数据已被其他页面或后台任务更新，本次保存已拒绝；请重新进入页面后再修改");
      }
      d.store.set(args.key, hv.clone(args.data));
      return hv.revisionOf(args.data);
    }
    if (cmd === "http_request") {
      // 生产 transport 形状：{ status, body(JSON 文本) }
      const res = await fetch(args.url, {
        method: args.method,
        headers: Object.fromEntries((args.headers || []).map(([k, v]) => [k, v])),
        body: args.body || undefined,
        signal: AbortSignal.timeout(15000),
      });
      return { status: res.status, body: await res.text() };
    }
    throw new Error("未知命令 " + cmd);
  }),
}));

vi.mock("../secure.js", () => ({
  encryptValue: async (v) => "enc:" + v,
  decryptValue: async (c) => (typeof c === "string" && c.startsWith("enc:") ? c.slice(4) : c),
}));

class StubCustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
}

function makeWindow(device) {
  const handlers = new Map();
  return {
    __TAURI_INTERNALS__: {},
    addEventListener: (type, fn) => handlers.set(type, [...(handlers.get(type) || []), fn]),
    removeEventListener: (type, fn) => handlers.set(type, (handlers.get(type) || []).filter((h) => h !== fn)),
    dispatchEvent: (event) => {
      device.events.push({ type: event.type, detail: event.detail });
      for (const fn of handlers.get(event.type) || []) fn(event);
      return true;
    },
  };
}

function newDevice({ id }) {
  const store = new Map();
  store.set("settings", { sync: { serverUrl: hv.base, deviceName: id } });
  const device = { id, store, events: [], repository: null, sync: null };
  device.window = makeWindow(device);
  return device;
}

async function bootDevice(device) {
  hv.device = device;
  vi.stubGlobal("window", device.window);
  vi.resetModules();
  device.repository = await import("../data/repository.js");
  device.sync = await import("./index.js");
  return device;
}

async function settle(label, predicate, tries = 300) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((r) => realSetTimeout(r, 0));
  }
  throw new Error(`settle 超时：${label}`);
}

/** 直接读服务端落盘文件（绕过客户端，验证服务端真实持有内容） */
function serverItems(dataDir, collectionId) {
  const file = path.join(dataDir, `${collectionId}.json`);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  return Object.values(doc.items || {});
}

let dataDir = "";
let server = null;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T08:00:00Z"));
  vi.stubGlobal("CustomEvent", StubCustomEvent);
  hv.device = null;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "toolcove-wiring-"));
  server = createSyncServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  hv.base = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("云同步接线（真实服务端）", () => {
  it("配对 → A 建速记自动上云 → B 拉取落地 → A 删除传播 → B 同步删除", async () => {
    const a = newDevice({ id: "devA" });
    const b = newDevice({ id: "devB" });

    // ── 阶段 1（A）：真实创建集合 + 加入（PBKDF2 派生 + 配对拿 token）
    await bootDevice(a);
    const { pairingCode } = await a.sync.createSyncCollection(hv.base, PASSWORD);
    const settingsA = a.store.get("settings").sync;
    expect(settingsA.enabled).toBe(true);
    expect(settingsA.collectionId).toBeTruthy();
    expect(settingsA.keyCipher.startsWith("enc:")).toBe(true);

    // ── 阶段 1b（A）：仓库层建速记 → 防抖自动推送
    const engineA1 = await a.sync.getEngine();
    const created = await a.repository.create("snippets", { title: "来自A", content: "body" });
    await vi.advanceTimersByTimeAsync(3500);
    await settle("A 推送到真实服务端", () => engineA1.currentStatus().status === "idle" && serverItems(dataDir, settingsA.collectionId).length === 1);
    const stored = serverItems(dataDir, settingsA.collectionId);
    expect(stored[0].tombstone).toBe(false);
    expect(stored[0].data).not.toContain("来自A"); // 密文上云
    expect(stored[0].deviceId).toBe(settingsA.deviceId);

    // ── 阶段 2（B）：用配对码加入 → 手动同步拉取 → 记录落盘
    await bootDevice(b);
    await b.sync.joinSyncCollectionFull(hv.base, settingsA.collectionId, pairingCode, PASSWORD);
    await b.sync.syncNowManual();
    await settle("B 落盘记录", () => (b.store.get("snippets") || []).some((r) => r.id === created.id));
    expect(b.store.get("snippets")[0]).toMatchObject({ id: created.id, title: "来自A", content: "body" });
    expect(b.events.some((e) => e.type === "data-changed" && e.detail && e.detail.source === "sync")).toBe(true);

    // ── 阶段 3（A 重启）：仓库删除（墓碑）→ 防抖自动同步
    await bootDevice(a);
    const engineA2 = await a.sync.getEngine();
    await vi.advanceTimersByTimeAsync(1000);
    await a.repository.remove("snippets", created.id);
    await vi.advanceTimersByTimeAsync(3500);
    await settle("A 推送墓碑", () => engineA2.currentStatus().status === "idle" && serverItems(dataDir, settingsA.collectionId).some((it) => it.tombstone === true));
    expect(serverItems(dataDir, settingsA.collectionId)).toHaveLength(1);

    // ── 阶段 4（B 重启）：同步 → 本地记录被墓碑删除
    await bootDevice(b);
    await b.sync.syncNowManual();
    await settle("B 应用删除", () => (b.store.get("snippets") || []).length === 0);
    expect(b.store.get("snippets")).toEqual([]);
  }, 60000);
});
