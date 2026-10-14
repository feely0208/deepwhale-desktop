#!/usr/bin/env node
/**
 * 离线守卫：右栏「全屏」不能透底/白屏，同时**不能把主界面的辉光做没了**（2026-10-14）
 *
 * 用户事故（截图）：点 DSH 右侧栏的「全屏」（⤢ / ⇧⌘↩）后，界面与下层会话正文叠在一起
 * （用户原话「最大化后界面都成一坨」）。根因：全屏面板自己没有背景，它下面的框架列与
 * 文档预览 iframe 都用 `--dsw-alias-bg-base` 上色，而我们的皮肤把这个 token 打薄成
 * 浅色 transparent / 深色半透明；1.0.55 的"做实"只写了 `[class*="_overlay"]` 子树。
 *
 * 用户同时给了硬前提（两次强调）：
 *   · 「**全屏后遮盖住辉光没关系**，只要不爆白屏就行」（所以覆盖不是问题）；
 *   · 「之前出过：最大化改好了，但白屏了，导致那一版更新是失败的」
 *     （所以**主界面那层的 token 必须保持薄**，否则辉光就没了 —— 那是另一个事故）。
 *
 * 本守卫直接读**编译产物**里生成出来的皮肤 CSS（`presetBackgroundCss('deepseek-blue')`），
 * 断言两件事同时成立：
 *   ① 右栏全屏的面 → 实底（浅 `#ffffff` / 深 `#0b1018`，alpha 必须 = 1），且仍保留
 *      1.0.55 那条 `[class*="_overlay"]` 做实（不许回归）
 *   ② 主界面那层 → 仍然薄（浅 transparent / 深 0.42）—— 辉光必须还在
 */
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist', 'main', 'skin-presets.js');
if (!fs.existsSync(dist)) {
  console.error('❌ 找不到编译产物 dist/main/skin-presets.js —— 请先 npm run build');
  process.exit(1);
}
const { presetBackgroundCss } = require(dist);

const problems = [];
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail ? `（${detail}）` : ''}`);
};

const css = presetBackgroundCss('deepseek-blue');
check('皮肤 CSS 能生成', typeof css === 'string' && css.length > 200);
if (typeof css !== 'string') {
  console.error('❌ 皮肤 CSS 生成失败，后续断言无法进行');
  process.exit(1);
}

/** 从 CSS 里取某条选择器对应的声明块（取全部匹配并拼接，便于跨深浅两段查） */
function blocksFor(selectorFragment, opts = {}) {
  const out = [];
  const re = /([^{}]*\{[^{}]*\})/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const blk = m[1];
    if (!blk.includes(selectorFragment)) continue;
    const isDark = blk.includes('data-ds-dark-theme');
    if (opts.theme === 'light' && isDark) continue;   // 浅色段：排除深色覆盖
    if (opts.theme === 'dark' && !isDark) continue;
    out.push(blk);
  }
  return out.join('\n');
}

/** 把 #rrggbb / rgba() 换算成 alpha（判"实底"用） */
function alphaOf(color) {
  const hex = /^#([0-9a-f]{6})$/i.exec(color);
  if (hex) return 1;
  const rgba = /^rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*([\d.]+)\s*\)$/i.exec(color);
  if (rgba) return Number(rgba[1]);
  return null;
}

// ── ① 右栏全屏：面板本身必须实底（**浅色段单独查** —— 深色段同选择器会掩盖浅色缺失）──
const fullscreen = blocksFor("[data-sidebar-right-panel='fullscreen']", { theme: 'light' });
check('浅色段存在右栏全屏的皮肤规则', fullscreen !== '');
const lightFsBg = /background:\s*(#[0-9a-f]{6}|rgba\([^)]*\))\s*!important/i.exec(fullscreen);
check('浅色段：全屏面板本身被赋予了实底', lightFsBg !== null);
if (lightFsBg) {
  const a = alphaOf(lightFsBg[1]);
  check('浅色段：全屏面板底色 alpha = 1（不透底）', a === 1, `实际 alpha=${String(a)}（${lightFsBg[1]}）`);
}
const fsToken = /--dsw-alias-bg-base:\s*(#[0-9a-f]{6}|rgba\([^)]*\))\s*!important/i.exec(fullscreen);
check('浅色段：全屏子树内的 --dsw-alias-bg-base 也被做实（预览 iframe 用它上色）', fsToken !== null);
if (fsToken) {
  const a = alphaOf(fsToken[1]);
  check('浅色段：全屏子树 token 的 alpha = 1', a === 1, `实际 alpha=${String(a)}（${fsToken[1]}）`);
}
// 深色下也要有（且必须是实底 #0b1018）
check(
  '深色主题下同样有全屏做实规则（实底 #0b1018）',
  /body\[data-ds-dark-theme\][^{]*\[data-sidebar-right-panel='fullscreen'\]\s*\{[^}]*background:\s*#0b1018\s*!important/i.test(
    css,
  ),
);

// ── ② 1.0.55 的浮层做实不许回归 ──
check(
  '仍保留 [class*="_overlay"] 做实（1.0.55 的修复不许被这次改动挤掉）',
  /\[class\*="_overlay"\][^{]*\{[^}]*--dsw-alias-bg-base:\s*#ffffff\s*!important/i.test(css),
);
check(
  '深色下同样保留 _overlay 做实',
  /data-ds-dark-theme\][^{]*\[class\*="_overlay"\][^{]*\{[^}]*--dsw-alias-bg-base:\s*#0b1018\s*!important/i.test(
    css,
  ),
);

// ── ③ 主界面那层必须仍然"薄"（辉光还在 —— 别为了防透底把辉光做没了）──
check(
  '浅色主界面 token 仍是 transparent（辉光透出来）',
  /--dsw-alias-bg-base:\s*transparent\s*!important/i.test(css),
);
const darkMain = /body\[data-ds-dark-theme\][^{]*\{[^}]*--dsw-alias-bg-base:\s*(rgba\([^)]*\))/i.exec(css);
check('深色主界面 token 仍是半透明', darkMain !== null);
if (darkMain) {
  const a = alphaOf(darkMain[1]);
  check('深色主界面 token alpha < 1（辉光透得上来）', typeof a === 'number' && a < 1, `alpha=${String(a)}`);
}

// ── ④ 不能把"停靠（push）"状态也做成实底 —— 那会吃掉侧栏本来的半透明观感 ──
check(
  '没有对 push（停靠）状态做全局实底',
  !/data-sidebar-right-panel='push'[^{]*\{[^}]*background:/i.test(css),
);

if (problems.length) {
  console.error('❌ 右栏全屏皮肤守卫失败：');
  problems.forEach((p) => console.error('  · ' + p));
  process.exitCode = 1;
} else {
  console.log(
    '✅ 右栏全屏皮肤守卫通过（全屏面 alpha=1 · 深/浅都有 · 浮层做实未回归 · 主界面 token 仍薄·辉光还在）',
  );
}
