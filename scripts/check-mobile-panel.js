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
// 1.0.59 实测：面板被 `lanAccess` 闸门拦住，而设置里根本没有那个开关 → 用户无路可走。
// 现在局域网由 mobile-gateway 提供，面板不得再依赖 lanAccess。
const panelFn = index
  .slice(index.indexOf('async function showMobileConnect('), index.indexOf('async function showMobileConnectLegacy('))
  // 去掉注释再判断：说明文字里提到 lanAccess 不算依赖（我第一次就误报了）
  .replace(/^\s*\/\/.*$/gm, '');
if (/store\.get\('lanAccess'\)/.test(panelFn)) problems.push('「手机连接」面板仍被旧开关 lanAccess 拦住（设置里没有这个开关，用户会无路可走）');
if (!/qrSvg\(/.test(mainPanel)) problems.push('面板没有用本地 qrSvg 生成二维码');
// 令牌必须持久化：否则每次重启网关都换新令牌 → 手机端存的令牌失效 → 每次都要重新配对
if (!/token:\s*gatewaySessionToken/.test(mainPanel)) {
  problems.push('面板没有把网关令牌持久化（重启后手机必须重新配对）');
}
if (!/lastGatewayToken/.test(mainPanel)) problems.push('面板启动时没有复用上次的令牌');
// 「换一个配对码」不能连令牌一起换：2026-10-19 真机根因 ——
//   旧实现调 gateway.rotate()（换令牌）却只持久化配对码 → 状态文件留旧令牌 →
//   桌面重启复用旧令牌 → 手机上已保存的令牌全部 401，被迫反复扫码。
// ⚠️ 必须在**去掉注释后的代码**里判断：说明文字里提到 gateway.rotate() 不算违规（第一版就误报了）
const mainPanelCode = mainPanel.replace(/^\s*\/\/.*$/gm, '');
if (/gateway\.rotate\(\)/.test(mainPanelCode)) {
  problems.push('「换一个配对码」调了 gateway.rotate()（会连令牌一起换，已配对的手机全部 401）→ 应改用 rotatePairCode()');
}
if (!/rotatePairCode\(\)/.test(mainPanelCode)) problems.push('「换一个配对码」没有调用 rotatePairCode()（只换码不换令牌）');
// 配对码也要在**启动路径**落盘：否则自动启动后状态文件里的码对不上内存里的码（排障/自动化会被骗）
// （already 分支 1 次 + 换码 1 次 + 启动 1 次 = 至少 3 处）
if ((mainPanelCode.match(/rememberPairCode\(/g) || []).length < 3) {
  problems.push('配对码没有在启动路径持久化（状态文件里的 pairCode 会对不上真实二维码）');
}
// 开启后必须把 enabled=true 写回：否则重启后 autoStartMobileGateway() 永远跳过
if (!/rememberEnabled\(true\)/.test(mainPanel)) {
  problems.push('开启手机访问后没有写 enabled=true → 重启不会自动恢复（旧代码只有 rememberEnabled(false)）');
}
// 自动恢复必须挂在**启动流程**（DSH 就绪后），不能只挂在「手机连接」菜单回调里：
//   否则用户重启桌面后不点菜单 → 网关不开 → 手机必 401（2026-10-19 真机定位）
const autoStartCalls = (index.match(/void ensureMobileGatewayAutoStart\(\)/g) || []).length;
if (autoStartCalls < 2) {
  problems.push(`自动恢复只在「手机连接」菜单里触发（启动流程里没有）→ 重启后网关不开；实际调用点 ${autoStartCalls} 处`);
}
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
