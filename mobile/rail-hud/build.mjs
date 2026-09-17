// 手机版 HUD 构建：把源码打成一个**自包含的单文件** index.html。
//
// 为什么必须是单文件：Android 的 WebView 里用 file:///android_asset/ 加载页面时，
// 页面是 opaque origin，`<script type="module">` 的跨文件 import 会被 CORS 挡掉
// （Chrome/WebView 对 file:// 的模块加载一律拒绝）。所以不能用「一个 html + 若干 .js」，
// 必须让产物里只有一段内联脚本。esbuild 的 --bundle + --format=iife 正好把 ESM 拍平。
//
// 产物两个地方用：
//   1. 拷进 Android 工程的 app/src/main/assets/（悬浮窗与全屏页都加载它）；
//   2. 直接丢到任意静态托管 / 用手机浏览器打开（同一个文件，行为一致）。
//
// 用法：node mobile/rail-hud/build.mjs   （或 npm run build:mobile）

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const outDir = join(here, "dist");

// 1) 抽词条：产物里内联的 i18n.gen.js 必须与主程序字典同步
execFileSync(process.execPath, [join(here, "gen-i18n.mjs")], { stdio: "inherit" });

// 2) 打包 JS（IIFE、无外部依赖、不压缩以便直接在手机上排查）
//
// esbuild 不新增依赖：Vite 自己就带一份（node_modules/@esbuild/<平台>/）。
// 这里优先用**原生可执行文件**而不是 node_modules/.bin/esbuild.cmd——
// Windows 上 Node 24 的 execFileSync 不能直接 spawn 一个 .cmd（EINVAL）。
const esbuildBinary = (() => {
  const platformPkg = { win32: "win32-x64", darwin: "darwin-x64", linux: "linux-x64" }[process.platform];
  if (platformPkg) {
    const native = join(root, "node_modules", "@esbuild", platformPkg, process.platform === "win32" ? "esbuild.exe" : "bin/esbuild");
    try {
      readFileSync(native);
      return native;
    } catch {
      // 掉到下面的 shim
    }
  }
  return join(root, "node_modules", ".bin", process.platform === "win32" ? "esbuild.cmd" : "esbuild");
})();

mkdirSync(outDir, { recursive: true });
const bundlePath = join(outDir, "hud.bundle.js");
execFileSync(
  esbuildBinary,
  [
    join(here, "main.js"),
    "--bundle",
    "--format=iife",
    "--platform=browser",
    "--target=chrome90",
    "--charset=utf8",
    "--legal-comments=none",
    `--outfile=${bundlePath}`,
  ],
  { stdio: "inherit", cwd: root },
);

// 3) 内联进 HTML
const html = readFileSync(join(here, "index.html"), "utf8");
const css = readFileSync(join(here, "styles.css"), "utf8");
const js = readFileSync(bundlePath, "utf8");

// 内联脚本里若出现 </script>，HTML 解析会提前结束整段脚本（文案里带这个串几乎不可能，
// 但这是「静默截断」类故障，代价只有一行判断，直接挡住）。
if (js.includes("</script")) throw new Error("打包产物里出现了 </script，无法安全内联");
if (css.includes("</style")) throw new Error("样式里出现了 </style，无法安全内联");

const out = html
  .replace("<!-- STYLES -->", `<style>\n${css}\n</style>`)
  .replace("<!-- SCRIPT -->", `<script>\n${js}\n</script>`);

if (out.includes("<!-- STYLES -->") || out.includes("<!-- SCRIPT -->")) {
  throw new Error("index.html 里的占位注释没被替换（模板被改过？）");
}

const outFile = join(outDir, "index.html");
writeFileSync(outFile, out, "utf8");
rmSync(bundlePath, { force: true });

// 4) 有 Android 工程就顺手拷进 assets
const assetsDir = join(root, "mobile", "android", "app", "src", "main", "assets");
try {
  mkdirSync(assetsDir, { recursive: true });
  cpSync(outFile, join(assetsDir, "index.html"));
  console.log(`[build:mobile] 已同步到 ${join("mobile", "android", "app", "src", "main", "assets", "index.html")}`);
} catch {
  // 还没建 Android 工程：只出 dist 即可
}

const kb = (Buffer.byteLength(out, "utf8") / 1024).toFixed(0);
console.log(`[build:mobile] 产出单文件 mobile/rail-hud/dist/index.html（${kb} KB，含样式与脚本）`);
