#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 本地冒烟测试 —— **自带完整回收**
#
# 背景：手工跑 `DSH_DESKTOP_SMOKE=1 electron dist/main/index.js` 会留下
#   ① 3199 端口的 DSH 实例（下次跑还会被"复用"，导致测出假结果）
#   ② `~/Library/Application Support/Electron/dsh-home`（370M+ 的迁移副本）
#   ③ 单实例锁（会让下一次启动静默退出、零输出）
# 所以：**测前清、测后也清**，并断言没有残留。
#
# 用法：
#   bash scripts/smoke-local.sh            # 跑一次，打印关键行
#   bash scripts/smoke-local.sh --keep     # 保留现场（调试用，记得自己收）
# ─────────────────────────────────────────────────────────────
set -uo pipefail

PORT=3199
UD="$HOME/Library/Application Support/Electron"
LOG=/tmp/dsh-smoke-$(date +%H%M%S).log
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1

cleanup() {
  lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | xargs -r kill -9 2>/dev/null
  pkill -f "dist/main/index.js" 2>/dev/null
  pkill -f "dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js" 2>/dev/null
  sleep 2
  if [ "$KEEP" = "0" ]; then
    rm -rf "$UD/dsh-home" 2>/dev/null
    rm -f "$UD/SingletonLock" "$UD/SingletonCookie" "$UD/SingletonSocket" 2>/dev/null
    rm -f "$HOME/Library/Logs/Electron/fault.log" 2>/dev/null
  fi
  # 还原被隔离的端口配置
  [ -f "$UD/settings.json.smoke-backup" ] && \
    mv -f "$UD/settings.json.smoke-backup" "$UD/settings.json" 2>/dev/null
}

# ⚠️ 回收必须挂 EXIT：壳内的 will-quit 回收**不可靠** —— 实测冒烟主进程有时
# 是被直接杀掉而非优雅退出，那时所有 app 退出钩子都不会跑，DSH 子进程会变成孤儿
# 继续占着端口。挂在脚本上才保证"无论怎么结束都收干净"。
trap cleanup EXIT INT TERM

echo "── 测前清理 ──"
cleanup

cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:$PATH"

# ⚠️ 关键：冒烟端口取自 <userData>/settings.json，**默认 3095 —— 也就是用户正在用的
# 那个会话**。不隔离的话，ServiceManager.isPortReady() 看到 3095 有响应就直接"复用"
# 用户实例：既不 spawn 随包运行时、注入也全跳过，冒烟**照样打印 [smoke] ok** ——
# 一次彻底的假通过，还会给用户弹窗。所以这里强制把端口改成隔离端口。
SETTINGS="$UD/settings.json"
mkdir -p "$UD"
[ -f "$SETTINGS" ] && cp -p "$SETTINGS" "$SETTINGS.smoke-backup" 2>/dev/null
python3 - "$SETTINGS" "$PORT" <<'PY'
import json, os, sys
path, port = sys.argv[1], int(sys.argv[2])
cfg = {}
if os.path.exists(path):
    try:
        cfg = json.load(open(path))
    except Exception:
        cfg = {}
cfg['port'] = port
json.dump(cfg, open(path, 'w'), ensure_ascii=False, indent=2)
print(f"  冒烟端口已隔离为 {port}（原配置备份在 settings.json.smoke-backup）")
PY

echo "── 构建 ──"
npm run build 2>&1 | grep -E "error TS|copy-assets\] done" | head -5

echo "── 跑冒烟（端口 $PORT，隔离 home）──"
DSH_DESKTOP_SMOKE=1 ./node_modules/.bin/electron dist/main/index.js --no-sandbox > "$LOG" 2>&1
CODE=$?

echo
echo "── 结果（已滤 GPU 噪音）──"
grep -vE "SharedImageManager|Invalid mailbox|shared_image_manager|skia_output_device" "$LOG" \
  | grep -E "smoke|service|legal-mode|office|plugins|Error" | head -20

echo
if grep -q "\[smoke\] DSH ready" "$LOG" && grep -q "\[smoke\] page ready" "$LOG"; then
  SPAWNED=$(grep -c "\[service\] 启动随包 DSH 运行时" "$LOG" 2>/dev/null || echo 0)
  if [ "$SPAWNED" -ge 1 ]; then
    echo "  ✅ 冒烟通过（真实拉起了随包运行时，exit=$CODE）"
  else
    echo "  ❌ 冒烟**无效**：没有拉起随包运行时（复用了已有实例）—— 结果不可信，请检查端口是否被占"
    exit 2
  fi
else
  echo "  ❌ 冒烟未通过（exit=$CODE）—— 完整日志：$LOG"
fi

echo
echo "── 测后回收 ──"
cleanup
lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | grep -q LISTEN \
  && echo "  ⚠️ $PORT 仍被占用" || echo "  ✅ $PORT 已释放"
ps aux 2>/dev/null | grep -qE "dist/main/index.js" \
  && echo "  ⚠️ 仍有残留进程" || echo "  ✅ 无残留进程"
if [ "$KEEP" = "0" ]; then
  du -sh "$UD" 2>/dev/null | sed 's/^/  缓存目录: /'
else
  echo "  （--keep：现场保留在 $UD/dsh-home，日志 $LOG）"
fi
