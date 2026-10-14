# iOS 包怎么来的、怎么装（未签名路线）

## 一句话

GitHub Actions 在 macOS runner 上把网页产物打进一个 WKWebView 壳，**产出未签名的 `.ipa`**；
你下载后用爱思助手 / Sideloadly 拿**免费 Apple ID** 重签，就能装进 iPhone。

## 必须先明白的硬约束

**iOS 上不存在「没签名也能装」。** 每个 App 都必须有有效签名才能运行，这是系统层面的要求，
不是打包参数能绕过的。所以路线只有三条：

| 路线 | 花钱 | 有效期 | 说明 |
|---|---|---|---|
| **免费 Apple ID 重签**（本项目默认） | 0 | **7 天** | 用爱思助手 / Sideloadly 重签后安装；到期重签一次（不用卸载重装） |
| Apple Developer Program | $99/年 | 1 年 | 可 Ad-Hoc（需登记设备 UDID）/ TestFlight，免 7 天重签 |
| 浏览器「添加到主屏幕」 | 0 | 永久 | 不是原生 App，但零安装、零过期；本项目网页版支持（见 PWA 一节） |

## 怎么出包

推送一个 `ios-v<版本>` 标签（版本号与 `package.json` 的 `mobileVersion` 必须一致）：

```bash
npm pkg set mobileVersion=1.3.12
git push
git tag ios-v1.3.12
git push origin ios-v1.3.12
```

CI（`.github/workflows/ios-release.yml`，macOS runner）：

1. `npm run build:mobile` → 网页产物；
2. 把产物拷进 `mobile/ios/www/`；
3. `xcodegen generate` 生成 Xcode 工程（仓库只留一份可读的 `project.yml`，不提交 pbxproj）；
4. `xcodebuild -target ToolCove -sdk iphoneos CODE_SIGNING_ALLOWED=NO` 编译；
5. 自检 `verify-ipa.sh`（Info.plist 关键键、`www/` 目录树完整、不残留签名目录）；
6. 打成 `ToolCove-unsigned.ipa` → 上传 artifact + 挂到 Release。

改到 `mobile/ios/**`、`mobile/app/**`、`src/**` 并推到 main 时也会编译一次（只上传 artifact，不发 Release），
方便在没打标签时验证壳还能编过。

## 怎么装（Windows 电脑即可）

1. 在 Release 页下载 `ToolCove-unsigned.ipa`；
2. 装 **爱思助手**（i4Tools）或 **Sideloadly**，连上 iPhone；
3. 把 ipa 拖进去 → 填你的 **Apple ID**（普通账号即可）→ 开始签名安装；
4. 首次运行前在手机上信任：**设置 → 通用 → VPN 与设备管理 → 信任**；
5. 7 天后失效时，用同一个工具重签一次（数据不会丢，**不要卸载**）。

> 常见失败：Apple ID 触发了双重认证提示（按提示输验证码即可）、
> 手机未开启「开发者模式」（iOS 16+：设置 → 隐私与安全性 → 开发者模式）。

## 壳里有什么（与安卓壳的对应）

| 安卓 | iOS | 说明 |
|---|---|---|
| `AssetsServer.kt` | `AssetServer.swift` | 回环 `http://127.0.0.1` 服务，**端口固定**（49731–49734）。为什么非要用 http：`crypto.subtle` 只在安全上下文可用，`file://` 与自定义 scheme 都不是——七牛签名、加密工具箱会当场失效。端口固定是为了 origin 稳定，否则 IndexedDB 每次等于全丢 |
| `ToolCoveBridge.kt` | `Bridge.swift` | 命令名与桌面/安卓**完全同名**；安卓是同步返回，iOS 用 id 配对回填（前端那层只认「invoke 是函数」，返回 Promise 同样能用，**JS 一行没改**） |
| `MainActivity.kt` | `WebViewController.swift` | 还实现了 `<input type="file">` 的拍照/相册选择（iOS 必须实现 `runOpenPanelWith`，否则按钮点了没反应） |

**已实现的原生命令**：`app_version`、`http_request`（绕 CORS，七牛管理接口靠它）、
`encrypt_text` / `decrypt_text`（Keychain + AES-GCM）、`download_to_device`（落「文件 App ▸ ToolCove」）。

**未实现**：`file_*`、`db_*`、`update_*`、`network_tcp_check` 等——会如实返回
`{"__error": "手机端尚未实现该命令：…", "__code": "unsupported"}`，前端据此回退到浏览器实现
（纯 Web 能力照常可用），所以**不会白屏，只是少几个原生工具**。后续按需补。

## 与网页版的关系

同一个 `src/` + `mobile/app/` 构建产物：网页版（GitHub Pages）与 iOS 壳跑的是同一份代码。
iOS 上的差别只有两点：**产物在本地**（离线可用、加载快），以及**原生桥**带来的那些能力。
