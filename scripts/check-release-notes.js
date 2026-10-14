#!/usr/bin/env node
/**
 * 离线守卫：这个版本要发出去，更新说明必须齐（2026-10-14）
 *
 * 为什么需要：我们的口径是「面向用户的更新说明以 `assets/whatsnew.json` 为准」
 * （App 内「本版更新内容」+ 官网 + 更新弹窗同源）。但它是**手写的** ——
 * 版本号一改、忘了写条目，用户那边就是"这版没说改了啥"，而且发布流程不会红。
 * 1.0.56 这一版尤其不能漏：里面有好几条是**用户报上来的问题**（Office 能力失效、
 * 全屏透底、更新停不下来、安装目录），不写清楚他根本不知道已经修了。
 *
 * 判据（对着 package.json 的 version 查）：
 *   ① whatsnew.json 里有这一版，且有 date / title
 *   ② items 非空，每条 kind 在允许集合里、text 有实质内容（不是占位符）
 *   ③ CHANGELOG.md 里有 `## [<version>]` 段（开发者向的记录）
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = String(pkg.version || '');
const problems = [];

if (version === '') problems.push('package.json 里没有 version');

const notes = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'whatsnew.json'), 'utf-8'));
const entry = notes.versions?.[version];
if (entry === undefined) {
  problems.push(
    `assets/whatsnew.json 里没有 ${version} 的条目\n` +
      '  → 用户侧「本版更新内容」、更新弹窗、官网都读它；缺了就等于"这版没说改了啥"。',
  );
} else {
  if (typeof entry.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) {
    problems.push(`${version} 的 date 不合法（应为 YYYY-MM-DD）：${String(entry.date)}`);
  }
  if (typeof entry.title !== 'string' || entry.title.trim().length < 6) {
    problems.push(`${version} 的 title 太短或缺失：${String(entry.title)}`);
  }
  const items = Array.isArray(entry.items) ? entry.items : [];
  if (items.length === 0) problems.push(`${version} 的 items 是空的`);
  const KINDS = new Set(['feat', 'fix', 'perf', 'docs', 'security']);
  items.forEach((it, i) => {
    if (!KINDS.has(it?.kind)) problems.push(`${version} items[${i}] 的 kind 非法：${String(it?.kind)}`);
    const text = typeof it?.text === 'string' ? it.text.trim() : '';
    if (text.length < 10) problems.push(`${version} items[${i}] 的 text 太短（像占位符）：${text}`);
    if (/TODO|待补|xxx/i.test(text)) problems.push(`${version} items[${i}] 里还有占位文字：${text}`);
  });
  // 用户报上来的问题必须有"修复"口径的交代（本版至少要有 fix 条目）
  const hasFix = items.some((it) => it?.kind === 'fix');
  if (!hasFix) {
    problems.push(`${version} 的条目里一条 fix 都没有 —— 这版修的是用户报的问题，必须有"修复"口径的说明`);
  }
  // 平台相关的能力别写成全平台（安装目录只有 Windows 有）
  const winOnly = items.some((it) => /安装目录/.test(String(it?.text ?? '')));
  if (winOnly && !items.some((it) => /Windows/.test(String(it?.text ?? '')))) {
    problems.push(`${version} 提到「安装目录」但没说这是 Windows 的能力（避免全平台误解）`);
  }
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf-8');
if (!new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(changelog)) {
  problems.push(`CHANGELOG.md 里没有 ## [${version}] 段`);
}

if (problems.length) {
  console.error('❌ 更新说明守卫失败：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log(
    `✅ 更新说明守卫通过（${version}：whatsnew 条目完整且有 fix 口径 · CHANGELOG 有对应段落）`,
  );
}
