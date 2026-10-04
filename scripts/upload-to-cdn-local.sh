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

echo "② 筛选（去掉 blockmap；**保留 mac 的两个 zip**）…"
# ⚠️ 2026-10-03 修：原来把桌面 zip 一起删了 —— 但 electron-updater 在 macOS 上读的正是
#    latest-mac.yml 里指的 zip；CDN 上没有它，用户点更新就会 403 失败（实测藏了一周）。
#    Windows/Linux 的 zip 仍然不要（它们用 exe/AppImage，zip 只是体积）。
cd "$STAGE"
for f in *; do
  case "$f" in
    *.blockmap) rm -f "$f" ;;
    *.zip)
      case "$f" in
        DeepWhale-Desktop-*-arm64.zip|DeepWhale-Desktop-*-x64.zip) : ;;
        *) rm -f "$f" ;;
      esac ;;
  esac
done
ls -la "$STAGE" | tail -n +2 | awk '{printf "   %s\n", $NF}'

echo "②a 放入「本版更新内容」（whatsnew.json）…"
# 用户要"升级前就知道改了什么"：这个文件由旧版本的壳在检查更新时拉取，
# 所以必须随每次发布同步到 CDN（内容来自仓库 assets/whatsnew.json）。
if [ -f "$ROOT/assets/whatsnew.json" ]; then
  cp "$ROOT/assets/whatsnew.json" "$STAGE/whatsnew.json"
  echo "   已放入 whatsnew.json"
else
  echo "   ⚠️ 没找到 assets/whatsnew.json（跳过）"
fi

echo "②b 校正 mac 更新清单（补双臂 + 按实际产物重算 sha512/size）…"
# CI 的 arm64 / x64 是两个 job，各生成一份 latest-mac.yml，后传的会覆盖先传的（只剩一个架构）；
# 这里用目录里真实存在的两个 zip 把缺失架构补回来，并保证哈希与上传的文件一致。
node "$ROOT/scripts/rewrite-update-manifest.js" --manifest latest-mac.yml --dir . --ensure-both-arch

echo "③ 上传到 CDN（OBS → dl.deepwhale.org.cn）…"
cd "$ROOT"
# --no-exclude：否则 sync-to-obs.js 的默认规则会把桌面 zip 又过滤掉（会白传）
node scripts/sync-to-obs.js --dir "$STAGE" --no-exclude

echo "④ 校验 CDN 上的版本号…"
for y in latest.yml latest-mac.yml latest-linux.yml; do
  printf "   %-18s " "$y"
  curl -s --max-time 20 "https://dl.deepwhale.org.cn/$y?cb=$RANDOM" | grep -m1 '^version:' || echo "(取不到)"
done
echo "✅ 完成"
