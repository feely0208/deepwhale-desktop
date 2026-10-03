#!/bin/bash
# 本机打包（自动挂国内镜像）
#
# 为什么需要：electron / electron-builder 的下载源在国内经常超时
# （2026-10-03 实测：直连官方源 600s 超时；挂 npmmirror 一次过）。
# 用法：scripts/dist-local.sh [额外的 electron-builder 参数]
#   scripts/dist-local.sh                       # 默认打 mac（当前架构）
#   scripts/dist-local.sh --mac --arm64 --x64   # 两个架构
#   scripts/dist-local.sh --win --x64           # Windows
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"
echo "使用镜像：ELECTRON_MIRROR=$ELECTRON_MIRROR"
echo "          ELECTRON_BUILDER_BINARIES_MIRROR=$ELECTRON_BUILDER_BINARIES_MIRROR"
./node_modules/.bin/electron-builder "$@"
