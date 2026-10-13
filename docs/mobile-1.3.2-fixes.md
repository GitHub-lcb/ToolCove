# 已修复：手机端三个"看起来没生效"的根因（1.3.2）

日期：2026-10-13 · 状态：**已修复** · 影响面：安卓 App（全部数据）+ iPhone 网页版（能力矩阵）

## 用户看到的现象

1. 装了 APK 1.3.1，「检查更新」却显示**当前是网页端**，与上一版一模一样、没有任何变化；
2. GitHub Pages 上的手机版（iPhone 用）也看不出区别；
3. 照片存档拍了照、传了之后杀掉 App 再打开，队列是空的（文档却写着"杀掉 App 也不丢"）。

## 根因（三个，互相独立）

### 1. 原生桥从装机起就没被接上过 —— 判据错了

Kotlin 侧用 `@get:JavascriptInterface val isMobile` 当"桥可用"标记，而 WebView 把 Java/Kotlin
成员注入成 JS **方法**：`window.ToolCove.isMobile` 是个函数对象，`=== true` 恒为假。
于是 `installNativeBridge()` 永远返回 false，整个 App 一直跑在**浏览器降级路径**上：
检查更新报 CORS 的 Failed to fetch、密钥不加密、HTTP 走 fetch 受跨域限制。

**为什么测试没发现**：E2E 的桥替身恰好种了 `isMobile: true` 这个**真机上不存在**的形状
（`45-mobile-realdevice` 那套用例本意就是"用真机形状跑"，却把假形状一起种了进去）。

**修法**：判据改成"`invoke` 是不是函数"（`mobile/app/platform/bridge.js`、`src/platform/env.js`），
Kotlin 侧删掉那个属性（多一个成员就是多一个攻击面）。
**守卫**：`mobile/app/platform/bridge.test.js`——只有 `isMobile` 布尔、没有 `invoke` 的形状**必须**判为不可用。

### 2. 本地服务用随机端口 —— 每次启动都换一个"站点来源"

`AssetsServer` 用 `ServerSocket(0)`（每次启动随机端口），而 WebView 加载的是
`http://127.0.0.1:<port>/`。**端口是 origin 的一部分**：`…:49731` 与 `…:51234` 在浏览器眼里
是两个不同的站点，IndexedDB / localStorage 各自独立。

后果不是"端口漂移"那么轻：每次冷启动都换一个来源 → 记录、工作台、设置、AI Key、照片上传队列
**全部像丢了**（数据其实还在旧来源里，只是再也没人读得到）；照片直传对象存储时，桶的 CORS
白名单也认不出这台设备（Origin 头每次启动都变）。

**修法**：绑**固定候选端口**（`AssetsServer.PREFERRED_PORTS`，首选 49731），候选全被占才退回系统分配；
启动日志打印 `stableOrigin`。代价是可预测性——服务只绑 127.0.0.1、只发 APK 内的静态资源、
没有任何服务端逻辑。
**守卫**：`AssetsServerTest`——「重启后端口不变」「首选被占退到下一个候选」「全占才退回随机且仍能服务」。

### 3. "手机形态"被当成了"有原生能力" —— iPhone 网页版的能力矩阵虚报

手机端产物（`__MOBILE__ = true`）同时供 **APK** 与 **GitHub Pages 给 iPhone 的 PWA** 使用，
两者只差有没有原生桥。但 `capabilities` 只看构建期常量，于是 iPhone 上
`sqlite / filePicker / secureStore / systemProxy / cloudSync` 全被标成"可用"：
本地数据库、SAF 选择器、云同步都露着入口，点下去必然失败；照片工具也不会提示
"凭据只存在浏览器本地"。

**修法**：`env.js` 新增运行时的 `hasNativeBridge` / `isNativeMobile`（判据同样是 `invoke` 是不是函数），
依赖原生桥的能力改为 `isDesktop || isNativeMobile`；界面文案区分「安卓 App」与「手机网页版（PWA）」。
**守卫**：`src/platform/env.capabilities.test.js`——「手机网页版」用例钉死那五项为 false，
并断言两种手机形态的差异**恰好**是那五项；E2E 侧 `46-mobile-backup.spec.js` 分两种形态各断言一次。

## 附带修掉的一个死结（同一次桥接通后才会暴露）

设置页原先把"密钥解密失败"与"快照读失败"混在一起处理：两者都禁止保存。
安卓的 Keystore 在卸载重装 / 清应用数据 / 换签名重装之后密钥会失效，此时**保存被禁止**，
用户连重填 API Key 的机会都没有。现在两者分开：读失败仍禁止保存（防覆盖原配置），
解密失败只提示并允许保存，且**留空保存不会覆盖原密文**（`mobile/app/SettingsView.vue`）。
**守卫**：`e2e/specs/37-mobile-settings.spec.js` 的「密钥解不出来」用例。

## 同时纠正的一处错误说明（照片存档 / WebDAV）

`providerWebdavBrowserWarn`（工具内提示）与 `docs/photo-storage-setup.md` §5 原先都写着
"多数公共网盘不放行浏览器跨域：手机网页版传不上去，**安卓 App 与桌面端不受影响**"。
这半句是错的：手机端上传一律是浏览器直发（`src/photo/upload.js` 的 `fetch`，不经过原生桥），
**安卓 App 里的页面同样是浏览器环境**（本地资源服务托管），CORS 一样会拦成 `Failed to fetch`。
照着旧说明排查，用户只会以为"App 又坏了"。现在两处都改成如实说明，并给出两条出路：
在 WebDAV 服务/反向代理上补 CORS 响应头，或改用 S3 兼容 / 七牛后端。
（桌面端 App 只做「列举 + 原生下载归档」，确实不受影响。）

**后续可做的改进**（本轮不动，属于功能改动）：把照片上传接到原生桥（`http_request` 加
`bodyBase64` 支持二进制请求体），安卓端就能真正绕过 CORS——那正是 `docs/mobile-app-plan.md` §4
里 `http_request` 存在的理由，只是照片工具为了三端同一条代码路径而选择了 `fetch`。

## 可复用的教训

1. **替身必须忠于真机形状**。假替身比没有替身更糟——它把"只在真机上出现的失败"变成了绿灯。
2. **平台能力要按运行时判定，不要按构建期常量**。同一份产物可能跑在有壳/没壳两种环境里。
3. **来源（origin）是数据的一部分**。凡是会变的端口/域名/协议，先问一句"存在它下面的东西还在吗"。
4. **禁止保存要有出路**。任何"不让你操作"的门禁，都要给一条用户能自己走出来的路。

## 追加：为什么"更新的 APK 装不上，要先卸载"（1.3.7）

Android 只允许**同签名**的包覆盖安装。而 CI 用的 debug 签名是**每次构建新生成**的：
AGP 在缺 `~/.android/debug.keystore` 时会随机生成一把，而 GitHub 的 runner 每次都是干净的。
实测证据（`apksigner verify --print-certs`）：

```
apk-v1.3.2  Signer #1 certificate SHA-256: b3240cf1f11059f167cdf93688f15efd1a6b2df4d33deb9fc09bf4b6a7a6f3ca
apk-v1.3.4  Signer #1 certificate SHA-256: a226a3280da0b83c9a13f009d6567acf09dd7aa29067cf890eabe44de1c75691
```

同一个应用、同一个版本线，两个包的签名完全不同——所以每次升级都要先卸载，
而卸载会连带清掉 **Keystore 加密的密钥与本机数据**（这正是"AI Key 又要重填"的来源）。

修法：CI 用 `actions/cache` 把 `~/.android/debug.keystore` 固定下来（缓存不在仓库里，也不随包分发），
并把签名指纹写进 Release 说明；本地自检（`npm run verify:apk`）也打印指纹。
要长期稳定（上架、换机器、清缓存都不受影响）请配 `ANDROID_KEYSTORE_BASE64` 等 Secrets——
工作流原本就支持，配了就走正式签名。