#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
比对「我们随包的 DSH 版本」与「npm 上上游的 latest」，判断有没有新版本。

为什么要有（2026-09-29，用户的原话）：
    「为什么每次官方升级都是我告诉你的呢，你为什么没有第一时间抓到这个信息来告诉我呢？」
    实情是根本没在做监测。官方 0.2.0-rc.2 发布当天（09-29 17:56），
    是用户从公众号看到告诉我，我才去查 npm —— 而我们随包还停在 0.1.7-rc.2。

    而深鲸壳是"随包一个 DSH 运行时"的产品形态，**上游每个版本都可能改变我们依赖的机制**：
    本轮就被 0.1.7 废弃 `.agent-presets` 坑过一次 —— 法律模式预设因此从来没进过花名册，
    三平台的选择器里都看不到它。

用法：
    python3 scripts/check-upstream-dsh.py                  # 人看：打印对比结果
    python3 scripts/check-upstream-dsh.py --github-output   # CI 用：写 changed/pinned/latest/... 到 $GITHUB_OUTPUT

数据源：公共 npm registry，不需要任何凭据。
"""
import argparse
import json
import os
import re
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELEASE_YML = os.path.join(REPO, '.github', 'workflows', 'release.yml')
PKG = '@deepseek-ai/dsh'


def pinned_version():
    """我们钉住的版本 —— 从 release.yml 里 `npm install "@deepseek-ai/dsh@x.y.z"` 那行取。"""
    text = open(RELEASE_YML, encoding='utf-8').read()
    m = re.search(r'@deepseek-ai/dsh@([0-9][^\s"]*)', text)
    if not m:
        raise SystemExit('❌ 没能在 release.yml 里找到钉住的 DSH 版本')
    return m.group(1)


def npm_meta():
    url = 'https://registry.npmjs.org/' + PKG.replace('/', '%2F')
    with urllib.request.urlopen(url, timeout=30) as resp:
        return json.loads(resp.read().decode('utf-8'))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument(
        '--github-output',
        action='store_true',
        help='把结果写成 key=value 追加到 $GITHUB_OUTPUT（GitHub Actions 用）',
    )
    args = ap.parse_args()

    pinned = pinned_version()
    meta = npm_meta()
    latest = meta['dist-tags']['latest']
    times = meta.get('time', {})
    published = str(times.get(latest, '?'))[:19]
    recent = list(meta.get('versions', {}).keys())[-6:]
    changed = pinned != latest

    print(f'  我们随包：{pinned}')
    print(f'  npm latest：{latest}（{published}）')
    print(f'  最近发布：{"、".join(recent)}')
    print(('  → 有新版本，需要评估' if changed else '  → 已是最新'))

    if args.github_output:
        out = os.environ.get('GITHUB_OUTPUT')
        if not out:
            raise SystemExit('❌ --github-output 需要 GITHUB_OUTPUT 环境变量')
        with open(out, 'a', encoding='utf-8') as f:
            f.write(f'changed={"true" if changed else "false"}\n')
            f.write(f'pinned={pinned}\n')
            f.write(f'latest={latest}\n')
            f.write(f'published={published}\n')
            f.write(f'recent={"、".join(recent)}\n')

    return 0


if __name__ == '__main__':
    sys.exit(main())
