# ToolCove Agent 化改造方案

## 定位

ToolCove 适合做“本地开发工作流智能体”：用户用自然语言描述目标，智能体选择并调用已有工具，展示每一步结果，必要时请求确认，并把过程保存成可复用的任务模板。

现有基础已经足够做 MVP：`src/ai.js` 提供 OpenAI 兼容聊天和流式输出，`src-tauri/src/ai.rs` 负责跨域代理，工具箱注册表和 Tauri 命令则提供了可复用能力。

## 推荐分层

```text
Chat/Task UI (Vue)
        |
Agent Runtime (JS，状态机与事件流)
  ├─ Planner：模型决定下一步和工具参数
  ├─ Tool Registry：统一描述工具及 JSON Schema
  ├─ Policy：风险分级、确认、超时、取消
  ├─ Memory：任务上下文、历史摘要、本地经验
  └─ Run Store：步骤、输入输出、错误、耗时
        |
Tool Adapters
  ├─ 纯 JS：convert / json / diff / generator / time
  ├─ Tauri command：file / image / db / network / request
  └─ 外部 MCP（后续可选）
```

模型只负责选择动作和生成参数；文件、数据库、网络等副作用必须由运行时执行并经过 Policy 检查。

## MVP 建议

先做一个“任务模式”，保留现有 AI Chat 作为自由对话模式。用户输入“读取这个 JSON，找出重复字段并导出 CSV”时，运行时循环执行：

1. 将目标、可用工具摘要和最近步骤发送给模型。
2. 模型返回一个结构化动作：`tool_call`、`final` 或 `ask_user`。
3. 校验工具名和参数 Schema，执行工具适配器。
4. 把结果（截断后的文本、结构化数据摘要、错误）追加到上下文。
5. 重复直到 `final`、取消或达到步数上限（建议 12 步）。

建议新增 `src/agent/`：

- `types.js`：动作、事件、运行状态的类型约定。
- `registry.js`：工具注册和 Schema 校验。
- `runtime.js`：`runAgent(input, options, handlers)` 主循环，支持 stop signal。
- `policy.js`：`read`、`transform`、`write`、`network`、`database` 风险级别。
- `memory.js`：任务摘要和用户批准过的经验。
- `adapters/`：把已有 JS 函数或 Tauri `invoke` 包成统一接口。

动作协议可以固定为：

```json
{"type":"tool_call","id":"step-1","tool":"json.parse","args":{"text":"..."}}
{"type":"ask_user","question":"即将执行 SQL UPDATE，是否继续？"}
{"type":"final","answer":"已完成，共发现 3 个重复字段。"}
```

工具描述统一为：

```js
{
  name: "json.parse",
  description: "解析 JSON 并返回结构化值",
  risk: "transform",
  inputSchema: { type: "object", required: ["text"], properties: { text: { type: "string" } } },
  execute: async ({ text }) => JSON.parse(text)
}
```

## 首批工具

先接入无副作用、容易验证的能力：JSON/YAML 解析、文本 diff、时间转换、数据生成、请求响应格式化。第二批再接文件写入、数据库 SQL、网络诊断；这些工具默认 `ask_user`，并提供取消、超时和敏感字段脱敏。

## UI 改造

在 `AiChatTool.vue` 增加“聊天 / Agent 任务”切换。任务模式显示步骤时间线：计划、工具参数、工具结果、确认卡片和最终答案；支持停止、重试单步、复制运行记录、将运行保存为任务模板。不要把原始 API Key、完整 SQL 结果或文件内容写入遥测。

## 配置与安全

沿用 `settings.ai`，增加 `agent.maxSteps`、`agent.requireConfirmation` 和每个工具的启用开关。API Key 继续只在 Rust 代理侧使用。工具执行统一限制输入大小、输出大小和执行时长；数据库工具使用只读连接作为默认配置。

## 交付顺序

1. 定义协议和 `registry`，给 5 个纯函数工具写适配器。
2. 实现运行循环、流式事件和停止能力，接入任务模式 UI。
3. 加 Schema 校验、风险确认、运行持久化和错误恢复。
4. 接入文件/DB/网络工具，增加只读沙箱与审计记录。
5. 再考虑 MCP、定时任务、多智能体协作和远程执行。

验收标准：同一输入能稳定复现步骤；非法工具或参数不会执行；高风险动作必有确认；中途停止不会留下半写入文件；断网、模型返回非法 JSON、工具超时都能在时间线上清楚呈现。

## 落地状态（与代码同步，改代码时一并维护）

- 引擎：`runtime.js`（受控循环 + 超时/重试/停止 + 逐次批准门禁 + 读后写门禁 + 模型退避重试）、
  `approval.js`（批准策略，见下）、`observation.js`（读后写门禁，见下）、`tools.js`（配置钳制与 registry 装配）、
  `session.js`（模块级运行态单例，视图销毁不丢运行）、`runStore.js`（历史脱敏落盘）、
  `timeline.js`（事件折叠，含审计行）、`index.js`（宽松解析 + `createRepairingPlanner` 解析失败回灌重试）。
- 副作用治理（对标 DSH，分析见 `docs/agent-dsh-borrow.md`）：
  - **逐次批准**（`approval.js`）：批准只对「这一次调用」有效。旧实现按 risk 分级后，某次批准会让同一 run 内
    后续同类调用直接放行，等于无意的批量授权。现在每次调用都重新问，只有「同工具 + 同参数」折叠为一次；
    批准与拒绝**都记账**——被拒绝的同一调用直接判拒（`denied-before`），不重复弹卡。
    `requireConfirmation` 三档语义：`always` 全问 / `risky` 写类问 / `never` 不问。
  - **审计事件**：每次工具调用都落 `approval_asked` + `approval_decided` 一对
    （`source: 'human' | 'policy'`，`by: 'user' | 'policy'`）。没问人不等于没决定——只读工具也要写明
    「是策略放行的」，否则「谁放行的」答不出来。`timeline.js` 折叠成一条 `kind:'approval'` 审计行。
  - **拒绝不终止任务**：拒绝作为反馈回灌给模型换招（旧行为直接 `cancelled`）；连续被拒 5 次才收尾。
  - **读后写门禁**（`observation.js`）：`file.write_text` / `file.preview_write` 要求先 `file.read_text`
    读过该文件。两套记账刻意分开：**内容观察**才能开门禁，**存在性证据**（含 `file.inspect`）只能阻止
    「盲创建覆盖同名文件」——同名不等于同内容。读过但报「不存在」→ 允许创建；其余读取失败一律拒绝
    （Tauri 把 IO 错误统一包成「无法读取文件：…」字符串，前端无法可靠区分不存在与读不了，所以让模型
    自己用 `file.inspect` 澄清）。门禁按运行独立，错误码 `OBSERVATION_REQUIRED`。
  - **模型调用退避重试**：`RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT` 退避重试（500ms→5s，上限 3 次尝试），
    鉴权/配置类错误不重试。重试落 `model_retry` 事件，时间线上可见。
  - **模型输出修复**：解析失败把错误原文回灌给规划器自我修正（上限 2 次），落 `model_repair` 事件。
- 界面：`AgentView.vue` 是应用默认首屏（`App.vue` MODULES 第一项，Ctrl+1）；`AiChatTool.vue` 的「Agent 任务」模式不再自建循环，直接复用 `session.js`，确认与历史与工作台同一份。
- 工具：`builtins.js` 覆盖除「AI 对话」与「标签打印」外的全部工具箱能力（json / convert / yaml / diff / time / generator / crypto / image / file / db / network / request）。文件、数据库、网络诊断四项带 `desktopOnly: true`；HTTP 请求改走平台 `invoke`，浏览器端由 fetch 直连实现（受目标端点 CORS 限制）。标签打印是有物理副作用的动作（要人核对介质与目标打印机），只在工具箱里手动操作，能力面板按「手动工具箱」列出入口。
- 数据工具：`dataTools.js` 提供业务数据读写（速记/问题/迭代/领域/池/发布），与 `builtins.js` 一起由 `tools.js` 装配；
  `AGENT_TOOL_NAMES` 在 `tools.js` 汇总（停用清单与能力面板共用）。`data.query`/`data.get` 为只读工具，
  `data.create`/`data.update`/`data.remove` 为写工具：写工具走 `repository` 同一写入口（乐观锁 + 冲突重放），
  写后广播 `data-changed`，视图与 Agent 各自的改动自动互见。
  返回体量受控：query 摘要化（长文本 400 字符、对象数组降级为条数），get 超 24000 字符才降级并标记 `truncated`。
  写入前按 `KIND_META` 校验必填字段、可改字段白名单与枚举（`problems.type/status`、`iterations.status`，
  取值表与视图同源）：视图模板用取值表直接索引，枚举外的脏值会让整个视图停止渲染，因此在工具边界就拒绝。
- 删除确认：`data.remove` 声明 `confirm: 'always'`，`runtime.js` 的确认门禁对它恒为真，
  不受运行选项 `requireConfirmation: 'never'` 影响（用户显式选「永不确认」也不放行删除）。
- 视图一致性：`SnippetView` / `ProblemView` / `IterationView` / `RequirementBoardView` / `TaskView` 的整表写入
  全部迁移到 `repository.mutate`，并订阅 `data-changed`（本地无未保存编辑时重载，有编辑时只提示）。
  `iterations` 的迭代页 / 需求大盘 / 任务页三处写入不再互相覆盖。
- 平台过滤：`src/platform/env.js` 是平台判定唯一真相源；`tools.js` 的 `buildAgentRegistry` / `listAgentTools` 与 `toolboxTools.js` 的 `visibleToolboxTools()` 在浏览器端剔除 `desktopOnly` 工具，规划器不会选中注定失败的工具；运行期兜底由 `platform/invoke.js` 抛 `DESKTOP_ONLY`。门禁行为由 `src/platform/browserGating.test.js` 覆盖。
- i18n：`agent.*`（113 键）与 `toolbox.ai.mode*` 已入 zh-CN / en-US，键数对齐由 `src/i18n/i18n.test.js` 强制。引擎内部错误文本仍是中文原文，UI 侧按 `errorCode` 映射到词条（`ERROR_KEY` / `NOTICE_KEY` / `APPROVAL_REASON_KEY`）。
- 云同步：装配层（`src/sync/index.js`）的数据源直接来自 `repository` 的 kind 镜像，视图无需注册，未打开的视图也能同步；
  信封加密载荷携带 `kind` 防止跨类别串写；删除以墓碑传播（30 天过期）。双设备装配级与真实服务端测试见
  `src/sync/wiring.test.js` / `src/sync/realServer.test.js`。
- 待办：MCP 与定时任务未做；浏览器端云同步待服务端开放 CORS 后再接入。
