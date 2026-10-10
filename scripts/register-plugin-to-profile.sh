#!/usr/bin/env bash
# 把插件完整注册进 DSH profile（**三步缺一不可**）。
#
# 2026-10-10 连踩三次才摸清：把插件目录拷进 dsh-home/plugins/ 之后，
# 还要三步它才会被加载：
#   ① profiles/<profile>/package.json 的 dependencies:
#        "@deepwhale-cn/<name>": "link:<dsh-home>/plugins/<dir>"
#   ② 同一文件的 dsh.profile.bundles: 加入包名
#   ③ profiles/<profile>/node_modules/@deepwhale-cn/<name> → 软链到插件目录
#      （**实际加载走的是这个软链**；②只是声明。缺 ③ 就完全没反应。）
#
# 用法：bash scripts/register-plugin-to-profile.sh <插件目录名> <包名> [profile]
set -euo pipefail
DIR="${1:?用法: register-plugin-to-profile.sh <目录名> <包名> [profile]}"
NAME="${2:?用法: register-plugin-to-profile.sh <目录名> <包名> [profile]}"
PROFILE="${3:-deepwhale}"
HOME_DIR="${DSH_HOME:-$HOME/Library/Application Support/DeepWhale Desktop/dsh-home}"
P="$HOME_DIR/profiles/$PROFILE/package.json"
PLUGIN="$HOME_DIR/plugins/$DIR"
[ -f "$P" ] || { echo "找不到 profile：$P" >&2; exit 1; }
[ -d "$PLUGIN" ] || { echo "找不到插件目录：$PLUGIN" >&2; exit 1; }

python3 - "$P" "$HOME_DIR" "$DIR" "$NAME" <<'PY'
import json, sys, shutil, time, os
p, home, d, name = sys.argv[1:5]
shutil.copy(p, p + ".bak-" + time.strftime("%m%d-%H%M"))
j = json.load(open(p, encoding="utf-8"))
j.setdefault("dependencies", {})[name] = "link:" + os.path.join(home, "plugins", d)
b = j.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if name not in b:
    if "@deepwhale-cn/dsh-shell-canvas" in b:
        b.insert(b.index("@deepwhale-cn/dsh-shell-canvas") + 1, name)
    else:
        b.append(name)
json.dump(j, open(p, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("[注册] ① dependencies link ✓")
print("[注册] ② bundles 启用清单 ✓（现 %d 个）" % len(b))
PY

# ③ 软链（实际加载走这里）
SCOPE="$HOME_DIR/profiles/$PROFILE/node_modules/@deepwhale-cn"
mkdir -p "$SCOPE"
ln -sfn "$PLUGIN" "$SCOPE/$(basename "$3")"
echo "[注册] ③ node_modules 软链 ✓ -> $SCOPE/$(basename "$3")"
echo "[注册] ⚠️ 需要**完全退出应用再打开**才会加载"
