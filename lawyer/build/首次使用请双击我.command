#!/bin/sh
# 深鲸律师端 · 首次使用助手
# 作用：移除 macOS 给"从网上下载的 App"加的隔离标记（不然会提示"已损坏/无法验证开发者"），
#       并顺便给 App 打上本地临时签名，然后启动它。
cd "$(dirname "$0")" || exit 1
APP="深鲸律师端.app"
if [ ! -d "$APP" ]; then
  echo "❌ 没找到「$APP」，请确认本文件和它在同一个文件夹里。"
  echo "按回车键退出。"; read -r _; exit 1
fi
echo "→ 正在移除系统隔离标记…"
xattr -dr com.apple.quarantine "$APP" 2>/dev/null
echo "→ 正在做本地临时签名…"
codesign --force --deep --sign - "$APP" 2>/dev/null
echo "→ 启动「深鲸律师端」…"
open "$APP"
echo "✅ 完成。如果窗口没出现，直接在「应用程序」里双击「深鲸律师端」即可。"
sleep 2
