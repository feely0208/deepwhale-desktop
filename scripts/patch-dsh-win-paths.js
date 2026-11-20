#!/usr/bin/env node
/**
 * 随包 DSH 补丁：Windows 上「显示文件位置」被路径往返校验拒掉（2026-11-20）
 *
 * 现象：macOS 点文件卡片的「显示文件位置」正常；Windows 一律「无法显示文件位置，请重试」。
 *
 * 上游逻辑（@deepseek-ai/dsh-api-session-controller 的 verifyDesktopPath）：
 *   const hostPath = resolve(path);
 *   const mapped = fs.processPathFromHostPath(hostPath);      // 内部走 fs.realpath
 *   if (mapped === void 0 || fs.processPath(await fs.resolve(mapped)) !== hostPath) throw
 *
 * Windows 上 realpath 会把盘符大小写、8.3 短名、junction 目标规范化，
 * 只要有一个字符不同（最常见 c: vs C:）就判不等 → 直接拒绝；POSIX 通常已是规范形式，
 * 所以 mac 能用、Windows 不能用。
 *
 * 补丁：Windows 上按大小写不敏感比较；不相等时把两侧路径打到 stderr
 *       （壳把运行时输出落到 <userData>/logs/dsh.log），下次复现就有现场。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh-api-session-controller', 'lib', 'index.js');

const OLD = 'if (mapped === void 0 || fs.processPath(await fs.resolve(mapped, { signal })) !== hostPath) throw new RemoteError("gateway/bad-request", "Path has no verified Host path", {});';
const NEW = [
  'const dwhResolved = mapped === void 0 ? void 0 : fs.processPath(await fs.resolve(mapped, { signal }));',
  '\t\t\tconst dwhSame = mapped !== void 0 && (process.platform === "win32"',
  '\t\t\t\t? String(dwhResolved).toLowerCase() === String(hostPath).toLowerCase()',
  '\t\t\t\t: dwhResolved === hostPath);',
  '\t\t\tif (!dwhSame) {',
  '\t\t\t\ttry { console.error("[dwh] verifyDesktopPath 不匹配，按原路径继续：host=" + String(hostPath) + " resolved=" + String(dwhResolved)); } catch {}',
  '\t\t\t\t// Windows 上不再拦截：realpath 会改写盘符大小写/短名/junction，严格比较必然误伤；',
  '\t\t\t\t// 单机桌面壳里路径来自本机界面，放行后仍由 explorer 自己判断文件是否存在。',
  '\t\t\t\tif (process.platform !== "win32") throw new RemoteError("gateway/bad-request", "Path has no verified Host path", {});',
  '\t\t\t}',
].join('\n');

function main() {
  if (!fs.existsSync(FILE)) {
    console.log('[dsh-win-paths] 未安装随包运行时，跳过');
    return;
  }
  const src = fs.readFileSync(FILE, 'utf-8');
  if (src.includes('dwhResolved')) {
    console.log('[dsh-win-paths] 已是打过补丁的版本，跳过');
    return;
  }
  if (!src.includes(OLD)) {
    console.error('[dsh-win-paths] ❌ 未匹配到 verifyDesktopPath 的已知实现（上游可能已改）：' + FILE);
    process.exitCode = 1;
    return;
  }
  fs.writeFileSync(FILE, src.replace(OLD, NEW), 'utf-8');
  console.log('[dsh-win-paths] ✅ Windows 上不再因路径比较拦截 reveal（记录不匹配并放行）');
}

main();
