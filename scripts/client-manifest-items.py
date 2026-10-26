#!/usr/bin/env python3
"""从 dsh web 首屏 HTML 里解析**客户端插件清单**（冒烟断言用）。

为什么单独抽成一个脚本（2026-10-26）：
  DSH 的客户端清单不是一条 URL，而是**被切成很多段** `plugins/??a,b,c…` compose URL
  —— 单段有字节上限（见 @deepseek-ai/dsh-client-modules 里的 MAX_COMBO_URL_BYTES）。
  旧版冒烟脚本用 `re.search()` **只取第一段**，于是排在后面段里的插件永远看不到：
  法律模式 `@deepseek-ai/dsh-client-ui-legal-mode` 正是落在后面，
  结果这条断言从 2026-10-10 上线起**从未绿过**（41 次全红、COUNT 恒为 57），
  每天两封错误邮件，还掩盖了真正的上游变更。
  → 必须把全页所有段合并去重后再断言，并且这段逻辑要能被单独测试
    （scripts/test-client-manifest-items.js 会喂人造 HTML 做否定测试）。

输出（stdout，一行一个）：
  COUNT=<去重后的插件数>
  LEGAL=YES|NO        # 是否含 @deepseek-ai/dsh-client-ui-legal-mode
  NO_MANIFEST         # 页面里根本没有 plugins/?? 段（鉴权页/空页/界面没起来）

用法：
  python3 scripts/client-manifest-items.py <首屏 HTML> [--dump <清单落盘路径>]
"""

import re
import sys


def extract_items(html: str) -> list[str]:
    """合并页面里**所有** `plugins/??…` 段，返回去重排序后的包名清单。"""
    segments = re.findall(r'plugins/\?\?([^"]+)"', html)
    items: list[str] = []
    for seg in segments:
        items += [x.split('/client.js')[0] for x in seg.split(',') if x]
    return sorted(set(items))


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print('用法：client-manifest-items.py <html> [--dump <path>]', file=sys.stderr)
        return 2
    path = argv[1]
    dump = None
    if '--dump' in argv:
        i = argv.index('--dump')
        if i + 1 < len(argv):
            dump = argv[i + 1]
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            html = fh.read()
    except Exception:
        print('NO_MANIFEST')
        return 3

    items = extract_items(html)
    if not items:
        print('NO_MANIFEST')
        return 3

    print('COUNT=%d' % len(items))
    print('LEGAL=%s' % ('YES' if any('legal' in i for i in items) else 'NO'))
    if dump:
        try:
            with open(dump, 'w', encoding='utf-8') as fh:
                fh.write('\n'.join(items))
        except Exception:
            pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv))
