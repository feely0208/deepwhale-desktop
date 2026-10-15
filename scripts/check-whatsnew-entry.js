#!/usr/bin/env node
/**
 * 能力断言：「本版更新内容」**每个平台都有够得着的入口**（2026-10-15 用户实测后新加）
 *
 * ── 事故 ──────────────────────────────────────────────────────────
 *   用户实测：macOS 能在「帮助」菜单打开本版更新内容，**Windows 版找不到这个选项**。
 *   代码级原因（两条叠加）：
 *     ① 该入口只注册在**应用菜单**的帮助子菜单里（`buildAppMenuTemplate`）；
 *     ② 窗口设了 `autoHideMenuBar: true` → **Windows/Linux 的菜单栏默认隐藏**，
 *        要按 Alt 才出现；macOS 的菜单栏是系统级的，不受影响 → 所以只有 mac 看得见。
 *   更糟的是：**托盘右键菜单里过去没有这一项** —— 而托盘右键恰恰是 Windows 用户
 *   唯一够得着的地方（用户原话：「win 版只能在后台小窗口右键显示一些功能，但没有这个」）。
 *
 * ── 判据（静态，读源码；不依赖任何平台）────────────────────────────
 *   ① **托盘菜单**必须包含「本版更新内容…」→ `onShowWhatsNew`（Windows/Linux 的主入口）；
 *   ② `onShowWhatsNew` 在整个 shell 里至少被注册 **2 处**（应用菜单 + 托盘），
 *      即**不允许只依赖那条会被 autoHideMenuBar 藏起来的菜单栏**；
 *   ③ 不能把托盘里那一项放进 `showDevMenu` 之类的条件分支（默认用户必须看得到）。
 *
 * 用法：node scripts/check-whatsnew-entry.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const TRAY = path.join(REPO, 'src', 'main', 'tray.ts');
const src = fs.readFileSync(TRAY, 'utf-8');

/** 取出 buildMenuTemplate（托盘菜单）的函数体 */
function trayMenuBody() {
  const start = src.indexOf('export function buildMenuTemplate');
  if (start < 0) return null;
  const end = src.indexOf('\n}', start);
  return src.slice(start, end > 0 ? end : src.length);
}

const problems = [];
const body = trayMenuBody();
if (body === null) {
  problems.push('找不到 buildMenuTemplate（托盘菜单）—— 结构变了，先确认代码');
} else {
  if (!/本版更新内容/.test(body) || !/onShowWhatsNew/.test(body)) {
    problems.push(
      '**托盘菜单里没有「本版更新内容…」**\n' +
        '       → Windows/Linux 的应用菜单被 autoHideMenuBar 藏着（要按 Alt），托盘右键是用户\n' +
        '         唯一够得着的入口；缺了它，用户在 win 版就"找不到本版更新内容"（2026-10-15 实测）。',
    );
  }
  // ③ 不许放进 dev-only 分支
  const lines = body.split('\n');
  const idx = lines.findIndex((l) => /本版更新内容/.test(l));
  if (idx >= 0) {
    const before = lines.slice(0, idx).join('\n');
    const lastSpread = before.lastIndexOf('...(');
    const lastSpreadEnd = before.lastIndexOf(')');
    if (lastSpread > lastSpreadEnd) {
      problems.push('托盘菜单里的「本版更新内容…」被放进了 `...(条件)` 展开里 —— 默认用户必须能直接看到它');
    }
  }
}

// ⚠️ 代码里是 `a.onShowWhatsNew?.()` 写法：正则要把可选链容进来（否则恒为 0）
const registrations = (src.match(/onShowWhatsNew\??\.?\(\)/g) || []).length;
if (registrations < 2) {
  problems.push(
    `onShowWhatsNew 只注册了 ${registrations} 处（需要 ≥2：应用菜单 + 托盘）\n` +
      '       → 只有一个入口时，一旦那个入口在某个平台不可达（菜单栏被藏、托盘图标不可见），\n' +
      '         用户就彻底打不开本版更新内容。',
  );
}

if (problems.length) {
  console.error('❌ 「本版更新内容」入口守卫失败：\n');
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  console.log(`✅ 入口守卫通过（托盘菜单有「本版更新内容…」· onShowWhatsNew 注册 ${registrations} 处 ≥2）`);
}
