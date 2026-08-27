# ToolCove 商业化第二批 · 云同步设计文档

- 日期：2026-08-27
- 状态：设计已展示，4 项关键决策经用户确认（2026-08-27）；审批弹窗工具故障，按用户「继续下一个批次」指令推进，如异议可随时叫停
- 范围：速记 + 问题文本字段的端到端加密云同步（Pro 功能 cloud-sync）；服务端零依赖 Node 入仓库

## 1. 已确认的决策（用户批准）

| 决策点 | 结论 |
|---|---|
| 同步范围 v1 | 速记 + 问题文本字段；问题截图对象同步放 v2 |
| 加密模型 | 同步密码派生（零知识）：PBKDF2 → AES-256-GCM 信封，每记录独立 nonce |
| 设备配对 | 匿名配对码（短码 + 同步密码加入，无邮箱无账号） |
| 服务端形态 | 仓库内新增 server/（Node 零依赖：node:http + JSON 文件持久化） |

## 2. 背景与目标

批次一交付了 Pro 许可体系（Ed25519 离线 license + feature 开关）与遥测/定价页。第二批兑现商业化路线图中「云同步（Pro 权益）」：让速记与问题记录在多设备间安全流转，延续「本地优先、零知识、无账号」三承诺，为团队版 B2B 打数据面基础。

## 3. 总体原则（不变量）

- 零知识：服务器仅存密文/时间戳/混淆 ID，永无明文；用户密码永不上云。
- 无账号：匿名配对码入伙；服务端不存邮箱/手机号/真实记录 ID。
- 复用通道：所有请求经现有 Rust `http_request` 代理（规避 CORS，兑现「外部请求均经内置代理」承诺）。
- 纯 JS 逻辑可单测（vitest）；服务端用 Node 内置 test runner，零依赖。
- 不新增 npm 依赖、不新增 Rust 依赖；不新增运行时命令（复用 http_request）。

## 4. 加密模型

### 4.1 密钥派生

- 同步密码（≥8 位，仅本地使用，永不上云）。
- `PBKDF2-SHA256(password, salt, 600_000 次) → masterKey(32B)`，salt 随机 16B 存 settings。
- WebCrypto 实现（`crypto.subtle`），纯 JS 模块 `src/sync/crypto.js` 可单测。

### 4.2 记录信封

- 每条记录（速记/问题，含全部文本字段；速记内嵌图片 b64 随记录加密同步）序列化为 JSON。
- `AES-256-GCM(随机 96-bit nonce)` 加密 → `base64(nonce || ct || tag)`。
- 云端条目：`{ id: HMAC-SHA256(recordId, masterKey) 64hex, updatedAt: 明文, tombstone: bool, data: 密文 }`。
- 真实 uuid 永不上云；updatedAt 明文仅用于增量游标与 LWW 排序（内容无泄漏）。

### 4.3 本机解锁与密钥保管

- 主密钥经既有 DPAPI（secure.js encrypt/decrypt）加密后落 settings（`sync.keyCipher`），设备自身启动免输密码。
- 新设备加入：输入同步密码（salt 相同 → 派生同密钥）即可解密云端数据。
- 忘记密码 = 云端数据不可恢复（设置页与 README 明示）；本地数据不受影响。

## 5. 同步协议（LWW + 墓碑）

### 5.1 接口（详见 §6 服务端）

| 操作 | 请求 | 说明 |
|---|---|---|
| 拉取 | GET /v1/items?since=<ts> | 增量；返回 items + serverTime |
| 推送 | PUT /v1/items | 批量 upsert（幂等） |
| 创建集合 | POST /v1/collection | 返回 collectionId + 一次性配对码 |
| 加入 | POST /v1/pair | 配对码 + 设备名 → deviceToken |
| 吊销 | DELETE /v1/device | 撤销当前设备 token |

### 5.2 冲突与删除

- LWW：updatedAt 大者胜；同值按设备 ID 字典序；服务器盲存储。
- 删除：本地墓碑（30 天）→ 推送墓碑 → 他端应用删除；墓碑到期自动清理（客户端与服务端各自清理）。
- 同一记录同时推送与拉取：先落本地再合并且对外只留最新（单写者假设弱化——允许双端编辑，LWW 收敛）。

### 5.3 触发时机

- 启动成功后拉取一次（延迟 8s，避开首屏 IO）。
- 速记/问题视图本地变更 → 防抖 3s 入推送队列。
- 手动「立即同步」（设置页）。
- 失败静默退避重试（指数退避，单日上限），token 失效（401）→ 提示重新配对。

## 6. 服务端（server/）

### 6.1 实现

- 单文件 `server/sync-server.js`：node:http + node:crypto + node:fs；零依赖、免 npm install。
- 持久化：`data/<collectionId>.json` 单文件原子写（tmp + rename）；JSON 结构 `{ items: { [id]: {updatedAt, data, tombstone} } }`。
- token：入伙时生成随机 32B，服务端只存 `SHA-256(token)`；请求头 `Authorization: Bearer <token>`。
- 配对码：8 位字母数字（去易混淆字符），一次性（配对成功后作废）；失败 5 次冷却 15 分钟（按 collection）。
- 限流：按 IP 每 5 分钟 300 次请求（超出 429）。
- CLI：`node server/sync-server.js --port 8080 --data-dir ./data`。

### 6.2 安全边界

- HTTPS 必需：README 给出宝塔/Caddy 反代 + systemd 示例；客户端对 http 地址显示警告（内网自托管允许）。
- 服务端不校验密文格式（盲存储，零知识）；密钥永远在客户端。
- 推送 body 上限 5MB/批（超限分批）；单条目上限 2MB。
- 每个 collectionId = 独立文件 + 独立限流桶，隔离租户。

## 7. 客户端

### 7.1 模块

| 文件 | 职责 |
|---|---|
| src/sync/crypto.js | 派生/加解密/ID 混淆（纯 JS，可单测） |
| src/sync/merge.js | LWW 合并、墓碑传播、条目归一（纯 JS） |
| src/sync/engine.js | 状态机：配对/拉取/推送/队列/退避（mock http 可测） |

### 7.2 配置（settings.json）

```json
"sync": { "enabled": false, "serverUrl": "", "collectionId": "", "deviceName": "", "salt": "", "keyCipher": "" }
```

- `keyCipher` = DPAPI 加密的 masterKey（secure.js 复用）。
- settingsConfig.js 归一：旧数据自动补默认（全关）。

### 7.3 Pro 门禁

- license features 新增 `cloud-sync`；`features.js` PRO_FEATURES 注册表补充；keygen 默认签发含该 feature；演示 key 重新签发。
- 未激活/无该 feature：设置页云同步组显示锁定引导；engine 不启动。

## 8. UI

- 设置页 Pro 分区新增「云同步」组（仅 Pro 可见）：
  - 服务器地址输入 + 保存；状态卡（最后同步时间、开关）；
  - 「创建同步」→ 展示配对码 15 分钟有效；或「加入同步」→ 输配对码 + 同步密码；
  - 设备列表（token 尾部 8 字符 + 设备名 + 吊销按钮）；
  - 「立即同步」按钮 + 错误文案。
- 顶栏小同步指示灯：灰=未启用 / 蓝=同步中 / 绿=已同步 / 红=失败（可点击进设置）。
- 速记/问题视图：变更防抖入队（SnippetView/ProblemView 的 persist() 钩子）。

## 9. 测试策略

| 层 | 用例 |
|---|---|
| vitest crypto.js | 派生一致性（同盐同密码同密钥）、不同盐不同密钥、加解密往返、篡改检测、nonce 随机、HMAC 混淆稳定 |
| vitest merge.js | LWW 矩阵（新/旧/同值 tiebreak）、墓碑传播、删除收敛、增量合并幂等 |
| vitest engine.js | mock http：配对流、拉取写入、推送队列、401 处理、退避上限、节流合并 |
| node:test server | 创建/配对（一次性/冷却）/拉取增量/推送幂等/吊销/重启持久化往返/限流 429 |
| 集成 | i18n 键对齐、vite build、cargo check、本地模拟链路（server 起服务 + engine 双设备对跑） |

## 10. 交付清单（文件级）

- 新增：server/sync-server.js、server/sync-server.test.js、server/README.md、src/sync/crypto.js、src/sync/merge.js、src/sync/engine.js、src/sync/crypto.test.js、src/sync/merge.test.js、src/sync/engine.test.js、docs/superpowers/plans/2026-08-27-cloud-sync.md
- 修改：src/settingsConfig.js（sync 归一）+ 测试、src/features.js（cloud-sync）、src/SettingsView.vue（云同步组）、src/App.vue（同步指示灯）、src/SnippetView.vue / src/ProblemView.vue（变更入队）、scripts/license-keygen.js（默认 feature 含 cloud-sync）、src/i18n/zh-CN.json / en-US.json（sync.* 键）、README.md（云同步章节）
- 版本号不动；Rust/依赖零改动（复用 http_request + secure.js）。

## 11. 边界与风险（明示）

- v1 不做：问题截图对象同步、实时推送（WebSocket）、多集合管理、服务端过期清理集群化。
- 风险：客户端时钟漂移 → LWW 误判（接受，v1 单用户多设备场景可容忍；服务端排序已含 serverTime 参照）。
- 风险：速记内嵌图片 b64 使单条体积大 → 单条上限 2MB 截断并警告（超限记录不同步，本地保留）。
- 遗忘密码不可恢复云端（明示文案 + EULA 更新留待售卖批次）。

## 12. 流程记录

- 2026-08-27：brainstorming 确认 4 项决策；设计稿展示；审批弹窗两次超时（工具故障），按用户"继续下一个批次"指令推进，如异议可随时叫停。
- 谱系：spec 评审（subagent）→ 修订定稿 → writing-plans → 实施。