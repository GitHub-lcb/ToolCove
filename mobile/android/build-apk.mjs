// 构建可安装的 APK：先出手机版 HUD 单文件，再交给 Gradle 打包。
//
// 版本是**配对着选**的，不要单独升级其中一个（见各文件里的注释与官方兼容矩阵）：
//   AGP 8.11.1 · Gradle 8.14.5 · Kotlin 2.2.21 · JDK 21 · compileSdk 35 · build-tools 35.0.0
//   AGP 8.11 要求 Gradle ≥ 8.13、build-tools ≥ 35.0.0、JDK ≥ 17；
//   Gradle 9.x 官方只测到 AGP 9.x，所以锁在 8.x。
//
// 用法：
//   node mobile/android/build-apk.mjs              # 打 release（debug 签名，适合侧载）
//   node mobile/android/build-apk.mjs --debug      # 打 debug
//   node mobile/android/build-apk.mjs --offline    # 工具链齐备后离线构建
//
// 产物复制到 mobile/android/out/，文件名带版本号，方便和上一版对比。

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ensureToolchain, runBat } from "./setup-toolchain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outDir = join(here, "out");
const assetsDir = join(here, "app", "src", "main", "assets");

const args = process.argv.slice(2);
const variant = args.includes("--debug") ? "debug" : "release";
const offline = args.includes("--offline");
const task = variant === "debug" ? "assembleDebug" : "assembleRelease";

const log = (...a) => console.log("[apk]", ...a);

// ── 1. 工具链 ────────────────────────────────────────────────────────
// 已经装好时 ensureToolchain 只做几次 existsSync，几乎不花时间（幂等）
log("检查工具链 …");
const { jdk, gradle, sdk } = await ensureToolchain();

// ── 2. 手机版 HUD（assets/index.html）────────────────────────────────
// 必须先于 Gradle：assets 是 app 模块的输入，先打包再编译才不会把旧页面塞进 APK
log("构建手机版 HUD …");
execFileSync(process.execPath, [join(root, "mobile", "rail-hud", "build.mjs")], { stdio: "inherit" });
if (!existsSync(join(assetsDir, "index.html"))) {
  throw new Error("assets/index.html 没生成——rail-hud 的构建脚本没把产物同步过来");
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
// 默认放在系统临时目录下；想固定位置就设 RAIL_GRADLE_HOME。
const gradleHome = process.env.RAIL_GRADLE_HOME || join(tmpdir(), "rail-gradle-home");
const androidUserHome = process.env.RAIL_ANDROID_HOME || join(tmpdir(), "rail-android-home");
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
const gradleBin = join(gradle, "bin", "gradle.bat");
const gradleArgs = [task, "--no-daemon", "--console=plain"];
if (offline) gradleArgs.push("--offline");

log(`Gradle ${task}${offline ? "（离线）" : ""} …`);
log(`  依赖缓存：${gradleHome}`);
log("  （首次要下载 AGP / Kotlin 插件，可能要几分钟）");
runBat(gradleBin, gradleArgs, { env, cwd: here });

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
  // 文件名里已经带了变体（app-release.apk / app-debug.apk），不再追加后缀，
  // 统一成 railpanel-<variant>.apk，方便一眼认出这是哪个工程的产物
  const target = join(outDir, `railpanel-${variant}.apk`);
  cpSync(join(apkDir, apk), target);
  results.push(target);
}

log("完成：");
for (const file of results) {
  const size = statSync(file).size;
  log(`  ${file}  (${(size / 1024 / 1024).toFixed(2)} MB)`);
}
log("");
log("安装到手机（手机开启 USB 调试后）：");
log(`  ${join(sdk, "platform-tools", "adb.exe")} install -r "${results[0]}"`);
log("装好后打开应用 → 先点「去授权」开启「显示在其他应用上层」→ 再点「开启悬浮面板」。");
