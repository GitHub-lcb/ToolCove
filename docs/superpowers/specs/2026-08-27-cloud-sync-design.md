# ToolCove 商业化第二批 · 云同步设计文档（V2）

- 日期：2026-08-27（V2 修订：架构评审 5×P1 + 8×P2/P3 全量并入）
- 状态：4 项关键决策经用户确认；设计稿展示；审批弹窗工具故障按指令推进；评审 V2 修订后待复审
- 范围：速记 + 问题文本字段的端到端加密云同步（Pro 功能 cloud-sync）；服务端零依赖 Node 入仓库

## 1. 已确认的决策（用户批准）

| 决策点 | 结论 |
|---|---|
| 同步范围 v1 | 速记 + 问题文本字段；问题截图对象同步放 v2 |
| 加密模型 | 同步密码派生（零知识）：PBKDF2 → AES-256-GCM 信封，每记录独立 nonce |
| 设备配对 | 匿名配对码（短码 + 同步密码加入，无邮箱无账号） |
| 服务端形态 | 仓库内新增 server/（Node 零依赖：node:http + JSON 文件持久化） |

## 2. 背景与目标（同 V1）

批次一交付 Pro 许可体系与遥测/定价页；本批兑现「云同步（Pro 权益）」：速记与问题在多设备间零知识流转，为团队版 B2B 打数据面。原则不变量不变：零知识、无账号、复用 Rust http_request 代理、纯 JS 可单测、零新增依赖。

## 3. 加密模型（评审修订并入）

- 同步密码（≥8 位，仅本地）。派生：`PBKDF2-SHA256(密码, salt, 600_000)×→32B masterKey`，salt 16B 随机。
- **salt 分发（P1 修复）**：salt 非机密——`POST /v1/collection` 与 `POST /v1/pair` 响应均返回 `salt`；创建设备将盐落 settings，新设备用响应内 salt 派生同密钥。
- 记录信封：`base64(nonce12B || AES-256-GCM(记录JSON) || tag16B)`。**密文内嵌信封元数据（P2 修复）**：解密后 JSON = `{ deviceId, ts, record }`——LWW 裁决所需的 deviceId/updatedAt 由客户端解密后确定性判定，服务器盲存储无需 tiebreak。
- ID 混淆：`HMAC-SHA256(recordId, masterKey)` → 64 hex 上云；真实 uuid 永不上云。
- 本机保管：masterKey hex 编码后经 DPAPI（secure.js encrypt/decrypt，非 Windows 降级明文并在 README 明示）落 settings `sync.keyCipher`；派生结果进程内缓存（不缓存密码）。
- 同步字段子集（P3 修复）：速记 = 全字段（含内嵌 b64 图片）；问题 = title/type/status/note/tags/logs/resolution/aiAnalysis/createdAt/updatedAt，**排除 images 字段**（问题图片为外部文件，v1 不同步；远端应用时本地 images 字段保留本地值，不产生悬空引用）。
- 遗忘密码 = 云端不可恢复（明示）；本地不受影响。

## 4. 同步协议（seq 游标 + LWW + 墓碑；评审修订并入）

### 4.1 服务端模型（P1 修复：补 devices/pairing/salt/seq）

集合 JSON：`{ meta: {createdAt, salt}, pair: {codeHash, codeSalt, expiresAt, fails, lockedUntil}, devices: { tokenHash: {name, tokenTail, createdAt, lastSeen, revoked} }, seq: <单调计数器>, items: { id: {updatedAt, data, tombstone, seq} } }`

### 4.2 接口

| 操作 | 请求 | 说明 |
|---|---|---|
| 创建 | POST /v1/collection | 返回 collectionId + 配对码(8位/15分钟/一次性) + **salt** |
| 加入 | POST /v1/pair {collectionId, code, deviceName} | 返回 token + **salt**；失败 5 次冷却 15 分钟；**配对码有效期内可被多台设备复用作废后失效** |
| 重新生成配对码 | POST /v1/pairing-code（Bearer） | 作废旧码，返回新码（V2.2：多设备入伙必要；原文档「一次性消费」修正） |
| 拉取 | GET /v1/items?since=<seq>&limit=500 | 增量按 **seq** 升序分页；返回 items + nextSeq/hasMore + serverTime |
| 推送 | PUT /v1/items | 批量 ≤200 条/≤5MB；幂等：updatedAt+data 均同则跳过不占新 seq |
| 设备列表 | GET /v1/devices | 返回 [{tokenTail, name, createdAt, lastSeen, revoked, self}] |
| 吊销 | DELETE /v1/device?deviceId=<tokenHash> | 允许吊销自身（注销离场）与其它设备 |

### 4.3 游标与恢复（P1 修复）

- **增量游标 = 服务端单调 seq**（写入时分配），客户端存 `sync.cursor`；时钟漂移不再卡游标（服务器 seq 与客户端时钟无关）。
- 服务端 per-item 幂等：同 id 同 updatedAt 同 data → 跳过（不新分配 seq）；不同 → 覆盖并分配新 seq（LWW 由客户端保证只推赢家）。
- **持久化推送水位 `sync.lastPushedAt`**：engine 启动时本地重扫 `updatedAt > lastPushedAt` 重建推送集（崩溃/杀进程后离线编辑不丢）；推送成功后水位推进；拉取同样以持久化 cursor 恢复。
- GET 分页：since + limit（默认 500，可升 2000）；响应 hasMore/nextSeq；避免大库单次拉爆与限流。

### 4.4 冲突与删除（评审修订并入）

- LWW：解密后信封内 `ts`（updatedAt）大者胜；同值按 **deviceId** 字典序（密文内字段，客户端裁决；P2 修复）。
- 删除：本地墓碑（30 天）→ 推送 tombstone → 他端应用删除并留本地墓碑。
- 复活窗口（P2 明示）：墓碑 30 天与离线 >30 天设备存在删除复活窗口——v1 接受，补「离线复活」测试用例；服务端不主动清墓碑（由客户端清理策略决定，服务端仅存储）。

### 4.5 大条目与触发（P1 修复：删「截断」）

- **超限整条跳过同步**：单条密文 >2MB → 本地保留 + 标记 syncOmit + 逐条警告 + 手动重试入口；不截断（截断导致双端分叉）。
- 触发：启动拉取（延迟 8s）；变更防抖 3s 入队；手动「立即同步」；401 → 置 revoked 态停止（见 §6 状态机）；指数退避（2^n，上限 30 分钟，单日上限）。
- 传输：复用 http_request 代理，显式 timeout_ms=60_000（5MB 推送场景）。

## 5. 客户端

| 文件 | 职责 |
|---|---|
| src/sync/crypto.js | 派生(进程缓存)/加解密(信封含 deviceId+ts)/ID 混淆/盐生成 |
| src/sync/merge.js | LWW（ts+deviceId）/墓碑/问题 images 字段本地保留/归一 |
| src/sync/engine.js | 状态机：未配对/同步中/已同步/失败/已吊销/已禁用；拉取(seq 游标)/推送(水位+重扫)/队列/退避；transport 可注入 |

settings 配置：`sync: { enabled, serverUrl, collectionId, deviceName, deviceId, salt, keyCipher, cursor, lastPushedAt, status }`（normalizeSync 补默认）。

## 6. UI 与状态机（P2 修复）

- 设置页 Pro 分区「云同步」组：地址输入；状态卡（status 文案 + 最后同步时间）；创建（展示配对码 15 分钟）/加入（配对码+同步密码，**用响应 salt 派生**）；同步密码设置（创建/加入时）；保存密码后即解锁；设备列表（tokenTail 8 位 + 名 + self 标记 + 吊销按钮，重名警告）；立即同步；手动重试 syncOmit 条目。
- **开关状态机**：创建/加入成功 → enabled=true + status=idle；关闭开关 → 仅停 engine 不删数据；401 → status=revoked + 停 engine + 本地保留 + 提示重新入伙；吊销自己 → 同 revoked，进入可重新加入。
- 顶栏同步指示灯：灰=disabled / 蓝=syncing / 绿=synced / 红=error / 黄=revoked(可点进设置)。
- Pro 门禁：features 增 `cloud-sync`；keygen 默认含；演示 key 重签。

## 7. 测试策略（评审补例并入）

| 层 | 用例 |
|---|---|
| vitest crypto | 派生一致/盐变密钥变/往返/篡改/混淆稳定/空入参；信封含 deviceId+ts |
| vitest merge | LWW 矩阵/同秒同值 deviceId 裁决/墓碑新于记录/记录新于墓碑/离线复活/幂等/问题 images 本地保留 |
| vitest engine | 配对流/推拉闭环(seq)/401→revoked/退避/节流/(同秒双推)/持久化水位重启恢复/mock transport |
| node:test server | 建/配(一次性+TTL+冷却)/拉(seq 分页/游标不被时钟漂移卡死)/推(幂等/超限拒收)/设备列表/吊销(自与他)/持久化往返/限流 |
| 集成 | i18n 对齐、vite build、cargo check、双设备模拟（双端口 server） |

## 8. 交付清单（文件级）

- 新增：server/sync-server.js、server/sync-server.test.js、server/package.json、server/README.md、src/sync/crypto.js、src/sync/merge.js、src/sync/engine.js、src/sync/{crypto,merge,engine}.test.js、docs/superpowers/plans/2026-08-27-cloud-sync.md
- 修改：src/settingsConfig.js(+test)、src/features.js(+test)、src/SettingsView.vue、src/App.vue、src/SnippetView.vue、src/ProblemView.vue、scripts/license-keygen.js、src/i18n/zh-CN.json、src/i18n/en-US.json、README.md
- 版本号不动；Rust/依赖零改动（复用 http_request + secure.js）。

## 9. 边界与风险（修订版）

- v1 不做：问题截图对象同步、实时推送、多集合、服务端墓碑自清理（由客户端策略驱动）。
- 时钟漂移仅影响 LWW 次序（客户端裁决，可再编辑收敛），不再影响游标。
- 速度注意：PBKDF2 600k 在低端机约几百 ms，派生结果进程内缓存；首次输入密码时 UI 显示处理中。
- 非 Windows 平台 DPAPI 不可用 → keyCipher 明文降级（README + UI 提示）。

## 10. 流程记录

- 2026-08-27：决策确认 → V1 展示（审批弹窗工具故障，按指令推进）→ 评审迭代1（5×P1+8×P2/P3）→ V2 修订 → 复审迭代2（全部通过 + 新 P1 设备列表 tokenHash →「修复后即 APPROVED」）→ V2.1（tokenHash 补全/参数更名/revoked 401）→ **V2.2（实施期自审发现：配对码「一次性」使第二台设备无法入伙 → 改为有效期内可复用 + POST /v1/pairing-code 重生成；明示修正）** → 实施。

> V2.1/V2.2 说明：被吊销设备请求由 findSession 过滤返回 401；配对码有效期内可多设备复用，持有者经 pairing-code 端点重生成（作废旧码）。