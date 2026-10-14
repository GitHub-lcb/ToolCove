// ToolCove 企业服务器测试（node:test 内置运行器，零依赖）
// 运行：node --test server/enterprise-server.test.js
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createEnterpriseServer, startEnterpriseServer } from "./enterprise-server.js";

function tempDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "toolcove-ent-"));
}

async function startServer(dataDir, tokens, maxBytes) {
  const server = new (await import("node:http")).default.createServer(
    createEnterpriseServer({ dataDir, tokens, maxBytes }).handler
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

const TOKEN = "tc_test-token";
const TOKENS = [{ token: TOKEN, name: "云仓研发组", role: "admin" }];

test("ping：无令牌 401、错误令牌 401、正确令牌回 name", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, TOKENS);
  assert.equal((await req(base, "POST", "/v1/auth/ping")).status, 401);
  assert.equal((await req(base, "POST", "/v1/auth/ping", { token: "wrong" })).status, 401);
  const ok = await req(base, "POST", "/v1/auth/ping", { token: TOKEN });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true, name: "云仓研发组" });
  stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("kv：未写入 404，PUT 后 GET 回原值（含 null 与特殊字符键）", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, TOKENS);
  assert.equal((await req(base, "GET", "/v1/kv/settings", { token: TOKEN })).status, 404);

  const put = await req(base, "PUT", "/v1/kv/settings", { token: TOKEN, body: { data: { a: 1 } } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, { ok: true });

  const get = await req(base, "GET", "/v1/kv/settings", { token: TOKEN });
  assert.equal(get.status, 200);
  assert.deepEqual(get.json, { data: { a: 1 } });

  // 键里带斜杠/空格等：encodeURIComponent 后仍要能精确命中
  const key = encodeURIComponent("release-pools/云仓 #1");
  await req(base, "PUT", `/v1/kv/${key}`, { token: TOKEN, body: { data: { active: [] } } });
  const back = await req(base, "GET", `/v1/kv/${key}`, { token: TOKEN });
  assert.deepEqual(back.json, { data: { active: [] } });

  // data 为 null 是可存的有效值（客户端 load_data 空值约定）
  await req(base, "PUT", "/v1/kv/nullkey", { token: TOKEN, body: { data: null } });
  assert.deepEqual((await req(base, "GET", "/v1/kv/nullkey", { token: TOKEN })).json, { data: null });
  stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("kv：无令牌 401；超上限 413；非法 JSON 400", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, TOKENS, 1024);
  assert.equal((await req(base, "GET", "/v1/kv/x")).status, 401);

  const big = await req(base, "PUT", "/v1/kv/x", { token: TOKEN, body: { data: "z".repeat(4096) } });
  assert.equal(big.status, 413);

  const raw = await fetch(`${base}/v1/kv/x`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: "{not json",
  });
  assert.equal(raw.status, 400);
  stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("首次启动自动签发令牌并落盘（之后重启复用同一令牌）", async () => {
  const dir = tempDataDir();
  const first = await startEnterpriseServer({ dataDir: dir, port: 0, host: "127.0.0.1" });
  try {
    assert.ok(first.created && first.created.token.startsWith("tc_"));
    const base = `http://127.0.0.1:${first.port}`;
    assert.equal((await req(base, "POST", "/v1/auth/ping", { token: first.created.token })).status, 200);
  } finally {
    await stopStarted(first);
  }

  const second = await startEnterpriseServer({ dataDir: dir, port: 0, host: "127.0.0.1" });
  try {
    assert.equal(second.created, null, "第二次启动不应再签发新令牌");
    assert.equal(second.tokens[0].token, first.created.token);
  } finally {
    await stopStarted(second);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("未知路由 404；GET 之外的写方法不越权", async () => {
  const dir = tempDataDir();
  const { server, base } = await startServer(dir, TOKENS);
  assert.equal((await req(base, "GET", "/v1/nope", { token: TOKEN })).status, 404);
  assert.equal((await req(base, "DELETE", "/v1/kv/x", { token: TOKEN })).status, 405);
  stopServer(server);
  fs.rmSync(dir, { recursive: true, force: true });
});
