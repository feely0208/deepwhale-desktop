#!/usr/bin/env node
/**
 * check-menu-i18n.js —— 校验应用菜单不会漏出英文标签
 *
 * ── 为什么需要这个脚本 ──────────────────────────────────────────────
 * Electron 的菜单有两层语言来源，很容易配出「半中半英」：
 *
 *   1. **`label`** —— 你自己写的文字，用什么语言就是什么语言。
 *   2. **`role`**  —— 只负责**行为与快捷键**；不写 `label` 时，
 *      Electron 显示的是它**内置的英文标签**（Undo / Redo / Cut / Copy /
 *      Paste / Select All / Minimize / Zoom / Close / Quit / About /
 *      Services / Hide / Hide Others / Show All / Front…）。
 *
 * 于是出现两种真实踩过的形态：
 *   · 律师端**完全没设菜单** → Electron 用内置默认菜单 → Windows 顶部
 *     整条是英文（File / Edit / View / Window / Help）。
 *   · 深鲸壳设了菜单，顶级写了中文，子项只写 role → 子项全是英文，
 *     形成「顶级中文、子项英文」的割裂。
 *
 * 这两种都是**静态可查**的，所以用脚本卡住，不靠人肉 review。
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node scripts/check-menu-i18n.js
 *
 * 退出码：0 = 通过；1 = 有问题
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 需要检查的文件：各自把菜单写在不同地方 */
const TARGETS = [
  { file: 'src/main/tray.ts', mustSetMenu: false, note: '深鲸壳菜单模板' },
  { file: 'lawyer/main.js', mustSetMenu: true, note: '律师端菜单' },
];

/** 允许出现在 label 里的非中文：品牌名、版本号、型号等 */
const ALLOWED_NON_CHINESE = /^[\s0-9A-Za-z·．.\-—…+:/（）()《》、，,]*$/;

const problems = [];

for (const target of TARGETS) {
  const full = path.join(ROOT, target.file);
  if (!fs.existsSync(full)) {
    problems.push(`${target.file}：文件不存在`);
    continue;
  }
  const src = fs.readFileSync(full, 'utf8');
  const isTs = target.file.endsWith('.ts');

  // ── ① 必须显式设置菜单，否则会回落到 Electron 的英文默认菜单 ──
  if (target.mustSetMenu && !/Menu\.setApplicationMenu\s*\(/.test(src)) {
    problems.push(
      `${target.file}：没有调用 Menu.setApplicationMenu() —— ` +
        `Electron 会回落到内置默认菜单，标签全是英文（File / Edit / View …）`,
    );
  }

  // ── ② 每个 role 都必须配 label，否则显示英文 ──
  // 匹配 { role: 'undo' } / { role: 'undo' as const } / { role: "undo", ... }
  const ROLES_WITHOUT_LABEL = isTs
    ? /\{\s*role:\s*'([a-zA-Z]+)'\s*as\s*const\s*\}/g
    : /\{\s*role:\s*['"]([a-zA-Z]+)['"]\s*\}/g;

  const lines = src.split('\n');
  lines.forEach((line, i) => {
    ROLES_WITHOUT_LABEL.lastIndex = 0;
    let m;
    while ((m = ROLES_WITHOUT_LABEL.exec(line)) !== null) {
      problems.push(
        `${target.file}:${i + 1}：role '${m[1]}' 没有配 label —— ` +
          `Electron 会显示内置英文标签。` +
          (isTs ? `改为 { role: '${m[1]}' as const, label: '中文' }` : `改为 { role: '${m[1]}', label: '中文' }`),
      );
    }
  });

  // ── ③ label 不得是纯英文（允许品牌名/版本号等白名单）──
  const LABEL_RE = /label:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g;
  lines.forEach((line, i) => {
    LABEL_RE.lastIndex = 0;
    let m;
    while ((m = LABEL_RE.exec(line)) !== null) {
      const text = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\$\{[^}]*\}/g, '');
      if (!text.trim()) continue;
      if (!/[\u4e00-\u9fa5]/.test(text) && !ALLOWED_NON_CHINESE.test(text)) {
        problems.push(`${target.file}:${i + 1}：label「${text}」不是中文，菜单会中英混杂`);
      }
    }
  });

  console.log(`  检查 ${target.file}（${target.note}）`);
}

console.log('');
if (problems.length === 0) {
  console.log('✅ 通过：菜单项均为中文，且 role 都配了 label。');
  process.exit(0);
}
console.log(`❌ 发现 ${problems.length} 处问题：`);
for (const p of problems) console.log('  · ' + p);
console.log('');
console.log('背景：Electron 的 role 只给行为与快捷键，标签要自己写。');
console.log('      不写 label → 显示内置英文；整个菜单不设 → 全是英文默认菜单。');
process.exit(1);
