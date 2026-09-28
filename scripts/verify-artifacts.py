#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
对**用户实际下载到的那个文件**做断言 —— 拆开安装包，检查里面该有的东西在不在。

为什么必须有这个（2026-09-28 的事故）：
    1.0.19 发出去的包，office 技能激活失败：
        Error: ENOENT, …dsh-skill-office/assets/office-docx/SKILL.md not found in app.asar
    原因是打包时一条 `-name '*.md'` 的裁剪规则把运行时按路径读取的
    **资产**当成了"依赖文档"删掉，三平台共缺 6 个 SKILL.md。

    而这个包**从外面看一切正常**：能装、能启动、法律模式也在。
    当时的自检只跑了 `dsh --version` / `dsh --help`，它们证明不了插件能激活，
    所以给了一个假通过。

    结论：验证必须落在**成品安装包里到底有什么**，而不是构建日志。

用法：
    python3 scripts/verify-artifacts.py --version 1.0.20            # 从 CDN 下载并检查
    python3 scripts/verify-artifacts.py --version 1.0.20 --dir /path # 用本地已下载的文件
    python3 scripts/verify-artifacts.py --version 1.0.20 --only dmg

依赖：拆 .exe 需要 py7zr（可选；缺了会跳过并明确告警，不会假装通过）。
      dmg 用 macOS 自带 hdiutil，deb 用自带 ar/tar，都不需要额外装东西。
"""
import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile

# Windows runner 的控制台默认是 cp1252，本脚本要打中文，
# 不强制 UTF-8 会直接 UnicodeEncodeError（2026-09-28 在 windows-latest 上实测踩到）。
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

CDN = "https://dl.deepwhale.org.cn/"

# 运行时按路径读取的资产 —— 少一个，对应插件就激活失败。
# 这份清单是事故后逐个核对出来的，不是猜的。
REQUIRED = [
    "dsh-runtime/node_modules/@deepseek-ai/dsh-skill-office/assets/office-docx/SKILL.md",
    "dsh-runtime/node_modules/@deepseek-ai/dsh-skill-office/assets/office-xlsx/SKILL.md",
    "dsh-runtime/node_modules/@deepseek-ai/dsh-skill-office/assets/office-pptx/SKILL.md",
    "dsh-runtime/node_modules/@deepseek-ai/dsh-agent-preset/skills/editing-cordis-compositions/SKILL.md",
    "dsh-runtime/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/SKILL.md",
    "dsh-runtime/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-composition-reference/SKILL.md",
]

# 壳自己的随包载荷 —— 少任何一个，对应的功能在用户那里就是"没有"。
# 2026-09-28：用户在 Windows 上反馈「里面没有法律模式」，所以把这些也纳入断言，
# 先排除"包本身就缺载荷"这一层。
SHELL_ASSETS = [
    "/legal-mode/plugin/lib/client.js",          # 法律模式的客户端插件
    "/legal-mode/plugin/package.json",
    "/office-runtime/runtime.json",               # office 载荷
    "/bundled-plugins/dsh-cn-compliance",         # 随包插件（合规）
    "/bundled-plugins/dsh-cn-doc-formatter",      # 随包插件（公文排版）
    "/dist/main/legal-mode.js",                   # 注入逻辑本身（在 app.asar 内）
]

TARGETS = {
    "dmg": "DeepWhale-Desktop-{v}-arm64.dmg",
    "deb": "DeepWhale-Desktop-{v}-amd64.deb",
    "exe": "DeepWhale-Desktop-{v}-x64-Setup.exe",
}


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def fetch(name, version, local_dir):
    """返回本地文件路径；本地目录里没有就从 CDN 下。"""
    fn = TARGETS[name].format(v=version)
    if local_dir:
        p = os.path.join(local_dir, fn)
        if os.path.exists(p):
            return p
        return None
    p = os.path.join(tempfile.gettempdir(), "verify-art-" + fn)
    if os.path.exists(p) and os.path.getsize(p) > 1024 * 1024:
        print(f"    复用已下载的 {fn}")
        return p
    print(f"    下载 {fn} …")
    r = run(["curl", "-sS", "-o", p, "--max-time", "1800", CDN + fn])
    if r.returncode != 0 or not os.path.exists(p):
        return None
    print(f"    下载完成 {os.path.getsize(p) / 1048576:.1f} MB")
    return p


def asar_paths(asar_file):
    """列出 app.asar 内所有路径（asar = 8 字节头 + pickled JSON 头 + 拼接的数据）。"""
    with open(asar_file, "rb") as f:
        head = f.read(8)
        size = struct.unpack("<I", head[4:8])[0]
        hdr = f.read(size)
        js = struct.unpack("<I", hdr[4:8])[0]
        idx = json.loads(hdr[8 : 8 + js].decode("utf-8"))

    out = []

    def walk(node, prefix):
        for key, meta in node.get("files", {}).items():
            p = prefix + "/" + key
            if "files" in meta:
                walk(meta, p)
            else:
                out.append(p)

    walk(idx, "")
    return out


def scan_shell_assets(root):
    """在解包树里按后缀实搜壳载荷。

    不要猜路径（`<root>/resources/...`）—— 各平台布局不同：
    deb 解出来是 `<root>/opt/Deep Whale/resources/...`，exe 是 `<root>/resources/...`，
    dmg 是挂载点里的 `<App>.app/Contents/Resources/...`。
    第一版就是猜的，于是对 deb 报了一堆假缺失。
    """
    found = set()
    for base, dirs, files in os.walk(root):
        for name in list(dirs) + list(files):
            rel = os.path.join(base, name).replace(os.sep, "/")
            for a in SHELL_ASSETS:
                if rel.endswith(a):
                    found.add(a)
    return found


def find_asar(root):
    hits = []
    for base, _dirs, files in os.walk(root):
        for f in files:
            if f == "app.asar":
                hits.append(os.path.join(base, f))
    return hits


def extract_dmg(path, work):
    mnt = os.path.join(work, "mnt")
    os.makedirs(mnt, exist_ok=True)
    r = run(["hdiutil", "attach", "-nobrowse", "-readonly", "-mountpoint", mnt, path])
    if r.returncode != 0:
        raise RuntimeError("hdiutil attach 失败: " + r.stderr.strip()[:200])
    try:
        apps = [d for d in os.listdir(mnt) if d.endswith(".app")]
        if not apps:
            raise RuntimeError("dmg 里没有 .app")
        app = os.path.join(mnt, apps[0])
        plist = os.path.join(app, "Contents", "Info.plist")
        ver = run(["plutil", "-extract", "CFBundleShortVersionString", "raw", plist]).stdout.strip()
        src = os.path.join(app, "Contents", "Resources", "app.asar")
        if not os.path.exists(src):
            # 别只丢一句 ENOENT —— 把实际结构打出来，否则根本猜不出是脚本错了还是包错了
            print(f"    [诊断] {app} 下没有 Contents/Resources/app.asar，实际结构：")
            for sub in ("Contents", "Contents/Resources"):
                d = os.path.join(app, sub)
                if os.path.isdir(d):
                    print(f"      {sub}/: {sorted(os.listdir(d))[:20]}")
            raise RuntimeError("dmg 里的 .app 没有 Contents/Resources/app.asar")
        # ⚠️ **必须先把 asar 拷出挂载点，再卸载**。
        #    原来这里直接返回挂载点里的路径，而 finally 会立刻 hdiutil detach ——
        #    调用方拿到的是一个已经失效的路径，报 ENOENT，
        #    看起来像"包里没有 app.asar"，实际上是自己把盘卸了（2026-09-28 实测踩到，
        #    手工验证时是"先解析再卸载"所以没暴露）。
        asar = os.path.join(work, "app.asar")
        shutil.copy2(src, asar)
        # ⚠️ 必须在 detach 之前扫载荷 —— 卸载后这个目录就没了
        found = scan_shell_assets(app)
        return ver, asar, app, found
    finally:
        run(["hdiutil", "detach", mnt, "-quiet"])


def extract_deb(path, work):
    import io

    data = open(path, "rb").read()
    assert data[:8] == b"!<arch>\n", "不是 deb（ar 头不对）"
    off = 8
    payload = None
    while off + 60 <= len(data):
        hdr = data[off : off + 60]
        nm = hdr[0:16].decode().strip().rstrip("/")
        sz = int(hdr[48:58].decode().strip())
        start = off + 60
        if nm.startswith("data.tar"):
            payload = data[start : start + sz]
        off = start + sz + (sz % 2)
    if payload is None:
        raise RuntimeError("deb 里没有 data.tar.*")
    tar = os.path.join(work, "data.tar")
    open(tar, "wb").write(payload)
    root = os.path.join(work, "root")
    os.makedirs(root, exist_ok=True)
    # data.tar.xz / .gz / .zst 都靠 tar 自己识别
    r = run(["tar", "xf", tar, "-C", root])
    if r.returncode != 0:
        raise RuntimeError("解 data.tar 失败: " + r.stderr.strip()[:200])
    asars = find_asar(root)
    if not asars:
        raise RuntimeError("deb 里没找到 app.asar")
    asar = asars[0]
    return "?", asar, root, scan_shell_assets(root)


def extract_exe(path, work):
    try:
        import py7zr
    except ImportError:
        raise RuntimeError("缺 py7zr（pip install py7zr）—— 跳过 exe，不假装通过")
    buf = open(path, "rb").read()
    sig = b"7z\xbc\xaf\x27\x1c"
    idx = buf.rfind(sig)
    if idx < 0:
        raise RuntimeError("exe 里找不到 7z 头（NSIS 结构变了？）")
    arc = os.path.join(work, "app.7z")
    open(arc, "wb").write(buf[idx:])
    with py7zr.SevenZipFile(arc, "r") as z:
        names = z.getnames()
        want = [n for n in names if n.endswith("app.asar")]
        if not want:
            raise RuntimeError("7z 里没有 app.asar")
        # ⚠️ 壳载荷（legal-mode / bundled-plugins / office-runtime）在 app.asar **之外**，
        #    只解 app.asar 的话它们不在磁盘上，扫描会报「缺 5 个壳载荷」——
        #    那是**假缺失**（第一版就这么误报过）。这里按需把这几项也解出来：
        #    只取小的（legal-mode 132K + bundled-plugins 152K + runtime.json），
        #    不整包倒 100MB 的 office-runtime。
        for n in names:
            if (n.startswith("resources/legal-mode")
                    or n.startswith("resources/bundled-plugins")
                    or n == "resources/office-runtime/runtime.json"):
                want.append(n)
        z.extract(path=work, targets=want)
    asar = os.path.join(work, "resources", "app.asar")
    if not os.path.exists(asar):
        hits = find_asar(work)
        if not hits:
            raise RuntimeError("解出来的 app.asar 找不到")
        asar = hits[0]
    return "?", asar, work, scan_shell_assets(work)


EXTRACTORS = {"dmg": extract_dmg, "deb": extract_deb, "exe": extract_exe}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--version", required=True)
    ap.add_argument("--dir", default=None, help="本地已下载安装包的目录（不给就从 CDN 下）")
    ap.add_argument("--only", nargs="*", default=list(TARGETS))
    args = ap.parse_args()

    print(f"== 成品安装包自检 · 壳 {args.version} ==")
    print(f"   数据源：{args.dir or 'CDN ' + CDN}")
    failures = []
    results = []

    for name in args.only:
        print(f"\n── {name.upper()} ──")
        work = tempfile.mkdtemp(prefix=f"verify-{name}-")
        try:
            path = fetch(name, args.version, args.dir)
            if not path:
                results.append((name, "取不到文件", "-", "-"))
                failures.append(f"{name}: 取不到安装包")
                continue
            ver, asar, _root, disk_found = EXTRACTORS[name](path, work)
            paths = asar_paths(asar)
            missing = [r for r in REQUIRED if not any(p.endswith("/" + r) for p in paths)]
            # 壳自己的载荷可能在 app.asar 内，也可能在 app.asar 外的 Resources 下
            shell_missing = []
            for a in SHELL_ASSETS:
                in_asar = any(p.endswith(a) for p in paths)
                if not (in_asar or a in disk_found):
                    shell_missing.append(a)
            skills = [p for p in paths if p.endswith("SKILL.md")]
            print(f"    app.asar 内文件数 {len(paths)}；SKILL.md {len(skills)} 个；包内版本 {ver}")
            if ver not in ("?", args.version):
                failures.append(f"{name}: 包内版本是 {ver}，期望 {args.version}")
                print(f"    ❌ 版本不符：{ver} ≠ {args.version}")
            if missing:
                failures.append(f"{name}: 缺 {len(missing)} 个运行时资产")
                print(f"    ❌ 缺 {len(missing)} 个运行时资产：")
                for m in missing:
                    print(f"         {m}")
            else:
                print("    ✅ 6 个运行时资产齐备（office 三项 + agent-preset 三项）")
            if shell_missing:
                failures.append(f"{name}: 缺 {len(shell_missing)} 个壳载荷")
                print(f"    ❌ 缺 {len(shell_missing)} 个壳载荷（法律模式/office/随包插件）：")
                for m in shell_missing:
                    print(f"         {m}")
            else:
                print("    ✅ 壳载荷齐备（法律模式客户端插件 + office + 随包插件 + 注入逻辑）")
            results.append((name, ver, len(paths), len(skills)))
        except Exception as e:  # noqa: BLE001 - 自检脚本，任何异常都要变成明确的失败
            print(f"    ❌ 拆包失败：{e}")
            failures.append(f"{name}: {e}")
        finally:
            shutil.rmtree(work, ignore_errors=True)

    print("\n── 汇总 ──")
    for name, ver, total, skills in results:
        print(f"  {name:4s} 版本 {ver:8s} 文件 {total:>6} SKILL.md {skills}")
    if failures:
        print("\n❌ 未通过：")
        for f in failures:
            print("   " + f)
        return 1
    print("\n✅ 三平台成品包内的运行时资产齐备")
    return 0


if __name__ == "__main__":
    sys.exit(main())
