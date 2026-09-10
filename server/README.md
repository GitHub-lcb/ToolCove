# ToolCove 云同步服务端

零依赖 Node 服务：只存储**密文**（端到端加密），服务器永远无法读取任何内容。

> 本仓库只包含服务端源码。官方托管的同步服务属于可选渠道，你也可以完全自托管——客户端默认不连接任何服务器，只有你显式填写服务地址并开启同步后才会通信。

---
## 快速开始

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

## 测试

```bash
node --test server/sync-server.test.js
```

## 隐私说明

- 同步密码只存在于用户设备（PBKDF2 派生 + Windows DPAPI 保护落盘）；忘记密码 = 云端数据不可恢复（本地数据不受影响）。
- 本服务不记录内容字段；如需审计日志请自行在反向代理层配置访问日志。