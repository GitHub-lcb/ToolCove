# 铁路大亨 · 安卓悬浮面板

把「下一站是什么」压在其他应用（游戏）之上显示，可以在面板里直接录入当前站的类型与提示。

这是 ToolCove 里「铁路大亨站点推断」工具的**手机端独立实现**：推断规则直接复用主项目的
`src/tools/railTycoon.js`（一行不改），界面是重写的（手机是竖排、单列、拇指区）。
主项目的桌面版仍然照旧用。

```
mobile/
  rail-hud/          手机版 HUD 页面（悬浮窗、全屏页、手机浏览器共用同一份）
    main.js          渲染与交互（原生 DOM，无框架）
    view.js          纯视图换算（站号口径、格子内容、建议文案）
    data.js          状态归一 + 导出/导入 JSON
    i18n.js          极简 i18n（词条从主项目字典抽取）
    styles.css       三种 mode：full / panel / bar
    index.html       外壳
    build.mjs        打成单文件 → 同时同步进 android 的 assets
  android/           原生壳（Kotlin，零第三方依赖）
    app/src/main/java/com/githublcb/railpanel/
      MainActivity.kt      主界面：权限引导 + 悬浮面板开关 + 全屏 HUD 页
      RailPanelService.kt  悬浮面板（前台服务 + TYPE_APPLICATION_OVERLAY）
      SupportActivity.kt   导出 / 导入页
      RailWebView.kt       WebView 配置与初始状态注入
      RailBridge.kt        JS ↔ 原生接口
      RailState.kt         状态真源（SharedPreferences + 广播同步）
    setup-toolchain.mjs    安装便携 JDK / Gradle / Android SDK
    fetch-sdk.mjs          直接下载 SDK 组件包（sdkmanager 用不了时的后路）
    build-apk.mjs          出 APK
```

## 构建

```bash
npm run build:mobile            # 只出手机版 HUD 单文件（80 KB，可直接丢静态托管）
npm run build:apk               # 出可安装的 APK（首次会下载工具链，约 500 MB）
node mobile/android/build-apk.mjs --offline   # 工具链齐备后离线构建
```

产物：`mobile/android/out/railpanel-release.apk`（debug 签名，侧载够用），实测 **0.67 MB**。

安装（手机开 USB 调试）：

```powershell
mobile\android\.toolchain\android-sdk\platform-tools\adb.exe install -r mobile\android\out\railpanel-release.apk
```

不想用命令行也可以直接把 APK 拷进手机点安装（需要允许「安装未知来源应用」）。

> 工具链默认装在 `mobile/android/.toolchain/`（JDK + Gradle + Android SDK）。
> 网络受限的环境下，`sdkmanager` 会因 Java 侧 TLS 不可用而失败，
> 这时 `fetch-sdk.mjs` 会用 Node 直接下载 Google 官方组件包并按 SDK 目录布局解包——
> 这条路不需要 sdkmanager 的交互与许可流程。

## 首次使用

1. 打开应用 → 点「去授权（显示在其他应用上层）」→ 在系统设置里打开开关
2. 回到应用 → 点「开启悬浮面板」
3. 切到游戏，面板会浮在画面上；按住面板顶部的窄条拖动，点一下窄条在「展开 / 收成一条」之间切换
4. 录入区右上角的「横屏 / 竖屏」按钮切换面板朝向（横屏 = 更宽更矮的左右分栏，遮挡更小）；
   全屏页里同一个按钮切的是整页方向，选过的方向会记住

各家系统会杀后台，若面板过一会儿自己消失，按主界面「省电与后台」那段的清单把应用加进
自启动 / 后台运行白名单。

## 关键设计取舍（改代码前请先读）

### 为什么是两个 WebView，而不是搬移一个

本来更省事：只保留一个 WebView，在「悬浮窗」和「全屏页」之间搬来搬去。
**这条路排除了**——WebView 跨窗口 reparent 没有任何官方保证，社区实测是**不对称**的
（Activity → overlay 成功，反向失败且两个窗口都不显示），踩中就是「面板空白」这种
无法自愈的故障。

于是改成两个独立实例，同步走 `RailState`：两边都回传状态给原生，原生写进
SharedPreferences 再广播给另一边（页面的 `window.railHud.applyStateJSON`）。

代价是一个必须记住的坑：**`WebView.pauseTimers()` 是进程级全局的**。
在 Activity 的 `onPause` 里调它会一起停掉悬浮窗里那个 WebView 的 JS 定时器，
面板会「假死」。所以本工程任何生命周期里都不调它，`HudActivity` 里有注释标明。

### 为什么初始状态要由原生注入

页面在 `file://` 下读不到 SharedPreferences；而 localStorage 在「刚装完」和
「另一个窗口刚改过」这两种情况下都不等于真源。所以 `RailWebView` 把状态**拼进 HTML**
再 `loadDataWithBaseURL`——用 `evaluateJavascript` 注入会晚于页面的 `DOMContentLoaded`，
写在 `loadUrl` 之前又会打到一个还不存在的文档上。

### 为什么面板里不能打字

面板带 `FLAG_NOT_FOCUSABLE`（不加就会把游戏的输入焦点抢过来，玩家在面板外点游戏会没反应），
代价是软键盘弹不出来。`<select>` 之类依赖子窗口的控件在 overlay 窗口里也不可靠。
所以**凡是「要打字、要弹系统界面」的动作都送到全屏页**（`SupportActivity`）——
这是刻意划的边界，不是没做完。

### 为什么用单个 classic script 而不是 ES module

Android WebView 在 `file:///android_asset/` 下，页面是 opaque origin，
`<script type="module">` 的跨文件 import 会被 CORS 直接拦掉
（Chromium 官方文档明确说 `file:///android_asset` 是 discouraged）。
`build.mjs` 用 esbuild 打成 IIFE 并把整段脚本内联进 HTML，绕开这个问题，
同时省掉 `WebViewAssetLoader` 与 androidx 依赖。

### 版本是配对着选的，不要单独升级

| 组件 | 版本 | 约束来源 |
|------|------|----------|
| AGP | 8.11.1 | 要求 Gradle ≥ 8.13、build-tools ≥ 35.0.0、JDK ≥ 17 |
| Gradle | 8.14.5（8.x 最新） | Gradle 9.x 官方只测到 AGP 9.x，不能配 AGP 8 |
| Kotlin | 2.2.21 | 官方声明支持 Gradle 7.6.3–8.14、AGP 7.3.1–8.11.1 |
| JDK | 21（Temurin） | LTS；Gradle 8.5+ 起支持 |
| compileSdk | 35 | AGP 8.11 的 max_supported_android_version = 36 |
| build-tools | 35.0.0 | AGP 8.11 的最低要求（**不是** 34.0.0） |

`targetSdk` 是 34：Android 15（API 35）对「靠 SYSTEM_ALERT_WINDOW 豁免在后台拉起前台服务」
多了一条「必须已有一个可见的 overlay 窗口」的要求，而 34 不受这条约束。

### 构建脚本为什么是 Groovy 而不是 Kotlin DSL

`GRADLE_USER_HOME` 只要落在**本仓库目录内**，构建就稳定失败在脚本编译缓存上：

```
Could not move temporary workspace (.../caches/<ver>/groovy-dsl/<hash>-<uuid>)
to immutable location (.../caches/<ver>/groovy-dsl/<hash>)
```

换脚本语言、清缓存、关 daemon、关 `vfs.watch`、改成进程内编译都无效；把
`GRADLE_USER_HOME` 挪到仓库外一次通过。这是 Gradle 侧在 Windows 上的问题
（[gradle/gradle#31392](https://github.com/gradle/gradle/issues/31392)、[#31438](https://github.com/gradle/gradle/issues/31438)）。
`build-apk.mjs` 因此强制把缓存放到系统临时目录（`RAIL_GRADLE_HOME` 可覆盖），
构建脚本顺手改成 Groovy（三个小文件不值得为类型安全再折腾这条链路）。

### 资源文件（XML）上的四个坑

都踩过，且报错信息都不指向真正的原因：

1. **注释里不能出现连续两个减号**。`<!-- 见 --bg -->` 会报
   `注释中不允许出现字符串 "--"`。别在 XML 注释里写 CSS 变量名。
2. **反斜杠只有少数几个转义合法**（`\n \t \' \" \\`）。写 `C:\temp` 会报
   `Invalid unicode escape sequence`；要写反斜杠就双写。
3. **属性值里的引号用单引号**，别写 `\"`——XML 本身不需要转义引号，
   多一层反斜杠只是给 aapt2 的转义解析再添一次机会。
4. **语言目录**：默认 `values/` 放英文，中文放 `values-zh/`。
   反过来（默认中文 + `values-en`）不合法，aapt2 会报
   `Can not extract resource from ParsedResource` 这种完全看不出原因的错误。
   另外每个 XML 都要有 `<?xml version="1.0" encoding="utf-8"?>`：
   没有声明时解析器用平台默认编码，中文 Windows 上是 GBK。

## 已知的真机待验项

这些是查文档无法定论、必须上手试的（都已在代码里留了退路）：

1. 目标游戏是否设了 `setFilterTouchesWhenObscured(true)`（tapjacking 防护）——
   若设了，被面板遮住的区域游戏会收不到点击。**这是最可能遇到的问题。**
2. 小米「后台弹出界面」与「显示悬浮窗」两项对后台创建 overlay 的实际门禁关系。
3. vivo 把「悬浮窗 / 后台弹出界面 / 锁屏显示」拆成三个权限项，实际哪一项卡住面板。
4. 各家 ROM 上 `localStorage` 写入后立刻被杀进程是否丢最后一笔
   （退路：状态同时写在 SharedPreferences 里，页面崩溃也不丢已确认的记录）。
