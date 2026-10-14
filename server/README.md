# ToolCove 服务端

本目录包含两个**零依赖** Node 服务（`node:http` + `node:crypto` + `node:fs`），按需选用：

| 服务 | 文件 | 用途 | 数据 |
|---|---|---|---|
| 云同步服务端 | `sync-server.js` | 速记/问题的多设备端到端加密同步 | 只存**密文**（零知识） |
| 企业服务器 | `enterprise-server.js` | 企业版桌面客户端的工作数据存储与令牌鉴权 | 存**明文**（企业内网，服务端即权威） |

> 本仓库只包含服务端源码。官方托管的同步服务属于可选渠道，你也可以完全自托管——客户端默认不连接任何服务器，只有你显式填写服务地址并开启后才会通信。

---
## 云同步服务端：快速开始

```bash
cd server
node sync-server.js --port 8080 --data-dir ./data
```

参数：`--port`（默认 8080）、`--host`（默认 0.0.0.0）、`--data-dir`（默认 ./data）。

## ⚠️ 生产必须 HTTPS

同步流量包含设备令牌与用户内容密文。公网部署**必须**放在 HTTPS 反向代理之后：

### Caddy（推荐，自动证书）

```
sync.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

### Nginx / 宝塔

```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;
    ssl_certificate     /www/server/panel/vhost/cert/sync.example.com/fullchain.pem;
    ssl_certificate_key /www/server/panel/vhost/cert/sync.example.com/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_read_timeout 60s;
        client_max_body_size 6m;
    }
}
```

### systemd 常驻

```ini
[Unit]
Description=ToolCove sync server
After=network.target

[Service]
WorkingDirectory=/opt/toolcove-sync
ExecStart=/usr/bin/node /opt/toolcove-sync/server/sync-server.js --port 8080 --data-dir /opt/toolcove-sync/data
Restart=always
RestartSec=3
User=toolcove

[Install]
WantedBy=multi-user.target
```

## 数据与备份

- 每个集合一个 JSON 文件（data/<collectionId>.json），原子写（tmp + rename）。
- 备份 = 直接复制 data/ 目录（单文件原子写保证一致性）。
- 恢复：把文件放回 data/ 重启即可。

## 安全模型

| 项 | 说明 |
|---|---|
| 零知识 | 服务端只见密文 / HMAC 混淆 ID / 时间戳 / 设备 ID（匿名随机 UUID），无明文、无账号 |
| 配对 | 8 位配对码，15 分钟有效，5 次失败冷却 15 分钟；持有者可随时重生成作废旧码 |
| 令牌 | 入伙签发 32B 随机 token，服务端只存 SHA-256；吊销后即时失效（401） |
| 限流 | 每 IP 5 分钟 300 次请求（429） |
| 幂等 | 同 (id, updatedAt, deviceId, data) 重复推送不占新序号；旧版本按 LWW 拒绝（stale） |
| 传输 | 客户端一律走 HTTPS（App 内 http 地址会有警告） |

## 接口一览

| Method | Path | 说明 |
|---|---|---|
| POST | /v1/collection | 创建集合 → collectionId + 配对码 + salt |
| POST | /v1/pair | 配对码入伙 → token + salt |
| POST | /v1/pairing-code | 重新生成配对码（Bearer） |
| GET | /v1/items?since=&limit= | 按 seq 增量拉取（分页） |
| PUT | /v1/items | 批量推送（≤200 条 / ≤5MB） |
| GET | /v1/devices | 设备列表（Bearer） |
| DELETE | /v1/device?tokenHash= | 吊销设备（Bearer，可吊销自身） |

## 企业服务器

为**企业版桌面客户端**提供工作数据存储与令牌鉴权。客户端契约写在
`src/platform/remoteStore.js` 的文件头注释，本服务是它的服务端实现。**存明文**——面向企业内网
（服务端即权威数据源，配合客户端的最小权限门禁与审计留痕使用），不要直接暴露到公网。

```bash
cd server
node enterprise-server.js --port 8787 --data-dir ./enterprise-data
```

首次启动会自动签发一个管理员成员并打印其令牌：

```
已签发管理员令牌（请填入客户端设置页的「企业服务器」令牌栏）：
  tc_xxxxxxxxxxxxxxxxxxxxxxxx
成员表：./enterprise-data/members.json
```

把它填进客户端「设置 → 企业服务器」的地址（`http://<主机>:8787`）与令牌，点「连接测试」即可切换为企业态。

参数：`--port`（默认 8787）、`--host`（默认 0.0.0.0）、`--data-dir`（默认 ./enterprise-data）、
`--max-bytes`（单键体积上限，默认 8MB）、`--seats`（席位上限，默认 0 = 不限）。

### 成员与席位

`members.json` 是权威的成员/席位表：

```json
{ "members": [ { "id": "…uuid…", "name": "云仓研发组", "role": "admin", "tokenHash": "<sha256>", "createdAt": 1730000000000 } ] }
```

- 服务端**只存令牌的 `tokenHash`（sha256），不存明文**——成员令牌仅在创建（`POST /v1/members`）的响应里返回一次，之后任何接口都不再提供，`GET /v1/members` 只回 `id/name/role/createdAt`。
- `name` 是客户端「连接测试」成功后显示的工作区名；`role` 为 `admin` 或 `member`，管理接口仅 `admin` 可访问。
- 吊销 = `DELETE /v1/members/<id>`（admin）；也可直接改文件后重启。不能删除自己（400 `cannot_revoke_self`）。
- **席位语义**：`--seats N` 约束**全部成员总数（含 admin）**，不只约束普通成员——admin 也占一个真实席位，避免账实不符。超配额时新建返回 `409 { "error": "seat_limit" }`；`0` 表示不限。

**旧版迁移（向后兼容）**：启动时若发现旧的 `tokens.json` 且没有 `members.json`，会自动迁成
`members.json`——旧条目里的明文 `token` 转成 `tokenHash`，`id` 用 `crypto.randomUUID()`，
`createdAt` 用当前时间；**原 `tokens.json` 保留不动**（迁移异常时可回滚），仅在启动日志里说明。
两者都存在时以 `members.json` 为准。

### 接口一览

| Method | Path | 权限 | 说明 |
|---|---|---|---|
| POST | /v1/auth/ping | 任意有效令牌 | → `{ ok, name, role }`（401 表示令牌无效） |
| GET | /v1/kv/:key | 任意有效令牌 | 读键 → `{ data }`（404 表示键不存在，客户端映射为空值） |
| PUT | /v1/kv/:key | 任意有效令牌 | 写键（body `{ data }`）→ `{ ok }`（413 表示超体积上限） |
| GET | /v1/members | admin | 成员列表 → `{ members: [{ id, name, role, createdAt }] }`（403 非 admin） |
| POST | /v1/members | admin | 新建成员（body `{ name, role? }`）→ 201 `{ member, token }`（令牌只返回一次；400 name 缺失；409 超席位） |
| DELETE | /v1/members/:id | admin | 删除成员 → `{ ok }`（400 删除自己；404 不存在） |

错误体统一为 `{ "ok": false, "error": "<code>" }`。键名 `encodeURIComponent` 后传输，
服务端按 `sha256(key)` 落文件名（键里的特殊字符不参与路径拼接）。

### 安全模型

| 项 | 说明 |
|---|---|
| 鉴权 | `Authorization: Bearer <token>`；服务端存令牌的 sha256，比对时先 sha256 再常数时间 `timingSafeEqual`（遍历全部不提前返回） |
| 成员 | 令牌绑定成员记录（`name` + `role`）；仅 `admin` 可管理成员与席位 |
| 限流 | 每成员每分钟 600 次请求（429） |
| 体积 | 单键默认 8MB（可调），超限 413；请求体另设硬上限防内存打满 |
| 落盘 | KV 每键一个 JSON 文件；成员表一个 `members.json`；均原子写（tmp + rename） |
| 部署 | 内网直连即可；若要跨公网**必须**置于 HTTPS 反向代理之后（配置同云同步） |

### 数据与备份

- 数据在 `<data-dir>/`：KV 在 `kv/`（每键一个 JSON，文件名 sha256(key)，文档内保留原始 key 便于排查）；成员表 `members.json`。
- 备份 = 直接复制 `<data-dir>/`（原子写保证单文件一致性）；恢复 = 放回重启。

## 测试

```bash
node --test server/sync-server.test.js
node --test server/enterprise-server.test.js
```

## 隐私说明

- 同步密码只存在于用户设备（PBKDF2 派生 + Windows DPAPI 保护落盘）；忘记密码 = 云端数据不可恢复（本地数据不受影响）。
- 本服务不记录内容字段；如需审计日志请自行在反向代理层配置访问日志。