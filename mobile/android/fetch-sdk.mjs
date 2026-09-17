// 从 Google 的仓库清单里找出 SDK 组件的下载地址。
//
// 为什么要有这个文件：`sdkmanager` 是 Java 程序，而本机的 Java 侧 TLS 走不通
// （沙箱进程拿不到 Windows 凭据存储，schannel/JVM 都报 SEC_E_NO_CREDENTIALS）。
// Node 自带 TLS 与 CA 包，不受影响，所以改成「用 Node 下组件包、按 SDK 目录布局解包」。
//
// 顺带的好处：这条路径不依赖 sdkmanager 的交互与许可流程，在别人机器上当兜底也更稳。
//
// 用法：node mobile/android/fetch-sdk.mjs

import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { TOOLCHAIN, VERSIONS } from "./setup-toolchain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const downloads = join(TOOLCHAIN, "_downloads");
const sdk = join(TOOLCHAIN, "android-sdk");
const MANIFEST = join(downloads, "repository2-3.xml");
const MANIFEST_URL = "https://dl.google.com/android/repository/repository2-3.xml";
const REPO_BASE = "https://dl.google.com/android/repository/";

const log = (...a) => console.log("[sdk]", ...a);

/**
 * 我们要装的组件。
 *
 * `stripRoot` 必须**按包显式声明**，不能靠启发式猜：官方 zip 的顶层结构两种都有，实测：
 *   - `platform-tools_rNN-win.zip`  → 顶层 `platform-tools/`，**要剥**；
 *   - `build-tools_rNN_windows.zip` → 顶层 `android-NN/`，**要剥**；
 *   - `platform-NN_rNN.zip`         → 顶层 `android-NN/`，**要剥**。
 * 所以三个包都剥一层。早先版本用「只有一个子目录就剥」，对 platforms 恰好剥错；
 * 后来改成按包声明，又误以为前两个是平铺——这里以 `tar -tf` 的实际输出为准。
 *
 * `verify` 是解包后的自检文件；`urlHint` 用来在清单里认出**正确的那个包**
 * （见 findPackage：同一个 path 会出现在旧 channel 里，URL 里带版本号能区分）。
 */
const PACKAGES = [
  {
    id: "platform-tools",
    dest: "platform-tools",
    stripRoot: true,
    verify: "adb.exe",
    urlHint: /platform-tools_r[\d.]+-win\.zip$/,
  },
  {
    id: `platforms;android-${VERSIONS.COMPILE_SDK}`,
    dest: `platforms/android-${VERSIONS.COMPILE_SDK}`,
    stripRoot: true,
    verify: "android.jar",
    urlHint: new RegExp(`^platform-${VERSIONS.COMPILE_SDK}_r\\d+\\.zip$`),
  },
  {
    id: `build-tools;${VERSIONS.BUILD_TOOLS}`,
    dest: `build-tools/${VERSIONS.BUILD_TOOLS}`,
    stripRoot: true,
    verify: "aapt2.exe",
    // 关键：区分 `build-tools_r35_windows.zip`（我们要的）与
    // `build-tools_r15-windows.zip`（旧 channel 里同名的 35.0.0 条目指向它）
    urlHint: new RegExp(`^build-tools_r${VERSIONS.BUILD_TOOLS.split(".")[0]}_windows\\.zip$`),
  },
];

async function manifest() {
  if (existsSync(MANIFEST)) return readFileSync(MANIFEST, "utf8");
  log("下载仓库清单 …");
  const r = await fetch(MANIFEST_URL);
  if (!r.ok) throw new Error(`清单下载失败 HTTP ${r.status}`);
  const text = await r.text();
  writeFileSync(MANIFEST, text, "utf8");
  return text;
}

/**
 * 清单里的 <url> 是**相对文件名**（例如 `platform-tools_r37.0.1-win.zip`），
 * 不是完整地址——直接拿去 fetch 会报 Invalid URL。这里补成绝对地址。
 * 留一个「已经是绝对地址就直接用」的分支：清单格式换过，两种都见过。
 */
export function resolveUrl(url) {
  return /^https?:\/\//i.test(url) ? url : REPO_BASE + url;
}

/**
 * 从清单里取一个包**属于 Windows 且确实是这个版本**的压缩包。
 *
 * 这里有两个**静默陷阱**，都会导致「下载解包都成功，但拿到的是错的东西」：
 *
 *  1) `<url>` 是相对文件名，直接抓段里第一个会拿到 linux 包
 *     （platform-tools 的 archive 顺序就是 linux → macosx → windows）。
 *     规则：优先 host-os=windows；没有 host-os 的（platforms 这类平台无关包）用 base。
 *
 *  2) **同一个 path 在清单里出现多次**。旧 channel 里也有一个 `build-tools;35.0.0`
 *     条目，它指向 `build-tools_r15-windows.zip`（Android 4.0.3 时代的工具）。
 *     只按 path 找第一处就会命中它——包能下能解，只是里面是 15 年前的 aapt。
 *     所以再按 URL 里的版本号校验一次（urlHint）。
 *
 * @param {RegExp} [urlHint] 收紧「哪个 archive 才算数」；不匹配就继续往后找下一个条目
 */
export function findPackage(xml, id, urlHint) {
  // 扫**所有** remotePackage 段：同一个 path 可能有好几处
  const blocks = [...xml.matchAll(/<remotePackage path="([^"]+)">([\s\S]*?)<\/remotePackage>/g)]
    .filter((m) => m[1] === id)
    .map((m) => m[2]);
  if (!blocks.length) throw new Error(`清单里没有 ${id}`);

  const candidates = [];
  for (const block of blocks) {
    const archives = [...block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map((m) => ({
      hostOs: m[1].match(/<host-os>([^<]*)<\/host-os>/)?.[1] ?? "",
      url: m[1].match(/<url>([^<]+)<\/url>/)?.[1] ?? "",
      size: Number(m[1].match(/<size>(\d+)<\/size>/)?.[1] ?? 0),
    }));
    // 平台无关的包只有 base 一个 archive；多平台的优先 windows
    const windows = archives.find((a) => a.hostOs === "windows");
    const base = archives.find((a) => a.hostOs === "");
    const chosen = windows ?? base;
    if (chosen?.url) candidates.push(chosen);
  }
  if (!candidates.length) throw new Error(`${id} 的所有条目里都没有可用的 <url>`);

  if (urlHint) {
    const matched = candidates.find((c) => urlHint.test(c.url));
    if (!matched) {
      throw new Error(
        `${id} 找到了 ${candidates.length} 个候选，但没有一个匹配 ${urlHint}：` +
          candidates.map((c) => c.url).join(", "),
      );
    }
    return matched;
  }
  return candidates[0];
}

/** unzip：用 PowerShell 的 Expand-Archive（Node 没有内置 zip 支持，tar.exe 不认 zip）。 */
function unzip(zipFile, dest) {
  mkdirSync(dest, { recursive: true });
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${dest}' -Force`],
    { stdio: "inherit" },
  );
}

/**
 * 解包一个 SDK 组件。
 *
 * 先整包解到临时目录，再按 `stripRoot` 决定铺哪一层：
 *   - stripRoot=false：临时目录的内容直接铺到 dest（包内平铺的形态）；
 *   - stripRoot=true：剥掉临时目录下唯一那层再铺（包内有前缀目录的形态）。
 */
function extractInto(zipFile, dest, stripRoot) {
  const tmp = join(downloads, "_extract_tmp");
  rmSync(tmp, { recursive: true, force: true });
  unzip(zipFile, tmp);

  let source = tmp;
  if (stripRoot) {
    const entries = readdirSync(tmp, { withFileTypes: true }).filter((e) => !e.name.startsWith("."));
    if (entries.length !== 1 || !entries[0].isDirectory()) {
      throw new Error(`${zipFile} 预期包内只有一层目录，实际 ${entries.map((e) => e.name).join(", ")}`);
    }
    source = join(tmp, entries[0].name);
  }

  mkdirSync(dest, { recursive: true });
  execFileSync(
    "powershell",
    ["-NoProfile", "-Command", `Copy-Item -Recurse -Force -Path '${source}\\*' -Destination '${dest}'`],
    { stdio: "inherit" },
  );
  rmSync(tmp, { recursive: true, force: true });
}

/**
 * 下载到文件，失败重试。
 *
 * 必须把「半截文件」删掉再重试：几十 MB 的包在网络抖动时很容易断，
 * 而留下的部分文件在下一次运行时会被 `existsSync` 当成「已下载」，
 * 于是解包出一个残缺的 SDK——那种故障要到编译或运行时才暴露，非常难查。
 */
async function downloadTo(url, file, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await pipeline(Readable.fromWeb(r.body), createWriteStream(file));
      return;
    } catch (e) {
      rmSync(file, { force: true }); // 关键：别留下半截文件
      if (attempt === attempts) throw new Error(`下载失败（已重试 ${attempts} 次）：${url}\n  最后一次错误：${e.message}`);
      const wait = attempt * 3000;
      log(`  第 ${attempt} 次失败（${e.message}），${wait / 1000}s 后重试 …`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function main() {
  mkdirSync(downloads, { recursive: true });
  const xml = await manifest();

  for (const pkg of PACKAGES) {
    const dest = join(sdk, pkg.dest);
    const marker = join(dest, pkg.verify);

    // 自检而不是只看目录在不在：解包结构不对时会留下一堆看着像装好了的文件，
    // 那种残留必须被识别出来并重装，否则会一直错到编译期。
    if (existsSync(marker)) {
      log(`已存在，跳过：${pkg.id} → ${pkg.dest}`);
      continue;
    }
    if (existsSync(dest)) {
      log(`检出残缺的 ${pkg.dest}（缺 ${pkg.verify}），清掉重装`);
      rmSync(dest, { recursive: true, force: true });
    }

    const { url } = findPackage(xml, pkg.id, pkg.urlHint);
    const fullUrl = resolveUrl(url);
    const zip = join(downloads, fullUrl.split("/").pop());
    if (!existsSync(zip)) {
      log(`下载 ${pkg.id}\n     ${fullUrl}`);
      await downloadTo(fullUrl, zip);
    }
    log(`解包 ${pkg.id} → ${pkg.dest}`);
    extractInto(zip, dest, pkg.stripRoot);

    if (!existsSync(marker)) throw new Error(`${pkg.id} 解包后仍然找不到 ${pkg.verify}（结构不符合预期）`);
  }

  log(`完成：android.jar ✓  aapt2 ✓  adb ✓`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

export { main as fetchSdkPackages };