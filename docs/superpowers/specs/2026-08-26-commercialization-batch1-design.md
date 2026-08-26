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

### 4.2 Rust 侧（src-tauri/src/license.rs）

| 命令 | 说明 |
|---|---|
| `license_status` | 读 `license.json`，验签/过期检查，返回 `{pro, plan, name, email, expiresAt, features, error?}` |
| `license_activate(key)` | 验签通过则写 `license.json` 并返回状态；失败返回错误码（invalid / expired / malformed / unsupported-plan） |
| `license_deactivate` | 删除 license.json，回到免费版 |

- 单测：用测试密钥对验签、篡改 payload/签名各错误路径、过期校验。
- 数据文件独立为 `license.json`（复用 storage.rs 的 `data_path`，key="license"）。

### 4.3 前端

- `src/license.js`（纯 JS）：key 文本解析/归一、状态归一化（normalizeLicenseStatus）、无 Tauri 环境（浏览器预览）降级为"免费版"假状态。
- `src/features.js`（纯 JS）：`PRO_FEATURES` 清单 + `isFeatureEnabled(status, feature)` + 锁定 UI 文案键约定。
- App.vue 挂载时拉取 `license_status` 并 provide(`licenseStatus`)；工具子窗口各自在挂载时拉取。
- 激活输入在设置页 pro 分区；成功后 emit `license-changed` 刷新各处锁定态。

### 4.4 首批锁定的真实功能

1. `db-export-xlsx`：DbTool 结果集新增「Excel(.xlsx) 导出」按钮（新能力；CSV/JSON 保持免费）。复用 `shared.js` 中 exceljs 惰性导入模式，新写 `buildDbResultXlsx` 帮助函数。
2. `theme-custom`：设置页新增「自定义主题色」选择器（新能力，仅 Pro 显示可用）。写入 localStorage `themeAccent`，覆盖 CSS 变量 `--accent* / --grad-brand` 等；提供 `resetAccent`。

- 锁定表现：按钮/控件显示 🔒 角标 + tooltip「Pro 功能」，点击提示去设置激活（现有 showToast 机制）。

### 4.5 在线激活

- 仅预留：Rust 命令签名占位（`license_activate_online(email)` 返回"coming-soon"错误码）；设置页「在线激活」按钮 disabled + 「即将推出」。

## 5. 可选遥测

### 5.1 配置与同意

- settings.json 新增 `telemetry: { enabled: false, prompted: false, installId: "<uuid>" }`（settingsConfig.js 归一，旧数据自动补默认值）。
- 首次启动询问一次：主窗口 onMounted、非 toolMode、`window.__TAURI_INTERNALS__` 存在且 `prompted === false` 时，弹自绘确认框（复用 ConfirmDialog 风格）：文案声明「仅匿名统计功能使用次数，不上传任何内容数据」。
- 拒绝后 `prompted=true` 写回，永不再次打扰；设置页可随时开关。

### 5.2 采集面（仅聚合计数）

- 埋点键：`view.<moduleKey>`（视图激活）、`tool.<toolKey>`（工具箱工具打开/窗口创建）、`ai.session`（AI 会话创建）。
- 附带元数据：installId、appVersion、平台（navigator/bowser）、locale、时间戳、时区偏移。无内容、无文件路径、无 IP。

### 5.3 聚合与发送

- `src/telemetry.js`（纯 JS）：Map 计数聚合、`track()`／`flush()` 接口、上限保护（单键 10^6 次封顶防止异常爆炸）、持久化到 localStorage（跨会话保留未发送计数；`telemetry.pending` 键）。
- Rust 命令 `telemetry_submit(events)`：复用已有 reqwest（rustls），POST 到 `TELEMETRY_ENDPOINT` 常量。**默认常量留空 = 只聚合本地、不实际发送**；后续上线服务器填地址。
- 失败静默：网络错误不打扰用户；单日最多重试 5 次，指数退避（前端控制）。

## 6. PRO 页面 / 定价页

### 6.1 设置页新增分区

- SettingsView SECTIONS 增加 `{ key: "pro", labelKey: "settings.navPro", icon: "star", descKey: "settings.navProDesc" }`（置于 ai 之后）。
- 内容块（自绘，沿用现有卡片/按钮样式）：
  1. **状态卡**：免费版 / Pro 已激活（授权名、到期时间、features 徽章）。
  2. **激活框**：key 文本输入 → 激活按钮 → 错误提示；「在线激活（即将推出）」disabled 按钮。
  3. **定价卡**：Pro 买断 ¥99 / $39（2 年更新）；团队版占位；均标注「即将推出」。
  4. **对比表**：免费 vs Pro 功能行（现有 12 工具组摘要 + Pro 专属行）。
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
| vitest | license.js：key 解析（合法/畸形/分隔符错误/base64 错误）、状态归一；features.js：开关矩阵；telemetry.js：计数聚合、上限、持久化、prompted 逻辑（不重复询问） |
| Rust | license.rs 单测：验签、篡改 payload、篡改签名、过期、格式错误、命令返回结构 |
| 集成 | i18n 键对齐（已有）；migrate 兼容（settings.json 无新字段 → 默认值）；构建冒烟（npm run build + cargo check） |

## 9. 交付清单（文件级）

- 新增：`src-tauri/src/license.rs`、`src/license.js`、`src/features.js`、`src/telemetry.js`、`src/telemetry.test.js`（及 license/features 测试）、`scripts/license-keygen.js`、`docs/commercial/EULA.md`
- 修改：`src-tauri/Cargo.toml`、`src-tauri/src/lib.rs`、`src/SettingsView.vue`、`src/App.vue`、`src/tools/DbTool.vue`、`src/shared.js`、`src/settingsConfig.js`、`src/i18n/zh-CN.json`、`src/i18n/en-US.json`、`LICENSE`、`README.md`、`.gitignore`、`src/settingsConfig.test.js`
- 版本号不动（v0.2.1 → 发布时再定）。

## 10. 风险与边界（明示）

- 离线 key 可被传播：接受，属买断制通病；后续在线激活/设备绑定加强。
- 遥测端点不存在：机制先行、默认不发；诚实承诺「当前不会发送任何数据」。
- 免费替代品强：付费墙压在 AI/同步/团队（后续批次），本批仅为框架。
- 不接真实支付：本批无收款能力，定价页为「即将推出」占位，收集意愿信号。
