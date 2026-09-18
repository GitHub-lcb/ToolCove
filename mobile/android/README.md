# 手机端（安卓 App）

目标是**与桌面端功能对齐**的独立安卓应用。方案、分期与无法对齐的平台能力见
[`docs/mobile-app-plan.md`](../../docs/mobile-app-plan.md)。

## 它是什么

一个**全屏 WebView 应用**：界面是 `mobile/app`（Vue 3 + Vite，与桌面端共用 `src/` 的逻辑层），
安卓侧只负责三件事——起一个本地 HTTP 服务托管前端产物、承载 WebView、把系统返回键交给页面历史。

上一代手机端是「铁路大亨悬浮面板」（`TYPE_APPLICATION_OVERLAY` 悬浮窗），已整体移除。
现在没有悬浮窗权限、没有前台服务、没有通知，manifest 只有 INTERNET。

## 为什么不用 `file:///android_asset`

这是本工程最关键的一个决定：

| | `file:///android_asset/index.html` | `http://127.0.0.1:<port>/`（本项目采用） |
|---|---|---|
| 来源 | **opaque origin**（不透明） | 安全上下文 |
| `crypto.subtle` | 部分 WebView 上不可用 | 可用（PDF 去加密、云同步端到端加密依赖它） |
| ESM 跨文件 import | 被 CORS 拒 → 前端只能打成单文件 IIFE | 正常，可懒加载 chunk |
| WASM（qpdf 1.2MB） | 只能内联进单文件 | 按需加载 |

安全性：只绑 `127.0.0.1`、端口随机（`ServerSocket(0)`）、只服务 `assets/web` 下的文件、
路径做了 `..` 穿越防护、不做任何服务端逻辑。

## 构建

```bash
npm run build:apk                 # release（debug 签名，适合侧载）
node mobile/android/build-apk.mjs --debug      # debug 变体
node mobile/android/build-apk.mjs --offline    # 工具链齐备后离线构建
```

产物：`mobile/android/out/toolcove-release.apk`。

脚本会自动：**先构建前端**（`vite build --config mobile/vite.mobile.config.js` → `dist/mobile/app`），
再让 Gradle 通过 `syncWebAssets` 任务把它同步进 APK 资源，最后把签名过的 APK 收集到 `out/`。

**工具链不需要手工准备**：`setup-toolchain.mjs` 会把 JDK 21 + Gradle 8.x + Android SDK 35
装到 `mobile/android/.toolchain/`（约 1.5 GB，已在 .gitignore）。首次构建要下载 AGP/Kotlin 插件，几分钟。

两个环境相关的硬约束（踩出来的，别改成「更整洁」的写法）：

1. **`GRADLE_USER_HOME` 必须在仓库之外**。只要它落在仓库目录内，构建就稳定失败在脚本编译缓存上
   （`Could not move temporary workspace ... to immutable location`，gradle/gradle#31392、#31438）。
   脚本强制把它指到系统临时目录，可用 `TC_GRADLE_HOME` 覆盖。
2. **用 Groovy DSL 而不是 Kotlin DSL**。原因同上：Kotlin DSL 会多产生一个脚本缓存目录，
   在本机 Windows 上那个 rename 稳定失败。

## 已验证 / 未验证（如实记录）

**已验证**
- APK 能构建成功（`BUILD SUCCESSFUL`，产物体积约 796 KB）。
- 前端产物确实进了 APK：`assets/index.html` + `assets/assets/*`（用 zip 条目核对）。
- **资源寻址能被服务端命中**：本机没有模拟器/设备（`emulator` 与 `system-images` 未安装、
  `adb devices` 为空），因此用 APK 里的真实条目名模拟了 `AssetManager` 的寻址，
  三个关键资源（含内容哈希的 JS/CSS）全部命中。寻址做了多候选回退，同时兼容
  「合并时保留目录名」与「不保留」两种打包结果。
- 前端本身有移动视口 E2E（`e2e/specs/30-*`、`31-*`、`32-*`），在浏览器里跑真实产物。

**未验证（需要装机）**
- 真机/模拟器上的完整启动：WebView 是否成功加载页面、`crypto.subtle` 是否可用、
  系统返回键行为、软键盘与安全区表现。
- 装机后请看日志：`adb logcat -s ToolCove`（会打印 assets 实际布局与本地服务地址）。
  若页面起不来，应用会**显示错误原因**而不是白屏——白屏是最难排查的失败形态。

本地跑模拟器需要额外安装 `emulator` 与 `system-images;android-35;google_apis;x86_64`
（约 1.5 GB），目前尚未安装。

## 目录

```
mobile/app/            前端（Vue 3 + Vite，共用 ../../src 的逻辑层）
mobile/vite.mobile.config.js
mobile/android/        安卓工程
  setup-toolchain.mjs  工具链引导（JDK/Gradle/SDK，幂等）
  fetch-sdk.mjs        SDK 组件下载（被 setup-toolchain 调用）
  build-apk.mjs        构建入口：前端 → Gradle → 收集产物
  app/build.gradle     应用模块（含 syncWebAssets：把前端产物注册为生成的 assets 源）
  app/src/main/java/com/githublcb/toolcove/
    MainActivity.kt    全屏 WebView + 返回键处理 + 启动失败的可读提示
    AssetsServer.kt    loopback HTTP 服务（见上文「为什么不用 file://」）
```

## 与桌面端的关系

- **逻辑层共用**：`src/data/repository.js`、`src/sync/*`、`src/tasks.js`、
  `src/requirementMetrics.js` 等原样复用，一行不改；平台差异全部收敛在 `src/platform/invoke`。
- **视图各自实现**：桌面端是多窗口 + 自由布局，手机端是「底部标签 + 全屏页」，
  这是有意的差异，不是没做完。
- **改手机端不影响桌面端**：反之亦然。每次改动都要求三端（桌面 / 网页 / 手机）构建通过。
