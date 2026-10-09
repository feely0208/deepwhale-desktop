#!/usr/bin/env bash
# 把**开发版**的画布插件装进桌面端实际加载的位置（并自动备份旧版）。
#
# 为什么需要它（2026-10-09 踩到的最大的一次误会）：
#   用户测了半天说"不能多选"，其实他测的是**已安装版（1.0.55）里的旧插件** ——
#   应用加载的是 $DSH_HOME/plugins/dsh-shell-canvas，而我在改的是开发目录。
#   两边根本不是同一份文件。**改完必须装进去，不然用户永远看不到。**
#
# 用法：bash scripts/install-canvas-plugin-to-app.sh
#   装完**必须重启应用**（完全退出再开）才会加载新插件。
set -euo pipefail
HOME_DIR="${DSH_HOME:-$HOME/Library/Application Support/DeepWhale Desktop/dsh-home}"
TARGET="$HOME_DIR/plugins/dsh-shell-canvas"
# ⚠️ 直接用手写源码目录，不用 bundled-plugins/ ——
#   build-bundled-plugins.js 是**从 npm registry 拉已发布包**的，网络不通就失败，
#   而它失败时会保留旧载荷 → 用 bundled-plugins/ 会装进**旧版本**（踩过）。
SRC="$(cd "$(dirname "$0")/.." && pwd)/shell-plugins/dsh-shell-canvas"

[ -d "$SRC" ] || { echo "找不到构建产物：$SRC（先跑 npm run build / node scripts/build-bundled-plugins.js）" >&2; exit 1; }
[ -d "$HOME_DIR/plugins" ] || { echo "找不到应用的插件目录：$HOME_DIR/plugins" >&2; exit 1; }

echo "[装] 来源: $SRC"
echo "[装] 目标: $TARGET"
if [ -d "$TARGET" ]; then
  BAK="$TARGET.bak-$(date +%m%d-%H%M)"
  cp -R "$TARGET" "$BAK"
  echo "[装] 旧版已备份 → $BAK"
fi
rm -rf "$TARGET"
cp -R "$SRC" "$TARGET"
echo "[装] 完成 · 插件版本 $(python3 -c "import json;print(json.load(open('$TARGET/package.json'))['version'])" 2>/dev/null || echo '?')"
echo "[装] 自检: 可多选=$(grep -c '可多选' "$TARGET/lib/client.js" || true) · 三形态=$(grep -c '一次出三形态' "$TARGET/lib/client.js" || true) · 自动选后端=$(grep -c '自动选' "$TARGET/lib/client.js" || true)"
# ⚠️ 2026-10-09 加：这些文件是 ESM（用 import），**出现 require( 就是 bug**。
#    用户实测踩过一次：宿主里写 require('node:child_process') → 报 "require is not defined"，
#    表现是"点了没反应"（错误很小，肉眼容易漏）。所以装完自动扫一遍。
# 只看**宿主侧 ESM 文件**（index.js 与 lib/*.mjs）；
# client.js 是浏览器侧打包产物，那里 require 本来就可用，不算。
# 也排除注释行（说明性文字里提到 require 是正常的）。
REQ="$(grep -n 'require(' "$TARGET/lib/index.js" "$TARGET"/lib/*.mjs 2>/dev/null | grep -vE ':[0-9]+: *(//|\*|/\*)' || true)"
if [ -n "$REQ" ]; then
  echo "[装] ❌ 宿主 ESM 文件里出现 require(（运行时必报 require is not defined，表现为"点了没反应"）："
  echo "$REQ" | sed 's/^/       /'
  exit 1
fi
echo "[装] ✓ 宿主 ESM 无 require( 误用"
echo "[装] ⚠️ 现在**完全退出应用再打开**（光刷新不够，插件是启动时加载的）"
