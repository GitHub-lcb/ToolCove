// 生成 iOS Release 的说明文本。
//
// 为什么用 Node 而不是 bash heredoc：heredoc 写在 YAML 的 run 块里时，
// 结束符的缩进、$ 插值、反引号三件事都很容易出错——第一版就这么把
// "版本号 / 体积 / ipa 文件名"三处插值写坏了（Release 页面上是乱码 + 空字段）。
// 换成 Node 写文件，编码与插值都由 JS 负责，YAML 里只剩一行命令。
import { readFileSync, statSync, writeFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const version = pkg.mobileVersion;
const ipaPath = "mobile/ios/ToolCove-unsigned.ipa";
const sizeKb = Math.round(statSync(ipaPath).size / 1024);

const notes = `ToolCove iOS 版 \`ios-v${version}\`（${sizeKb} KB，**未签名**）

## 怎么装（免费 Apple ID，不需要开发者账号）

1. 下载下面的 \`ToolCove-unsigned.ipa\` 到电脑（Windows 即可）；
2. 用 **爱思助手**（i4Tools）或 **Sideloadly** 打开它，用你的 **Apple ID** 重新签名；
3. 工具会自动装进连接的 iPhone；首次运行前在手机上信任：
   设置 → 通用 → VPN 与设备管理 → 信任。

## 必读

- **未签名包不能直接安装**：iOS 不存在「无签名运行」，必须重签这一步；
- 免费 Apple ID 的签名 **7 天过期**，到期用同一个工具重签一次即可（**数据不会丢，别卸载**）；
- 想免重签只能加入 Apple Developer Program（约 99 美元/年）；
- 这个包与网页版是**同一份前端代码**，原生能力目前覆盖：HTTP 请求（绕 CORS）、
  密钥加解密（Keychain + AES-GCM）、下载到「文件 App ▸ ToolCove」；
  \`<input type="file">\` 用系统自带选择器（拍照 / 相册）。
- 尚未实现的命令（文件读写、SQLite、更新检查等）会如实提示
  \`{"__code":"unsupported"}\`，前端据此回退到浏览器实现——**不会白屏，只是少几个原生工具**。

安装遇到问题见仓库里的 \`docs/ios-build.md\`。
`;

writeFileSync("release-notes-ios.md", notes);
console.log(`发布说明已生成：ios-v${version}，${sizeKb} KB`);
