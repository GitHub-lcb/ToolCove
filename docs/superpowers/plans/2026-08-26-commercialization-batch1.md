# ToolCove 商业化第一批 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地商业化第一批基础设施：Pro 开关 + 离线 Ed25519 license 校验、可选遥测（仅计数、默认不发）、PRO/定价页（占位）、LICENSE 商业条款与 EULA 草案。

**Architecture:** 前端纯 JS 模块（license.js / features.js / telemetry.js / accentTheme.js）承载逻辑并配 vitest；Rust 侧 license.rs（ed25519-dalek 验签）与 telemetry.rs（reqwest 上报，端点为常量、默认空）通过 tauri 命令暴露；设置页新增 pro 分区与隐私开关；DbTool 新增 Pro 专属 xlsx 导出；App.vue 挂载时统一加载授权态并 provide 到全树。

**Tech Stack:** Tauri 2（Rust 2021）、Vue 3 (script setup)、vitest、vue-i18n（zh-CN/en-US 键对齐测试护航）、node:crypto（签发脚本，零新 npm 依赖）、ed25519-dalek（唯一新 Rust 依赖）。

**前置事实（已核对代码）：**
- 命令注册：src-tauri/src/lib.rs 的 `tauri::generate_handler![...]` 列表；数据文件走 storage::data_path(key)（`<app_data>/<key>.json`，key 仅安全字符）。
- xlsx 导出惯例：shared.js 返回 base64 → 前端 `invoke("export_file_b64", { path, contentB64 })`（见 ReleasePackage.vue:84-85 / TaskView.vue:346-347）。
- 主题变量：App.vue styles 中 light(≈448 行) / dark(≈731 行) 两套 `--accent*` 与 `--grad-brand` 变量，`applyTheme(mode)` 在 App.vue:244。
- 确认框：`askConfirm({...})`（src/confirm.js，SettingsView 已用）。
- 设置存取：`invoke("load_data",{key:"settings"})` / `invoke("save_data",...)`；SettingsView SECTIONS = [ai, general]。
- 私钥红线惯例：.gitignore 已排除 `src-tauri/updater.key`（标注"绝不入库"）。
- node:crypto 支持 ed25519（签名 64 字节，已实测）。

---

## 文件结构

| 文件 | 职责 |
|---|---|
| src-tauri/src/license.rs（新） | license_status/activate/deactivate 命令 + ed25519 验签 + 单测 |
| src-tauri/src/telemetry.rs（新） | telemetry_submit 命令（reqwest POST，端点常量默认空）+ 单测 |
| src-tauri/src/lib.rs（改） | mod 声明 + invoke_handler 注册 4 个新命令 |
| src-tauri/Cargo.toml（改） | 追加 `ed25519-dalek = "2"` |
| src/license.js（新） | key 文本解析/归一、状态归一化、无 Tauri 降级 |
| src/features.js（新） | PRO_FEATURES 清单 + isFeatureEnabled + lock 提示键 |
| src/telemetry.js（新） | opt-in 计数聚合、上限、localStorage 持久化、flush |
| src/accentTheme.js（新） | 自定义主题色预设 + apply/reset（Pro gate） |
| src/shared.js（改） | 新增 `buildDbResultXlsx(rows, cols)`（exceljs 惰性导入） |
| src/settingsConfig.js（改） | telemetry/license 字段归一（旧数据补默认） |
| src/App.vue（改） | 授权态加载 + provide、遥测首启询问、视图/工具埋点、侧边栏升级按钮、accent 应用 |
| src/SettingsView.vue（改） | pro 分区（状态卡/激活/定价/对比/爱发电）、隐私开关（遥测） |
| src/tools/DbTool.vue（改） | 结果集 xlsx 导出按钮 + Pro gate |
| scripts/license-keygen.js（新） | 生成密钥对 + 签发 license（node:crypto） |
| src/i18n/zh-CN.json / en-US.json（改） | settings.pro.* / pro.* / license.* / telemetry.* 键（两边同步） |
| LICENSE（改） | 新增商业授权条款小节 |
| docs/commercial/EULA.md（新） | 完整 EULA 草案（中文正文 + 英文摘要） |
| .gitignore（改） | 排除 `src-tauri/license-private.key` 与 `scripts/.license-secrets/` |
| README.md（改） | 爱发电链接、Pro 说明、遥测声明 |

## 设计要点速查（详见 specs/2026-08-26-commercialization-batch1-design.md）

- Key 格式：`TCV1-<base64url(payload)>.<base64url(sig64)>`；验签对象 = payload 原文。
- payload：`{"plan":"pro","name","email","issued","expires","features":[]}`，features 首批 = ["db-export-xlsx","theme-custom"]。
- 授权文件：`license.json`；状态经 `license_status` 每次实时验签（文件小，无缓存问题）。
- 遥测：settings.json `telemetry:{enabled,prompted,installId}`；埋点键 view.<key> / tool.<key> / ai.session；TELEMETRY_ENDPOINT 常量默认空字符串（不发送）。
- 锁定呈现：🔒 角标 + toast 提示去设置激活；设置页「在线激活」disabled + 「即将推出」。

---

### Task 1: Rust license 模块（验签 + 三个命令）

**Files:** Create `src-tauri/src/license.rs`; Modify `src-tauri/Cargo.toml`, `src-tauri/src/lib.rs`

- [ ] Cargo.toml 追加 ed25519-dalek = "2"（pin 版本，无需 rand 特性）
- [ ] license.rs：`PUBLIC_KEY_B64: &str`（占位——由 keygen 输出后填入；先放测试密钥对为默认值并在 README/脚本中说明替换）
- [ ] `struct LicensePayload { plan, name, email, issued, expires, features }` serde 反序列化（字段全 Option 容错）
- [ ] `parse_key(text) -> Result<RawKey, LicenseError>`：TCV1- 前缀、两段 base64url 解码、长度检查
- [ ] `verify(raw) -> Result<Licensed, LicenseError>`：ed25519-dalek VerifyingKey::from_bytes + verify_strict(payload_bytes, sig)
- [ ] LicenseError 枚举：Malformed/InvalidSignature/Expired/UnsupportedPlan/BadName（字符串化中文错误码：invalid-key / bad-signature / expired / unsupported-plan）
- [ ] `license_status(app) -> serde_json::Value`：读 license.json → 验签 → {pro, plan, name, email, expiresAt, features, error?}
- [ ] `license_activate(app, key)`：验签通过 → data_io_lock() + ensure_data_writable() 后 write_json_file → app.emit("license-changed", status) → 返回状态；失败返回 {pro:false, error}
- [ ] `license_status` 读侧特判：文件不存在或内容为空数组一律返回 {pro:false}（免费态）；`license_deactivate` 成功同样 emit license-changed
- [ ] `license_deactivate(app)`：删除 license.json（不存在则视为已免费版，不报错）
- [ ] `license_activate_online(_app, _email)`：返回 {pro:false, error:"coming-soon"}（预留）
- [ ] 单测 #[cfg(test)]：测试密钥对签发→验签通过；篡改 payload 任一字节→bad-signature；篡改签名→bad-signature；expires 过去→expired；非 TCV1 前缀/缺段/坏 base64→invalid-key
- [ ] lib.rs：`mod license; mod telemetry;` + generate_handler 追加 license_status/license_activate/license_deactivate/license_activate_online/telemetry_submit
- [ ] `cargo test` 通过（license 相关全绿）
- [ ] commit

### Task 2: 前端许可逻辑（license.js + features.js + 测试）

**Files:** Create `src/license.js`, `src/features.js`, `src/license.test.js`, `src/features.test.js`

- [ ] license.js：`parseLicenseKey(text)`——前缀/两段/字符集（base64url）/长度校验，返回 {payload, sig} 或 {error:"invalid-key"}
- [ ] license.js：`normalizeLicenseStatus(raw)`——null/缺字段兜底 {pro:false}；pro=true 才透传 plan/name/expiresAt/features
- [ ] license.js：`FREE_STATUS` 常量；`loadLicenseStatus()`——非 Tauri 环境返回 FREE_STATUS（不 invoke）
- [ ] features.js：`PRO_FEATURES = { "db-export-xlsx": {labelKey, descKey, icon}, "theme-custom": {...} }`
- [ ] features.js：`isFeatureEnabled(status, feature)`——无 status/未激活/features 列表面缺失 → false；`proLockHint(feature)` 返回 i18n 键
- [ ] license.test.js：合法 key 解析产物；畸形 key 各错误路径；normalize 兜底
- [ ] features.test.js：激活含 features 列表 / 空列表 / 免费态矩阵
- [ ] `npx vitest run src/license.test.js src/features.test.js` 通过
- [ ] commit

### Task 3: settingsConfig 归一 + telemetry.js + 测试

**Files:** Create `src/telemetry.js`, `src/telemetry.test.js`; Modify `src/settingsConfig.js`, `src/settingsConfig.test.js`

- [ ] settingsConfig.js：`normalizeTelemetry(raw)`——{enabled:false, prompted:false, installId:null} 兜底；installId 非法（非 string/超长）置 null
- [ ] settingsConfig.test.js：旧数据 {} / 缺失 / 半值补齐用例
- [ ] telemetry.js：`newInstallId()`（crypto.randomUUID 降级 Math.random）；`loadConfig()`（读 settings.json 的 telemetry 字段）
- [ ] telemetry.js：`track(key, {attempt}=1)`——聚合 Map；单键上限 1e6 熔断；localStorage `tc.telemetry.pending` 持久化
- [ ] telemetry.js：`consent(allow)`——立即 save_data 合并写回 enabled+prompted（与设置表单路径分离）；`maybePrompt()`——`!prompted`（undefined 也算未询问）才返回应询问
- [ ] telemetry.js：`isEnabled()` 读 settings.enabled 缓存 + 监听 settings-saved 失效缓存
- [ ] App.vue：启用时 10 分钟定时 flush + settings-saved 时 flush + beforeunload 尽力 flush（fire-and-forget）；工具子窗口只读不 flush
- [ ] telemetry.js：`flush()`——enabled 且聚合非空时 invoke("telemetry_submit",{events})；失败静默 + 单日重试≤5（localStorage 计数）
- [ ] telemetry.test.js：计数/上限/持久化往返/consent 状态机/不重复询问/禁用不发送（mock invoke）
- [ ] vitest 通过
- [ ] commit

### Task 4: Rust telemetry_submit

**Files:** Create `src-tauri/src/telemetry.rs`; Modify `src-tauri/src/lib.rs`

- [ ] telemetry.rs：`const TELEMETRY_ENDPOINT: &str = "";`（上线真实服务器前保持空）
- [ ] `telemetry_submit(events: Vec<serde_json::Value>) -> Result<(), String>`：endpoint 空 → Ok(())（静默）；非空 → reqwest POST JSON，超时 5s，任何错误 Ok 返回（不报错）
- [ ] 单测：空 endpoint 时直接 Ok；payload 无内容数据断言（仅结构单测，不真发请求）
- [ ] storage.rs 备份/恢复清单排除 license.json（run_backup/run_restore 均跳过 license 键），补集成测试验证恢复后 license 不被覆盖/复活
- [ ] cargo test 通过
- [ ] commit

### Task 5: App.vue 集成（授权态/首启询问/埋点/侧边栏入口/主题色）

**Files:** Modify `src/App.vue`

- [ ] 挂载时 `loadLicenseStatus()` → `licenseStatus = ref` + `provide("licenseStatus")`；订阅 Tauri 全局事件 `license-changed`（@tauri-apps/api/event listen）刷新
- [ ] ToolWindow.vue：挂载时 listen license-changed + 窗口 focus 时重拉 license_status（工具窗口兜底）
- [ ] 侧边栏底部：免费态显示「升级 Pro」按钮 → `openSettings("pro")`；Pro 态显示小徽章（显示授权名/到期）
- [ ] 首启遥测询问：onMounted 中（非 toolMode && __TAURI_INTERNALS__ && telemetry.prompted===false）→ `askConfirm` 文案（匿名计数声明 + 设置页可开关说明）→ consent(true/false)
- [ ] 埋点：`activateModule` 处 track("view."+key)（节流：同 key 10 秒内只计一次）；ToolboxView 打开工具 track("tool."+key)（在 ToolboxView 组件内做，避免 App.vue 膨胀——改放 Task 7 说明，此处若 ToolboxView 归 App.vue 管则由 App.vue track）
- [ ] accentTheme：Pro 态且 localStorage `tc.accent` 存在 → applyAccent(预设)（CSS 变量覆盖 --accent*/--grad-brand）；主题切换 applyTheme 后重放 accent
- [ ] 快速自查：npm run build 通过
- [ ] commit

### Task 6: SettingsView PRO 分区 + 隐私开关 + i18n

**Files:** Modify `src/SettingsView.vue`, `src/i18n/zh-CN.json`, `src/i18n/en-US.json`

- [ ] SECTIONS 追加 `{ key:"pro", labelKey:"settings.navPro", icon:"star", descKey:"settings.navProDesc" }`
- [ ] pro 分区四块：状态卡（免费/已激活，含 features 徽章）、激活框（key 输入 + 激活 + 错误码→i18n + 在线激活 disabled 按钮；已激活态显示「当前已激活」+「停用 Pro」需 askConfirm 确认）、定价卡（Pro 买断 ¥99/$39 2 年更新 + 团队版占位，均「即将推出」）、功能对比表（免费 vs Pro 行，12 工具 × 5 分组措辞）
- [ ] 爱发电入口按钮 → `openUrl("https://afdian.com/a/toolcove")`（失败 toast）
- [ ] general 分区追加「隐私」组：遥测开关（enabled）+ 说明文字（只计数/不上内容/当前不发送）；开关变化即时保存
- [ ] 激活成功 → window.dispatchEvent("license-changed") + toast「Pro 已激活」
- [ ] i18n：zh-CN/en-US 同步新增 settings.pro.*, pro.*, license.*, telemetry.* 全部键
- [ ] vitest（i18n 键对齐测试）通过
- [ ] commit

### Task 7: DbTool xlsx 导出（Pro gate）+ shared.js 帮助函数

**Files:** Modify `src/tools/DbTool.vue`, `src/shared.js`

- [ ] shared.js：`buildDbResultXlsx(rows, cols)`——列名+行数据，基础样式（表头加粗/边框），exceljs 惰性 import；cols 缺省取首行键
- [ ] DbTool.vue：导出区新增「Excel」按钮（csv/json 旁），点击：非 Pro → toast 提示+锁定样式；Pro → saveDialog 选路径 → buildDbResultXlsx → `invoke("export_file_b64",{path,contentB64})`
- [ ] 禁用态样式：按钮 🔒 角标 + toast 提示「Pro 功能，请到主窗口 设置 → Pro 激活」（沿用现有 ghost 按钮 + showToast）
- [ ] Export 区域监听 `license-changed` 刷新锁定态
- [ ] 手动冒烟：浏览器预览（非 Tauri）降级为 toast 提示需桌面端（沿用 exportNeedDesktop 惯例）
- [ ] commit

### Task 8: theme-custom Pro 新能力

**Files:** Create `src/accentTheme.js`; Modify `src/SettingsView.vue` (pro 分区内), `src/App.vue` 

- [ ] accentTheme.js：`ACCENT_PRESETS`（4 个预设：默认蓝/青绿/紫/橙，各含 --accent*/--primary/--primary-hover/--primary-soft/--grad-brand/--grad-selected/--border-blue 色值，深浅主题各一套补丁）+ `applyAccent(key)`（documentElement.style.setProperty 覆盖）+ `resetAccent()` + `loadAccent()`（按 themeMode/system→matchMedia 选深浅色值）
- [ ] 工具子窗口挂载路径（revealToolWindow）补 applyAccent（与 applyTheme 并列）
- [ ] pro 分区新增「主题色」组（仅 Pro 显示）：4 色板按钮 + 重置；非 Pro → 显示锁定提示行（不可交互）
- [ ] 选择写入 localStorage `tc.accent`；App.vue applyTheme 后重放
- [ ] 深色/浅色切换时 accent 保持（两套主题变量都被覆盖为所选色系）
- [ ] commit

### Task 9: 签发脚本 + 文档（LICENSE/EULA/README/.gitignore）

**Files:** Create `scripts/license-keygen.js`, `docs/commercial/EULA.md`; Modify `LICENSE`, `README.md`, `.gitignore`

- [ ] .gitignore：追加 `scripts/.license-secrets/`（私钥路径 scripts/.license-secrets/license.key，注释：license 私钥红线，参照 updater.key 先例）
- [ ] license-keygen.js：`node scripts/license-keygen.js --out <dir>` 生成密钥对（node:crypto ed25519）+ 打印 base64 公钥（供粘贴进 license.rs）；`--sign --name "..." [--email ...] [--features db-export-xlsx,theme-custom] [--expires 2027-12-31]` 读私钥签发并打印 key 文本（stdout 单行，便于复制到设置页激活）
- [ ] LICENSE：保留专有声明，新增「商业授权条款」小节（免费版定义 / Pro 授权 / 禁止转售 key / 14 天退款 / 与 EULA 冲突以 EULA 为准）
- [ ] docs/commercial/EULA.md：定义、授权范围（免费版+Pro）、买断/订阅与续费规则、退款、禁止行为（含 key 分享）、免责与责任限制、终止、适用法律（中国）、联系方式占位
- [ ] README.md：功能清单追加 Pro 说明行；下载节追加「爱发电支持」链接与遥测声明（默认关闭、仅计数）
- [ ] commit

### Task 10: 全量验证

- [ ] `npm run test`（vitest 全量）通过
- [ ] `cargo test`（含 license/telemetry 单测）通过
- [ ] `npm run build`（vite build）通过；`cargo check` 通过
- [ ] 生成一组真实测试 license（keygen 脚本）手动验证：激活→状态卡变化→xlsx 按钮解锁→主题色可选→重置
- [ ] 待发布时：keygen 生成正式密钥对，公钥替换 license.rs 占位值
- [ ] 全部提交干净

## V3 修订（2026-08-26，设计复审后同步）

- 错误码统一：Rust license_activate 仅返回 4 码 `malformed`（前缀/分段/base64/JSON 结构）/ `bad-signature`（验签失败）/ `expired` / `unsupported-plan`；license.js 归一与 SettingsView i18n 映射一一对应。（覆盖原 Task1/Task6 中 invalid-key 等旧码）
- license 写入改走 `replace_json_file`（storage.rs:83，与 save_data 同款，含损坏保护），仍在 data_io_lock + ensure_data_writable 内。（覆盖 Task1 写文件步骤）
- 恢复后写保护场景：`DATA_RESTORE_COMPLETE` 置位期间 ensure_data_writable 拒绝写入——激活/停用失败时 UI 提示「数据已从备份恢复，请重启应用后重试」。（Task 6 状态卡错误态补充）
- 备份/恢复隔离三处排除（Task 4 补充）：① run_backup 的 read_dir 扫描循环跳过 license.json；② read_restore_archive 过滤 license.json 条目（过滤跳过而非拒错）；③ managed_json_files 排除 license.json。集成测试断言：新备份不含 / 旧备份不复活 / 恢复后当前 license.json 原样保留。
- telemetry.js 抽纯函数 `shouldPrompt(settings)`（!telemetry?.prompted，undefined 计入）与 `mergePromptDecision(settings, allow)`；App.vue 只调用 + save_data。（Task 3 覆盖）
- SettingsView：插入 pro 分区后 `currentMeta` 兜底不得再依赖 `SECTIONS[1]` 下标（会变成 pro），改为显式 `find(s => s.key === "general")`；（Task 6 补充）`openSettings("pro")` 依赖 SECTIONS 校验，联调确认。
- accentTheme 测试并入 Task 8（预设结构/apply/reset/深浅补丁），telemetry.rs 单测并入 Task 4。
- 工具窗口只读不 flush 遥测；isEnabled 缓存失效与 settings-saved 的窗口级作用域配套——工具窗口挂载时读盘一次即可。