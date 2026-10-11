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

/**
 * 把注释替换成**等长空格**后再匹配 —— 偏移量不变，受控区域的 index 判断照旧有效。
 *
 * ⚠️ 2026-10-11 修（判据本身的 bug，不是代码的 bug）：
 *   原来直接在原文上 `matchAll(/role:\s*'forceReload'/)`，**把注释也算进去了**。
 *   src/main/tray.ts 里有一句注释在解释「为什么**不**用 role: 'forceReload'」
 *   （它的默认快捷键 ⇧⌘R 和我们那条冲突），结果被判成「生产包会暴露」。
 *   于是从 2026-10-10 起三个平台的 CI 全红 —— 而代码一直是对的。
 *
 *   教训（对齐 release-selfcheck 第五节的排查顺序）：
 *   **先确认判据对不对，再怀疑业务代码。** 判据错了会把正确的东西判成错的。
 */
function stripComments(src) {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  let state = null; // 'line' | 'block' | "'" | '"' | '`'
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (state === 'line') {
      if (c === '\n') state = null;
      else out[i] = ' ';
      i++;
    } else if (state === 'block') {
      if (c === '*' && d === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = null; }
      else { if (c !== '\n') out[i] = ' '; i++; }
    } else if (state === "'" || state === '"' || state === '`') {
      if (c === '\\') { i += 2; continue; }
      if (c === state) state = null;
      i++;
    } else {
      if (c === '/' && d === '/') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'line'; }
      else if (c === '/' && d === '*') { out[i] = ' '; out[i + 1] = ' '; i += 2; state = 'block'; }
      else if (c === "'" || c === '"' || c === '`') { state = c; i++; }
      else i++;
    }
  }
  return out.join('');
}

const problems = [];
console.log('== 生产包开发者工具入口检查 ==');

for (const file of FILES) {
  if (!fs.existsSync(file)) continue;
  const raw = fs.readFileSync(file, 'utf8');
  // 匹配只在「去掉注释」的副本上做；偏移量与 raw 一致，所以下面用 raw 取受控区域坐标也没问题
  const src = stripComments(raw);
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
