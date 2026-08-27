import { describe, it, expect } from "vitest";
import { createSyncEngine } from "./engine.js";

// 内存版同步服务器（与真实协议同构：collection/pair/items seq 游标 + Bearer）
function memServer() {
  const state = { collections: new Map() };
  function ensure(cid) {
    if (!state.collections.has(cid)) {
      state.collections.set(cid, { meta: { salt: "salt" }, pair: { codeHash: "PAIRCODE1", fails: 0 }, devices: {}, items: {}, seq: 0 });
    }
    return state.collections.get(cid);
  }
  const api = async ({ method, url, headers, body }, cid, token) => {
    const doc = ensure(cid);
    if (url.endsWith("/v1/collection")) {
      return { status: 200, json: { collectionId: "mem-" + cid, pairingCode: "PAIRCODE1", expiresAt: 0, salt: "salt" } };
    }
    if (url.endsWith("/v1/pair")) {
      const b = JSON.parse(body);
      if (!doc.pair) return { status: 401, json: { error: "bad-code" } };
      if (b.code !== doc.pair.codeHash) {
        doc.pair.fails = (doc.pair.fails || 0) + 1;
        if (doc.pair.fails >= 5) return { status: 429, json: { error: "locked" } };
        return { status: 401, json: { error: "bad-code" } };
      }
      const tk = "tok-" + Math.random().toString(36).slice(2, 12);
      doc.devices[tk] = { name: b.deviceName, tokenTail: tk.slice(-8), createdAt: 0, lastSeen: 0, revoked: false };
      return { status: 200, json: { token: tk, salt: doc.meta.salt } };
    }
    if (!token || !doc.devices[token] || doc.devices[token].revoked) return { status: 401, json: { error: "unauthorized" } };
    if (url.includes("/v1/items") && method === "GET") {
      const since = Number(new URL(url, "http://x").searchParams.get("since")) || 0;
      const items = Object.values(doc.items).filter((v) => v.seq > since).sort((a, b) => a.seq - b.seq);
      return { status: 200, json: { items, hasMore: false, nextSeq: items.length ? items[items.length - 1].seq : since, serverTime: Date.now() } };
    }
    if (url.endsWith("/v1/items") && method === "PUT") {
      const list = JSON.parse(body).items;
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
      return { status: 200, json: { accepted, rejected } };
    }
    return { status: 404, json: { error: "not-found" } };
  };
  return { state, api, ensure };
}

function makeCtx(sharedServer) {
  const server = sharedServer || memServer();
  const settings = {
    enabled: true,
    serverUrl: "http://mem.test",
    collectionId: "col-1",
    deviceName: "dev-a",
    deviceId: "devA",
    salt: "c2FsdA==",
    keyCipher: "",
    cursor: 0,
    lastPushedAt: 0,
    status: "idle",
  };
  const snippets = [{ id: "s1", updatedAt: 100, title: "hello", images: [] }];
  const tombstones = {};
  let token = null;
  const engine = createSyncEngine({
    transport: async (r) => server.api(r, settings.collectionId, token),
    getConfig: () => ({ ...settings }),
    saveConfig: async (patch) => Object.assign(settings, patch),
    masterKeyProvider: async () => "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
    tokenProvider: async () => token,
    deviceId: settings.deviceId,
    recordSources: [
      {
        key: "snippets",
        get: () => snippets,
        apply: (ops) => {
          for (const op of ops) {
            if (op.type === "add" || op.type === "update") {
              const i = snippets.findIndex((x) => x.id === op.record.id);
              if (i >= 0) snippets[i] = op.record;
              else snippets.push(op.record);
            } else if (op.type === "delete") {
              const i = snippets.findIndex((x) => x.id === op.record.id);
              if (i >= 0) snippets.splice(i, 1);
            }
          }
        },
      },
    ],
    getTombstones: () => tombstones,
    setTombstones: (t) => Object.assign(tombstones, t),
    callbacks: {},
    debounceMs: 10,
  });
  return { engine, settings, snippets, tombstones, server, setToken: (t) => (token = t) };
}

describe("engine 配对流", () => {
  it("createCollection 返回码与盐", async () => {
    const ctx = makeCtx();
    const r = await ctx.engine.createCollection();
    expect(r.pairingCode).toBe("PAIRCODE1");
    expect(r.salt).toBeTruthy();
  });

  it("joinCollection 成功拿 token；错误码抛出对应错误", async () => {
    const ctx = makeCtx();
    ctx.settings.collectionId = "col-2";
    ctx.server.ensure("col-2");
    const ok = await ctx.engine.joinCollection("col-2", "PAIRCODE1");
    expect(ok.token).toBeTruthy();
    await expect(ctx.engine.joinCollection("col-2", "WRONG")).rejects.toThrow("sync.errBadCode");
  });
});

describe("engine 推拉闭环（A/B 双设备共享服务器）", () => {
  it("A 变更 → 推送 → B 拉取解密合并可见", async () => {
    const shared = memServer();
    const a = makeCtx(shared);
    const b = makeCtx(shared);
    const pa = await a.engine.joinCollection("col-1", "PAIRCODE1");
    a.setToken(pa.token);
    const pb = await b.engine.joinCollection("col-1", "PAIRCODE1");
    b.setToken(pb.token);

    a.snippets[0].title = "updated-on-A";
    a.snippets[0].updatedAt = 5000;
    a.engine.enqueue(a.snippets);
    await new Promise((r) => setTimeout(r, 30));
    await a.engine.syncNow();

    await b.engine.syncNow();
    expect(b.snippets.find((x) => x.id === "s1").title).toBe("updated-on-A");
  });

  it("增量拉取游标推进：再次同步不重复不丢失", async () => {
    const shared = memServer();
    const a = makeCtx(shared);
    const b = makeCtx(shared);
    const pa = await a.engine.joinCollection("col-1", "PAIRCODE1");
    a.setToken(pa.token);
    const pb = await b.engine.joinCollection("col-1", "PAIRCODE1");
    b.setToken(pb.token);

    a.snippets[0].title = "fromA";
    a.snippets[0].updatedAt = 3000;
    a.engine.enqueue(a.snippets);
    await new Promise((r) => setTimeout(r, 30));
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.snippets.find((x) => x.id === "s1").title).toBe("fromA");
    await b.engine.syncNow();
    expect(b.snippets).toHaveLength(1);
  });
});

describe("engine 异常路径", () => {
  it("401 → revoked，本地保留，且 error 不得覆盖", async () => {
    const ctx = makeCtx();
    ctx.setToken("bad-token");
    // 直接同步（避免防抖双跑竞态）：401 → revoked
    await ctx.engine.syncNow();
    expect(ctx.engine.currentStatus().status).toBe("revoked");
    expect(ctx.snippets).toHaveLength(1);
  });

  it("墓碑：A 删除后同步 → B 应用删除", async () => {
    const shared = memServer();
    const a = makeCtx(shared);
    const b = makeCtx(shared);
    const pa = await a.engine.joinCollection("col-1", "PAIRCODE1");
    a.setToken(pa.token);
    const pb = await b.engine.joinCollection("col-1", "PAIRCODE1");
    b.setToken(pb.token);
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.snippets).toHaveLength(1);

    a.tombstones.s1 = Date.now();
    await a.engine.syncNow();
    await b.engine.syncNow();
    expect(b.snippets.find((x) => x.id === "s1")).toBeUndefined();
  });
});