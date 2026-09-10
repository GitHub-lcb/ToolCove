# Agent 数据层与导航分层改造方案

日期：2026-09-10 · 状态：P0 已完成，P1 进行中 · 关联：`docs/agent-architecture.md`

## 1. 结论（TL;DR）

- **Agent 现在只是"工具箱调度器"**：24 个内置工具全部是通用能力（json/base64/file/db/网络/crypto/image），
  读不到应用自己的数据（领域/迭代/需求/问题/发布/速记/任务）。所以第一优先级是**加数据工具**，不是减模块。
- **模块不该删，该分层**：现有 10 个平级导航其实是三层——Agent（入口）｜数据模块（业务资产）｜工具箱（能力）。
  建议压成 **Agent / 项目 / 记录 / 工具箱 / 设置**，其中「项目」= 领域+迭代+需求大盘+发布+任务（Tab 切换），
  「记录」= 速记+问题。首页内容下沉为 Tab，导航项去掉。
- **顺带修一个实测缺陷**：云同步在应用内**完全空转**——`registerSyncSource` 全仓无调用，
  且引擎拿到的 `recordSources: []` 与 `engineRefs.sources` 不是同一个数组（详见 2.3）。
  它正好被"统一数据写入路径"这一步自然修掉。

## 2. 现状盘点（均已核对代码）

### 2.1 模块、键与记录结构

| 模块 | 持久化键 | 记录关键字段 | 保存路径 |
|---|---|---|---|
| 领域 `DomainView` | `domains` / `pools`（数组） | domain `{id,name,note,createdAt,updatedAt}`；pool `{id,domainId,name,note,path?,createdAt,updatedAt}` | 直接 `invoke`（`:70/:77`） |
| 迭代 `IterationView` | `iterations`（数组） | `{id,title,version,domainIds[],status:plan\|dev\|done,releaseDate,goal,items[],releaseId,liveAt,createdAt,updatedAt}`；item=需求 `{id,name,url,estimateDays,note,done,subtasks[],logs[],questions[],bugs[]}` | 直接 `invoke`（`:189`） |
| 需求大盘 `RequirementBoardView` | 同上 `iterations` | 只读/写同一数组 | 直接 `invoke`（`:39/:173`） |
| 问题 `ProblemView` | `problems`（数组） | `{id,title,type,status,tags[],note,logs[],images[],resolution,resolvedAt,createdAt,updatedAt}` | 直接 `invoke` + `enqueueSync(["problems"])`（`:71`） |
| 发布 `ReleaseView` | `release-pools`（对象 `{active[],archived[]}`） | `{id,name,codingProject,createdAt,updatedAt,archivedAt?,lastRelease{...}}`；并写 `pools`（`:346`） | `releasePools.js` 纯函数 + `invoke` |
| 速记 `SnippetView` | `snippets`（数组） | `{id,title,category,content,fields[],images[],pinned,createdAt,updatedAt}` | 直接 `invoke` + `enqueueSync(["snippets"])`（`:45`） |
| 任务 `TaskView` | 无独立键（读 `iterations`） | 另存 `reportPrefs` / `reports` | 直接 `invoke`（`:380/:387`） |
| 概览 `HomeView` | 只读 `iterations`/`problems`/`snippets`/`settings` | — | 直接 `invoke`（`:21-24`） |
| 工具箱 | `toolbox-<key>`（`{v:value}`） | — | `toolboxStore.js` / `secureToolbox.js` |

- `id` 统一 `crypto.randomUUID()`；`updatedAt` 为 **数值** `Date.now()`（同步引擎按数值比较）。
- 既有纯 JS 数据模块：`tasks.js`（迭代/需求/子任务增删改 + `iterationHours`）、`snippets.js`、`releasePools.js`、
  `publishState.js`、`requirementMetrics.js`、`migrate.js`。**没有统一的仓储层**，视图各自 `invoke`。
- 已接云同步的只有 `problems` 与 `snippets` 两处 `enqueueSync`。

### 2.2 Agent 工具现状

- `src/agent/builtins.js:19-41` 共 24 个工具，`toolKey` 11 个取值（convert/crypto/db/diff/file/generator/image/json/network/request/time），
  **无任何业务数据读写**。
- 确认策略：`runtime.js:107-117` 按 risk 决定（read/transform 免确认，write/database 在默认 `risky` 下弹确认），
  无"单个工具强制确认"能力。
- 审计：`session.js` 的 `agentRuns`（上限 30）+ `runStore.js` 脱敏落盘；业务数据侧无审计。

### 2.3 实测发现的问题（建议一并修）

1. **[P0] 云同步空转**：`registerSyncSource`（`sync/index.js:128`）全仓无调用；且 `sync/index.js:99` 传给引擎的是
   字面量 `recordSources: []`，`engineRefs.sources` 是另一个数组，即使调用注册函数引擎也读不到。
   结果：`enqueue([])` → `dirty` 为空 → 不调度；`pullOnce` 的逐源合并同样遍历空数组（`engine.js:264-271`）。
   **推和拉都不落数据**，只有状态机与 UI 在跑。
2. **[P1] 死键 `tasks`**：`GlobalSearch.vue:29` 读 `tasks` 键（期望 `{id,title,code}`），全仓无写入（任务实际在 `iterations` 里）。
   搜索的"任务"分组永远为空。
3. **[P1] 同一数组多写者**：`iterations` 被迭代/需求大盘/任务/概览四个视图读写，各自"整表覆盖"，
   后写覆盖先写的窗口天然存在；Agent 一旦写入会放大。

## 3. 目标结构

```text
入口层     Agent 工作台（默认首屏，Ctrl+1） ＋ 全局搜索（Ctrl+K）
资产层     项目（领域 | 迭代 | 需求大盘 | 发布 | 任务）   记录（速记 | 问题）
能力层     工具箱（12 工具；浏览器端过滤为 9）
系统       设置（AI / 赞助 / 系统设置；桌面端含同步、备份、更新）
横切       Agent 数据工具（读写资产层）＋ 云同步（只同步 速记/问题）
```

## 4. 第一期：数据访问层 + Agent 数据工具

### 4.1 数据访问层 `src/data/repository.js`（新）

唯一读写业务数据的地方，视图与 Agent 工具共用；纯逻辑（不依赖 Vue），可单测。

```js
export const KINDS = Object.freeze({
  snippets:   { key: "snippets",      shape: "array",  sync: true  },
  problems:   { key: "problems",      shape: "array",  sync: true  },
  iterations: { key: "iterations",    shape: "array",  sync: false },
  domains:    { key: "domains",       shape: "array",  sync: false },
  pools:      { key: "pools",         shape: "array",  sync: false },
  releases:   { key: "release-pools", shape: "object", sync: false },
});

list(kind, { keyword, tag, status, ids, limit = 20 })  // 只读，带内存缓存（TTL 1s）
get(kind, id)
create(kind, draft)        // 补 id/createdAt/updatedAt，校验必填，落盘
update(kind, id, patch)    // 拒绝改 id/createdAt；自动刷 updatedAt；写前 load 最新（避免覆盖他人）
remove(kind, id)           // 硬删 + 写墓碑（sync:true 的 kind）→ 跨端删除可传播
mutate(kind, fn)           // load→fn→save，供视图整表写入使用（修 2.3-3）
```

- 落盘仍走 `invoke("load_data"/"save_data")`（桌面）／IndexedDB（浏览器，已由平台层抹平）。
- 每次成功写：`window.dispatchEvent(new CustomEvent("data-changed", { detail: { kind, ids } }))` +
  `enqueueSync([kind])`（sync 内部自行判断桌面/启用）。
- 墓碑：`sync/index.js` 增补导出 `markTombstone(kind, id, ts)`（写 `sync-tombstones`），`remove` 调用它。
- 缓存策略：读缓存仅在同一次 Agent 运行内复用（工具连续读不重复落盘），写后立即失效。

### 4.2 Agent 数据工具（新文件 `src/agent/dataTools.js`）

| 工具 | risk | 确认 | 参数 | 返回 |
|---|---|---|---|---|
| `data.query` | read | 免 | `{kind, keyword?, tag?, status?, ids?, limit≤50}` | `{total, items[]}`，`content/note` 截断 400 字符 |
| `data.get` | read | 免 | `{kind, id}` | 完整记录 |
| `data.create` | write | 按策略 | `{kind, draft}` | 新记录 |
| `data.update` | write | 按策略 | `{kind, id, patch}` | 更新后记录 |
| `data.remove` | write | **always** | `{kind, id}` | `{removed:true}` |

- 5 个工具覆盖 6 个 kind，避免工具爆炸；`kind` 用 enum 约束，返回里带 `{kind, id}` 便于 UI 后续"打开"。
- 必填字段（`create` 校验）：snippets→`title`；problems→`title`；domains→`name`；pools→`domainId`+`name`；
  iterations→`title`+`version`；releases→`name`。
- 可改字段白名单（`update`）：snippets→title/category/content/pinned；problems→title/type/status/tags/note/resolution；
  iterations→title/version/status/releaseDate/goal/domainIds；domains→name/note；pools→name/note/path；releases→name/codingProject。
- **超 token 保护**：单次返回 ≤50 条、单字段 ≤400 字符，超出部分给 `truncated: true`。
- 注册：`buildAgentRegistry` 在 `createBuiltinRegistry()` 之外并入 `createDataTools()`，同样受 `disabledTools` 与平台过滤约束。
- 二期候选（先不做）：`report.hours`（工时统计，复用 `tasks.js:iterationHours`）。

**实现状态（2026-09-10）**

- 数据层 `src/data/repository.js` 与只读工具 `src/agent/dataTools.js`（`data.query` / `data.get`）均已落地；
  工具名全集收敛到 `tools.js` 的 `AGENT_TOOL_NAMES`（含数据工具），`config.js` 与 `settingsConfig.normalizeAgent` 共用同一份，
  能力面板（`AgentView.vue` 风险分组）自动出现这两个工具。`builtins.js` 不再自导 `AGENT_TOOL_NAMES`，避免两份真相。
- 与 4.2 表格的两处细化：`query` 的返回摘要把对象数组（`items`/`logs` 等）降级为 `<field>Count`（详情走 `data.get`），
  字符串数组（`tags`）保留前 20 项；`data.get` 正常体量下无损返回，仅当整条序列化超过 24000 字符才降级
  （字段 8000、数组 50、深度 3，标记 `truncated`）——否则会撞上 runtime 的 32000 结果上限直接失败。
- 测试：`src/agent/dataTools.test.js`（12 用例），含用确定性规划器跑通验收口径「我有几个未完成的线上问题」「最近三条速记是什么」。
  全量 772 用例绿；`vite build` 与 `build:web` 均通过。

### 4.3 确认策略扩展（runtime 小改）· ✅ 已完成（2026-09-10）

`runtime.js:111` 改为：`tool.confirm === 'always'` 直接需要确认（不受 `requireConfirmation: never` 影响），
其余逻辑不变。配套：`settingsConfig` 的能力矩阵把 5 个数据工具纳入开关；`agent-architecture.md` 补一行说明。

**实现状态**

- 门禁写成三级：`tool.confirm === 'always'` → 必确认；`requireConfirmation` ∈ {always, never} 直接决定；
  否则按 `risk !== 'read'` 判定。`data.remove` 声明 `confirm: 'always'`，用户在设置里选「永不确认」也不放行删除。
- 能力矩阵：`settingsConfig` 的 `names` 来自 `tools.js` 的 `AGENT_TOOL_NAMES`（单一真相源），
  5 个数据工具自动进入停用清单与能力面板，无需单独登记。
- 用例：`dataTools.test.js` 的「确认策略」describe 覆盖 always 覆盖 never（拒绝则记录保留、批准则删除 +
  墓碑）、普通写工具不弹确认。
- `docs/agent-architecture.md` 已加「删除确认」小节说明。

### 4.4 视图并发与一致性 · ✅ 已完成（2026-09-10）

- 视图监听 `data-changed`：`kind` 命中且本地无未保存编辑时重新加载；有编辑时只显示"数据已被 Agent 更新"提示（不打断输入）。
- 视图的整表写入迁移到 `repository.mutate`（先收敛 `iterations`：迭代/需求大盘/任务三处），
  消除"后写覆盖先写"（2.3-3）。
- Agent 写操作在时间线里已有确认卡片与结果记录，作为审计；本期不新增业务审计表。

**实现状态**

- 五个视图全部迁移：`SnippetView`（记录级 create/update/remove/restore）、`ProblemView`（整表 mutate +
  mergeRecords，删除走记录级 remove/restore）、`IterationView`（快照 mergeRecords）、`RequirementBoardView`
  （对 fresh 的读改写，直接 push 新需求）、`TaskView`（对 fresh 的变换：子任务增删改与"新建迭代+需求+子任务"
  一次落盘，新对象在变换外生成保证重放幂等）。
- 订阅口径统一：`source === 'view'` 跳过（同窗口自身写入已就地处理；跨视图切换会重新挂载并加载），
  其余来源命中 kind 时：无未保存编辑 → `load()`；有编辑 → toast（速记 / 问题用 i18n 词条
  `snippet.updatedExternally` / `problem.updatedExternally`，迭代 / 需求大盘 / 任务页为中文提示）。
- **期间发现并修复 1 个真实缺陷（有回归用例）**：`tasks.js` 的 `updatedAt` 写 ISO 字符串，视图写 `Date.now()` 数字，
  而 `mergeRecords` 用 `Number(updatedAt) || 0` 比较 → `Number(ISO)` = NaN → 0，任务页刚写的内容会被迭代页的
  整表写回判成"更旧"而丢掉（反向同理）。修复：`repository.tsOf()` 归一化两种写法（数字优先，否则 `Date.parse`），
  `mergeRecords` 与 `list()` 排序共用。
- 新增用例（`repository.test.js` 的「iterations 三写者收敛」）：①任务页形态对 fresh 变换遇上并发写者，
  CAS 冲突重放后两边改动都在；②迭代页形态整表写回不抹掉磁盘上其他写者新增的迭代；③快照更旧时磁盘改动不被回退
  （ISO 与数字时间戳可比）。已做反向验证：把 `tsOf` 换回 `Number()` 时第 ③ 条立即红。
- 边界：`DomainView`（domains/pools）与 `ReleaseView`（release-pools 对象、pools）仍是直接 `invoke` 整表写，
  不在本期 §6 影响面内；`release-pools` 是对象型 kind，写回需要增量语义（而非整对象覆盖），留待后续期次。
- **浏览器实测又发现并修复 2 个缺陷（均有回归用例）**：①保存速记时报 `DataCloneError`——Vue 响应式代理直接进
  IndexedDB 会被结构化克隆拒绝；两层修复（`platform/invoke.js` 的 `plainValue()` 归一化落盘载荷、
  `repository.mutate` 落盘前 `cloneData`），`invoke.test.js` 与 `repository.test.js` 各留一条代理载荷用例。
  ②Agent 写入未知枚举值（实测 `type: '线上'`）后问题页整页停止渲染（模板 `TYPES[p.type].cls` 直接索引）——
  写入边界加 `checkEnums`（`dataTools.js`，`KIND_META.enums` 与视图取值表同源），渲染侧加回退
  （`ProblemView.typeMeta`、`IterationView.statusMeta`、`HomeView` 标签兜底），老数据/外部数据不再能打崩界面。

### 4.5 云同步接线修复（并入本期）· ✅ 已完成（2026-09-10）

**实际实现（对 4.5 原文的偏离与理由）**

- 原文要求 `SnippetView` / `ProblemView` 挂载时 `registerSyncSource(...)`。实现改为**仓储层持有数据源**：
  `sync/index.js` 的 `sourceProvider` 直接读取 `repository` 的 kind 镜像（`refreshSources()` 先拉最新镜像，
  推送前刷新），视图不需要注册任何东西。理由：视图未挂载时同步也应工作（例如只开了 Agent 工作台），
  且与 P1 的 repository 单写入口径一致；原方案"视图注册"会在未打开对应视图时静默丢同步。
- `enqueueSync(kinds)` 现在 = 刷新镜像 → `enqueue(records)` → `requestSync()`（墓碑也走这条）。

**期间实测发现并修复的 6 个缺陷**（全部有测试覆盖）

1. `getConfig` 传的是 async 函数，引擎按同步契约读取 → `status` 恒为 `disabled`，同步整体空转。
   修复：`getConfig: () => configCache`（进程内快照，写入路径同步维护）。
2. `getEngine()` 无并发保护：repository 的 fire-and-forget 与调用方各建一个引擎 → 双引擎、状态错乱。
   修复：`enginePromise` 单飞 + `buildEngine()` 拆分。
3. 删除不传播：删光记录后 `dirty` 为空 → 永不调度 → 墓碑不上云。修复：引擎新增 `requestSync()`。
4. 配对/加入集合后引擎状态卡在 `disabled` 到进程重启。修复：引擎新增 `refreshEnabled()`，`writeSyncConfig` 在写入后调用。
5. 信封不带类别 → 拉取时所有条目并入每个 source（速记落进问题）。修复：信封加密载荷增加 `kind` 字段
   （`makeEnvelope` 第 4 参、`normalizeEnvelope` 透出、引擎推送打标/接收按 kind 过滤；旧格式无 kind 时用本地记录反查归属，查不到则跳过）。
6. `runSync` 用 `busy` 直接 return：防抖运行中手动「立即同步」变空转且拿到旧结果。修复：改为 `runPromise` 并发合并，
   重复调用共享同一次运行（此缺陷此前让 `engine.test.js` 在全量跑时概率性红）。

**测试（新增 2 个文件）**

- `src/sync/wiring.test.js`：装配级双设备（内存版服务端），4 个阶段 = 4 次"应用启动"（`vi.resetModules`），
  覆盖 A 创建→防抖自动推送（校验服务端密文不含明文）→ B 拉取落地 → A 删除→墓碑上云 → B 同步删除且收敛稳定。
  注意点已固化为注释：WebCrypto 不吃假时钟，`settle` 需在 fake timers 之前抓住真 `setTimeout` 让出真实宏任务。
- `src/sync/realServer.test.js`：真实 `server/sync-server.js`（`127.0.0.1` 随机端口 + 真实配对/PBKDF2/WebCrypto），
  直接读服务端磁盘文件校验密文与墓碑，全流程 0.9s。

**验收状态**

- ✅ vitest 全绿：59 文件 / 760 用例（连跑两遍稳定；修复缺陷 6 之前 `engine.test.js` 有 flake）。
- ⏳ 待人工：双端真实桌面 UI 互见（需两台桌面安装实例，浏览器端 cloudSync 关闭；清单见提交说明）。

## 5. 第二期：导航分层

### 5.1 新导航（4 项 + 设置）

| 顺序 | key | 内容 | 快捷键 |
|---|---|---|---|
| 1 | `agent` | Agent 工作台 | Ctrl+1 |
| 2 | `work` | Tab：概览 / 领域 / 迭代 / 需求大盘 / 发布 / 任务 | Ctrl+2 |
| 3 | `records` | Tab：速记 / 问题 | Ctrl+3 |
| 4 | `toolbox` | 工具箱 | Ctrl+4 |
| — | `settings` | 设置（不进导航列表，沿用 `openSettings(section)`） | Ctrl+5 |

- 实现：新增一个 `ModuleTabs` 外壳（仅切换 Tab 并透传 `show-toast`/`jump-id`/`@navigate`），
  各视图组件内部零改动，`:key="activeModule + tab"` 决定是否重挂载；Tab 状态记在 `App.vue`（不入 settings）。
- 旧 key 映射（供深链与设置迁移）：`domain|iteration|requirement|release|task → work:<同名 tab>`，`snippet|problem → records:<同名 tab>`。

### 5.2 首页（HomeView）处置

- **M1（推荐）**：拆成两个小组件——"迭代进度 / 待产品确认"进 `work` 的首 Tab「概览」，"最新速记"进 `records` 首 Tab 速记顶部；
  "快捷入口"卡片删除（与 Agent 首屏 + 工具箱重复）。
- **M2（保守）**：HomeView 原样保留，只做导航合并，`work` 首 Tab 嵌入整个 HomeView。
- 取舍点：M1 更干净但要拆分 611 行的视图；M2 一天内可完成。建议 M1，M2 作为回退。

### 5.3 兼容性三件事

1. **快捷键重排**：旧编号（Ctrl+2=首页…Ctrl+0=工具箱）无法与新的 4 项共存，采用新编号；`Ctrl+0` 保留为"工具箱"。
   变更写进 Release Notes。可选：Tab 内用 Alt+1..6 直切。
2. **深链与搜索**：`GlobalSearch` 结果改为 `{module:'work'|'records', tab, id}`；`App.onGlobalNavigate` 负责 set tab + jump。
   `AgentView` 的 `navigate` 降级目标（`module:"toolbox"`）不变。
3. **hiddenModules 迁移**：`normalizeHiddenModules` 只认已知 key，旧值会被丢弃 → 在 `migrate.js` 加一步映射
   （`setting.ui.hiddenModules` 旧 key → 新 key，去重保序），并在 `settingsConfig` 里更新 `NAV_MODULE_OPTIONS` 为新的 4 项。

### 5.4 i18n 与测试

- 新增 `nav.work` / `nav.records` / Tab 标签键；zh-CN 与 en-US 同步（`i18n.test.js` 强制对齐）。
  **偏差**：`module.workDesc` / `module.recordsDesc` 未加——模块描述（`descKey`）自 UI 2.0 起无渲染点，加了也是死键；
  若将来导航项要展示副标题再补。
- 补纯函数测试：key 映射表（旧→新）、`hiddenModules` 迁移、Tab 状态解析。
- 现状：MODULES / `onKeydown` / `onGlobalNavigate` / jumpId 均无测试覆盖——本期至少补映射与迁移两份单测。

**P3 实现状态（已完成）**

- 新增 `src/navConfig.js`(+`navConfig.test.js` 9 用例)：`NAV_MODULES` / `MODULE_TABS` / `MODULE_HOME_TAB` /
  `LEGACY_VIEW_TARGET` / `resolveNavTarget` / `migrateHiddenModulesV1`——App、SettingsView、migrate、
  GlobalSearch 共用一份真相（SettingsView 里原先复制的十项列表已删）。
- `HomeView.vue` 改名拆分为 `WorkOverviewView.vue`（work 首 Tab）：落地 M1 但**不拆两个组件**——
  「迭代进度 / 待产品确认」留在概览，「最新速记」卡片直接删除（SnippetView 默认即按 `pinned → updatedAt`
  倒序，概览展示前三条与进「速记」Tab 首屏完全重复），「快捷入口」卡片删除。
- `ModuleTabs.vue`：Tab 外壳；内层 `<component :key="active">`，跨模块 `:key="activeModule"`，与既有
  「切模块即重载」行为一致。Tab 状态存 `App.vue` 的 `moduleTabs`（不入 settings，不开机记忆）。
- 快捷键：Ctrl+1 Agent / Ctrl+2 工作台 / Ctrl+3 记录 / Ctrl+4 工具箱 / Ctrl+5 设置 / Ctrl+0 工具箱（旧习惯保留）。
  **发布时需写入 Release Notes**（仓库内无 changelog 文件，随 GitHub Release 说明发布）。
- hiddenModules 迁移：`migrate.js` v7→v8（`SCHEMA_VERSION = 8`），旧视 key 经 `LEGACY_VIEW_TARGET` 归并到模块后去重保序，
  无法识别的历史脏值丢弃；语义为「旧隐藏的视图 → 隐藏其所在模块」（模块级隐藏是本期设置项的粒度）。
- 顺带修复：`AgentView` 的 `inject("openSettings")` 此前从未被 provide（`emit navigate{module:'settings'}` 落到空处），
  本期在 App 补上。
- 浏览器实测：4 导航项 + 设置；工作台 6 Tab / 记录 2 Tab 逐个挂载正确组件；Ctrl+1..5/0 全对；
  深链（搜索速记→记录/速记+行高亮、问题→记录/问题+展开、迭代→工作台/迭代+选中）跨模块与同模块切 Tab 两径均达；
  v7→v8 迁移实测 `["snippet","domain","toolbox","bogus","snippet"]` → `["records","work","toolbox"]` 且侧栏只余 Agent。
- 全量 800 用例（61 文件）全绿；`vite build` 与 `build:web` 双端构建通过。

## 6. 影响面（文件级）

| 区域 | 文件 |
|---|---|
| 新增 | `src/data/repository.js`(+test)、`src/agent/dataTools.js`(+test)、`src/ModuleTabs.vue` |
| 修改 | `src/agent/tools.js`（并入数据工具）、`src/agent/runtime.js`（confirm:always）、`src/sync/index.js`（sourceProvider + markTombstone）、`src/agent/session.js`（无需改） |
| 视图 | `SnippetView` / `ProblemView`（注册同步源 + data-changed）、`IterationView` / `RequirementBoardView` / `TaskView`（mutate）、`HomeView`（拆分或嵌入）、`App.vue`（MODULES/快捷键/跳转）、`GlobalSearch.vue`（module+tab） |
| 配置/字典 | `src/settingsConfig.js`、`src/migrate.js`、`src/i18n/{zh-CN,en-US}.json`、`docs/agent-architecture.md` |

## 7. 分期与验收

| 期 | 内容 | 验收标准 | 状态 |
|---|---|---|---|
| P0 | 云同步接线修复（4.5） | 双端真实 UI 编辑可互见；删除可传播；vitest 全绿 | ✅ 已完成（760 用例全绿 + 双设备自动化测试；双端真实 UI 待人工验证） |
| P1 | 数据层 + 只读工具（`data.query`/`data.get`） | Agent 能答"我有几个未完成的线上问题""最近三条速记是什么"；返回截断生效 | ✅ 已完成（772 用例全绿；验收由确定性规划器用例覆盖；真实模型下的回答待人工试跑） |
| P2 | 写工具 + 强制确认 + 视图 mutate 收敛 + data-changed | Agent 建速记/改问题状态后界面自动刷新；删除必弹确认；`iterations` 三处写入不再互相覆盖 | ✅ 已完成（791 用例全绿；三写者收敛由 `repository.test.js` 新增 4 用例覆盖并做过反向验证；`data.remove` 强确认与枚举校验由 `dataTools.test.js` 覆盖；「Agent 建速记后界面自动刷新」已在浏览器实测（无刷新出现新速记）；双端手工互见仍待人工验证） |
| P3 | 导航分层 + 首页处置 + 快捷键/深链/hiddenModules 迁移 | 导航 4 项 + 设置；深链定位到 Tab+条目；旧隐藏配置迁移后语义不变 | ✅ 已完成（800 用例全绿；双端构建通过；浏览器实测导航/Tab/快捷键/深链/hiddenModules 迁移全部达，详见 §5.4；桌面端人工复验清单见提交说明） |

每期独立可发布；P0/P1 建议合成一次提交，P3 单独一次（改动面大、可回滚）。

## 8. 风险与回滚

- **视图与 Agent 双写**：靠 `data-changed` + `mutate` 收敛；若出现丢失编辑的反馈，回退方案是"Agent 写操作后强制重新加载视图并提示"。
- **导航重构打断肌肉记忆**：快捷键变更不可逆（无兼容层），如担心可先发 P3 的一版"只加 Tab、不改编号"的中间态。
- **数据层迁移引入新 bug**：`repository` 上线时保留"直连 invoke"的旧路径一版（视图逐个迁移，不做大爆炸），出问题可单视图回退。

## 9. 本期不做（边界）

- 多智能体、MCP、定时任务（沿用 `agent-architecture.md` 的待办）。
- 浏览器端云同步（等服务端开 CORS）。
- 业务数据审计表、Agent 写操作的二次确认流水（当前以时间线 + runStore 为准）。
