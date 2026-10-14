#!/usr/bin/env bash
# 打包后的自检：把「这个包能不能被重签工具吃下去」的几件事验一遍。
#
# 为什么要单独验：iOS 的失败往往出现在"装的一刻"（爱思助手报签名失败），
# 而那时已经离构建很远了；这里把可静态判断的部分提前暴露出来。
set -u
app="${1:-out/ToolCove.app}"
fail=0

info="$app/Info.plist"
for key in CFBundleIdentifier CFBundleShortVersionString CFBundleVersion CFBundleExecutable; do
  value=$(/usr/libexec/PlistBuddy -c "Print :$key" "$info" 2>/dev/null || echo "")
  if [ -z "$value" ]; then
    echo "::error::Info.plist 缺少 $key"
    fail=1
  else
    echo "$key = $value"
  fi
done

# 资源服务靠 Bundle 里的 www/ 目录树；被拍平的话子目录会丢，App 打开就是白屏
count=$(find "$app/www" -type f 2>/dev/null | wc -l | tr -d ' ')
echo "www 文件数 = $count"
if [ "$count" -lt 5 ]; then
  echo "::error::www/ 里的文件太少（$count），网页产物可能没进包"
  fail=1
fi
for file in index.html assets; do
  if [ ! -e "$app/www/$file" ]; then
    echo "::error::www/$file 缺失"
    fail=1
  fi
done

# 未签名包不该带 _CodeSignature（带了说明构建参数没起作用）
if [ -d "$app/_CodeSignature" ]; then
  echo "::warning::包里出现了 _CodeSignature，构建参数可能没完全生效"
fi

exit $fail
