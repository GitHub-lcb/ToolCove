// ToolCove 企业服务器测试（node:test 内置运行器，零依赖）
// 运行：node --test server/enterprise-server.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createEnterpriseServer, startEnterpriseServer } from "./enterprise-server.js";

const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "toolcove-ent-"));
}

async function startServer(dataDir, members, opts = {}) {
  const server = new (await import("node:http")).default.createServer(
    createEnterpriseServer({ dataDir, members, ...opts }).handler
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// fetch（undici）默认 keep-alive，连接不关会让 server.close() 一直等——先把存活连接全断掉。
function stopServer(server) {
  server.closeAllConnections?.();
  server.close();
}

/** 关掉 startEnterpriseServer 起的服务：同样要先断存活连接。 */
function stopStarted(s) {
  return new Promise((resolve) => {
    s.server.closeAllConnections?.();
    s.server.close(resolve);
  });
}

async function req(base, method, p, { token, body } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// 工厂接受带明文 token 的成员数组（自动转 tokenHash），方便单测构造。
const ADMIN_TOKEN = "tc_test-admin";
const MEMBER_TOKEN = "tc_test-member";
const MEMBERS = [
  { id: "m-admin", name: "云仓研发组", role: "admin", token: ADMIN_TOKEN },
  { id: "m-member", name: "成员甲", role: "member", token: MEMBER_TOKEN },
];

test("ping：无令牌 401、错误令牌 401、正确令牌回 name + role", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, MEMBERS);
  assert.equal((await req(base, "POST", "/v1/auth/ping")).status, 401);
  assert.equal((await req(base, "POST", "/v1/auth/ping", { token: "wrong" })).status, 401);
  const ok = await req(base, "POST", "/v1/auth/ping", { token: ADMIN_TOKEN });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, name: "云仓研发组", role: "admin" });
  const member = await req(base, "POST", "/v1/auth/ping", { token: MEMBER_TOKEN });
  assert.deepEqual(member.json, { ok: true, name: "成员甲", role: "member" });
  stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("kv：未写入 404，PUT 后 GET 回原值（含 null 与特殊字符键）", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, MEMBERS);
  assert.equal((await req(base, "GET", "/v1/kv/settings", { token: ADMIN_TOKEN })).status, 404);

  const put = await req(base, "PUT", "/v1/kv/settings", { token: ADMIN_TOKEN, body: { data: { a: 1 } } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { ok: true });

  const get = await req(base, "GET", "/v1/kv/settings", { token: ADMIN_TOKEN });
  assert.equal(get.status, 200);
  assert.deepEqual(get.json, { data: { a: 1 } });

  // 键里带斜杠/空格等：encodeURIComponent 后仍要能精确命中
  const key = encodeURIComponent("release-pools/云仓 #1");
  await req(base, "PUT", `/v1/kv/${key}`, { token: ADMIN_TOKEN, body: { data: { active: [] } } });
  const back = await req(base, "GET", `/v1/kv/${key}`, { token: ADMIN_TOKEN });
  assert.deepEqual(back.json, { data: { active: [] } });

  // data 为 null 是可存的有效值（客户端 load_data 空值约定）
  await req(base, "PUT", "/v1/kv/nullkey", { token: ADMIN_TOKEN, body: { data: null } });
  assert.deepEqual((await req(base, "GET", "/v1/kv/nullkey", { token: ADMIN_TOKEN })).json, { data: null });
  stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("kv：无令牌 401；超上限 413；非法 JSON 400", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, MEMBERS, { maxBytes: 1024 });
  assert.equal((await req(base, "GET", "/v1/kv/x")).status, 401);

  const big = await req(base, "PUT", "/v1/kv/x", { token: ADMIN_TOKEN, body: { data: "z".repeat(4096) } });
  assert.equal(big.status, 413);

  const raw = await fetch(`${base}/v1/kv/x`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: "{not json",
  });
  assert.equal(raw.status, 400);
  stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("首次启动自动签发管理员成员并落盘（之后重启复用同一令牌）", async () => {
  const dir = tempDataDir();
  const first = await startEnterpriseServer({ dataDir: dir, port: 0, host: "127.0.0.1" });
  try {
    assert.ok(first.created && first.created.token.startsWith("tc_"));
    assert.equal(first.created.role, "admin");
    assert.ok(fs.existsSync(first.membersFile), "应落盘 members.json");
    const base = `http://127.0.0.1:${first.port}`;
    const ping = await req(base, "POST", "/v1/auth/ping", { token: first.created.token });
    assert.equal(ping.status, 200);
    assert.equal(ping.json.role, "admin");
  } finally {
    await stopStarted(first);
  }

  const second = await startEnterpriseServer({ dataDir: dir, port: 0, host: "127.0.0.1" });
  try {
    assert.equal(second.created, null, "第二次启动不应再签发新令牌");
    assert.equal(second.members.length, 1);
    const base = `http://127.0.0.1:${second.port}`;
    assert.equal((await req(base, "POST", "/v1/auth/ping", { token: first.created.token })).status, 200, "旧令牌仍可复用");
  } finally {
    await stopStarted(second);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("未知路由 404；GET 之外的写方法不越权", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, MEMBERS);
  assert.equal((await req(base, "GET", "/v1/nope", { token: ADMIN_TOKEN })).status, 404);
  assert.equal((await req(base, "DELETE", "/v1/kv/x", { token: ADMIN_TOKEN })).status, 405);
  stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("成员：admin 可列/建/删；新建令牌可 ping 且 role 正确", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, MEMBERS);
  try {
    const list = await req(base, "GET", "/v1/members", { token: ADMIN_TOKEN });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.members.map((m) => m.id).sort(), ["m-admin", "m-member"]);
    assert.deepEqual(Object.keys(list.json.members[0]).sort(), ["createdAt", "id", "name", "role"]);
    // 列表绝不回令牌/哈希
    assert.equal(JSON.stringify(list.json).includes("tc_test"), false);

    // 缺 name → 400
    assert.equal((await req(base, "POST", "/v1/members", { token: ADMIN_TOKEN, body: {} })).status, 400);

    const created = await req(base, "POST", "/v1/members", { token: ADMIN_TOKEN, body: { name: "新同学" } });
    assert.equal(created.status, 201);
    assert.ok(created.json.token.startsWith("tc_"));
    assert.equal(created.json.member.name, "新同学");
    assert.equal(created.json.member.role, "member", "默认角色为 member");
    assert.ok(created.json.member.id);

    // 新建成员返回的令牌可用于 ping 且 role 正确
    const ping = await req(base, "POST", "/v1/auth/ping", { token: created.json.token });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json, { ok: true, name: "新同学", role: "member" });

    // 删除新建成员 → 200；再删 → 404
    const del = await req(base, "DELETE", `/v1/members/${created.json.member.id}`, { token: ADMIN_TOKEN });
    assert.equal(del.status, 200);
    assert.deepEqual(del.json, { ok: true });
    assert.equal((await req(base, "DELETE", `/v1/members/${created.json.member.id}`, { token: ADMIN_TOKEN })).status, 404);
  } finally {
    stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("成员：非 admin（member 令牌）访问列表/新建/删除均 403；无令牌 401", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, MEMBERS);
  try {
    assert.equal((await req(base, "GET", "/v1/members", { token: MEMBER_TOKEN })).status, 403);
    assert.equal((await req(base, "POST", "/v1/members", { token: MEMBER_TOKEN, body: { name: "x" } })).status, 403);
    assert.equal((await req(base, "DELETE", "/v1/members/m-admin", { token: MEMBER_TOKEN })).status, 403);
    // 无/错令牌先 401
    assert.equal((await req(base, "GET", "/v1/members")).status, 401);
    assert.equal((await req(base, "GET", "/v1/members", { token: "wrong" })).status, 401);
  } finally {
    stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("成员：删除自己 400 cannot_revoke_self", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, MEMBERS);
  try {
    const self = await req(base, "DELETE", "/v1/members/m-admin", { token: ADMIN_TOKEN });
    assert.equal(self.status, 400);
    assert.deepEqual(self.json, { ok: false, error: "cannot_revoke_self" });
    // 自己还在
    assert.equal((await req(base, "GET", "/v1/members", { token: ADMIN_TOKEN })).json.members.length, 2);
  } finally {
    stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("成员：席位配额满时 POST 409 seat_limit（含 admin 计数）", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, MEMBERS, { seats: 2 }); // 已有 2 名（含 admin）
  try {
    const over = await req(base, "POST", "/v1/members", { token: ADMIN_TOKEN, body: { name: "第三人" } });
    assert.equal(over.status, 409);
    assert.deepEqual(over.json, { ok: false, error: "seat_limit" });

    // 删掉一个腾出席位后可再建
    assert.equal((await req(base, "DELETE", "/v1/members/m-member", { token: ADMIN_TOKEN })).status, 200);
    assert.equal((await req(base, "POST", "/v1/members", { token: ADMIN_TOKEN, body: { name: "第三人" } })).status, 201);
  } finally {
    stopServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移：旧 tokens.json 自动转 members.json，旧明文令牌仍可 ping", async () => {
  const dir = tempDataDir();
  fs.writeFileSync(
    path.join(dir, "tokens.json"),
    JSON.stringify({ tokens: [{ token: "tc_legacy", name: "老工作区", role: "admin" }] })
  );
  const started = await startEnterpriseServer({ dataDir: dir, port: 0, host: "127.0.0.1" });
  try {
    assert.equal(started.created, null);
    assert.equal(started.migrated, 1);
    assert.ok(fs.existsSync(path.join(dir, "members.json")), "应生成 members.json");
    assert.ok(fs.existsSync(path.join(dir, "tokens.json")), "旧 tokens.json 应保留不动");

    const base = `http://127.0.0.1:${started.port}`;
    const ping = await req(base, "POST", "/v1/auth/ping", { token: "tc_legacy" });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.json, { ok: true, name: "老工作区", role: "admin" });

    // members.json 只存哈希，不存明文令牌
    const stored = fs.readFileSync(path.join(dir, "members.json"), "utf8");
    assert.equal(stored.includes("tc_legacy"), false);
    assert.ok(stored.includes(sha256Hex("tc_legacy")), "应存 tokenHash");
  } finally {
    await stopStarted(started);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("迁移：members.json 与 tokens.json 并存时以 members.json 为准", async () => {
  const dir = tempDataDir();
  fs.writeFileSync(path.join(dir, "tokens.json"), JSON.stringify({ tokens: [{ token: "tc_old", name: "旧", role: "admin" }] }));
  fs.writeFileSync(
    path.join(dir, "members.json"),
    JSON.stringify({ members: [{ id: "seed", name: "新", role: "admin", tokenHash: sha256Hex("tc_new"), createdAt: 1 }] })
  );
  const started = await startEnterpriseServer({ dataDir: dir, port: 0, host: "127.0.0.1" });
  try {
    assert.equal(started.created, null);
    const base = `http://127.0.0.1:${started.port}`;
    assert.equal((await req(base, "POST", "/v1/auth/ping", { token: "tc_old" })).status, 401, "旧文件被忽略");
    const ping = await req(base, "POST", "/v1/auth/ping", { token: "tc_new" });
    assert.equal(ping.status, 200);
    assert.equal(ping.json.name, "新");
  } finally {
    await stopStarted(started);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
