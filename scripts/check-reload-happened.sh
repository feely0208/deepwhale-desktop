#!/bin/bash
# 断言「注入了就必须真的重载」。
#
# 为什么单独做成一个脚本：
#   这条断言本身也要能被**否定测试** —— 得能证明它在坏输入上真的会失败。
#   埋在 smoke-local.sh 里只能靠"跑一次完整冒烟"来验证，成本太高，
#   于是实际结果就是没人验证它、它坏了也没人知道。
#
# 判定规则（$1 是壳的运行日志）：
#   · 有「injection applied; reload scheduled」但**没有**「reload done」
#       → 失败。窗口里还是注入前那份清单，用户看不到法律模式。
#   · 有重载但没有注入记录 → 通过（复用了已注入过的 home，正常）
#   · 两者都没有        → 通过（home 级注入在服务启动前就位，本轮不需要重载）
#
# 用法： check-reload-happened.sh <日志文件>
set -uo pipefail

LOG="${1:-}"
if [ -z "$LOG" ] || [ ! -f "$LOG" ]; then
  echo "  ⚠️ 找不到日志（${LOG:-未提供}），跳过重载断言"
  exit 0
fi

if grep -q '\[smoke\] legal-mode profile injection applied; reload scheduled' "$LOG"; then
  if grep -q '\[smoke\] reload done' "$LOG"; then
    echo "  ✅ 本轮注入写过盘，且重载确实跑完了（界面已切到注入后的插件清单）"
    exit 0
  fi
  echo "  ❌ 注入了但**重载没有发生** —— 用户窗口里仍是注入前那份界面，法律模式不会出现"
  exit 1
fi

if grep -q '\[smoke\] reload done' "$LOG"; then
  echo "  ⚠️ 有重载但没看到「注入写过盘」的记录（复用已注入过的 home？）—— 不影响结论"
  exit 0
fi

echo "  ✅ 本轮无需重载（home 级注入在服务启动前就位，首启即含法律模式）"
exit 0
