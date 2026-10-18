#!/bin/bash
# 本机「改完代码 → 重启应用」一条龙（用户只需退出应用，其余全自动）
#
# 为什么需要（2026-10-18 反复折腾用户三次）：
#   1) 应用在跑时 release/mac-arm64 删不掉 → electron-builder 报 ENOTEMPTY；
#   2) `dist-local.sh` 以前只打包**不编译** → "重新打包"是空转，包里还是旧代码；
#   3) 让用户"退出后回话"是死循环（退出就把聊天界面关了，他没法回话）。
#
# 用法：在后台跑本脚本 → 用户托盘退出应用 → 脚本自动：等进程消失 → 杀 3095 上的 DSH
#      → 编译 + 拷随包插件 + 打包 → 用 open -n -g 拉起新包 → 校验 3095 恢复。
#
# 环境变量：
#   WAIT_SECONDS  等应用退出的最长时间（默认 900 秒）
#   SKIP_BUILD=1  只重启不重打包（调试用）
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
APP_DIR="${APP_DIR:-release/mac-arm64}"
APP="$ROOT/$APP_DIR/DeepWhale Desktop.app"
BIN="$APP/Contents/MacOS/DeepWhale Desktop"
WAIT_SECONDS="${WAIT_SECONDS:-900}"
MARKER=/tmp/dsh-rebuild-app.done

rm -f "$MARKER"
echo "[rebuild] 等待用户退出应用（最多 ${WAIT_SECONDS}s）…"

deadline=$(( $(date +%s) + WAIT_SECONDS ))
while :; do
  if ! pgrep -f "$BIN" >/dev/null 2>&1; then
    echo "[rebuild] 应用已退出 ✓"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "[rebuild] 等待超时 ✗（应用还在跑）"
    echo "timeout" > "$MARKER"
    exit 1
  fi
  sleep 3
done

# 应用退出后，它拉起的 DSH 可能还占着 3095 与 app 目录里的文件 → 必须收掉
for pid in $(lsof -nP -iTCP:3095 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}'); do
  echo "[rebuild] 停掉 DSH PID $pid"
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 3
for pid in $(lsof -nP -iTCP:3095 -sTCP:LISTEN 2>/dev/null | awk 'NR>1{print $2}'); do
  echo "[rebuild] 强制停掉 PID $pid"
  kill -9 "$pid" 2>/dev/null || true
done
sleep 1

if [ "${SKIP_BUILD:-0}" != "1" ]; then
  echo "[rebuild] 编译 + 拷随包插件 + 打包…"
  export CSC_IDENTITY_AUTO_DISCOVERY=false
  if ! ./scripts/dist-local.sh --mac --dir -c.directories.output="$APP_DIR" > /tmp/dsh-rebuild-app.log 2>&1; then
    echo "[rebuild] 打包失败 ✗ 详见 /tmp/dsh-rebuild-app.log"
    echo "build-failed" > "$MARKER"
    exit 1
  fi
  echo "[rebuild] 打包完成 ✓"
fi

# open -n：强制新实例（同 bundle id 时 -n 才不会再指回旧的那份）
echo "[rebuild] 拉起新包…"
open -n -g "$APP" 2>/dev/null || true

# 校验 3095 是否恢复（最多 60s）
for _ in $(seq 1 20); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3095/ 2>/dev/null || true)
  if [ "$code" = "401" ] || [ "$code" = "200" ]; then
    echo "[rebuild] 3095 已恢复 ✓（HTTP $code）"
    echo "ok" > "$MARKER"
    exit 0
  fi
  sleep 3
done

echo "[rebuild] 3095 未恢复 ✗（新包可能没起来，需手动双击）"
echo "not-running" > "$MARKER"
exit 1
