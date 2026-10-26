#!/usr/bin/env node
/**
 * 皮肤/主题守卫（2026-10-27，白屏事故）
 *
 * 事故：在设置页切皮肤或切深浅色 → 整屏白。根因链：
 *   ① DSH 换主题时**先删 body[data-ds-dark-theme]、再逐个写 token**；
 *   ② 我们皮肤 CSS 里「全屏浮层纯白 #ffffff !important」是无条件生效的；
 *   ③ 皮肤重注入又是「先 clear 再 add」，中间还有一段裸窗期。
 *   → 深色下的安全网只有那个会被删掉的属性，于是设置页（全屏 *_overlay）被刷白。
 *
 * 这条守卫锁住三件事，防止以后又写回去：
 *   ① apply() 必须是 swap（先注入新的，再移除旧的），不许先 clear；
 *   ② 深色浮层覆盖必须同时认 <html style="color-scheme: dark">（属性空窗期它还在）；
 *   ③ 皮肤失败必须落盘（skin-failed），并且有运行期主题一致性自检（theme-inconsistent）。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const problems = [];

// ① apply 不能先 clear
{
  const src = read('src/main/skin-manager.ts');
  const at = src.indexOf('async apply(win: BrowserWindow)');
  const 段 = at >= 0 ? src.slice(at, at + 1200) : '';
  if (at < 0) problems.push('skin-manager.ts 里找不到 apply(win)');
  if (段.includes('await this.clear(win)')) {
    problems.push('skin-manager.ts 的 apply() 又变成「先 clear 再注入」了 —— 会重新引入裸窗期（白屏）。必须 swap：先注入新 CSS，再移除旧 key。');
  }
  if (!段.includes('旧keys')) {
    problems.push('skin-manager.ts 的 apply() 没有记录旧 key 做 swap（找不到 旧keys）');
  }
  if (!src.includes("kind: 'skin-failed'")) {
    problems.push('skin-manager.ts 的皮肤失败没有落盘（找不到 kind: \'skin-failed\'）');
  }
}

// ② 深色覆盖要认 html 的 color-scheme
{
  const src = read('src/main/skin-presets.ts');
  if (!src.includes('html[style*="color-scheme: dark"]')) {
    problems.push('skin-presets.ts 缺少 html[style*="color-scheme: dark"] 兜底 —— DSH 删掉 body[data-ds-dark-theme] 的瞬间，全屏浮层会被刷成纯白（白屏事故原样复现）。');
  }
  // 无条件纯白规则必须存在对应的深色兜底：统计出现次数
  const 白 = (src.match(/#ffffff !important/g) || []).length;
  const 兜底 = (src.match(/color-scheme: dark/g) || []).length;
  if (白 > 0 && 兜底 < 2) {
    problems.push(`skin-presets.ts 里有 ${白} 处 #ffffff !important，但 color-scheme 兜底只有 ${兜底} 处 —— 疑似有规则没做深色兜底`);
  }
}

// ③ 运行期自检
{
  const src = read('src/main/index.ts');
  if (!src.includes('installThemeSanityCheck(')) {
    problems.push('index.ts 没有挂 installThemeSanityCheck（主题一致性自检）');
  }
  if (!src.includes("kind: 'theme-inconsistent'")) {
    problems.push('index.ts 的自检没有落盘（找不到 kind: \'theme-inconsistent\'）');
  }
}

if (problems.length) {
  console.error('❌ 皮肤/主题守卫失败：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log('✅ 皮肤/主题守卫通过（swap 注入 / color-scheme 兜底 / 失败落盘 / 运行期自检）');
}
