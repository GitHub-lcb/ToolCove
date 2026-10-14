# 照片存档：网页版的「补头转发」（photo relay）

## 为什么需要它

七牛管理接口（列举 /list、删除 /delete、移动 /move）**只认 `Authorization` 请求头**
（官方 Go SDK `auth/credentials.go` 的 `AddToken` 只有这一种传法），而七牛的数据域名
（`rsf.qbox.me`、`rsf-z2.qbox.me`、`rs-z2.qbox.me`…）对浏览器的 CORS 预检**不放行**这个头
（实测 OPTIONS 只回 `Access-Control-Allow-Origin: *`）。

所以浏览器发不出这种请求。App 与桌面端走原生 HTTP，不受此约束。

解法：页面上**本地签名**（AK/SK 只留在浏览器），把签好的凭证交给一个你自己部署的
「补头转发」，由它转发给七牛。**转发器不持有、不落盘任何密钥**，只做两件事：
补 `Authorization` 头 + 回 CORS 头。

## 部署方式一：Cloudflare Worker（推荐，免费、五分钟）

```js
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors() });
    }
    if (request.method !== "POST") return new Response("POST only", { status: 405, headers: cors() });
    const { url, method, headers } = await request.json();
    // 只转发给七牛（防开放代理）；GET/POST/HEAD 之外不放行。
    // ⚠️ 真实域名有：rsf.qbox.me / rs-z2.qbox.me / rsf.qiniuapi.com / api.qiniu.com /
    //    upload-z2.qiniup.com / s3-cn-south-1.qiniucs.com —— 用后缀列表逐一匹配，
    //    早期版本用一条塞满分支的正则漏掉了后三种，会被自己的转发器拦成 403。
    const target = new URL(url);
    if (!isAllowedHost(target.hostname) || !["GET", "POST", "HEAD"].includes(method)) {
      return new Response("forbidden", { status: 403, headers: cors() });
    }

    // 必须是【真后缀】：evil.com、qiniu.com.evil.com、rsf.qbox.me.evil.com 都不通过
    function isAllowedHost(hostname) {
      const host = String(hostname || "").toLowerCase();
      return [".qbox.me", ".qiniu.com", ".qiniuapi.com", ".qiniup.com", ".qiniucs.com"]
        .some((suffix) => host === suffix.slice(1) || host.endsWith(suffix));
    }
    const upstream = await fetch(target.href, {
      method,
      headers: Object.fromEntries(Object.entries(headers || {}).filter(([k]) => /^authorization$|^content-type$/i.test(k))),
    });
    const body = await upstream.text();
    return new Response(JSON.stringify({ status: upstream.status, body }), {
      headers: { ...cors(), "Content-Type": "application/json" },
    });
  },
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}
```

部署：dash.cloudflare.com → Workers & Pages → Create Worker → 粘贴 → Deploy，
然后把 `https://<worker 名>.<你的子域>.workers.dev/` 填进 照片存档 → 存储配置 → **网页转发地址**。

## 部署方式二：nginx（自有机房/内网）

```nginx
# 照片存档网页版的补头转发：只补 Authorization，不做任何签名与存储
location = /photo-relay {
    if ($request_method = OPTIONS) {
        add_header Access-Control-Allow-Origin "*" always;
        add_header Access-Control-Allow-Methods "POST, OPTIONS" always;
        add_header Access-Control-Allow-Headers "Content-Type" always;
        return 204;
    }
    if ($request_method != POST) { return 405; }

    # 从 JSON 体里取 url/method/headers 由应用层完成时，nginx 做不了 JSON 解析，
    # 所以这个地址要配到「server/photo-relay.mjs」（Node 版）上，nginx 只做反代：
    proxy_pass http://127.0.0.1:8127;
    add_header Access-Control-Allow-Origin "*" always;
    add_header Access-Control-Allow-Methods "POST, OPTIONS" always;
    add_header Access-Control-Allow-Headers "Content-Type" always;
}
```

Node 版（`server/photo-relay.mjs`，随仓库提供，`node server/photo-relay.mjs` 即可跑）：

```bash
node server/photo-relay.mjs --port 8127   # 或 PORT=8127
```

## 安全模型（务必读完）

- AK/SK **只存在浏览器**（localStorage/IndexedDB），转发器不接触 SecretKey，也不落日志；
- 转发器按上面的白名单**只转发给七牛域名**，避免变成任意开放代理；
- 它是"谁都能用"的公共端点——如果你担心被陌生人借用，把 Worker 里的 CORS `Allow-Origin`
  从 `*` 改成 `https://github-lcb.github.io`，或加一个自定义头作暗号；
- Cloudflare Workers 免费额度（10 万次/天）对这个工具绰绰有余。
