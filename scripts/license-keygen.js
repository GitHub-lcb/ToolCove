#!/usr/bin/env node
// ToolCove license 密钥工具（仅开发者本机使用，私钥绝不入库）
//
// 用法：
//   node scripts/license-keygen.js --gen --out scripts/.license-secrets
//      生成 ed25519 密钥对：license.key（PKCS8 PEM 私钥，gitignore 红线）
//      并在 stdout 打印 base64(32 字节原始公钥) —— 粘贴进 src-tauri/src/license.rs 的 PUBLIC_KEY_B64
//   node scripts/license-keygen.js --sign --name "张三" [--email zhang@example.com] [--features db-export-xlsx,theme-custom,cloud-sync] [--expires 2027-12-31]
//     推荐 features：db-export-xlsx,theme-custom,cloud-sync（云同步为第二批 Pro 功能）
//      读取默认私钥签发 license，stdout 单行输出 TCV1-xxx 可直接粘贴到设置页激活
//      可选 --key /path/to/license.key 指定私钥
//
// 设计约定（与 license.rs 严格一致）：
//   - payload 键序固定：plan, name, email, issued, expires, features（防 JSON 重排）
//   - 签发与验签对象均为 payload 原文 UTF-8 字节
//   - base64url 无填充（Node toString('base64url') = Rust base64 URL_SAFE_NO_PAD）

import { generateKeyPairSync, sign, createPrivateKey, createPublicKey } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const DEFAULT_KEY = "scripts/.license-secrets/license.key";
const PREFIX = "TCV1-";

function fail(msg) {
  console.error("错误：" + msg);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name) => process.argv.includes(name);

// 公钥 32 字节原始格式 → base64url（供 Rust 内嵌；Rust 侧 ed25519-dalek 的
// VerifyingKey::from_bytes 接收的正是这 32 字节）
function publicKeyB64(pubKey) {
  const jwk = pubKey.export({ format: "jwk" });
  return jwk.x; // jwk 的 x 字段即为 base64url 编码的 32 字节公钥
}

function signPayload(payloadJson, privateKey) {
  return sign(null, Buffer.from(payloadJson, "utf8"), privateKey).toString("base64url");
}

function buildPayload({ name, email, expires, features }) {
  if (!name || !name.trim()) fail("--name 必填");
  const issued = new Date().toISOString().slice(0, 10);
  const feat = features
    ? features.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  return JSON.stringify({
    plan: "pro",
    name: name.trim(),
    email: (email || "").trim(),
    issued,
    expires: (expires || "").trim(),
    features: feat,
  });
}

if (has("--gen")) {
  const out = arg("--out") || "scripts/.license-secrets";
  mkdirSync(out, { recursive: true });
  const keyPath = join(out, "license.key");
  if (existsSync(keyPath)) {
    fail(keyPath + " 已存在（--force 未实现，先手动删除再重新生成，避免误覆盖线上签名密钥）");
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const b64 = publicKeyB64(publicKey);
  console.log("私钥已写入: " + resolve(keyPath));
  console.log("");
  console.log("公钥（base64url 32 字节原始格式，粘贴进 src-tauri/src/license.rs 的 PUBLIC_KEY_B64）：");
  console.log(b64);
  // 校验回读可用
  const check = createPublicKey(readFileSync(keyPath));
  if (publicKeyB64(check) !== b64) fail("回读校验失败，请重新生成");
} else if (has("--sign")) {
  const features = arg("--features") || arg("--feature") || "";
  const keyPath = arg("--key") || DEFAULT_KEY;
  if (!existsSync(keyPath)) fail("私钥不存在：" + keyPath + "（先执行 --gen）");
  const privateKey = createPrivateKey(readFileSync(keyPath));
  const payload = buildPayload({
    name: arg("--name"),
    email: arg("--email"),
    expires: arg("--expires"),
    features,
  });
  const sig = signPayload(payload, privateKey);
  console.log(PREFIX + Buffer.from(payload, "utf8").toString("base64url") + "." + sig);
} else if (has("--pub")) {
  const keyPath = arg("--key") || DEFAULT_KEY;
  if (!existsSync(keyPath)) fail("私钥不存在：" + keyPath);
  console.log(publicKeyB64(createPublicKey(readFileSync(keyPath))));
} else {
  console.log("ToolCove license-keygen\n\n用法：\n  node scripts/license-keygen.js --gen --out <dir>          生成密钥对并打印公钥\n  node scripts/license-keygen.js --sign --name <name> [--email <e>] [--features a,b] [--expires YYYY-MM-DD]  签发 license\n  node scripts/license-keygen.js --pub [--key <path>]       打印公钥\n\nprivate key 默认路径：" + DEFAULT_KEY + "（红线：绝不提交入库，.gitignore 已排除）");
}