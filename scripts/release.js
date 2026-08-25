// ToolCove 发布构建脚本：注入更新签名密钥构建，生成 latest.json 并发布到 GitHub Releases。
// 用法：
//   npm run release -- "更新说明"   # 版本发布：签名构建 → 上传安装包与 latest.json 到 Release v<version> → 发布上线
//   npm run release -- --drivers    # 一次性上传 Oracle 驱动（release-out/oracle-driver.zip）到 tag drivers
// 前置：环境变量 GITHUB_TOKEN（PAT，scope 需含 repo）。
// 用 Node 而非 PowerShell：PowerShell 无法设置空字符串环境变量（会被当成删除变量），
// 而签名私钥无密码时 CLI 需要 TAURI_SIGNING_PRIVATE_KEY_PASSWORD="" 才不会交互式卡住。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OWNER = "GitHub-lcb";
const REPO = "ToolCove";
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const UPLOAD = `https://uploads.github.com/repos/${OWNER}/${REPO}`;
// 安装包下载 URL 与 tauri.conf.json 里 updater.endpoints 的目录一致（releases/latest/download）
const RELEASE_DOWNLOAD = `https://github.com/${OWNER}/${REPO}/releases/latest/download`;
const UPLOAD_TIMEOUT_MS = 15 * 60 * 1000; // 62MB 驱动上传预留 15 分钟

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outDir = path.join(root, "release-out");
fs.mkdirSync(outDir, { recursive: true });

const token = process.env.GITHUB_TOKEN;
const driversMode = process.argv[2] === "--drivers";
const notes = (driversMode ? "" : (process.argv[2] || "").trim());

// ---------- GitHub API 封装 ----------
async function gh(method, url, { body, raw, timeout } = {}) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body && !raw ? { "Content-Type": "application/json" } : {}),
      ...(raw ? { "Content-Type": "application/octet-stream" } : {}),
    },
    body,
    signal: timeout ? AbortSignal.timeout(timeout) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok && !(res.status === 422 && data.message && /already exists|already_used/i.test(data.message))) {
    throw new Error(`GitHub API ${method} ${url} 失败 (${res.status}): ${text.slice(0, 300)}`);
  }
  return data;
}

async function ensureRef(tag, sha) {
  // tag 已存在则复用，否则创建指向指定 commit 的轻量 tag
  const existing = await gh("GET", `${API}/git/ref/tags/${tag}`).catch(() => null);
  if (existing?.object) return existing;
  return gh("POST", `${API}/git/refs`, { body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }) });
}

async function ensureRelease(tag, name, body) {
  // 已存在同 tag release 则复用（返回 {id, draft}），否则创建 draft
  const existing = await gh("GET", `${API}/releases/tags/${tag}`).catch(() => null);
  if (existing?.id) return existing;
  return gh("POST", `${API}/releases`, {
    body: JSON.stringify({ tag_name: tag, name, body, draft: true }),
  });
}

async function uploadAsset(releaseId, filePath) {
  const name = path.basename(filePath);
  // 幂等：同名资产先删除再上传
  const assets = await gh("GET", `${API}/releases/${releaseId}/assets`);
  const dup = assets.find((a) => a.name === name);
  if (dup) await gh("DELETE", `${API}/releases/assets/${dup.id}`);
  const size = fs.statSync(filePath).size;
  process.stdout.write(`上传 ${name} (${(size / 1024 / 1024).toFixed(1)}MB)...`);
  const asset = await gh("POST", `${UPLOAD}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
    body: fs.readFileSync(filePath),
    raw: true,
    timeout: UPLOAD_TIMEOUT_MS,
  });
  console.log(" 完成");
  return asset;
}

async function publishRelease(releaseId) {
  const r = await gh("PATCH", `${API}/releases/${releaseId}`, { body: JSON.stringify({ draft: false }) });
  console.log(`Release 已发布：${r.html_url}`);
  return r;
}

async function mainBranchSha() {
  const ref = await gh("GET", `${API}/git/ref/heads/main`);
  return ref.object.sha;
}

// ---------- 签名构建 ----------
const keyPath = path.join(root, "src-tauri", "updater.key");
if (!fs.existsSync(keyPath)) {
  console.error("缺少更新签名私钥 src-tauri/updater.key（不在仓库里，需从原机器拷贝），无法生成可自动更新的版本");
  process.exit(1);
}
process.env.TAURI_SIGNING_PRIVATE_KEY = fs.readFileSync(keyPath, "utf8").trim();
process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";

if (!token) {
  console.error("缺少环境变量 GITHUB_TOKEN（PAT，scope 需含 repo），无法创建/更新 GitHub Release");
  process.exit(1);
}

// ---------- 驱动模式：tag drivers + oracle-driver.zip ----------
if (driversMode) {
  const zip = path.join(outDir, "oracle-driver.zip");
  if (!fs.existsSync(zip)) {
    console.error(`未找到驱动包 ${zip}，请先从旧仓 release-out/ 拷贝`);
    process.exit(1);
  }
  console.log("驱动模式：发布 oracle-driver.zip 到 tag drivers");
  await ensureRef("drivers", await mainBranchSha());
  const release = await ensureRelease("drivers", "Oracle JDBC Driver", "数据库工具使用的 Oracle 驱动包（oracle-driver.zip），首次使用数据库工具时自动下载。");
  await uploadAsset(release.id, zip);
  if (release.draft) await publishRelease(release.id);
  console.log("驱动发布完成。");
  process.exit(0);
}

// ---------- 版本发布 ----------
console.log("构建签名安装包（tauri build）...");
const r = spawnSync("npm", ["run", "tauri", "build"], { stdio: "inherit", shell: true, cwd: root });
if (r.status !== 0) process.exit(r.status ?? 1);

const version = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8")).version;
const nsisDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
const setupName = `ToolCove_${version}_x64-setup.exe`;
const setupPath = path.join(nsisDir, setupName);
const sigPath = setupPath + ".sig";
if (!fs.existsSync(setupPath) || !fs.existsSync(sigPath)) {
  console.error("未找到安装包或签名文件：" + setupPath);
  process.exit(1);
}
fs.copyFileSync(setupPath, path.join(outDir, setupName));

const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      // 与 tauri.conf.json updater.endpoints 的 releases/latest/download 目录一致
      url: `${RELEASE_DOWNLOAD}/${encodeURIComponent(setupName)}`,
    },
  },
};
fs.writeFileSync(path.join(outDir, "latest.json"), JSON.stringify(latest, null, 2));
console.log(`发布产物已生成：${outDir}`);

// ---------- 发布到 GitHub Releases ----------
console.log(`发布 v${version} 到 GitHub Releases...`);
const sha = await mainBranchSha();
const tag = `v${version}`;
await ensureRef(tag, sha);
const release = await ensureRelease(tag, `ToolCove v${version}`, notes || `ToolCove v${version} 发布`);
// 顺序固定：先传安装包，再传 latest.json（避免客户端读到未上传完的新版）
await uploadAsset(release.id, setupPath);
await uploadAsset(release.id, path.join(outDir, "latest.json"));
if (release.draft) await publishRelease(release.id);
console.log(`\n发布完成：https://github.com/${OWNER}/${REPO}/releases/tag/${tag}`);
