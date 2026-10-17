#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 发版后**预热 CDN**（2026-10-17 事故后新增）
#
# 为什么需要：
#   用户 1.0.57 的自动更新下载 1.0.58 时"太慢，被我停掉了"。
#   排查发现不是带宽问题 —— CDN 实测 34 MB/s、100MB 只用 2.9 秒。
#   真实原因是：**刚上传完的文件还没进 CDN 缓存**，首次请求要回源，
#   而回源时不稳定（当晚我拉套装依赖时有 3 个文件被中途断流：
#   `transfer closed with N bytes remaining`）。
#   用户的一次更新，恰好撞在"缓存未落地"的窗口里。
#
# 做法：对每个新产物发一次 64KB 的 Range 请求，触发 CDN 缓存落地。
#   之后用户第一次下载就是 TCP_HIT，不会再遇到回源抖动。
#
# 用法：
#   bash scripts/warm-cdn.sh v1.0.58              # 桌面端 + 清单
#   bash scripts/warm-cdn.sh v1.0.58 --suite      # 额外预热套装
# ─────────────────────────────────────────────────────────────
set -uo pipefail

TAG="${1:?用法: warm-cdn.sh <tag>（如 v1.0.58）[--suite]}"
VER="${TAG#v}"
WITH_SUITE="${2:-}"
ORIGIN="https://dl.deepwhale.org.cn"

FILES=(
  "latest.yml" "latest-mac.yml" "latest-linux.yml" "whatsnew.json"
  "DeepWhale-Desktop-${VER}-arm64.dmg"
  "DeepWhale-Desktop-${VER}-x64.dmg"
  "DeepWhale-Desktop-${VER}-x64-Setup.exe"
  "DeepWhale-Desktop-${VER}-x86_64.AppImage"
  "DeepWhale-Desktop-${VER}-amd64.deb"
  "DeepWhale-Desktop-${VER}-arm64.zip"
  "DeepWhale-Desktop-${VER}-x64.zip"
)
if [ "$WITH_SUITE" = "--suite" ]; then
  FILES+=(
    "DeepWhale-Suite-${VER}-macOS-arm64.zip"
    "DeepWhale-Suite-${VER}-macOS-x64.zip"
    "DeepWhale-Suite-${VER}-Windows-x64.zip"
    "DeepWhale-Suite-${VER}-Linux-x64.zip"
  )
fi

echo "== 预热 CDN：$VER =="
ok=0; miss=0
for f in "${FILES[@]}"; do
  # ① 拉 64KB 触发缓存落地
  code=$(curl -sS -o /dev/null --max-time 90 -r 0-65535 -w '%{http_code}' "$ORIGIN/$f" 2>/dev/null)
  # ② 回读命中状态（TCP_HIT = 已进缓存）
  hit=$(curl -sS -I --max-time 25 "$ORIGIN/$f" 2>/dev/null | grep -oE 'TCP_HIT|TCP_MISS' | head -1)
  if [ "$code" = "200" ] || [ "$code" = "206" ]; then
    printf "  ✅ %-46s %s\n" "$f" "${hit:-?}"
    ok=$((ok+1))
  else
    printf "  ❌ %-46s http=%s\n" "$f" "$code"
    miss=$((miss+1))
  fi
done
echo "== 完成：预热 $ok 个，失败 $miss 个 =="
[ "$miss" -eq 0 ] || exit 1
