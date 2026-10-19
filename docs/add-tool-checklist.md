# 新增工具 / 并发协作检查清单

适用：在 ToolCove 新增一个工具箱工具（`src/tools/<key>/`，含 Agent 动作），尤其是多个分支 / 多个会话**并行开发**时。

注册真相源：`scripts/gen-tool-registry.mjs` 扫描 `src/tools/*/contract.js`；三张注册表、工具 i18n 片段、迁移基线都由脚本生成，**不要手改**。

## 0. 开工前先分配（并行开发必做）

- [ ] **工具 key = 目录名**：唯一、kebab-case（如 `json-path`）。
- [ ] **`order`（唯一）**：先看已占用值，再给每个并行分支分配不重叠的号段。
      `grep -h "order:" src/tools/*/contract.js`
      例：分支 A 领 280 / 290，分支 B 领 300 / 310。撞号时生成器直接报错。
- [ ] **`ui.icon`**：优先复用 `src/ui/Icon.vue` 现有图标；确实要新图标时，那是一个**共享文件**改动，必须提前打招呼。
- [ ] **`ui.category`**：优先复用 `src/contracts/groups.js` 现有分类；新分类要同时改共享分组与 i18n。
- [ ] **动作与风险**：read / transform / write / database；是否需要 `demo` 演示脚本、是否桌面独占（`desktopOnly`）。

## 1. 只碰自己的包

```
src/tools/<key>/
  contract.js          # UI 元数据 + Agent 动作声明（单一真相源）
  View.vue             # 工具界面
  logic.js             # 可选：视图 / 执行器共用的纯逻辑
  executor.js          # 可选：动作实现（重依赖按需 import）
  i18n.zh-CN.json      # 片段必须中英成对
  i18n.en-US.json
  *.test.js            # 包内单测
```

不要修改（生成物 / 共享快照）：

- `src/contracts/index.generated.js`
- `src/toolComponents.generated.js`
- `src/toolExecutors.generated.js`
- `src/i18n/tools.generated.js`
- `src/i18n/preMigrationKeys.json`

以上文件由命令生成；手改会被 `registryGating` / `i18nFragments` 守卫打成红灯。

## 2. 生成与自测（每个分支都要做）

```bash
npm run gen:tools           # 注册表 + 工具 i18n 片段
npm run gen:i18n-baseline   # 新增 / 删除了词条时（合并分支后也要统一跑一次）
npm test                    # registryGating / i18nFragments / contracts 等守卫
```

工具包有 e2e 的，再跑对应 `e2e/specs/*.spec.js`。

## 3. 并行协作规则

- **一个工具一个 worktree / 分支**；不要在同一工作树里让两个会话同时跑 `gen:tools`（写同一批文件，容易互相覆盖或让测试看到半成品）。
- 生成物与 `preMigrationKeys.json` 在合并时冲突是**常态**：不要手改，取任意一侧后重跑生成命令即可得到并集。
- 同一工具 key / 目录的并行开发天然冲突，必须串行；不同工具才能并行。
- `order`、新图标、新分类是仅有的三个「多个工具共享的手写点」，提前分配好。

## 4. 合并后验收

```bash
npm run gen:tools           # 生成物冲突的最终解法
npm run gen:i18n-baseline   # i18n 键集合取并集
npm test                    # 全绿
```

- [ ] `gen:tools` 无报错（key / order 唯一）
- [ ] `npm test` 全绿
- [ ] 相关 e2e 通过
- [ ] `git status` 里只有本工具的包 + 重新生成的注册表 / 基线，没有夹带其他分支的文件

## 附：运行时并不并发

Agent 仍是「一步一个动作、串行执行」；本清单解决的是**开发期**多人并发新增工具。若要一步并行调用多个工具，那是 runtime 协议（planner 动作格式 + 执行器）的改动，与新增工具无关。
