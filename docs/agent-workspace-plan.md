# ToolCove Agent 工作台方案：同源双版

日期：2026-10-14 · 状态：待评审 · 前置：工具契约化改造已完成（`feat: Agent 产品化改造规划`）

---

## 结论速览

1. **双目标**：个人 Agent 工作台 + 可企业级部署的 Agent 工作台，同一份代码，靠契约的 `scope` 字段投影出两个版本，不 fork。
2. **原创主张**：不做"你雇来的工程师"（Qoder 范式），做"跟你过日子的管家"——Agent 先开口（今日简报）、入口散在数据旁、手动用工具即教 Agent、记忆可打理。
3. **灯塔场景全用已有件**：周五自动周报（迭代/需求/发布数据 → 周报草稿 → 人确认 → 归档速记），零新数据模型，验证"Agent 懂你们公司的数据"。
4. **节奏三期**：一期地基与体感（scope 投影 + Agent 三栏）→ 二期企业 MVP（远端数据后端 + 周报闭环）→ 三期管理面（成员/权限/审计/团队知识）。

## 决策记录（2026-10-14 拍板）

| # | 决策点 | 结论 | 排除项 |
|---|---|---|---|
| 1 | 企业部署形态 | **桌面客户端连企业服务器**（Tauri 优先） | 浏览器门户（browserHandlers 保留为后备，不投入） |
| 2 | 企业版灯塔场景 | **用已有功能闭环**（研发管理 + 周报自动化） | 任何需要新数据模型的场景 |
| 3 | 双版节奏 | **并行**：`scope` 现在进契约 | 个人版先行后补 scope（后补要再碰一遍 27 个契约） |

## 定位陈述

- **个人版是"懂你的管家"**：本地优先、无账号、Agent 知道你这周干了什么（work/records 数据在身体里）。
- **企业版是"懂你们公司的员工"**：桌面端连企业服务器，数据留在公司，统一模型网关，审计留痕。
- **共同卖点**：数据主权 + Agent 记忆力——通用聊天 Agent 给不了的两样东西。
- **商业化单元**：个人版免费 + Pro 订阅（云同步/模型额度/高级工具）；企业版按席位 + 私有化部署 License，管理面/审计/团队知识引擎企业独占。

## 架构层改造

### 契约加 `scope`（决策 3 的落点）

- `src/contracts/<key>.js` 每个契约新增 `scope: "personal" | "enterprise" | "both"`，默认 `both`。
- 初版标 `personal` 的工具：rail（铁路大亨）、interview（面试刷题）、checkin（自动签到）、photo（照片存档）、label（标签打印，待议）、game 分类下其余工具。
- 动作级也可标 `scope`（企业版未来加审计类动作时直接用），初版只在工具级标注。
- `contracts.test.js` 准入规则加一条：`scope` 必填且枚举合法。

### 投影加版本过滤

- `platform/env.js` 增加 edition 判定：`isEnterprise = !!企业服务器配置`（配置落 settings，二期做配置界面；一期先留常量开关与测试钩子）。
- `toolboxTools.js` 的 `visibleToolboxTools` 从「只按平台过滤」升级为「平台 × 版本」双过滤，与现有 `desktopOnly` 机制同构。
- Agent 目录同理：`catalog.js` 投影时按版本过滤动作，保证企业版 Agent 看不到游戏类工具。

### 数据远端后端（决策 1 的落点，二期实施）

- invoke 数据桥（`load_data/save_data`）已抽象，新增「企业服务器」实现：HTTP API + token 鉴权。
- 上层（work/records/Agent）零改动——数据边界在桥层切换。
- 企业版会话/任务数据同样落服务器，为三期审计做准备。

## 界面骨架

```
┌──────────────────────────────────────────────────────────────────┐
│ 侧边栏（可折叠，默认展开）│ 中央区域                    │ 右侧（条件出现）│
│ [+ 新任务]              │  对话 / 运行消息流           │ 任务监控        │
│ ── 工作面 ──            │   ├ 你：目标（消息流首条）    │（运行 / 待确认 │
│  ▣ 研发 / 记录 / 工具箱  │   ├ 工具卡（折叠）           │  / 有产物时出现）│
│  🔍 搜索历史             │   ├ 最终回答                 │ 目标·执行活动   │
│ ┌ 会话列表（唯一滚动区）┐│   └ 交付清单                 │ 产物·指路       │
│ │ ── 进行中 ──         ││  ──────────────────        │               │
│ │ ── 今天/昨天/7天/更早 ─││  输入框（钉在底部）          │               │
│ │ ● 会话行（状态灯+主题）││  [域▾][目标][运行]          │               │
│ └──────────────────────┘│                            │               │
│ [♥ 赞助][⚙ 设置][« 收起] │                            │               │
└──────────────────────────────────────────────────────────────────┘
```

**骨架的四条硬约束**（三期修订时逐条对齐过，改动前请先读）：

1. **输入框钉在对话列底部**。它是这一屏唯一的操作面，不随消息流滚走。二期曾把它放在
   页面中部、空态标语落在它**下面**——新用户自上而下读到的是「输入框 → 说一件事」，
   顺序是反的。
2. **右栏条件出现**。三期的取舍是：工具开关是**配置**，不是对话的家具——常驻会占掉
   四分之一宽度，并把一个一次性问题绑在每一轮对话上。因此工具目录 / 技能库 / 溢出清理
   搬进「设置 → Agent」，右栏只留运行时才有意义的东西（目标 / 实时进度 / 产物）。
3. **侧边栏默认展开并记住收起状态**。默认折成图标栏等于把历史与工作面藏起来。
4. **侧边栏里只有会话列表滚动**，固定入口（新任务 / 工作面 / 搜索 / 底部按钮）一律不参与。
   反例是实测踩到的：整条侧边栏共用一个滚动容器时，历史一长，「新任务」和搜索框被滚出
   视野、工作面被挤到底部——能看见什么取决于你滚到哪。这条由
   `e2e/specs/29-sidebar-fixed-zones.spec.js` 守着（断言滚动前后固定区 y 坐标不变、
   且 `.nav` 容器本身 `scrollHeight === clientHeight`）。

参考实现（结论来源）：Qoder 桌面端（侧边栏 = 新任务 → 扩展 → **带搜索的历史在下半部分**
→ 账号钉底；中央 = 空态 + 消息流 + **底部**输入框；右侧 = 仅执行期出现的任务监控，
且可设为浮动）、VS Code Chat view（sessions / 对话 / 输入三段式）、
Claude Desktop（工具调用折叠成摘要）、OpenHands（活动指示放进 composer）。


三种界面角色（命名沿用并修正 [toolcove-positioning-and-module-review.md](toolcove-positioning-and-module-review.md) 指出的"工作台"一词二义问题）：

| 角色 | 界面 | 人机关系 |
|---|---|---|
| **任务面**（默认首屏） | 任务列表 + 对话 + 监控 | 人指挥 Agent：定义目标、过门禁、验收产物 |
| **工作面** | work / records 管理界面 | 人自己干活的地方，也是 Agent 的取数记忆 |
| **手动面** | 工具箱画廊 + ToolWindow | Agent 的 41 只手，人也可直接操作，产物双向流转 |
| **管理面**（企业版，三期） | 成员/权限/审计/知识引擎 | 企业管理员驾驭 Agent 的边界 |

四个核心机制：

1. **任务即执行单元**：goal → 计划 → 风险门禁 → 产物 → Summary，每步结构化留痕（session.js 已有 run/steps，补 Summary）。
2. **产物双向流转**：产物卡「在工具中打开」→ ToolWindow 按契约 inputSchema 预填参数继续加工；工具里也可"就地问 Agent"。
3. **Summary 交付清单**：run 末尾自动生成（做了什么/产出了什么/遗留什么）。
4. **首屏分版叙事**：个人版 = 今日简报（Agent 先开口：迭代进度/卡住的需求/快到的发布/昨晚跑完的事）；企业版 = 任务面。

手机端不动，保持工具优先（移动场景是"快速用一下"）；契约层已保证两端能力同源，布局分端是合法差异。

## 灯塔场景：周五自动周报（决策 2 的落点）

```
Agent 汇总本周迭代/需求/发布数据（已有 BUSINESS_ACTIONS）
  → 生成周报草稿（已有 weeklyReport.js）
  → 人确认/修改（风险门禁复用）
  → 归档速记（已有 records）
```

- 零新数据模型，全是已有能力的串联；要新增的只有「定时触发」与「周报模板」两个小件。
- 验证的卖点：每个研发周五花约一小时拼周报，现在一键。
- 企业版里这条链路的数据来自企业服务器（二期远端后端接通后自然成立）。

## 实施状态（2026-10-14，三期后追加「布局修订」）

### 布局修订（2026-10-15）：把二期改坏的两处骨架修回来

二期的导航重构方向（会话列表上移侧边栏、工作面分组）是对的，但落地的形态偏离了本文件
「界面骨架」一节定下的三条约束。修订内容：

- **侧边栏**（`app/App.vue` + `app/AgentSidePanel.vue` + `app/taskListItems.js`）：
  - 「新任务」从渐变主按钮改回**导航行**。它是"去哪里"，不是"现在执行"；两处都做 CTA
    会互相抢视觉权重，且停在 agent 主区时它还常亮，读起来像「新任务被选中」。
  - 历史加**搜索**（匹配标题与目标全文）与**按时间分组**（进行中 / 今天 / 昨天 /
    最近 7 天 / 更早）。二期是一条无差别的倒序长列表，20 条原始目标平铺，找不回任何一条。
  - 行内显示**主题**而不是原始目标（`conversationTitle`：压空白 + 在断句处截断，
    而不是硬切出半句话）。
  - **分层：只有会话列表滚动**（用户实测反馈后补的第 4 条硬约束）。顺序改为
    新任务 → 工作面 → 搜索 → 历史（滚动）→ 底部，工作面提到会话列表之上，
    与 Qoder 桌面端一致；滚动区由 `AgentSidePanel` 的 `.history` 独占，
    `.nav` 不再 `overflow`。守它的用例：`e2e/specs/29-sidebar-fixed-zones.spec.js`。
  - 默认**展开**，收起状态落 `localStorage`（`app/theme.js` 的 `getSidebarCollapsed`）——
    必须首帧同步可读，否则每次启动都会先按展开画一遍再收起，闪一下。宽度 224 → 268px。
- **对话主区**（`views/AgentView.vue`）：
  - 输入框从页面中部移到**对话列底部**（`.composer`），与消息流分离；空态与首启说明
    移到输入框**上方**（二期恰好相反）。
  - 用户的目标作为**消息流首条**渲染（`.msg-user`）。二期主区只有 Agent 的步骤时间线，
    自己的话不出现在流里，于是它读起来像运行监视器而不是对话。
  - 实时进度条（`RunProgress`）从表头移到输入框上方——进度讲的是「我正在做什么」，
    该挨着用户下一步动作。
  - 右栏「能力清单」**撤掉常驻**，改为条件出现的**任务监控**（运行 / 待确认 / 有产物时
    才占位；顶栏按钮可手动收起）。宽度 340 → 320px，用 `:has()` 让列在有面板时才存在。
- **工具目录搬家**（`views/SettingsView.vue` + `agent/capabilities.js`）：工具开关 / 技能库 /
  溢出清理落进新增的「设置 → Agent」分节，即改即存（不走页面底部的保存按钮，避免表单快照
  覆盖 agent 分组）。顺手修掉两个既有缺陷：`agent.capSettingsHint` 的文案一直指向这个
  不存在的分节；主区「设置」按钮调用的 `goSettings('agent')` 因分节缺失而静默落到 general。
  风险色/词条映射抽到 `agent/capabilities.js`，两处共用同一套语义。

**为什么以 Qoder 桌面端为主要参照**：它是与本产品形态最接近的独立 agent 桌面端
（而非 IDE 插件），且把「哪些东西该常驻、哪些该条件出现」写得很明确——任务监控仅执行期
出现、可停靠可浮动，设置里能整体关掉；历史是「一次对话 = 一个任务」，而不是一次运行一行。

- **一期：已完成。** 契约 `scope` 标注（5 个 personal / 22 个 both）+ `env.js` 版本判定
  （`currentEdition()` / `isEnterprise()` / `inEdition()`，测试钩子 `__TOOLCOVE_EDITION__`）
  + 画廊与 Agent 注册表的「平台 × 版本」双过滤（`editionGating.test.js`）；
  AgentView 三栏化（左栏会话列表：搜索 / 进行中脉冲灯 / 最新在前）；产物「在工具中打开」
  （`agent/artifacts.js` 识别产物 + `app/toolPrefill.js` 跨窗口一次性交接 + `PdfTool.vue` 消费）；
  Summary 交付清单（纯派生 `runSummary`，不改引擎）。
- **二期：已完成。** 导航重构（侧边栏主体 = 新任务 + 任务列表 `AgentSidePanel.vue`、
  「工作面」分组收拢 work/records/toolbox、跨模块后台任务监控条、AgentView 历史任务回看
  `viewRunId`、schema v9 迁移使 agent 不可隐藏）；企业服务器数据桥（`platform/remoteStore.js`
  的 ping/kv API 契约 + `platform/invoke.js` 数据路由 + 设置页 enterprise 段 + `app/enterpriseServer.js`
  启动恢复，token 走 secure 存储）；周报闭环（`report/material.js` 素材抽取、`report/weeklyPolicy.js`
  纯函数、`report/schedule.js` 装配式调度器、`report/index.js` 生成/通知/归档、TaskView 定时设置行
  与「确认即归档速记」门禁）。
- **三期：客户端部分已完成。**
  - **企业权限门禁**：`src/enterprise/policy.js`（纯规则：`disabledTools` + `maxRisk` 风险上限）、
    `policyStore.js`（同步缓存 + 持久化），在 `isEnterprise()` 时接进 `visibleToolboxTools()` 与
    `buildAgentRegistry/listAgentTools` 的投影（个人版不受影响）。空策略 = 不限制。
  - **操作审计留痕**：`src/enterprise/audit.js`（`auditFromRun` 从 runtime 的 `approval_decided` 事件
    1:1 映射条目 + `mergeAudit` 幂等去重，上限 500），session 落盘路径追加接线（**个人版也留痕**，
    管理面只负责企业态展示）。
  - **管理面**：设置页新增「管理」段（仅企业态可见）——工具准入开关、风险上限、
    审计日志列表 + 清空（二次确认）+ 导出 JSON。
  - **知识写回**：Agent 结论卡「存为速记 / 存为问题」→ `src/agent/answerDraft.js` 纯函数映射 +
    `repository.create` 复用速记/问题同源写入口。
  - **会话域绑定**：`src/agent/context.js` 的 `buildContextLine(domain, t)`；AgentView 域选择器 →
    `startAgentRun(goal, { contextLine })` → 经 planner 注入提示词（照 `clarifyLine` 范式，
    不选域时提示词逐字节不变）。
  - **成员/席位管理**：接口与客户端已完成——`src/platform/remoteStore.js` 的
    `remoteMembers` / `remoteCreateMember` / `remoteRevokeMember`（403→`REMOTE_FORBIDDEN`、
    409→`REMOTE_SEAT_LIMIT`、删自己→`CANNOT_REVOKE_SELF`），`remotePing` 增加 `role`；
    设置页「管理」段挂 `src/enterprise/MembersPanel.vue`（哑组件 + SSR 渲染测试）。名册以服务端为
    权威来源，令牌只在创建时返回一次。服务端实现见 `server/enterprise-server.js`。
- **服务端（企业）**：`server/enterprise-server.js`（零依赖 Node）已实现客户端契约
  （`POST /v1/auth/ping` + `GET/PUT /v1/kv/<key>`，常数时间令牌比对、限流、体积上限、原子写），
  首次启动自动签发管理员令牌；`server/enterprise-server.test.js`（5 例）与客户端
  `src/platform/remoteStore.js` 的契约注释一一对应。部署与令牌表见 `server/README.md`。
  成员/席位接口（`GET/POST /v1/members`、`DELETE /v1/members/{id}` 与 ping 的 `role`）也已实现。

## 分期计划（原始规划）

### 一期：地基与体感（不碰导航迁移）

| 改动 | 文件 | 测试影响 |
|---|---|---|
| 契约加 `scope` + 准入断言 | `src/contracts/*.js`、`contracts.test.js` | 新增枚举合法性断言 |
| 版本过滤进投影 | `platform/env.js`、`toolboxTools.js`、`agent/catalog.js` | `browserGating.test.js` 扩展版本维度用例 |
| Agent 三栏化 | `views/AgentView.vue`（history rail → 左栏会话列表，带搜索+状态灯） | `AgentView.render.test.js` 重写断言 |
| 产物「在工具中打开」 | AgentView 产物卡 → `ToolWindow.vue` 预填协议 | 新增预填协议单测 |
| Summary 交付清单 | `agent/session.js` run 收尾 + AgentView 卡片 | session 测试补断言 |

### 二期：企业 MVP（碰导航与数据桥，需要迁移）

- 侧边栏主体改任务列表；work/records/toolbox 收进「工作面」分组；任务监控提升为应用级条件面板。
- `navConfig.js` 加 schema v9 迁移（hiddenModules/深链/LEGACY_VIEW_TARGET 全套，`migrate.test.js` 仿 v8 写 v9）。
- invoke 数据桥接企业服务器实现 + 设置页服务器配置 + 登录态。
- 周报闭环：定时触发 + 模板 + 确认门禁 + 归档。
- 空状态定位文案（个人版"今日简报"叙事）。

### 三期：管理面（企业商业化形态）

- 成员/席位管理、权限门禁（哪些工具/动作对谁可见）、操作审计留痕。
- 团队知识引擎：records 的团队共享空间 + Agent 结论一键写回（知识沤肥）。
- 输入框域绑定（工作台切换器）：对话默认带当前域上下文。

## 不做清单（明确排除，防过度工程）

- 多智能体流水线（Experts 模式）、IM 频道接入、MCP/插件市场、实时语音——个人工具现阶段全是过度工程。
- 浏览器门户形态——决策 1 已选桌面端，browserHandlers 仅维持现状不投入。
- 手机端 Agent 优先改造——手机端维持工具优先。

## 验收标准

- **一期**：全量测试绿（含新增 scope/三栏/预填/Summary 断言）；个人版与企业版（常量开关模拟）画廊内容按 scope 正确分化。
- **二期**：企业服务器连通后可演示「周五自动周报」全链路；导航迁移测试绿；深链兼容。
- **三期**：管理面可配权限且权限在 Agent 目录投影中生效；审计留痕可查询。


---

## 布局修订（2026-10-18）：三栏 AppFrame + 万物皆本地工具

对标 DSH 的 `ui-layout` / `ui-sidebar`（见 `apps/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-layout`）重做了外壳。
修订前的问题是**三层 chrome**：应用顶栏 56px + 视图内 thread bar 52px + 页内标题，首屏被吃掉近 110px，
而「任务监控」是主区内部切走 280px，切到其它模块就一起消失。

### 骨架

```
┌────────────┬───────────────────────────────┬──────────────┐
│ 侧栏 280   │ 顶栏 48（标题 · 状态 · 动作） │ 右栏 340     │
│ 新任务 ⌃N  │ ───────────────────────────── │ （条件出现） │
│ 工作面     │  对话列（限宽 820 / 居中）    │ 运行监控      │
│  研发…     │  ⋯                            │ 或 本地工具   │
│ 历史（滚动）│  composer（钉底）             │              │
│ 设置       │                               │              │
└────────────┴───────────────────────────────┴──────────────┘
```

| 项 | 改前 | 改后 | 硬约束 |
|---|---|---|---|
| 侧栏 | 244（收起 64） | **280**（收起 **56** 图标轨道，窄屏 760 浮层） | 固定入口不滚动这条不变（`29-sidebar-fixed-zones`） |
| 顶栏 | 56，视图再叠一条 52 的 bar | **单条 48**，标题/状态由 AgentView 经 `shellFrame.thread` 投递 | 外壳**不许** import `agent/session.js`（会把引擎拖进 entry chunk） |
| 右栏 | AgentView 内部 grid 列 280 | 外壳 `<aside class="dock">` **340**，`Teleport to="#shell-dock"` 投递 | 外壳只提供列与开关；`v-show` 而非 `v-if`，否则 Teleport 目标不存在 |
| 右栏开关 | 画布内「任务监控」按钮 | 顶栏图标（`aria-pressed`），关闭按钮仍在面板头 | 视图卸载时 `dockOpen=false`，否则切模块后留一列空面板 |

投递协议（`src/app/App.vue` provide `shellFrame`）：

```js
{ dockOpen: Ref<boolean>, thread: { title, status }, setDock(v), toggleDock() }
```

AgentView 侧：`watch([threadGoal, statusMeta, busy, viewRun])` 写 `thread`；`onBeforeUnmount` 清空并关右栏。
单独渲染本视图（单测 / 手机端）时 `inject` 拿到 null，退化为本地 `monitorVisible`，行为与旧版一致。

### 万物皆本地工具

「工具箱」画廊（启动台大数字 + 常用工具卡 + 可折叠分组）换成**一份目录**：

- 导航项 `工具箱` → **本地工具**（`nav.toolbox` 的值改了，键保持不变，深链不破）。
- 目录行 = 图标 / 名称 / 一句能力 / 「Agent 可调」徽标 / 收藏星 / 打开箭头，42px 一行。
- 顶部三个筛选：**全部 / Agent 可调 / 最近**；「Agent 可调」不是第二份清单，而是同一批工具里
  被 `AGENT_TOOL_CATALOG` 的 `toolKey` 引用到的那些（当前数据 13 / 18，与目录头部三个数字同源）。
- 目录末尾列 **Agent 动作**（41 条，等宽名字 + 说明 + 风险 chip），证明「Agent 的动作空间」就是这些工具，
  不是另一套黑箱；搜索词同时过滤动作。
- 右栏空闲态展示 6 个可直开的本地工具（与目录同源 `visibleToolboxTools()`），
  让「这轮它有哪些手」在对话屏就能看到。

淘汰的代码：`buildToolboxQuickList` / `normalizeExpandedGroups` / `toggleExpandedGroup` 不再被本视图引用
（模块本身保留，手机端与单测仍在用），`expanded-groups` 持久化键停写。

### 测试影响

| 守卫 | 改动 |
|---|---|
| `src/views/AgentView.render.test.js` | 新增 `renderWithShell`，把「标题/状态投递」「右栏默认关闭」改成断言 `shellFrame` 的值；空态示例改成胶囊标题（`agent.exampleTitleN`） |
| `src/i18n/preMigrationKeys.json` | 新增 11 条词条后重生成（5317 键）；`i18nFragments` 的「不许多键」随之刷新 |
| `e2e/specs/29-sidebar-fixed-zones.spec.js` | 280/56 侧栏、48 顶栏、13.5px 标题、27px logo |
| `e2e/specs/{01,20,24,50,52,54,56,58,59,63,66,67,71}` | 导航文案 工具箱 → 本地工具；目录行选择器 `.tool-item` → `.lt-tool`，搜索框 `.toolbox-search` → `.lt-search` |
| `e2e/specs/28-agent-monitor-panel.spec.js` | 开关从画布内按钮改成顶栏 `.dock-toggle`（name 在「显示/收起任务监控」间切换）；窄窗（≤620px）开关收起，只验不溢出 |
| `e2e/helpers.js` | 无需改：`expectRunFinished` 仍读 `.st-chip`——顶栏状态胶囊在运行结束后**保留终态**（`runStatus` 比 `busy` 活得久），否则所有等待运行结束的用例都会超时 |

**未做**（明确的取舍）：右栏宽度不可拖拽、没有 `shell.bottom` 状态行、没有 `Plugins` 之类的全局面板槽位——
这三件都属于「等真有第二个占用方再加」，现在只有一个面板，先把列与开关做对。
