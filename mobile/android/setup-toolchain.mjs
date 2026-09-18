// Android 便携工具链安装器（Windows，无需管理员权限、无需 Android Studio）。
//
// 装到 workspace 内的 mobile/android/.toolchain/，不碰系统盘、不改系统 PATH——
// 所有路径都由 build-apk.mjs 显式传给 Gradle，所以你在别的机器上也能照抄这个目录结构。
//
// 为什么要这套东西：本机只有 JDK 1.7（AGP 8.11 要 JDK 17+）、没有 Android SDK、
// 没有 Gradle。这三样都是几百 MB 的下载，所以做成一个可重跑的脚本，而不是让人照着文档敲。
//
// 用法：node mobile/android/setup-toolchain.mjs
// 幂等：已经装好的组件会跳过（判断目录是否已存在）。

import { execFileSync } from "node:child_process";
import { cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const TOOLCHAIN = join(here, ".toolchain");
const DOWNLOADS = join(TOOLCHAIN, "_downloads");

/**
 * 版本选择（配对着选，不能各自取最新）：
 *   AGP 8.11.1 → 最低 Gradle 8.13、最低 build-tools 35.0.0、最低 JDK 17
 *   AGP 8.11 的 max_supported_android_version = 36 → compileSdk 35 安全
 *   Gradle 9.x 官方只测到 AGP 9.x，所以**不追最新**，锁 Gradle 8.x
 * 这三条来自 Android 官方的兼容矩阵，改动前请重新核对。
 */
const JDK_MAJOR = 21;          // LTS；Gradle 8.5+ 支持，AGP 8.11 最低要 17
const GRADLE_SERIES = "8.";    // 只在 8.x 里取最新
const AGP_VERSION = "8.11.1";
const KOTLIN_VERSION = "2.2.21";
const COMPILE_SDK = "35";
const BUILD_TOOLS = "35.0.0";
const CMDLINE_TOOLS_CANDIDATES = ["13114758", "11076708"]; // 新版优先，旧版兜底

const log = (...args) => console.log("[toolchain]", ...args);
const have = (name) => existsSync(join(TOOLCHAIN, name));

async function download(url, file) {
  if (existsSync(file)) {
    log(`已下载，跳过：${file.split(/[\\/]/).pop()}`);
    return file;
  }
  log(`下载 ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  log(`  → ${file}`);
  return file;
}

/** 解压 zip。用 PowerShell 的 Expand-Archive：Node 没有内置 zip 支持，而 tar.exe 不认 zip。 */
function unzip(zipFile, dest) {
  mkdirSync(dest, { recursive: true });
  execFileSync("powershell", [
    "-NoProfile",
    "-Command",
    `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${dest}' -Force`,
  ], { stdio: "inherit" });
}

/**
 * 目录改名：解压出来的顶层目录名带版本号，统一改成固定名字，后面脚本才好引用。
 *
 * 用「复制 + 删源」而不是 renameSync：跨目录 rename 在 Windows 上会因子目录/句柄占用
 * 或安全软件的实时扫描返回 EPERM（实测踩到过），复制对这类占用宽容得多。
 */
function adopt(extractedParent, newName) {
  const target = join(TOOLCHAIN, newName);
  if (existsSync(target)) {
    rmSync(extractedParent, { recursive: true, force: true });
    return target;
  }
  const entries = readdirSync(extractedParent, { withFileTypes: true }).filter((e) => e.isDirectory());
  if (entries.length !== 1) throw new Error(`${extractedParent} 下应只有一个目录，实际 ${entries.length} 个`);
  cpSync(join(extractedParent, entries[0].name), target, { recursive: true, force: true, errorOnExist: false });
  rmSync(extractedParent, { recursive: true, force: true });
  return target;
}

async function installJdk() {
  if (have("jdk")) return join(TOOLCHAIN, "jdk");
  // Adoptium 官方 API：binary.package.link 才是 zip（installer.link 是 .msi，不能用）
  const api = `https://api.adoptium.net/v3/assets/latest/${JDK_MAJOR}/hotspot?architecture=x64&image_type=jdk&os=windows&vendor=eclipse`;
  log(`查询 Adoptium JDK ${JDK_MAJOR} …`);
  const assets = await (await fetch(api)).json();
  const link = assets?.[0]?.binary?.package?.link;
  if (!link) throw new Error(`Adoptium 没返回 zip 下载地址：${api}`);
  const zip = await download(link, join(DOWNLOADS, link.split("/").pop()));
  const tmp = join(TOOLCHAIN, "_jdk_tmp");
  unzip(zip, tmp);
  return adopt(tmp, "jdk");
}

async function installGradle() {
  if (have("gradle")) return join(TOOLCHAIN, "gradle");
  log("查询 Gradle 8.x 最新版 …");
  const all = await (await fetch("https://services.gradle.org/versions/all")).json();
  // 排除 rc/milestone：只要正式版
  const stable = all.find((v) => !v.snapshot && !v.rcFor && !v.milestoneFor && String(v.version).startsWith(GRADLE_SERIES));
  if (!stable) throw new Error("找不到 Gradle 8.x 正式版");
  const url = stable.downloadUrl || `https://services.gradle.org/distributions/gradle-${stable.version}-bin.zip`;
  log(`选定 Gradle ${stable.version}`);
  const zip = await download(url, join(DOWNLOADS, `gradle-${stable.version}-bin.zip`));
  const tmp = join(TOOLCHAIN, "_gradle_tmp");
  unzip(zip, tmp);
  return adopt(tmp, "gradle");
}

async function installCmdlineTools() {
  const sdk = join(TOOLCHAIN, "android-sdk");
  const sdkm = join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager.bat");
  if (existsSync(sdkm)) return sdk;

  let zip = null;
  for (const build of CMDLINE_TOOLS_CANDIDATES) {
    const url = `https://dl.google.com/android/repository/commandlinetools-win-${build}_latest.zip`;
    try {
      zip = await download(url, join(DOWNLOADS, `cmdtools-${build}.zip`));
      break;
    } catch (e) {
      log(`  ${build} 不可用（${e.message}），试下一个`);
    }
  }
  if (!zip) throw new Error("cmdline-tools 所有候选下载地址都失败，请到 developer.android.com/studio#command-tools 取最新 build 号后加进 CMDLINE_TOOLS_CANDIDATES");

  // 目录名必须是 latest，否则 sdkmanager 找不到 SDK root
  const tmp = join(TOOLCHAIN, "_cmdtools_tmp");
  unzip(zip, tmp);
  const dest = join(sdk, "cmdline-tools", "latest");
  mkdirSync(join(sdk, "cmdline-tools"), { recursive: true });
  cpSync(join(tmp, "cmdline-tools"), dest, { recursive: true, force: true });
  rmSync(tmp, { recursive: true, force: true });
  return sdk;
}

/**
 * 调用一个 .bat/.cmd。
 *
 * 三个 Windows/Node 的坑，缺一个都跑不起来（每个都实测过）：
 *
 *  1) 不能让 Node 直接 spawn 批处理文件——CreateProcess 只执行 .exe/.com，
 *     `.bat` 由 cmd.exe 解释，`execFileSync('foo.bat')` 抛 EINVAL。
 *     必须经 `cmd.exe /d /c`。
 *
 *  2) **参数要一个一个分开传，不要自己拼成整串**。这条反直觉，但四种写法实测下来
 *     只有这一种在「路径带空格」时也成立：
 *       分开传（Node 加引号）        → 普通路径 ✓  带空格路径 ✓
 *       分开传 + windowsVerbatim     → 普通路径 ✓  带空格路径 ✗
 *       整串不加引号                 → 普通路径 ✓  带空格路径 ✗
 *       整串自己加引号（最初写法）    → 普通路径 ✗  带空格路径 ✗
 *     原因是 Node 会对自己构造的命令行统一做引号处理；我们预先加的那层引号会被它
 *     再转义一遍，cmd 收到 `\"C:\...\x.bat\"` 就报「文件名、目录名或卷标语法不正确」。
 *     交给 Node 拼引号，它才会为空格的路径正确加引号。
 *
 *  3) **必须用 stdio: "inherit"**。`stdio: "pipe"` 会去创建命名管道，在受限沙箱里
 *     直接 EPERM。代价是没有 stdout 可读——调用方只看退出码，不解析输出。
 *
 * 这里也**不提供传标准输入的能力**：`execFileSync` 的 `input` 只在 Node 自己建管道时
 * 生效（与第 3 条冲突），而 `cmd /c "... < 临时文件"` 的重定向又会被第 2 条的引号问题
 * 带崩。需要免交互的地方（SDK 许可）改成直接写文件，见 writeLicenses。
 */
export function runBat(bat, args, { env, cwd } = {}) {
  return execFileSync("cmd.exe", ["/d", "/c", bat, ...args], {
    env: env ?? process.env,
    stdio: "inherit",
    // cwd 必须显式传：Gradle 是按**当前工作目录**找 settings.gradle 的，
    // 不传就会拿调用方（仓库根）当构建根，报「does not contain a Gradle build」
    cwd,
  });
}

/**
 * 写入 SDK 许可记录，免掉 `sdkmanager --licenses` 的交互。
 *
 * 为什么不走 `--licenses` 喂输入，而是直接写文件：**这条路在这套环境里不可靠**，而且
 * 失败方式是静默的——
 *   - `execFileSync` 的 `input` 选项在 `stdio: "inherit"` 下被忽略（见 runBat 注释）；
 *   - `cmd /c "... < 临时文件"` 的重定向被 cmd 判为语法错误。
 *   - 更要命的是：`--licenses` 收不到输入时**退出码仍然是 0**，只是不写许可文件。
 *     于是它静默失败，直到后面装包才报错，而报错信息指向别处。
 *     这个坑只在干净机器（CI）上暴露，本机因为许可早已接受过而完全看不见——
 *     第一版 CI 就是死在这里。
 *
 * 直接写文件没有这些问题：无交互、无管道、退出码可信，也是 CI 镜像里设置
 * Android SDK 的通行做法。sdkmanager 只对许可文本做等值比对，`licenses/`
 * 这个目录本来就是可以整份拷贝到别的机器的。
 */
function writeLicenses(sdk) {
  const dir = join(sdk, "licenses");
  mkdirSync(dir, { recursive: true });
  const files = {
    "android-sdk-license": "24333f8a63b6825ea9c5514f83c2829b004d1fee",
    "android-sdk-preview-license": "84831b9409646a918e30573bab4c9c91346d8abd",
  };
  for (const [name, hash] of Object.entries(files)) {
    const file = join(dir, name);
    try {
      if (readFileSync(file, "utf8").includes(hash)) continue; // 已有记录，别重复写
    } catch {
      // 文件不存在：往下写
    }
    writeFileSync(file, `${hash}\n`, "utf8");
    log(`写入许可记录 licenses/${name}`);
  }
}

/** sdkmanager 安装 SDK 包。它要求 JAVA_HOME 指向 JDK 17+（本机默认那个 1.7 会直接失败）。 */
function installSdkPackages(sdk) {
  const javaHome = join(TOOLCHAIN, "jdk");
  const sdkm = join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager.bat");
  const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: sdk };

  // 许可：直接写记录文件，不走 `--licenses` 的交互（理由见 writeLicenses）
  writeLicenses(sdk);

  log(`安装 platform-tools / platforms;android-${COMPILE_SDK} / build-tools;${BUILD_TOOLS} …`);
  try {
    runBat(
      sdkm,
      ["platform-tools", `platforms;android-${COMPILE_SDK}`, `build-tools;${BUILD_TOOLS}`, `--sdk_root=${sdk}`],
      { env },
    );
  } catch (e) {
    // 把两种最常见的失败分开说，否则用户只会看到 sdkmanager 的一大串进度条：
    //   - 下载仓库清单失败（网络/代理）：报 "Failed to download any source lists"
    //   - 许可没接受：报 "not accepted the license agreements"
    throw new Error(
      `sdkmanager 安装失败（exit ${e.status ?? "?"}）。\n` +
        `  若日志里有「Failed to download any source lists」→ 是网络问题（下载 dl.google.com 的仓库清单失败），重跑本脚本即可；\n` +
        `  若有「not accepted the license agreements」→ 许可记录没写进去，检查 ${join(sdk, "licenses")}`,
    );
  }
}

export async function ensureToolchain() {
  mkdirSync(DOWNLOADS, { recursive: true });
  const jdk = await installJdk();
  const gradle = await installGradle();
  const sdk = await installCmdlineTools();

  // SDK 组件优先走官方 sdkmanager；它跑不起来时退回「Node 直接下组件包」。
  //
  // 为什么要留后路：sdkmanager 是 Java 程序，而 Java 的 TLS 在「进程拿不到 Windows
  // 凭据存储」的环境里（受限沙箱、部分 CI）会以 SEC_E_NO_CREDENTIALS 失败——
  // Node 自带 TLS 与 CA 包，不受这个限制。实测本机就是这种情况，
  // 没有兜底的话工具链永远装不完，而这不是用户能靠重试解决的问题。
  try {
    installSdkPackages(sdk);
  } catch (e) {
    log("sdkmanager 失败，改用直接下载组件包的方式：");
    log(`  ${String(e.message).split("\n")[0]}`);
    const { fetchSdkPackages } = await import("./fetch-sdk.mjs");
    await fetchSdkPackages();
  }

  if (!existsSync(join(sdk, "platforms", `android-${COMPILE_SDK}`, "android.jar"))) {
    throw new Error(`platforms;android-${COMPILE_SDK} 没装上，android.jar 不存在`);
  }
  return { jdk, gradle, sdk };
}

export const VERSIONS = { AGP_VERSION, KOTLIN_VERSION, COMPILE_SDK, BUILD_TOOLS, JDK_MAJOR };

// 直接执行时只装工具链，不打 APK
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { jdk, gradle, sdk } = await ensureToolchain();
  log("完成：");
  log(`  JDK    ${jdk}`);
  log(`  Gradle ${gradle}`);
  log(`  SDK    ${sdk}`);
  log("下一步：node mobile/android/build-apk.mjs");
}
