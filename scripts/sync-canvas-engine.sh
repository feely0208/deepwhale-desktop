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
# ⚠️ spec/ **必须带上**（2026-10-09 真机上现形）：
#   校验文档要读 spec/v1/document.schema.json，缺了它面板会直接画
#   「ENOENT: no such file or directory, open '.../engine/spec/v1/document.schema.json'」，
#   任务永远出不了片。只拷 src/packs/templates 是不够的。
for d in src packs templates spec; do cp -R "$CANVAS_SRC/$d" "$DST/"; done

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
# ── 带上引擎的运行时依赖（2026-10-09 真机上现形的问题）─────────────
#   引擎 src/validate.mjs 静态 import 'ajv/dist/2020.js'。
#   开发机能在仓库根 node_modules 找到它；但插件被安装到 $DSH_HOME/plugins/ 后，
#   那里**没有 node_modules** → 真机上报「Cannot find package 'ajv'」，
#   面板显示「引擎 ? · 模板库 正在读取…」，插件等于不可用。
#   做法：把 ajv 及其运行时依赖一起放进 engine/node_modules/（Node 会从
#   engine/src/ 往上找到 engine/node_modules/ ✓），插件保持**自包含**。
#   体积：约 1.3 MB，插件总量仍在 5 MB 红线内。
DEPS="ajv fast-deep-equal json-schema-traverse require-from-string fast-uri"
NM="$DST/node_modules"
mkdir -p "$NM"
for dep in $DEPS; do
  if [ -d "$CANVAS_SRC/node_modules/$dep" ]; then
    # **整包拷**：不能只挑 dist/lib —— 有些包的入口就在包根
    #（fast-deep-equal 的 main 是 index.js，只拷子目录会报
    # "Please verify that the package.json has a valid main entry"）。
    cp -R "$CANVAS_SRC/node_modules/$dep" "$NM/$dep"
    echo "[sync]   + 依赖 $dep"
  else
    echo "[sync]   ⚠️ 找不到依赖 $dep（引擎的 ajv 校验会失败）" >&2
  fi
done

echo "[sync] 引擎大小: $(du -sh "$DST" | cut -f1)（应 ≤ 5 MB）"
echo "[sync] 插件总大小: $(du -sh "$(dirname "$DST")" | cut -f1)（红线 5 MB）"
