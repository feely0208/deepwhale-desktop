#!/usr/bin/env node
/**
 * 守卫：桌面端「手机连接」面板必须"接线齐全"
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这条守卫防的是"看起来有、其实没接上"（本仓库踩过：插件写了但没进随包清单、
 * 命令写了但没注册 IPC）。手机连接面板是整条链路的入口，缺一处就是"用户点不开"：
 *   ① 面板页面存在，且引用了自己的 preload；
 *   ② preload 暴露 start/stop/rotate/status（少一个按钮就废）；
 *   ③ 主进程注册了对应 IPC（mobile:start / mobile:stop / mobile:rotate / mobile:status）；
 *   ④ 面板由「手机连接」菜单调用（showMobileConnect → showMobilePanel）；
 *   ⑤ 二维码是**本地生成**（引用 qrSvg，且没有在线二维码服务域名）；
 *   ⑥ 退出时会收掉网关（否则端口一直开着）。
 *
 * 用法：node scripts/check-mobile-panel.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const REPO = path.join(__dirname, '..');
const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : '');
const problems = [];

const panel = read(path.join(REPO, 'src', 'mobile-panel', 'index.html'));
const mainPanel = read(path.join(REPO, 'src', 'main', 'mobile-panel.ts'));
const preload = read(path.join(REPO, 'src', 'preload', 'mobile-panel-preload.ts'));
const index = read(path.join(REPO, 'src', 'main', 'index.ts'));

if (panel === '') problems.push('缺少 src/mobile-panel/index.html');
if (!/id="btn-start"/.test(panel)) problems.push('面板缺少「开启手机访问」按钮');
if (!/id="qr-svg"/.test(panel)) problems.push('面板缺少二维码容器');
if (!/id="pair-code"/.test(panel)) problems.push('面板缺少配对码显示');

for (const m of ['start', 'stop', 'rotate', 'status']) {
  if (!new RegExp(`${m}:`).test(preload)) problems.push(`preload 没暴露 ${m}()`);
}
for (const ch of ['mobile:start', 'mobile:stop', 'mobile:rotate', 'mobile:status']) {
  if (!mainPanel.includes(`'${ch}'`)) problems.push(`主进程没注册 ${ch}`);
}
if (!/showMobilePanel\(\)/.test(index)) problems.push('「手机连接」没有接到面板（showMobilePanel 未被调用）');
if (!index.includes('disposeMobileGateway')) problems.push('退出时没有收掉手机访问网关（端口会一直开着）');
if (!/qrSvg\(/.test(mainPanel)) problems.push('面板没有用本地 qrSvg 生成二维码');
// 在线二维码服务会把"一次性钥匙"递出去
if (/api\.qrserver|chart\.googleapis|quickchart|qrserver\.com/.test(panel + mainPanel)) {
  problems.push('面板引用了**在线**二维码服务（配对载荷不该发给第三方）');
}

if (problems.length) {
  console.error('❌ 手机连接面板守卫失败：\n');
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  console.log('✅ 手机连接面板接线齐全（按钮/二维码/配对码 · preload 4 方法 · IPC 4 通道 · 菜单已接 · 退出收服 · 本地生成二维码）');
}
