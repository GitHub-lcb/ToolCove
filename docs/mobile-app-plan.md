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

## 6. 对齐审计（以桌面端为基准的机器比对）

"完成了"不能靠感觉。手机端的目录、命令清单、页面都是**手写**的——漏一项不会有任何报错，
界面上只是少一个入口。所以对齐要做成**可执行的检查**，而不是一次性的清点。

### 6.1 审计发现的第一个致命问题（已修）

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

### 6.2 比对结果（第二轮审计后）

| 维度 | 桌面端 | 手机端 | 结论 |
|---|---|---|---|
| 导航模块 | 12 个（含 work 的 6 个子模块） | 5 个标签 | ✅ 全部有归属（子模块并入「工作台」，速记/问题并入「记录」） |
| 工具箱 | 15 个 | 15 个 | ✅ 一一对应（曾漏 `chat`，现由断言守住） |
| 前端调用但桥未实现 | — | `load_data` / `save_data` | ✅ 已修为"可回退"，并有真机环境用例 |
| 工作台子模块 | overview / domain / iteration / requirement / release / task | overview / iteration / domain / release（分段）+ requirement / task（钻取） | ✅ 全部有入口 |
| 系统返回键 | 不适用（桌面无此概念） | 逐层回退 | ✅ 已接（此前只有界面上的 ‹ 按钮） |
| 能力矩阵 | — | 设置 → 关于 → 能力说明 | ✅ 已可见（此前只在文档里） |
| 设置项 | AI / 同步 / 外观 / 导航模块 / 语言 / 备份 / 遥测 / 更新 / 关于 | AI / 同步 / 语言 / 系统（含备份）/ 关于（含能力） | ✅ 差异项均为有意降级，见 6.5 |

### 6.3 第二轮审计发现的三个问题（本轮已修）

1. **系统返回键没接**：`Shell.vue` 的注释写着"让标签栏与系统返回键配合"，但**代码里没有实现**。
   `WorkView.goBack` 与工具箱的工具页状态都只挂在界面上的 `‹` 按钮上——也就是说在需求/子任务层
   或工具页里按安卓返回键会**直接退出应用**。已修：两个视图 `defineExpose` 暴露 `goBack`，
   `Shell.vue` 用 `popstate` 接住返回键（WebView 把返回键变成 `history.back()`，
   见 `MainActivity.onBackPressed`），策略是"页面内先回退，到栈底才交给系统"：
   每次进入可回退状态压一条哨兵，回退时消费它；不在第一个标签时退回记录页。
2. **能力矩阵只在文档里**：目标要求"平台独占能力给出安卓替代或明确降级"，
   但界面上没有一处能查"这个功能为什么不好用"。已加：设置 → 关于 → **能力说明**，
   直接读 `env.js` 的 `capabilities` 渲染（**不手写第二份清单**——手写的迟早与代码不一致），
   每一项给出"可用"或**具体原因**，而不是只标一个叉。
3. **工作台概览缺了**：桌面端 work 模块默认落在 overview，手机端此前默认是迭代列表。
   已补 `mobile/app/work/WorkOverview.vue`（KPI 两列网格、本周迭代带进度条、最近活动），
   **数据读取与统计口径与桌面端一致**：只读 iterations / problems，活动与工时从迭代子任务与
   问题日志**聚合**（不是独立数据键——我一开始按 `activityLogs` 读，那是不存在的键）。

### 6.3.1 设置页的缺口（上一轮补上备份与恢复）

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

### 6.4 领域与发布（本轮补齐）

工作台的分段从 2 个扩到 4 个：**概览 / 迭代 / 领域 / 发布**——与桌面端 work 模块的入口一一对应
（`src/navConfig.js` 的 MODULE_HOME_TAB）。为什么做成"同一标签内的分段"而不是底部新标签：
手机上底部已有 5 个标签，再塞两个会让每个都窄到难以点中；分段是"同一模块内的视图切换"。

- `mobile/app/work/DomainPanel.vue`：领域列表 → 领域下的 Pool（两层钻取）。
  数据用 repository 的 `domains` / `pools` 类别（带变更通知，比桌面端直接 invoke 更准）。
  **删领域会连同它的 Pool 一起删**——留下孤儿 Pool 在界面上再也看不到，等于数据丢失。
- `mobile/app/work/ReleasePanel.vue`：发布池列表 + 状态徽标 + 步骤勾选。
  数据用 repository 的 `releases` 类别（真实存储键是 **`release-pools`**，形状 `{active, archived}`）。
  状态判定直接复用 `src/publishState.js`（`releaseBadge` / `doneStepsCount` / `RELEASE_STEPS`），
  所以"什么算发布成功、进行到第几步"两端同一套规则；重名检查复用 `src/releasePools.js` 的 `nameConflict`。

**刻意不做的桌面专属能力**（平台上没有，不是没做完）：从 Coding 拉项目列表、批量导入路径、
git pull、真实打包与部署。手机端只做**发布状态的记录与查看**——界面底部明确写了这一点。

**过程中修掉的一个真 bug**：归档操作最初把 `active` 与 `archived` 拼成一个数组再重新分配，
结果 `rest` 同时包含原本已归档的项，把它们倒进了 active——表现为"归档一条后 active 里
凭空多出一条本该归档的记录，列表数量还不变"。改成**两个列表各自增删**。

### 6.5 仍未做的（如实记录）

| 桌面端能力 | 手机端 | 说明 |
|---|---|---|
| AI 识图建 Pool、批量导入、git pull | 不做 | 需要桌面端凭据与本地仓库；贴图识别可用工具箱的 AI 对话 |
| 外观（主题色） | 不做 | 桌面端场景；密度在手机上有实际意义，已保留 |
| 真机验证（SAF / Keystore / SQLite / wasm 加载耗时） | **未做** | 本机无模拟器与设备（`adb devices` 为空） |

### 6.6 把平台类里的逻辑挖出来测（本轮）

`bridge/` 一直是纯 JVM 可测的（102 条单测），但**平台类里的逻辑**此前完全没有测试。
本轮把两类高风险逻辑挖进 `bridge/AssetPath.kt`：

1. **路径穿越防护**（安全）：`..` 必须在**百分号解码之后**判断，否则 `%2e%2e%2f` 能绕过去。
   顺带把反斜杠也拦掉——不依赖"Android 上反斜杠不是分隔符"这个平台细节。
2. **资源候选前缀顺序**（可用性）：这是"645KB 空壳包白屏"那次事故的防线。
   `AssetsServer` 按 `web/$path` → `$path` → `web/web/$path` 的顺序找资源
   （AGP 合并 assets 时是否保留一级目录名不由我们决定），顺序错一个就是白屏。

23 条新单测覆盖：常规路径、目录式路由回落、query/hash 剥离、百分号解码、
**明文与编码后的穿越都要拦住**、坏编码不致命、候选顺序与三种布局、MIME（含
`application/wasm` 必须是它否则 `instantiateStreaming` 拒绝加载）、响应头（Content-Length
必须是真实字节数、no-cache）。

**并把"顺序对不对"与"真实产物"接上**：`verify-apk.mjs` 现在会**从 Kotlin 源码读候选列表**
（不手写第二份，避免漂移），再拿真实 APK 的 33 个资源逐个验证能否命中。
实测结论很有价值——**真实产物全部靠"原样路径"命中（`$path ×33`），`web/` 前缀这次根本没用到**，
也就是说：如果当初只写了 `web/` 一种假设，装上去就是白屏。

这个检查做过负向验证：把候选改成只剩 `web/` 前缀后，自检立刻失败并报出
"33 个资源找不到（会 404 → 白屏）" + "index.html 无法命中"——**一个永远通过的检查等于没有检查**。

### 6.7 核验"桌面端保持现状不改"（附证据）

这条是目标里的硬约束，而手机端重做期间**确实动过共享层**（`src/`），所以不能靠自信，要拿证据。
以 Phase 0（`93048b4` 移除旧悬浮面板）为基准做**语义级**比对：

| 共享文件 | 表面改动 | 语义核验结果 |
|---|---|---|
| `src/i18n/zh-CN.json` / `en-US.json` | `+278 / -4` 行 | **0 删除、0 改值**，新增 261 个键（2726 → 2987）。行数变化只是把 JSON 重排成一行一键 |
| `src/platform/env.js` | `+28 / -13` 行 | 4 个能力项表达式变了（`systemProxy`/`secureStore`/`cloudSync` 改为 `isDesktop \|\| isMobile`；`backup` 改为 `true`），但**桌面端取值全部不变**（`isDesktop` 在桌面上仍是 true，`backup` 桌面本来就是 true） |
| `src/platform/invoke.js` | `+53 / -1` 行 | 桌面分支 `if (isDesktop) return tauriCore.invoke(command, args);` **逐字未变**；`isDesktop` 相关行数前后都是 2 |
| 其余 4 个测试文件 | — | 只加断言或放宽 `vi.waitFor` 超时，不影响运行时 |

**并把这条约束变成永久守卫**：`env.capabilities.test.js` 原本只抽查 7 项，**恰好漏掉被改过的那 4 项**
（"没被覆盖"意味着下次真改坏了也没人知道）。已改为**全量快照 + 键集合断言**，
任何一项变化都必须显式改测试。做过负向验证：把桌面端 `rawPrint` 改成 `false` 后测试立刻失败并指出该项。

### 6.8 有意的降级（不是缺口，但要写明）

| 桌面端能力 | 手机端 | 原因 |
|---|---|---|
| `db_drivers` / `db_install_oracle_driver` / `db_indexes` / `db_ddl` | 不提供 | 安卓没有 JDBC；只支持 SQLite（界面已标注） |
| `label_printers` / `label_print` | 不提供，改为导出 .prn | 安卓没有 Windows 的 RAW 打印队列 |
| `file_tool_list_directory` / `batch_rename` | 不提供 | SAF 的 URI 不代表真实目录，遍历/批量改名需 tree picker（未做） |
| `autostart_*` | 不提供 | 移动端没有"开机自启"这个语义 |
| `git_pull` | 不提供 | 手机端不做仓库操作 |
| `telemetry_submit` | 不提供 | 桌面端专属的遥测通道 |
| `backup_data` / `restore_data` / `auto_backup` | 改为 JSON 导出 + SAF 恢复（见 6.3.1） | 备份路径语义不同（安卓无任意路径写） |
| `export_file` | 用浏览器下载 | 手机端用 `<a download>` + 系统分享 |
| 外观（主题色/密度） | 只保留密度 | 主题色是桌面端场景；密度在手机上有实际意义（一屏信息量） |

## 7. 标签引擎的 WASM 复用（已验证可行）

标签工具卡在"排版引擎只有 Rust 一份"上。解法不是重写，而是**让两端跑同一份代码**：

| 步骤 | 做法 | 验证 |
|---|---|---|
| 抽 crate | `crates/label-core`：把 `label.rs` 的纯逻辑（1–1155 行）逐字搬过来，**不依赖 tauri / 文件系统 / 打印** | `cargo test` **29 条原有单测全绿**（无损搬运的证据） |
| 编译 WASM | `wasm32-unknown-unknown`，导出层用裸 `extern "C"` + 手写内存协议（不引 wasm-bindgen 那一整套工具链） | 产物 **472 KB**，导出 `alloc`/`layout_json`/`source_json`/`last_len`/`release_last` |
| 真跑一次 | `node crates/label-core/build-wasm.mjs`：编译后立刻实例化并比对排版结果 | **9 项全过**：画布 400×240、间隙 16 点、文字居中 x=152、指令 `SIZE 50 mm,30 mm`、两次调用一致、坏参数返回结构化错误 |

**过程中踩到并修掉的一个真缺陷**：最初让 JS 用 `last_len()` 的返回值去释放结果内存，
运行即崩（`__rdl_dealloc` 断言）——`Vec` 的容量可能大于长度，用 len 释放是未定义行为。
改成 **wasm 侧按真实容量释放**（`release_last()`，JS 不传长度）：让分配方负责释放。

**后续（已完成）**：`src-tauri/src/label.rs` 已改为引用 `label-core`（1808 → 785 行，只留平台相关的
命令层），桌面端 `cargo test` **72 条全绿**（其中 label 相关 45 条），行为未变；
手机端 `mobile/app/platform/labelEngine.js` 加载 wasm（按需，仅打开标签工具时取），
标签工具页已落地并有 9 条 E2E（在真实浏览器产物上跑通）。

**未验证**：真机上加载 472 KB 的 wasm 的首次耗时（安卓 WebView 支持 WebAssembly，但需实测）。

## 8. 验收标准（移动端）

- **性能**：冷启动到首屏 < 2s；交互响应中位数 < 200ms；无 > 100ms 的长任务堆积；APK < 20 MB。
- **稳定性**：无白屏、无未处理异常；**系统返回键行为正确**（页面内逐层回退而不是直接退出）。
- **功能**：P2–P5 列出的能力可用；不支持的平台能力在界面上**如实标注**，不显示成坏掉的按钮。
- **回归**：复用同一批 E2E 用例跑移动视口（Playwright device emulation），关键路径不允许只靠人工验证。
- **桌面端不受影响**：`npm test`、E2E、双端构建保持全绿。

## 9. 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| WebView 版本碎片（minSdk 26） | WASM/WebCrypto 老机型不可用 | 启动能力探测 + 明确降级提示；必要时提高 minSdk |
| 本地 HTTP 服务被 ROM 杀/占用端口 | 白屏 | 随机端口 + 启动重试；保留单文件回退方案 |
| SAF 与桌面「绝对路径」语义差异 | 文件类工具行为不一致 | 在 invoke 适配层翻译；UI 文案区分「选择文件」与「路径」 |
| **桥存在与否走不同代码分支** | **只在真机出现的失败**（已实际发生：`load_data` 不可用，界面报"尚未实现该命令"） | `45-mobile-realdevice.spec.js` 把"桥存在"作为测试环境，桥只实现 Kotlin 侧真正实现的命令 |
| **手机端清单/目录是手写的** | 漏一项没有任何报错（已实际发生：漏 `chat`、漏概览） | `mobile/app/parity.test.js` 以桌面端为基准做机器比对（工具清单、命令回退、导航归属） |

**未验证**：真机上加载 472 KB 的 wasm（安卓 WebView 支持 WebAssembly，但首次加载耗时需实测）；
以及真机上的 SAF 选择器交互、Keystore 加密、SQLite 读写——这三项都只能在设备上确认
（本机没有模拟器/设备，`adb devices` 为空）。代码里已把可测的部分全部挪到 JVM 单测
（74 条）与真机环境 E2E 里。

