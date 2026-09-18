// 跑安卓侧的 JVM 单测（用完即删）：
//   node mobile/android/test-bridge.mjs
// 逻辑与 build-apk.mjs 同源（同一套工具链与环境变量约束），只是任务换成 testDebugUnitTest。
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ensureToolchain, runBat } from "./setup-toolchain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const log = (...a) => console.log("[android-test]", ...a);

const { jdk, gradle, sdk } = await ensureToolchain();

// 与 build-apk.mjs 相同的两条硬约束：GRADLE_USER_HOME 必须在仓库之外（见 gradle.properties 注释）
const gradleHome = process.env.TC_GRADLE_HOME || join(tmpdir(), "toolcove-gradle-home");
const androidUserHome = process.env.TC_ANDROID_HOME || join(tmpdir(), "toolcove-android-home");
mkdirSync(gradleHome, { recursive: true });
mkdirSync(androidUserHome, { recursive: true });

const args = [":app:testDebugUnitTest", "--no-daemon", "--console=plain"];
if (process.argv.includes("--offline")) args.push("--offline");
if (process.argv.includes("--rerun")) args.push("--rerun-tasks");

log("运行 Kotlin JVM 单测（桥的核心逻辑，不需要设备）…");
runBat(join(gradle, "bin", "gradle.bat"), args, {
  cwd: here,
  env: {
    ...process.env,
    JAVA_HOME: jdk,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    GRADLE_USER_HOME: gradleHome,
    ANDROID_USER_HOME: androidUserHome,
  },
});

// 汇总测试报告：Gradle 默认只在失败时说话，这里把条数打出来（否则"全绿"看不出跑没跑）
const report = join(here, "app", "build", "test-results", "testDebugUnitTest");
try {
  const files = execFileSync(process.execPath, ["-e", `
    const fs=require('fs'), path=require('path');
    const dir=${JSON.stringify(report)};
    let tests=0, failures=0, errors=0;
    for (const f of fs.readdirSync(dir).filter(x=>x.endsWith('.xml'))) {
      const c=fs.readFileSync(path.join(dir,f),'utf8');
      const m=c.match(/tests="(\\d+)"[^>]*failures="(\\d+)"[^>]*errors="(\\d+)"/);
      if (m) { tests+=Number(m[1]); failures+=Number(m[2]); errors+=Number(m[3]); }
    }
    console.log(JSON.stringify({tests,failures,errors}));
  `], { encoding: "utf8" }).trim();
  const { tests, failures, errors } = JSON.parse(files);
  log(`结果：${tests} 条用例，失败 ${failures}，错误 ${errors}`);
} catch {
  log("（未能汇总报告，但 Gradle 已通过）");
}
