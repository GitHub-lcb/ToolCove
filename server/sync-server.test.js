// ToolCove 云同步服务端测试（node:test 内置运行器，零依赖）
// 运行：node --test server/sync-server.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSyncServer } from "./sync-server.js";

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "toolcove-sync-"));
}

async function startServer(dataDir) {
  const server = createSyncServer({ dataDir });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base };
}

async function req(base, method, p, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + p, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

const PID = "a".repeat(64);
const PID2 = "b".repeat(64);

test("创建集合返回配对码与 salt；pair 非法集合 404", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir);
  const r = await req(base, "POST", "/v1/collection");
  assert.equal(r.status, 200);
  assert.ok(r.json.collectionId && /^[a-f0-9-]{36}$/.test(r.json.collectionId));
  assert.equal(r.json.pairingCode.length, 8);
  assert.ok(r.json.salt && typeof r.json.salt === "string");
  assert.ok(r.json.expiresAt > Date.now());
  const bad = await req(base, "POST", "/v1/pair", { body: { collectionId: "no-such", code: "xxxx" } });
  assert.equal(bad.status, 404);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("配对：错误码 401、失败 5 次锁定 429、多设备共用一码", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir);
  const c = await req(base, "POST", "/v1/collection");
  const { collectionId, pairingCode } = c.json;
  for (let i = 0; i < 5; i++) {
    const bad = await req(base, "POST", "/v1/pair", { body: { collectionId, code: "WRONG" + i, deviceName: "d" } });
    assert.equal(bad.status, 401);
  }
  const locked = await req(base, "POST", "/v1/pair", { body: { collectionId, code: "WRONG6", deviceName: "d" } });
  assert.equal(locked.status, 429);
  const stillLocked = await req(base, "POST", "/v1/pair", { body: { collectionId, code: pairingCode, deviceName: "ok" } });
  assert.equal(stillLocked.status, 429);

  // 新集合：两台设备共用同一配对码
  const c2 = await req(base, "POST", "/v1/collection");
  const ok1 = await req(base, "POST", "/v1/pair", { body: { collectionId: c2.json.collectionId, code: c2.json.pairingCode, deviceName: "dev-a" } });
  assert.equal(ok1.status, 200);
  assert.ok(ok1.json.token);
  assert.equal(ok1.json.salt, c2.json.salt);
  const ok2 = await req(base, "POST", "/v1/pair", { body: { collectionId: c2.json.collectionId, code: c2.json.pairingCode, deviceName: "dev-b" } });
  assert.equal(ok2.status, 200);
  assert.notEqual(ok2.json.token, ok1.json.token);
  assert.equal(ok2.json.salt, c2.json.salt);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("重新生成配对码：旧码作废新码生效", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir);
  const c = await req(base, "POST", "/v1/collection");
  const p1 = await req(base, "POST", "/v1/pair", { body: { collectionId: c.json.collectionId, code: c.json.pairingCode, deviceName: "d1" } });
  const regen = await req(base, "POST", "/v1/pairing-code", { token: p1.json.token });
  assert.equal(regen.status, 200);
  assert.equal(regen.json.pairingCode.length, 8);
  const old = await req(base, "POST", "/v1/pair", { body: { collectionId: c.json.collectionId, code: c.json.pairingCode, deviceName: "d2" } });
  assert.equal(old.status, 401);
  const nw = await req(base, "POST", "/v1/pair", { body: { collectionId: c.json.collectionId, code: regen.json.pairingCode, deviceName: "d2" } });
  assert.equal(nw.status, 200);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("推送/拉取：seq 游标、幂等、更新分配新 seq、墓碑、非法条目拒收", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir);
  const c = await req(base, "POST", "/v1/collection");
  const p = await req(base, "POST", "/v1/pair", { body: { collectionId: c.json.collectionId, code: c.json.pairingCode, deviceName: "dev" } });
  const token = p.json.token;
  assert.equal((await req(base, "GET", "/v1/items?since=0")).status, 401);

  const put1 = await req(base, "PUT", "/v1/items", { token, body: { items: [
    { id: PID, updatedAt: 1000, data: "AAAA", tombstone: false },
    { id: PID2, updatedAt: 1000, data: "BBBB", tombstone: false },
  ] } });
  assert.equal(put1.json.accepted, 2);

  const put2 = await req(base, "PUT", "/v1/items", { token, body: { items: [{ id: PID, updatedAt: 1000, data: "AAAA", tombstone: false }] } });
  assert.equal(put2.json.accepted, 0); // 幂等

  const get1 = await req(base, "GET", "/v1/items?since=0", { token });
  assert.equal(get1.json.items.length, 2);
  assert.equal(get1.json.items[0].id, PID);
  assert.ok(get1.json.items[0].seq < get1.json.items[1].seq);
  const since1 = get1.json.items[0].seq;
  const get2 = await req(base, "GET", `/v1/items?since=${since1}`, { token });
  assert.equal(get2.json.items.length, 1);
  assert.equal(get2.json.items[0].id, PID2);

  const put3 = await req(base, "PUT", "/v1/items", { token, body: { items: [{ id: PID, updatedAt: 2000, data: "AAAA2", tombstone: false }] } });
  assert.equal(put3.json.accepted, 1);
  const get3 = await req(base, "GET", "/v1/items?since=0&limit=2000", { token });
  const pidEntry = get3.json.items.find((x) => x.id === PID);
  assert.equal(pidEntry.updatedAt, 2000);
  assert.equal(pidEntry.data, "AAAA2");

  const put4 = await req(base, "PUT", "/v1/items", { token, body: { items: [{ id: PID, updatedAt: 3000, data: "", tombstone: true }] } });
  assert.equal(put4.json.accepted, 1);
  const get4 = await req(base, "GET", "/v1/items?since=0&limit=2000", { token });
  assert.equal(get4.json.items.find((x) => x.id === PID).tombstone, true);

  const put5 = await req(base, "PUT", "/v1/items", { token, body: { items: [
    { id: "zzz", updatedAt: 1, data: "x" },
    { id: PID, updatedAt: "bad", data: "x" },
  ] } });
  assert.equal(put5.json.accepted, 0);
  assert.equal(put5.json.rejected.length, 2);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("大条目拒收（密文 >2MB）", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir);
  const c = await req(base, "POST", "/v1/collection");
  const p = await req(base, "POST", "/v1/pair", { body: { collectionId: c.json.collectionId, code: c.json.pairingCode, deviceName: "dev" } });
  const big = "x".repeat(2 * 1024 * 1024 + 10);
  const r = await req(base, "PUT", "/v1/items", { token: p.json.token, body: { items: [{ id: PID, updatedAt: 1, data: big }] } });
  assert.equal(r.json.accepted, 0);
  assert.equal(r.json.rejected[0].reason, "item-too-large");
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("设备列表与吊销（自/他）、吊销后 401", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir);
  const c = await req(base, "POST", "/v1/collection");
  const p1 = await req(base, "POST", "/v1/pair", { body: { collectionId: c.json.collectionId, code: c.json.pairingCode, deviceName: "dev-a" } });
  const p2 = await req(base, "POST", "/v1/pair", { body: { collectionId: c.json.collectionId, code: c.json.pairingCode, deviceName: "dev-b" } });

  const list = await req(base, "GET", "/v1/devices", { token: p1.json.token });
  assert.equal(list.json.devices.length, 2);
  const self = list.json.devices.find((d) => d.self);
  assert.ok(self.tokenHash && self.tokenTail.length === 8);
  const other = list.json.devices.find((d) => !d.self);

  const rev = await req(base, "DELETE", `/v1/device?tokenHash=${other.tokenHash}`, { token: p1.json.token });
  assert.equal(rev.status, 200);
  const list2 = await req(base, "GET", "/v1/devices", { token: p1.json.token });
  assert.equal(list2.json.devices.length, 1);

  const ghost = await req(base, "GET", "/v1/items?since=0", { token: p2.json.token });
  assert.equal(ghost.status, 401);

  const selfRevoke = await req(base, "DELETE", `/v1/device?tokenHash=${self.tokenHash}`, { token: p1.json.token });
  assert.equal(selfRevoke.status, 200);
  const gone = await req(base, "GET", "/v1/items?since=0", { token: p1.json.token });
  assert.equal(gone.status, 401);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("重启持久化：数据与设备不丢失", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir);
  const c = await req(base, "POST", "/v1/collection");
  const p = await req(base, "POST", "/v1/pair", { body: { collectionId: c.json.collectionId, code: c.json.pairingCode, deviceName: "dev" } });
  await req(base, "PUT", "/v1/items", { token: p.json.token, body: { items: [{ id: PID, updatedAt: 1, data: "AAA" }] } });
  await new Promise((resolve) => server.close(resolve));

  const { server: server2, base: base2 } = await startServer(dir);
  const get = await req(base2, "GET", "/v1/items?since=0", { token: p.json.token });
  assert.equal(get.status, 200);
  assert.equal(get.json.items.length, 1);
  assert.equal(get.json.items[0].data, "AAA");
  server2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("限流：超过阈值返回 429", async () => {
  const dir = tempDataDir();
  const server = createSyncServer({ dataDir: dir, rate: 5 });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  let last = 200;
  for (let i = 0; i < 8; i++) {
    last = (await req(base, "GET", "/v1/items?since=0")).status;
  }
  assert.equal(last, 429);
  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
});