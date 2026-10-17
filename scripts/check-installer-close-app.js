#!/usr/bin/env node
/**
 * 守卫：安装器必须能**自己**关掉正在运行的旧版本（2026-10-15 用户实测后新加）
 *
 * ── 事故 ──────────────────────────────────────────────────────────
 *   用户截图：装到一半弹「DeepWhale Desktop 无法关闭。请手动关闭它，然后单击重试以继续。」
 *   根因两条并存：
 *     ① 我们的应用**关窗是最小化到托盘**（src/main/window.ts：closeToTray && !isQuitting() → hide()）；
 *     ② 安装器用的是 electron-builder 默认的 `_CHECK_APP_RUNNING`，只做**温和**关闭
 *        （allowOnlyOneInstallerInstance.nsh：`KILL_PROCESS ... 0` = 不带 /F 的 taskkill）
 *        → 被我们忽略 → 循环重试 → 最后要求用户手动关。
 *   覆盖官方钩子 `customCheckAppRunning` 才能改成"先温和、再强杀整棵树"。
 *   必须带 `/T`：应用会拉起 DSH 子进程（Electron-as-Node），不杀子树会占着文件、
 *   安装卡在"复制文件"。
 *
 * ── 判据（全部读**代码行**，注释不算；本文件自己就踩过"注释被 grep 到"的坑）──
 *   ① build/installer.nsh 存在；
 *   ② 定义了 `!macro customCheckAppRunning`（否则等于没覆盖，默认温和逻辑仍生效）；
 *   ③ 代码里有强制且带子树参数的杀进程（`taskkill` + `/F` + `/T`）；
 *   ④ 代码里**不**引用 `$pid` / `GetProcessInfo`（这两个只在"未覆盖该宏"的分支里定义）；
 *   ⑤ electron-builder.yml 的 `nsis.include` 指向该文件（不挂上去等于没写）。
 *
 * 用法：node scripts/check-installer-close-app.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const NSH = path.join(REPO, 'build', 'installer.nsh');
const YML = path.join(REPO, 'electron-builder.yml');

/** 去掉 NSIS 注释（行首 `;` 或 `#`）与行尾注释，只留代码 */
function codeLines(text) {
  return text
    .split('\n')
    .map((l) => l.replace(/;.*$/, '').trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
}

const problems = [];
if (!fs.existsSync(NSH)) {
  problems.push('缺少 build/installer.nsh（安装器关不掉运行中的旧版，用户会看到"无法关闭，请手动关闭"）');
}
const nshText = fs.existsSync(NSH) ? fs.readFileSync(NSH, 'utf-8') : '';
const code = codeLines(nshText).join('\n');

// ⚠️ 必须带词边界：`customCheckAppRunningX` 也会被前缀正则放过（实测反例没红）
if (nshText && !/!macro\s+customCheckAppRunning\b/.test(code)) {
  problems.push(
    'installer.nsh 没有定义 `!macro customCheckAppRunning`\n' +
      '       → electron-builder 会继续用它默认的**温和**关闭逻辑（不带 /F），\n' +
      '         而我们的应用关窗是"最小化到托盘"、根本不理 → 用户被要求手动关进程。',
  );
}
if (nshText && !/taskkill[\s\S]{0,80}\/F[\s\S]{0,40}\/T|taskkill[\s\S]{0,80}\/T[\s\S]{0,40}\/F/.test(code)) {
  problems.push(
    '没有"强制 + 含子树"的杀进程命令（需要 `taskkill /F /T`）\n' +
      '       → 不带 /F：托盘应用不会退；不带 /T：它拉起的 DSH 子进程仍占着文件，安装会卡住。',
  );
}
if (nshText && /\$pid|GetProcessInfo/.test(code)) {
  problems.push(
    'installer.nsh 引用了 `$pid` / `GetProcessInfo` —— 这两个只在"未覆盖 customCheckAppRunning"\n' +
      '       的模板分支里才会被定义（allowOnlyOneInstallerInstance.nsh 的 `!ifmacrondef`），\n' +
      '       覆盖该宏后引用它们会**编译不过**。',
  );
}

let yml = null;
try {
  yml = require('js-yaml').load(fs.readFileSync(YML, 'utf-8'));
} catch (e) {
  problems.push('读不了 electron-builder.yml：' + e.message);
}
const include = yml && yml.nsis && yml.nsis.include;
if (include !== 'build/installer.nsh') {
  problems.push(
    `electron-builder.yml 的 nsis.include = ${JSON.stringify(include)}（应为 "build/installer.nsh"）\n` +
      '       → 文件写了但没挂上去，等于没写。',
  );
}

if (problems.length) {
  // 2026-10-17：workflow 命令必须写 stdout —— 之前用 console.error(stderr)，
  // GitHub 不解析，CI 红了却看不到原因（Windows step17 因此查了两轮）。
  if (process.env.GITHUB_ACTIONS === 'true') {
    for (const pr of problems) console.log('::error::' + String(pr).slice(0, 900));
  }
  console.error('❌ 安装器"关掉旧版"守卫失败：\n');
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  const kills = (code.match(/taskkill[^\n]*\/F[^\n]*\/T/g) || []).length;
  console.log(`✅ 安装器关进程守卫通过（customCheckAppRunning 已覆盖 · 强杀整树 ${kills} 次 · nsis.include 已挂）`);
}
