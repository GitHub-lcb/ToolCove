# 照片存档：存储配置指南

照片工具（工具箱 27）把手机拍的照片直传到你自己的对象存储/网盘，桌面端再批量下载归档。
本文说明三种后端的建桶、跨域与权限配置。**五分钟能配好，配错多半是 CORS 或缺权限。**

---

## 0. 先选后端

| 后端 | 手机直传 | 桌面归档 | 适合谁 |
|---|---|---|---|
| **S3 兼容**（腾讯 COS / MinIO / R2 / AWS） | 需要配桶 CORS | 原生支持 | 主流选择；容量与持久性由云厂商背书 |
| **七牛云 Kodo** | 不需要额外配置 | 原生支持 | 已有七牛账号；上传域名对浏览器跨域是放行的 |
| **WebDAV**（坚果云 / 群晖 / Nextcloud） | 取决于服务端是否放行 CORS | 原生支持 | 自建 NAS / 自配 CORS 的环境；公共网盘手机网页版多半传不了 |

## 1. 通用原则（三种后端都适用）

1. **用专用子账号**，权限只到这一个桶、只开放「上传 + 列举 + 读取」——不要用主账号密钥。
2. **凭据存放在设备上**：桌面端 DPAPI、安卓端 Keystore（`encrypt_text`）加密保存；
   **iPhone 网页版没有系统密钥库**，凭据以浏览器本地数据保存——这也是上一条建议的由来。
3. **五年保留靠"不设过期"**：照片工具全链路没有删除代码；云端保留策略是桶侧的事——
   建桶时**不要**设置生命周期过期规则；想省钱可以设「转低频/归档存储」（COS 的低频、OSS 的 IA），
   转存储类型不影响读取，只是取回成本不同。
4. **明文直存**（按你的选择）：存储服务商/服务器管理员能看到照片内容；介意的桶就不要公开读。
5. **桌面归档只新增、不覆盖**：同名对象（大小一致）直接跳过；`archive-manifest.json` 记录
   每个对象的 sha256，供日后校验。

## 2. 腾讯云 COS（S3 兼容）

**建桶**：访问权限选「私有读写」；地域记下来（如 `ap-guangzhou`）。

**CORS**（桶 → 安全管理 → 跨域访问配置）——不配手机端会以「TypeError: Failed to fetch」失败：

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 600
  }
]
```

**子用户与策略**（访问管理 → 用户 → 子用户 → 自定义策略）：

```json
{
  "version": "2.0",
  "statement": [
    {
      "effect": "allow",
      "action": ["cos:PutObject", "cos:GetObject", "cos:HeadObject", "cos:GetBucket"],
      "resource": ["qcs::cos:<地域>:uid/<APPID>:<桶名>/*", "qcs::cos:<地域>:uid/<APPID>:<桶名>"]
    }
  ]
}
```

**工具内填写**：服务地址 `cos.<地域>.myqcloud.com`；区域 `<地域>`；存储桶 `<桶名>-<APPID>`；密钥填子用户的 SecretId / SecretKey；路径风格一般不勾。

## 3. MinIO / Cloudflare R2 / AWS S3（S3 兼容）

- **MinIO**（自建，局域网/公网均可）：服务地址填 `主机:端口`（如 `192.168.1.10:9000`），区域随便填一个非空值（如 `us-east-1`），**勾选「路径风格寻址」**；CORS 在控制台 Bucket → Anonymous/Access Rules 里配（允许 `*` 来源的 PUT/GET/HEAD + Expose ETag）。
  - 局域网地址是 **http://**：浏览器页面跑在 HTTPS（GitHub Pages）下会被"混合内容"拦截——局域网直传请用安卓 App 的本地页面（http，无此限制），或给 MinIO 配上证书走 HTTPS。
- **Cloudflare R2**：服务地址 `<账户ID>.r2.cloudflarestorage.com`，区域填 `auto`，勾选路径风格；R2 的 CORS 在桶的 Settings → CORS Policy 里配（同样是 PUT/GET/HEAD + Expose ETag）。
- **AWS S3**：服务地址 `s3.<区域>.amazonaws.com`，区域 `<区域>`；CORS 配置项形状同上（JSON 字段名相同）。

## 4. 七牛云 Kodo

1. 对象存储 → 新建空间（访问控制按需：**私有空间**下载需令牌，工具会自动带；公开空间直接裸链）。
2. 空间设置 → **绑定域名**（CDN 域名）；没有域名无法长期下载（测试域名 30 天回收）。
   工具里的「访问域名」填它（只填域名，不要带 `https://`）。
3. 密钥管理 → 新建**子账号**，授予该空间的管理权限；AK/SK 填子账号的。
4. 「上传域名」一般不用改（默认 `upload.qiniup.com`，全球自动路由）。
5. 手机端上传走表单直传，**不需要额外配置跨域**；桌面端的列举走管理接口（rsf），
   连不上时先在桌面端点「测试连接」。

## 5. WebDAV（坚果云 / 群晖 / Nextcloud）

- **坚果云**：账户 → 安全选项 → 添加**应用密码**（不要用登录密码）；地址填
  `https://dav.jianguoyun.com/dav/照片存档` 之类。注意：坚果云的 WebDAV
  **不放行浏览器跨域**——手机网页版会传不上去，安卓 App 与桌面端可用。
- **群晖 / Nextcloud**：地址 `https://<主机>/remote.php/dav/files/<用户>/<目录>`（Nextcloud）
  或 `https://<主机>:5006/<目录>`（群晖 WebDAV Server）。要让手机网页版直传，
  需要在 WebDAV 服务或其反向代理（Caddy/Nginx）上补 CORS 响应头，例如：

  ```
  Access-Control-Allow-Origin: *
  Access-Control-Allow-Methods: PUT, MKCOL, OPTIONS
  Access-Control-Allow-Headers: Authorization, Content-Type
  ```

  同时要在反代上放行 `PROPFIND` / `MKCOL` 方法。

## 6. 桌面端归档

- 归档目录下按 `YYYY-MM-DD/`（拍摄日期，取自对象命名的目录段）存放原图；
- `archive-manifest.json`：每条记录 key / 大小 / sha256 / 归档时间 / 相对路径；
  「已存档」标记与「只下新照片」都以此为准——**换目录即换一本账**；
- 中断随时可取消：已下载的部分保留，下次刷新后重新勾选即可续跑（同名同大小自动跳过）。

## 7. 手机端注意事项

- 照片先落本地队列（IndexedDB）再上传：上传成功前杀掉 App、锁屏、断网都不会丢；
- **上传要停在页面前台**（iOS 的系统限制）；断网恢复、下次打开都会自动续传；
- iPhone 用户建议 Safari 打开手机版后「添加到主屏幕」，按 PWA 使用；
- 加照片**不需要先配置**——先拍先存，配置好后自动开传。
