#!/usr/bin/env bash
# 把插件注册进 DSH profile（**光把目录丢进 plugins/ 是不生效的**）。
#
# 2026-10-10 踩到的坑：
#   我把 dsh-shell-video-preview 拷进 dsh-home/plugins/ 就以为完事了 →
#   重启后毫无反应 ✗。查下来：
#     plugins/dsh-shell-canvas 在 profiles/deepwhale/package.json 里出现 115 次，
#     而新插件 0 次 —— **它压根不在加载清单里**。
#   插件要生效，必须两处都登记：
#     ① dependencies:  "@deepwhale-cn/<name>": "link:<dsh-home>/plugins/<dir>"
#     ② dsh.profile.bundles: 加入包名
#
# 用法：bash scripts/register-plugin-to-profile.sh <插件目录名> <包名>
set -euo pipefail
DIR="${1:?用法: register-plugin-to-profile.sh <目录名> <包名>}"
NAME="${2:?用法: register-plugin-to-profile.sh <目录名> <包名>}"
HOME_DIR="${DSH_HOME:-$HOME/Library/Application Support/DeepWhale Desktop/dsh-home}"
P="$HOME_DIR/profiles/deepwhale/package.json"
[ -f "$P" ] || { echo "找不到 profile：$P" >&2; exit 1; }

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
print("[注册] " + name)
print("[注册]   link -> " + os.path.join(home, "plugins", d))
print("[注册]   bundles 现 %d 个" % len(b))
PY
echo "[注册] ⚠️ 需要**完全退出应用再打开**才会加载"
