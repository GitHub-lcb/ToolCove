# ToolCove 定位与模块划分评估

日期：2026-10-12 · 分析对象：`main` @ `ca01db6`（199 commits，2026-08-22 → 2026-10-12）
方法：全量静态阅读（不改代码）。所有结论附 `文件:行` 证据；行数为物理行数（含空行）。

---

## 结论速览

1. **定位不是"一堆工具"，但也还不完全是"智能体工作台"**：它实际上是**一个 Agent 工作台 + 一个研发管理工作台 + 一个 26 件工具箱**的三合一。README 只认真写了其中两件（Agent、工具箱），**第三件占了 `src/` 非测试代码的 38%，却在 README 的功能清单里一个字都没有**。
2. **模块划分的骨架是健康的**：分层方向清晰、无死代码、全项目只有 1 个文件级循环依赖、`platform/` 是干净的叶子层。这套纪律比同类项目好得多。
3. **真正失焦的地方是"根目录没有分区"**：`src/` 根下平铺着 **79 个非测试文件 / 24,872 行**，三个产品的代码混在一起；`src/Icon.vue` 被 **58 个文件**导入，成为全项目第一大耦合枢纽。
4. **最该修的三处**：根目录按产品分区、`json.js` 重名消除（现为唯一重名模块，且两份内容已漂移）、README/欢迎页与代码的分层定义对齐（当前"工作台"一词在 README 指 Agent、在界面指研发管理）。

---

## 一、定位：它到底是什么

### 1.1 三个产品面，不是两个

| 产品面 | 用户任务 | 入口 | 非测试行数 | 占 `src/` |
|---|---|---|---|---|
| **A. 通用工具**（26 件，Agent 的动作空间） | "我要转个格式 / 修张图 / 压个 PDF" | `toolbox` 模块（Ctrl+4） | `src/tools/` 31,060 | **47%** |
| **B. 研发管理**（领域/迭代/需求/发布/任务 + 速记/问题） | "这个版本的需求、工时、上线到哪一步了" | `work` + `records` 模块（Ctrl+2 / Ctrl+3） | 8,631 + 支撑 1,059 + 逻辑 739 ≈ **9,149** | **14%** |
| **C. Agent 工作台**（把这些能力当动作空间去规划） | "用一句话说目标，你来挑工具串起来" | `agent` 模块（Ctrl+1，默认首屏） | `src/agent/` 4,000（含测试 9,003） | **6%** |

> `src/` 非测试合计 **65,466 行**（210 文件），另加 141 个测试文件 23,997 行。

**每个视图都在讲自己的故事，而它们讲的是不同的故事：**

- **代码说自己是 Agent 工作台**：`src/App.vue:55` `const activeModule = ref("agent")` —— 默认首屏是 Agent，不是工具箱；`src/navConfig.js:6-11` 侧边栏第一项也是 agent。
- **欢迎页说自己是研发管理工具**：`src/WelcomeView.vue:9` 画的是**工具箱的扳手图标**，文案却是"任务、迭代、需求、发布等模块已全部迁入"（`src/i18n/zh-CN.json` 的 `welcome.body`）。一个页面同时指向两个产品面。
- **README 说自己是工具箱 + Agent**：`README.md:19-72` 的功能清单里，**26 件工具逐个列出、Agent 用 12 行详述，而领域/迭代/需求/发布/任务六个 Tab 在英文版没有一条 feature bullet**，只在 Agent 能力表的括号里出现过一次（`README.md:91`："snippets, problems, prompts, iterations, domains, pools, releases"）。中文版（`README.md:398-400`）同样只列速记/问题/云同步。

**这不是文档疏漏，是定位没收敛。** 三个产品面对"我是什么"的回答互相冲突，而 README 选择性地只承认其中两个。

### 1.2 "工作台"这个词已经被占用两次

- `README.md:290`（中文简介）："ToolCove（工具湾）是面向开发者的**智能体工作台**" → 工作台 = Agent
- `src/i18n/zh-CN.json` 的 `nav.work` = **"工作台"** → 工作台 = 研发管理模块（迭代/需求/发布）

用户点开侧边栏的"工作台"，看到的不是 README 承诺的智能体工作台，而是一个迭代管理页。**同一个词指两个不同的东西，是本项目定位混乱最直观的症状。**

### 1.3 `welcome.body` 是唯一接近定位陈述的地方

`src/i18n/zh-CN.json:welcome.body`：「纯本地、无账号、开箱即用的开发者效率工作台。任务、迭代、需求、发布等模块已全部迁入。」

- 它承认了研发管理面（好），但把它说成"迁入"——像是在描述一次历史迁移，而不是一个产品主张。
- `src/SettingsView.vue:35-40` 的 `SECTIONS` 只有 ai / sync / sponsor / general，**没有任何"关于本产品"的说明**。也就是说，产品自己没在任何显眼处回答"我是什么"。

### 1.4 三个产品面的耦合程度：弱得可以切开

这是好消息，也是"定位可以晚点再定"的底气：

```
src/platform/     ← 零跨区出边（PROD），唯一真叶子层
src/i18n/         ← 只出到 platform
src/data/         ← 只依赖 platform + sync
src/agent/        ← 只依赖根级共享层 + platform
src/tools/        ← 依赖根级共享层（38 文件 / 109 边）+ platform
src/checkin/      ← 依赖根级共享层 + platform
```

**研发管理面与工具箱面之间没有任何直接依赖**：`src/tools/` 不导入 `agent`/`data`/`checkin`/`sync` 中的任何一个（grep 无命中）。两者唯一的交集是 Agent 的 `data.*` 工具（`src/agent/dataTools.js:6` → `src/data/repository.js`）。

**结论：三个产品面在代码层面是可分离的。** 定位问题因此不是"技术债"，而是"产品决策债"——现在可以慢慢想，代价还很小。

---

## 二、模块划分审计

### 2.1 分层方向：总体健康

- **`src/platform/` 在生产代码中零跨区出边**（11 个生产文件），是全项目唯一的真底层。这是教科书式的做法。
- **`src/tools/` 是最大消费方**：74 个生产文件里 47 个（63.5%）有跨区依赖、175 条边，占全部跨区边的 74%。符合"能力层"定位。
- **无死代码**：147 个非测试 `.js` 中，除入口 `src/main.js` 外**全部至少有一个生产导入方**；63 个 `.vue` 全部有导入方（21 个根级视图经 `App.vue:73-83` 的 `defineAsyncComponent` 懒加载，26 个工具组件经 `src/toolComponents.js:8-33`）。**没有任何模块是"只被测试引用"的**。
- **`src/toolboxTools.js`（26 件工具）↔ `src/toolComponents.js`（26 个组件）完全一一对应**，无孤儿、无缺件；且由 `src/toolboxTools.test.js:183-193` 与 Tauri capability（`src-tauri/capabilities/default.json`）双向锁死。这条纪律很好。

### 2.2 依赖环：全项目只有 1 个文件级环

```
src/data/repository.js:130  →  import("../sync/index.js")      [动态，有意惰性]
src/sync/index.js:10        →  import { KINDS, ... } from "../data/repository.js"  [静态]
```

`repository.js:129-132` 用 `syncModule = syncModule || import(...)` 做 memoize 打破静态环，**是有意为之且有注释**。

区域级环有 6 个，其中 **`tools ↔ agent` 是唯一与根目录无关的环**：

```
src/tools/AiChatTool.vue:9  → src/agent/session.js
src/agent/session.js:13     → ./tools.js
src/agent/tools.js:25       → await import("./executors.js")
src/agent/executors.js:8    → import { yamlToJson } from '../tools/yaml.js'   ← 回路终点
```

注意 `agent → tools` 全项目**只有这 1 条边**（`executors.js:8`，借了一个 `yaml.js`），而 `tools → agent` 有 2 条。**为了一个 YAML 解析函数制造了一个跨区环**——`src/tools/yaml.js`（207 行）挪到根级共享层即可消除。这是本报告里"改动最小、收益最直接"的一条。

### 2.3 扁平根：本报告认定的**主要结构问题**

`src/` 根目录下平铺着 **79 个非测试文件 / 24,872 行**（占非测试代码 38%），其中同时住着：

- 11 个应用视图（`AgentView.vue` 1,024 / `IterationView.vue` 1,859 / `TaskView.vue` 1,228 …）
- 56 个纯逻辑模块，分成三类却没有任何目录区分：
  - **工具逻辑**：`json.js`(139)、`xmlTool.js`(501)、`tableTool.js`(383)、`imageTool.js`(474)、`markdownTool.js`(333)、`jsonSchema.js`(487)、`cryptoTool.js`(243)…
  - **业务逻辑**：`tasks.js`(142)、`snippets.js`(30)、`releasePools.js`(66)、`publishState.js`(45)、`requirementMetrics.js`(97)、`weeklyReport.js`(198)…
  - **应用框架**：`navConfig.js`、`settingsConfig.js`、`migrate.js`、`toolWindow.js`、`accentTheme.js`、`telemetry.js`…

**成本已经被量化：**

| 指标 | 数值 | 说明 |
|---|---|---|
| `src/tools/` 中 `../` 相对导入 | **187 条 / 62 个源文件** | 每 3 条相对导入就有 2 条要跳回根目录 |
| 被 `src/tools/` 导入的根级目标 | **38 个文件 / 109 条边** | 根目录是 `tools/` 的"共享层"，但它是无分组的 |
| `src/Icon.vue` 导入方 | **58 个文件** | 全项目第一大枢纽 |
| `src/toolboxStore.js` 导入方 | 22 | 第二 |
| `src/confirm.js` 导入方 | 20 | 第三 |
| `src/shared.js` 导入方 | 17 | 第四（564 行，26 个导出符号，横跨"日期/工时/Excel/Markdown 渲染/平台链接解析"五个无关领域） |

**`src/Icon.vue` 是最能说明问题的一个**：它被 35 个 `tools/` 文件导入（`CryptoTool.vue:4`、`DbTool.vue:6`、`JsonTool.vue:25`、`RailTycoonTool.vue:24` …）。一个"图标原子组件"住在应用视图层，于是每个工具箱工具都要跨区取它。**它本该在 `src/ui/` 或 `src/shared/`。**

**唯一的重名模块也是这个问题的产物**：

```
src/json.js        139 行  import { i18n } from "./i18n/index.js"
src/tools/json.js  138 行  import { i18n } from "../i18n/index.js"
```

两份内容**已漂移**（`Compare-Object` 只差 3 行，其中一处是注释）；`src/json.js` 与 `src/tools/json.js` 的测试文件**字节完全相同**（SHA256 一致），等于同一套测试跑两遍不同实现。实际使用也割裂：

- `src/tools/JsonTool.vue:4` 与 `src/tools/yaml.js:3` 用 **`tools/json.js`**
- `src/agent/executors.js:6`、`mobile/app/tools/JsonToolView.vue:10` 用 **`src/json.js`**
- `mobile/app/tools/toolContracts.test.js:2` 对着 **`src/json.js`** 断言契约

**Agent 跑 `json.parse` 用的实现，和用户在 JSON 工具里手点的实现，不是同一份。** 这不是命名问题，是正确性问题。

### 2.4 研发管理面：划分基本合理，但有一处历史遗留的命名崩塌

**合理的部分**（值得肯定）：

- `src/data/repository.js`（323 行）是业务数据的**唯一读写入口**：`KINDS` 白名单 + 修订号 CAS + 冲突重放 + `data-changed` 广播 + 墓碑删除，视图与 Agent 数据工具共用。这个抽象是对的，`docs/superpowers/plans/2026-09-10-agent-data-layer-and-nav.md:141-171` 记录了它修掉的真实缺陷（三写者互相覆盖、`updatedAt` 数字与 ISO 不可比、Vue 代理进 IndexedDB 报 `DataCloneError`）。
- 七个视图（`SnippetView` / `ProblemView` / `IterationView` / `RequirementBoardView` / `TaskView` / `DomainView` / `ReleaseView`）全部迁移到 `repository.mutate`，并订阅 `data-changed`。
- `src/navConfig.js`（75 行）把导航、旧 key 映射、迁移规则收在一处，有单测。

**问题 1：`tasks` 死键 —— 一个从没写过的存储键**

`src/GlobalSearch.vue:29` 读 `invoke("load_data", { key: "tasks" })`，期望 `{id, title, code}` 形状。**全仓无任何写入**（搜 `"tasks"` 只命中这一处，加一条 `dataTools.test.js:159` 的否定断言）。任务数据实际存在 `iterations` 数组里。

后果：全局搜索的"任务"分组**永远是空的**。项目自己的计划文档早在 2026-09-10 就记了这一条（`docs/superpowers/plans/2026-09-10-agent-data-layer-and-nav.md:51`），**至今未修**。

**问题 2：`tasks.js` 这个名字里装的不是任务**

`src/tasks.js:2-5` 的文件头自己写着数据模型是迭代/需求/子任务：

```
iteration = { …, items: [requirement] }
requirement = { …, subtasks: [subtask] }
subtask = { …, logs }
```

`src/TaskView.vue:11` 从 `tasks.js` 导入 `addIteration` / `addRequirement` / `addSubTask` —— **"任务"页写进的是 `iterations` 数组**。三处命名对应同一个数组：`task`（导航 key）、`tasks.js`（文件名）、`iterations`（存储键）。新加入的人第一次找"任务数据在哪"必然踩空。

**问题 3：重复实现已经产生语义分歧**

| 重复项 | 位置 | 后果 |
|---|---|---|
| 工时聚合 | `src/shared.js:249-316` `collectDayLogs`（规范实现，处理 `logs` 明细与指派人回退） vs `src/WorkOverviewView.vue:163-180` `dayHours`（**重新实现且无 `logs` 分支**） | **概览页的"今日工时"与任务页的日合计会对不上** |
| 迭代进度 | `src/IterationView.vue:277-282` `progress()` vs `src/WorkOverviewView.vue:81-86` `progress()` | 逐字符相同的两份拷贝 |
| 迭代状态标签 | `src/IterationView.vue:22-28` · `src/WorkOverviewView.vue:79` · `src/i18n/zh-CN.json` 的 `mobile.status.*` · `src/agent/dataTools.js:31` | 同一个枚举 4 份定义，**其中 2 份硬编码中文、完全不进 i18n** |
| `function round(` | 出现 6 次 | — |

### 2.5 一个"体积与地位不匹配"的孤岛

`src/tools/interviewBank*` 共 **21 个文件 / 约 6,000 行**，结构是单链：

```
InterviewTool.vue → interviewBank.js → interviewBankParts.js → { 19 个 interviewBankXxx.js }
```

每个下游文件 in-degree 恰好为 1。它服务**唯一一个工具**（面试刷题），却占了 `src/tools/` 非测试代码的 **约 20%**（6,000 / 31,060）。

这不算"错误划分"——题库按方向拆文件、由 `interviewBankParts.js` 单一装配，是**正确**的做法（`interviewBankParts.js:1-9` 的注释解释了为什么不写一个几千行的文件），且 `interviewBankParts.js:63-147` 用受控主题词表 + 测试断言防止同义词分裂。但它确实应该有自己的目录（`src/tools/interview/`），否则 `src/tools/` 的 107 个文件里，理解成本被这 21 个同名前缀文件挤占。

### 2.6 i18n 的不一致：一半视图彻底国际化，一半硬编码中文

| 文件 | `t("…")` 调用 | 硬编码中文字符串字面量 | 中文字符数 |
|---|---|---|---|
| `src/ProblemView.vue` | 117 | 0 | 701 |
| `src/tools/DbTool.vue` | 156 | 0 | 2,273 |
| `src/AgentView.vue` | 108 | 0 | 1,735 |
| `src/SnippetView.vue` | 58 | 1 | 524 |
| `src/DiskAnalyzerTool.vue` | 95 | 1 | 1,757 |
| **`src/IterationView.vue`** | **0** | **199** | **3,166** |
| **`src/TaskView.vue`** | **0** | **109** | **2,456** |
| **`src/DomainView.vue`** | **0** | **60** | **1,247** |
| **`src/ReleaseView.vue`** | **0** | **43** | **1,547** |
| **`src/RequirementBoardView.vue`** | **0** | **33** | **432** |
| **`src/WorkOverviewView.vue`** | **0** | **31** | **911** |

**规律非常干净：`records` 模块（速记/问题）与所有 `tools/` 工具完全国际化；`work` 模块六个 Tab 一个 `t()` 都没有。** 字典里 `zh-CN.json` 共 3,957 个叶子键（`toolbox` 2,638 / `agent` 173 / `problem` 115 / `snippet` 69），**没有一个是 work 模块的**。

`src/i18n/i18n.test.js` 强制了"中英字典键集合一致""每个键非空"，但**没有任何守卫能发现"这段界面根本没用字典"**。英文用户切到 `work` 模块会看到整页中文。

### 2.7 移动端：共享逻辑，重写视图 —— 判断正确，但缺一层 UI 复用

`mobile/` 共 96 个受版本控制的文件。架构选择是**对的**：

- `mobile/app/*` 通过 `../../src/...` 复用 `platform` / `i18n` / `data/repository` / `sync` / `tasks` 及 15 个工具纯逻辑（65 处跨目录 import）。
- `mobile/app/parity.test.js:53-109` 把"手机端是否漏了工具/命令/模块"变成**可执行的机器比对**——`parity.test.js:61-72` 甚至静态解析 Kotlin `Bridge.dispatch` 的 `when` 分支，断言"前端调了但桥没实现的命令"为零。这个方法比写文档强得多。
- `docs/mobile-app-plan.md:93-111` 记录的致命 bug（`invoke` 在手机端写成"桥存在就直接返回"，导致真机 `load_data`/`save_data` 全废，且 E2E 测不出因为跑的是浏览器分支）已经修好并加了回归守卫。

**代价是 1,589 行手写视图**：`mobile/app/WorkView.vue`(331) / `work/DomainPanel.vue`(271) / `work/ReleasePanel.vue`(337) / `RecordsView.vue`(237) / `work.js`(117) / `records.js`(111) 等，视觉与交互对桌面端的对应物**没有任何自动化对齐**（`parity.test.js` 只比对"有没有入口"，不比对行为）。`mobile/app/work.js:6` 的注释自己承认："桌面把这段算在 **106KB 的 IterationView.vue** 里"。

### 2.8 门禁的缺口

好的守卫（已存在）：

- `src/agent/catalog.test.js` 双向锁定"目录 ↔ 实现"（键集合、`risk`/`desktopOnly`/`previewBefore`/`confirm`/`retryable` 全部逐项相等），并在 `catalog.test.js:93-147` 用真实输入跑通接入的纯转换工具。
- `src/toolboxTools.test.js:180-193` 锁定"注册表工具 ↔ Tauri capability 窗口"双向。
- `src/i18n/i18n.test.js` 锁定字典键对齐与消息编译。
- `mobile/app/parity.test.js` 锁定手机端对齐。

**缺口**：

1. `eslint.config.js`（92 行）**没有任何 import 边界规则**——无 `no-restricted-imports`、无 `import/no-cycle`。前面所有分层约定**全靠人工自觉**。
2. **没有任何守卫能发现 work 模块不走 i18n**（§2.6）。
3. **没有任何守卫能发现 `tasks` 是死键**（§2.4 问题 1），尽管类型上完全可写（"每个 `data.*` 的 kind 都必须在 `KINDS` 里"这条断言存在，但 `GlobalSearch` 直连 `invoke("load_data")` 绕过了 repository）。

---

## 三、问题清单（按"该不该现在修"排序）

| # | 问题 | 证据 | 影响 | 成本 |
|---|---|---|---|---|
| 1 | **`json.js` 重名且两份实现已漂移** | `src/json.js:1-139` vs `src/tools/json.js:1-138`；`src/json.test.js` 与 `src/tools/json.test.js` **SHA256 相同**；Agent 用前者（`agent/executors.js:6`）、JSON 工具用后者（`tools/JsonTool.vue:4`） | **正确性**：同一操作两条代码路径 | 低（删 `src/tools/json.js`，改 3 处 import） |
| 2 | **`tasks` 死键，全局搜索"任务"分组永空** | `src/GlobalSearch.vue:29`；全仓无写入；项目自己 2026-09-10 已记录（计划文档 `:51`） | 用户可见的功能缺失 | 低 |
| 3 | **`tools ↔ agent` 环，只为借一个 `yaml.js`** | `agent/executors.js:8` 是全项目唯一的 `agent→tools` 边 | 结构 | 低（`yaml.js` 上移） |
| 4 | **根目录 79 文件 / 24,872 行无分区** | 见 §2.3；`Icon.vue` 58 个导入方；`shared.js` 564 行横跨 5 个无关领域 | 长期维护成本、新人理解成本 | 中 |
| 5 | **work 模块 6 个视图零 i18n** | 见 §2.6 表 | 英文用户看到整页中文 | 中高（3,166+2,456+… 字符） |
| 6 | **工时聚合两套实现，结果会不一致** | `src/shared.js:249-316` vs `src/WorkOverviewView.vue:163-180` | 数据可信度 | 低 |
| 7 | **README 完全没写研发管理面** | `README.md:19-72` 英文功能清单、`:398-400` 中文清单均无 work 模块；只在 `:91` 括号里出现一次 | 定位不清、新用户不知道有这功能 | 低 |
| 8 | **"工作台"一词两义** | `README.md:290`（=Agent）vs `nav.work`（=研发管理） | 沟通成本 | 低（改一个词条） |
| 9 | **`Icon.vue` 等 UI 原子住在应用视图层** | `src/Icon.vue` 被 35 个 `tools/` 文件导入 | 跨区耦合最大化 | 低（移入 `src/ui/`） |
| 10 | **`tasks.js` 命名与内容不符** | `src/tasks.js:2-5` 定义的是迭代/需求/子任务；`TaskView.vue:11` 从它导入 `addIteration` | 认知负担 | 低（改名 `iterations.js`） |
| 11 | **无 import 边界 lint 规则** | `eslint.config.js:30-66` | 分层约定无守卫 | 低 |
| 12 | **`interviewBank*` 21 文件 / 6,000 行无自己的目录** | 见 §2.5 | 局部理解成本 | 低（移入 `src/tools/interview/`） |

---

## 四、建议

### 第一步（半天，纯收益，无风险）

1. 删 `src/tools/json.js`，把 `tools/JsonTool.vue:4`、`tools/yaml.js:3` 改指 `src/json.js`；删 `src/tools/json.test.js`（与 `src/json.test.js` 字节相同，只需留一份）。
2. `src/tools/yaml.js` 上移到根级共享层，消掉 `agent/executors.js:8` 这条唯一的 `agent→tools` 边。
3. 删 `src/GlobalSearch.vue:29` 的 `tasks` 死键读取（第 20 行的 `data.value.tasks` 初始化、第 130-132 行的分组循环、第 88 行的 `task` 分组图标一并清掉）。
4. `src/WorkOverviewView.vue:163-200` 改用 `shared.js` 的 `collectDayLogs`，删掉本地 `dayHours` / `recentLogs` 的重复实现。
5. `nav.work` 词条从"工作台"改为"研发"或"项目"（英文 `nav.work` 同步），把"工作台"留给 README 里的 Agent。

### 第二步（1–2 天，结构）

6. **根目录分区**（一次机械移动 + 改 import，`git mv` 可保持历史）：

```
src/
  app/        应用外壳与框架：App.vue, navConfig.js, settingsConfig.js, migrate.js,
              toolWindow.js, accentTheme.js, telemetry.js, ToolWindow.vue, ModuleTabs.vue …
  ui/         UI 原子与通用交互：Icon.vue, ConfirmDialog.vue, confirm.js, dragsort.js,
              ToolErrorPanel.vue, skeleton 相关
  views/      研发管理视图：work/（overview/domain/iteration/requirement/release/task）
                              records/（snippet/problem）+ GlobalSearch.vue
  shared/     真正跨产品的纯工具：shared.js（建议再按 date/ / excel/ / markdown/ 拆）
  tools/      维持不变（26 件工具 + 各自的纯逻辑）
  agent/ checkin/ sync/ data/ platform/ i18n/ screenshot/   维持不变
```

   **判据**：移动的标准是"它服务于哪个产品面"——`shared.js` 的三个 Excel 构建函数（`buildReleaseXlsx` / `buildWorkHoursXlsx` / `exportDbResultXlsx`）应该按调用方归属拆分，而不是继续留在"通用"里。

7. `eslint.config.js` 加 `no-restricted-imports`：禁止 `src/tools/**` 导入 `src/views/**` 与 `src/app/**`，禁止 `src/platform/**` 导入任何上层。这把现有的自觉变成红灯。

### 第三步（产品决策，需要先拍板）

8. **决定第三个产品面的去留**，三选一：
   - **认领**：README 补一节 work 模块（领域/迭代/需求/发布/任务），`welcome.body` 从"已迁入"改成产品主张；这会让定位从"Agent 工作台"变成"研发工作台，内含 Agent"。最省事，且符合代码现状（默认首屏是 Agent，但 38% 的代码在业务面）。
   - **降级**：把 work + records 标为可选模块（设置里默认隐藏），README 不动，Agent 成为唯一主线。
   - **拆出**：既然两个产品面零直接依赖，`work`/`records` + `data/repository` + 相关视图可以独立成一个应用/包，ToolCove 回归纯工具箱 + Agent。

   无论选哪个，**都应该先修 §2.6 的 i18n 缺口**——这是三个选项的共同前置条件。

9. `interviewBank*` 移入 `src/tools/interview/`（`interviewBankParts.js` 已是唯一装配点，移动零逻辑改动）。

---

## 五、落地状态（2026-10-12 复核）

本报告之后，问题清单里的 **1/2/3/5/6/7/8/9/10/11/12 已修**，只剩 4（根目录分区）待做。
过程与踩坑见 [ui-upgrade-progress-and-constraints.md](ui-upgrade-progress-and-constraints.md)。

| # | 问题 | 现状 |
|---|---|---|
| 1 | `json.js` 两份实现 | **已修**：删 `src/tools/json.js`，`JsonTool.vue` / `yaml.js` 改指 `src/json.js`，测试只留一份 |
| 2 | `tasks` 死键 | **已修**：`GlobalSearch.vue` 不再读 `tasks`，注释写明任务/工时的真实数据源是 `iterations` 的 `items→subtasks` |
| 3 | `tools ↔ agent` 环 | **已修**：`yaml.js` 上移到 `src/`，`agent/executors.js` 那条唯一的 `agent→tools` 边消失；`src/importBoundaries.test.js` 守边界 |
| 4 | 根目录 79 文件无分区 | **主体完成**：`ui/`（原子）、`tools/interview/`（题库孤岛）、`views/`（22 个界面）、`app/`（18 个外壳/框架）四块已立起来，564 行的 `shared.js` 拆成 `src/shared/` 下 8 个领域文件，**根目录非测试文件 79 → 47**。剩下的 47 个是工具纯逻辑 / 业务数据层 / AI 客户端层 / 工具箱注册表四族混住，2026-10-13 明确决定**暂不再切**：再分目录的收益只是"看着整齐"，代价是上百条 import 加一批按路径读源码的守卫。边界已由 `importBoundaries.test.js` 守住（agent↛tools、platform↛上层、tools↛views、ui↛上层、shared↛上层），分层不会因为下次改动悄悄失效。搬迁过程的踩坑见 [ui-upgrade-progress-and-constraints.md](ui-upgrade-progress-and-constraints.md) §七–§八 |
| 5 | work 模块零 i18n | **已修**：中英各补 741 键，六个视图 + 手机面板的硬编码中文清零；`src/i18nCoverage.test.js` 守「界面不许不走字典」 |
| 6 | 工时聚合两套实现 | **已修并发现更多**：实际是**四份**（桌面概览 / 任务页 / 手机概览 / 迭代进度），且两处已产生错值——概览跨天工时算错日、手机迭代进度恒 0%（按不存在的 `status` 字段判定）。现统一为 `collectDayLogs` + `sumHoursByDate` + `partitionDayLogs` + `iterationProgress`，守卫 `src/workDataSingleSource.test.js` |
| 7 | README 没写研发管理面 | **已修**：中英各加一节模块清单，并把定位句改成"工具箱即动作空间" |
| 8 | "工作台"一词两义 | **已修**：`nav.work` 改为「研发」/`Delivery`，「工作台」留给产品定位与 Agent 首屏；`welcome.body` 顺势改成真正的定位陈述（原来写的是"模块已全部迁入"这种过程话） |
| 9 | `Icon.vue` 住在应用层 | **已修**：`Icon.vue` / `ConfirmDialog.vue` / `confirm.js` / `dragsort.js` / `ToolErrorPanel.vue` 搬进 `src/ui/`，全仓 86 条 import 一起重算；`importBoundaries.test.js` 新增「`src/ui/**` 只依赖 vue、i18n 与彼此」，防止原子层又长回上层依赖 |
| 10 | `tasks.js` 名不副实 | **已修**：改名 `src/iterations.js`（导出符号本来就按迭代/需求/子任务命名，无需改），12 处注释与文档路径同步。文件头补齐真实枚举（旧注释写 `status: "plan"|"dev"|"done"` 是错的，实际 plan/dev/test/pending/live），并写明**需求只有 `done` 布尔、没有 status**——这正是手机端进度恒 0% 的根因 |
| 11 | 无 import 边界守卫 | **已修，但换了实现**：不在 eslint 做（`no-restricted-imports` 匹配的是写法字面量而非解析后路径，glob 要按目录深度枚举、分区后即失效），改由 `src/importBoundaries.test.js` 按真实路径判定 |
| 12 | `interviewBank*` 无自己的目录 | **已修**：24 个文件（含 20 个 `interviewBank*` 分片）搬进 `src/tools/interview/`，全仓引用与两处按路径读源码的测试同步更新；`src/tools/` 从 107 个文件降到 83 个 |

§四「第三步」的产品决策：选了**认领**——README 补齐研发管理面、`welcome.body` 改成产品主张。
代码现状支持这个选择（38% 的非测试代码在业务面），而它的前置条件（§2.6 的 i18n 缺口）已经清掉。

---

## 附：值得保留的做法（不要在这次重构里改掉）

- `src/data/repository.js` 的"单一读写入口 + 修订号 CAS + 冲突重放 + `data-changed` 广播"——它修掉的都是真实缺陷。
- `src/agent/catalog.js` 与 `src/agent/executors.js` 的"元数据 / 实现"分离：让首屏只读目录（启动交付脚本从 875 KB 降到 532 KB，见 `docs/perf-and-ux-baseline.md:36-38`），一致性由 `catalog.test.js` 双向强制。
- `src/navConfig.js` 把导航 + 旧 key 映射 + 迁移规则收成一个纯函数模块。
- `docs/` 里那几份"记录了什么试过但无效"的方案文档（`docs/perf-and-ux-baseline.md:47-51` 记录了"把 i18n 字典压成一行"对产物体积无效）、"踩过的坑"（`docs/perf-and-ux-baseline.md:40-45` 解释为什么不能把 `const cfg = await readSyncConfig()` 当死代码删）。
- `mobile/app/parity.test.js` 的机器比对思路——它比任何"对齐清单"文档都可靠。
- 所有 GitHub Actions 都 pin 到完整 commit SHA（`.github/workflows/*.yml`），发布密钥有明确的红线约定（`.gitignore:59-62`）。

---

*本报告未修改任何源码文件。*
