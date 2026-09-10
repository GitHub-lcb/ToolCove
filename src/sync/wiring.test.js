// P0 接线验收（真实装配路径，双设备）：仓库层写入 → 防抖自动推送 → 另一设备拉取落盘；
// 删除经墓碑跨端传播。全程不导入任何 .vue 视图，证明推送/拉取不依赖视图是否挂载。
//
// 与 engine.test.js 的区别：这里走生产装配（sync/index.js + data/repository.js），
// 只把最外层平台命令（invoke）与 secure 层替成内存实现。
// 每个阶段都是一次「应用启动」：模块状态全新、配置从磁盘装配；
// 设备数据（store）与服务器状态由测试持有，跨阶段延续。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const KEY = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
// 真机推拉链路的收尾是 WebCrypto（crypto.subtle）——要真实事件循环轮次才能 resolve，
// 纯微任务轮询驱动不了；先抓住未被 fake 的原版 setTimeout 用于让出事件循环。
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
    if (!d) throw new Error("wiring-test：未设置当前设备");
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
    if (cmd === "http_request") return d.server.handle(args);
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

// 内存同步服务器：与真实协议同构（Bearer 鉴权 / seq 游标 / 服务端陈旧拒绝）
function makeMemServer() {
  const doc = { items: {}, seq: 0, tokens: { "tok-A": { revoked: false }, "tok-B": { revoked: false } } };
  const items = () => Object.values(doc.items).sort((a, b) => a.seq - b.seq);
  const handle = (req) => {
    const url = new URL(req.url);
    const header = (name) => {
      const hit = (req.headers || []).find(([k]) => String(k).toLowerCase() === name);
      return hit ? hit[1] : "";
    };
    const auth = header("authorization");
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!doc.tokens[token] || doc.tokens[token].revoked) {
      return { status: 401, body: JSON.stringify({ error: "unauthorized" }) };
    }
    if (url.pathname === "/v1/items" && req.method === "GET") {
      const since = Number(url.searchParams.get("since")) || 0;
      const batch = items().filter((v) => v.seq > since);
      return {
        status: 200,
        body: JSON.stringify({ items: batch, hasMore: false, nextSeq: batch.length ? batch[batch.length - 1].seq : since, serverTime: Date.now() }),
      };
    }
    if (url.pathname === "/v1/items" && req.method === "PUT") {
      const list = JSON.parse(req.body || "{}").items || [];
      const rejected = [];
      let accepted = 0;
      for (const it of list) {
        const ex = doc.items[it.id];
        if (ex) {
          if (ex.updatedAt === it.updatedAt && ex.deviceId === it.deviceId && ex.data === it.data && !!ex.tombstone === !!it.tombstone) continue;
          if (it.updatedAt < ex.updatedAt || (it.updatedAt === ex.updatedAt && (it.deviceId || "") <= (ex.deviceId || ""))) {
            rejected.push({ id: it.id, reason: "stale" });
            continue;
          }
        }
        doc.seq += 1;
        doc.items[it.id] = { ...it, seq: doc.seq };
        accepted += 1;
      }
      return { status: 200, body: JSON.stringify({ accepted, rejected }) };
    }
    return { status: 404, body: JSON.stringify({ error: "not-found" }) };
  };
  return { doc, handle, items };
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

/** 设备对象：独立数据存储 + 已配对的同步配置（token/key 以 DPAPI 后的密文串落盘） */
function newDevice({ id, token, server }) {
  const store = new Map();
  store.set("settings", {
    sync: {
      enabled: true,
      serverUrl: "http://mem.test",
      collectionId: "col-1",
      deviceName: id,
      deviceId: id,
      salt: "c2FsdA==",
      keyCipher: "enc:" + KEY,
      tokenCipher: "enc:" + token,
      cursor: 0,
      lastPushedAt: 0,
      status: "idle",
    },
  });
  const device = { id, store, server, events: [], repository: null, sync: null };
  device.window = makeWindow(device);
  return device;
}

/** 一次「应用启动」：模块状态全新（含引擎/配置缓存/墓碑缓存），数据从 store 装配 */
async function bootDevice(device) {
  hv.device = device;
  vi.stubGlobal("window", device.window);
  vi.resetModules();
  device.repository = await import("../data/repository.js");
  device.sync = await import("./index.js");
  return device;
}

/** 条件轮询：先让微任务链推进，再让出真实事件循环（WebCrypto 收尾需要） */
async function settle(label, predicate, tries = 200) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return;
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((r) => realSetTimeout(r, 0));
  }
  throw new Error(`settle 超时：${label}`);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T08:00:00Z"));
  vi.stubGlobal("CustomEvent", StubCustomEvent);
  hv.device = null;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("云同步接线（仓库层直连，无视图）", () => {
  it("A 创建 → 防抖自动推送 → B 拉取落盘；A 删除的墓碑跨端传播且收敛稳定", async () => {
    const server = makeMemServer();
    const a = newDevice({ id: "devA", token: "tok-A", server });
    const b = newDevice({ id: "devB", token: "tok-B", server });

    // ── 阶段 1（A 启动）：仓库层创建（无视图参与），写入自动入队 → 防抖到点自动推送
    await bootDevice(a);
    const created = await a.repository.create("snippets", { title: "来自A", content: "body" });
    const engineA1 = await a.sync.getEngine();
    await settle("A 入队 dirty", () => engineA1.currentStatus().dirty > 0);
    await vi.advanceTimersByTimeAsync(3500);
    await settle("A 自动同步完成", () => engineA1.currentStatus().status === "idle" && server.items().length === 1);
    expect(server.items()).toHaveLength(1);
    expect(server.items()[0].tombstone).toBe(false);
    expect(server.items()[0].data).not.toContain("来自A"); // 明文不上云
    expect(server.items()[0].deviceId).toBe("devA");

    // ── 阶段 2（B 启动）：手动同步拉取 → 解密合并落盘 → 广播 data-changed(source=sync)
    await bootDevice(b);
    await b.sync.syncNowManual();
    await settle("B 落盘记录", () => (b.store.get("snippets") || []).some((r) => r.id === created.id));
    expect(b.store.get("snippets")[0]).toMatchObject({ id: created.id, title: "来自A", content: "body" });
    expect(b.events.some((e) => e.type === "data-changed" && e.detail && e.detail.source === "sync")).toBe(true);

    // ── 阶段 3（A 重启后）：仓库删除（写墓碑）→ 防抖自动同步 → 服务端记录变墓碑
    await bootDevice(a);
    const engineA2 = await a.sync.getEngine();
    await vi.advanceTimersByTimeAsync(1000); // 墓碑时间戳需不早于记录版本（LWW 删除条件）
    await a.repository.remove("snippets", created.id);
    expect(a.store.get("snippets")).toEqual([]);
    await vi.advanceTimersByTimeAsync(3500);
    await settle("A 推送墓碑", () => engineA2.currentStatus().status === "idle" && server.items().some((it) => it.tombstone === true));
    expect(server.items()).toHaveLength(1);
    expect(server.items()[0].tombstone).toBe(true);

    // ── 阶段 4（B 重启后）：同步 → 本地记录被墓碑删除；再同步不回推、服务端不再增长（收敛）
    await bootDevice(b);
    await b.sync.syncNowManual();
    await settle("B 应用删除", () => (b.store.get("snippets") || []).length === 0);
    expect(b.store.get("snippets")).toEqual([]);

    await b.sync.syncNowManual();
    expect(b.store.get("snippets")).toEqual([]);
    expect(server.items()).toHaveLength(1);
    expect(server.items()[0].tombstone).toBe(true);
  });
});
