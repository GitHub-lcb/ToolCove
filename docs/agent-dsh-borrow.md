# ToolCove Agent 对标 DSH：能力差距与借鉴清单

> 目的：把 ToolCove 现有 Agent（`src/agent/`，约 1430 行 + 9 个测试文件、98 条用例）与 DeepSeek Harness（DSH）的
> Agent 架构逐维度对标，找出**值得借鉴**的部分，并按「性价比 × 与 ToolCove 的契合度」排序给出改造方案。
>
> 本文只做分析与方案，**不含代码改动**。

## 0. 调研口径与可复现性

| 项 | 内容 |
|---|---|
| ToolCove 侧证据 | 全量通读 `src/agent/*.js`、`src/AgentView.vue`、`src/ai.js`、`src/settingsConfig.js`、`docs/agent-architecture.md` |
| DSH 侧证据 | 本轮审计本机安装的 `@deepseek-ai/*`：`D:\ProgramData\AppData_Move\npm-cache\_npx\1e7f6d9597241db0\node_modules\@deepseek-ai\`，共 **240 个包**（231 个 DSH 包 `0.1.5-rc.1` + 9 个 vendored cordis 系框架包），3 397 个文件 |
| DSH 证据形态 | 只读 `package.json` / `README.md` / 编译后的 `lib/*.js`（**未压缩**，JSDoc 与 `#region` 保留）/ `lib/types/*.d.ts` / `cordis.patch.yml` 装配文件 |
| DSH 已知局限 | 所有 README 的 "Source map" 指向的 `src/*.ts`、`docs/**` 在安装产物中**不存在**，README 声明只能与 `lib/` 交叉验证；本文引用 DSH 行为均给出包名/文件名，未验证项在正文标注 |
| ToolCove 测试基线 | ⚠️ **未能在本次会话中运行**：`npx vitest run src/agent` 在 DSH 沙箱下失败于 `esbuild` 的 `spawn EPERM`（受限模式下子进程无法使用命名管道/管道 stdio，两种受限模式皆然，放宽权限也不解决）。本地验证命令见 §6 |

**一句话结论**：ToolCove 的 Agent 在「协议闭环 + 安全护栏 + 工程克制」上已经做对了骨架；与 DSH 的差距集中在
**上下文预算管理、副作用治理粒度、失败可恢复性、并发与可观测性**四块。其中前两项、以及一个「读后写」门禁，
是低成本高收益、且不需要引入 DSH 那套插件体系就能落地的。

---

## 1. ToolCove 现状（实测，非推断）

### 1.1 模块与职责

| 文件 | 行数 | 职责 | 关键实现点 |
|---|---|---|---|
| `runtime.js` | 142 | 受控执行循环 + 工具注册表 + Schema 校验 | `runAgent` 单步串行循环；`maxSteps` 默认 12 / 上限 50；`guarded()` 统一超时+停止；确认策略三分支 |
| `index.js` | 35 | 把 LLM 规划器接到循环上 | `createAIPlanner` 拼字符串 prompt；`parseAction` 直接 `JSON.parse`；`runAIAgent` 负责 run 落盘 |
| `builtins.js` | 42 | 19 个内置工具定义 | json / base64 / yaml / diff / time / id / file / db / crypto / network / http / image |
| `dataTools.js` | 184 | 5 个业务数据工具 | `data.query/get/create/update/remove`；`KIND_META` 白名单 + 枚举校验；摘要化与体量分级 |
| `tools.js` | 44 | registry 装配与配置钳制 | `resolveRunOptions` 把用户配置钳到硬上限；浏览器端剔除 `desktopOnly` |
| `session.js` | 218 | 模块级运行态单例 | `reactive` 单例活过视图销毁；`pending` 确认 Promise；`stopFlag` |
| `runStore.js` | 80 | run 持久化 + 脱敏 + 计量 | `sanitizeRun` 深度脱敏；`canResume` 守卫；`accumulateUsage` 熔断 |
| `timeline.js` | 111 | 事件流折叠成可渲染卡片 | 纯函数、无 Vue/Tauri 依赖，可在 node 下单测 |
| `transport.js` | 14 | 桌面命令统一入口 | 非桌面抛 `DESKTOP_ONLY` |

**工具面**：`builtins.js` 19 个 + `dataTools.js` 5 个 = **24 个工具**，风险分级四档
`read / transform / write / database`，其中 11 个标 `desktopOnly`。

### 1.2 已验证的设计优点（改造时**不要动**）

1. **规划器与执行器强制分离**：模型只产出动作，副作用一律由运行时执行并经策略检查——`docs/agent-architecture.md` 的原始设计意图，代码里落实得很干净。
2. **配置永不信任**：`tools.js:resolveRunOptions` 对 `settings.agent` 这种用户可手改的 JSON 重算钳制（`maxSteps ≤ 50`、`retries ≤ 3`、策略枚举白名单），手改配置绕不过运行时的受控边界。
3. **脱敏在两条路径上都生效**：`runStore.appendStep` 管持久化副本，`session.pushEvent` 管实时 DOM 路径（注释明确写了动机：否则粘进来的密码会在 DOM 里留整个会话）。
4. **`canResume` 的拒绝式设计**：含写类工具历史的 run 直接判定不可续跑，而不是「尽力而为地重放」，避免 `docs/agent-architecture.md` 验收标准里那条「中途停止不会留下半写入文件」被破坏。
5. **`data.remove` 的 `confirm: 'always'` 不可被策略绕过**：即使用户显式选「永不确认」，删除仍然要问——这是正确的优先级。
6. **业务数据工具在边界做枚举校验**：注释指出「视图模板用取值表直接索引，枚举外的脏值会让整个视图停止渲染」，所以脏值在工具边界就拒绝。这个判断很到位。
7. **单例运行态的决定**：`session.js` 顶部用 6 行注释解释了「为什么必须是模块级 reactive 而不是组件 ref」，并给出先例文件。
8. **纯函数可测**：`timeline.js` 刻意不 import Vue/Tauri；`vite.config.js` 无 jsdom，测试跑在 node 环境。

---

## 2. 对标矩阵

判定列含义：**✅ 已对齐** / **⚠️ 部分对齐，有具体缺口** / **❌ 缺失** / **⛔ 不建议借鉴**。

### A. 模型交互协议

| # | 维度 | ToolCove 现状 | DSH 做法 | 判定 |
|---|---|---|---|---|
| A1 | 动作产出形式 | 纯文本 prompt，要求模型回一个 JSON 动作，`parseAction` 直接 `JSON.parse`（`agent/index.js:6`） | 原生工具 schema，`ctx.llm.stream()` 流式；模型可见 ⟺ 已落盘 | ⚠️ 见 A2 |
| A2 | 解析失败处理 | **无修复、无重试**：模型多一句解释、少一个引号 → 整个 run `failed` | `agent/request-error` 瀑布 + `dsh-llm-retry`：`EMPTY_RESPONSE/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT` 默认 5 次重试，指数退避 500ms→10s、抖动 0.1；`Retry-After` 优先 | ❌ **高价值缺口** |
| A3 | 历史投喂 | `JSON.stringify(history.slice(-8))` 整段塞进 prompt（`agent/index.js:19`） | 事件溯源 session log；`deriveMessages()` 派生 + 三层上下文治理（§2 章 B） | ⚠️ 见 B |
| A4 | 流式 / 过程可见 | 规划调用走 `aiComplete`（非流式），模型思考期间 UI 无内容 | 每个模型尝试只发一次 `start`，与 assistant 帧结算配对后才有 chunk，恰好一个终止 `end` | ⚠️ 可选增强 |
| A5 | 工具超时 | `guarded()` 超时默认 30s / 上限 120s，超时 abort 并提示「已停止等待，请确认执行结果后再试」 | 工具私有 `timeoutMs`（声明式），由 `dsh-tool-call-timeout-policy` 统一在 `tools/execute` 注入 deadline；**协作式，从不硬杀**，工具忽略 signal 时 wrapper 会一直等待 | ✅ 已对齐，且 ToolCove 的文案更诚实 |
| A6 | 单步/总预算 | `maxSteps` 默认 12 / 硬上限 50；单次工具结果 ≤ 32000 字符（上限 100000） | 循环**无内建 turn 预算**，由策略挂 `agent/turn-stopping`；体量治理交给 B | ⚠️ 有预算但处理方式粗暴（B1） |

### B. 工具结果保留与上下文预算

这是**差距最大**的一块。

| # | 维度 | ToolCove 现状 | DSH 做法 | 判定 |
|---|---|---|---|---|
| B1 | 单次结果超限 | 超 `maxOutput` **直接抛错**：`throw Error('工具结果过大，请缩小输入后重试')`（`runtime.js:139`）——整步失败，模型只能盲目缩小输入重试 | **三层：spill → prune → compact**，且顺序固定在时间轴上<br>① **spill**：工具返回即判定，纯文本结果 UTF-8 超过 `maxInlineBytes`（base 配 50000）时，保留头尾各半 + 提示 `(Omitted <N> bytes. Full formatted result stored at: <locator>. Use read with offset/limit, or grep this path to search within it.)`，全文落私有临时目录（`mkdtempSync`，0600/0700，`wx` 打开）<br>② **prune**：`dsh-compaction-tool-result-pruner` 阈值 8192 字符、头 4096 / 尾 1024，中间替换为 `[... tool result middle pruned ...]`；**先剪枝、再测压，压力已缓解就完全跳过摘要**<br>③ **compact**：阈值 0.8 × contextWindow，保留尾部 0.16，摘要由 `ctx.llm.stream()` 生成且**逐字节重放系统提示+工具+被遮蔽消息**作为真实前缀<br>三层的改动都是日志里的 `replace` 事件（引用 `sourceEventSeqs`），原始 `tool/result` 始终在日志里 → 可重放 | ❌ **最高性价比缺口** |
| B2 | 历史裁剪 | `history.slice(-8)` 只保留尾部，**早期步骤被静默丢弃** | 折叠而非丢弃；被遮蔽区间有 `shadowedSeqs[]` 权威记录 | ❌ 缺口 |
| B3 | Token 计量 | `accumulateUsage` 累计服务端返回的真实 usage（含熔断上限） | `ctx.tokenMeter` 是**估算器不是分词器**（`CHARS_PER_TOKEN=4`），对 session log 做 replay-aware 折叠；`tokens`（路由定价）与 `heuristicTokens`（路由无关）刻意分开 | ⚠️ ToolCove 更准，但无法预知「下一步会不会撞上下文墙」 |
| B4 | 重复调用抑制 | 无 | `dsh-repeat-tool-reminder`：链键 = (工具名, 参数深排序 JSON)，阈值 `[3,5,8]`，挂在 `tools/post-execute`（**被拒绝的调用也算**，所以「反复锤一个被拒的调用」能被抓到）；提醒走 `additionalContexts` 而**不替换 content**，保持审计原样；纯建议，不阻断 | ❌ 缺口（B2 的直接后果） |

### C. 并发与多智能体

| # | 维度 | ToolCove 现状 | DSH 做法 | 判定 |
|---|---|---|---|---|
| C1 | 工具并发 | 严格串行：`for (step...)` 每轮一个工具 | `maxParallelToolCalls` 默认 **10**；只有 `isConcurrencySafe() === true` 的调用可重叠，**独占调用是排序屏障**；abort 时把已启动调用排空并为未派发者合成 `ABORTED_BEFORE_DISPATCH` 结果，保证重放有效 | ❌ 缺口 |
| C2 | 子智能体 | 无 | `ctx.subagents` 命名提供者注册表；spawn 与 fork **只差一件事**——子 session 是否带父日志前缀；子 agent 有独立 Session、独立循环、同一 cordis 服务图；深度上限 3 | ⛔ 超出 ToolCove 定位（见 §5） |
| C3 | 工作流 / Ralph / Goal | 无（`docs/agent-architecture.md` 已把「多智能体协作」列在最后） | workflow 有真正的 `parallel` 屏障与无屏障 `pipeline`；Ralph 是固定脚本 + 每轮 fresh child（`inheritsParentContext === false` 强制校验）；goal 事件溯源 + 轮次驱动 | ⛔ 见 §5 |

### D. 副作用治理（安全护栏）

| # | 维度 | ToolCove 现状 | DSH 做法 | 判定 |
|---|---|---|---|---|
| D1 | 确认粒度 | **运行级**：`requireConfirmation ∈ {risky, always, never}`，`risky` 下按 `risk ∉ {read, transform}` 决定问不问；批准一次后**同类调用在该 run 内不再问** | **调用级**：`approval/request` 的决策枚举只有 `allowed-once` —— **没有 allow-always、没有记住的规则、没有撤销、没有授权存储** | ❌ **安全缺口**：ToolCove 的「批准一次，后续同类全放行」是无意的批量授权 |
| D2 | 提权阶梯 | 无（`risk` 是静态分级，运行时不可提权） | `WIDER_MODES = {'read-only':['workspace-write','danger-full-access'], 'workspace-write':['danger-full-access']}`；**非放宽请求永不弹人工**；无审批者 → `unavailable`（失败关闭）；`approveEscalation` 里「无审批者更宽 → 提示 → 人工请求」的排序保证了最小打扰 | ❌ 缺口（ToolCove 无沙箱，但**排序思想可借**） |
| D3 | 沙箱 | 无（依赖 Tauri 命令自身边界 + `desktopOnly` 过滤） | 三档 mode（默认 `read-only`）+ 平台链 bwrap/Landlock/Seatbelt/Windows ACL，**功能性探测、失败关闭**（`SandboxUnavailableError`，绝不无约束放行）；`windows-acl` 只是 `partial` 且明确说明原因（`EVERYONE` 必须保留、NTFS 硬链接别名） | ⛔ 见 §5 |
| D4 | 读后写门禁 | **无**：`file.write_text` 可在从未读过的路径上盲写（`builtins.js:29`） | `dsh-fs-observation-policy`：`WeakMap<owner, Map<targetKey, observation>>` 按 **session** 记账，未读就 `edit` → `FS_NOT_OBSERVED`；`writeIntent` 返回 `createIfAbsent` 或 `{kind:'replaceIfVersion', version}`；**授权依据是版本新鲜度，不是视图完整性**（任何窗口读都能授权对未变更文件的全量覆写） | ❌ **高价值缺口** |
| D5 | 计划模式 | 无 | `dsh-plan-mode` 明说「**不限制 agent**：每个工具仍可调用，需要硬限制请用沙箱和审批」。它只注册一个 prompt 段和一个工具，且退出工具**在非激活时也保持注册**（KV 缓存稳定性） | ✅ 不借（ToolCove 没有沙箱兜底，做「只提示不强制」的计划模式会误导用户） |

### E. 可观测性与审计

| # | 维度 | ToolCove 现状 | DSH 做法 | 判定 |
|---|---|---|---|---|
| E1 | 脱敏 | `sanitizeRun` 已实现（键名匹配 + 凭据格式 + Bearer/Basic + URL 内嵌凭据 + `sk-` 前缀 + 值级替换） | `session-telemetry/record` 瀑布；抛异常的脱敏监听器会**扣下该条记录**（失败关闭）；OTel 默认 `FEEDBACK_ONLY`（只有用户显式反馈才释放未处理前缀） | ✅ ToolCove 的脱敏做得不错，缺的是 E2 |
| E2 | 操作审计 | 用户的人类决定只在 `session.resolvePending` 里推一条 `confirmation` 事件，**没有独立的决策事件、没有契约、没有不变量校验** | `approval/asked` + `approval/decided` 成对写在 turn 内；`dsh-user-approval` 的不变量断言这对事件必须 turn-enclosed 且词表封闭 | ❌ 缺口 |
| E3 | 不变量 | 靠 98 条单元测试 | `ctx.invariants`：35 个 invariant 文件、341 个 `fail()` 点，多数同时校验已加载历史**和**挂 `internal/dispatch` 校验发布前事件（如 `a loop-built request must be frozen`、`LLM stream ended without a terminal finish chunk`） | ⚠️ 量级不适合，但「成对事件」的不变量思路可小规模借 |
| E4 | 遥测 | `track("agent.run")` / `track("agent.resume")` 两个埋点 | `SessionTelemetryRecord{channel:'ledger'|'ops', ...}`；结算顺序刻意设计：记录提交 → 释放等待者 → 可见集变更 → **完成监听器最后**（因为 reporter 可能同步开启一个模型 turn） | ⚠️ 可补，非优先 |

### F. 扩展模型

| # | 维度 | ToolCove 现状 | DSH 做法 | 判定 |
|---|---|---|---|---|
| F1 | 工具注册 | 静态 24 个，`disabledTools` 开关只能减不能加 | `ctx.tools.register()` + `restrict({allow, deny})` 作用域限制；`presentAs(mode)` 三档呈现（native / ptc / both） | ⚠️ ToolCove 的「只能减」对终端用户是合理的，见 §5 |
| F2 | 扩展点数量 | 只有 registry + 配置两个 | 240 包、70+ 个 `ctx` 服务、seam/provider 二分、fiber 作用域自动卸载；`dsh-sdk-minimal` 却证明**最小可用只要 31 行装配** | ⛔ 架构量级不匹配 |
| F3 | 技能 | 无 | `dsh-skill-filesystem` 六级 root 排名 + 按需加载；目录里**只投 name + 截断到 500 字符的 description**，`whenToUse` 刻意不进目录 | ❌ 缺口（可做轻量版，见 §3 第 6 项） |

---

## 3. 借鉴清单（按性价比 × 契合度排序）

排序原则：先做**安全**，再做**鲁棒**，最后做**吞吐**；每项都控制在纯 JS 模块 + 单测的既有形态内。

> **落地状态**：P0-1 / P0-2 / P0-3 **已实现**（`src/agent/approval.js`、`src/agent/observation.js`、
> `src/agent/index.js` + `runtime.js`），并已同步到 `docs/agent-architecture.md` 的落地状态段。
> P1 / P2 仍为待办。实现过程中由验证脚本抓到 4 个真实缺陷，见 §6 末尾。

### P0-1　逐次批准 + 操作审计记录

| 项 | 内容 |
|---|---|
| 借自 | DSH `dsh-user-approval`（`allowed-once` 是唯一的授权形态）+ `dsh-permission-presets`（按顺序写 `sandbox/mode`、`approval/policy` 事件） |
| 为什么 | 当前 `risky` 策略批准一次后，**该 run 内所有同类工具调用都不再询问**。用户以为「我同意写这一个文件」，实际同意的是「这次任务里所有文件写入」。这是本次对标里最该先修的一条。 |
| 落地 | 新增 `src/agent/approval.js`：`createApprovalPolicy(cfg)` 返回 `{ decide({tool, callId, history}) }`。规则：<br>· `tool.confirm === 'always'` → 恒为问（保留现有优先级）<br>· `requireConfirmation === 'never'` → 不问（用户显式选择，尊重）<br>· `requireConfirmation === 'always'` → 每次都问<br>· `risky` → **仍在首次询问，但每次调用都问**（不再复用上一次的结构性授权）<br>· 已批准集合按 **callId** 记账，不复用工具名 |
| 改动面 | `src/agent/approval.js`（新）、`runtime.js` 的确认门禁段（107–118 行）、`session.js` 的 `handleConfirm`（补 callId）、`AgentView.vue` 确认卡文案（标明「仅本次」） |
| 事件契约 | 每次决策落一对 `{type:'approval_asked', callId, tool, args}` / `{type:'approval_decided', callId, approved, by}`，进 `runStore` 与 `timeline.js`（新增 `kind:'approval'` 折叠分支）。二者**成对**是这项的关键——单条 `confirmation` 事件无法回答「谁放行了什么」。 |
| 风险 | 交互变啰嗦。缓解：`risky` 下**同一 run 内对同一工具、同一目标参数的重复调用**（如连续写同一文件）可折叠为一次询问——但这是唯一允许的复用，且必须记进审计事件。 |
| 验证 | `src/agent/approval.test.js`（新）：`always`/`never`/`risky` 三策略 × 首调/重复调；`runtime.test.js` 补「第二次同类写调用仍然询问」。 |

### P0-2　文件读后写门禁

| 项 | 内容 |
|---|---|
| 借自 | DSH `dsh-fs-observation-policy`（`WeakMap` 按 session 记账 / `FS_NOT_OBSERVED`） |
| 为什么 | `file.write_text` 现在可以在从未读取过的路径上盲写；模型很容易「以为文件是空的」而覆盖掉真实内容。这是**当前最可能造成真实数据损失**的路径。 |
| 落地 | 新增 `src/agent/observation.js`：`createObservationGate()` 提供 `observe(path)` / `check(path)`。`runtime.js` 在 `tool.execute` 前调用（可按 `tool.observeBefore` 标记挂钩，或直接按工具名判断 `file.read_text` 观察、`file.write_text` 校验）。未观察 → `throw Error` 带 `code:'FS_NOT_OBSERVED'`，文案要能教会模型自救：`写入前需先读取该文件：<path>`（DSH 的文案就是这个形态）。<br>跑通后扩展：`file.preview_write` 天然满足门禁，可让它顺带完成观察登记。 |
| 改动面 | `src/agent/observation.js`（新）、`runtime.js`、`AgentView.vue` 的 `ERROR_KEY`（补 `FS_NOT_OBSERVED` 词条）、`i18n` 两语言 |
| 风险 | 新建文件会被门禁误伤。按 DSH 的 `createIfAbsent` 思路区分：**读取失败 = 确认不存在** → 放行创建；读取成功 → 登记版本，写入放行。需要 `file_tool_read_text` 能区分「文件不存在」和「读取失败」，若不能则退化为「不存在目录内的新文件放行」。 |
| 验证 | `src/agent/observation.test.js`（新）：未观察拒写 / 观察后放行 / 不存在文件允许创建 / 观察被 stop 清空。 |

### P0-3　模型响应鲁棒化与有界重试

| 项 | 内容 |
|---|---|
| 借自 | DSH `dsh-llm-retry`（分类重试 + 有界退避 + 抖动；`llm/retry` 事件先落盘再起定时器） |
| 为什么 | `parseAction` 是裸 `JSON.parse`。模型多一句「好的，我来」、少一个反引号，整个任务立刻 `failed`——这是**当前最常见的任务失败原因**，而它完全可以自愈。 |
| 落地 | 三件事，纯 JS：<br>① 新增 `parseActionLoose()`（对齐 `ai.js` 里已有的 `parseJSONLoose` 手法：剥 ```json 围栏 → 截最外层 `{...}`）；<br>② 解析失败时把**解析错误原文回灌**给规划器（`agent/index.js` 的历史里推一条 `{error:'模型未返回有效 JSON'}`），让模型自我修正，最多 N 次（建议 2），N 次后按现状失败；<br>③ 对 `EMPTY_RESPONSE` 类瞬时错误加有界退避重试。注意：ToolCove 走 OpenAI 兼容端点，`aiChat` 抛出的错误目前**没有错误码**，需要先给 `ai.js` 的失败分类（可只分 `TIMEOUT / TRANSPORT / RATE_LIMIT / AUTH / OTHER` 五类）。 |
| 改动面 | `src/agent/index.js`、`src/ai.js`（错误分类）、可选抽 `src/agent/repair.js` |
| 风险 | 无界重试会烧 token。**必须有次数上限**，且重试事件要出现在时间线上（用户要看得见「模型格式错了，正在重试」）。 |
| 验证 | `src/agent/index.test.js`：围栏包裹的合法 JSON / 前后有解释文字 / 完全非 JSON 时重试并在上限后失败。 |

### P1-4　工具结果分层保留（替代「超限即失败」）

| 项 | 内容 |
|---|---|
| 借自 | DSH 的 spill → prune → compact 三层（**顺序是时间轴顺序**：spill 在工具返回时，prune 在测量后，compact 是最后手段） |
| 为什么 | `runtime.js:139` 的 `throw Error('工具结果过大，请缩小输入后重试')` 把「结果太大」变成「这步白做」。而 `dataTools.js` 已经证明 ToolCove 会做体量分级（query 摘要化 / get 超 24000 才降级）——**这个模式应该上移到 runtime 层作为兜底**。 |
| 落地 | `runtime.js` 里把「超限抛错」换成三级：<br>① `< maxOutput` 原样；<br>② `maxOutput ~ 4×maxOutput` → 保留头尾 + `…[已省略 N 字符]` 提示，**在历史里记 `truncated: true`**；<br>③ `> 4×maxOutput` → 写临时文件（桌面端 `tmp-debug`/应用数据目录；浏览器端跳过此级），结果里带路径 `完整结果已存至：<path>，可用 file.read_text 分段读取或搜索`。<br>关键细节（照抄 DSH 的教训）：**提示文字本身的字节数要先预留**，否则替换后会超预算。 |
| 改动面 | `runtime.js`（结果处理段）、`builtins.js`（可选：给 `file.read_text` 加 `offset/limit`，否则「分段读取」这句话是空头支票） |
| 风险 | 临时文件会堆积。DSH 的 `cleanupPeriodDays` 默认 30 天；ToolCove 至少要限制单 run 数量 + 复用已有清理路径。**注意 `file.read_text` 目前没有 offset/limit**，不加的话 spill 出来的文件读不回来——这两件事必须同批做。 |
| 验证 | `runtime.test.js` 补：小结果原样 / 中结果头尾保留且带省略标记 / 大结果落盘且提示含路径。 |

### P1-5　并发安全的工具并行执行

| 项 | 内容 |
|---|---|
| 借自 | DSH `maxParallelToolCalls` + `isConcurrencySafe()`（只有精确 `true` 才参与重叠，独占调用是屏障） |
| 为什么 | 串行执行让「读 5 个文件」这种典型任务平白慢 5 倍。ToolCove 的 `read` 类工具完全无副作用，是天然的并发候选。 |
| 落地 | 工具定义加 `concurrencySafe: true`（`builtins.js` 里给 `json.*`、`base64.*`、`yaml.*`、`text.diff`、`time.*`、`id.*`、`crypto.*`、`image.plan`、`file.inspect`、`file.read_text`、`file.list_directory`、`network.*` 打标——注意 `data.*` 全部不打标，因为写后广播 `data-changed`）。<br>`runtime.js` 改成：连续收集 `concurrencySafe` 的调用 → 并发执行（上限建议 4，ToolCove 面向单机开发场景，10 太大）→ 合成结果。**单步内事件顺序必须与历史顺序一致**，否则时间线会错位——DSH 的 `ABORTED_BEFORE_DISPATCH` 合成结果就是为这个服务的。<br>⚠️ 前提：当前协议**一步只产出一个动作**，「连续多个调用」需要先扩协议（模型一次返回动作数组）。所以这项实际包含协议变更，请在 P0 全部落地后再评估。 |
| 改动面 | `runtime.js`（循环结构 + 事件排序）、`builtins.js`（打标）、协议文档 |
| 风险 | 协议变更会破坏 `history` 的既有形态 → 影响 `canResume` 与历史 run 的续跑。需要版本化或兼容读取。 |
| 验证 | `runtime.test.js`：并发批内事件顺序 = 历史顺序；共享可变状态的工具（打字面打错成 safe）仍串行。 |

### P1-6　历史折叠：早期步骤摘要化而非直接丢弃

| 项 | 内容 |
|---|---|
| 借自 | DSH 的折叠语义（被遮蔽区间有权威记录）+ 技能目录的「只投 name + 截断 description」 |
| 为什么 | `history.slice(-8)` 丢掉的恰恰是「任务目标推导出的早期关键事实」。长任务里模型反复重试同一件事，很可能就是因为第 3 步的结果已经不在了。 |
| 落地 | 新增纯函数 `src/agent/history.js`：`buildHistoryView(history, {keepTail: 8, summaryBudget})` → `{ target, earlierSummary, recent }`，其中 `earlierSummary` 对早期步骤只保留 `{tool, 参数摘要(截断), 结果摘要(截断或条数), 错误}`。目标单独常驻（现在 `input` 已经在 prompt 里，不重复）。<br>配套：给每步历史记 `truncated` 标记，摘要里明确写「已折叠」。 |
| 改动面 | `src/agent/history.js`（新）、`agent/index.js` 的 prompt 拼装 |
| 风险 | 摘要也可能丢关键信息。缓解：`keepTail` 可配置，且**错误步骤与写类步骤的摘要给更高预算**（错误信息是模型纠错的主要依据）。 |
| 验证 | `src/agent/history.test.js`：短历史不折叠 / 长历史保留目标 / 错误步骤摘要不被截没。 |

### P2-7　规划过程的流式可见

| 项 | 内容 |
|---|---|
| 借自 | DSH 的流式契约（每个尝试恰好一个终止事件） |
| 落地 | 规划调用改用 `aiChatStream` + `parsePartialJson`（二者 ToolCove 已有：`ai.js` 与 `streamJson.js`），UI 在「规划中」指示器下显示正在生成的 JSON 片段。低优先，因为 `parsePartialJson` 已经在识图提取路径上验证过。 |
| 坑 | `aiChatStream` 在流式路径**不返回 usage**（`ai.js:283` 注释已说明需 `stream_options.include_usage`），而 tool 用量计量依赖非流式。改流式要么补 `include_usage`，要么接受用量缺口——**别默默丢计量**。 |

### P2-8　可续跑检查点显式化

| 项 | 内容 |
|---|---|
| 借自 | DSH `dsh-session-checkpoint-policy`（三道屏障：模型流构造前、工具体执行前、每个 `agent/pre-step`，失败关闭） |
| 现状 | ToolCove 用 `canResume` 做**保守拒绝**（含写类步骤就不给续跑）。这个「拒绝」是对的，但代价是用户拿不到任何续跑能力。 |
| 落地 | 每步完成后记 `checkpoint = {stepIndex, historyLength, sideEffects: n}`；只有「所有副作用步骤都发生在检查点之后且未重放过」时才允许续跑。即把 canResume 从「整段历史不含写」放宽到「最后一个写之前的部分可以重放」。 |
| 风险 | 这条最容易做错——错一次就是重复副作用。**如果本轮只做 P0/P1，建议明确保持现状的保守拒绝**，把它列为独立课题。 |

### P2-9　写前预览接入

`file.preview_write` 工具已实现却**没有任何地方自动调用**（模型要自己想到才用）。可在 `approval.js` 里加规则：`file.write_text` 的确认卡附带一次 `file.preview_write` 的 diff 结果。DSH 的对应机制是 `DiffCallView`（`presentation.d.ts` 的 23 种 render intent 之一）。纯 UI 收益，成本低。

### 修正一个文档偏差

`docs/agent-architecture.md` 第 30 行的 MVP 描述里写「（建议 12 步）」，而 `settingsConfig.js:74` 的 `normalizeAgent` 默认值确实是 12、`runtime.js:70` 的 `bounded` 兜底也是 12、`AGENT_MAX_STEPS_HARD_CAP = 50`——**代码与文档一致，此处无偏差**，保留记录以免后续重复核对。

---

## 4. 不建议借鉴（明确划界）

| DSH 机制 | 为什么不借 |
|---|---|
| **事件溯源 session log + `SESSION_FORMAT_VERSION = 3` + 三个冻结迁移边（v0→v1→v2→v3）+ `seq = log.length` 不变量** | 这是一整套「历史必须逐字节可重放」的工程，配套 22 个 `session-*` 包、35 个 invariant 文件。ToolCove 的持久化是 `saveToolbox('agentRuns')` + 浏览器 IndexedDB，量级差两个数量级。**借它的结论（结果要可追溯），不借它的实现。** |
| **cordis 插件体系**（240 包、70+ 服务、fiber 作用域、seam/provider 二分、`cordis.patch.yml` profile 装配） | ToolCove 的技术栈明确写着「No router / state library / UI framework」。引入依赖注入容器会摧毁这个项目最大的优势：可读、可测、零框架。反证很有意思：DSH 自己的 `dsh-sdk-minimal` 只用 31 行装配就够跑，说明**最小可用不需要这套体系**。 |
| **内核级沙箱**（bwrap / Landlock / Seatbelt / Windows ACL + 功能性探测 + 失败关闭） | 三平台内核设施 + 探测逻辑，工作量远超本项目。ToolCove 的边界是 Tauri 命令 + `desktopOnly` 过滤 + 风险确认。**但「失败关闭」的态度要借**：宁可拒绝执行也不无约束放行。 |
| **三个独立的 worker/VM 系统**（`dsh-workflow-worker-thread` / `dsh-code-runtime-worker-thread` / `dsh-cordis-host-runner`） | 三者都**自认不是安全边界**（`dsh-code-runtime-worker-thread` 的 README 与 `.d.ts` 里声明了四次）。ToolCove 没有「执行模型写的代码」这个需求，没有对应风险。 |
| **MCP / hooks / ACP / SDK（JSON-RPC）** | `docs/agent-architecture.md` 已把 MCP 列为待办。建议**保持待办**：MCP 客户端是 `dsh-mcp-client` 整个包，且 DSH 自己也只支持 `tools/list` + `tools/call`（resources 和 prompts 不支持），不是低垂果实。 |
| **subagent / workflow / Ralph / goal** | 面向「一个长任务拆成多智能体跑几小时」的场景，与 ToolCove「本地开发小动作」的定位不符。其中唯一有边角价值的是 `dsh-repeat-tool-reminder`（已并入 P1-6 的动机）。 |
| **计划模式** | DSH 自己写明「不限制 agent，需要硬限制请用沙箱和审批」。ToolCove 没有沙箱兜底，做「只提示不强制」的计划模式会给出虚假的安全感。 |
| **把 `JsonSchemaNode` 收窄到无 `minItems`/`pattern`/`format`** | DSH 收窄 schema 语言是**有意为之**（保证跨 provider 兼容）。ToolCove 的 `validateArgs` 目前支持 `minimum/maximum/maxLength/maxItems/enum`，而且 `builtins.js` 大量使用它们（`count ≤ 100`、`port ≤ 65535`、`maxHops ≤ 10`）。**不要为了对齐 DSH 而削弱自己的校验。** |

---

## 5. 落地顺序与验收

| 批次 | 项 | 依赖 | 预估改动 | 验收 |
|---|---|---|---|---|
| 1 | P0-1 逐次批准 + 审计 | 无 | ~120 行 + 测试 | 同类写操作第二次仍询问；时间线可见成对审计事件 |
| 1 | P0-2 读后写门禁 | 无 | ~80 行 + 测试 | 未读文件拒写并给出可自救文案；不存在文件可创建 |
| 1 | P0-3 响应鲁棒化 | `ai.js` 错误分类 | ~100 行 + 测试 | 围栏/前后缀 JSON 能解析；非 JSON 重试后仍失败则按现状报错 |
| 2 | P1-4 结果分层保留 | P0-3（错误路径统一） | ~100 行 + `file.read_text` 分页 | 中结果头尾保留；大结果落盘且路径可读回 |
| 2 | P1-6 历史折叠 | 无 | ~90 行 + 测试 | 长历史保留目标与错误步骤摘要，不再静默丢失 |
| 3 | P2-7 流式 / P2-9 写前预览 | — | 各 ~50 行 | 规划期有内容；写确认卡带 diff |
| 3 | P1-5 并发 | 协议变更 | ~150 行 + 协议版本化 | 批内事件顺序与历史一致 |
| 独立课题 | P2-8 检查点续跑 | 需专门设计 | ~200 行 | 续跑绝不重放副作用 |

**每批完成后的固定动作**：
1. 跑 `npm run test`（全量，不只 `src/agent`）。
2. `src/i18n/i18n.test.js` 会强制 zh-CN / en-US 键数对齐——新增 `agent.*` 词条时两语言必须同批。
3. 更新 `docs/agent-architecture.md` 的「落地状态」段（该段头部已写明「与代码同步，改代码时一并维护」）。
4. 新增错误码要同步登记到 `AgentView.vue` 的 `ERROR_KEY`，否则 UI 会退化成显示引擎的中文原文。

---

## 6. 本地验证

本次会话**无法**运行 ToolCove 的测试套件（沙箱限制，见 §0）。请在本地执行：

```bash
cd E:\develop-lcb\workspace-tools\ToolCove
npm run test                                  # 全量单测
npx vitest run src/agent                      # 只跑 agent 模块（改造前 9 文件；现 12 文件）
```

改造涉及的测试落点（沿用 `runtime.test.js` 的既有写法：构造最小 registry + 脚本化 planner + 断言事件序列）：

| 新增/修改 | 覆盖点 | 状态 |
|---|---|---|
| `src/agent/approval.test.js`（新） | 三策略 × 首调/重复调；`confirm:'always'` 不可被 `never` 绕过；拒绝记账后不再追问 | ✅ 已写 |
| `src/agent/observation.test.js`（新） | 未观察拒写 / 观察后放行 / 不存在文件允许创建 / `inspect` 只证明存在 / `paths` 数组形状 / 路径大小写 | ✅ 已写 |
| `src/agent/index.test.js`（新） | 宽松解析三种输入；修复重试有界；带 code 的错误不重试 | ✅ 已写 |
| `src/agent/runtime.test.js`（改） | 换参数必重问；同参数折叠；拒绝回灌；审计成对；门禁；退避重试；被拒不重复追问 | ✅ 已改 |
| `src/agent/session.test.js`（改） | 门禁先于传输层；审计进时间线；`callId` 进 pending；修复过程可见 | ✅ 已改 |
| `src/agent/history.test.js`（新） | 短历史不折叠 / 长历史保留目标 / 错误步骤摘要不被截没 | ⬜ P1-6 待写 |

**本次验证做了什么、没做什么（务必如实理解）**：

1. **没能跑 vitest**（沙箱限制，`esbuild` 的 `spawn EPERM`，两种受限模式皆然）。
2. 作为替代，把 `src/agent` 的依赖闭包复制到临时目录、把 npm 包/i18n/JSON 换成替身，
   **直接 import 真实的 `runtime.js` / `index.js` / `approval.js` / `observation.js` / `timeline.js`**，
   用 `node:assert` 跑了 **15 项行为断言，全部通过**。这一步是真实执行，不是阅读代码后的推断。
   替身只覆盖外部依赖（`js-yaml`、`diff`、`tauri invoke`、`i18n`、`builtins.js`），本次断言不依赖它们。
3. **仍需在本地跑 `npm run test` 确认全量绿**——尤其是 `AgentView.vue`（无组件测试）与
   `builtins.js` 里新改的工具描述文案，这两处本次没有被执行到。
4. `i18n.test.js` 的键对齐已单独核对：zh-CN / en-US 两边 flat key 数量一致（合并 v0.6.0 后为 2637），无单边键。
   与 v0.6.0 一起进来的 `toolbox.rail.*` 169 键和本次新增的 16 个 `agent.*` 键共存——合并后 i18n 差异为
   **纯新增、零删除**，且 v0.6.0 新加的 `ADVICE_KEYS` 校验（10 条）在合成后的字典上全部满足。

**验证脚本抓到的 5 个真实缺陷（均已在实现内修正，测试已补）**：

| # | 缺陷 | 后果 |
|---|---|---|
| 1 | `requestApproval` 只在批准时调用 `record()` | 拒绝不记账 → 模型原样重试同一调用时**对同一张卡片反复追问**（实测 5 次），把步数预算耗在重复确认上 |
| 2 | `evaluate` 里 `denied-before` 判定放在 `confirm:'always'` 之后 | 「必须人工确认」的工具即使已被拒绝也仍会重复追问 |
| 3 | `observeSuccess` / `observeFailure` 只读 `args.path` | `file.inspect` 的参数是 `paths`（数组）→ **inspect 永远登记不上**，「先 inspect 证明不存在再创建」这条官方指路走不通 |
| 4 | `namesPath` 用字符串全等比较路径 | `C:/tmp/A.txt` 与 `c:\tmp\a.txt` 认不出是同一文件 → 同一文件被反复要求重读 |
| 5 | `canonicalJson` 直接 `JSON.stringify` 原语 | **折叠键碰撞**：`JSON.stringify` 会省略 `undefined`、把 `NaN`/`Infinity` 压成 `null`、把 `Date` 压成 `{}` → `{x: undefined}` 与 `{}` 算出同一个键。而折叠键决定「要不要问人」，**碰撞的代价是误放行**——一次批准被内容不同的调用复用，正是本次改造要堵的洞 |

前 4 条是「只读代码看不出来」的那类问题——都藏在真实参数形状与 Windows 路径大小写里。
第 5 条是提交前自查抓到的：原语序列化的碰撞在正常路径上碰不到（模型产出的是 JSON），
但它是安全机制的核心函数，**不能靠"输入不会长这样"来保证正确**。现在 `undefined` / `NaN` /
`Infinity` / `Date` / 非有限数都显式标出，并补了 5 组碰撞回归用例（含端到端：`{x:undefined}`
被批准后 `{x:null}` 仍必须重新问）。

---

## 附：DSH 侧关键常量速查（供后续设计参考）

| 常量 | 值 | 出处 |
|---|---|---|
| `maxParallelToolCalls` | 10 | `dsh-agent-loop/lib/types/constants.d.ts` |
| spill 触发 `maxInlineBytes` | 50000（base 装配值） | `dsh-spill-policy` |
| prune `thresholdChars` / `headChars` / `tailChars` | 8192 / 4096 / 1024 | `dsh-compaction-tool-result-pruner` |
| compact `thresholdRatio` / `retainRatio` | 0.8 / 0.16 | `dsh-compaction-basic` |
| LLM 重试 `maxRetries` / `initialDelayMs` / `maxDelayMs` / `jitterRatio` | 5 / 500 / 10000 / 0.1 | `dsh-llm-retry` |
| token 估算 `CHARS_PER_TOKEN` | 4 | `dsh-token-meter` |
| 重复调用提醒阈值 | `[3, 5, 8]` | `dsh-repeat-tool-reminder` |
| 技能目录描述截断 | 500 字符 | `dsh-skill-filesystem` |
| 子 agent 深度上限 | 3 | `dsh-tool-subagent` |
| 审批决策枚举 | `allowed-once \| rejected \| cancelled \| unavailable` | `dsh-user-approval` |
| 沙箱默认 mode | `read-only` | `dsh-sandbox-policy` |
