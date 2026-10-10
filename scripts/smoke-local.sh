#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 本地冒烟测试 —— **自带完整回收**，支持「开发态」与「打包态」两种目标
#
# 用法：
#   bash scripts/smoke-local.sh                  # 开发态：npm run build 后跑 dist/main/index.js
#   bash scripts/smoke-local.sh --app <路径>     # 打包态：直接跑打好的 .app / 可执行文件（CI 用）
#   bash scripts/smoke-local.sh --keep           # 保留现场（调试用，记得自己收）
#   bash scripts/smoke-local.sh --port 3199      # 换隔离端口
#
# 为什么加「打包态 / --app」（2026-10-10）：
#   verify-dsh-version workflow 的「打包态冒烟」原来只会调默认模式 —— 而默认模式会
#   **重新 build、跑 dist/main/index.js（开发态）**，根本没碰刚打出来的
#   release-verify/…app。于是那一步测的不是打包产物（日志里连打包产物都没出现），
#   断言 ui-legal-mode 自然对不上。现在 CI 传 --app，脚本跳过 build、只跑打包产物。
#
# 为什么回收只按「本次唯一标记」：
#   旧版用 `pkill -f dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js` 收尾 ——
#   那条命令在本机会把**用户正在用的深鲸桌面/DSH 实例**一起杀掉（同一份包内路径）。
#   CI 里侥幸没暴露，但只要有人在本机跑一次就是事故。现在：
#     · 打包态的 userData 目录名带本次唯一标记（TAG），只回收带该标记的进程；
#     · 两种模式都只按**隔离端口**回收 DSH 服务 —— 默认的 3095（用户实例）绝不碰。
# ─────────────────────────────────────────────────────────────
set -uo pipefail

PORT=3199
TAG="dw-smoke-$(date +%Y%m%d-%H%M%S)-$$"
LOG="${SMOKE_LOG:-/tmp/dsh-smoke-$(date +%H%M%S).log}"
KEEP=0
APP=""

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP=1 ;;
    --app) APP="${2:-}"; shift ;;
    --app=*) APP="${1#--app=}" ;;
    --port) PORT="${2:-}"; shift ;;
    --port=*) PORT="${1#--port=}" ;;
    *) echo "未知参数：${1}（可用：--app <路径> / --keep / --port <端口>）" >&2; exit 2 ;;
  esac
  shift
done

# 打包态用**全新的临时 userData**（名字里带 TAG，回收时只认它）；
# 开发态沿用 Electron 默认目录，保持旧行为不变。
if [ -n "$APP" ]; then
  UD="/tmp/$TAG-ud"
else
  UD="$HOME/Library/Application Support/Electron"
fi

# 递归杀一棵进程树（先子后父）。只在 cleanup 里对**本次启动的** pid 用。
kill_tree() {
  local pid="$1" sig="${2:-TERM}" kid
  [ -n "$pid" ] || return 0
  for kid in $(pgrep -P "$pid" 2>/dev/null || true); do kill_tree "$kid" "$sig"; done
  kill -"$sig" "$pid" 2>/dev/null || true
}

cleanup() {
  # ⚠️ 绝不按「dsh 运行时路径」全局 pkill（会误杀用户正在用的实例）。
  [ -n "${APP_PID:-}" ] && kill_tree "$APP_PID" TERM
  pkill -f "$TAG" 2>/dev/null
  # 只回收隔离端口上的 DSH 服务（3095 是用户实例，不在此列）。
  lsof -nP -iTCP:$PORT -sTCP:LISTEN -t 2>/dev/null | xargs -I{} kill -9 {} 2>/dev/null
  sleep 2
  [ -n "${APP_PID:-}" ] && kill_tree "$APP_PID" KILL
  pkill -9 -f "$TAG" 2>/dev/null
  if [ "$KEEP" = "0" ]; then
    if [ -n "$APP" ]; then
      rm -rf "$UD" 2>/dev/null
    else
      rm -rf "$UD/dsh-home" 2>/dev/null
      rm -f "$UD/SingletonLock" "$UD/SingletonCookie" "$UD/SingletonSocket" 2>/dev/null
      rm -f "$HOME/Library/Logs/Electron/fault.log" 2>/dev/null
    fi
  fi
  # 还原被隔离的端口配置
  [ -f "$UD/settings.json.smoke-backup" ] && \
    mv -f "$UD/settings.json.smoke-backup" "$UD/settings.json" 2>/dev/null
  # 回收函数只负责收尾，不允许用返回码覆盖冒烟结论（它会作为 EXIT trap 再跑一次）
  return 0
}

# ⚠️ 回收必须挂 EXIT：壳内的 will-quit 回收**不可靠** —— 实测冒烟主进程有时
# 是被直接杀掉而非优雅退出，那时所有 app 退出钩子都不会跑，DSH 子进程会变成孤儿
# 继续占着端口。挂在脚本上才保证"无论怎么结束都收干净"。
trap cleanup EXIT INT TERM

echo "── 测前清理 ──"
cleanup

cd "$(dirname "$0")/.." || exit 1
export PATH="/usr/local/bin:$PATH"

if [ -n "$APP" ]; then
  # 打包态：.app → Contents/MacOS/<name>；也允许直接传内部可执行文件
  if [ -d "$APP" ] && [ -x "$APP/Contents/MacOS/$(basename "$APP" .app)" ]; then
    APP_BIN="$APP/Contents/MacOS/$(basename "$APP" .app)"
  else
    APP_BIN="$APP"
  fi
  [ -x "$APP_BIN" ] || { echo "❌ 打包产物不可执行：$APP_BIN"; exit 2; }
  APP_ARGS=("$APP_BIN" "--user-data-dir=$UD" "--no-sandbox")
  echo "── 打包态冒烟（不重新 build，直接跑打包产物）──"
  echo "  应用：$APP_BIN"
  echo "  userData：${UD}（全新隔离）"
  echo "  端口：$PORT"
  mkdir -p "$UD"
  printf '{"port":%d}' "$PORT" > "$UD/settings.json"
else
  echo "── 开发态冒烟（会先 npm run build）──"
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
  APP_ARGS=(./node_modules/.bin/electron dist/main/index.js --no-sandbox)

  echo "── 构建 ──"
  npm run build 2>&1 | grep -E "error TS|copy-assets\] done" | head -5
fi

echo "── 跑冒烟（端口 ${PORT}，隔离 userData=${UD}）──"
# 壳放后台跑，同时并发轮询 DSH 界面查插件清单 ——
# 必须断言**用户实际能看到的结果**（界面里有没有法律模式），
# 而不是"注入写了盘"。本轮踩的坑恰恰是"写盘了但界面看不到"：
# DSH 的客户端插件清单在服务启动那一刻定型，事后重载页面也不变。
PLUGIN_OUT="/tmp/dsh-smoke-plugins-$$.txt"
UI_JAR="/tmp/dsh-smoke-jar-$$.txt"
UI_HTML="/tmp/dsh-smoke-ui-$$.html"
: > "$PLUGIN_OUT"

env -u ELECTRON_RUN_AS_NODE -u DSH_WEB_URL -u DSH_SESSION_ID -u DSH_SHELL -u DSH_PROFILE_DIR \
  DSH_HOME="$UD/dsh-home" DSH_PROFILE=deepwhale DSH_DESKTOP_SMOKE=1 \
  "${APP_ARGS[@]}" > "$LOG" 2>&1 &
APP_PID=$!

(
  TURL=""
  for _ in $(seq 1 40); do
    sleep 3
    TURL=$(grep -oE '\[smoke\] dsh token url: \S+' "$LOG" 2>/dev/null | head -1 | sed 's/.*url: //')
    [ -n "$TURL" ] && break
    kill -0 "$APP_PID" 2>/dev/null || break
  done
  if [ -z "$TURL" ]; then echo "NO_TOKEN" > "$PLUGIN_OUT"; exit 0; fi
  # ⚠️ 拿到 token 只是"服务把地址打出来了"，**不等于界面已就绪**（实测 token 行 ~6s 就有，
  # 而界面要几十秒）。旧版只 curl 一次 → 抓到空页/鉴权页 → 报出假的 NO_MANIFEST。
  # 所以这里重试：拿到清单（COUNT=）或壳退出为止。
  for _ in $(seq 1 30); do
    curl -sSL -c "$UI_JAR" -b "$UI_JAR" -o "$UI_HTML" --max-time 20 "$TURL" 2>/dev/null
    python3 - "$UI_HTML" > "$PLUGIN_OUT" 2>/dev/null <<'PY'
import re, sys
try:
    html = open(sys.argv[1], encoding='utf-8').read()
except Exception:
    print("NO_UI"); raise SystemExit
m = re.search(r'plugins/\?\?([^"]+)"', html)
if not m:
    print("NO_MANIFEST"); raise SystemExit
items = [x.split('/client.js')[0] for x in m.group(1).split(',') if x]
print("COUNT=%d" % len(items))
print("LEGAL=%s" % ("YES" if any('legal' in i for i in items) else "NO"))
PY
    grep -q '^COUNT=' "$PLUGIN_OUT" 2>/dev/null && break
    kill -0 "$APP_PID" 2>/dev/null || break
    sleep 4
  done
) &
POLLER=$!

wait $APP_PID
CODE=$?
wait $POLLER 2>/dev/null

echo
echo "── 界面插件清单断言（首次启动，未经重启）──"
if grep -q "^LEGAL=YES" "$PLUGIN_OUT" 2>/dev/null; then
  echo "  ✅ $(grep '^COUNT=' "$PLUGIN_OUT")，含 @deepseek-ai/dsh-client-ui-legal-mode"
  LEGAL_OK=1
else
  echo "  ❌ 界面上【看不到】法律模式插件：$(head -1 "$PLUGIN_OUT" 2>/dev/null)"
  LEGAL_OK=0
fi
rm -f "$UI_JAR" "$UI_HTML"

echo
echo "── 结果（已滤 GPU 噪音；完整日志：${LOG}）──"
grep -vE "SharedImageManager|Invalid mailbox|shared_image_manager|skia_output_device" "$LOG" \
  | grep -E "smoke|service|legal-mode|office|plugins|Error" | head -20

echo
echo "── 「重载必须发生」断言 ──"
# 逻辑抽到 scripts/check-reload-happened.sh，好让这条断言本身也能被否定测试。
if ! bash "$(dirname "$0")/check-reload-happened.sh" "$LOG"; then
  echo "  ⚠️ 完整日志：$LOG"
  rm -f "$PLUGIN_OUT"
  exit 1
fi

echo
if grep -q "\[smoke\] DSH ready" "$LOG" && grep -q "\[smoke\] page ready" "$LOG"; then
  SPAWNED=$(grep -c "\[service\] 启动随包 DSH 运行时" "$LOG" 2>/dev/null || echo 0)
  if [ "$SPAWNED" -lt 1 ]; then
    echo "  ❌ 冒烟**无效**：没有拉起随包运行时（复用了已有实例）—— 结果不可信，请检查端口是否被占"
    rm -f "$PLUGIN_OUT"
    exit 2
  fi

  # ★ 关键断言：首次启动（未经重启）界面里就能看到法律模式。
  #   这条断言是本轮事故的产物：v1.0.18 注入写盘成功、冒烟也报通过，
  #   但用户在界面上看不到法律模式 —— 因为 DSH 的插件清单是服务启动时定型的。
  #   只断言"注入成功"会给出假通过，必须断言"界面能看到"。
  if [ "${LEGAL_OK:-0}" = "1" ]; then
    echo "  ✅ 冒烟通过（真实拉起了随包运行时，exit=${CODE}；法律模式首次启动即可见）"
  else
    echo "  ❌ 冒烟未通过：法律模式在首次启动的界面上不可见 —— 完整日志：$LOG"
    rm -f "$PLUGIN_OUT"
    exit 1
  fi
else
  echo "  ❌ 冒烟未通过（exit=${CODE}）—— 完整日志：$LOG"
  echo "  ── 日志尾部 ──"
  tail -20 "$LOG" 2>/dev/null
  rm -f "$PLUGIN_OUT"
  exit 1
fi
rm -f "$PLUGIN_OUT"

echo
echo "── 测后回收 ──"
cleanup
lsof -nP -iTCP:$PORT -sTCP:LISTEN 2>/dev/null | grep -q LISTEN \
  && echo "  ⚠️ $PORT 仍被占用" || echo "  ✅ $PORT 已释放"
# 残留判据跟模式走：打包态看本次唯一标记，开发态看 dev 入口
if [ -n "$APP" ]; then RESIDUE_PAT="$TAG"; else RESIDUE_PAT="dist/main/index.js"; fi
pgrep -f "$RESIDUE_PAT" >/dev/null 2>&1 \
  && echo "  ⚠️ 仍有残留进程" || echo "  ✅ 无残留进程"
if [ "$KEEP" = "0" ]; then
  [ -n "$APP" ] || du -sh "$UD" 2>/dev/null | sed 's/^/  缓存目录: /'
else
  echo "  （--keep：现场保留在 ${UD}，日志 ${LOG}）"
fi
