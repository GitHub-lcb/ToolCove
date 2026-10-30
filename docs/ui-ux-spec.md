# ToolCove UI/UX 规范

日期：2026-10-20 · 状态：**现行**（与代码同步，违规由守卫拦截）
真相源：[src/styles/tokens.css](../src/styles/tokens.css)（令牌）·[src/styles/primitives.css](../src/styles/primitives.css)（桌面组件）·[mobile/app/styles/shell.css](../mobile/app/styles/shell.css)（手机端组件层，不引 primitives）·[src/styles/uiSpec.test.js](../src/styles/uiSpec.test.js)（守卫）
关联：[ui-upgrade-progress-and-constraints.md](ui-upgrade-progress-and-constraints.md)（改造过程与踩坑）

**怎么用它**：动手前查 §3 组件词汇表决定用哪个族，取数值只看 §2 的令牌；
写完把 §13 清单贴进 PR 逐条打勾；卡在某条"到底能不能这么写"时，先按 §0 判断它属于
硬性 / 棘轮 / 走查 哪一类——**这条要求有没有守卫，决定了它会不会被下一个人悄悄改掉**。
**要改规范本身**（加令牌、加组件族、加指标）看 §14，那里写了每步该跑哪条命令、
以及为什么基线数字不许手改。手机端先看 §9：它不是桌面的缩小版，是另一套组件层。

---

## 0. 先说这份规范凭什么生效

写规范这件事在本仓已经失败过一次：`globals.css` 的注释里写着"新代码请直接用 `.tc-*` 类"，
实测全仓 `.vue` 里兑现了 **11 处**，同时 `globals.css` 自己另抄了一份数值并开始漂移
（同一个"主按钮"，旧名 `padding: 9px var(--sp-6)`，新名 `height: var(--control-h)`）。
**一句没人执行的注释，比没有注释更糟**——它让下一个人以为已经有标准了。

不是每条要求都能机器判定——所以明确分三种拦截强度，**写在规范里的每条要求都要指明它属于哪一种**，
否则就会变成第二份"新代码请用 `.tc-*`"：

| 拦截方式 | 含义 | 例子 | 谁执行 |
|---|---|---|---|
| **硬性**（当前必须为 0） | 已经全部合规，新增即红灯 | 全局 z-index 走 `--z-*`；遮罩底色走 `--overlay` / `--overlay-strong`；桌面端不许自写遮罩底座与组件底座骨架；组件底座只在 primitives.css 定义；`.vue` 用到的 `tc-*` 必须有定义；每个对话框都有 dialog 语义且 `vDialog` 已就地 import；纯图标按钮都有可访问名；每个界面都有 aria/role 语义（豁免须写理由）；每个 `<th>` 都有 `scope`；凡是会被 `:disabled` 用到的按钮都要有禁用态口径（两端分层判）；toast 容器是 live region；App.vue 里不出现裸的外壳尺寸；JS 里抄写的令牌 hex 必须等于 `tokens.css` 的浅色值；**规范自己的刻度表也必须等于 `tokens.css`**（它是生成物）；同一个类不许把同一个属性写两遍（`duplicateCssProps`，桌面两层 + 手机 `shell.css` 一起扫） | `uiSpec.test.js`（`npm test`，25 项指标里 16 项当前为 0） |
| **棘轮**（≤ 基线） | 存量还没清完，但**不许新增** | 裸色值 14、裸字号 26、刻度外间距 301、刻度外圆角 58、零引用原语 65、换名字的自造组件 14、手机自写遮罩底座 1、视口断点 17 种、图标尺寸 20 种 | `uiSpec.test.js` + `uiDebtBaseline.json`（数字由守卫自己生成，不许手改） |
| **实测 / 走查** | 机器判不了或判起来噪声太大 | 文本对比度与焦点可见性（`e2e/specs/21-ux.spec.js` 实测）；空态副文案是否给了下一步；破坏性操作是否配确认；错误提示是否在提交前出现、按钮是否在等待时禁用；画出来的拖放区在桌面形态是否真收得到文件 | e2e + §13 自检清单，评审时逐条打勾 |


棘轮基线存在 [src/styles/uiDebtBaseline.json](../src/styles/uiDebtBaseline.json)，
由守卫自己生成（`UPDATE_UI_BASELINE=1 npx vitest run src/styles/uiSpec.test.js`）——
**数字不由人填**，避免"顺手把上限改大"。只在真的降了债务之后刷新，刷新前先看 `git diff`。

配套的既有守卫：[cssVars.test.js](../src/styles/cssVars.test.js)（变量双向引用 + 两套深色分支集合一致）、
[mobileTokens.test.js](../mobile/app/mobileTokens.test.js)（手机端令牌别名）、
[i18nCoverage.test.js](../src/i18nCoverage.test.js)（12 个受管界面必须走字典）、
[e2e/specs/21-ux.spec.js](../e2e/specs/21-ux.spec.js)（对比度与焦点可见性实测）。

> 每条守卫都必须**证明它会红**。本规范的 **25 项指标全部**做过注入验证：
> 塞进一个 `__UiSpecProbe.vue`（含 `z-index: 250`、`.probe-mask{position:fixed; inset:0; background:rgba(...)}`、
> 未定义的 `tc-ghost-but-not-real`、`.empty{padding:33px}`、`font-size:15px`、`border-radius:7px`、
> `:size="27"`、`@media (max-width: 643px)`、一个没 import 指令的 `v-dialog`、
> 一个不带 `title`/`aria-label` 的图标按钮、一个不带 `scope` 的 `<th>`），
> 再往 `App.vue` 注一行 `.probe-shell{width:280px;height:48px}`——
> 一次性让 6 条棘轮 + 多条硬性同时变红；撤销探针后 48 条用例全绿。
> 还有一条**不看代码、看文档**的用例：§2.1 那张刻度表是 `npm run gen:ui-scale` 从 `tokens.css` 生成的，
> 守卫逐条比对——临时把 `--fs-base` 改成 15px，它就红并告诉你跑哪条命令（改回来又全绿）。
> **规范抄代码是本仓漂过两次的老毛病**（`globals.css` 抄按钮几何、`DomainView` 抄令牌 hex），
> 而文档抄错了守卫原本管不着——现在管得着了。
> 新增的"禁用态口径"这条（`disabledWithoutAffordance`）用另一种方式验过——**撤掉已有口径**而不是注入违规：
> 手机侧删 `shell.css` 的 `.m-chip[disabled]`，硬性用例与棘轮用例同时红并点名
> `SettingsView.vue` / `SchemaToolView.vue`（`KbToolView.vue` 不在名单里，因为它自己的 scoped 块里有口径）；
> 桌面侧删 `primitives.css` 的 `button:disabled` 底线，同一个指标报出 6 处并点名
> `AgentComposer` / `App.vue` / `DbConnModal` / `TaskView` 那批自造名。两次还原后都全绿。
> 最后加的三条各验过一次：删 `mobile/app/SettingsView.vue` 的指令 import → `fieldErrorDirectiveNotImported` 红并点名该文件；
> 临时改 `--fs-base` 的取值 → 刻度表那条用例红并告诉你跑 `npm run gen:ui-scale`；
> 保留手机层那 12 条重复定义不清 → `duplicateCssProps` 直接列出 `shell.css m-bar.height` 等条目。
> **凡是写"证明过"的地方，都留了"怎么再证一次"的线索。**
> 过程与被守卫抓出来的判据错误记录在 [ui-upgrade-progress-and-constraints.md](ui-upgrade-progress-and-constraints.md) §九。

---

## 1. 三层结构：谁住在哪里

```
引入顺序（main.js）：tokens.css → primitives.css → globals.css
```
顺序**不能反**：`globals.css` 里是应用外壳件与 body 基线，若它先于 primitives 引入，
同名类会落到错误的一份定义上（这条踩过，见约束文档 §一.3）。

| 层 | 文件 | 装什么 | 不许装什么 |
|---|---|---|---|
| 令牌 | `styles/tokens.css` | 色阶/字号/圆角/间距/动效/层叠/控件高度；浅深两套 | 任何选择器、任何组件 |
| 原语 | `styles/primitives.css` | **组件样式的唯一出处**：按钮、弹窗、空态、加载、徽标、开关、进度条、表单、工具条、列表项、代码块、提示条 | 业务专属类、页面布局 |
| 应用级 | `styles/globals.css` | `<body>` 基线与背景氛围、滚动条、右键菜单、弹层过渡、工具演示聚光 | 组件底座（本轮已全部搬走） |
| 视图 | `src/views/*.vue`、`src/tools/*/View.vue`、`src/app/*.vue` | 本页布局 + **覆盖**原语的个别属性 | 重写组件底座、裸色值、魔法 z-index |
| 手机端 | `mobile/app/styles/shell.css` | `--m-*` 角色别名（全部 `var(--…)`）+ 手机版式 | 裸色值、近似值 fallback、**同一个类的属性写两遍**（这里曾攒了 12 条被后一份整体盖掉的死声明） |

一条判据：**同一件事在两个文件里各写一遍，就是漂移的开始**。
z-index、遮罩色、按钮几何这三处本轮都已经各写了一遍。

⚠️ **`tc-` 前缀的唯一例外是 `.tc-demo-focus`**（工具演示聚光），它住在 `globals.css`。
理由是它不由模板写出：`src/app/useToolDemo.js` 在播放演示时把这个类**加到真实元素上**，
所以它必须在全局层；而守卫 `tcClassWithoutDefinition` 判的是"`.vue` 里用到的 `tc-*` 是否在
`primitives.css` 有定义"——**JS 运行时加的类不在它视野里**。
换句话说：这类"由脚本加进来的全局类"目前没有守卫兜着，删掉它不会红灯，只会在演示时静默失去高亮。
新加这种类之前先想清楚能不能改成模板里的条件 class；确实要加就在本节补一行，别让它成为第二个例外。

---

## 2. 令牌刻度

### 2.1 刻度表（默认档 / 舒适档）

<!-- ui-scale:start （由 scripts/ui-scale-table.mjs 生成，改令牌后跑 npm run gen:ui-scale，别手改） -->

| 族 | 默认取值 | 舒适档 |
|---|---|---|
| 字号 `--fs-*` | 11px · 12.5px · 13.5px · 14.5px · 16px · 20px · 26px | ❌ 不参与 |
| 行高 `--lh-*` | 1.4 · 1.65 | lh-tight 1.5 · lh-body 1.8 |
| 圆角 `--r-*` | 6px · 9px · 12px · 16px · 999px | ❌ 不参与 |
| 间距 `--sp-1..7` | 6px · 8px · 10px · 12px · 14px · 16px · 20px | sp-1 8px · sp-2 10px · sp-3 12px · sp-4 14px · sp-5 16px · sp-6 18px · sp-7 24px |
| 微间距 `--sp-0` `--sp-05` | 2px · 4px | ❌ 不参与 |
| 控件高 `--control-h*` | 30px · 24px | control-h 34px · control-h-sm 28px |
| 动效 `--dur-*` | 0.12s · 0.18s · 0.28s · 1.1s | ❌ 不参与 |
| 层叠 `--z-*` | 40 · 120 · 200 · 300 · 400 · 500 | ❌ 不参与 |
| 外壳尺寸 | 280px · 56px · 48px · 340px · 300px | ❌ 不参与 |

<!-- ui-scale:end -->

**这张表是生成的，不是手抄的**：`scripts/ui-scale-table.mjs` 从 `tokens.css` 的浅色段与
`:root[data-density="comfort"]` 逐条读出来，`uiSpec.test.js` 比对文档与实值——
**规范抄代码这件事本身就会漂**（本仓已经因此错过两次：`globals.css` 抄按钮数值、`DomainView` 抄令牌 hex），
所以把它变成生成物，改令牌不同步跑 `npm run gen:ui-scale` 就红灯。

**反向也锁住了**：`uiSpec.test.js` 顶部那三套硬写刻度集合与 `tokens.css` 的 `--sp-*` / `--r-*` / `--fs-*`
双向比对——往令牌里加一档（哪怕只在 tokens 里）或删集合里的一档都会红。这条原先只写在 §14.1 的流程里，
没有任何用例兜着：`FONT_SCALE` 定义了却没人用，等于"扩刻度必须显式"这句话对字号完全不起作用。

用途（散文本节不参与生成，因此也不需要机器判）：字号层级见 §2.4；
chip 用 `--r-xs/sm`、输入框 `--r-sm`、卡片 `--r-md`、弹窗 `--r-lg`；
`--z-*` 各档职责见 §5；外壳尺寸见 §11.1；动效见 §6.3。

**刻度外就不许写**：需要新刻度是**一次改 `tokens.css` 的显式决定**，不是某个视图里的一次例外。
`--sp-8`（28px）这类"看着差不多"的档位刻意没加——刻度越细，密度档能表达的差别越少（取舍记录在约束文档 §五.2）。

### 2.2 为什么微间距不参与密度缩放

6px 以下（2px/4px）在令牌化**之前**实测 303 处（2px×147、4px×156），本轮收成 `--sp-0/--sp-05`。
它们不是"留白"而是"线"：图标与文字的间隙、胶囊内边距、表格线偏移。密度档放大留白是对的，
放大这些只会让控件看起来散架。所以 `--sp-0/--sp-05` 在舒适档里**不重定义**，
并由守卫断言这条"不重定义"是刻意的（`uiSpec.test.js` 的"密度档只缩放留白"用例）。

口径要说清：截至 2026-10-20，`padding|margin|gap` 的值里仍有 **98 处**直接写裸 `2px/4px`
（`grep -rE "(padding|margin|gap)[^:]*: [^;]*\b(2px|4px)\b" src mobile --include=*.css --include=*.vue`），
它们和 3/5/7/9px 一起算在 `offScaleSpacing` 这根棘轮里——**已令牌化的部分不会自动让这根棘轮归零**，
剩下的要逐屏吸附，见 §10。

### 2.3 色彩：语义而非色号

界面里**没有"蓝色"，只有"主色"**。背景分 5 级、文字分 5 级、描边是"3 档中性 + 1 档近义待合并 + 2 档语义"：

| 背景层级 | 令牌 | 用在 |
|---|---|---|
| 画布 | `--bg` / `--bg-grad` | body |
| 卡片 | `--card` | 面板、弹窗、输入框底 |
| 卡内嵌套 | `--card-soft` | 分组区块底、panel-head |
| 抬起控件 | `--card-raised` | 需要浮起来的输入控件 |
| 凹陷区 | `--card-inset` / `--well` / `--ghost` | 代码块、预览框、进度槽底、幽灵按钮底 |

| 文字层级 | 令牌 | 用在 | 深色下 |
|---|---|---|---|
| 主 | `--text` | 正文、标题 | 反转 |
| 次 | `--text-weak` | 导航项、辅助说明 | 反转 |
| 三级 | `--text-soft` | chip、日期、tag | 反转 |
| 四级 | `--text-dim` | 表头、弱标签 | 反转 |
| 最淡 | `--faint` | 行号、占位 | 已提到 AA 可读写（见 §2.5） |

描边（浅色值 → 深色值，实测用量）：

| 令牌 | 取值 | 用量 | 用在 |
|---|---|---|---|
| `--card-border` | `#e3e8ee` → `#21262d` | 175 | 卡片/面板/弹窗的边（最浅，"区分而不强调"） |
| `--border` | `#d8dee4` → `#21262d` | 219 | 通用分隔线、表格线、次级控件边 |
| `--border-strong` | `#c8d1da` → `#30363d` | 195 | 输入框、需要"点得动"的控件边 |
| `--border-blue` | `#b8d8fb` → `#1f3a5f` | 76 | 语义：主色相关的边（选中、聚焦、信息态） |
| `--border-danger` | `#f0b1b1` → `#5c2b2b` | 30 | 语义：危险/报错的边 |

**不许再往这一组里加名字**：中性描边只有深浅三档的差别需要存在。
多出来的第四个名字（`--border-steel`，与 `--border-strong` 每通道差 ≤ 4）本轮已经并回去、
并从 `tokens.css` 删掉：它没有被任何规范职责分配，只用在一批散落的旧界面上，
后来的人无从判断该选哪一个。**同色不同名，就是下一次漂移的起点。**

### 2.4 状态层：跨页面唯一的五态

`--run / --wait / --done / --fail / --idle`（各带 `-soft` 与 `-deep`）。
**Agent 的每一步、任务状态、发布状态、流水线状态一律映射到这五个语义槽**，
不是各自取色。此前的病灶：同一个"待上线"在不同页是不同颜色。

| 语义 | 前景用 | 底用 | 典型 |
|---|---|---|---|
| 运行中 | `--run-deep` | `--run-soft` | 正在执行的步骤、plan |
| 等待 | `--wait-deep` | `--wait-soft` | 待上线、需人工确认 |
| 完成 | `--done-deep` | `--done-soft` | live / done |
| 失败 | `--fail-deep` | `--fail-soft` | 报错、破坏性结果 |
| 空闲 | `--idle-deep` | `--idle-soft` | 未开始、已归档 |

生命周期名（`st-plan/st-dev/st-test/st-pending/st-live/st-fail`）是**这五态的别名表**，
在 `primitives.css` 一处定义；新页面要状态色就选五态之一，不要新增第六种。

### 2.5 对比度是硬指标

正文 ≥ 4.5:1，大字号（≥18.66px 或 ≥14px 加粗）≥ 3:1，由 `e2e/specs/21-ux.spec.js` 实测拦截（当前上限 <6 个不达标元素）。
两个已付过学费的具体结论：

- `--faint` 曾是 `#afb8c4`（白底 2.0:1）却用在行号/时间戳上——**能读的文字就不允许装饰性淡色**，现为 `#626a75` / 深色 `#9aa4b2`。
- 深色下主按钮 `#4493f8` + 白字只有 3.1:1，按钮文字是 12–13px 够不上大字号豁免 → `--primary` 压深到 `#2b6ad0`（5.15:1）。
  同一条深色 `--primary-hover` 提到 `#58a6ff`，因为它同时是导航激活态的**文字**色。

新增颜色的流程：先定语义（它属于五态或五层级里的哪一个）→ 定浅色值 → **立刻算两种底色上的对比度** → 再补深色两套触发（§6.1）。

---

## 3. 组件词汇表

`primitives.css` 是组件的**唯一出处**。每个族有两个可寻址的名字（历史名与 `tc-` 名），
它们是**同一条声明**里的选择器组，所以长得一定一样；用哪个都行，**唯一禁止的是新造第三个名字**。

| 族 | 历史名 | 现代名 | modifier | 何时用 |
|---|---|---|---|---|
| 按钮 | `.btn-primary` `.btn-outline` `.btn-ghost` `.icon-btn` | `.tc-btn--primary/outline/ghost/quiet/danger/danger-outline` | `--sm` `--xs` `--block` | 见 §3.1 |
| 分段控件 | `.segmented`（crypto / file）、`.seg`（interview / label） | `.tc-seg` + `.tc-seg__item.is-on` | 等宽需 `grid-auto-columns` | 2–5 个互斥视图切换。**档位已按现存实现校准**：项目高 `--control-h`、字号 `--fs-sm`、字色 `--muted`、容器 `--well` 底 + `--border-strong` 描边 + `--sp-0` 内边距、选中 `--card` + `--shadow`（原来写的是 20px 高配 `--fs-md`，比任何控件都矮，所以从来没人采用） |
| 工具面板 | `.panel` + `.panel-head` | `.tc-panel*` | — | 见 §3.2（两种职责不合并） |
| 空状态 | `.empty` + `.empty-ico` | `.tc-empty` | `--sm` | 见 §4 |
| 加载 | `.spin`（转已有图标） | `.tc-spinner` `--sm/--lg`、`.tc-loading`、`.tc-skel` | — | `.spin` 与 `.tc-spinner` 不是一回事 |
| 遮罩/弹窗 | `.modal-mask` `.modal` `.modal-foot` | `.tc-mask` `.tc-modal` `--sm/--lg` | — | 见 §3.3 |
| 状态徽标 | `.st-chip` + `st-*` | `.tc-status--run/wait/done/fail/idle` | `--xs` | 状态一律走 §2.4 五态 |
| 类型胶囊 | `.tc-chip` + `tc-danger/primary/amber/neutral/teal/sky/accent/note` | 同名（历史遗留） | `.sm` | 分类、风险、领域；**不是状态** |
| 状态圆点 | — | `.tc-dot--run/wait/done/fail` | — | 运行中自带呼吸 |
| 开关 | — | `.tc-switch` + `__track` | — | 必须包原生 `input[type=checkbox]` |
| 进度条 | — | `.tc-bar` + `__fill` | `--thin` `--thick`、`__fill--wait/done/fail` | 统一 6px |
| 表单字段 | `.field`（**刻意不做别名**） | `.tc-field` | — | 见 §3.4 |
| 输入 | — | `.tc-input` `.tc-select` `.tc-textarea` | `--mono` | 新写的输入控件一律用它 |
| 工具条 | `.toolbar`（自写） | `.tc-toolbar` | — | 一行操作 + `.tc-spacer` 撑开 |
| 列表项 | — | `.tc-row`（`.is-on` 选中） | — | 可点的行必须是它 |
| 代码 | — | `.tc-code`（行内）`.tc-pre`（块） | — | 底色走 `--code-bg` |
| 提示条 | — | `.tc-note--info/wait/done/fail` | — | 页面内的解释性状态条 |
| 无障碍/截断 | — | `.tc-visually-hidden` `.tc-truncate` | — | 见 §7 |

### 3.1 按钮：强调阶梯

```
primary  >  outline  >  ghost  >  quiet
                        danger / danger-outline（破坏性，与强调阶梯正交）
```

- **一个视图里不该有两个 `primary`**。要选唯一主行动；剩下的降到 outline/ghost。
- 破坏性操作：不可逆的（删除、清空、覆盖）**必须**配 `askConfirm()`（§3.5）；
  可逆的（收起、取消选中）用 `danger-outline` 甚至 `ghost` 即可，不要用红色吓用户。
- 会打到外部系统的动作（构建 / 发布 / 上传 / 请求模型 / 弹原生选择器）在进行中必须 `:disabled` + 文案变化或
  `.tc-spinner`，**不允许**"看着能点但没反应"。判据是"会不会打到外部系统"，不是"函数是不是 async"——
  详见 §12.3，那里记了本节早先按"`disabled` 出现次数"误报的三个界面。
  禁用之后还得**看得出被禁用**：桌面由 `primitives.css` 统一给 `:disabled { opacity: .55 }`，
  手机端是独立一套 `shell.css`（不引 primitives），会被 `:disabled` 用到的按钮族必须自己写口径
  （守卫 `disabledWithoutAffordance` 两端分层判）。
- 纯图标按钮（`.icon-btn` / `.tc-btn--icon`）必须带 `title` 或 `aria-label`，
  只有 `Icon.vue` 自带 `aria-hidden="true"`（它是装饰层，不是标签）。
- 尺寸只走 modifier：`--sm` / `--xs` / `--block`。**不要**在视图里写 `padding: 7px 11px` 造第 38 套按钮。

### 3.2 `.panel` 与 `.tc-panel` 为什么不合并

- `.panel`＝**工具面板**：嵌在工具窗口里，无阴影，标题条带 `--card-soft` 底色，靠描边分区。
- `.tc-panel`＝**悬浮卡片**：浮在页面上，有 `--shadow`，标题条只有一条分隔线。

合并的结局要么是所有工具面板长出阴影、要么是卡片丢掉层次。
两者共享的底座（外框、圆角、`min-height: 38px` 标题条）已经写成一条选择器组——
**差异留在职责上，不留在数值抄写上**。

### 3.3 弹窗与遮罩：第 16 个名字不接受

实测曾有 15 个遮罩类名（`modal-mask / save-mask / dk-mask / wf-mask / hist-mask / gs-mask /
env-mask / curl-mask / cf-mask / ax-mask / rec-overlay / confirm-overlay / drop-overlay …）
与 4 种遮罩底色。规则：

- **底座只有一份**：全局 `.modal-mask`（= `.tc-mask`，同一条声明）。
  视图保留自己的语义类名，**两个类名并列**，scoped 里只写真差异：
  `class="modal-mask dk-mask"` + `.dk-mask { backdrop-filter: blur(3px); }`。
  这不是折中——e2e 用 `data-role` 选元素，类名留着当钩子零成本；
  而底座每多写一份，就多一个"改一处漏一处"的漂移点。
  本轮把 16 处自写底座迁成"底座类名 + 语义钩子"：桌面 **0 处**（硬性），
  手机端只剩 1 处（`.m-photo-preview`，手机构建不引 `primitives.css`，见 §9），
  指标因此拆成 `restatedMaskBasesDesktop`（硬性 0）与 `restatedMaskBasesMobile`（棘轮 1），只减不增。
- 底色只有两档，写死 rgba 一律红灯（深色下它纹丝不动，此前 6 处只有一半生效）：
  · `--overlay`＝普通弹窗遮罩（浅 `rgba(17,24,39,.5)` / 深 `rgba(0,0,0,.62)`）
  · `--overlay-strong`＝**媒体预览**底（浅 `rgba(10,12,16,.82)` / 深 `rgba(0,0,0,.86)`）
    ——看图要把周围压暗让画面浮起来，比普通弹窗深一档
- 定位与层叠走 `--z-*`（§5）；居中由底座的 flex 提供，不要自己算 `top`。
- 弹窗宽度用 `.tc-modal--sm`(420) / 默认(540) / `--lg`(760)；
  要更高就 `overflow-y: auto` + `max-height: 90vh`（已在原语里），不要写死 height。
- 遮罩里的**盒子必须挂 `v-dialog`**（见 §7）：语义与焦点进出只有一个实现处。
  新写弹窗时不要自己加 `role="dialog"`，也不要抄一份 `aria-label` 文案。
- 遮罩必须能被 `Escape` 关闭、点击遮罩空白处关闭（破坏性确认除外）。

### 3.4 `.field`：同名不同义，故意不统一

`.field` 在 19 个文件里出现（口径：`grep -rl 'class="field' src mobile --include=*.vue`），实际是两个东西：
A＝工具面板里的纵向表单字段（7 个工具逐字相同：`flex column` + `gap --sp-1`）；
B＝工作台视图里的裸标签容器（`display:block; margin-bottom`）。
统一成一个全局 `.field`，A 的 flex 会毁掉 B 里依赖块级换行的排版。
所以 **不提供 `.field` 别名**；要共用就显式写 `.tc-field`，把语义写进类名。

### 3.5 确认、提示、反馈：每件事只有一个机制

| 需求 | 唯一机制 | 现状 |
|---|---|---|
| 二次确认 | `src/ui/confirm.js` 的 `askConfirm()` → 单例 `ConfirmDialog.vue` | 37 处调用，**零** `window.confirm/alert`（守卫不许新增） |
| 对话框语义与焦点 | `src/ui/dialog.js` 的 `v-dialog`（全局指令 + 就地 import，两端都注册） | 现在 18 个桌面文件、6 个手机文件在用；判据不是"用了几个文件"而是**每个遮罩站点都必须有对话框语义**——守卫 `dialogsMissingSemantics` 硬性为 0 |
| 右键菜单 | `App.vue` `provide("openCtxMenu", …)`，样式在 `globals.css` 的 `.ctx-menu` / `.ctx-item` | 7 个界面在用（问题/迭代/数据库树与页签/请求页签/钉图/Pin）。**条目形状是固定的** `{ label, icon, fn, danger }`：`label` 走字典、破坏性动作给 `danger: true`（红色只给不可逆），层级永远是 `--z-menu`。语义与键盘由菜单本体负责：`role="menu"` + 每项 `role="menuitem"`、打开即把焦点送进第一项、`↑/↓` 在条目间循环、`Escape` 关闭并**把焦点还给右击前的元素**（点外面关闭时**不**抢焦点）。`e2e/specs/77-ctx-menu.spec.js` 钉住这三条；不许再造第二个菜单实现 |
| 全局提示 | `App.vue` 的 toast 队列（有上限、自动过期、可带动作） | ⚠️ 靠 **prop drilling** 传下去：`App → ModuleTabs → ToolWindow → view`，52 个文件提到 toast。新组件容易接不上——待改为 `provide/inject`，改动前不许再造第二个 toast 实现 |
| 工具报错 | `src/ui/ToolErrorPanel.vue` | 只 2 处引用；工具内错误展示仍各自实现（债，见 §7） |
| 页内说明 | `.tc-note--*` | 原语已有；需求大盘的「一条迭代都没有」提示已采用（`tc-note--info` + 动作），其余视图仍可迁移 |
| 复制/下载等即时反馈 | toast + 控件态变化 | 不要静默成功 |

---

## 4. 状态矩阵：每个数据界面都必须有的四态

空态里**没有自己写字号的文字**会跟着底座走 `--fs-base`（14.5px）。
本轮把 6 个工具空态接回 `.empty` 时，它们原来 12.5px 的说明文字因此放大了 2px——
这是有意的（全应用空态同一个字号），但需要肉眼确认一次。已有自己类名与字号的元素不受影响。

| 态 | 用什么 | 要求 |
|---|---|---|
| 空 | `.empty` / `.tc-empty`（`--sm` 用于卡内） | 标题说"这里会有什么"，副文案给**下一步动作**，能给入口按钮就给 |
| 加载 | `.tc-spinner`（局部）· `.tc-skel`（列表/卡片占位）· `.tc-loading`（行内文字） | 首次加载 ≥ 约 200ms 可感知时必须有指示；列表用骨架屏而不是转圈 |
| 错误 | `.tc-note--fail` / `ToolErrorPanel` + toast | 文案三段式：**发生了什么 / 影响什么 / 怎么办**；保留可复制的原始信息 |
| 禁用·进行中 | `:disabled` + `opacity .55`（原语已给）+ 光标 `not-allowed` | 异步提交期间必须禁用，防止重复提交 |

实测核对（不是启发式统计）：**凡是渲染列表的视图都已经带 `.empty`**——
按"模板里 `v-for ≥ 3` 但没渲染 `.empty`"这条判据扫 `src/views` + `src/app`，命中 **0 个**。
此前那份"8 个界面无空态"的名单是按"文件里有没有 empty 这个词"数的，属于误报：
`App.vue / ModuleTabs.vue / ToolWindow.vue` 是外壳，`WelcomeView` 本身就是首屏引导，
`PoolStatus` 是单池徽标，`PoolPublish` 由 `v-if="publishPool"` 挡着，
`ExecutionLanes` 的根节点就是 `v-if="data"`，`RunProgress` 在 `maxSteps=0` 时刻意不画条
（这三条有 `RunProgress.render.test.js` 守着）。**它们不该有空态，硬加反而是噪声。**

**aria/role 语义已经全覆盖**：`src/views` + `src/app` 里每个界面要么带 `aria-*`/`role=`，
要么挂了 `v-dialog`（运行时补语义）。本轮补的内容都是**零新文案**的做法：
`RunProgress` 补 `role=status` + 进度条 `role=progressbar/aria-valuenow/max`、
`ProblemView` 的 div 列表补 `role=list`/`listitem`、
`ReleasePackage` 的表格用页签名当 `aria-label`、`WorkOverviewView` 的表格 `aria-labelledby` 指向已有小标题。
只有 2 个界面是**写清理由的豁免**（`VIEWS_ARIA_EXEMPT`）：
`PoolStatus`（单枚徽标，播报由承载它的列表负责）、`WelcomeView`（首屏引导，动作全是带文字的主按钮）。
指标 `viewsWithoutAriaSemantics` 是硬性 0——**豁免必须写为什么，否则一年后没人分得清这是漏网还是决定**
（先例：工具契约里的 `agentExempt`）。

空态文案的判据不是"有没有图"，而是**这句话是不是废话**。
"暂无数据"是废话；"还没有绑定工作域，绑定后这里会列出该域的需求与迭代"是信息。
字典里已经形成的句式可以直接沿用：`还没有X，点「Y」开始` / `暂无Z`
（如 `settings.aiProfileEmpty`、`toolbox.ai.noSession`、`snippet.emptyTitle`）。

**样板：需求大盘的四列空态。** 每列原来只写「暂无需求」四个字——读了等于没读。
现在分两种情况给下一步：有迭代时列里给「新建需求」，没有迭代时在**顶部一条** `.tc-note--info`
说明原因并给「去迭代页」，列里只留「「小需求」还空着」。分层的理由是：四列各喊一遍「去迭代页」
既吵、又让人点一个必然保存失败的按钮。新写空态照这个形状：
**先判断用户"现在能不能做这件事"，能就给动作，不能就给原因 + 通往原因的那条路。**

---

## 5. 层叠刻度（z-index）

规则一句话：**要压过某一层，就用比它高一档的令牌；不要写数字。**
组件**自身层叠上下文内部**的 1/2/3 允许写裸整数（那是局部坐标，不参与全局层叠）；
`z-index ≥ 10` 不写令牌即红灯（`uiSpec.test.js` 硬性用例）。

| 令牌 | 值 | 职责 | 迁移前的原值 |
|---|---|---|---|
| `--z-raised` | 40 | 就地浮层：工具条、下拉、悬浮控件、窄屏侧栏/dock 浮出 | 20/30/40/45/50/60 |
| `--z-float` | 120 | 常驻悬浮件：后台任务监控条、更新面板 | 60/120 |
| `--z-overlay` | 200 | 模态遮罩 + 弹窗 | 50/60/100/200 |
| `--z-front` | 300 | 要盖住弹窗的浮层：图片预览、全局搜索、历史面板、toast | 200/260 |
| `--z-confirm` | 400 | 全局确认弹窗：除右键菜单外永远最上 | 300 |
| `--z-menu` | 500 | 右键菜单：任何时刻都要可见 | 400 |

迁移用 [scripts/tokenize-zindex.mjs](../scripts/tokenize-zindex.mjs)（按行精确替换，
每条带"这一层凭什么压过谁"的备注，行号与期望值对不上就报错退出而非静默跳过）。
**相对次序逐条核对过没被打乱**，两个已知的观感点：

1. 监控条（原 120）现在低于模态遮罩（200）——弹窗打开时它会被遮罩压住。符合预期。
2. toast 与"盖住弹窗的浮层"同档（300），确认弹窗仍在它们之上。

---

## 6. 主题、密度与动效

### 6.1 深色有两套触发，**必须同时覆盖**

```
a) @media (prefers-color-scheme: dark) :root:not([data-theme="light"])   跟随系统
b) [data-theme="dark"]                                                    用户显式选择
```
为什么必须有 (b)：旧实现只靠媒体查询，`localStorage.themeMode` 设了值但 CSS 变量一个字没变——
**用户手动切深色不改变任何颜色**（`src/app/theme.js` 顶部记录了这次回归）。

新增令牌的义务：浅段 + 两套深色分支**三处一起补**。
少补一处不会报错，只会"半深半浅"：那个变量在少补的那套触发下退回浅色值。
`cssVars.test.js` 现在逐条比对两套分支的**变量集合**（`深色两套触发的变量集合必须一致`），
少补一处就红并点名；此前它只保证"引用必有定义"，抓不到这种只补一半的情况。
刻意只在浅色定义的例外只有 3 个：`--text-invert`（彩色底上的白字）、`--win-close`、`--focus-ring`。

强调色预设走 `src/app/accentTheme.js`：每个预设给 **light + dark 两份 patch**，
以 inline style 覆盖 21 个主色/强调色相关变量（`--primary*`、`--accent*`、`--grad-*`、`--border-blue`）。
加预设就要加两份，缺深色那份等于深色下主色不可读。

### 6.2 密度档

`:root[data-density="comfort"]` 只重定义 `--sp-1..7`、两个行高、`--control-h(-sm)`。
绑在 `:root` 而不是 `.shell`，因为独立工具窗口（`ToolWindow.vue` 的根是 `.tool-win`）
不在 `.shell` 内——旧实现绑在 `.shell` 上，"界面密度"对独立窗口完全无效。

⚠️ 本轮的一处观感变化：`.icon-btn` 的 30px 改为 `var(--control-h)`。
默认档等值，**舒适档下 106 个图标按钮（`.icon-btn` 的模板用法数）会从 30px 长到 34px**。
这是"密度应当影响控件"的正解，但需要真机确认（见 §8 待办）。

### 6.3 动效

- 只用四档时长：`--dur-fast`（hover/按下）、`--dur-base`（常规过渡）、`--dur-slow`（面板展开/布局位移）、`--dur-pulse`（流式光标呼吸）。
- 缓动只有一个：`--ease-out`（快起慢收）。没有 `ease-in`——进入界面不该给人"被拽进去"的感觉。
- 默认只动 `transform` 与 `opacity`；`width/height/top/left` 只在确实表达位移时用 `--dur-slow`。
- `prefers-reduced-motion: reduce` 下时长全部退化 0.01ms 且动画只播一遍（tokens.css 末尾），
  并且**不得**用动画表达唯一信息：工具演示聚光 `.tc-demo-focus` 就是范例——
  减弱动效时退化为静态描边，仍然看得清"这一步动的是哪个控件"。
- 关键帧全仓只有一份定义（`tc-spin` / `tc-skel-shimmer` / `tc-dot-pulse` / `cfPop` / `tc-demo-pulse`），
  守卫断言 `primitives.css` 里不存在同名关键帧。

---

## 7. 无障碍与键盘

| 要求 | 做法 | 拦截方式 |
|---|---|---|
| 对话框要有语义 | **`v-dialog` 指令**（`src/ui/dialog.js`，两端入口都注册）：挂 `role="dialog"` + `aria-modal="true"`，并取盒子里第一个标题元素补 id 后用 `aria-labelledby` 指过去——可访问名与可见标题是同一段文字，改文案不会漂移；没有标题的（图片预览、搜索面板）由调用方传 `{ label: t('…') }`。**用了 `v-dialog` 的组件必须自己 `import { vDialog }`**：`<script setup>` 会就地解析，全局注册在 SSR 渲染测试里不生效 | 硬性（`dialogsMissingSemantics` 每个遮罩站点都要有语义；`dialogDirectiveNotImported` 每个使用者都要 import）；`dialog.test.js` 测接线逻辑；浏览器实测两条分支都对 |
| 焦点进出 | 同一个指令负责：打开时焦点进对话框（优先 `[data-dialog-focus]`，否则第一个可聚焦控件），关闭时**还给触发它的元素**（已卸载就不还） | 浏览器实测（焦点进入 `.gs-panel` 的输入框、Escape 后回到触发项） |
| 提示要被读屏收到 | toast 容器带 `role="status" aria-live="polite"` | 硬性（`toastsWithoutLiveRegion`） |
| 焦点必须可见 | 原语已给 `:focus-visible { outline: 2px solid var(--focus-ring) }`；**禁止** `outline: none` 而不给替代 | `e2e/specs/21-ux.spec.js`（焦点不可见元素 < 4） |
| 字段错误要读得到 | `v-field-error="msg"` 挂在字段容器上：给可见的错误文案补 id，控件写 `aria-invalid` + `aria-describedby` 指过去；msg 空则摘掉 | 硬性（`fieldErrorDirectiveNotImported`）；`fieldError.test.js` 9 条 DOM 替身；`37-mobile-settings.spec.js` 真浏览器断言关联指向可见句子、且改对后撤回 |
| 文本对比度 | §2.5 | 同一份 e2e（不达标 < 6） |
| 遮罩可关 | `Escape` 关闭 + 点空白关闭；确认弹窗只走 `askConfirm()` | 现状 24 个文件已处理 Escape，新弹窗必须处理（走查） |
| 菜单要能键盘用 | 右键菜单：`role="menu"` / `role="menuitem"`、打开即聚焦第一项、`↑/↓` 循环、`Escape` 关闭并把焦点还给右击前的元素 | `e2e/specs/77-ctx-menu.spec.js`（摘掉 `role="menu"` 三条同时红，验过） |
| 图标按钮有名字 | `title` 或 `aria-label`（换成 `:title="t('…')" :aria-label="t('…')"` 也行）；`Icon.vue` 是装饰层，自带 `aria-hidden`。名字要来自字典，不要写中文字面量 | 硬性（`iconButtonsWithoutName`）——按**标签**取整段属性判，因为 SFC 里属性常换行写 |
| 界面有基本语义 | 列表 `role=list/listitem`、表格把已有页签名或小标题用 `aria-label`/`aria-labelledby` 关联、状态行 `role=status`；**全部零新文案**（播报的就是可见文字） | 硬性（`viewsWithoutAriaSemantics`）；确实不需要的进 `VIEWS_ARIA_EXEMPT` 并**写清理由**（现 2 个：`PoolStatus`、`WelcomeView`） |
| 列头要说清属于哪一列 | `<th scope="col">`（行头 `scope="row"`）；44 个已补齐 | 硬性（`headersWithoutScope`），见 §12.2 |
| 禁用之后要看得出禁用 | 桌面：`primitives.css` 除了族名口径还有**元素级底线** `button:disabled { opacity: .55 }`（兜住 `.mp-item`/`.effort-chip`/`.theme-btn`/`.mini-btn`/`.chip` 这 6 处"换个名字再拼一遍"的按钮）；手机：独立一套 `shell.css`，会被 `:disabled` 用到的**按钮族**必须自己有口径（`.m-btn`/`.m-op`/`.m-chip`/`.m-item-main`） | 硬性（`disabledWithoutAffordance`）——两端各自判；手机侧判据取"按钮任一 class 有口径"，因为 `.primary/.sm/.danger` 是跟着底座走的修饰名 |
| 开关可读屏 | `.tc-switch` 包原生 `checkbox`（`aria-checked` 自造的角色**不要用**） | 走查 |
| 状态不只靠颜色 | `.tc-status` 自带文字；圆点 `.tc-dot` 必须与文字并排 | 走查 |
| 长文案不撑破布局 | `.tc-truncate`（同一批词条，英文均长 31.6 字符 vs 中文 12.4，约 **2.6 倍**；口径：把 `zh-CN.json` 与 `en-US.json` 摊平取共同键求平均） | 走查 |
| 仅屏幕阅读器可见的说明 | `.tc-visually-hidden` | 走查 |

---

## 8. 文案与 i18n

- **界面文字一律走字典**（`t()`），中文不得出现在脚本字面量或模板文本节点里。
  `i18nCoverage.test.js` 守着研发管理/记录两端共 12 个界面；新界面按同一判据自查。
- 空态/错误态文案的形状：**发生了什么 · 影响什么 · 下一步做什么**。
  禁止"出错了""暂无数据"这类无下一步的表述。
- 按钮用动词开头，不加"点击"：`新建工作域` 而不是 `点击这里创建工作域`。
- 破坏性确认的标题必须包含被作用对象的类型与数量：`删除 3 条提示词？`。
- 词表一致性（已定的不再改，理由记在约束文档 §五）：
  导航 `nav.work` ＝「研发」（英文 `Delivery`），因为「工作台」同时是产品定位词；
  `release.workbenchTitle` 保留「工作台」——它指发布页里的逐步清单，不撞名。
- 数字与单位：`12 条` / `3.5h`；大统计数字用 `--fs-num` + `--font-num`（Bahnschrift）。

---

## 9. 手机端

| 维度 | 现状 | 规则 |
|---|---|---|
| 令牌 | `mobile/app/main.js` **先** import `src/styles/tokens.css`，`shell.css` 在后 | 顺序由 `mobileTokens.test.js` 断言 |
| 色彩 | `--m-*` 全部是 `var(--…)` 别名，零裸色值、零近似值 fallback | 守卫硬性；角色可以不同（深色下 `--m-primary` 取 `--primary-hover`，因为手机上主色多用作文字） |
| 层叠 | 与桌面共用 `--z-*`：标签栏 `--z-raised`、表单全屏 `--z-overlay`、应用内确认 `--z-front` | 不再自成一串 20/30/40 |
| 触摸目标 | `--m-touch: 44px`、`--m-tabbar: 56px`（手机独有，桌面上无对应） | 可点区域不小于 44px |
| 禁用态 | 桌面由 `primitives.css` 统一给（本轮起还有元素级底线 `button:disabled`，族名覆盖不到的自造名也兜得住）；手机各自写在 `shell.css`，本轮补齐前只有 `.m-btn` / `.m-item-main` / `.m-item button` 有口径——`.m-op`（PDF 排序、自检"单独跑一项"）与 `.m-chip`（知识库保存/删除、同步开关）**禁用了看起来跟能点一模一样** | 凡是会被 `:disabled` 用到的按钮族，`shell.css` 里必须有 `[disabled] { opacity: .55; cursor: default; }`；守卫 `disabledWithoutAffordance` 硬性 0，桌面看 primitives、手机只看自己这一层。取值本轮已统一到 **.55**（此前手机是 .5）——"禁用"只该有一种深浅 |
| 主题 | 手机不挂 `data-theme`，因此自动走 `prefers-color-scheme` 分支——跟随系统，取值同一份令牌 | 要加手动开关就得同时补 `[data-theme]` 那份 |
| 版式 | ⚠️ **未统一**：手机 31 个 `.vue` 自己实现视图，字号用 rem、卡片圆角/阴影口径与桌面不同 | 要继续统一必须先看看真机，不能只对着 CSS 改 |
| 组件底座 | ⚠️ 手机构建只引 `tokens.css`，**不引 `primitives.css`**：桌面那套 `.modal-mask` / `.tc-*` 在手机端根本不存在，所以 `.m-photo-preview` 只能自己写定位（守卫把它单列为 `restatedMaskBasesMobile` 棘轮，桌面端则是硬性 0） | 想消掉这个例外：让 `mobile/app/main.js` 也引 `primitives.css`，然后逐屏看真机——这会一次性改变手机端所有借用同名类的观感 |

手机端与桌面共享的**不是组件 CSS**，而是：令牌值、`NAV_MODULES`、共享纯函数（工时/进度）。
`mobile/app/**` 不得 import 依赖 JSON 的模块（Node ESM 加载不了，会让 Playwright 收集到 0 条用例）——
这条限制的具体后果与守卫见约束文档 §三。

---

## 10. 存量债务与迁移顺序

基线（2026-10-20 实测，见 `uiDebtBaseline.json`）：

| 指标 | 当前 | 收敛动作 |
|---|---|---|
| 裸色值（tokens 之外） | 14 | 多数是 canvas 绘制与 Pin 窗口的固定深底，逐个换成令牌或 `color-mix` |
| 裸字号 | 26 | 对齐到 `--fs-*` 七档（13px×1、10.5px×4、12px×6 是主要项） |
| 刻度外间距 | 301 | 集中在 3/5/7/9px 这类"半档"，就近吸附需要逐屏看 |
| 刻度外圆角 | 58（去重后又降了 1：删掉的那条 `border-radius: 4px` 本来就不在 `--r-*` 五档里） | 吸附到 `--r-*` 五档，改一个界面看一个 |
| 零引用的原语类 | 65 | **这 65 个全部是 `tc-` 别名**（守卫的 `UNUSED_PRIMITIVES` 只在 `primitives.css` 里找 `tc-*` 名字，再拿其余文件的全文当语料）。历史名被广泛使用、`tc-` 名几乎没人写——实测只有 7 个 `.vue` 写过 `tc-*`，共 23 处（全在 `src/`，`mobile/` 一个都没有）。这**不是"规范没被执行"**：§3 说两个名字等价、用哪个都行，所以用历史名完全合规。它是"同一件事有两个入口"的代价，而这根棘轮真正盯的是**别加第三个名字**。 |
| 桌面自写遮罩底座 | **0（硬性）** | 本轮把 16 处迁成"底座类名 + 语义钩子"，再写一处就红灯 |
| 手机自写遮罩底座 | 1（棘轮） | 手机构建没有 `primitives.css`，见 §9 的"组件底座"行 |
| 视口断点种数 | 17（棘轮） | 真正在起作用的是五档：壳层 1180/1000/900/760 + 工具窗口 820；其余是各视图自加的。目标 ≤5 档，见 §11.2 |
| 图标尺寸种数 | 20（棘轮） | 13/14/15 各用上百次却几乎是同一个尺寸。目标 6 档，见 §11.3 |
| 缺 aria/role 语义的界面 | **0（硬性）** + 2 个写明理由的豁免 | 见 §4：补法全是零新文案（角色属性、复用已有标题），豁免理由写在守卫里 |
| 缺 `scope` 的列头 | **0（硬性）** | 44 个 `<th>` 本轮补齐（`scripts/add-th-scope.mjs`），行头 `scope="row"` 也算合规 |
| 禁用后没有可见反馈的按钮（两端） | **0（硬性）** | 手机补了 `.m-op[disabled]` / `.m-chip[disabled]`（8 处受益），桌面补了元素级底线 `button:disabled`（6 处自造名受益）。两端取值本轮统一到 **.55** |
| 桌面自写组件底座骨架 | **0（硬性）** | `.panel / .empty / .st-chip / .modal / .btn-*` 五族沿用族名的底座已全网收敛 |
| **换名字的自造组件** | 14（棘轮） | 换个类名再拼一遍同样的骨架，才是"自造"的主形态。本轮把 7 处真正的空态/主按钮接回原语（21→14）；**剩下的 14 条是刻意保留的差异**：虚线拖放区（`.file-drop`/`.style-bar`）、提示条（`.noai`）、列表行（`.tl-item`）、带主色描边的 CTA（`.go-next`）、渐变底按钮（`.mock-run`）——它们不是同一个东西，抹平会改观感。名单由守卫打印（`UPDATE_UI_BASELINE=1`） |

迁移顺序与进度：
1. ~~遮罩族~~ —— **已完成**（16 处 → 桌面 0 处）。做法不是改类名，而是
   `class="modal-mask 原类名"` 并列 + scoped 里只留真差异（`backdrop-filter`、更强的 `--z-*`、`align-items`）。
   迁移脚本 [scripts/migrate-masks-to-primitive.mjs](../scripts/migrate-masks-to-primitive.mjs) 保留了每条"为什么这处还留着差异"。
2. 换名字的自造组件（21 条 → 已降到 14）：`.blank-state / .canvas-empty / .error-state / .result-state`
   换成 `class="empty 你的类名"`，`.new-btn / .type-opt / .go-next` 换成
   `class="btn-ghost 你的类名"` 之类的组合——**语义类名留着当钩子和当 scoped 覆盖点**，
   底座交给原语。名单由守卫打印，不用自己 grep。
   **下一批的具体目标已经量好了：4 处分段控件迁到 `.tc-seg`**（crypto / file 的 `.segmented`、
   interview / label 的 `.seg`）。逐处要肉眼确认的真实差异只有三件：
   ① 原语有 `gap: --sp-0`（2px），现存四件都是 0；
   ② file 的 `grid-auto-columns: minmax(96px, auto)` 比 crypto/label 的 66px 宽，原语不含等宽规则；
   ③ interview 那套是**另一种东西**——分隔线相连 + 选中用 `--primary-soft` 平涂，不是"抬起的一格"。
   先决定它归 `.tc-seg` 还是留在自造（规范不许有第二种分段形状），再动手；
   这三处都不属于"改一处两边都变"的等值替换，所以按 §14.5 的规矩：**看到界面之前不批量改**。
3. ~~aria/role 语义~~ —— **已完成**：`viewsWithoutAriaSemantics` 现在是硬性 0，
   补法全部零新文案（`role=list/listitem`、表格用已有页签名/小标题关联、状态行 `role=status`），
   2 个界面走"写理由的豁免"。见 §4。
4. ~~异步动作的防连点锁~~ —— **判据写错了，已按 §12.3 更正**：原先这里写"`SnippetView`/`WorkOverviewView`/
   `PoolStatus` 的 `disabled` 为 0，是个缺口"，那是**数属性数出来的假缺口**（读函数体后：筛选、导航、
   剪贴板、以及只负责打开确认面板的按钮）。真正缺的那一处是手机自检的"单独跑一项"（`runSingle` 完全没有锁），
   本轮已按 `busyKey` 形态补齐。剩下的要靠逐个界面看——**它要的不是属性，而是"这个动作能不能连点"的判断**。
5. 刻度吸附：字号 → 圆角 → 间距（每吸附一处看一次界面，不批量赌）。
6. 字段错误的读屏关联：机制已建（`v-field-error`），已接 9 处字段容器 / 17 条 `.field-err` 里的 11 条。
   剩下 6 条是面板级汇总提示，不属于任何输入框，**不打算接**（接了是误导，见 §12.3 的边界）。
   新写的表单字段只要有错误文案就顺手挂指令——这是唯一一个"不接就会红"以外的增量口（守卫只查 import）。
7. 手机端：先决定要不要让 `mobile/app/main.js` 引 `primitives.css`（引了才能复用原语），
   再做版式统一（需要真机）；禁用态取值 .5 → 与桌面 .55 统一也在那一批里。
8. ~~近义描边令牌~~ —— **已完成**：9 处 `var(--border-steel)` 改指 `--border-strong`，
   并从 `tokens.css` 的浅色段与两套深色分支里删掉这个令牌（深色下取值本来就相同，浅色每通道差 ≤ 4；
   `cssVars.test.js` 的"定义必有人用"是这一步必须删干净的判据）。

**不要**做的事：为了指标好看把基线数字调大；批量正则改 CSS（CRLF 与编码两个坑都踩过）；
在没看到界面前动宽度/圆角/字号。

---

## 11. 外壳骨架、断点与图标刻度

### 11.1 应用外壳尺寸是令牌，不是组件里的数字

| 令牌 | 默认值 | 是什么 | 谁在用 |
|---|---|---|---|
| `--sidebar-w` | 280px | 左栏展开宽度 | `.shell` 栅格轨道、窄屏浮出侧栏的 `width` |
| `--rail-w` | 56px | 左栏收起后的图标轨道 | 同上（`.shell.collapsed`）+ ≤760px 强制轨道 |
| `--topbar-h` | 48px | 单条顶栏高度 | `.brand`、`.top`——**视图不许再加第二条 bar** |
| `--dock-w` | 340px | 右栏停靠宽度 | `.shell.dock-open` 第三轨、`.dock` |
| `--dock-w-sm` | 300px | ≤1180px 时的右栏宽度（先让出 40px 给中栏） | `App.vue` 的 `@media (max-width: 1180px)` 两轨改写 |

规则：`App.vue` 的 `<style>` 里**不许再出现**裸的 280/56/48/340/300px（硬性为 0，守卫
`shellGeometryLiterals`）。这条特别值得钉住：e2e 里就有用例断言"壳为 280/56px 侧栏与 48px 顶栏"
（`29-sidebar-fixed-zones.spec.js`），尺寸散在组件里等于**测试与组件互相猜**。

三栏是 `grid-template-columns`，不是绝对定位。完整阶梯（从 `App.vue` 的媒体查询逐条抄下来，别凭印象改）：

| 视口 | 左栏 | 右栏（dock） | 中栏 |
|---|---|---|---|
| >1180 | `--sidebar-w` 280（收起 56） | `--dock-w` 340，占第三轨 | `minmax(0,1fr)` |
| ≤1180 | 同上 | 缩到 `--dock-w-sm` 300 | `minmax(0,1fr)` |
| ≤1000 | 同上 | 同上 | 顶栏内边距收窄、搜索框降到 160px、`<kbd>` 提示隐藏 |
| ≤900 | 同上 | **脱离流**：`position: fixed` + `--z-raised`，宽度 `min(--dock-w, 92vw)`，盖在中栏上 | 回到两轨，独自撑满 |
| ≤760 | 强制收成 `--rail-w` 轨道；展开时 `position:absolute` 浮出（`--z-raised`），收起走 Escape/底部按钮 | 同上 | `.main` 钉在第二列（否则掉进 56px 轨道列） |

两条容易被写反的事实：**右栏是"先缩再浮"，不是"一直压窄"**（对话列不能被挤到读不动）；
**≤760 的浮出不改桌面折叠偏好**（`narrowSidebar` 与 `collapsed` 是两个状态，别合并）。
应用窗口最小 720×520，所以中栏的极限可用宽度是 `720 − 56 = 664px`——这就是"界面必须在窄宽度下不破"的判据来源。

### 11.2 视口断点

媒体查询用不了 `var()`，所以断点刻度只能靠约定——但**种数可以数出来**：
实测 17 种（守卫指标 `viewportBreakpoints`，棘轮），真正在起作用的只有五档：

| 断点 | 语义 | 依据 |
|---|---|---|
| `≤1180px` | 右栏 340→300，先让 40px 给中栏 | 壳层阶梯第一档（`App.vue`） |
| `≤1000px` | 顶栏内边距收窄、搜索框降宽、`<kbd>` 隐藏 | 同上 |
| `≤900px` | 右栏脱离文档流变成浮层，不再挤中栏 | 同上 |
| `≤760px` | 左栏强制收成图标轨道 + 浮出展开 | Agent 工作台的双形态分界 |
| `≤820px` | 工具类界面两栏→单栏 | 用得最多（13 处 / 12 个文件；口径是 `819px`/`820px` 都算，含 2 处视图内的 `max-width`，不是 13 条媒体查询），事实上是工具窗口分界 |

其余 560/600/619/620/720/780/819/860/980/1100/1150/1280 是各视图自己加的（`819` 是 rail 对 820 的 1px 口径差）。
**目标收到 5 档以内**（上表这五档就是目标集合）；新增断点前先问一句：能不能复用五档之一。

**取值本身也被钉住了**：守卫里有一份 `KNOWN_OFF_TIER_BREAKPOINTS` 白名单，
新加一个主干外的数值会直接红——只数"种数"挡不住 `780 → 785` 这种替换（种数不变，守卫照样绿）。
存量清掉后记得把白名单那一项也删掉，否则下一个人会以为它还在。

### 11.3 图标尺寸

`<Icon :size="N">` 实测 20 种取值（棘轮 `iconSizes`），其中 13 / 14 / 15 分别用了
**218 / 198 / 164 次**，视觉上几乎是同一个东西——这不是设计差异，是没人定刻度。目标 6 档：

| 档 | 尺寸 | 用在 |
|---|---|---|
| xs | 12 | 行内辅助、chip 前缀、时间戳 |
| sm | 14 | **行内默认**（按钮、菜单项、列表行） |
| md | 16 | 独立图标、输入框内 |
| lg | 20 | 卡片标题、空态小图标 |
| xl | 24 | 空态主图标、品牌区 |
| 2xl | 32 | 首屏/大空态 |

收敛动作要**看着界面做**（13→14 会动 218 处），所以这里只钉刻度不批量改；
新写的图标一律取上面六档之一，别再填 13/15/17——这条现在**有守卫**：
`KNOWN_OFF_TIER_ICON_SIZES` 之外的两位数尺寸会让 `uiSpec.test.js` 直接红。

**归档规则（先定规则再动手，否则 15 这种"半档"每个人收敛到不同的地方）**：
1. **按用途取档，不按数值就近**——同一个 15px，出现在按钮/菜单/列表行里归 `sm 14`，
   出现在独立图标或输入框内归 `md 16`。上表"用在"那一列就是判据。
2. 脱离用途能判断时才用就近：取差值最小的档；**差值相同取更小的一档**
   （宁可紧一点，也不让行内出现 16 造成的基线跳动）。
3. 一次只扫一个界面，扫完看一眼：这一批改的是"同一件事被写成三种尺寸"，
   不是把图标调大调小；改完肉眼看不出差别才算对。
4. 守卫 `iconSizes` 是棘轮（当前 20 种），所以**新增第 21 种会红**，
   但把 13 改成 14 也不会自动让它归零——种数只有在某个值被彻底清空时才下降。

### 11.4 同一个界面要同时活过两种窗口

ToolCove 的视图有两条承载路径，**写视图时默认自己在第二种里**：

| 形态 | 谁提供外壳 | 尺寸 | 对视图的约束 |
|---|---|---|---|
| 主壳内嵌 | `App.vue` 的 `.topbar` + 三轨 `.shell` | 视口宽度，中栏极限约 664px（见 §11.1 阶梯） | 页眉由外壳的 `.page-title` 承担（里面放着全局搜索触发器），**视图不许再画一条 bar 或面包屑条** |
| 独立工具窗口 | `ToolWindow.vue` 的 `.tw-bar`（`decorations: false`，`data-tauri-drag-region`） | 默认 980×720、最小 720×520；工具可用注册表 `window` 字段覆盖（如"显示辅助"类要小一圈好压在游戏上） | **它就是另一个视口**：媒体查询按窗口宽度生效，所以别用 `vw` 做布局假设；改了最小尺寸就要在最小时长看一眼 |

三条由此而来的规则：

1. **主题与密度绑在 `:root`**，两种窗口都跟随（`resolveToolWindowTheme()` 负责工具窗口自己那份），
   所以视图里不许出现"只读 `data-theme` 才成立"的分支——见 §6.1 的两套触发。
2. 工具窗口的紧凑标题条由 `provide("toolWindowChrome", { compact, setCompact })` 交给视图，
   偏好存在 localStorage（按工具键）。**需要窄标题条才用得到它**，普通工具不许自己画第二条 bar。
   目前只有铁路工具在用（`src/tools/rail/View.vue`），这是刻意保持的低耦合，不是漏接。
3. 工具窗口的 toast 是**从主壳 prop drilling 传下来的**（`App → ModuleTabs → ToolWindow → view`）。
   新组件接不上 toast 时，先看 §10 里那条"待改 provide/inject"，**不要再造第二个 toast 实现**。

拦截方式：这一节全部是**走查**——宽度与外壳归属机器判起来噪声大于收益（视图自己声明"我在窗口里"
这件事没有稳定的静态判据）。评审时按 §13 那条"两种形态各看一眼"打勾。

---

## 12. 键盘、表格、表单与非点击输入

### 12.1 快捷键与命令面

| 键 | 行为 | 实现处 |
|---|---|---|
| `Ctrl/Cmd + 1…5` | 切模块（1 Agent / 2 研发 / 3 记录 / 4 工具箱 / 5 设置） | `App.vue` 的 `onKeydown` |
| `Ctrl/Cmd + 0` | 工具箱（保留的旧习惯） | 同上 |
| `Ctrl/Cmd + K` | 全局搜索面板 | 同上 → `GlobalSearch.vue` |
| `Ctrl/Cmd + N` | 新任务（与顶栏同一入口） | 同上 |
| `Enter` | 单行输入提交（实测 37 处） | 各表单 `@keyup.enter` |
| `Ctrl/Cmd + Enter` | 多行文本里的提交（4 处：Agent 发送等） | `@keydown.ctrl.enter` |
| `Escape` | 关浮层/面板（24 个文件已实现） | 各遮罩自己处理 |

> 本节所有计数都是 **2026-10-20 的实测快照**，用来说明"现状是什么样、判据长什么样"，**不是阈值**——
> 代码在长，这些数字会跟着变；守卫盯的是 §0 那张表里的指标，不是这里的计数。

规则（走查判定）：
- 组合键一律判 `(e.ctrlKey || e.metaKey)`——mac 上用户按的是 Cmd；并且必须 `preventDefault()`，
  否则 `Ctrl+N` 会先开出浏览器新窗口。
- **新快捷键只许挂 Ctrl/Cmd 组合**，不要做"单键命令"（会抢走输入框里的字母）；
  也不要与浏览器保留键冲突（`Ctrl+W` / `Ctrl+T`）。
- 快捷键必须在界面上**看得见**：`<kbd>` 提示（现有 8 处），
  窄屏/触屏下隐藏（`.kbd-hint { display: none }`）——触屏没有 Ctrl，写出来只是噪声。

### 12.2 表格与数字

- 列头一律 `<th scope="col">`（本轮补齐 44 个，守卫 `headersWithoutScope` 硬性 0）；
  行头用 `scope="row"`，判据两者都接受。没有 scope，读屏走到单元格只能说"第 3 列"，说不出这一列是什么。
- 数字、ID、时间列用 `font-variant-numeric: tabular-nums`（现有 29 处）或 `--font-num`，
  否则数字一变宽就抖；**数值右对齐、文字左对齐**（`.th-r` / `.c-res` 一类修饰）。
- 长表滚动时表头吸顶：`position: sticky; top: 0; z-index: 1`（桌面 `src/` 里 11 处，手机 `shell.css` 另有 3 处）。
  这里的 `z-index: 1` 是**组件自身层叠上下文内部**的坐标，允许裸整数（§5 的例外条款）。
- 空表走 `.empty`，不要写"暂无数据"四个字了事（§4）。
- 单元格里的可编辑控件用 `.tc-input`，不要自写内边距。

### 12.3 表单校验与提交

- **校验时机**：失焦后或提交时报错，不要边打字边红。
- 错误的三个位置要一致：字段下方文案 · 整体 `.tc-note--fail` · 一次性动作失败的 toast。
- 必填要么用原生 `required`（31 处），要么给可见标记（红点或"必填"二字），
  **不能只靠 placeholder 表达必填**——placeholder 一输入就消失。
- **同一个动作不许连点两次**——但判据**不是数 `:disabled` 的出现次数**。本仓里"调用 async 函数、按钮却没禁用"
  机械扫出来有 **147 处**，绝大多数不该改：本地 store 写入也是 `async`（要 `await` 落盘），
  筛选 chip、跳详情、打开确认弹窗都算进去了。给它们统统加锁既没必要、还会把交互做烂。
  **要问的是这个动作会不会打到外部系统**——触发构建 / 发布 / 上传 / 请求模型 / 弹原生选择器，
  这些重复一次有真实后果（重复构建、两次弹 SAF 面板、结果互相覆盖）。
- 写法照抄仓里已有的，别自创（[src/tools/checkin/View.vue:162](../src/tools/checkin/View.vue)）：
  `const busyKey = ref("")` → 进入时 `if (busyKey.value) return;`、`busyKey.value = key`，
  `finally` 里清空；模板 `:disabled="busyKey === item.key"` 并把文案换成"进行中"。
  整批动作用另一个 `busyAll`，两者互斥。手机自检区（`mobile/app/SettingsView.vue`）就是这个形态的第二例：
  跑全部有 `selfTestBusy` 锁，"单独跑一项"以前**完全没有锁**——连点会开两个文件选择器、
  两个结果互相覆盖，本轮按同一形态补齐（`busyKey` + `:disabled`，进行中文案换 `common.loading`；
  因为一次只允许一项在跑，所有"单独跑一项"按钮共用一把锁，判据写成 `selfTestBusy || !!busyKey`）。
- ⚠️ 更正一条我自己写错过的话：本文早前把 `SnippetView` / `WorkOverviewView` / `PoolStatus`
  列为"`disabled` 出现 0 次"的缺口——**那是计数假象，不是缺陷**。逐个看过：前两者的 async 点击是筛选、
  导航与剪贴板，`PoolStatus` 的发布按钮只做 `publishPool = p`（打开确认面板），真正的外部动作在面板里、
  已带自己的状态机。与 §4 那次"8 个界面无空态"是同一类错误：**度量只能用来找候选，不能用来得结论。**

- **字段错误必须让读屏听得到**（本轮已接）：用 `v-field-error="msg"` 挂在字段容器上
  （[src/ui/fieldError.js](../src/ui/fieldError.js)），机制与 `v-dialog` 同构——
  指令找到里面（或紧邻下一行）那条**当前真的渲染出来的**错误文案，给它补一个稳定 id，
  再在控件上写 `aria-invalid="true"` + `aria-describedby=<那个 id>`；msg 变空就把两个属性摘掉。
  **不抄文案、只指节点**，所以改了词条读屏跟着变。已接 9 处字段容器 / 覆盖 17 条错误文案里的 11 条
  （桌面设置页 5 个 label、手机设置页 3 个、手机照片配置 1 个模板），
  剩下 6 条是面板级/汇总提示，本来就不属于任何一个输入框。
  用了它必须像 `v-dialog` 一样**就地 import**（`fieldErrorDirectiveNotImported` 硬性 0）。
- ⚠️ **别把这套东西批量铺到"所有带 err 字样的节点"**：实测全仓 170 处错误样式里，
  真正的**字段级**错误只有上面那 3 个文件的 17 处，其余是**操作结果态**（转换失败、跑挂了、算不动），
  不对应任何一个输入框。`aria-invalid` 的语义是"用户填的内容无效"，
  把服务端/引擎失败标成 invalid 反而误导读屏——**这是"补了比不补更坏"的那种自动化**。
- **报错之后用户一改这个字段，就收起那条红字**（下次保存再判）。
  不要在视图里重新校验——那等于把 `settingsForm.js` 的规则抄第二份（本仓"同一段计算写第四份"的老毛病），
  也不要让它一路红到用户再次点保存（`aria-invalid` 也就跟着赖着不走）。

### 12.4 非点击输入：粘贴与拖放

这两个入口没有按钮可点，所以**全靠约定**，也是本仓最容易"承诺落空"的地方。实测口径：
文件粘贴入口共 4 处——3 个窗口级监听（[AiExtract.vue:250](../src/views/AiExtract.vue)、
[ProblemView.vue:451](../src/views/ProblemView.vue)、[SnippetView.vue:239](../src/views/SnippetView.vue)，
都按"表单/弹窗是否打开"来 `addEventListener` / `removeEventListener`）+ 1 个元素级
`@paste`（[AgentComposer.vue:657](../src/app/AgentComposer.vue)）；另有 4 处显式按钮走
`navigator.clipboard.read()`（表格工具桌面与手机、`SnippetView`、`ProblemView`）。

- **接管的前提是"剪贴板里有我要的东西"**。四个处理器都写成同一种形状：
  先看 `clipboardData` 里有没有 `image/*`，**没有就直接 `return`，不 `preventDefault`**。
  这是同一个界面里 Ctrl+V 既能把文字粘进输入框、又能把图片粘进附件区的唯一办法。
  新写粘贴入口照抄这个形状，不要"先 preventDefault 再看内容"。
- **窗口级监听必须成对增删**：打开时挂、关闭时移除、组件卸载再兜一次
  （`onBeforeUnmount`）。漏一次的结果是关掉弹窗后仍在抢粘贴。
- **看不见的入口要有发现性与失败回执**。旁边至少有一个"粘贴剪贴板"按钮或占位文案；
  粘失败必须 toast——`SnippetView` 的窗口粘贴是最后一处静默失败（`blobToB64` 抛错就变成
  "什么都没发生"），本轮已按现成键 `snippet.saveImageFailed` 补齐，四个入口现在都有 `catch`。
- **桌面端拖文件不能只挂 `@drop`**。Tauri 把"从系统拖文件进窗口"拦成原生事件，
  HTML5 的 `dataTransfer.files` 拿不到本地文件（见 [src/platform/dnd.js](../src/platform/dnd.js) 顶部注释），
  必须走 `watchFileDrop({ onFiles, onActive })` 拿路径，再用
  [src/platform/droppedFiles.js](../src/platform/droppedFiles.js) 把路径读成 `File`
  （图片管线只认 `File`；单个路径读不到就跳过，但全失败时把后端给的原因 toast 出来——
  不能把"超过 20 MB"说成"没检测到图片"）。
  四个拖放区现在都接了：`AgentComposer`、加密工具、图片工具、`AiExtract`；
  后两者保留 `@drop` 只当浏览器分支（桌面端在 `onDrop` 里直接 return）。
  **判据：画了拖放浮层就必须真的收得到文件**——只挂 `@drop` 的浮层是承诺落空。
  这条仍要在真机上确认（桌面形态的拖放属于本仓自动化盲区，e2e 的 `__TAURI_INTERNALS__` 替身
  不在原生 drag-drop 这条链路上）。**注意区分**：`useDragSort`（PDF 页面排序、迭代列表排序）
  是界面内部的行拖动，不跨原生边界，不受这条影响。

---

## 13. 新界面自检清单

复制到 PR 描述逐条打勾：

- [ ] 颜色全部走令牌，没有裸 `#hex`；新增色已定语义并补深色两套触发
- [ ] 间距只用 `--sp-0/05/1..7`；留白用 `sp-1..7`，2/4px 只在"线"上用
- [ ] 圆角只用 `--r-xs/sm/md/lg/pill`；字号只用 `--fs-*`
- [ ] 组件用 §3 的族；没有新造类名，没有重写底座
- [ ] 遮罩用 `--overlay` + `--z-*`；`≥10` 的 z-index 全是令牌
- [ ] 四态齐：空（有下一步动作）/ 加载 / 错误（三段式）/ 进行中禁用
- [ ] 破坏性操作走 `askConfirm()`；文案与红色只给不可逆动作
- [ ] 键盘：`Escape` 关浮层、Tab 顺序合理、焦点可见、图标按钮有名字
- [ ] 右键菜单项是 `<button role="menuitem">`、打开即有焦点、`↑/↓` 能走、`Escape` 能关（`77-ctx-menu.spec.js` 已钉住）；
      只有鼠标用得上的菜单算缺陷
- [ ] 状态不只靠颜色；长文案有 `.tc-truncate` 退路
- [ ] 文案走字典；中英都试过一次
- [ ] 外壳尺寸用 `--sidebar-w/--rail-w/--topbar-h/--dock-w`，不写 280/56/48/340px；视图不自带第二条顶栏
- [ ] 弹窗盒子挂 `v-dialog` 并 `import { vDialog }`；没有可见标题的传 `{ label: t('…') }`
- [ ] 会"发生后才知道"的信息（toast/结果条）在 live region 里；破坏性结果不只靠颜色
- [ ] 表格：列头有 `scope="col"`，数字/时间列走 tabular-nums，数值右对齐，长表表头吸顶
- [ ] 表单：失焦或提交时才报错；必填有可见标记；**会打到外部系统**的动作在进行中 `:disabled` + 状态文案
      （判据见 §12.3——不是所有 async 按钮都要锁）
- [ ] 字段级错误挂了 `v-field-error`（读屏听得到错在哪句）；用户一改该字段就收起那条红字；
      操作失败（跑挂/算不动）**不要**标 `aria-invalid`（§12.3 的边界）
- [ ] 新快捷键只挂 Ctrl/Cmd 组合并 `preventDefault()`，界面上给出 `<kbd>` 提示（触屏隐藏）
- [ ] 断点复用 §11.2 的五档之一（1180/1000/900/820/760）；图标取 §11.3 的六档之一（不填 13/15/17）。
      两者都另有取值白名单，新值会被守卫判红
- [ ] 两种窗口形态各看一眼：主壳中栏压到最窄、独立工具窗口收到最小尺寸（§11.4）；视图不自带第二条 bar
- [ ] 粘贴入口：剪贴板里没有我要的东西就原样放行（不 `preventDefault`）；窗口监听成对增删；失败有 toast（§12.4）
- [ ] 桌面形态拖文件走 `watchFileDrop`，`@drop` 只当浏览器分支；画了拖放浮层就必须真的收得到文件（§12.4）
- [ ] 改了 `tokens.css` 的取值就跑 `npm run gen:ui-scale`（规范 §2.1 那张表是生成的，不跑就红）
- [ ] `npx vitest run src/styles/`（cssVars + uiSpec）与 `npm run lint` 全绿
- [ ] 动效只用四档时长 + `--ease-out`；减弱动效下信息不丢失

---

## 14. 怎么扩展这套规范（新增令牌 / 组件族 / 守卫指标）

规范如果只有"该怎么写"没有"该怎么改"，下一个人就会手改基线数字、把阈值调大——
这两件事一旦发生，前面所有守卫都变成装饰品。所以这一节把扩展动作钉成流程。

### 14.1 新增或修改一个令牌

1. 改 `src/styles/tokens.css`：浅段 + **两套深色分支**（`@media (prefers-color-scheme: dark)` 里的
   `:root:not([data-theme="light"])` 与 `[data-theme="dark"]`）三处一起补，少一处不会报错，
   只会在那个组合下变成透明/无色（§6.1）。
2. 属于**刻度**族（字号/行高/圆角/间距/控件高/层叠/外壳尺寸）的，还要同步改
   `uiSpec.test.js` 顶部的 `SPACING_SCALE` / `RADIUS_SCALE` / `FONT_SCALE` 三个集合
   （有一条硬性用例 `§2 的刻度集合与 tokens.css 一致` 双向比对这两处：只在 tokens 加一档、
   或只删集合里的一档，都会红）——
   **这里刻意硬写而不是从 `tokens.css` 读**：扩刻度必须是一次看得见的显式改动，
   不能让"随手加个数"就自动变成合规。
3. 跑 `npm run gen:ui-scale` 重写规范 §2.1 的表（不跑就红），再跑 `npx vitest run src/styles/`。

### 14.2 新增一个组件族

1. 只在 `src/styles/primitives.css` 里定义；历史名与 `tc-` 名写成**同一条声明的选择器组**
   （守卫 `familiesRestatedInViews*` / `restatedMaskBases*` / `tcClassWithoutDefinition` 会分别拦
   "在视图里重写底座"、"在 `globals.css` 里定义组件"、"`tc-*` 用了但没定义"）。
2. 手机端要同名族就写 `mobile/app/styles/shell.css`（它不引 primitives），
   并且**如果这个族会被 `:disabled`，同处要补禁用态口径**（守卫 `disabledWithoutAffordance`）。
3. 有可禁用形态的按钮族，禁止在视图里换个名字再拼一遍——那是 `handRolledComponents` 这根棘轮
   在数东西，名单由守卫打印。

### 14.3 新增一条守卫指标

1. 在 `uiSpec.test.js` 的 `measure()` 里加一个**数值**键（不能是对象/数组，棘轮循环只认数字）。
2. `UPDATE_UI_BASELINE=1 npx vitest run src/styles/uiSpec.test.js` 生成基线，
   **然后 `git diff src/styles/uiDebtBaseline.json` 逐行看**：只允许"新增键"或"数字变小"。
   任何一个数字变大，说明你这批改动新造了债务，先修代码再刷新。
3. **必须证明它会红**，两种方式选一种（第二条更常被漏）：
   塞一个违规进去（`__UiSpecProbe.vue` 那种），或者**把已有的合规撤掉**
   （删一条口径/底线），看它是否点名该点名的文件、是否不误伤不该点名的。
   `duplicateCssProps` 这条就是这么验的：把误加的那行 `.tc-note` 放回去，
   守卫精确报 `tc-note.background`；取下来就绿。
   **同一个类里同一个属性写两遍**就是"两份定义开始漂移"，判据是**属性重复**而不是"类出现两次"——
   历史名在共享组之外再补一条**不冲突**的属性是合法写法（`.panel-head` 就是）。
4. 判据要么"当前为 0"（写进 `describe("硬性规则")`），要么进基线当棘轮；
   两条都不是的，就在规范里标成**实测/走查**并写清由谁打勾。
   **绝不允许写一条既无守卫、又不标走查的要求**——那正是当初
   `globals.css` 里"新代码请直接用 `.tc-*`"的下场（实测只兑现 11 处）。

### 14.4 把一条要求从"走查"升成"硬性"之前

先把它报出来的**每一条**读一遍。本仓这条流程救过三次：
图标按钮名第一版按行判报 20 处、实际 2 处；遮罩判据第一版漏检、第二版误伤 24 条；
"`:disabled` 出现 0 次"报的三个界面读完成本就不是缺口。
误报的代价不是红一次，而是把所有人训练成"这守卫又误报了"，从此忽略它。

### 14.5 不要做的事

- 为了指标好看把基线数字调大，或把 e2e 的性能阈值调大（阈值只许降）。
- **为了 `unusedPrimitives` 变小而删掉没人写的 `tc-` 别名**：那 65 个零引用类全是别名，
  删掉等于把 §3 推荐的现代名变成不存在的类名，且历史名与它们是同一条声明、行为完全相同，
  删了不会让任何界面变干净，只会让规范开始说谎。真要降这个数，办法是把一整套自造实现
  （例如现存 6 套 `.segmented` / `.seg` 分段控件）迁到原语上，让 `tc-` 名**被用到**，
  而不是把没人用的名字删掉。
- 批量正则改 CSS/模板——脚本必须**打印每一处改了什么**，且按行/按 needle 精确命中，
  对不上就报错退出（本仓 6 个迁移脚本都是这个形状）。
- 在没看到界面前动宽度/圆角/字号/透明度。规范里凡标"需要真机"的，别用"测试全绿"替代。
- 规范正文里写"实测 N 处"而不附口径。**每个计数都要能用一条命令复现**，
  并且知道它是快照不是阈值（并行会话会让它漂）。



---

## 15. 记录页：列表 + 详情（B · Pipeline 落地）

记录模块（速记 / 问题）从「整屏卡片 + 弹窗」改成两栏，规则如下：

| 面 | 规则 |
|---|---|
| 布局 | 左列固定宽度（速记 300px，问题 340px），右列自适应；两列各自滚动，页头工具条保持不动 |
| 空态 | 落在左列里（图标 → 标题 → 说明 → 新建入口），右列只留一句占位，不再整屏居中 |
| 选中 | 列表行为按钮，选中行左侧 2px 主色条 + 浅底；切换即切详情，不折叠 |
| 编辑 | 详情内就地编辑（速记：标题/分类/正文；问题：标题/备注）；保存后回到只读态，取消不清列表 |
| 新建 | 同一块右栏从空白开始，保存后写入并自动选中；不再先弹窗再回列表 |
| 完整编辑器 | 速记的「字段与图片」、问题的「类型/标签/状态」仍走原弹窗——就地表单只放高频字段 |
| 写入 | 速记走 `repository.create/update`（记录级写）；问题走 `mutate + mergeRecords`（整表合并），与 Agent / 云同步的写入不互相覆盖 |
| 守卫 | `i18nCoverage`（SnippetView ≥50、ProblemView ≥90 个 t() 调用）、`cssVars`（新样式只许引用已定义令牌）、`uiSpec` 的裸值/间距/圆角棘轮继续适用 |

未覆盖：移动端 `mobile/app/RecordsView.vue` 仍是旧结构，等桌面稳定后单独一轮对齐。
