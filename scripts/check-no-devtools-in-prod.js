#!/usr/bin/env node
/**
 * 断言**生产客户端里没有开发者工具入口**。
 *
 * ── 为什么要（2026-09-29，用户当场按 Ctrl+Shift+I 打开给我看）──────────
 * `lawyer/main.js` 的「视图」菜单里挂着 `{ role: 'toggleDevTools' }`，
 * 而且是 `Menu.setApplicationMenu(...)` **全局生效** —— 用户端窗口同样有。
 * 于是任何人在律师端按 Ctrl+Shift+I 就能打开开发者工具面板，
 * 直接在控制台改 `localStorage["legal-mode.lawyer"]`，把实名核验绕过去。
 *
 * 这是生产客户端绝不该有的入口。用户的原话是「这个能留在客户端吗」——
 * 留不得。
 *
 * 规则：
 *   · 菜单里出现 `role: 'toggleDevTools'` / `'forceReload'` 时，
 *     它必须写在 `DEV_MENU_ITEMS` 这个受开关控制的声明之内；
 *   · 不允许出现程序化的 `openDevTools(` 调用。
 *
 * 用法：node scripts/check-no-devtools-in-prod.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const FILES = [
  path.join(REPO, 'lawyer', 'main.js'),
  path.join(REPO, 'src', 'main', 'tray.ts'),
  path.join(REPO, 'src', 'main', 'window.ts'),
  path.join(REPO, 'src', 'main', 'index.ts'),
];

const problems = [];
console.log('== 生产包开发者工具入口检查 ==');

for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');
  const rel = path.relative(REPO, file);

  // 受允许的区域：DEV_MENU_ITEMS 那个三目表达式
  let allowedFrom = -1;
  let allowedTo = -1;
  const at = src.indexOf('const DEV_MENU_ITEMS');
  if (at >= 0) {
    allowedFrom = at;
    // 到这条语句结束（以 `: [];` 收尾）
    const end = src.indexOf(': [];', at);
    allowedTo = end >= 0 ? end + 5 : src.length;
  }

  const checkRole = (role) => {
    const re = new RegExp(`role:\\s*'${role}'`, 'g');
    for (const m of src.matchAll(re)) {
      const inside = allowedFrom >= 0 && m.index >= allowedFrom && m.index <= allowedTo;
      if (!inside) problems.push(`${rel}: 菜单里有 role: '${role}' 且不在受控开关内（生产包会暴露）`);
    }
  };
  checkRole('toggleDevTools');
  checkRole('forceReload');

  if (/\.openDevTools\s*\(/.test(src)) {
    problems.push(`${rel}: 出现了 openDevTools( 调用 —— 生产包不该程序化打开开发者工具`);
  }

  const roleCount = (src.match(/role:\s*'toggleDevTools'/g) ?? []).length;
  if (roleCount === 0) console.log(`  ✅ ${rel}：无开发者工具菜单项`);
  else if (allowedFrom >= 0) console.log(`  ✅ ${rel}：出现在受控开关内（生产不显示）`);
}

console.log('');
if (problems.length > 0) {
  console.error('❌ 未通过：');
  for (const p of problems) console.error('   ' + p);
  console.error(
    '\n   生产客户端出现开发者工具，等于把 localStorage 里的核验记录交给用户改 ——' +
    '\n   按 Ctrl+Shift+I 就能绕过实名核验。请把这类菜单项放进受 app.isPackaged 控制的开关里。\n',
  );
  process.exit(1);
}
console.log('✅ 通过：生产包不含开发者工具入口');
