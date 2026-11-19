#!/usr/bin/env node
/**
 * 随包 DSH 补丁：Windows「在文件管理器中显示」传的是 file:// URL，导致 explorer /select 失败（2026-11-19）
 *
 * 现象：Windows 用户点文件卡片上的「显示文件位置」→「无法显示文件位置，请重试」。
 * 已排除配置面：`$DSH_HOME/cordis.patch.yml` 里 nativeOpen: true 确实生效（--dump-config 验证过）。
 *
 * 根因（读上游源码定位）：
 *   @deepseek-ai/dsh-native-command 的 explorerTarget() 把路径转成 file:///C:/… 的 URL 再交给
 *   `explorer.exe /select,<target>`。Windows 资源管理器的 /select 只认**文件系统路径**，
 *   不认 file URL；macOS 走 `open -R <path>` 所以不受影响 —— 这就是"只有 Windows 老毛病"的原因。
 *
 * 做法：装完运行时就地改成传原始 Windows 路径（spawn 的参数数组本身就处理引号，
 *       普通路径对 explorer 的 open 与 /select 两种用法都成立）。
 *
 * 纪律：幂等、缺文件不报错（未装运行时的环境跑 build 不该红）、改过打标记便于排查。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh-native-command', 'lib', 'index.js');
const MARK = '/* dwh-patch: explorer 用原始路径 */';

function main() {
  if (!fs.existsSync(FILE)) {
    console.log('[dsh-native-path] 未安装随包运行时，跳过（打包前会再跑一次）');
    return;
  }
  const src = fs.readFileSync(FILE, 'utf-8');
  if (src.includes(MARK)) {
    console.log('[dsh-native-path] 已是打过补丁的版本，跳过');
    return;
  }
  const re = /function explorerTarget\(windowsPath\) \{\n\treturn pathToFileURL\(windowsPath, \{ windows: true \}\)\.href[^\n]*\n\}/;
  if (!re.test(src)) {
    console.error('[dsh-native-path] ❌ 未匹配到 explorerTarget 的已知实现（上游可能已改），请人工检查：' + FILE);
    process.exitCode = 1;
    return;
  }
  const next = src.replace(
    re,
    `function explorerTarget(windowsPath) {\n\t${MARK}\n\t// 上游原来返回 file:/// URL；explorer.exe /select 只认文件系统路径，URL 会失败。\n\treturn windowsPath;\n}`,
  );
  fs.writeFileSync(FILE, next, 'utf-8');
  console.log('[dsh-native-path] ✅ 已修正 explorerTarget：改为传原始路径（Windows /select 可用）');
}

main();
