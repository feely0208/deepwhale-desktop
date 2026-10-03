#!/usr/bin/env node
/**
 * Windows 快捷方式自愈的回归自检（可在 macOS/Linux 上跑）
 *
 * 为什么要有它：真正的现象只在 Windows 上出现，而我们平时在 macOS 开发 ——
 * 至少要把**判定逻辑**和"非 Windows 必须完全不动"这两件事钉死：
 *   1. 什么算"指歪了"（Temp / old-install / 不是当前 exe）
 *   2. 什么算"正常"（正好等于当前 exe）
 *   3. 非 Windows、开发态：一次都不该去碰快捷方式
 *
 * 用法：node scripts/test-win-shortcut.js（或 npm run test:win-shortcut）
 */
const assert = require('assert');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { isShortcutTargetStale, repairWindowsShortcuts } = require(path.join(
  REPO,
  'dist/main/windows-shortcut.js',
));

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log('  ✅ ' + m);
};
const bad = (m) => {
  fail += 1;
  console.error('  ❌ ' + m);
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (e) {
    bad(name + ' —— ' + (e instanceof Error ? e.message : String(e)));
  }
};

const EXE = 'C:\\Users\\zhang\\AppData\\Local\\Programs\\DeepWhale Desktop\\DeepWhale Desktop.exe';

console.log('Windows 快捷方式判定逻辑：');
check('正好指向当前 exe → 不动', () => {
  assert.strictEqual(isShortcutTargetStale(EXE, EXE), false);
});
check('大小写不同也算正常（Windows 路径不区分大小写）', () => {
  assert.strictEqual(isShortcutTargetStale(EXE.toUpperCase(), EXE), false);
});
check('用户实测的 %TEMP%\\…\\old-install\\ → 必须修', () => {
  const stale =
    'C:\\Users\\zhang\\AppData\\Local\\Temp\\nstE4B2.tmp\\old-install\\DeepWhale Desktop.exe';
  assert.strictEqual(isShortcutTargetStale(stale, EXE), true);
});
check('旧安装目录（App 被移动/重装到别处）→ 必须修', () => {
  assert.strictEqual(
    isShortcutTargetStale('C:\\Program Files\\DeepWhale Desktop\\DeepWhale Desktop.exe', EXE),
    true,
  );
});
check('空目标 → 必须修', () => {
  assert.strictEqual(isShortcutTargetStale('', EXE), true);
});
check('指向别的程序 → 必须修（我们只把目标改回当前 exe）', () => {
  assert.strictEqual(isShortcutTargetStale('C:\\Windows\\notepad.exe', EXE), true);
});

(async () => {
  console.log('\n平台守卫（非 Windows / 开发态必须完全不动作）：');
  const onMac = await repairWindowsShortcuts({ platform: 'darwin', isPackaged: true });
  if (onMac.checked === 0 && onMac.repaired === 0) ok('非 Windows：不检查、不修改（' + onMac.skipped + '）');
  else bad('非 Windows 竟然动了快捷方式：' + JSON.stringify(onMac));

  const dev = await repairWindowsShortcuts({ platform: 'win32', isPackaged: false });
  if (dev.checked === 0 && dev.repaired === 0) ok('Windows 开发态：不动（' + dev.skipped + '）');
  else bad('Windows 开发态竟然动了快捷方式：' + JSON.stringify(dev));

  const notExe = await repairWindowsShortcuts({
    platform: 'win32',
    isPackaged: true,
    exePath: '/Applications/DeepWhale Desktop.app/Contents/MacOS/DeepWhale Desktop',
  });
  if (notExe.checked === 0 && /exe/.test(notExe.skipped)) ok('execPath 不是 .exe 时跳过（' + notExe.skipped + '）');
  else bad('execPath 判断失效：' + JSON.stringify(notExe));

  console.log(`\n[win-shortcut-test] ${fail === 0 ? '全部通过 ✅' : '失败 ' + fail + ' 项 ❌'}（${pass} 通过）`);
  process.exit(fail === 0 ? 0 : 1);
})();
