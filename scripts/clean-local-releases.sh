#!/usr/bin/env bash
# 清理**本机临时构建产物**（release-next* / release-test*）。
#
# 设计原则（踩过的坑）：
#   1) 默认 **dry-run**：只打印将要删什么、多大，不真删；确认后加 --yes。
#   2) 只删构建目录，**绝不**碰源码、mobile-ui、shell-plugins、docs、交付证据、HAP、~/Library。
#   3) 删之前检查「正式版是否在跑」：如果当前进程仍从 release-* 里启动，拒绝执行并提示先装正式版。
#   4) 桌面测试快捷方式（指向 release-* 的软链接）一起清掉；指向 /Applications 的快捷方式保留。
#
# 用法：
#   scripts/clean-local-releases.sh            # 预演
#   scripts/clean-local-releases.sh --yes      # 真删
#   scripts/clean-local-releases.sh --keep release-next27   # 保留某个目录（可多次）
set -u
cd "$(dirname "$0")/.." || exit 1

DO=0
KEEP=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) DO=1 ;;
    --keep) shift; [ $# -gt 0 ] && KEEP+=("$1") ;;
    -h|--help) sed -n '1,20p' "$0"; exit 0 ;;
    *) echo "未知参数：$1"; exit 1 ;;
  esac
  shift
done

# ① 安全闸门：还在从 release-* 跑的话不许删（否则删了用户正在用的 App）
if ps -ef | grep -v grep | grep -q "DeepWhale Desktop.app/Contents/MacOS/DeepWhale Desktop" ; then
  RUNNING=$(ps -ef | grep -v grep | grep "DeepWhale Desktop.app/Contents/MacOS/DeepWhale Desktop" | grep -o "/Users[^ ]*release-[^/]*" | head -1)
  if [ -n "$RUNNING" ]; then
    echo "✗ 检测到 App 正在从临时构建启动：$RUNNING"
    echo "  请先安装并启动 1.0.60 正式版（/Applications 里那个），再清理。"
    exit 2
  fi
fi

TOTAL=0
TARGETS=()
for d in release-*; do
  [ -d "$d" ] || continue
  skip=0
  for k in ${KEEP[@]+"${KEEP[@]}"}; do [ "$d" = "$k" ] && skip=1; done
  [ $skip -eq 1 ] && { echo "· 保留 $d（--keep）"; continue; }
  sz=$(du -sk "$d" 2>/dev/null | awk '{print $1}')
  TOTAL=$((TOTAL + sz))
  TARGETS+=("$d")
  printf '· 删除 %-22s %s\n' "$d" "$(du -sh "$d" 2>/dev/null | awk '{print $1}')"
done

# ② 桌面：指向 release-* 的测试快捷方式清掉；指向 /Applications 的保留
SHORTCUTS=()
for f in "$HOME"/Desktop/*.app; do
  [ -L "$f" ] || continue
  tgt=$(readlink "$f" || true)
  case "$tgt" in
    *"/dsh-desktop/release-"*) SHORTCUTS+=("$f"); printf '· 删除快捷方式 %s -> %s\n' "$(basename "$f")" "$tgt" ;;
    *) : ;;
  esac
done

echo
if [ ${#TARGETS[@]} -eq 0 ] && [ ${#SHORTCUTS[@]} -eq 0 ]; then
  echo "没有需要清理的临时产物。"
  exit 0
fi
printf '合计可释放：%s（%d 个构建目录 / %d 个桌面快捷方式）\n' \
  "$(awk -v k=$TOTAL 'BEGIN{printf "%.1fG", k/1024/1024}')" "${#TARGETS[@]}" "${#SHORTCUTS[@]}"

if [ $DO -eq 0 ]; then
  echo
  echo "（预演模式，未删除任何东西。确认无误后加 --yes 真删。）"
  exit 0
fi

for d in ${TARGETS[@]+"${TARGETS[@]}"}; do
  rm -rf -- "$d" && echo "已删除 $d"
done
for f in ${SHORTCUTS[@]+"${SHORTCUTS[@]}"}; do
  rm -f -- "$f" && echo "已删除快捷方式 $(basename "$f")"
done
echo "完成。"
