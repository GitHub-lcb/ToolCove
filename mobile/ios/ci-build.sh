#!/usr/bin/env bash
# iOS 壳的构建脚本（CI 与本地 macOS 都能跑）。
#
# 为什么把逻辑放进脚本而不是散在 workflow 的 run 里：
#   1) 一条命令就能在 mac 上复现 CI 的行为，排查不用推标签；
#   2) 全过程 tee 到 build.log —— 失败时 CI 会把这个日志推到 ci/ios-log 分支，
#      于是"看日志"不需要 GitHub API（匿名 API 有 60 次/小时的限流，真被卡过）。
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
log="$here/build.log"
: > "$log"
# 全过程既进日志又进 CI 输出
exec > >(tee -a "$log") 2>&1

version=$(node -p "require('../../package.json').mobileVersion" 2>/dev/null || echo 0.0.0)
echo "== 版本：$version =="

command -v xcodegen >/dev/null 2>&1 || brew install xcodegen
xcodegen --version
xcodegen generate

echo "== 工程与资源 =="
ls -la
echo "www 文件数：$(find www -type f | wc -l | tr -d ' ')"

echo "== xcodebuild =="
set -x
xcodebuild \
  -project ToolCove.xcodeproj \
  -target ToolCove \
  -configuration Release \
  -sdk iphoneos \
  CONFIGURATION_BUILD_DIR="$here/out" \
  MARKETING_VERSION="$version" \
  CURRENT_PROJECT_VERSION="1" \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  CODE_SIGNING_ENTITLEMENTS="" \
  build
set +x

app="$here/out/ToolCove.app"
test -d "$app" || { echo "没有产出 ToolCove.app"; exit 1; }
test -f "$app/www/index.html" || { echo "www/index.html 没有进包"; exit 1; }
echo "架构：$(lipo -info "$app/ToolCove")"
"$here/verify-ipa.sh" "$app"

rm -rf "$here/Payload"
mkdir -p "$here/Payload"
cp -R "$app" "$here/Payload/"
rm -f "$here/ToolCove-unsigned.ipa"
(cd "$here" && zip -qry ToolCove-unsigned.ipa Payload)
ls -lh "$here/ToolCove-unsigned.ipa"
echo "== 完成 =="
