# ToolCove 商业化第一批 · 设计文档

- 日期：2026-08-26
- 状态：已获用户批准（2026-08-26）
- 范围：① Pro 功能开关 + 离线 license 校验框架；② 可选遥测（opt-in，仅计数）；③ PRO/定价页（占位）；④ LICENSE 商业条款 + EULA 草案

## 1. 背景与目标

ToolCove（工具湾）v0.2.1 为本地优先的 Windows 开发效率工作台（Tauri 2 + Vue 3 + vitest + vue-i18n，无路由/状态库，数据存本地 JSON）。当前纯免费、专有许可、GitHub Releases 分发、无账号无遥测。

商业化路线（已确认）：闭源 Freemium。免费核心获客，付费墙压在「AI 网关 / 同步 / 团队 / 高级导出」等新能力上，不锁定现有高频工作流。

本批交付 4 项基础设施，验证付费意愿与付费墙可行性，不接入真实支付。

## 2. 已确认的决策（用户批准）

| 决策点 | 结论 |
|---|---|
| Pro 首批锁定范围 | 框架 + 锁定 1-2 个真实功能 |
| 遥测同意方式 | 默认关闭 + 首次启动询问一次 |
| License 机制 | 离线 Ed25519 签名 key + 可选在线激活（预留） |
| 定价页形态 | 占位页：定价展示 + 即将推出 + 爱发电入口 |

## 3. 总体原则（不变量）

- 无账号可激活；数据不上云；遥测默认关闭。
- 付费墙只加新能力，不砍现有免费功能、不动九视图导航结构。
- 纯 JS 逻辑抽为可单测模块（vitest）；Rust 侧只做验签与网络。
- 延迟加载（exceljs 已有惰性加载模式），不拖慢启动。
- 不新增 npm 依赖；Rust 仅新增 `ed25519-dalek`。

## 4. 许可子系统

### 4.1 密钥与 key 格式

- 算法：Ed25519（`ed25519-dalek`，Rust 侧验签；node:crypto 生成公钥对/签发）。
- 公钥以 const 内嵌 Rust 二进制；私钥只在开发者机器（`scripts/license-keygen.js` 生成，`.gitignore` 排除）。
- License key 文本格式：

```
TCV1-<base64url(payload_json)>.<base64url(signature_64bytes)>
```

- payload_json（无换行、键序固定）：

```json
{"plan":"pro","name":"...","email":"...","issued":"2026-08-26","expires":"","features":["db-export-xlsx","theme-custom"]}
```

- 验签内容 = 完整 payload 原文（签名对象为 payload 字节），防 JSON 重排攻击。
- `expires` 空串 = 永久有效；非空为 `yyyy-mm-dd`（UTC 零时比较），过期拒绝。
- 依赖 pin：`ed25519-dalek = 2`（验签无需 rand 特性）。私钥路径：`scripts/.license-secrets/license.key`（gitignore 排除，注释明确红线）。

### 4.2 Rust 侧（src-tauri/src/license.rs）

| 命令 | 说明 |
|---|---|
| `license_status` | 读 `license.json`，验签/过期检查，返回 `{pro, plan, name, email, expiresAt, features, error?}` |
| `license_activate(key)` | 验签通过则写 `license.json` 并返回状态；失败返回统一错误码（malformed / bad-signature / expired / unsupported-plan），见表下说明 |
| `license_deactivate` | 删除 license.json，回到免费版 |

> 错误码定义（**审查修订 V3 统一**）：`malformed`（TCV1 前缀/分段/base64/JSON 结构错误）、`bad-signature`（验签失败，payload 或签名被篡改）、`expired`（expires 已过）、`unsupported-plan`（plan 非 pro）。前端 i18n 四个键一一对应。

- 写入统一走 `data_io_lock()` + `ensure_data_writable()` 后 `write_json_file`（与备份/恢复无竞态）；读侧特判：文件不存在或内容为空数组（read_json_file 的缺省返回）一律映射为「未激活」免费态。
- 单测：用测试密钥对验签、篡改 payload/签名各错误路径、过期校验（用固定 32 字节 seed 的 `SigningKey::from_bytes`，不依赖随机源）。
- 数据文件独立为 `license.json`（复用 storage.rs 的 `data_path`，key=license）。
- **备份/恢复隔离（审查修订 V3）**：storage.rs 无「备份清单」，是三段目录扫描逻辑，需在**三处**显式排除 license.json（由本批新增的 `is_license_json` 判定收口，定义于 license.rs 导出、storage.rs 三处过滤点引用，避免硬编码字符串）：① `run_backup` 的 `fs::read_dir` 扫描循环跳过 license.json（新备份不含授权）；② `read_restore_archive` 过滤 license.json 条目（**过滤跳过而非拒错**，否则含授权的旧备份整体恢复失败）；③ `managed_json_files` / `run_restore` 的 current 清单排除 license.json（否则当前授权文件会被移入 rollback 后删除，任何恢复都会丢授权）。集成测试断言三方向：新备份不含 license.json / 恢复含 license.json 的旧备份不复活授权 / 恢复任意备份后当前 license.json 原样保留。

### 4.3 前端

- `src/license.js`（纯 JS）：key 文本解析/归一、状态归一化（normalizeLicenseStatus）、无 Tauri 环境（浏览器预览）降级为"免费版"假状态。
- `src/features.js`（纯 JS）：`PRO_FEATURES` 清单 + `isFeatureEnabled(status, feature)` + 锁定 UI 文案键约定。
- App.vue 挂载时拉取 `license_status` 并 provide(`licenseStatus`)；工具子窗口各自在挂载时拉取。
- **跨窗口传播（审查修订）**：主窗口与工具子窗口是不同 JS realm，改用 Tauri 全局事件——Rust 侧在 activate/deactivate 成功后 app.emit（事件名 license-changed，lib.rs 已有 Emitter 先例 tray-action）；前端 @tauri-apps/api/event 的 listen 在 App.vue 与 ToolWindow.vue 各订阅一次（两个入口覆盖主窗口与全部工具窗口），收到后重新拉取 license_status 并刷新 provide/锁定态；工具子窗口另在窗口 focus 时重拉一次（兜底）。
- 激活输入在设置页 pro 分区；成功后由 license-changed 事件刷新各处锁定态。

### 4.4 首批锁定的真实功能

1. `db-export-xlsx`：DbTool 结果集新增「Excel(.xlsx) 导出」按钮（新能力；CSV/JSON 保持免费）。复用 `shared.js` 中 exceljs 惰性导入模式，新写 `buildDbResultXlsx` 帮助函数。
2. `theme-custom`：设置页新增「自定义主题色」选择器（新能力，仅 Pro 显示可用）。写入 localStorage `tc.accent`，**覆盖变量清单（审查修订，含组件实际使用的 primary 系与导航选中态）**：`--accent*`、`--primary`/`--primary-hover`/`--primary-soft`、`--grad-brand`、`--grad-selected`、`--border-blue`；提供 `resetAccent`。深浅两套主题共用同一强调色系（内联 style 覆盖同时作用于两套媒体查询定义），预览取色板保证两种背景下的可读性；accentTheme.js 按当前主题（themeMode/system→matchMedia）选深浅色值补丁。工具子窗口挂载时同样应用 accent（revealToolWindow 路径补 applyAccent）。

- 锁定表现：按钮/控件显示 🔒 角标 + tooltip「Pro 功能」，点击提示去设置激活（现有 showToast 机制）；**工具子窗口内提示补充导航指引（审查修订）**：「Pro 功能，请到主窗口 设置 → Pro 激活」。

### 4.5 在线激活

- 仅预留：Rust 命令签名占位（`license_activate_online(email)` 返回"coming-soon"错误码）；设置页「在线激活」按钮 disabled + 「即将推出」。

## 5. 可选遥测

### 5.1 配置与同意

- settings.json 新增 `telemetry: { enabled: false, prompted: false, installId: "<uuid>" }`（settingsConfig.js 归一，旧数据自动补默认值）。
- 首次启动询问一次：主窗口 onMounted、非 toolMode、`window.__TAURI_INTERNALS__` 存在，且 **`shouldPrompt(settings)`（telemetry.js 纯函数：`!telemetry?.prompted`，undefined 视为未询问，审查修订 V3）** 返回 true 时，弹 askConfirm 确认框：文案声明「仅匿名统计功能使用次数，不上传任何内容数据」。
- 同意/拒绝路径**立即 `save_data` 合并写回** settings.json（enabled+prompted，与设置表单保存路径分离，避免用户不点保存导致下次再问）；写回失败不阻断启动（try/catch 静默）。设置页可随时开关。

### 5.2 采集面（仅聚合计数）

- 埋点键：`view.<moduleKey>`（视图激活）、`tool.<toolKey>`（工具箱工具打开/窗口创建）、`ai.session`（AI 会话创建）。
- 附带元数据：installId、appVersion、平台（navigator/bowser）、locale、时间戳、时区偏移。无内容、无文件路径、无 IP。

### 5.3 聚合与发送

- `src/telemetry.js`（纯 JS）：Map 计数聚合、`track()`／`flush()` 接口、上限保护（单键 10^6 次封顶防止异常爆炸）、持久化到 localStorage（跨会话保留未发送计数；`telemetry.pending` 键）。
- **开关读取通道（审查修订）**：`isEnabled()` 读 settings.json 的 telemetry.enabled 并缓存；监听 `settings-saved` 事件失效缓存（App.vue 已有监听先例）；工具子窗口挂载时各自读盘一次（窗口间事件不互通、共享 localStorage 计数）。
- Rust 命令 `telemetry_submit(events)`：复用已有 reqwest（rustls），POST 到 `TELEMETRY_ENDPOINT` 常量。**默认常量留空 = 只聚合本地、不实际发送**；后续上线服务器填地址。
- 失败静默：网络错误不打扰用户；单日最多重试 5 次，指数退避（前端控制）。
- **flush 触发时机（审查修订）**：① 主窗口启用期间每 10 分钟定时 flush（仅 enabled 时启动定时器）；② 设置页保存时 flush；③ beforeunload 尽力而为 flush（fire-and-forget，不 await）。主窗口是唯一持有 settings 写入权的窗口，工具子窗口只读不 flush。

## 6. PRO 页面 / 定价页

### 6.1 设置页新增分区

- SettingsView SECTIONS 增加 `{ key: "pro", labelKey: "settings.navPro", icon: "star", descKey: "settings.navProDesc" }`（置于 ai 之后）。
- 内容块（自绘，沿用现有卡片/按钮样式）：
  1. **状态卡**：免费版 / Pro 已激活（授权名、到期时间、features 徽章）。
  2. **激活框**：key 文本输入 → 激活按钮 → 错误提示（错误码一一映射 i18n：malformed/bad-signature/expired/unsupported-plan）；**状态机（审查修订）**：未激活→输入+激活按钮；已激活→显示「当前已激活」信息行并隐藏输入（或提供「重新激活」折叠）；「在线激活（即将推出）」disabled 按钮；「停用 Pro」按钮需 askConfirm 确认后 license_deactivate，成功后刷新状态卡并广播 license-changed。
  3. **定价卡**：Pro 买断 ¥99 / $39（2 年更新）；团队版占位；均标注「即将推出」。
  4. **对比表**：免费 vs Pro 功能行（现有 12 个工具 × 5 个分组摘要 + Pro 专属行，措辞与 toolboxTools.js 的 TOOLBOX_GROUPS 一致）。
  5. **爱发电入口**：`openUrl("https://afdian.com/a/toolcove")`（占位链接，README 同步标注）。
- 侧边栏底部：免费版显示「升级 Pro」小按钮 → `openSettings("pro")`。

### 6.2 i18n

- zh-CN.json / en-US.json 同步新增 `settings.pro.*`、`pro.*`、`license.*`、`telemetry.*` 键；现有 i18n.test.js 键对齐测试自动护航（必须两边同步）。

## 7. LICENSE 与 EULA

### 7.1 LICENSE 更新

保留专有声明，新增「商业授权条款」小节：
- 免费版定义：官方渠道下载安装、个人/内部使用。
- Pro 授权：按 license key 授权的付费功能使用权；不得转售/分享 key。
- 退款：购买后 14 天内（买断）可申请退款。
- 免责与责任限制：现状提供、间接损失免责（沿用现有）。
- 保留条款效力：与 EULA 冲突时以 EULA 为准。

### 7.2 docs/commercial/EULA.md（草案）

- 中文正文 + 英文摘要；含定义、授权范围、订阅/续费规则、退款、禁止行为、免责、终止、适用法律（中国法）、联系方式占位。

## 8. 测试策略

| 层 | 用例 |
|---|---|
| vitest | license.js：key 解析（合法/畸形/分隔符错误/base64 错误）、状态归一；features.js：开关矩阵；telemetry.js：计数聚合、上限、持久化、shouldPrompt 纯函数（不重复询问）、consent 落盘；accentTheme.js：预设结构/apply/reset/深浅补丁 |
| Rust | license.rs 单测：验签、篡改 payload、篡改签名、过期、格式错误、命令返回结构；telemetry.rs 单测：空 endpoint 直接 Ok、事件结构；storage.rs 备份/恢复排除集成测试（三方向断言） |
| 集成 | i18n 键对齐（已有）；migrate 兼容（settings.json 无新字段 → 默认值）；构建冒烟（npm run build + cargo check） |

## 9. 交付清单（文件级）

- 新增：`src-tauri/src/license.rs`、`src-tauri/src/telemetry.rs`、`src/license.js`、`src/features.js`、`src/telemetry.js`、`src/accentTheme.js`、`src/telemetry.test.js`（及 license/features/accentTheme 测试）、`scripts/license-keygen.js`、`docs/commercial/EULA.md`、`docs/superpowers/plans/2026-08-26-commercialization-batch1.md`
- 修改：`src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src/SettingsView.vue`、`src/App.vue`、`src/ToolWindow.vue`（license-changed 订阅）、`src/tools/DbTool.vue`、`src/shared.js`、`src/settingsConfig.js`、`src/i18n/zh-CN.json`、`src/i18n/en-US.json`、`LICENSE`、`README.md`、`.gitignore`、`src/settingsConfig.test.js`
- 版本号不动（v0.2.1 → 发布时再定）。

## 9.5 审查修订记录（V2，2026-08-26）

审查子代理共提出 2 个 P1 + 9 个 P2（复审另补充 1 个 P1 + 3 个 P2，见 V3 修订记录），无事实性硬错误；全部修订已并入上文对应章节：
- P1-1：定义 flush 触发时机（10 分钟定时 + 设置保存 + beforeunload 尽力）。
- P1-2：license-changed 改走 Tauri 全局事件（Rust emit + App.vue/ToolWindow.vue listen + 工具窗口 focus 兜底重拉）。
- P2-1：主题覆盖变量清单扩展至 primary 系/导航选中态；两主题共用强调色 + 按主题选深浅补丁。
- P2-2：license.json 排除出备份/恢复，补集成测试。
- P2-3：写入走 data_io_lock + ensure_data_writable；缺文件/空数组 = 免费态。
- P2-4：询问条件 !prompted；同意/拒绝即时 save_data 落盘。
- P2-5：isEnabled 缓存 + settings-saved 失效；工具窗口读盘。
- P2-6：expires 空串 = 永久；私钥路径 scripts/.license-secrets/license.key。
- P2-7：对比表措辞 12 个工具 × 5 分组；锁定提示含主窗口导航指引。
- P2-8：ed25519-dalek pin 2；测试用固定 seed。
- P2-9：激活状态机（已激活信息行、停用需确认）。

### V3 修订（2026-08-26，复审）
- P1：备份/恢复隔离修正为三处排除点（run_backup 扫描 / read_restore_archive 过滤 / managed_json_files 排除），集成测试断言三方向。
- P2-1：错误码统一为 malformed / bad-signature / expired / unsupported-plan，前端键一一对应。
- P2-2：§9.5 计数修正为 2 P1 + 9 P2。
- P2-3：§8 测试表补 accentTheme 与 telemetry.rs；prompted 判定抽为 telemetry.js 纯函数 shouldPrompt（可单测）。

## 10. 风险与边界（明示）

- 离线 key 可被传播：接受，属买断制通病；后续在线激活/设备绑定加强。
- 遥测端点不存在：机制先行、默认不发；诚实承诺「当前不会发送任何数据」。
- 免费替代品强：付费墙压在 AI/同步/团队（后续批次），本批仅为框架。
- 不接真实支付：本批无收款能力，定价页为「即将推出」占位，收集意愿信号。
