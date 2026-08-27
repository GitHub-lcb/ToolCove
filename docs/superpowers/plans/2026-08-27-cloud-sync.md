# 云同步（第二批）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付速记 + 问题文本字段的端到端加密云同步（Pro 功能 cloud-sync）：零知识（PBKDF2→AES-256-GCM 信封 + HMAC ID 混淆）、匿名配对码、LWW+墓碑、服务端零依赖 Node 入仓库。

**Architecture:** 纯 JS 三模块（crypto/merge/engine）承载全部逻辑并配 vitest；传输复用现有 Rust http_request 代理（Authorization 头透传）；主密钥 DPAPI 落盘 settings；服务端单文件 node:http + JSON 原子写；UI 在设置页 Pro 分区 + 顶栏指示灯。

**Tech Stack:** WebCrypto（PBKDF2/AES-GCM/HMAC-SHA256）、Node 内置 test runner（服务端）、vitest、vue-i18n、零新增 npm/Rust 依赖。

**前置事实（批次一已核对 + 本批补充）：**
- 记录结构：SnippetView（key=snippets，含 id/title/category/content/fields/images/createdAt/updatedAt）、ProblemView（key=problems，含 id/title/type/status/note/tags/logs/images/createdAt/updatedAt）——均有 uuid + updatedAt，可直接 LWW。
- settings 存取：invoke load_data / save_data（key=settings）；Secret 字段走 secure.js encryptValue/decryptValue（DPAPI，SettingsView 对 ai.apiKey 的先例）。
- http_request：method/url/headers/body/timeout_ms；返回 {status, body, bodyBase64, headers}。body 为字符串——加密后的 base64 密文可直接作 body。
- non-Tauri（浏览器预览）：engine 不启动（与 license/telemetry 同款 __TAURI_INTERNALS__ 降级）。

## 文件结构

| 文件 | 职责 |
|---|---|
| server/sync-server.js（新） | 零依赖 HTTP 服务：collection/pair/items/devices + 限流 + 原子写 |
| server/sync-server.test.js（新） | node:test 全接口用例 |
| server/README.md（新） | 部署指南（HTTPS/systemd/宝塔） |
| server/package.json（新，可选） | type module + test script（node --test） |
| src/sync/crypto.js（新） | 派生/加解密/混淆（WebCrypto，纯函数） |
| src/sync/crypto.test.js（新） | 派生一致/往返/篡改/混淆稳定 |
| src/sync/merge.js（新） | LWW/墓碑/归一（纯函数） |
| src/sync/merge.test.js（新） | 矩阵/墓碑/幂等 |
| src/sync/engine.js（新） | 状态机：配对/拉取/推送/队列/退避（注入 http 函数可测） |
| src/sync/engine.test.js（新） | mock 传输全流程 |
| src/sync/index.js（新，可选薄层） | 导出 createSyncEngine + 挂载钩子 |
| src/features.js（改） | PRO_FEATURES 增 cloud-sync |
| src/settingsConfig.js（改）+ test（改） | normalizeSync（旧数据补默认） |
| src/SettingsView.vue（改） | 云同步组 UI（创建/加入/设备/立即同步/开关） |
| src/App.vue（改） | 顶栏同步指示灯 + 启动拉取 + settings-saved 联动 |
| src/SnippetView.vue / src/ProblemView.vue（改） | persist 后通知 engine 入队 |
| src/i18n/zh-CN.json / en-US.json（改） | sync.* 键（对齐测试护航） |
| scripts/license-keygen.js（改） | 默认 features 含 cloud-sync |
| README.md（改） | 云同步章节 + 隐私声明 |

## 设计要点速查（详见 specs/2026-08-27-cloud-sync-design.md）

- 信封：base64(nonce12B || ct || tag16B)；云端 {id: HMAC64hex, updatedAt, tombstone, data}。
- LWW：updatedAt 大者胜；同值设备 ID 字典序（设备 ID = 本机生成的 uuid，存 settings）。
- 墓碑：30 天；删除记录时推送墓碑；他端收到应用删除并本地也留墓碑。
- 推送幂等：服务端按 (collectionId, itemId) upsert，updatedAt 取自客户端。
- 配对码：8 位（去 0O1lI 等易混淆字符），服务端存 SHA-256 后 15 分钟过期；失败 5 次冷却。
- token：32B 随机，服务端存 SHA-256。
- 大条目（密文 >2MB）不同步：本地标记 syncOmit，UI 提示。

---

### Task 1: 服务端 server/sync-server.js + 测试

**Files:** Create server/sync-server.js, server/sync-server.test.js, server/package.json, server/README.md

- [ ] 数据结构：集合文件含 pair（codeHash/expiresAt/fails）、devices（tokenHash→name/createdAt/lastSeen）、items（itemId→updatedAt/data/tombstone）、meta（createdAt）；单文件 data/<cid>.json 原子写（tmp+rename，写锁串行）。
- [ ] CLI：--port（默认 8080）、--data-dir（默认 ./data）、--host。
- [ ] POST /v1/collection：生成 cid(uuid) + 配对码(8 位)；返回 collectionId/pairingCode/expiresAt。
- [ ] POST /v1/pair：校验 codeHash + 未过期；一次性（成功后删除 pair）；失败计数+冷却；签发 token；返回 token。
- [ ] GET /v1/items?since=<ts>（Bearer 校验）：返回 items（按 updatedAt 升序）+ serverTime。
- [ ] PUT /v1/items（Bearer，批量 ≤200 条/≤5MB）：upsert；单条 data ≤2MB 拒收（错误列出条目）。
- [ ] DELETE /v1/device：吊销当前 token（删 tokenHash），返回 ok。
- [ ] 限流桶：byIP 5 分钟 300 次 → 429（独立于 collection 冷却）。
- [ ] 测试（node:test）：建/配/拉/推/幂等/吊销/重启持久化/一次性配对/冷却/限流/鉴权 401/大条目拒收。
- [ ] server/README.md：宝塔/Caddy HTTPS 反代、systemd 示例、数据目录备份说明。
- [ ] 本地跑通：node --test server/ 全绿。commit

### Task 2: crypto.js + 测试

**Files:** Create src/sync/crypto.js, src/sync/crypto.test.js

- [ ] deriveMasterKey(password, saltB64)：PBKDF2-SHA256 600k 迭代 → 32B；返回 base64。
- [ ] newSalt()：crypto.getRandomValues 16B → base64。
- [ ] encryptRecord(masterKeyB64, jsonString)：randomNonce → AES-GCM → base64(nonce||ct||tag)。
- [ ] decryptRecord(masterKeyB64, cipherB64)：校验 tag，失败抛坏密文错误。
- [ ] obfuscateId(masterKeyB64, recordId)：HMAC-SHA256 → 64 hex。
- [ ] 测试：派生一致（同输入同输出）、盐变则密钥变、往返、篡改任何字节失败、混淆稳定且不可逆、空/垃圾输入错误路径。
- [ ] vitest 全绿。commit

### Task 3: merge.js + 测试

**Files:** Create src/sync/merge.js, src/sync/merge.test.js

- [ ] normalizeItem(raw)：id/updatedAt/tombstone/data 归一（缺失补默认）。
- [ ] mergeItems(localMap, remoteItems, deviceId)：LWW 矩阵——远程新（并入）、远程旧（忽略）、同 updatedAt（deviceId 字典序）；tombstone 处理（远程墓碑新于本地→删除；本地墓碑新→推送）。
- [ ] applyRemote(records, merged)：产出「新增/更新/删除」操作列表（供视图消费）。
- [ ] 测试：矩阵覆盖（新/旧/同值/墓碑新于记录/记录新于墓碑）、幂等（重复合并结果一致）、重复 id 清洗。
- [ ] vitest 全绿。commit

### Task 4: engine.js + 测试

**Files:** Create src/sync/engine.js, src/sync/engine.test.js

- [ ] createSyncEngine({ http, loadConfig, saveConfig, getRecords, setRecords, ensureMasterKey })：http 注入（生产=包一层 invoke http_request 的 adapter，测试=内存 mock）。
- [ ] 状态：idle/syncing/error；lastSyncAt；queue（Map 防抖 3s 合并）。
- [ ] enqueue(records)：同 id 只留最新；节流计时。
- [ ] pull()：GET since=lastSyncCursor；合并；写回视图 setRecords；游标推进。
- [ ] push()：本地 ≥cursor 记录 → 加密 → PUT；401 → 状态 error(auth) 回调。
- [ ] runSync()：push 后 pull；成功置 lastSyncAt；失败指数退避（2 幂次，上限 30 分钟）单日上限。
- [ ] pair/create/join/revoke 透传。
- [ ] omits：密文 >2MB 标记 syncOmit 不入队。
- [ ] 测试：配对流、推拉闭环、401 处理、退避、节流合并、并发互斥（同一时刻只一个 sync）。
- [ ] vitest 全绿。commit

### Task 5: settings 配置 + 归一

**Files:** Modify src/settingsConfig.js + src/settingsConfig.test.js

- [ ] normalizeSync(raw)：enabled=false/serverUrl=空/collectionId=空/deviceName=空/deviceId=空/salt=空/keyCipher=空/cursor=0/lastSyncAt=0（serverUrl 合法域：http(s)://，长度 ≤512）。
- [ ] 测试：缺字段/非法值补齐。vitest 全绿。commit

### Task 6: 视图接入（SnippetView/ProblemView 变更入队）

**Files:** Modify src/SnippetView.vue, src/ProblemView.vue

- [ ] 两视图的 persist() 后调用 engineRef 入队（不阻断保存）。
- [ ] engine 拉取完成后通过回调把「操作列表」应用到视图（新增/更新/删除——删除需走视图既有删除路径）。
- [ ] 浏览器预览降级：无 engine（__TAURI_INTERNALS__ 假）。
- [ ] 手工冒烟：编辑速记 → 3s 后无异常。commit

### Task 7: UI（设置页云同步组 + 顶栏指示灯）

**Files:** Modify src/SettingsView.vue, src/App.vue（+ Icon.vue 如需要）

- [ ] SettingsView Pro 分区新增「云同步」组：开关（即存）；服务器地址输入；状态卡（最后同步/设备名/集合尾部 8 位）；「创建同步」「加入同步」（输配对码+同步密码）、「立即同步」「吊销设备」；错误文案（含 auth 失效引导重新入伙）。
- [ ] 首次创建流程：输地址→点创建→展示配对码 + 提示在其他设备「加入」。
- [ ] 密码输入：创建/加入时设置同步密码（保存派生盐 + DPAPI keyCipher）。
- [ ] App.vue 顶栏指示灯：监听 engine 状态事件；灰/蓝/绿/红 + tooltip；点击 openSettings(pro)。
- [ ] i18n sync.* 键 zh/en 同步。vitest 对齐测试通过。commit

### Task 8: Pro 门禁 + keygen + 演示 key

**Files:** Modify src/features.js, scripts/license-keygen.js, src/features.test.js

- [ ] features.js：PRO_FEATURES 增 cloud-sync（labelKey/descKey）。
- [ ] keygen：--features 示例与帮助文本补 cloud-sync。
- [ ] 重新签发演示 key（含 db-export-xlsx,theme-custom,cloud-sync）；license.rs PUBLIC_KEY_B64 不变（密钥对不变）。
- [ ] features.test.js 断言 3 个 feature。vitest 全绿。commit

### Task 9: 文档（README + 隐私声明）

**Files:** Modify README.md

- [ ] README 增「云同步」章节：零知识说明、自托管部署入口（server/README.md）、忘记密码影响、Pro 门禁。
- [ ] 隐私说明补：云同步为端到端加密，服务器不可见明文。commit

### Task 10: 全量验证 + 双设备模拟链路

- [ ] vitest 全量（含新增 sync 用例）、node --test server/、vite build、cargo check。
- [ ] 本地模拟：起 server（临时端口）→ engine A 创建配对 → engine B 加入 → A 写记录推送 → B 拉取解密还原 → 双向 LWW 冲突样例收敛（脚本化演练，输出 PASS 日志）。
- [ ] 全部提交干净；git log 汇总。