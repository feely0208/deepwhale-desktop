#!/usr/bin/env bash
# 把**开发版**的视频预览插件装进桌面端实际加载的位置（并自动备份旧版）。
#
# 和 install-canvas-plugin-to-app.sh 同一个道理：应用加载的是
#   $DSH_HOME/plugins/dsh-shell-video-preview
# 而我们在改的是开发目录，两边不是同一份文件 —— 改完必须装进去。
#
# 用法：bash scripts/install-video-preview-plugin-to-app.sh
#   装完**必须完全退出应用再打开**（宿主半边要重新组合 loader 行；
#   只按 ⌘R 不够，DSH 服务是常驻内存的）。
set -uo pipefail
HOME_DIR="${DSH_HOME:-$HOME/Library/Application Support/DeepWhale Desktop/dsh-home}"
TARGET="$HOME_DIR/plugins/dsh-shell-video-preview"
SRC="$(cd "$(dirname "$0")/.." && pwd)/shell-plugins/dsh-shell-video-preview"

[ -d "$SRC" ] || { echo "找不到插件源码：${SRC}" >&2; exit 1; }
[ -d "$HOME_DIR/plugins" ] || { echo "找不到应用的插件目录：$HOME_DIR/plugins" >&2; exit 1; }

echo "[装] 来源: $SRC"
echo "[装] 目标: $TARGET"
if [ -d "$TARGET" ]; then
  BAK="$TARGET.bak-$(date +%m%d-%H%M%S)"
  cp -R "$TARGET" "$BAK"
  echo "[装] 旧版已备份 → $BAK"
fi
rm -rf "$TARGET"
cp -R "$SRC" "$TARGET"

# ── 自检：这七项任一为假，插件就不会生效 ─────────────────────────────
FAIL=0
if ! python3 - "$TARGET" <<'PY'
import json, os, sys
t = sys.argv[1]
pkg = json.load(open(os.path.join(t, 'package.json'), encoding='utf-8'))
ok = True
def chk(label, cond):
    global ok
    print(('  \u2713 ' if cond else '  \u2717 ') + label)
    ok = ok and cond
chk('exports["./client"] 指到 lib/client.js',
    (pkg.get('exports') or {}).get('./client') == './lib/client.js')
chk('dsh.client.platform == "web"',
    (pkg.get('dsh') or {}).get('client', {}).get('platform') == 'web')
chk('dsh.bundle.patch 指到 cordis.patch.yml',
    (pkg.get('dsh') or {}).get('bundle', {}).get('patch') == './cordis.patch.yml')
chk('宿主半边 lib/index.js 存在', os.path.isfile(os.path.join(t, 'lib', 'index.js')))
chk('组合层 cordis.patch.yml 存在', os.path.isfile(os.path.join(t, 'cordis.patch.yml')))
src = open(os.path.join(t, 'lib', 'client.js'), encoding='utf-8').read()
chk('client.js 是 ModuleLoader 包体', 'window.__ModuleLoader__.load' in src)
chk('client.js 走带 key 的槽位注册', 'ctx.slots.register' in src and 'key: BODY_ID' in src)
sys.exit(0 if ok else 1)
PY
then
  FAIL=1
fi

# 宿主半边是 ESM：出现 require( 就是 bug（上一代画布插件踩过 "require is not defined"）。
REQ="$(grep -n 'require(' "$TARGET/lib/index.js" 2>/dev/null | grep -vE ':[0-9]+: *(//|\*|/\*)' || true)"
if [ -n "$REQ" ]; then echo "  ✗ 宿主半边出现 require(：$REQ"; FAIL=1; else echo "  ✓ 宿主半边无 require("; fi

echo "[装] 完成 · 插件版本 $(python3 -c "import json;print(json.load(open('$TARGET/package.json', encoding='utf-8'))['version'])")"
[ $FAIL -eq 0 ] || { echo "[装] 自检未全过，见上面的 ✗" >&2; exit 1; }
echo "[装] 下一步：**完全退出应用再打开**（不是 ⌘R）。"
