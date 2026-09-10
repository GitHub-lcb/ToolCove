# ToolCove 对比 ZGWork master 的可迁移优化

对比基线：`E:\develop-lcb\workspace-tools\ZGWork` 的 `master`（commit `2ea0a18`）。ZGWork 当前工作树还有未提交的试金改动，本评估只参考 master 已提交代码。

## 建议优先迁移

| 优先级 | 能力 | ZGWork 参考 | 对 ToolCove 的价值 | 成本 |
|---|---|---|---|---|
| P0 | `transport` 传输网关 | `src/transport.js` | 把 Tauri `invoke` 集中隔离，为未来浏览器版和 Agent 沙箱提供统一边界 | 中 |
| P0 | 启动与窗口恢复兜底 | `src/main.js`、`src-tauri/src/lib.rs` 的 `sanitize_main_window` | 解决黑屏、白条窗口、异常尺寸恢复；ToolCove 最近已经出现启动黑屏问题 | 低 |
| P0 | 原子存储、版本化保存、自动备份 | `src/transport.js`、`src-tauri/src/storage.rs` | Agent 执行会产生更多中间状态，需要冲突检测、恢复和每日备份 | 中 |
| P1 | 统一确认弹窗与 Toast 撤销 | `src/confirm.js`、`src/ConfirmDialog.vue`、`App.vue` | Agent 的高风险工具调用可复用统一交互，不应使用 `window.confirm` | 低 |
| P1 | Web 构建与浏览器登录 | `src/transport.js`、`server/`、`src/WebLogin.vue` | 让 Agent 能部署成团队内网服务，桌面端继续保持本地优先 | 高 |
| P1 | 运行记录与可恢复任务 | `src/tryGoldRun.js`、`src/tryGoldStorage.js`、`src/tryGoldTask.js` | 可直接借鉴步骤状态、错误、重试、断点续跑模型，补齐当前 Agent 的持久化短板 | 中 |
| P1 | 敏感数据扫描与脱敏 | `src/transport.js` 的 `sanitizeTryGoldWorkspace` | 防止 Agent 将 API Key、Cookie、Token、密码写进任务记录或同步数据 | 中 |
| P2 | 数据库空闲重连与只读查询 | `src-tauri/src/db.rs`、`src/db.js` | 适合 Agent 数据库工具，降低连接失效和误写风险 | 中 |
| P2 | 发布分支最近提交、需求风险清单 | `src/latestCommitQuery.js`、`src/requirementMetrics.js` | 可作为 Agent 的研发上下文工具 | 低 |

## 不建议直接搬运

- `server/` 的完整账号、团队、邮件和 SQLite 业务：会改变 ToolCove 的无账号、纯本地定位，应拆成可选插件。
- `trygold` 领域模型：它面向 PAAS 自动化工作流，适合抽取“运行状态机”和“凭据引用”思想，不宜整体复制。
- ZGWork 的大块视图和业务模块：ToolCove 的工具箱信息架构不同，直接复制会增加包体和维护成本。

## 推荐实施顺序

1. 先迁移窗口恢复兜底、统一确认弹窗、原子备份。
2. 将 Agent Runtime 的执行事件接入 `Run Store`，采用 `pending/running/waiting/success/failed/cancelled` 状态。
3. 把 `sanitizeTryGoldWorkspace` 收敛成通用 `sanitizeSensitiveData`，用于 Agent 记录、导出和同步。
4. 把所有外部调用收拢到 transport，再接入文件、DB、HTTP Agent 工具。
5. 最后评估浏览器版；需要团队协作时才迁移 server/auth/team 能力。

## 结论

最值得直接赋值的是 ZGWork 的工程基础设施：传输网关、窗口恢复、原子存储/备份、统一确认交互、运行状态机和敏感数据防护。这些能力与 ToolCove 的本地 Agent 方向高度兼容，预计可显著提升稳定性和可维护性；业务视图和完整服务端应保持隔离，按插件或后续产品线引入。
