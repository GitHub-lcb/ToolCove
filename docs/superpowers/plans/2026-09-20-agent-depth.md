# Agent 纵深改造方案：结果预算 · 历史折叠 · 写前预览 · 技能库

日期：2026-09-20 · 状态：P0 进行中 · 关联：`docs/agent-dsh-borrow.md`（P1-4 / P1-6 / P2-9 与 F3）、`docs/agent-architecture.md`

## 1. TL;DR

`docs/agent-dsh-borrow.md` 里最该做、也最容易做错的一批（P1/P2）至今仍未落地。本方案按「先让一步不白做 → 再让上下文不被挤掉 → 再让确认卡看得见 → 最后让经验可复用」的顺序分四期：

| 期 | 内容 | 一句话验收 |
|---|---|---|
| P0 | 工具结果分层保留 + 分段读取 | 大结果不再让整步失败，模型能自己把完整结果读回来 |
| P1 | 历史折叠摘要化 | 长任务早期关键事实（尤其错误）不再被 `slice(-8)` 丢掉 |
| P2 | 写前预览接入确认卡 | 写文件的确认卡直接显示 diff，而不是只报一个路径 |
| P3 | 技能库雏形 | 一次成功的运行能沉淀成「下次自动带上」的技能 |

四期都保持既有形态：**纯 JS 模块 + vitest 单测**，runtime 不引平台依赖（I/O 由注入的钩子完成）。

**进度**：P0 ✅ · P1 ✅ · P2 ✅ · P3 ✅ —— 四期全部落地，**92 文件 / 1312 用例全绿**，`npm run build` 与 `npm run build:web` 双端通过。
待人工：桌面端真写一次文件核对 diff 与落盘内容、浏览器端读回 spill、点一次「沉淀为技能」看词条与开关（单测只覆盖引擎与整形层，GUI 行为需实机确认）。

## 2. 现状（均已核对代码）

- `runtime.js:276`：`if (JSON.stringify(value ?? null).length > maxOutput) throw Error('工具结果过大，请缩小输入后重试')`。
  `maxOutput` 默认 32000（`runtime.js:117`，硬上限 100000）。**超限 = 这一步白做**，而且模型拿不到任何「怎么做才对」的提示。
- `file.read_text`（`builtins.js:28`）**没有 offset/limit**：整文件一次返回，10 MB 上限（`file_tool.rs:119`）。
  所以「完整结果已存至某文件，去读它」这句话在现状下是空头支票——一读又会撞上限。
- `index.js:44`：`历史：${JSON.stringify(history.slice(-8))}`。第 9 步之前的一切（包括失败原因）直接消失。
- `file.preview_write`（`builtins.js:30`）已实现、已声明「会读内容因此满足读后写门禁」，但**没有任何地方自动调用**。
- 扩展模型（F3）：24 个静态工具，只能减不能加；没有「上次这么干成了」的复用通道。

## 3. P0：结果分层保留 + 分段读取

### 3.1 新增 `src/agent/resultBudget.js`（纯函数）

对标 DSH 的 spill → prune → compact，落成三级：

```
size = safeJsonSize(value)            // JSON 长度，循环引用/不可序列化有兜底
size ≤ maxOutput                      → { kind:'keep', value }
maxOutput < size ≤ maxOutput*4        → { kind:'clip', ... }   头尾保留 + 省略标记
size > maxOutput*4                    → { kind:'spill', text } 交给 spill 钩子落盘
```

- **预留提示文字自身的字节数是这项的关键**（DSH 的教训）：标记文本先按最终形态算进去，超预算就按比例收窄头尾，再做一次校验——保证 `safeJsonSize(结果) ≤ maxOutput` 恒成立，而不是「大概不超」。
- `safeJsonSize`：`JSON.stringify` 对 `undefined` 返回 `undefined`，对 BigInt 抛错，对循环引用抛错。三者都兜成 `String(value).length`，绝不因为「量个长度」把一步工具调用弄失败。
- 非字符串结果（对象/数组）裁剪时输出字符串：`"<头部>\n…[已省略 N 字符，原长度 M]…\n<尾部>"`。

### 3.2 runtime 接线（`runtime.js`）

- 超限分支换成分层执行：`clip` 直接进历史并落 `{type:'tool_result', clipped:true}`；
  `spill` 调注入的 `options.spill({ tool, text, size, maxOutput })`。
- **spill 是注入钩子，不是 runtime 里的 I/O**：runtime 保持无平台依赖、node 环境可单测（写盘在 `session.js` 侧实现）。
- spill 成功 → 历史里放 `{spillRef:{key,chars}, note:'完整结果已保存为 spill:<key>（N 字符）。用 spill.read 分段读取，带 keyword 可直接定位。'}`，并落 `{type:'tool_spill'}` 事件；
  spill 失败或未注入（浏览器/测试）→ **降级为 clip**，不失败。宁可少信息，不可白做一步。
- 新事件都进 `timeline.js` 折叠（`tool_spill` / `tool_clip` 作为该工具卡的可见标记）。

### 3.3 新增 `src/agent/readWindow.js`（纯函数）

- `createReadWindow(text, {offset, limit})` → `{ text, offset, nextOffset, totalChars, windowLine, totalLines, hasMore, truncated }`。
- `windowNote(meta)`：截断时给模型的**可执行**提示（剩余多少字符、下次 offset 填多少、带 keyword 怎么用）。
- `clampWindow`：offset/limit 越界一律夹取，绝不抛错（模型给负数/超大值是常态）。

### 3.4 读回通道（同一批做，否则 spill 是死路）

- `file.read_text` 加 `offset` / `limit`：整文件读出后**在 JS 侧开窗**（Rust 命令契约不变，双端一致）。
  返回体补 `window`/`hasMore`/`nextOffset`/`note`。Rust 侧原生 offset/limit 留作后续优化（避免动已发布的 IPC 契约）。
- 新增 `spill.read` 工具（`risk:'read'`，双端可用）：`{key, offset?, limit?, keyword?}` → 命中带行号片段，未命中带关键词提示。
- `spill.list` 只进能力面板说明，不单独开工具（避免工具爆炸）。

### 3.5 实现状态（2026-09-20）

- 新增模块：`src/agent/resultBudget.js`（24 用例）、`src/agent/readWindow.js`、`src/agent/spillStore.js`。
- `runtime.js`：新增 `retainResult()`（分层收口，替代原来的「超限即抛」）、`budgetEvent()` 包装所有出站事件、
  写前预览钩子（含「预览成功也算内容观察」）。
- `builtins.js`：`file.read_text` 加 offset/limit 与 `concurrencySafe` 标记；新增 `spill.read`；
  导出共用 `spillStore`（否则 runtime 写入的 key 工具读不到）。
- `session.js`：注入 `spill`（落盘）与 `preview`（读旧内容做 diff）两个钩子；`pending.preview` 供确认卡渲染。
- **与 §3.2 的三处偏离（都有理由）**：
  1. **spill 落盘走 `platform/invoke` 的 save_data/load_data**，不用临时文件、也不复用 `toolboxStore`：
     前者要动 Rust 契约，后者在 Node 单测环境（无 localStorage/IndexedDB）会静默失败。走 invoke 双端一致、可注入可断言。
  2. **正文删除只摘索引**：桌面端没有「按 key 删文件」的命令，够不着就不假装够得着（孤儿文件不进任何读取路径）。
  3. **事件载荷也收预算**（原方案只提到历史）：发出去的 `tool_result` 带的是原始对象，
     5 MB 结果会顺着 `session.steps` 进 DOM 与持久化 run。上限 8000，标记 `payloadClipped`。
- 口径坑（已在代码注释里固化）：**裁剪结果本身是字符串，`safeJsonSize` 会多算两个引号**，
  所以「不变量 = payload ≤ 预算 + 2」；整齐 JSON 的换行转义还会再加约每行 1 个字符，
  因此严格裁剪要按 `safeJsonSize` 收口（`clipToBudget` 的 `strict`），只按字符数收会在写入 run 时超限。
- 回归：全量 **88 文件 / 1252 用例全绿**（P0 新增 45 用例）；`npm run build` 与 `npm run build:web` 双端通过。
  期间抓到并修掉 3 个真实缺陷：`clipToBudget` 忘了初始对半分（头尾恒为空）、
  事件预算与字符数口径差 2 个字符的假报警、`retainResult` 引用了未定义的 `args`（异常被 catch 吞成静默降级）。

## 4. P1：历史折叠摘要化

新增 `src/agent/history.js`：

- `buildHistoryView(history, {keepTail=8, summaryBudget=1500})` → `{ folded, recent, note }`；
  早期步骤只保留 `{tool, args 摘要, 结果摘要/条数, error}`，目标本身常驻 prompt 不重复。
- **错误步骤与写类步骤给更高预算**：错误信息是模型纠错的主要依据（DSH 明确点过）。
- 摘要里显式写「已折叠」，不让模型误以为完整。

`index.js` 的 `buildPrompt` 换成用 `history.js` 的输出，并保留 `repairs` 段。

**实现状态（2026-09-20）· ✅ 已完成**

- `src/agent/history.js`（14 用例）：`summarizeStep`（一行式摘要：调用 X · 参数 … · 结果 …／失败 …）、
  `stepWeight`（错误与写类步骤 = 3 倍权重）、`buildHistoryView`、`historyPromptText`。
- 预算分配刻意两步走：**先把每行压成摘要，再按权重分配**——全部均分会把「第 3 步为什么失败」
  截成半句，而那正是模型纠错唯一能依据的东西；宁可把成功行的结果摘要压得更短。
  补完剩余预算时错误行因权重高而先被补满。
- `index.js`：`buildPrompt` 改用 `historyPromptText`，`createAIPlanner` 透传 `keepTail` / `summaryBudget`；
  `index.test.js` 补 3 用例（长历史进 prompt 是摘要且带「已折叠」、短历史仍是原文、参数可覆盖）。

## 5. P2：写前预览接入确认卡

- runtime 在 `file.write_text` 类调用（`tool.previewBefore === true`）进入批准门禁时，先执行预览钩子，把 diff 与新旧文本一并塞进确认事件：
  `{type:'approval_asked', ..., preview:{path, diff, oldText, newText}}`，并透传到 `options.confirm(message, meta)`。
- 预览失败**不阻断**批准（读不到旧文件也得允许用户决定）。
- UI：`AgentView.vue` 的确认卡在加参数区内联渲染 diff（复用 `textDiff.js` 的输出结构），长 diff 沿用既有折叠阈值。

**实现状态（2026-09-20，引擎侧已完成）**

- 新增 `src/agent/preview.js`（12 用例）：`summarizePreviewRows` 只取**改动附近**的行（上下文 1 行、上限 40 行），
  并给出 `hidden` 让 UI 说明这是节选——只截前 N 行会让「改动在文件末尾」这种最常见的情况看不见。
- `runtime.js`：`previewBefore` 的工具在问人之前调 `options.preview`；`preview` 进 `approval_asked` 事件与 confirm meta；
  预览抛错只当没有 diff；**预览成功（`isNew` 为假）同时登记为内容观察**——
  否则会出现「看着 diff 点了允许、执行时却被读后写门禁拦住」这种自相矛盾的体验（这条有专门用例）。
- `session.js`：`previewWrite()` 读旧内容 + 生成 diff；读不到时归为「新建」并带 `readError`（人有权知道为什么没有旧内容）。
- `AgentView.vue`：确认卡新增预览块（路径 / 新建或未变化标记 / +n−n / 行号 + 语义底色 / 节选说明）；
  `timeline.js` 把 `preview` 挂到 approval 条目上；i18n 两语言补 7 键。
- 待人工：桌面端实际写文件一次，确认 diff 与最终落盘内容一致（单测只覆盖引擎与整形层）。

## 6. P3：技能库雏形

新增 `src/agent/skills.js`（纯函数）+ `src/agent/skillStore.js`（持久化）：

```js
{ id, name, description, instructions, keywords[], toolNames[], createdAt, sourceRunId }
```

- `extractSkill(run)`：从成功运行生成技能（名称取目标截断，instructions 由目标 + 工具调用链 + 关键参数拼装）。
- `matchSkills(skills, goal, {limit:3})`：关键词/名称/描述打分，阈值以下不注入（宁可不带，不可乱带）。
- **目录只投 name + 描述**（DSH 的做法）：只有命中的技能正文进 prompt，控制 token。
- `buildSkillSection(matches, {maxChars})`：正文截断。
- 存储：`tc.skills`，上限 50 条、单条 8000 字符（`skillStore` 裁剪）。
- UI：运行结束后出现「沉淀为技能」按钮；能力面板下列技能清单（可删除/停用）。
- 设置：`settings.agent.disabledSkills[]`（沿用 normalizeAgent 的钳制风格）。

**实现状态（2026-09-20）· ✅ 已完成**

- `src/agent/skills.js`（24 用例）+ `src/agent/skillStore.js`（9 用例）：
  - `extractSkill` 只在**跑成功 + 用过至少一个工具 + 正文够长**时才产出技能（失败/取消不沉淀，
    纯问答不沉淀）——拒绝也是一种能力，技能库不该变成日志。
  - `matchSkills` 打分：关键词命中 ×2（中文取二元组、拉丁取 ≥3 字母词，两边都过停用词表）、
    名称/描述整体命中 ×3、工具短名命中 ×1；阈值 `SKILL_MIN_SCORE = 3`，最多 3 条。
  - **匹配只吃用户自己的话**（目标原文、工具名、参数键），不吃 i18n 文案——否则切语言会改变命中结果。
  - `skillsPromptSection` 预算裁的是**整条**而不是条目内部：宁可少带一条，不要一条只带半句。
  - 落盘边界 `validateSkill`：整体 8000 字符，超了按「工具名 → 关键词 → 正文」依次收紧，
    直到真的落进预算——JSON 转义与键名也占字节，靠估算留余量迟早会有漏网的组合（实测抓到过一次）。
- 持久化：`skillStore.js` 复用 toolboxStore（桌面落应用数据目录、浏览器落 IndexedDB），
  读取与写入都过一遍归一；**同名技能视为同一条**（更新而不是堆叠，保留原 id 与创建时间）。
- 注入：`createAIPlanner({ skills, disabledSkills })` 把命中技能放进 prompt（`src/agent/index.js`），
  并写明「仅供参考、参数必须重新核对」；`session.launch` 每次运行前刷新技能库（读失败不拦运行）。
- 设置：`normalizeAgent` 增 `disabledSkills`（只做形状/去重/条数约束，不做存在性校验——
  技能 id 由用户沉淀产生，找不到的在匹配阶段自然被忽略）。
- UI：最终答复卡上的「沉淀为技能」；右栏新增可折叠「技能库」（条数徽标 + 每条的开关与删除）。
- 渲染冒烟：新增 `src/AgentView.render.test.js`（5 用例，SSR + mock session）兜住视图层——
  时间线含新事件、确认卡含 diff 预览、技能库折叠不把正文塞进首屏、词条缺键不漏 key 原文。

## 7. 影响面

| 区域 | 文件 |
|---|---|
| 新增 | `src/agent/resultBudget.js`(+test)、`src/agent/readWindow.js`(+test)、`src/agent/history.js`(+test)、`src/agent/skills.js`(+test)、`src/agent/skillStore.js`(+test)、`src/agent/spillStore.js`(+test)、`src/agent/preview.js`(+test)、`src/AgentView.render.test.js` |
| 修改 | `src/agent/runtime.js`（分层结果 + 预览钩子）、`src/agent/builtins.js`（分段读取 + `spill.read`）、`src/agent/index.js`（历史视图 + 技能段）、`src/agent/timeline.js`（新事件折叠）、`src/agent/session.js`（注入 spill / 技能装配 / pending 预览）、`src/settingsConfig.js`（disabledSkills）、`src/AgentView.vue`（确认卡 diff + 沉淀按钮 + 技能库）、`src/i18n/{zh-CN,en-US}.json`、`docs/agent-architecture.md` |
| 不动 | Rust 侧 IPC 契约（本期不改签名与命令名） |

## 8. 验收与回归

- 单测：三级分层的边界（正好等于上限 / 上限+1 / 4×上限 / 4×上限+1）、提示文字预留字节、循环引用与 BigInt 兜底、offset/limit 夹取、spill 失败降级、历史折叠保留错误、预览失败不阻断、技能匹配阈值与「关掉不注入」。
- 端到端：`runtime.test.js` 补「大结果不失败、模型能读到 spill 引用」「写文件确认卡带 preview」；`index.test.js` 补「命中技能进 prompt / 不相关不注入」。
- 实测结果：全量 **92 文件 / 1312 用例全绿**（起点 84 / 1169，本期新增 143 用例）；`npm run build` 与 `npm run build:web` 双端构建通过。
- 仍未自动化：GUI 实机行为（写文件核对 diff、spill 读回、技能按钮与开关）——见文首「待人工」。

## 9. 边界（本期不做）

- MCP、定时任务（沿用既有待办）。
- Rust 侧 `file_tool_read_text` 的原生 offset/limit（先保契约稳定）。
- 多动作协议与只读工具并发（`agent-dsh-borrow.md` P1-5，需协议变更）。
- 可续跑检查点放宽（P2-8，做错一次就是重复副作用）。

## 10. 期间修掉的既有缺陷（非本期方案内容）

1. **`ask_user` 永远拿不到答案**（用户实测发现）：它复用了工具确认那条路（`options.confirm`），
   返回值只被当布尔用，UI 也只画「允许 / 拒绝」——点「允许」等于把 `true` 当答案回灌，
   模型只能把同一个问题再问一遍。实测场景：让它比较两个文件，它问「两个文件的绝对路径」，
   点允许之后它还是问路径（截图见用户反馈）。修复：拆成两条路径——工具确认 `confirm` → 布尔；
   提问 `askUser` → 文本（`session.answerPending` + 提问卡输入框 + 空回答不发）。
   用例：`runtime.test.js` 的「ask_user 的回答是文本」3 条、`session.test.js` 的「ask_user 的文本回答」4 条、
   `AgentView.render.test.js` 的提问卡渲染 1 条（断言提问卡上不出现「允许/拒绝」按钮）。
