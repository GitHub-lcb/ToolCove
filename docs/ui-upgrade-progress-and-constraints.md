# UI 升级与解耦改造：进度与约束

日期：2026-10-12 · 关联：[toolcove-positioning-and-module-review.md](toolcove-positioning-and-module-review.md)

**写界面/改样式请先看 [ui-ux-spec.md](ui-ux-spec.md)**（现行规范：令牌刻度、组件词汇表、
状态矩阵、层叠、主题密度、无障碍、文案、手机端、债务与迁移顺序）。
这份文档记录的是**改造过程中的约束与踩过的坑**——规范告诉你该怎么做，这里告诉你为什么这么做。
它们不是结论，而是"下次动手前必须知道的事"。

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

## 九、第 12 轮：把规范写成能执行的东西（2026-10-20）

规范文档落在 **[ui-ux-spec.md](ui-ux-spec.md)**。这一轮解决的是"规范凭什么生效"，
而不是"再写一份更详细的规范"——因为本仓已经失败过一次：
`globals.css` 注释里写着"新代码请直接用 `.tc-*`"，实测全仓 .vue 里只兑现 **11 处**，
同时 `globals.css` 另抄了一份数值并开始漂移（同一个"主按钮"，旧名 `padding: 9px var(--sp-6)`、
新名 `height: var(--control-h)`，两套几何并不一致）。**一句没人执行的注释比没有注释更糟**：
它让下一个人以为已经有标准了。

### 做了什么

| 动作 | 规模 | 观感影响 |
|---|---|---|
| 组件族收敛成"同一份声明、两个名字" | `primitives.css` 重写、`globals.css` 387→126 行（只剩 body/滚动条/右键菜单/过渡/演示聚光） | 无（数值逐条照搬），除了下面三行 |
| z-index 归 6 档层叠刻度 | 32 处调用点 / 18 个魔法值清零（`scripts/tokenize-zindex.mjs` 按行精确替换） | 相对次序逐条核对过；监控条(120)现在低于模态遮罩(200) |
| 遮罩底色统一 `var(--overlay)` | 11 处：脚本先改 6 处，守卫又抓出 5 处各自实现的遮罩（chat / disk / rail / ConfirmDialog×2） | 浅色下 3 处遮罩由 .4/.42/.35 → .5（略深一档），**深色下全部真的变深**（此前只有一半生效） |
| 新增微间距 `--sp-0`(2px) / `--sp-05`(4px) | 406 条声明 / 63 个文件（含手机 shell.css 96 条） | 等值替换；这两档**刻意不参与密度缩放**（是"线"不是"面"） |
| `.modal` 补 1px `card-border` | 73 个历史 `.modal` 调用点 | 浅色下多出一条极淡的边，换来两种主题边界一致 |
| `.icon-btn` 尺寸改取 `--control-h(-sm)` | 106 处（模板用法；另有 24 条 scoped 规则跟着改口径） | 默认档等值 30/24；**舒适档从 30 长到 34**（此前密度档对图标按钮完全无效） |
| 遮罩族收敛成"底座 + 语义钩子" | 16 处自写底座 → 桌面 **0** 处（`scripts/migrate-masks-to-primitive.mjs`，29 个改写点） | 图片预览的内边距 32px 归到底座的 20px；确认弹窗盒子的内边距 24px→`--sp-7`、阴影换成 `--shadow-pop` |
| 组件底座骨架（族名沿用型）清零 | 5 个文件的 `.panel/.empty/.st-chip` 骨架 → 0（硬性指标） | 照片工具那套自定状态胶囊色（`--ok-soft/--ok` 等）挂回共享状态层；中性一枚的底从 `--ghost` 变 `--well` |
| 应用外壳尺寸收成令牌 | `--sidebar-w/--rail-w/--topbar-h/--dock-w/--dock-w-sm` 五档，App.vue 里 31 行改写 | 等值替换；`shellGeometryLiterals` 钉成硬性 0（此前 280/56/48 是组件里的裸数字，而 e2e 恰好断言着这三个尺寸） |
| 补齐规范缺的两块 | 新增 §11：外壳骨架/视口断点/图标刻度；指标 `viewportBreakpoints`=17、`iconSizes`=20 记为棘轮 | **只钉刻度不批量改**：13→14 会动 218 个图标，属于必须看着界面做的批量 |
| 对话框语义与焦点收成一个指令 | 新增 `src/ui/dialog.js` 的 `v-dialog`（两端入口都注册），挂到 31 个桌面遮罩站点 + 7 个手机端 `.m-modal`；toast 补 `role=status`+`aria-live` | 读屏下弹窗从此有名字、焦点会进/会回；界面上没有可见变化（除新增的语义属性） |
| 无障碍从"走查"升成硬性 + 补齐 | 图标按钮可访问名、对话框语义、live region、界面 aria/role 四项都变硬性 0；补了 `RunProgress`(status+progressbar)、`ProblemView`(list/listitem)、两张表格(复用页签名/小标题做 `aria-label`/`aria-labelledby`) | 全部**零新文案**：播报内容就是可见文字本身。2 个界面走"写理由的豁免"（`PoolStatus`、`WelcomeView`） |
| 规范里的数字全部换成可复核的 | §4 原来写"8 个界面无空态"——**实测不成立**：按"`v-for ≥ 3` 且没渲染 `.empty`"扫，命中 0 个 | 那 8 个是"文件里没出现 empty 这个词"的启发式误报：外壳/首屏/单值徽标/被父级 `v-if` 挡住的轨迹组件本就不该有空态 |
| 换名字的自造组件：接回原语 | 21 → 14（`scripts/migrate-empty-states.mjs`，14 处改写） | 6 个空态的说明文字从各自 12.5px 跟到底座的 `--fs-base`（14.5px），聊天工具的新建按钮改挂 `.btn-primary` |
| 新增 `--overlay-strong`（媒体预览底） | 4 处（3 个视图 + 手机照片预览） | 浅色值就是原来的 `rgba(10,12,16,.82)`，深色改成真正的黑——**这一档以前不随主题变** |
| 列头补齐 `scope="col"` | 44 个 `<th>`（`scripts/add-th-scope.mjs`，src + mobile 一起），守卫 `headersWithoutScope` 钉成硬性 0 | 无可见变化，读屏下"这一格属于哪一列"从此有解 |
| 规范补齐键盘/表格/表单口径 | 新增 §12（快捷键、Enter 提交、表格、表单错误提示）+ §13 自检清单，原 §12 顺延 | 先量后写：37 处 `@keyup.enter` / 4 处 `@keydown.ctrl.enter` / 8 个 `<kbd>` / 24 个文件处理 `Escape` / 31 处 `required`，错误样式散在 60 个文件的 170 处 class 里；**`aria-invalid`、`aria-describedby` 全仓 0 次**——按"未做"写进规范，不冒充已完成。（这些是快照不是阈值，规范 §12 顶部已写明口径；`aria` 那条在后面的批次里已经接上了，见"字段错误的读屏关联"那行） |
| 补齐禁用态口径（两端） | 手机：`shell.css` 新增 `.m-op[disabled]` / `.m-chip[disabled]`（此前只有 `.m-btn`、`.m-item-main`、`.m-item button` 有）；桌面：`primitives.css` 加元素级底线 `button:disabled { opacity:.55 }`。守卫 `disabledWithoutAffordance` 硬性 0，两端分层判 | **本轮看得见的观感变化都在这里**：手机 8 处、桌面 6 处按钮禁用后从"与能点一模一样"变成变淡（桌面 .55 / 手机 .5，取值尚未统一）。桌面那 6 处是 `.mp-item`/`.effort-chip`/`.theme-btn`/`.mini-btn`/`.chip`——都是"换个名字再拼一遍"的自造名，族名口径盖不住，所以才要元素级底线 |
| 手机自检"单独跑一项"补进行中锁 | `runSingle` 原本没有任何锁（`runChecks` 有 `selfTestBusy`），连点会开两个原生选择器、两份结果互相覆盖；按 `src/tools/checkin/View.vue` 的 `busyKey` 形态补齐，并与"跑全部"互斥 | 只在自检真正跑起来的零点几秒里可见：按钮变淡、文案换"加载中"。`49-mobile-selftest` 5/5 仍绿 |
| 非点击输入（粘贴 / 拖放）写成规范 §12.4 | 4 个粘贴入口逐个读过（3 个窗口监听 + 1 个元素级 `@paste`），共同形状是"剪贴板里没有我要的东西就原样放行"；顺手补了 `SnippetView.onFormPaste` 缺的 `try/catch`（全仓唯一一处，失败从静默变成 toast，键 `snippet.saveImageFailed` 已存在） | 无观感变化，只有粘贴失败时多一条 toast |
| 抓出桌面拖放的"承诺落空"两处 | `src/tools/image/View.vue`（还画了整层"把图片拖到这里"浮层）与 `src/views/AiExtract.vue` 只挂 HTML5 `@drop`，而 Tauri 把系统文件拖放拦成原生事件——仓里正确通道 `watchFileDrop` 只有 `AgentComposer` 与加密工具在用 | **没有顺手改**（原生事件在本仓无自动化覆盖，改了也验不了），判据与修法写进规范 §12.4，列为待真机项 |
| 字段错误的读屏关联（规范 §12.3 最后一条"未做"现已做完） | 新增 `src/ui/fieldError.js` 的 `v-field-error`（与 `v-dialog` 同构：找**当前真的渲染出来的**错误句 → 补 id → 控件写 `aria-invalid` + `aria-describedby`；msg 空则撤回）。接了 9 处字段容器（桌面设置页 5 / 手机设置页 3 / 手机照片配置 1 个模板），覆盖 17 条 `.field-err` 里的 11 条；剩下 6 条是面板级汇总提示，不属于任何一个输入框 | 界面上没有新东西（红字与文案本来就在），差别在读屏里。顺带修了一个真的交互缺口：**手机设置页报错后改字段，红字要等下次保存才消失**——现在一改就收（刻意不在视图里重算校验，避免把 `settingsForm.js` 的规则抄第二份） |
| 工具箱从"目录行"改成卡片墙 | `ToolboxView.vue`：`.lt-group` 三列栅格（≤1180 两列、≤900 一列，都取 §11.2 的五档），`.lt-tool` 卡片化（34px 图标底座、描述两行截断、能力标签贴底、收藏星浮右上角）；语义推荐行仍保持清单形态 | **本轮最明显的一处观感变化**：1440 宽下一屏 9 件、描述能读全；代价是比目录行少看 4–5 件（旧形态的理由与这次取舍都写在样式注释里） |
| 守卫扩两条 + 手机禁用态取值统一 | `cssVars.test.js` 新增"深色两套触发的变量集合必须一致"（当前 79 项逐条比对）；`uiSpec.test.js` 新增断点/图标尺寸的**取值白名单**——只数种数挡不住 `780 → 785` 这类替换，现在把值本身钉住，用例 45 → 47；手机 `.m-btn / .m-chip / .m-op / .m-item` 的禁用透明度 .5 → .55，与桌面同口径 | 透明度那 .05 肉眼看不出来；白名单的意义是"别再填 13/15/17、别再补第 18 种断点"从散文变成红灯 |
| 需求大盘空态：从「暂无需求」变成"给下一步" | 四列空态改成 `.empty` 骨架（图标 + 「「小需求」还空着」+ 说明 + 动作）：有迭代时给「新建需求」，没有迭代时顶部一条 `.tc-note--info` 解释并给「去迭代页」（列里不再重复按钮）。顺带用上从没被采用的 `.tc-note` 原语 | 有迭代/没迭代两种形态都验过；点「新建需求」确实打开弹窗、点「去迭代页」确实切到迭代 Tab——不做"点了没反应"的假动作。`unusedPrimitives` 67 → 65 |
| 任务页：空态补就地入口 + 修一个 Esc 关不掉的弹窗 | 「当天没有工时记录」原来只写"点右上角「添加工时」"，空态自己不给入口；补了就地按钮，并让 `openAddTask(date)` 接受日期——选中 10 月 1 日就从 10 月 1 日开录，而不是永远落回今天（`typeof date === "string"` 兜住工具栏 `@click` 传来的 MouseEvent）。同时发现「添加工时」弹窗**关不掉 Esc**（`onEsc` 只接了周报），按规范 §3.3 补齐 | 空态多一个「添加工时」；Esc 现在能关掉录入弹窗。实测断言：选中 10-01 后弹窗日期字段 = `2026-10-01`，默认日 = 今天 |
| 规范补 §14「怎么扩展这套规范」 | 新增令牌（浅段 + 两套深色 + 刻度集合是硬写的、要显式扩）、新增组件族（只在 primitives.css；手机端另有 `disabled` 口径义务）、新增指标（`measure()` 加数值键 → 刷基线 → `git diff` 只许降 → **必须证明它会红**）、升硬之前的前置阅读、五条"不要做的事" | 无观感变化。补它的理由：规范只写"该怎么写"而不写"该怎么改"，下一个人就会手改基线数字或把阈值调大——那时前面所有守卫都变成装饰品。`CONTRIBUTING.md` 的 PR 一节同时指向 §13 与 §14 |
| 全局右键菜单补上语义与键盘，并给它第一条 e2e | `App.vue` 的 `.ctx-menu` 补 `role="menu"` / 每项 `role="menuitem"`；打开即把焦点送进第一项；`↑/↓` 在条目间循环；`Escape` 关闭并把焦点还给右击前的元素（点外面关闭时**不**抢焦点，所以两个 window 监听改绑命名函数 `dismissCtxMenu`）。新增 `e2e/specs/77-ctx-menu.spec.js` 3 条 | 键盘用户第一次能只用键盘走完一个右键菜单；界面无变化。**负向验证**：临时摘掉 `role="menu"` → 3 条同时红，装回来 3 条绿。（改这里时我自己引入过一次"add 用箭头函数、remove 用原函数"的监听不配对，当场用命名函数消掉了——记下来是因为这类错只在看 diff 时才看得见） |
| 抓出并修掉一条**没人能看见的原语 bug** | 胶囊配色表里误加过一行 `.tc-note { color: --wait-deep; background: --wait-soft }`，而 `.tc-note` 是第 14 节提示条的名字：`background` 被后面的定义盖掉，`color` 漏过来 → **所有 `.tc-note--info/done/fail` 的文字都是琥珀色**。删掉那行，并新增守卫（当时叫 `duplicatePrimitiveProps`，随后扩成 `duplicateCssProps` 覆盖三层）——同一个类把同一个属性写两遍即红 | 零观感变化——因为 `.tc-note` 至今零采用。**"没人用的原语"不等于"无害的原语"**：它的规格错着，等第一个采用者出现就直接呈现错的样子，而那时没人知道根在哪。负向验证：把那行放回去 → 守卫精确报 `tc-note.background`，取下来 → 45 条全绿 |
| `.tc-seg` 的档位纠错（另一个"没人用 = 写错了"的例子） | 原语把分段控件写成 `height: calc(--control-h-sm - 4px)`＝**20px** 配 `--fs-md`，比应用里任何控件都矮，所以四套自造实现一个都没迁过来。已按现存实现校准：项目 `min-height: --control-h` + `--fs-sm` + `--muted`，容器 `--well` + `--border-strong` + `--sp-0`，选中态的字面 `rgba` 阴影换成 `var(--shadow)`（深色下才会跟着变） | **零观感变化**——正因为零引用。刻意**没有**新加 `.tc-seg--equal`：`unusedPrimitives` 是棘轮，空放一个没人用的名字等于给自己制造债务，等真迁移一个实现时再一起加。四处分段控件的迁移目标与三处需肉眼确认的差异（gap 0→2px、file 的 96px 等宽、interview 的分隔线式选中态）写在规范 §10 第 2 条 |
| 手机端 CSS 里 12 条"死声明"清掉，守卫扩到三层 | `duplicatePrimitiveProps` → **`duplicateCssProps`**（`primitives.css` + `globals.css` + 手机 `shell.css` 一起扫，判据是"同一个类把同一个属性写了两遍"，不是"类出现两次"——`.panel-head`/`.tc-textarea` 那种"再补一条不冲突的属性"是合法写法）。手机层用 `scripts/dedupe-css-props.mjs` 机械清理：`.m-chips`、`.m-bar`、`.m-badge` 各有 12 条被后一份整体盖掉的声明 | **零观感变化**，等价性是算出来的：删前删后各跑一次"按源码顺序求每个类的最终生效映射"，**逐字段相同**才收下（行数 1670→1658、花括号 234/234 配平）。第一次写盘删错了行（坑 12），已回滚修好脚本再重做，并给它加了"行号自校验 + 删后行数必须等于计划数"两道闸 |
| 把规范自己的数字变成生成物 | 新增 `scripts/ui-scale-table.mjs` + `npm run gen:ui-scale`：§2.1 的刻度表从 `tokens.css` 生成，守卫逐条比对 | 无观感变化。动机是本轮第三次自我更正（见坑 10）：**文档抄代码是同一个"抄一份值"的老毛病，而抄错了没有任何东西会红** |
| 复核规范里的**行为描述与计数** | §11.1 壳层阶梯从"三个断点"改成实测四档（1180 缩右栏 → 1000 顶栏收窄 → 900 右栏脱离流变浮层 → 760 左栏轨道+浮出），`--dock-w-sm` 生效点从 ≤900 改成 ≤1180；新增 §11.4「同一个界面要同时活过两种窗口」；§11.2 目标断点集合成五档；**另把规范里所有"实测 N 处"逐条重跑**：`<kbd>` 7→8、Escape 19→24 文件、`required` 30→31、`askConfirm` 34→37、toast 文件 55→52、`.field` 18→19 文件、微间距迁移后仍剩 98 处裸 `2px/4px`（§2.2 原来把迁移前的 303 写得像现状）、`tc-*` 采用面从"5 个文件 10 处"更正为 **7 个文件 23 处（全在 `src/`，`mobile/` 一个都没有）**；§4 与 §6.1 的判据重跑仍然成立（`v-for≥3` 无 `.empty` 命中 0、三个浅色专用令牌各只定义一次、accentTheme 覆盖 21 个变量） | 无观感变化，但这一条**纠正的是我自己写错的规范**：右栏的真实行为是"先缩再浮"不是"一直压窄"；计数会因为并行会话在长代码而漂——**规范里带"实测"两个字的地方，都要能一条命令复现**，所以现在每条都附了口径 |
| 把 §2.3 那句"描边分 4 级"落到令牌与用量 | 实测描边是 6 个令牌：`--card-border` 175 / `--border` 219 / `--border-strong` 195 / `--border-steel` **9** / `--border-blue` 76 / `--border-danger` 30。规范改成一张带取值、深浅与用量的表，并写清"中性三档 + 一个待合并的近义名 + 两个语义档" | 无观感变化。顺带抓到一条真的设计债：`--border-steel`(`#c7cdd8`) 与 `--border-strong`(`#c8d1da`) **每通道差 ≤ 4，深色下取值完全相同**，名字只差一个词，却各自存在——后来的人无从选择。合并步骤与"删令牌会被 `cssVars` 的『定义必有人用`判死`"这个坑一起记进规范 §10 与任务清单 |

### 守卫：`src/styles/uiSpec.test.js`（48 条用例 = 23 条硬性断言 + 25 项指标棘轮）

| 动作 | 规模 | 观感影响 |
|---|---|---|
| 补上"刻度集合 ↔ tokens.css"的硬性用例 | 发现 `FONT_SCALE` 定义了却零消费：§14.1 说"扩刻度必须同步改三个集合"，但提速查发现往 `tokens.css` 加 `--sp-9: 28px` 不会红。新增用例双向比对间距/圆角/字号三套集合，注入 `--sp-9` 验证会红（精确点名 `28px`） | 无观感变化；关闭了"绕过显式决定"的缺口。用例 47 → 48 |
| 清掉 15 条纯机械 lint 噪音 | 4 处无意义转义（`[\[`、`\/`）、测试/e2e 里的死导入（`desktopOps`/`mockAI`/`downloadCloudObject`/`PDFDocument`/`beforeEach`/`jsonToXml`/`dirname`）、死变量（`totalKb`/`result`/`html`） | 无行为变化；warning 79 → 64，剩下的 30 条 `vue/no-mutating-props` 等属于既有设计取舍，没有盲改 |

分三类，**每条要求都要写明属于哪一类**（第三类是"只能实测或走查"，见规范 §0）：

- **硬性为 0**（25 项指标里当前取值为 0 的 16 项）：`z-index ≥ 10` 不走令牌、遮罩写死 rgba、桌面端自写遮罩底座、桌面端自写组件底座骨架、
  `.vue` 用到 primitives 里没有的 `tc-*`、组件底座出现在 `globals.css`、同名 `@keyframes` 出现两遍、
  舒适档误缩放微间距、App.vue 里裸的外壳尺寸（280/56/48/340/300）、抄写的令牌 hex 与 `tokens.css` 不一致、
  对话框缺 `role`/`v-dialog`、用了 `v-dialog` 却没 import 指令、用了 `v-field-error` 却没 import 指令、
  纯图标按钮没有可访问名、toast 不在 live region 里、
  `<th>` 缺 `scope`、界面缺 aria/role 语义、被 `:disabled` 用到的按钮没有禁用态口径（两端分层判）、
  **规范 §2.1 的刻度表与 `tokens.css` 不一致**（表是 `npm run gen:ui-scale` 生成的，漏跑就红）、
  同一个类把同一个属性写了两遍（`duplicateCssProps`，三层 CSS 一起扫）、
  **断点取值超出五档白名单**（只数种数挡不住 780→785 的替换，见规范 §11.2）、
  **图标尺寸超出六档白名单**（`KNOWN_OFF_TIER_ICON_SIZES`，见 §11.3）。
  后两条是本轮补的：把"别再填 13/15/17"和"别再加第 18 种断点"从散文变成红灯，
  白名单只记录存量——清掉存量必须同时删名单，否则用例会报"这项已经没人用了"。
- **其余 9 项是棘轮 ≤ 基线**（[uiDebtBaseline.json](../src/styles/uiDebtBaseline.json)，由守卫自己生成，数字不由人填）：
  裸色值 14 · 裸字号 26 · 刻度外间距 301 · 刻度外圆角 58 · 零引用原语类 67 ·
  换名字的自造组件 14 · 手机自写遮罩底座 1 · 视口断点种数 17 · 图标尺寸种数 20。

25 项指标全部做过**注入违规**的负向验证：临时塞一个 `__UiSpecProbe.vue`
（含 `z-index: 250`、`.probe-mask{position:fixed; inset:0; background:rgba(...)}`、
一个不存在的 `tc-ghost-but-not-real`、`.empty{padding:33px}`、`font-size:15px`、`border-radius:7px`、
`:size="27"`、`@media (max-width: 643px)`、一个没 import 指令的 `v-dialog`、一个没有语义的遮罩站点、
一个不带 `title`/`aria-label` 的图标按钮、一个不带 `scope` 的 `<th>`），
再往 `App.vue` 注一行 `.probe-shell{width:280px;height:48px}`——
一次性让多条硬性断言 + 6 条棘轮同时变红；撤销探针后 48 条全绿（25 项指标里 16 项是"当前必须为 0"的硬性项）。
探针里的 `@media (max-width: 643px)` 与 `:size="27"` 现在还会额外触发两条取值白名单用例。
最后一条（禁用态口径，`disabledWithoutAffordance`）**换了个注入方式——不是加违规，而是撤掉已有的口径**，
两端各验一次：
① 手机侧临时删 `shell.css` 的 `.m-chip[disabled]`，硬性用例与棘轮用例同时红，点名
`SettingsView.vue` / `SchemaToolView.vue` 而**不**点 `KbToolView.vue`（它自己 scoped 块里有口径）——
"按钮任一 class 有口径就算合规"这一步，就是靠这条不点名才证明有效的；
② 桌面侧临时删 `primitives.css` 的 `button:disabled` 底线，同一个指标报出 6 处并点名
`AgentComposer`/`App.vue`/`DbConnModal`/`TaskView` 那五个自造名——**证明底线真的在兜族名口径盖不住的那批**。
两次都还原后全绿。


### 本轮踩到的十二个新坑（值得单独记）

1. **"零引用原语"用样式块判定 = 永远判不出**。第一版 `unusedPrimitives` 只在 `.vue` 的
   `<style>` 里找类名，于是 76 个原语全被判成"没人用"；再修一次又发现 `primitives.css`
   自己也在扫描集合里，**它匹配自己**，于是 76 个全被判成"在用"。
   正解是分两份语料：判定 CSS 声明只看 `<style>`，判定类名有没有人用要看**整份文件**，
   并且把定义所在文件从语料里剔掉。一个指标同时踩到"漏判"和"自证"两种错，
   说明单靠数字对不上不行——得把名单打印出来人工扫一眼（守卫里就是这么做的）。
2. **合成元素比截图更适合验证"两个名字同一条声明"**。浏览器截图这条这次不可用
   （in-app Browser 没有可见视口），改用 `document.createElement` 造探针读 computed style：
   10 组 `历史名 ⇄ tc-名` 的计算样式**逐字段全等**，遮罩 z-index=200、
   `--overlay` 在 `data-theme="dark"` 下确实翻转成 `rgba(0,0,0,.62)`，
   `.icon-btn` 高度 30 → 舒适档 34。**"改一处两边都变"从注释变成了可测的等式。**
3. **同一类判据要同时拿正反样例校准，否则一次太窄、一次太宽**。
   遮罩判据第一版关键词表是 `mask|overlay|veil|backdrop|shade`，结果是**漏检**：
   三个 `.img-preview { background: rgba(10,12,16,.82) }` 大摇大摆活在守卫底下——
   "遮罩"在类名里有太多种写法，`preview` 没想到。
   补上 `preview|sheet|dim|lightbox` 之后反过来**误伤 24 条**：`.preview-panel` 是预览
   **面板**（底色当然该用 `--card`）、`.icon-preview-area` 是预览区、`.m-sheet` 是手机
   全屏表单（不透明、纵向滚动），它们都不是遮罩。
   最终判据是两个条件同时成立——**类名像遮罩 且 `position: fixed`**——
   并且只禁字面色值（rgba/hex/hsl），不禁 `var(--card)` 这类合法底色。
   教训：**判据必须同时有正例和反例才敢定，只核对数字对不上是不够的**。
   顺带得到一条新的硬性指标：桌面端自写遮罩底座 = 0；手机端因为构建里根本没有
   `primitives.css`，只能自己写，单列为棘轮 1，理由写在守卫注释里而不是留成沉默的例外。
4. **批量脚本按"类名子串"匹配会误伤同族子元素，而打印清单是唯一把它抓住的手段**。
   给对话框挂 `v-dialog` 的脚本用 `class="…m-modal…` 匹配遮罩，结果
   `.m-modal-card / .m-modal-ops / .m-modal-cancel / .m-modal-ok` **也全算遮罩站点**，
   40 多个位置被挂上指令——表现会是"取消按钮变成了一个 role=dialog 的对话框"。
   因为脚本按设计打印了每一处改动，运行完当场就能看出名单不对，逐行摘掉即可；
   如果它只打印"共改 N 处"，这 40 个错误挂载要等到 e2e 或真机才暴露。
   **结论：批量改写源码的脚本必须打印"改了哪一处、改成什么"，而不只是数量。**
   同一批里还有一次引号转义事故：在 JS 字符串里写 `\\"` 让整行语法不合法——
   含非 ASCII 或转义的文件一律用可见的字符串常量写，别在 shell 内联脚本里叠转义。
5. **全局注册 ≠ 组件自带：SSR 渲染测试会把这件事捅出来**。
   `v-dialog` 只在两个入口 `app.directive(...)` 里注册过，浏览器里完全正常，
   但 `createSSRApp(...).use(i18n)` 这类渲染测试没有注册它，
   于是 `RequestTool` 的三条渲染用例红在 `Failed to resolve directive: dialog` 上。
   修法是**用哪个组件就在哪个组件里 `import { vDialog }`**（`<script setup>` 就地解析），
   并把"用了 `v-dialog` 却没 import"钉成守卫（`dialogDirectiveNotImported`）——
   因为我漏掉那一个文件的原因很普通：脚本用 `includes("vDialog")` 判重，
   而文件里本来就有 `<ReqEnvDialog>` 这个组件名。**判重要用词边界，别用子串。**
   顺带一条：本仓单测刻意不引 jsdom（`vite.config.js` 写明"仅测纯函数逻辑"），
   所以指令这种碰 DOM 的东西由「DOM 替身单测 + 浏览器实测」两头覆盖，
   `src/ui/dialog.test.js` 测接线（含"标题已有 id 就不覆盖"、"触发元素已卸载就不还焦点"），
   `role`/`aria-labelledby`/焦点进出在真浏览器里各测过一条分支。
6. **"按行找元素"和"按第一个 `>` 收尾找标签"都会判错属性。**
   图标按钮可访问名这条守卫先按行判，报出 20 处违规——实际只有 2 处：SFC 里
   `<button>` 的属性常换行写，`:title` 落在第四行。改成按标签取整段属性后，
   又栽在 `:disabled="tabs.length >= 10"` 上——那个 `>` 把标签腰斩，
   把本来合规的按钮报成违规。**判据要按引号状态走字符**，不能拿"碰到 `>` 就停"当词法。
   两次都靠"先看报出来的名单"发现（守卫失败信息里点名文件与片段），
   所以硬性规则在钉下去之前，**必须先读一遍它报的每一条**，不然第一版就会把人训练成"这守卫又误报了"。
7. **"切出 `<template>` 段再判"会被嵌套模板骗过去。**
   测界面有没有 aria/role 时，我先按"从 `<template>` 到最后一个 `</template>`"取模板段——
   带 `<template #slot>` / `<template v-if>` 的文件直接被切歪：
   `IterationView` 实际有 `:aria-expanded`，却因模板段只取到全文 1/7 而被判成"缺语义"。
   判据改成**扫整份文件**：代价是 JS 里拼的 aria 字符串也算数（偏松），
   对棘轮来说偏松比偏误报好——但这条要写进注释，不然下一个人会以为是偷懒。
8. **改词条必须跟着跑 `gen:i18n-baseline`，而这条守卫的提示语第一次就值回票价**：
   加了 `toolbox.photo.retryTitle/removeTitle` 后只跑了 `gen:tools`，
   四条 `i18nFragments` 用例立刻红，且失败信息直接写着"改词条后跑 npm run gen:i18n-baseline"。
   好的守卫不只是拦住，还要在红的时候把下一步命令告诉你。
9. **"数某个属性出现几次"当缺陷清单，本轮第二次把我骗了**（第一次是 §4 的"8 个界面无空态"）。
   写规范 §12.3 时我先按"`:disabled` 出现 0 次"报出三个界面当缺口——逐个点开看，**三个都不是缺口**：
   两个界面的 async 点击是筛选/导航/剪贴板，第三个（`PoolStatus` 的发布按钮）函数体只有
   `publishPool.value = p`，即打开确认面板，真正的外部动作在面板里且自带状态机。
   反过来机械扫"调用 async 但没禁用"命中 **147 处**，全仓 `await` 落盘的本地写入都算了进去——
   这个数字既不能当缺口清单，也不能当"已经合规"的证据。
   真正的那一处是**手机自检的"单独跑一项"**：`runChecks` 有 `selfTestBusy` 早退锁，
   而 `runSingle` 一点锁都没有，连点会开两个 SAF 选择器、两份结果互相覆盖。
   判据最终收敛成一句话（写进规范 §12.3）：**问这个动作会不会打到外部系统，而不是问函数是不是 async**。
   教训：**度量只能用来找候选，不能用来得结论**；任何"缺口 N 处"的话，落笔前要把每一处的函数体读一遍。
10. **写"行为描述"时凭上一轮的印象，比写数字更容易错**（本轮第三次自我更正，和前两次不同种）。
    §11 我写的是"主干只有三个断点（900/760/820）"、"`--dock-w-sm` 在 ≤900px 生效"、"右栏让位 40px"——
    逐条回到 `App.vue` 的媒体查询去看，实际是**四档壳层阶梯**：
    `≤1180` 右栏 340→300、`≤1000` 顶栏收窄与 `<kbd>` 隐藏、`≤900` 右栏**脱离文档流变成浮层**、
    `≤760` 左栏强制轨道 + 浮出。也就是"先缩再浮"，不是"一直压窄"。
    顺带纠正了两处计数（`≤820` 是 13 处 / 12 个文件，不是"12 处"），并补了 §11.4
    "同一个界面要同时活过两种窗口"（主壳 vs `ToolWindow.vue` 的独立窗口：980×720 默认、720×520 最小，
    `compact` 走 `provide("toolWindowChrome")`，只有铁路工具在用）。
    教训与前两条不同：**数字错了守卫会红，行为描述错了没有任何东西会红**——
    所以规范里凡是"到某个宽度/某个尺寸会发生什么"的句子，必须把对应的选择器或常量名一起写出来，
    让它能被逐条对回代码。
11. **无障碍也能"补了比不补更坏"——`aria-invalid` 的语义是"用户填的内容无效"**。
    准备补 §12.3 那条"全仓 `aria-invalid` 0 次"时，我先按"有 err 字样 class 的地方"数出 **170 处 / 60 个文件**，
    又按"错误文案上面 4 行内有没有输入框"数出 **43 处**——**两个数字都不能用**：
    本仓的错误提示绝大多数是**操作结果态**（转换失败、跑挂了、算不动），不对应任何一个输入框。
    真正的字段级错误只有 3 个文件里的 17 处 `.field-err` / `.m-field-err`。
    照 43 处批量补，等于把服务端失败标成"你填错了"，读屏收到的是一句误导——比不补更坏。
    最终做法：`v-field-error` 只接这 3 个文件的 9 处字段容器（覆盖 11 条可见错误句），
    规范 §12.3 把这条边界写死（"不要把这套东西铺到所有带 err 字样的节点"）。
    同批还修了一个真交互缺口：手机设置页报错后**改字段红字不消失**，要等下次保存；
    改成一改就收，并且**刻意不在视图里重算校验**——那等于把 `settingsForm.js` 的规则抄第二份
    （正是约束文档 §四之五 反对的那件事）。
    验证分三层：DOM 替身 9 条（含"msg 空必须撤回关联""找不到错误句就不许指不存在的 id""只认紧邻兄弟"
    "卸载时摘掉关联"）、
    守卫 `fieldErrorDirectiveNotImported` 硬性 0、`37-mobile-settings` 在真浏览器里断言
    `aria-describedby` 指向那句可见文案、三个字段指向不同 id、改对之后属性摘掉。
12. **批量删行的脚本，自己就是最需要被验证的那段代码——我这次删错了行**。
    新增守卫 `duplicateCssProps` 后，手机 `shell.css` 里那 12 条"被后一份整体盖掉的死声明"要用
    `scripts/dedupe-css-props.mjs` 机械清掉。第一次 `--write` 之后 `git diff --stat` 显示 109 增 108 删，
    而我只打算删 12 行——顺着看下去才发现是**行号算术二次偏移**：收集时存的已经是 0-based 下标，
    写入时又减了 1，于是每一条都删成了"目标行的上一行"，把 `.m-badge {` 的选择器行都删没了，
    CSS 结构当场断裂（`.m-chips` 丢 `margin-bottom`、`.m-bar` 丢 `display`）。
    恢复过程给了三条经验：
    ① **别信"我记得改了什么"，信编译产物**——上一轮构建留下的 `dist/mobile/app/assets/*.css`
    就是改动前的真相，用它反推每个类的"最终生效映射"，比读 diff 可靠；
    ② **等价性要写成可执行的判据**：修完脚本后我先跑一遍"按源码顺序求 winner 映射"，
    写入后再跑一遍，**逐字段相同才算 dedupe 等价**（这一步现在是脚本外的验证，跑完 12 条删除、映射零变化、
    行数 1670→1658、花括号 234/234 配平）；
    ③ 脚本里加了两道自检：删之前确认那一行确实是目标属性（不对就退出），
    删之后确认"删掉的行数 == 计划数"且花括号配平，**不通过就不写盘**。
    含非 ASCII 或需要转义的逻辑一律写成脚本文件跑，不要在 shell 里内联 `node -e`——
    本轮两次因为转义把正则弄坏（同一个坑第 N 次）。

### 本轮刻意不"顺手改掉"的几处（每条都写明要的是真机眼睛还是决策）

- 舒适档下图标按钮长高 4px（106 个）。方向是对的，但只在舒适档可见，需要看真机。
- 底座骨架的重复实现本轮已归零（桌面端遮罩、族名沿用型底座都是硬性 0），剩下的债务是**换了名字的自造组件 14 处**
  和**刻度外取值**（间距 301 · 圆角 58 · 断点 17 种 · 图标尺寸 20 种）。迁移顺序写在规范 §10：
  自造组件 → 图标刻度 → 视口断点 → 手机版式。这几批都不是"改一处两边都变"的等值替换，必须看着界面做。
- 手机端**版式**仍自成一套（字号用 rem、卡片圆角/阴影口径与桌面不同）。
  令牌层已经统一，版式统一必须看真机，不能对着 CSS 改。
- 表单错误提示的**无障碍**：本轮从"只有规范、没有实现"变成"机制 + 已接 9 处字段容器"
  （`v-field-error`，见上面那一行与规范 §12.3）。**没有**批量铺到其余上百处错误样式上——
  那些是操作结果态，`aria-invalid` 用在它们身上是误导（坑 11）。
- **桌面形态的拖放**：原本有两处"承诺落空"——图片工具画了整层"把图片拖到这里"的浮层、
  `AiExtract` 有虚线拖放区，却都只挂 HTML5 `@drop`（Tauri 把系统文件拖放拦成原生事件，
  `dataTransfer.files` 是空的）。**本轮已改**：两者都接上 `watchFileDrop`，路径经
  `src/platform/droppedFiles.js` 读成 `File` 再进原有管线，`@drop` 只当浏览器分支。
  边界要说清：桌面原生事件在本仓**没有任何自动化覆盖**（e2e 的"桌面形态"是注入
  `__TAURI_INTERNALS__` 模拟的），所以这条只到"代码路径对齐"，真正拖一次仍要人眼。
- **需要人眼点头的观感变化又多了一类：14 处按钮禁用后现在会变淡**（手机 8 处、桌面 6 处，
  见上面"补齐禁用态口径"那行）。方向与桌面既有口径一致（桌面 `.btn-*:disabled` 早就是 .55），
  但**桌面那 6 处里有 5 处同时是"选中态"控件**（`AgentComposer` 的模型/力度选项 3 处、
  `TaskView` 的时间范围 chip 2 处）——它们在"生成中"被禁用的同时还带着 `.on`/`.active` 高亮，
  变淡之后高亮会不会显得脏，必须看界面才知道。
  这次仍然没有可用截图通道，所以只能标成待确认，不能说"验过了"。

- 手机端禁用态取值本轮已统一到桌面同款 **0.55**（`.m-btn / .m-chip / .m-op / .m-item` 四处）；
  `mobile/app/main.js` 要不要引 `primitives.css` 仍未定——引了才能复用原语，
  但会一次性改变手机端所有借用同名类的观感，需要真机 + 一次决策。
- **两条本轮新建、需要人眼的迁移**（都不是等值替换，所以没有"顺手做掉"）：
  ① 四套自造分段控件迁到 `.tc-seg`（三处真实差异见规范 §10 第 2 条：gap 0→2px、file 的 96px 等宽、
  interview 的分隔线式选中态）；
  ② ~~`--border-steel` 并进 `--border-strong`~~ —— **已完成**（9 处改指、令牌从浅色段与两套深色分支删除；
  深色下取值本来就相同，浅色每通道差 ≤4，属"看不见的等值替换"）。
  剩下那一项的定位命令是 `grep -rn "class=\"seg\|class=\"segmented" src mobile`。

### ⚠️ 别在 E2E 跑着的时候改源码，也别让两套 E2E 同时跑

本轮踩了两次，第二次是我自己制造的：

1. **改源码**：全量 E2E（约 10 分钟）挂后台跑的同时继续改 `ConfirmDialog.vue` 与照片工具的模板。
   Vite 会把改动 HMR 进正在跑的浏览器实例，于是出现"`29-sidebar:42` 挂了"这种
   单独重跑又 9/9 全绿的假象。
2. **两个套件抢同一个服务**：先前有一个**没被托管、输出也没重定向**的后台任务还在跑，
   我又起了第二个全量 E2E。`playwright.config.js` 的 `webServer` 自己会执行
   `build:label-wasm && build:web && build:mobile` 再起 `e2e/server.mjs`，
   于是两边的构建产物互相覆盖、端口互相抢占，最后一次跑出 **"321 passed，另有 9 条失败，
   剩下约 90 条根本没跑"** 这种四不像结果——它既不是全绿也不是可信的失败清单。

判据：**一次 e2e 结果只有在"期间没有源码写入、且只有一个套件在跑"的前提下才算证据。**
操作上就是：起一个托管任务、等它的完成通知、期间不碰源码，也不要再起第二个。
（附带教训：后台命令一定要用可托管方式起并落盘输出；`(...)&` 直接甩到后台等于失去它的输出与控制权。）

### 第 12 轮验证基线

```
单测    210 文件 / 3112 用例 全绿（含 uiSpec.test.js 45 条 + dialog.test.js 5 条 + fieldError.test.js 9 条）
lint    全仓 1 error / 77 warning：唯一的 error 在 server/photo-relay.mjs:74（提示词工具预存，非本轮引入）；
        本轮改过与新增的文件（uiSpec.test.js / SettingsView.vue / shell.css / ui-scale-table.mjs）没有产生任何 warning
构建    桌面 vite build / 浏览器 build:web / 手机 build:mobile 三者**退出码逐个打印验过，全为 0**
        （上一版这里记的是"全绿"但取自一段没落盘的输出，这次改成 `echo "$s exit=$?"` 逐条回显——
         因为我无法从旧记录里确认那三个"1"到底是退出码还是行数）
真渲染  computed style 探针：10 组类名等价 + 遮罩/层叠/密度全部符合规范预期
E2E     最后一次全量（手机端 CSS 去重之后，作为本轮收口证据）424 条：422 绿 / 2 红（10.5m），
        两条红正是本轮之前就存在、判据齐全、且都与界面无关的 `68-photo-archive:152` 与
        `20-performance:64`；这一轮没有出现新的 flake。
        再往前"右键菜单那一批"的全量是 421 绿 / 3 红，多出来的三条 `11-agent-write-preview:64`、
        `27-agent-resume-rail:14`、`67-prompt-tool:189` 判为满载 flake——后两条当时已各自单跑复测
        （1 passed / 15 passed），三条在最后一次全量里全部转绿，因此不必再单独复跑定性。
        去重本身是"生效映射逐字段不变"的等价改动（删掉 12 条被后写覆盖的声明，1670→1658 行、
        花括号 234/234），单元 210 文件 / 3112 用例与三端构建（逐条 exit=0）都已复绿。
        本轮新增/加强的用例：`49-mobile-selftest` 5 条（补进行中锁后仍绿）、
        `37-mobile-settings` 13 条（含 4 条字段错误 `aria-invalid`/`aria-describedby` 断言）、
        `77-ctx-menu` 3 条（新文件，摘掉 `role="menu"` 会全红）。
        另有 2 处**陈旧断言**本轮已修好：22-locale（盯改词后的旧文案）与 29-sidebar（选中态断言打错元素）。
```

### 全量 E2E 抓出来的两条**陈旧断言**（本轮已修，判据写进用例）

| 用例 | 它以为在测什么 | 实情 |
|---|---|---|
| `22-locale.spec.js` | 首屏中文正文「说一件事，剩下的交给我」 | 这句在「工作台以对话为中心重构」后已改词，现在**只在注释里留着**。用例长期红着没人跟——`i18nCoverage` 只查键存在性，看不见这种漂移。已改成共享常量 `ZH_SLOGAN` 盯 `agent.emptySlogan`，两条用例共用一个来源 |
| `29-sidebar-fixed-zones.spec.js` | 选中的会话行有 `on` 类 | `on` 挂在**外层 `.task-row`**（样式就是 `.task-row.on .task-item`），断言打在内层元素上，查的是一个从来不存在的类名——所以它既没红过也没测到过任何东西。已改为断言 `.task-row.on` 命中该行，9/9 通过 |

判据（为什么这两条与本轮样式改动无关）：本轮对 `AgentSidePanel.vue` / `PhotoToolView.vue`
的 diff **只有 CSS 声明行的等值令牌替换与 z-index 令牌化**（`gap: 10px` → `var(--sp-3)` 这类），
模板与脚本一行没动；而这两条失败分别是文案字面量过期与选择器层级错位。

还有一条**刻意没修**的预存失败：`68-photo-archive.spec.js:152`（切到七牛后
`[data-role="config-test"]` 应当 disabled，实测 enabled）。这是字段校验逻辑与
`9e82fac`「七牛区域解析」之后的字段集不一致，属产品逻辑，不在 UI 规范范围内——
留待该工具作者确认到底是断言旧了还是按钮该禁没禁。

### 全量 E2E 还暴露了一个真的性能回退（与本轮无关，但值得单独说）

`20-performance:64` 的红不是抖动，是**数字真的变了**：防回退锁的阈值是 700KB，实测 940KB；
入口 chunk 从用例注释里记录的 528KB 涨到 **729KB**，首屏期间另外动态加载 ≈211KB。
判据说明它不是本轮引入：`bootScriptKb` 只统计 **script** 资源，
而本轮改动全是 CSS/模板类名——改样式不会改变 JS 体积。
阈值**没有**顺手调大（规范 §10 的第一条"不要做的事"就是为了这一刻）：
要动它得先看清是哪几个工具把重依赖搬回静态引用面的，连同用例里的演进记录一起改。
这是留给下一个人的真问题，不是本轮的收尾项。

### 顺手补的一条守卫：抄写的令牌值必须与 tokens.css 逐条相等

`DomainView.vue` 里有一张 `TOKEN_HEX`（JS 的 `hueShiftOf` 解析不了 `var()`，只能拿基准 hex 算色相）。
它靠注释提醒"改令牌值时同步更新这里"，实测 `--amber` 已经漂了一个色相
（抄的是 `#d97706`，令牌早就是 `#9a6700`），表现是琥珀色领域的徽章底色 hue 与它的色点不一致——
不报错、不红灯，只是看着不对。**"抄一份值"能继续留着的前提是有人逐条比对**，
所以比对交给了守卫（与 `toolboxIcons.test.js` 处理手机端图标的办法同构）。

