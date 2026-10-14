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

首次启动会自动签发一个管理员令牌并打印：

```
已签发管理员令牌（请填入客户端设置页的「企业服务器」令牌栏）：
  tc_xxxxxxxxxxxxxxxxxxxxxxxx
令牌表：./enterprise-data/tokens.json
```

把它填进客户端「设置 → 企业服务器」的地址（`http://<主机>:8787`）与令牌，点「连接测试」即可切换为企业态。

参数：`--port`（默认 8787）、`--host`（默认 0.0.0.0）、`--data-dir`（默认 ./enterprise-data）、
`--max-bytes`（单键体积上限，默认 8MB）。

### 令牌与席位

`tokens.json` 是权威的令牌表，可放多个令牌（每个 = 一个工作区/席位）：

```json
{ "tokens": [ { "token": "tc_xxx", "name": "云仓研发组", "role": "admin" } ] }
```

- `name` 是客户端「连接测试」成功后显示的工作区名。
- 吊销 = 从文件里删掉该条并重启（客户端随即收到 401）。
- 「成员/席位管理」的**接口尚未定义**——那需要账号体系与席位配额的服务端语义，等契约确定后再扩展。

### 接口一览

| Method | Path | 说明 |
|---|---|---|
| POST | /v1/auth/ping | 令牌校验 → `{ ok, name }`（401 表示令牌无效） |
| GET | /v1/kv/:key | 读键 → `{ data }`（404 表示键不存在，客户端映射为空值） |
| PUT | /v1/kv/:key | 写键（body `{ data }`）→ `{ ok }`（413 表示超体积上限） |

键名 `encodeURIComponent` 后传输，服务端按 `sha256(key)` 落文件名（键里的特殊字符不参与路径拼接）。

### 安全模型

| 项 | 说明 |
|---|---|
| 鉴权 | `Authorization: Bearer <token>`；常数时间比对（先 sha256 再 timingSafeEqual） |
| 限流 | 每令牌每分钟 600 次请求（429） |
| 体积 | 单键默认 8MB（可调），超限 413；请求体另设硬上限防内存打满 |
| 落盘 | 每键一个 JSON 文件，原子写（tmp + rename） |
| 部署 | 内网直连即可；若要跨公网**必须**置于 HTTPS 反向代理之后（配置同云同步） |

### 数据与备份

- 数据在 `<data-dir>/kv/`：每键一个 JSON（文件名 sha256(key)，文档内保留原始 key 便于排查）。
- 备份 = 直接复制 `<data-dir>/`（原子写保证单文件一致性）；恢复 = 放回重启。

## 测试

```bash
node --test server/sync-server.test.js
node --test server/enterprise-server.test.js
```

## 隐私说明

- 同步密码只存在于用户设备（PBKDF2 派生 + Windows DPAPI 保护落盘）；忘记密码 = 云端数据不可恢复（本地数据不受影响）。
- 本服务不记录内容字段；如需审计日志请自行在反向代理层配置访问日志。