#!/usr/bin/env node
/**
 * 移除 NSIS 内置的「检查应用是否运行」步骤（2026-10-29）
 *
 * 为什么：
 *   1.0.63 的 Windows 预览包在**没有任何 DeepWhale 进程**的机器上仍然弹
 *   「DeepWhale Desktop 无法关闭」——实测 tasklist 只有安装器自己。
 *   内置检测（allowOnlyOneInstallerInstance.nsh 的 _CHECK_APP_RUNNING）在
 *   某些环境下会误判，且 MessageBox 让用户无法继续。
 *
 * 我们已经有更可靠的替代：build/installer.nsh 的 customInit / customUnInit
 * 会在检查之前用 taskkill /F /T 结束旧进程（安装器与卸载器都会跑）。
 *
 * 做法：在 electron-builder 的模板里删掉 3 处 `!insertmacro CHECK_APP_RUNNING`
 * （installSection.nsh 两处、uninstaller.nsh 一处），幂等。
 *
 * 位置：打包前执行（release.yml 的 Package 步骤之前）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const targets = [
  'node_modules/app-builder-lib/templates/nsis/installSection.nsh',
  'node_modules/app-builder-lib/templates/nsis/uninstaller.nsh',
];

let changed = 0;
for (const rel of targets) {
  const file = path.join(root, rel);
  if (!fs.existsSync(file)) {
    console.log(`[nsis-patch] 跳过（不存在）: ${rel}`);
    continue;
  }
  const before = fs.readFileSync(file, 'utf-8');
  // 只删调用行，保留宏定义（其它地方可能引用）
  const after = before.replace(/^[ \t]*!insertmacro CHECK_APP_RUNNING[ \t]*\r?\n/gm, '');
  if (after !== before) {
    fs.writeFileSync(file, after);
    changed += 1;
    console.log(`[nsis-patch] 已移除 CHECK_APP_RUNNING 调用: ${rel}`);
  } else {
    console.log(`[nsis-patch] 无需改动: ${rel}`);
  }
}
if (changed === 0) console.log('[nsis-patch] 模板已是目标状态');
