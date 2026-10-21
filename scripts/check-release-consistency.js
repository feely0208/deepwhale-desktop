#!/usr/bin/env node
/**
 * 发版一致性守卫（2026-10-21）
 *
 * 为什么需要：1.0.61 发版时踩到三处"版本号各说各话"：
 *   ① `package-lock.json` 还停在 1.0.60（package.json 已是 1.0.61）；
 *   ② 主站下载页仍是 v1.0.60 / 律师端 v0.1.11 / 套装 v1.0.28 ——
 *      `bump-site-version.js` 当时对 download.html 误判"无需改动"
 *      （分组正则不认带 id 的 dlx-group、且徽标替换被 oldV 前置条件挡住）；
 *   ③ Pages 站律师端 tag 写成了壳的 v1.0.60（产物在 lawyer-v0.1.12）。
 *   三处都属于"发之前看不出来、发之后用户下错/404"。
 *
 * 判据：
 *   ① package-lock.version === package.json.version
 *   ② docs/index.html 的 DESKTOP_VERSION === v<version>
 *   ③ 主站 assets/site.js 的 DESKTOP_VERSION === v<version>
 *   ④ 主站 download.html「深鲸桌面」分组的徽标与平台数都是 v<version>
 *
 * 用法：node scripts/check-release-consistency.js [--main-dir <主站目录>]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const mainDirArg = args.indexOf('--main-dir');
const mainDir =
  mainDirArg !== -1 && args[mainDirArg + 1]
    ? args[mainDirArg + 1]
    : '/Users/mac/DeepSeek Harness/site-migration/deepwhale.org.cn';

const problems = [];
const ok = [];
const skipped = [];
const hasMainSite = fs.existsSync(mainDir);

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const version = String(pkg.version || '');
if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`package.json 的 version 不是 x.y.z：${version}`);
const want = `v${version}`;

// ① package-lock
try {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf-8'));
  if (lock.version !== version) {
    problems.push(`package-lock.json 的 version 是 ${String(lock.version)}，应为 ${version}（跑 npm install --package-lock-only）`);
  } else {
    ok.push(`package-lock = ${version}`);
  }
} catch (error) {
  problems.push(`读不到 package-lock.json：${error.message}`);
}

// ② Pages 站常量
try {
  const pages = fs.readFileSync(path.join(root, 'docs', 'index.html'), 'utf-8');
  const m = pages.match(/DESKTOP_VERSION\s*=\s*'v([\d.]+)'/);
  if (m === null) problems.push('docs/index.html 里找不到 DESKTOP_VERSION');
  else if (`v${m[1]}` !== want) problems.push(`docs/index.html DESKTOP_VERSION = v${m[1]}，应为 ${want}`);
  else ok.push(`Pages DESKTOP_VERSION = ${want}`);
} catch (error) {
  problems.push(`读不到 docs/index.html：${error.message}`);
}

// ③ 主站 site.js 常量（CI runner 上没有主站目录 → 跳过，本机发版必须过）
try {
  if (!hasMainSite) throw Object.assign(new Error('主站目录不存在，跳过'), { skip: true });
  const site = fs.readFileSync(path.join(mainDir, 'assets', 'site.js'), 'utf-8');
  const m = site.match(/DESKTOP_VERSION\s*=\s*'v([\d.]+)'/);
  if (m === null) problems.push('主站 assets/site.js 里找不到 DESKTOP_VERSION');
  else if (`v${m[1]}` !== want) problems.push(`主站 site.js DESKTOP_VERSION = v${m[1]}，应为 ${want}`);
  else ok.push(`主站 DESKTOP_VERSION = ${want}`);
} catch (error) {
  if (error.skip) skipped.push('主站 site.js（无主站目录）');
  else problems.push(`读不到主站 assets/site.js：${error.message}`);
}

// ④ 主站下载页「深鲸桌面」分组的徽标 / 平台数
try {
  if (!hasMainSite) throw Object.assign(new Error('主站目录不存在，跳过'), { skip: true });
  const html = fs.readFileSync(path.join(mainDir, 'download.html'), 'utf-8');
  const blocks = [...html.matchAll(/<div class="dlx-group"[^>]*>([\s\S]*?)(?=<div class="dlx-group"[^>]*>|$)/g)];
  const shell = blocks.map((b) => b[1]).find((body) => /<h3>深鲸桌面<\/h3>/.test(body));
  if (shell === undefined) {
    problems.push('download.html 里找不到「深鲸桌面」分组（页面结构变了？）');
  } else {
    const chips = [...shell.matchAll(/class="dlx-chip ver">v([\d.]+)</g)].map((m) => m[1]);
    const cnt = [...shell.matchAll(/class="cnt">v([\d.]+)/g)].map((m) => m[1]);
    const bad = [...chips, ...cnt].filter((v) => v !== version);
    if (bad.length > 0) {
      problems.push(`download.html「深鲸桌面」分组有 ${bad.length} 处徽标不是 ${want}：${[...new Set(bad)].map((v) => `v${v}`).join('、')}`);
    } else if (chips.length === 0) {
      problems.push('download.html「深鲸桌面」分组里没找到任何 dlx-chip ver 徽标');
    } else {
      ok.push(`下载页桌面分组徽标 = ${want}（${chips.length} 处卡片 + ${cnt.length} 处分组标题）`);
    }
  }
} catch (error) {
  if (error.skip) skipped.push('主站 download.html（无主站目录）');
  else problems.push(`读不到主站 download.html：${error.message}`);
}

if (problems.length > 0) {
  console.error('❌ 发版一致性守卫失败：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log(`✅ 发版一致性通过（${version}）：${ok.join(' · ')}`);
  if (skipped.length > 0) console.log(`   （跳过：${skipped.join('、')}）`);
}
