#!/bin/bash
# 本地上传安装包 + 更新清单到 CDN（比跨海 CI 快得多）
#
# 用法：scripts/upload-to-cdn-local.sh v1.0.40
# 依赖：~/.obs-credentials（600 权限，只放 AK/SK）
set -euo pipefail
TAG="${1:?用法: upload-to-cdn-local.sh <tag>，例如 v1.0.40}"
VER="${TAG#v}"
CRED="$HOME/.obs-credentials"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGE="$(mktemp -d)/cdn"

[ -f "$CRED" ] || { echo "❌ 缺少 $CRED"; exit 1; }
# shellcheck disable=SC1090
set -a; . "$CRED"; set +a
[ -n "${OBS_AK:-}" ] && [ -n "${OBS_SK:-}" ] || { echo "❌ $CRED 里的 OBS_AK / OBS_SK 还没填"; exit 1; }

echo "① 从草稿 Release 下载 $TAG 的资产…"
mkdir -p "$STAGE"
gh release download "$TAG" --pattern "DeepWhale-Desktop-${VER}-*" --pattern "latest*.yml" --dir "$STAGE"

echo "② 按 CI 同样的规则筛选（去掉 blockmap 与 zip）…"
cd "$STAGE"
for f in *; do
  case "$f" in *.blockmap|*.zip) rm -f "$f";; esac
done
ls -la "$STAGE" | tail -n +2 | awk '{printf "   %s\n", $NF}'

echo "③ 上传到 CDN（OBS → dl.deepwhale.org.cn）…"
cd "$ROOT"
node scripts/sync-to-obs.js --dir "$STAGE"

echo "④ 校验 CDN 上的版本号…"
for y in latest.yml latest-mac.yml latest-linux.yml; do
  printf "   %-18s " "$y"
  curl -s --max-time 20 "https://dl.deepwhale.org.cn/$y?cb=$RANDOM" | grep -m1 '^version:' || echo "(取不到)"
done
echo "✅ 完成"
