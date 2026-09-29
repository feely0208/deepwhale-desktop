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
VERSION_FILE = os.path.join(REPO, 'dsh-runtime.version')
PKG = '@deepseek-ai/dsh'

# 数据源候选：官方 registry 优先（CI 在境外，最权威也最快），
# 失败再退到 npmmirror —— 本机实测 registry.npmjs.org 在这个网络下 TLS 握手直接超时，
# 不退一步的话「本地手动跑一次监测」永远是失败的，那这个脚本在本地就等于没有。
REGISTRIES = [
    'https://registry.npmjs.org/',
    'https://registry.npmmirror.com/',
]


def pinned_version():
    """我们钉住的版本 —— 从仓库根目录的 dsh-runtime.version 读。

    2026-09-29 之前是从 release.yml 里正则抓 `@deepseek-ai/dsh@x.y.z`；
    现在版本号已经收口到 dsh-runtime.version（见 scripts/dsh-runtime-version.js），
    release.yml 里那行变成了 `@deepseek-ai/dsh@$DSH_VERSION`，再抓就抓不到了。
    """
    version = open(VERSION_FILE, encoding='utf-8').read().strip()
    if not re.match(r'^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$', version):
        raise SystemExit(f'❌ dsh-runtime.version 里的 {version!r} 不像版本号')
    return version


def npm_meta():
    last_error = None
    for base in REGISTRIES:
        url = base + PKG.replace('/', '%2F')
        try:
            with urllib.request.urlopen(url, timeout=30) as resp:
                return json.loads(resp.read().decode('utf-8'))
        except Exception as e:  # noqa: BLE001 —— 换源重试，最后统一报错
            last_error = f'{base} → {e}'
            print(f'  （{base} 查不到，换下一个源）')
    raise SystemExit(f'❌ 所有 registry 都查不到 {PKG}：{last_error}')


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
