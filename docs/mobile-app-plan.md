# 手机端重做方案：安卓 App 与桌面端功能对齐

日期：2026-09-20 · 状态：Phase 0 进行中 · 关联：`docs/agent-architecture.md`、`docs/perf-and-ux-baseline.md`

## 1. 目标与边界

**目标**：手机端重做成与桌面端功能对齐的独立安卓 App。桌面端与浏览器端**保持现状**（同一份 `src/` 继续出桌面包与静态站点）。

**明确不做**（平台不存在对应能力，方案里给出替代或降级）：
- **JDBC 数据库驱动**：Android 上没有 JDBC。替代方案是 android.database.sqlite（SQLite 本地库）+ 明确不做 MySQL/PG（见 §6）。
- **标签真打印**：Windows RAW 打印队列无对应物。保留 TSPL 指令生成与 203dpi 预览，真打印只在桌面端。
- **网络诊断的 ping / traceroute / DNS**：WebView 无 ICMP 与原始套接字。只保留 TCP 连通性检测（Java Socket）。

**删除**：铁路大亨悬浮面板（`mobile/rail-hud/` 与 `mobile/android/` 的悬浮窗壳、`railpanel-v*` 发版线、铁路大亨的手机端 HUD 页面）。
**保留**：`src/tools/railTycoon.js`（铁路大亨纯逻辑，桌面端 `RailTycoonTool.vue` 在用）——铁路大亨将在 Phase 3 作为**一个工具**回到 App 里。

## 2. 为什么这次能做（现有分层给的红利）

| 层 | 现状 | 手机端要做什么 |
|---|---|---|
| 业务逻辑（`src/*.js`、`src/tools/*.js`） | **纯 JS，无平台依赖** | **一行不改，直接复用** |
| 数据层（`src/data/repository.js`） | 只经 `platform/invoke` 的 `load_data`/`save_data` | 复用。存储后端由 invoke 决定 |
| 同步（`src/sync/*`：engine/crypto/merge） | 只经 invoke + WebCrypto | 复用。端到端加密本就在前端 |
| 视图层（47 个 `.vue`，1.4 MB） | 面向 1440×900 桌面窗口 + Tauri 多窗口 | **必须重做**——这是本项目的真正工作量 |
| 平台层（`src/platform/*`） | 桌面走 Tauri，浏览器走 IndexedDB/fetch | **换一套实现**（见 §4） |

一句话：**业务与数据层已经是平台无关的，重做的是 UI 与平台适配。** 这也是为什么桌面端不需要为手机端改任何东西。

## 3. 关键技术选型

### 3.1 用 localhost HTTP 托管，而不是 `file://`

旧 HUD 必须打成**单文件 IIFE**，因为 `file:///android_asset/` 是 **opaque origin**：ESM 跨文件 import 被 CORS 拒，`crypto.subtle` 也可能不可用。

新 App 改为：Kotlin 起一个**极小 HTTP 服务**（随机端口）→ WebView 加载 `http://127.0.0.1:<port>/`。收益：

- **安全上下文**：`crypto.subtle` 可用（PDF 去加密、云同步端到端加密都依赖它）；
- **不必打单文件**：可以懒加载 chunk 与 WASM（qpdf 1.2 MB 按需取），启动更快；
- **标准 Vite 构建**：直接复用 `vite build`，不必为手机端维护一套 esbuild 脚本；
- 代价：多一个本地服务实现（约 100 行 Kotlin，只绑 127.0.0.1）。

> 单文件方案作为**回退**保留：若本地服务在某些 ROM 上有问题，退回 `vite-plugin-singlefile` 出单文件 + `file://` 加载，代价是失去懒加载与 WebCrypto。

### 3.2 复用现成的 Android 工具链引导

`mobile/android/setup-toolchain.mjs`、`fetch-sdk.mjs`（自动装 JDK/Gradle/SDK，无需管理员权限）与 `build-apk.mjs` 的**引导部分与业务无关**，保留并沿用；只重写 `app/` 模块与 UI。

## 4. 平台适配层：invoke 换成安卓实现

手机端要实现的命令（与桌面端同名同语义）：

| 命令 | 安卓实现 | 备注 |
|---|---|---|
| `load_data` / `save_data` | WebView localStorage/IndexedDB，或原生 SQLite（加密） | 先 IndexedDB，够用再换 |
| `http_request` | Kotlin OkHttp 桥（绕过 WebView CORS） | AI 请求与云同步都靠它 |
| `ai_chat` / `ai_chat_stream` | 同上（流式走 WebView fetch） | 流式优先用 fetch，非流式走桥 |
| `file_tool_*` | Storage Access Framework（`ACTION_OPEN_DOCUMENT` / `ACTION_CREATE_DOCUMENT`） | 与桌面的绝对路径语义不同，需适配层翻译 |
| `db_*` | android.database.sqlite（仅 SQLite） | 其余驱动明确不支持 |
| `network_tcp_check` | Java Socket | 其余网络诊断不支持 |
| `encrypt_text` / `decrypt_text` | Android Keystore | 桌面是 DPAPI，等价物是 Keystore |
| `notify` / `save_image` / `backup_*` | 通知、应用私有目录、SAF 导出 | 逐个实现 |

## 5. 分期计划

| 期 | 内容 | 验收 | 状态 |
|---|---|---|---|
| **P0** | 删旧实现；建 `mobile/app/` 骨架（Vite + 安卓壳 + 本地 HTTP 服务） | 装机可启动、不白屏；桌面端单测/E2E 不受影响 | ✅ |
| **P1** | 平台层：invoke 安卓实现 + 存储 + HTTP 桥；跑通 `repository` 与 `sync` | 单测复用通过；手机上能建速记并同步 | ✅ |
| **P2** | 记录（速记/问题）+ 工作台（迭代/需求/子任务）+ 设置（AI/同步/语言） | E2E（移动视口）覆盖关键路径 | ✅ |
| **P3** | 15 个工具逐个移动端化（去掉多窗口 → 全屏页 + 触摸目标）；铁路大亨作为工具回归 | 每个工具一条渲染冒烟 + 关键交互用例 | **12/14**（剩数据库、标签） |
| **P4** | Agent 工作台（复用 runtime/session，确认卡与时间线移动端化） | 用桩跑通「调用工具 → 确认 → 收尾」 | ✅ |
| **P5** | 原生桥与平台独占替代：HTTP/TCP/Keystore/SAF 已落地；剩 SQLite、TSPL 预览 | 能力面板如实标注支持范围 | 进行中 |
| **P6** | 发版：APK 签名（可选正式签名）、版本线、CI、产物自检 | 一条 tag 出一个可安装 APK | ✅ |

每期独立可发布；P0/P1 是地基，P2–P5 之间无强依赖，可按需调整顺序。

### 5.1 与原计划的三处偏离（都写清原因）

1. **标签工具不重写 JS 版**：桌面端的 TSPL 排版是 Rust 侧 1550 行引擎（`src-tauri/src/label.rs`），
   JS 侧只有表单归一化与预览几何。把排版用 JS 再实现一遍等于同一件事两份实现，
   迟早不一致——而"所见即所打"是这个工具的立身之本。
   **已找到可行路径：把引擎抽成独立 crate 并编译到 WASM**（见 §6）。
2. **P6 提前到 P3 之前做**：安卓壳与发版链路是唯一能"证明这套技术路线成立"的东西，
   越早打通越好（本地 HTTP 服务、crypto.subtle 可用性、资源寻址都要靠装机验）。
3. **P5 的桥分层做**：HTTP/TCP/Keystore/SAF/SQLite 逐个落地，每个都把"可测的部分"挪出 Android 依赖
   （JSON、编解码、命令分发、选择器时序），使 JVM 单测能覆盖绝大部分逻辑，装机只剩接线。

## 7. 对齐审计（以桌面端为基准的机器比对）

"完成了"不能靠感觉。手机端的目录、命令清单、页面都是**手写**的——漏一项不会有任何报错，
界面上只是少一个入口。所以对齐要做成**可执行的检查**，而不是一次性的清点。

### 7.1 审计发现的第一个致命问题（已修）

`src/platform/invoke.js` 在手机端写成「桥存在就直接返回」，**从不回退浏览器实现**。
而桥只实现"真正需要原生"的能力（HTTP/TCP/加密/SAF/SQLite），
存储命令 `load_data` / `save_data` 走的是浏览器实现（IndexedDB）。

后果：**真机上读写不了任何数据**——记录、工作台、设置、Agent 全部依赖这两个命令。

为什么 E2E 没测出来：所有移动端用例都跑在"浏览器形态"（没有 `window.ToolCove`），
走的是**另一条分支**。真机上桥存在，走的是从未被测过的那条。

修法与守住的规则：
- 桥抛错时回退浏览器处理器，但**只对"桥明确不认识"的命令**（`code: "unsupported"`）——
  桥认识的命令一旦失败（HTTP 超时、文件读不到），那是**真实结果**，回退只会掩盖它；
- 新增 `e2e/specs/45-mobile-realdevice.spec.js`：**把"桥存在"作为测试环境**，
  且桥只实现 Kotlin 侧真正实现过的命令，其余一律返回 unsupported。
  这样任何"前端调了但桥没实现"的命令都会在 CI 暴露，而不是等装机；
- `mobile/app/parity.test.js` 里加一条静态断言：`invoke` 的手机端分支必须保留 try/catch 回退，
  且回退要有条件（不能吞掉真实错误）。

### 7.2 四个维度的比对结果

| 维度 | 桌面端 | 手机端 | 结论 |
|---|---|---|---|
| 导航模块 | 12 个（含 work 的 6 个子模块） | 5 个标签 | ✅ 全部有归属（子模块并入「工作台」标签，速记/问题并入「记录」） |
| 工具箱 | 15 个 | 15 个 | ✅ 一一对应（曾漏 `chat`，现由断言守住） |
| 前端调用但桥未实现 | — | `load_data` / `save_data` | ✅ 已修为"可回退"，并有真机环境用例 |
| 设置项 | AI / 同步 / 外观 / 导航模块 / 语言 / 备份 / 遥测 / 更新 / 关于 | AI / 同步 / 语言 / 系统（含备份）/ 关于 | ⚠️ 见下 |

### 7.3 设置页的缺口（本轮补上备份与恢复）

审计发现手机端设置页只有 3 张卡片（AI / 同步 / 语言），**完全没有备份与恢复**——
而桌面端有。这在手机端**是可行的**，只是做法不同：

- 桌面端：把 `app_data_dir` 下的 `*.json` 与图片打成 **zip**，写到用户选的路径；
- 手机端：数据在 IndexedDB 里，**导出成一个 JSON 文件**（走浏览器下载，可存网盘/传电脑），
  恢复时经**系统文件选择器（SAF）**选该文件写回。

格式用 JSON 而非 zip 是刻意的：手机端要少一层依赖（JS 造 zip 要么引库、要么手写），
而备份的实质就是"一堆键值对"，JSON 足够且**人能读懂**——出问题可以直接打开看。
文件头带 `format`/`version`/`platform`，所以：
- 选到桌面端的 zip → 提示"请在电脑上恢复"；
- 选到别的工具的 JSON → 提示"格式不匹配"；
- 备份来自更高版本 → 提示"请先升级再恢复"（不假装能读，否则会丢字段）。

新增 `mobile/app/backup.js`（纯逻辑，9 条单测）+ 设置页的备份卡片 + 6 条 E2E。

### 7.4 有意的降级（不是缺口，但要写明）

| 桌面端能力 | 手机端 | 原因 |
|---|---|---|
| `db_drivers` / `db_install_oracle_driver` / `db_indexes` / `db_ddl` | 不提供 | 安卓没有 JDBC；只支持 SQLite（界面已标注） |
| `label_printers` / `label_print` | 不提供，改为导出 .prn | 安卓没有 Windows 的 RAW 打印队列 |
| `file_tool_list_directory` / `batch_rename` | 不提供 | SAF 的 URI 不代表真实目录，遍历/批量改名需 tree picker（未做） |
| `autostart_*` | 不提供 | 移动端没有"开机自启"这个语义 |
| `git_pull` | 不提供 | 手机端不做仓库操作 |
| `telemetry_submit` | 不提供 | 桌面端专属的遥测通道 |
| `backup_data` / `restore_data` / `auto_backup` | 设置页走同步与导出 | 备份路径语义不同（安卓无任意路径写） |
| `export_file` | 用浏览器下载 | 手机端用 `<a download>` + 系统分享 |


## 6. 标签引擎的 WASM 复用（已验证可行）

标签工具卡在"排版引擎只有 Rust 一份"上。解法不是重写，而是**让两端跑同一份代码**：

| 步骤 | 做法 | 验证 |
|---|---|---|
| 抽 crate | `crates/label-core`：把 `label.rs` 的纯逻辑（1–1155 行）逐字搬过来，**不依赖 tauri / 文件系统 / 打印** | `cargo test` **29 条原有单测全绿**（无损搬运的证据） |
| 编译 WASM | `wasm32-unknown-unknown`，导出层用裸 `extern "C"` + 手写内存协议（不引 wasm-bindgen 那一整套工具链） | 产物 **472 KB**，导出 `alloc`/`layout_json`/`source_json`/`last_len`/`release_last` |
| 真跑一次 | `node crates/label-core/build-wasm.mjs`：编译后立刻实例化并比对排版结果 | **9 项全过**：画布 400×240、间隙 16 点、文字居中 x=152、指令 `SIZE 50 mm,30 mm`、两次调用一致、坏参数返回结构化错误 |

**过程中踩到并修掉的一个真缺陷**：最初让 JS 用 `last_len()` 的返回值去释放结果内存，
运行即崩（`__rdl_dealloc` 断言）——`Vec` 的容量可能大于长度，用 len 释放是未定义行为。
改成 **wasm 侧按真实容量释放**（`release_last()`，JS 不传长度）：让分配方负责释放。

**下一步**：把 `label.rs` 的命令层改为引用 `label-core`（re-export 类型 + 调 `build_render_payload`），
桌面端因此与手机端共用同一份引擎；然后手机端加 `labelEngine.js` 加载 wasm、实现标签工具页。

**未验证**：真机上加载 472 KB 的 wasm（安卓 WebView 支持 WebAssembly，但首次加载耗时需实测）；
桌面端接线后 `cargo test` 需全绿（保证搬运与 re-export 没有改变行为）。


## 6. 验收标准（移动端）

- **性能**：冷启动到首屏 < 2s；交互响应中位数 < 200ms；无 > 100ms 的长任务堆积；APK < 20 MB。
- **稳定性**：无白屏、无未处理异常；系统返回键行为正确（页面栈而不是直接退出）。
- **功能**：P2–P5 列出的能力可用；不支持的平台能力在界面上**如实标注**，不显示成坏掉的按钮。
- **回归**：复用同一批 E2E 用例跑移动视口（Playwright device emulation），关键路径不允许只靠人工验证。
- **桌面端不受影响**：`npm test`、`npm run test:e2e`、双端构建保持全绿。

## 7. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| WebView 版本碎片（minSdk 26） | WASM/WebCrypto 老机型不可用 | 启动能力探测 + 明确降级提示；必要时提高 minSdk |
| 本地 HTTP 服务被 ROM 杀/占用端口 | 白屏 | 随机端口 + 启动重试；保留单文件回退方案 |
| SAF 与桌面「绝对路径」语义差异 | 文件类工具行为不一致 | 在 invoke 适配层翻译；UI 文案区分「选择文件」与「路径」 |
| 47 个组件的响应式改造量大 | 周期长 | 分 P3 逐个工具推进，每个工具独立可发布 |
| 双端行为漂移 | 同一功能两边不一样 | 业务逻辑共用同一份 `src/`，UI 各自实现；关键逻辑由单测锁住 |
