# UI 升级与解耦改造：进度与约束

日期：2026-10-12 · 关联：[toolcove-positioning-and-module-review.md](toolcove-positioning-and-module-review.md)

这份文档记录**改造过程中的关键约束与踩过的坑**。它们不是结论，而是"下次动手前必须知道的事"。

---

## 一、必须守住的三条约束

### 1. 浏览器端**不能**改成构建期裁剪

`e2e/` 有 40+ 条用例依赖「web 构建 + 注入 `window.__TAURI_INTERNALS__` 即桌面形态」这个机制
（`e2e/helpers.js:238` 的 `seedDesktopIpc`）。改成 `__PLATFORM__` 构建期常量会让这批用例全部失效。

因此平台判定保持**运行时**（`src/platform/env.js`），解耦只做在分发层：
`invoke.js` 不再内联浏览器实现，改为委派给 `backends/{browser,mobile}.js`。

### 2. `parity.test.js` 的守卫指向会随拆分移动

`mobile/app/parity.test.js` 用**读源码文本 + 正则**的方式断言平台层结构。抽取后端时必须同步更新它：
- 浏览器实现的断言从 `src/platform/invoke.js` 改指 `src/platform/backends/browser.js`
- 手机端回退的断言从「`if (isMobile)` 到 `if (isDesktop)` 之间」改为盯住 `invokeMobile()` 函数体
  ——形态变了但守卫的**意图**（必须有条件回退）不能变

### 3. 样式拆到独立文件后，`globals.css` 必须**最后**引入

`main.js` 里的顺序是 tokens → primitives → globals，原因是 globals 含旧类名的**兼容别名**，
需要覆盖 primitives 里同名的现代写法。顺序颠倒会让 `.tc-chip` 之类的类落到错误的一份定义上。

---

## 二、两个反直觉的 CSS 事实

### 1. 未定义的 CSS 变量会让**整条声明失效**，不是取空值

```css
background: var(--soft);   /* --soft 未定义 → 这条声明被浏览器丢弃 */
```

元素保持继承来的透明底。**界面不报错、测试不红、控制台无 warning。**
`src/styles/cssVars.test.js` 就是为此存在的——它同时禁止"无 fallback 的缺失引用"与"死令牌"。

### 2. BEM 修饰符里的 `--x` 不是变量

`.tc-btn--outline { }` 中的 `--outline` 会被朴素的 `--name:` 规则误判为"定义了一个变量"。
写 CSS 变量扫描类工具时必须先剥离选择器，否则噪声淹没真问题。

---

## 三、踩过的坑（都已修正，记录以免重犯）

| 坑 | 现象 | 教训 |
|---|---|---|
| **CRLF 行尾污染** | 用 Node 脚本批量改文件时，`fs.writeFileSync` 把 `DbTool.vue` 从 LF 变成 CRLF，产生 3774 行假 diff 并弄坏 3 个测试 | 批量改文件前先查行尾；`.gitattributes` 存在时 git diff 会放大这个差异 |
| **过度删除** | 把 10 处 `@keyframes spin` 全删了，但其中 4 处用的是 `animation: spin`（不是 `class="spin"`），关键帧是**在用的** | 删"重复代码"前先确认每个副本的**引用方式**，同名的两种用法只一种是冗余 |
| **空扫描静默通过** | 变量守卫第一版 ROOT 路径算错一层，扫到 0 个文件，但 3 条断言里 2 条"通过"了 | 断言集合里必须有一条"扫描规模合理"的下限检查，否则扫描器坏了也显示全绿 |
| **CLI 改文件破坏编码** | 用 PowerShell `-replace` 重写含中文的 .js，把 UTF-8 写成乱码并破坏引号配对 | 含非 ASCII 的源码文件只用 `write`/`edit` 工具改，不用 shell 重写 |
| **脚本追加末尾换行** | 批量删样式时给原本无末尾换行的文件补了一个，diff 尾部多出一行 `+` | 拼回文件前用 `/\r?\n$/` 判定原文是否以换行结尾，原样保持 |
| **ESM 的 import 会被提升** | 把 `import` 写在文件中间看似可用，实则 `DESKTOP_TOOLS` 为 `undefined` | `import` 一律放文件顶部；`defined?.x` 这种可空访问掩盖不了"整个模块没加载" |
| **"抄写死"的令牌值静默漂移** | 手机端 `shell.css` 自带一份颜色，与 tokens.css 逐条"对齐"——审计实测已有 3 处不一致（`--m-muted` ×2、深色 `--m-danger`），两端都能正常渲染，没有任何测试会红 | 跨端共享的值不要抄，**改成别名**：手机入口先 `import tokens.css`，`--m-*` 一律 `var(--…)`。角色可以不同（深色下 `--m-primary` 取 `--primary-hover`，因为手机上主色多用作文字），但**值只有一份** |
| **CRLF 文件被整文件跳过** | `tokenize-spacing.mjs` 为避免假 diff 直接跳过 CRLF 文件，结果是 `ToolWindow.vue`（独立工具窗口）与 `SnippetView.vue`、`ConfirmDialog.vue` 永远不吃密度档——**规避假 diff 的代价变成了真功能失效** | 正确做法是"按文件保留行尾"：归一成 LF 处理，写回时按原样换行，并断言行尾状态没变。本轮已改脚本并补上 43 条声明 |
| **守卫的判据写得比代码还窄** | 别名判据写成 `/^var\(--[a-z-]+\)$/`，`--sp-4` 因为带数字被判定为"不是别名"，一条真通过的用例被误判失败 | 写守卫时先拿**已知的合法样本**跑一遍；判据宁可宽松 + 另加一条精确断言，也不要窄到把正确写法判成违规 |
| **编辑工具吞掉换行** | 用 Edit 替换 `export const WORK_SOURCES = {\n` 时 new_string 没带回换行，下一行被并到同一行——单看diff 不明显，语法还成立 | 老串带换行、新串也必须带；改完至少 `sed -n` 看一眼那两行 |

### 每一条"守卫"都要证明它会红

本轮新加的 4 个守卫（`importBoundaries` / `i18nCoverage` / `workDataSingleSource` / `mobileTokens`）
都做过**注入违规**的负向验证：往 `agent/config.js` 加一条 `import "../tools/yaml.js"`、
往手机概览模板塞一个 `<p>守卫自检</p>`，确认对应断言真的失败，再把探针删掉。
一个从没失败过的绿色断言，和一条坏掉的扫描器等价——上面「空扫描静默通过」就是踩过一次的教训。

### ⚠️ 最重要的一条：`e2e/helpers.js` 用**原生 Node** 加载移动端模块

`e2e/helpers.js:579` 与 `e2e/specs/42-mobile-db.spec.js:9` 会直接
`await import("../mobile/app/toolbox.js")` / `import { DESKTOP_ONLY_KEYS } from ...`，
用的是 **Node 自带的 ESM loader**，不是 Vite。

后果：**`mobile/app/**` 下的模块不得引入任何依赖 JSON import 的模块。**
`src/toolboxTools.js` 顶部 `import { i18n } from "./i18n/index.js"` → i18n 再 import 词条 JSON，
Node 于是抛 `needs an import attribute of "type: json"`。

这个错误的隐蔽之处在于它**不报"某个用例失败"，而是让 Playwright 收集不到任何用例**：

```
$ npx playwright test --list
TypeError: Module ".../src/i18n/zh-CN.json" needs an import attribute of "type: json"
Total: 0 tests in 0 files
```

退出码是 1，但一条 `✘` 都没有——看起来像"跑得太快没输出"，实际是套件根本没起来。

**所以**：`mobile/app/toolbox.js` 里的图标映射只能写死，
靠 `mobile/app/toolboxIcons.test.js` **读桌面注册表源码文本**来比对一致性，
而不是 import 桌面注册表。（这条已踩过一次；写死的映射当时抄错了 4 个图标名，也是那条用例抓出来的。）

---

## 四之二、同名不同义的类，不能统一

`.field` 在 18 个文件里出现，审计把它算作"18 处重复"。实际是**两个不同的东西**：

- **A**：工具面板里的纵向表单字段（7 个工具逐字相同：`flex column` + `gap --sp-1`）
- **B**：工作台视图里的裸标签容器（`display:block; margin-bottom`）

若图省事统一成一个全局 `.field`，A 的 flex 会毁掉 B 里依赖块级换行的排版。
所以 `globals.css` 里**刻意不提供** `.field` 别名，并在注释里写明了原因——
把"这里为什么不做"记下来，比留下一个看不出意图的空白更省下一个人重新踩一遍。

同样的判断也适用于 `.empty`（已统一，7 份确实逐字相同）与 `.panel`（已统一）。

---

## 四之三、两端各自的真相源

界面上的同一件事，两端**只能有一处定义**，否则迟早漂移：

| 事实 | 真相源 | 手机端怎么用 |
|---|---|---|
| 导航模块与图标 | `src/navConfig.js` 的 `NAV_MODULES` | `Shell.vue` 直接 import（navConfig 是纯数据，不碰 JSON，安全） |
| 工具与分组图标 | `src/toolboxTools.js` | **只能抄写死**：该模块依赖 i18n→JSON，Node 加载不了（见上面的 ESM 陷阱）。由 `toolboxIcons.test.js` 读源码文本比对 |
| 颜色/圆角/间距令牌 | `src/styles/tokens.css` | `main.js` **直接 import tokens.css**，`shell.css` 里的 `--m-*` 一律写成 `var(--…)` 别名——一个裸色值都不留（此前是手抄一份值，实测已漂 3 处）。守卫见 `mobile/app/mobileTokens.test.js` |
| 工时聚合与迭代进度 | `src/shared.js` + `src/requirementMetrics.js` | 桌面两端与手机都调同一对纯函数（见下面「四之五」） |
| 主题/密度 | `src/theme.js` + `<html data-*>` | 手机端不挂 `data-theme`，因此自动走 tokens.css 里的 `prefers-color-scheme` 分支——跟随系统，且取值仍来自同一份令牌 |

`mobile/app/parity.test.js`、`mobile/app/toolboxIcons.test.js` 与 `mobile/app/mobileTokens.test.js` 守着这些关系。

---

## 四之五、同一段计算写第四份之前先看这一节

第 5 轮（工时聚合与迭代进度）实测到的漂移，比"代码重复"这四个字严重得多：

| 位置 | 它以为自己在做什么 | 实际结果 |
|---|---|---|
| `WorkOverviewView.vue` 的日合计 | 「与任务页同一口径」 | 缺 `subtasks[].logs` 明细分支：跨天登记的工时，概览整笔记到子任务归属日，任务页按实际登记日拆开——**两个页面显示两个数** |
| 手机端 `work/WorkOverview.vue` 的进度 | 注释写着「与桌面端同一口径」 | 用 `req.status === "done"` 判定，而需求的数据模型（`src/tasks.js:4`）里**根本没有 status 字段**，只有 `done` 布尔——手机概览的迭代进度**恒为 0%** |
| 同一文件的工时聚合 | 第三份遍历 | 既没有明细分支，也没有"只算自己的"过滤——手机把全组的工时都算进「今日工时」 |
| `TaskView.vue` 的日条目模板 | 「迭代来源的条目都能就地编辑」 | 对**所有** `source === "iteration"` 的条目取 `e.s.id`；历史「记一笔」（需求级 `logs`）没有子任务引用，只要某条需求留着旧数据，打开那一天就 TypeError 白屏 |

修法不是"把三份对齐"，而是**只留一份**：

- `shared.collectDayLogs()`（已有，规范实现）成为唯一入口，三处消费方都调它；
- 新增 `shared.sumHoursByDate()`（按日合计）与 `shared.partitionDayLogs()`（可编辑子任务行 / 只读旧记录行）；
- 新增 `requirementMetrics.iterationProgress()`，桌面概览、迭代页、手机概览都用别名 `progress` 取它。

守卫是 `src/workDataSingleSource.test.js`：它断言这三处消费方**必须引用**这两个函数、且视图里**不许再出现**自己数 done/total 或拼 `source: "iteration"` 的写法。这类"读源码文本比对"的守卫在本仓已有先例（`parity.test.js`、`toolboxIcons.test.js`），比写一份"对齐清单"文档可靠。

---

## 四、当前验证基线

```
单测    156 文件 / 2483 用例 全绿
lint    0 error（74 warning 是项目既有的工具噪音，刻意保留）
构建    桌面 vite build / 浏览器 build:web / 手机 build:mobile 三者全绿
E2E     354 用例全绿（10.4 分钟；含 20-performance / 22-locale 那个单独计时 project）
```

### E2E 实况

**全绿**：354 用例全数通过（第 6 轮收尾时复跑，无失败、无 flaky 命中）。

其中 `67-prompt-tool` 的 2 条图片预览失败**已修复**（原为预存缺陷）：
替身 `convertFileSrc` 不忠于真机（返裸路径而非 asset URL）+ 断言写错了平台分支
（在桌面形态下断言 base64）。根因与修法见
[known-issues-prompt-tool-image.md](known-issues-prompt-tool-image.md)——**产品代码 `imageSrc()` 的分流是对的，改的是测试基建。**

**已知 flake（非回归，勿误判为样式破坏）**：以下两条在**全套件并行满载**时会偶发失败，
单独跑各自 spec 稳定通过。实测各跑 8 次：6 次全过、2 次命中。
第 6 轮收尾的那次全量复跑（354 用例）两条都没有命中。
```
67-prompt-tool.spec.js:189   搜索/分类筛选/置顶排序（刷新后保持）
43-mobile-label.spec.js:40   预览画的也是引擎给的绘制模型
```
排查结论：**不是改造引入**。
- `67-prompt-tool:189` 的置顶写走 `repository.mutate`，该路径**没有防抖**、
  `await persistValue()` 落盘成功才返回，理论上 reload 前必然已写盘；
  唯一相关改动是 `ToolboxView.vue` 里 `8px` → `var(--sp-2)`，而 `--sp-2` 默认档正是 `8px`（**等值替换**）。
- `43-mobile-label:40` 是 WASM 引擎编译竞争下的 canvas 像素比对。
两条都表现为"跑慢了就偶发"，是时间竞争，不是样式回归。

### 新增守卫

| 文件 | 守什么 |
|---|---|
| `src/styles/cssVars.test.js` | CSS 变量双向引用：无 fallback 的缺失引用 + 死令牌 |
| `src/RunProgress.render.test.js` | 运行进度条三态与边界（未结束不显示旧工具名、maxSteps=0 不画条） |
| `mobile/app/toolboxIcons.test.js` | 手机端图标必须来自桌面注册表，不能另抄一份；未知 key 走兜底 |
| `mobile/app/parity.test.js`（扩） | 标签栏必须复用 `NAV_MODULES` + 共享 `Icon`，且**每个桌面模块都有手机端视图分支**（漏一个会静默渲染空白页） |
| `src/importBoundaries.test.js` | 按**解析后的真实路径**守分层：`agent↛tools`、`platform↛任何上层`、`tools↛*View.vue`、`data↛视图与工具`；带扫描规模下限，防止扫空了还全绿 |
| `src/i18nCoverage.test.js` | 研发管理/记录两端共 12 个界面**必须走字典**：`t()` 数量下限 + 脚本里不许有中文字面量 + 模板文本节点不许有中文。补的是「键存在性守卫看不见整段界面没用字典」这个洞 |
| `src/workDataSingleSource.test.js` | 工时聚合与迭代进度只许有一处实现（`collectDayLogs` / `sumHoursByDate` / `partitionDayLogs` / `iterationProgress`），视图不许再自己数 done/total 或拼 `source: "iteration"` |
| `mobile/app/mobileTokens.test.js` | 手机端 `--m-*` 必须是 `var(--…)` 别名：不许裸色值、不许近似值 fallback、引用到的令牌都要有定义、`tokens.css` 必须早于 `shell.css` 引入 |
| `src/i18nKeys.test.js`（既有） | 组件引用的每个 `t()` 键都真实存在 |

### 工具

- `scripts/merge-i18n-fragments.mjs` — i18n 片段合并，带四类校验（键集合一致 / 值非空 / 键无空白 / 不重复定义），任一不过就拒绝写入
- `scripts/migrate-duplicate-panel-styles.mjs` — 样式去重迁移，**逐文件保留行尾**
- `scripts/tokenize-spacing.mjs` — 盒模型间距令牌化；**按文件保留行尾**（CRLF 文件归一成 LF 处理、写回时换回去，并断言行尾状态没变）
- `scripts/analyze-import-boundaries.mjs` — 依赖边盘点（分析用，非守卫）：`node scripts/analyze-import-boundaries.mjs [过滤词]` 打印各跨区边的实例与数量，写边界规则前先看不越界的边有哪些

### 间距令牌化（第 4 轮）

**动机**：密度档（`:root[data-density="comfort"]`）只改 7 个 `--sp-*` 令牌，
而源码里有 **2136 处**写死的 px 间距与它无关——**"切到舒适档"对绝大多数控件根本不生效**。
用户改了设置、看到的变化微乎其微。

**边界**（刻意排除，理由写在脚本注释里）：
- 只改 `margin*` / `padding*` / `gap` / `row-gap` / `column-gap`
- **不含** `top/right/bottom/left/inset` —— 那是**坐标不是间距**。
  TaskView 的月度图有 `inset: 0 0 38px` 与 `bottom: calc(38px + (100% - 38px) * X)`
  这套坐标系；若只令牌化其中一个，密度档一切换图表坐标轴就对不上。（已单独回归验证）
- **不改** border / width / height / font-size / border-radius / flex-basis / transform
- 只吸收 6/8/10/12/14/16/20px 这 7 个有对应令牌的值；5px/7px/9px/11px 等"半档"值留着
  —— 给它们建令牌会让刻度退化成 25 档
- **负值不动**（`margin: -8px 0` 那类 tab 下划线/提示偏移）—— 它不该随密度缩放
- 已是 `var(...)` 的值不动；**CRLF 文件不再跳过**——按文件保留行尾写回
  （第 6 轮补：`ToolWindow.vue` 5 条、`ConfirmDialog.vue` 5 条、`SnippetView.vue` 25 条，
  行尾维持 CRLF、diff 只含改动行；`WelcomeView.vue` 唯一的裸值是 `padding: 40px`，不在刻度内）

**结果**：969 条声明 / 50 个文件改为 `var(--sp-N)`（第 4 轮），第 6 轮再补 35 条 / 3 个 CRLF 文件，
计算值不变（单测、构建、E2E 全绿），
但**从这一刻起它们会随密度档一起缩放**。对照 `tmp/spacing-audit.mjs` 可随时复盘点账。

---

## 五、剩余工作清单

1. **手机端记录页 / 工作台的版式统一** —— 令牌层已经统一（`--m-*` 全是 tokens.css 的别名，
   漂移不再可能），但**版式**仍是手机自定的一套：字号用 rem、卡片圆角与阴影口径与桌面不同。
   要继续统一得先看真机界面，不能只对着 CSS 改。

   ⚠️ 别名化带来四处**真机要看一眼**的观感变化（值换了，不是纯重构）：

   | 令牌 | 旧值 | 现值（别名指向） |
   |---|---|---|
   | 浅色 `--m-bg` | `#ffffff` | `--bg` = `#f6f8fa`——卡片与画布拉开层次，此前手机是「白底 + 白卡 + 描边」 |
   | 浅色 `--m-soft` | `#f6f8fa` | `--card-soft` = `#fafbfd`——更弱的一档，与桌面一致 |
   | 深色 `--m-soft` | `#1c2128`（抄的 `--card-raised`） | `--card-soft` = `#10151c`——按角色取，不再按"看着接近"取 |
   | 深色 `--m-border` | `#30363d`（抄的 `--border-strong`） | `--border` = `#21262d`——描边更弱，卡片边界改由 `--card` 与 `--bg` 的明度差承担 |

   深色下主色的**角色差异保留**：`--m-primary: var(--primary-hover)`（`#58a6ff`），
   因为手机上主色多用作文字/链接，`--primary`（`#2b6ad0`）在 `#0d1117` 上对比不足。
   这类"角色不同但值仍只有一份"的写法，是别名化能落地而不必牺牲可读性的原因。
2. **剩余裸间距令牌化** —— 已吸收 1004 条，还剩约 1100 条值不在令牌刻度内
   （5/7/9/11/13/18/22px 等"半档"值）。是否扩刻度是产品决策：
   刻度越细，"密度档"能表达的变化越少，二者需要权衡。
3. ~~CRLF 文件的间距令牌化被跳过~~ —— 第 6 轮已解决：脚本改成按文件保留行尾。
4. **根目录分区的剩余部分**（评审文档 §2.3）—— 第 7–11 轮已经搬掉四块：
   `src/ui/`（原子）、`src/tools/interview/`（题库孤岛）、`src/views/`（22 个界面）、
   `src/app/`（18 个外壳/框架），并把 564 行的 `shared.js` 拆成 `src/shared/` 下 8 个领域文件。
   根目录非测试文件 **79 → 47**。
   剩下的 47 个是四个族群混住：工具纯逻辑（json / xmlTool / tableTool / imageTool…约 27 个）、
   业务数据层（iterations / releasePools / snippets / weeklyReport…）、AI 客户端层
   （ai / chatSession / comfy* / streamJson）、工具箱注册表与视图状态（toolboxTools / Store / Semantic / ViewState / toolComponents）。
   **2026-10-13 决定先不再拆**：再切四个目录的收益主要是"看着整齐"，
   而代价是上百条 import 加一批按路径读源码的守卫要再跟一轮；
   真要动，判据应该是"某个族群已经出现过误改"，而不是"它能被分类"。
   `importBoundaries.test.js` 现在守住的边界（agent↛tools、platform↛上层、tools↛views、
   ui↛上层、shared↛上层）已经足够让"分层"这件事不会因为下一次改动悄悄失效。

措辞已定的一处，记录理由免得被改回去：`nav.work` 从「工作台」改成「研发」（英文 `Work` → `Delivery`），
因为「工作台」同时是产品定位词（README 首句、Agent 首屏标题 `agent.hintTitle`）又是六个业务模块的
导航名，同一个词在两处指两件事。`release.workbenchTitle`（"Pool 发布工作台"）保留——
它指的是发布页里那张逐步清单，不与导航撞名。

不建议在没看到界面前动的两处：`.field` 同名不同义（见上文），
以及宽度/圆角/字号——它们不是间距。

---

## 六、第 5–6 轮改动清单（2026-10-12 收尾）

第 1–4 轮做的是「设计令牌 / 组件原语 / 间距令牌化 / 平台层解耦」。
第 5–6 轮按 [toolcove-positioning-and-module-review.md](toolcove-positioning-and-module-review.md)
的问题清单往下清，落在这里：

- **第一步剩余三条**：`yaml.js` 上移（消掉唯一的 `agent→tools` 边）、
  `WorkOverviewView` 改用 `collectDayLogs`、`nav.work` 改名「研发」/`Delivery` + `welcome.body` 改成定位陈述。
- **工时与进度收成一个实现**：新增 `shared.sumHoursByDate` / `shared.partitionDayLogs` /
  `requirementMetrics.iterationProgress`，桌面概览、迭代页、任务页、手机概览四处都改为调用它们。
  过程中修掉两个错值（概览跨天工时算错日、手机迭代进度恒 0%）和一个白屏点（历史「记一笔」条目缺 `s` 引用）。
- **门禁**：`importBoundaries.test.js`、`i18nCoverage.test.js`、`workDataSingleSource.test.js`、
  `mobileTokens.test.js` 四个守卫（都做过注入违规的负向验证）；`parity.test.js` 扩到「每个桌面模块都要有手机端视图分支」；
  eslint 侧记录了「为什么边界不在 lint 里做」。
- **手机端令牌别名化**：`main.js` 先引 `tokens.css`，`--m-*` 全改 `var(--…)`，裸色值与近似 fallback 清零。
- **CRLF 文件的间距令牌化**：`tokenize-spacing.mjs` 从「整文件跳过」改成「按文件保留行尾」，补上 35 条声明。
- 新增分析工具 `scripts/analyze-import-boundaries.mjs`（依赖边盘点，写边界规则前先看现状）、
  搬迁工具 `scripts/move-into-subdir.mjs`（按**解析后的真实路径**重算全仓相对 import，含 `vi.mock()` 与动态 import，按文件保留行尾）。

## 七、第 7–9 轮（结构搬迁，2026-10-13）

按评审文档 §三 的清单往下走，三笔纯结构改动：

- **第 7 轮：题库孤岛** —— 24 个 `interviewBank*` / `interviewImport` / `interviewProgress` 文件从
  `src/tools/` 平铺搬进 `src/tools/interview/`。`src/tools/` 从 107 个文件降到 83 个。
- **第 8 轮：UI 原子层** —— `Icon.vue` / `ConfirmDialog.vue` / `confirm.js` / `dragsort.js` /
  `ToolErrorPanel.vue` 搬进 `src/ui/`，全仓 86 条 import 由脚本重算（`Icon.vue` 一个就有 61 个引用方）。
  `importBoundaries.test.js` 加了一条「`src/ui/**` 只依赖 vue、i18n 与彼此」，
  否则原子层会慢慢又长回上层的依赖，白搬一次。
- **第 9 轮：`tasks.js` → `iterations.js`** —— 文件名不再骗人（里面从来没有"任务"集合），
  导出符号本来就按迭代/需求/子任务命名，所以只改文件名与 4 处 import + 12 处注释。
  顺手修了文件头两处失真：迭代状态枚举写成 `plan|dev|done`（实际 `plan/dev/test/pending/live`），
  以及没写明**需求只有 `done` 布尔、没有 `status`**——第 5 轮手机端进度恒 0% 就踩在这个字段上。

### 这两条经验值得单独记

1. **`move-into-subdir.mjs` 只改 import 语句，改不到"按路径读源码"的字符串。**
   本仓有一类特殊的耦合：守卫用 `readFileSync(resolve(process.cwd(), "src/tools/interviewImport.js"))`
   这种方式读源码文本来做静态断言（`InterviewTool.render.test.js`、`mobile/app/parity.test.js` 都这么干）。
   移动文件后这类引用**不会报错，只会静默读不到**——而它们大多是 `toContain(...)` 型断言，
   读空字符串照样可能通过。搬完全仓要专门 grep 一次旧路径字符串。
2. **`vi.mock("./confirm.js")` 的 specifier 不是 import 语句。**
   搬走 `confirm.js` 后 `src/updater.test.js` 的 4 条用例失败：mock 路径还指旧位置，
   而被测模块已经 import 新路径，于是 mock 完全没生效、弹真实确认框。
   脚本后来把 `vi.mock(` / `jest.mock(` 也纳入改写范围（`--apply` 前先看 dry-run 清单）。

## 八、第 10–11 轮（根目录分区与 shared.js 拆分，2026-10-13）

- **第 10 轮：界面与外壳搬家** —— 22 个界面文件进 `src/views/`，18 个外壳/框架文件进 `src/app/`
  （`App.vue` / `navConfig` / `settingsConfig` / `migrate` / `toolWindow` / `accentTheme` / `telemetry` /
  `updater` / `theme`，以及 `ToolWindow.vue`、`ModuleTabs.vue`）。入口 `main.js` 留在 `src/` 根
  （`index.html` 直接引它）。根目录非测试文件从 77 降到 47。
  跟着改的守卫：`i18nCoverage` / `workDataSingleSource` 的文件清单、`parity.test.js` 读 navConfig 的路径、
  以及 `importBoundaries` 里「什么算视图」的正则——**分区会让按旧路径写的判据静默失去匹配对象**，
  这是本轮最值得记住的一点（判据匹配不到东西时，断言照样通过）。
- **第 11 轮：拆 `shared.js`** —— 564 行、横跨五个领域的杂物间拆成 8 个领域文件：

  | 新文件 | 装什么 | 行数 |
  |---|---|---|
  | `shared/dates.js` | fmtDate / weekday / isWorkday / nextReleaseDate / startOfWeek / relativeTime | 63 |
  | `shared/hours.js` | collectDayLogs / sumHoursByDate / partitionDayLogs / WORK_SOURCES / subLogsByDate / subRemaining / subPushedHours / workHoursRows | 162 |
  | `shared/xlsx.js` | 上线包三表、工时表、数据库结果集三种导出（exceljs 仍是动态加载） | 186 |
  | `shared/markdown.js` | renderMarkdown（本仓唯一把文本变 HTML 的地方，转义前提写在文件头） | 142 |
  | `shared/pkg.js` | 上线包三张表的列定义与建行 | 43 |
  | `shared/links.js` | 平台链接与 bug 状态的纯解析 | 47 |
  | `shared/errors.js` | errText | 18 |
  | `shared/workMeta.js` | 研发管理面的词表：TYPES / DOMAIN_COLORS / RELEASE_ROLES / SORTS | 47 |

  26 个导出**一个不丢**（脚本比对 HEAD 的导出集合验证），508 行的 `shared.test.js` 同步拆成 5 个
  领域测试文件。17 个引用方按符号改成引具体模块，**没留 barrel**——留 barrel 等于把
  "这行代码属于哪个领域"这个问题原样留给下一个人。
  新增边界规则：`src/shared/**` 只许依赖自己的分模块、i18n、platform 与 highlight。

  顺带清掉一处失真：`buildReleaseXlsx` 与 `buildWorkHoursXlsx` 里逐字复制了 11 行的标题行代码，
  拆文件时提成 `addXlsxTitle()`；两条导出链路的平台差异（DB 结果集走 Rust 直写、另两张表走 exceljs+base64）
  在文件头写明**刻意不合并**。

### ⚠️ 拆 `shared.js` 时最容易做错的一件事：import 前缀

`shared.js` 拆成 8 个领域文件后，17 个引用方要从
`import { fmtDate, errText } from "../shared.js"` 变成两条 `../shared/dates.js` / `../shared/errors.js`。
拆分脚本按「剥掉 `shared.js` 剩下的就是目录前缀」来拼新路径，于是

```js
"../shared.js"           →  "../" + "dates.js"   →  "../dates.js"          // ✗ 少了 shared/
"../../../src/shared.js"  →  "../../../src/" + "markdown.js"                // ✗ 同样错
```

**相对路径越短越容易错**——只有一层 `../` 时"目录前缀"看起来是空的，人就默认不用再拼一段。
Vite 这次替我抓出来了（解析失败直接报错），但真正麻烦的是另一类不会报的：
守卫里 `readFileSync("src/shared.js")` 这种路径字符串。
收尾办法是写一个只认**真实路径**的校验器（`tmp/check-dangling-paths.mjs`）：
把每条相对 specifier 与每个 `"src/…"` 形态的字符串都解析一次，指不到文件的列出来——
一次跑出 36 处悬空，两类引用（import 与路径字符串）都覆盖到。
判据很简单：**存在性**是唯一可信的信号，"看起来像路径"不是。