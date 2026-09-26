#!/usr/bin/env python3
"""把若干文件打成一个 zip，**文件名按 UTF-8 正确标记**。

为什么不直接用 `zip` 命令：macOS 自带的 Info-ZIP **不写 UTF-8 标志位**，
于是 `安装说明.txt` 这种中文名在中央目录里是一串裸字节 —— macOS 自己解压没问题
（它默认按 UTF-8 猜），但 Windows 的解压工具会按 CP437 解释，**显示成乱码**。
Python 的 `zipfile` 对非 ASCII 名字会自动置位 UTF-8 标志，各平台一致。

用法：
    python3 zip_utf8.py <输出.zip> <文件1> [文件2 ...]

文件按 basename 存进 zip 顶层（不带目录），保持"解压出来直接看到文件"的形态。
"""
import os
import sys
import zipfile


def main() -> int:
    if len(sys.argv) < 3:
        print("usage: zip_utf8.py <out.zip> <file>...", file=sys.stderr)
        return 2
    out = sys.argv[1]
    files = sys.argv[2:]
    if os.path.exists(out):
        os.remove(out)
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for f in files:
            if not os.path.isfile(f):
                print(f"zip_utf8: missing file {f}", file=sys.stderr)
                return 1
            # arcname 用 basename → 顶层平铺，不带暂存目录
            zf.write(f, arcname=os.path.basename(f))
    return 0


if __name__ == "__main__":
    sys.exit(main())
