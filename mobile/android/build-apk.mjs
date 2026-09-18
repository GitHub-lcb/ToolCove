// 构建可安装的 APK：先出手机端前端产物，再交给 Gradle 打包。
//
// 用法：
//   node mobile/android/build-apk.mjs              # 打 release（debug 签名，适合侧载）
//   node mobile/android/build-apk.mjs --debug      # 打 debug
//   node mobile/android/build-apk.mjs --offline    # 工具链齐备后离线构建
//   node mobile/android/build-apk.mjs --system-toolchain
//        用**环境里已有的** JDK/Gradle/SDK，不下载自带的 .toolchain。
//        CI（ubuntu-latest 自带 Android SDK）走这条；本地默认用自带工具链。
//
// 产物复制到 mobile/android/out/，文件名统一为 toolcove-<variant>.apk。
//
// 与上一代手机端（铁路大亨悬浮面板）的差别：
//   · 前端不再是「rail-hud 单文件」，而是 mobile/app 的标准 Vite 产物（dist/mobile/app）；
//   · 产物由 app/build.gradle 的 syncWebAssets 同步进 APK 资源，本脚本只负责先把它构建出来；
//   · 应用是普通全屏应用，没有悬浮窗/前台服务，因此不需要额外权限声明。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, cpSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outDir = join(here, "out");

const argv = process.argv.slice(2);
const variant = argv.includes("--debug") ? "debug" : "release";
const offline = argv.includes("--offline");
const useSystemToolchain = argv.includes("--system-toolchain") || process.env.TC_SYSTEM_TOOLCHAIN === "1";
/** 是否配置了正式签名（由环境变量传入，见 app/build.gradle 与 mobile-release.yml）。 */
const signedRelease = !!process.env.TC_KEYSTORE_PATH;
const task = variant === "debug" ? "assembleDebug" : "assembleRelease";

const log = (...a) => console.log("[apk]", ...a);

/**
 * 解析工具链：两条路径。
 *
 * 本地（默认）：用自带的 .toolchain（本机系统只有 JDK 1.7，AGP 8 要 17+，所以必须自带）。
 * CI（--system-toolchain）：用环境里已有的 JDK/Gradle/SDK——GitHub 的 ubuntu runner 已预装
 * Android SDK，再下一份 1.5GB 的工具链既慢又没必要；而且 setup-toolchain.mjs 是为 Windows
 * 写的（sdkmanager.bat、commandlinetools-win），在 Linux 上跑不起来。
 */
async function resolveToolchain() {
  if (!useSystemToolchain) {
    const { ensureToolchain } = await import("./setup-toolchain.mjs");
    const { jdk, gradle, sdk } = await ensureToolchain();
    return { jdk, gradle, sdk, runner: "local" };
  }

  const jdk = process.env.JAVA_HOME || "";
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
  const gradleHome = process.env.GRADLE_HOME || "";
  if (!jdk) throw new Error("--system-toolchain 需要设置 JAVA_HOME");
  if (!sdk) throw new Error("--system-toolchain 需要设置 ANDROID_HOME 或 ANDROID_SDK_ROOT");

  // Gradle 优先用环境里的；没有就回退到 PATH 上的 gradle
  const gradle = gradleHome && existsSync(gradleHome) ? gradleHome : "";
  return { jdk, gradle, sdk, runner: "system" };
}

// ── 1. 工具链（幂等：已装好时只做几次 existsSync） ──────────────────
const { jdk, gradle, sdk, runner } = await resolveToolchain();
log(`工具链（${runner === "system" ? "环境自带" : "项目自带"}）：JDK ${jdk}`);
log(`        Gradle ${gradle || "（用 PATH 上的 gradle）"}`);
log(`        SDK ${sdk}`);

// ── 2. 前端产物 ─────────────────────────────────────────────────────
// 必须先于 Gradle：assets 是 app 模块的输入，先构建再编译才不会把旧页面塞进 APK。
const webDist = join(root, "dist", "mobile", "app");
log("构建手机端前端（npm run build:mobile 等价的 vite build）…");
execFileSync(process.execPath, [join(root, "node_modules", "vite", "bin", "vite.js"), "build", "--config", join(root, "mobile", "vite.mobile.config.js")], {
  stdio: "inherit",
  cwd: root,
});
if (!existsSync(join(webDist, "index.html"))) {
  throw new Error(`前端产物缺失：${webDist}/index.html\n检查 mobile/vite.mobile.config.js 的 outDir`);
}

// ── 3. local.properties（SDK 路径）────────────────────────────────────
// 写成正斜杠：Java properties 里反斜杠是转义符，写 Windows 路径得双写，容易出错。
// 这个文件是机器相关的，已在 .gitignore 里（不随代码走）。
writeFileSync(join(here, "local.properties"), `sdk.dir=${sdk.replace(/\\/g, "/")}\n`, "utf8");

// ── 4. Gradle ───────────────────────────────────────────────────────
//
// GRADLE_USER_HOME 必须放在**本仓库之外**，这不是洁癖，是本机踩出来的硬约束：
// 只要它落在仓库目录内，构建就稳定失败在脚本编译缓存上——
//   Could not move temporary workspace (.../caches/<ver>/groovy-dsl/<hash>-<uuid>)
//   to immutable location (.../caches/<ver>/groovy-dsl/<hash>)
// 换构建脚本语言、清缓存、关 daemon、关 vfs.watch 全都无效；挪出仓库立刻通过。
// 这是 Gradle 侧在 Windows 上的问题（gradle/gradle#31392、#31438）。
//
// 默认放在系统临时目录下；想固定位置就设 TC_GRADLE_HOME。
const gradleHome = process.env.TC_GRADLE_HOME || join(tmpdir(), "toolcove-gradle-home");
const androidUserHome = process.env.TC_ANDROID_HOME || join(tmpdir(), "toolcove-android-home");
mkdirSync(gradleHome, { recursive: true });
mkdirSync(androidUserHome, { recursive: true });

const env = {
  ...process.env,
  JAVA_HOME: jdk,
  ANDROID_HOME: sdk,
  ANDROID_SDK_ROOT: sdk,
  GRADLE_USER_HOME: gradleHome,
  // debug keystore 也放这里，避免写 C 盘用户目录
  ANDROID_USER_HOME: androidUserHome,
};
const gradleArgs = [task, "--no-daemon", "--console=plain"];
if (offline) gradleArgs.push("--offline");

log(`Gradle ${task}${offline ? "（离线）" : ""} …`);
log(`  依赖缓存：${gradleHome}`);
log("  （首次要下载 AGP / Kotlin 插件，可能要几分钟）");

if (gradle) {
  // 自带工具链：直接调它的 launcher（Windows 上是 gradle.bat，Linux/macOS 上是 gradle）
  const { runBat } = await import("./setup-toolchain.mjs");
  runBat(join(gradle, "bin", process.platform === "win32" ? "gradle.bat" : "gradle"), gradleArgs, { env, cwd: here });
} else {
  // 环境自带模式：用 PATH 上的 gradle（CI 的 runner 已装好）
  log("  使用 PATH 上的 gradle");
  execFileSync("gradle", gradleArgs, { env, cwd: here, stdio: "inherit" });
}

// ── 5. 收集产物 ─────────────────────────────────────────────────────
const apkDir = join(here, "app", "build", "outputs", "apk", variant);
if (!existsSync(apkDir)) throw new Error(`没找到产物目录 ${apkDir}`);
const apks = readdirSync(apkDir).filter((f) => f.endsWith(".apk"));
if (!apks.length) throw new Error(`${apkDir} 下没有 .apk`);
// 优先取已签名的那个：release 变体会同时产出 app-release-unsigned.apk 与 app-release.apk，
// 用户装到手机上的是后者（前者装不上）。
const signed = apks.filter((f) => !f.includes("unsigned"));
const picked = signed.length ? signed : apks;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const results = [];
for (const apk of picked) {
  const target = join(outDir, `toolcove-${variant}.apk`);
  cpSync(join(apkDir, apk), target);
  results.push(target);
}

// ── 6. 产物自检 ─────────────────────────────────────────────────────
// 构建成功 ≠ 包能用：**空壳包能装上、能启动、打开是白屏**，这是最难排查的失败形态
// （上一代手机端就出过：assets 同步路径算错，包 645KB 却没有任何页面）。
// 所以构建完立刻验产物本身，失败就非零退出，别把空壳包交给发版流程。
for (const file of results) {
  log(`自检 ${file} …`);
  execFileSync(process.execPath, [join(here, "verify-apk.mjs"), file], { stdio: "inherit" });
}

// ── 7. 汇报 ─────────────────────────────────────────────────────────
log("完成：");
for (const file of results) {
  const { statSync } = await import("node:fs");
  const kb = Math.round(statSync(file).size / 1024);
  log(`  ${file}  (${kb} KB)`);
}
if (variant === "release" && !signedRelease) {
  log("提示：release 用 debug 签名，仅供侧载自用；上架需要配置签名（见 mobile-release.yml 的 Secrets）。");
}
