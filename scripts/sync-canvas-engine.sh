#!/usr/bin/env bash
# 把「深鲸画布引擎」同步进插件（引擎 → 插件，单向）
#
# 为什么需要：插件要自带引擎核心（1.4 MB）才能"零配置"轻量可用；
# 但引擎的唯一源是独立仓库 deepwhale-canvas-cn。插件里那份是**副本**，
# 没有同步机制就必然分叉（2026-10-08 已经出现过一次手动同步）。
#
# 用法：
#   bash scripts/sync-canvas-engine.sh                    # 默认从 ~/DeepSeek Harness/canvas
#   CANVAS_SRC=/path/to/canvas bash scripts/sync-canvas-engine.sh
set -euo pipefail
CANVAS_SRC="${CANVAS_SRC:-$HOME/DeepSeek Harness/canvas}"
DST="$(cd "$(dirname "$0")/.." && pwd)/shell-plugins/dsh-shell-canvas/engine"

[ -d "$CANVAS_SRC/src" ] || { echo "找不到引擎源：$CANVAS_SRC" >&2; exit 1; }

echo "[sync] 源 : $CANVAS_SRC"
echo "[sync] 目标: $DST"
rm -rf "$DST"
mkdir -p "$DST"
for d in src packs templates; do cp -R "$CANVAS_SRC/$d" "$DST/"; done

# 记下来源版本，便于排查"插件里这份引擎是哪来的"
VER="$(git -C "$CANVAS_SRC" describe --tags --always --dirty 2>/dev/null || echo unknown)"
DESC="$(git -C "$CANVAS_SRC" log -1 --format='%h %ad %s' --date=short 2>/dev/null || echo unknown)"
{
  echo "source: deepwhale-canvas-cn"
  echo "version: $VER"
  echo "commit: $DESC"
  echo "synced_at: $(date '+%Y-%m-%d %H:%M:%S')"
} > "$DST/VERSION"
echo "[sync] 已写入 $DST/VERSION"; sed 's/^/        /' "$DST/VERSION"
echo "[sync] 引擎大小: $(du -sh "$DST" | cut -f1)（应 ≤ 5 MB）"
