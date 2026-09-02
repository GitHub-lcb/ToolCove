# ToolCove 云同步 · 生产部署档案

> 维护人：开发
> 更新时间：2026-09-02
> 部署方式：SSH 自动化脚本（root）+ systemd；**本档案不含任何凭据**

## 1. 环境总览

| 项 | 值 |
|---|---|
| 服务器 IP | 106.12.166.113 |
| 系统 | CentOS 8（kernel 4.18 el8_5，4GB 内存） |
| 登录方式 | root + 密码（**建议轮换并启用密钥登录**，见 §6） |
| Node.js | v20.19.4（官方 tarball 安装于 /opt/node） |
| 服务名 | toolcove-sync（systemd） |
| 端口 | **8090**（8080 已被既有 nginx 占用，勿动） |
| 目录 | /opt/toolcove-sync/server（代码）、/opt/toolcove-sync/data（数据） |
| 数据形态 | 零知识：仅密文 + HMAC 混淆 ID + 时间戳 + 匿名设备 ID |

## 2. 当前状态（2026-09-02）

- [x] 代码上传、Node 安装、systemd 常驻、本机健康检查通过（HTTP_200）
- [ ] **公网放行：腾讯云安全组需放行 TCP 8090**（OS 层 iptables 已确认无拦截；安全组在云控制台操作，SSH 无法代劳）
- [ ] HTTPS：**待域名**——拿到域名并解析到本 IP 后，按 §5 Playbook 一键升级（HTTP 明文仅限内网/测试，公网使用必须走 HTTPS）

## 3. 日常运维

```bash
# 状态与日志
systemctl status toolcove-sync
journalctl -u toolcove-sync -f

# 健康检查（响应 200 即正常）
curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:8090/v1/collection

# 重启
systemctl restart toolcove-sync

# 数据备份（直接复制目录即可，原子写保证一致性）
tar czf /root/sync-data-$(date +%F).tar.gz /opt/toolcove-sync/data
```

## 4. 升级发布流程（客户端合并后用）

```bash
# 本地准备（repo 根目录执行，experimented 从仓库取最新 server 文件）
# 上传并重启：
scp server/sync-server.js root@106.12.166.113:/opt/toolcove-sync/server/sync-server.js
ssh root@106.12.166.113 'systemctl restart toolcove-sync && sleep 1 && curl -s -o /dev/null -w "%{http_code}
" -X POST http://127.0.0.1:8090/v1/collection'
```

## 5. HTTPS 升级 Playbook（拿到域名后）

前置：域名 DNS 的 A 记录解析到 106.12.166.113，安全组放行 80/443。

### 5.1 Caddy（推荐，自动证书）

```bash
# 安装 Caddy（CentOS 8）
dnf install -y yum-plugin-copr && dnf copr enable -y @caddy/caddy && dnf install -y caddy
```

```caddyfile
sync.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

```bash
systemctl enable --now caddy
```

### 5.2 客户端指向 https://sync.example.com，删除 http 警告

### 5.3 可选：安全组仅放行 80/443，8090 改为仅本机监听（`--host 127.0.0.1` 或注释掉 systemd 里的端口暴露）

## 6. 安全建议（务必执行）

1. **轮换 root 密码**：凭据曾以明文传输/存储，建议控制台改密。
2. 改用密钥登录（`ssh-keygen` + `ssh-copy-id`），关闭密码登录（`/etc/ssh/sshd_config` 中 `PasswordAuthentication no`）。
3. 数据目录定期备份（§3 命令）；备份文件与密文同级敏感，落私有存储。
4. 公网放行仅 8090/22（及未来 80/443），其余端口保持关闭。

## 7. 接口与协议速查

协议规范见 `docs/superpowers/specs/2026-08-27-cloud-sync-design.md`（V2.2）；服务端说明见 `server/README.md`：创建/配对/重生成配对码/seq 增量拉取/批量推送/设备列表/吊销，限流 300 次·IP·5min，配对码 15min/失败 5 次冷却。
