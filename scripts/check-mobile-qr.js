#!/usr/bin/env node
/**
 * 守卫：配对二维码必须**结构正确**（能扫出来的最低要求）
 *
 * 为什么单独一条：二维码是手机端唯一的入口（扫码配对）。画错了 = 功能等于不存在，
 * 而"看起来有个方块"是看不出来的 —— 必须断言结构：
 *   ① 模块数合法（21 + 4k）；
 *   ② 三个角上的定位图案（7×7 finder）在位；
 *   ③ 定位图案之间交替的时序图案在位；
 *   ④ 载荷与网关的配对载荷格式一致（dshmobile://pair?origin=…&code=…）。
 * 用法：node scripts/check-mobile-qr.js
 */
'use strict';
const path = require('node:path');
const { qrMatrix, pairPayload, qrSvg } = require(path.join(__dirname, '..', 'dist', 'main', 'mobile-gateway.js'));

const payload = pairPayload({ origin: 'http://192.168.1.5:8765', token: 'secret', pairCode: 'ABC234', pairExpiresAt: 0 });
const m = qrMatrix(payload);
const n = m.length;
const problems = [];

if ((n - 21) % 4 !== 0 || n < 21) problems.push(`模块数不合法：${n}（应为 21+4k）`);
if (!/^dshmobile:\/\/pair\?/.test(payload)) problems.push(`配对载荷格式不对：${payload.slice(0, 40)}`);
if (!/origin=/.test(payload) || !/code=ABC234/.test(payload)) problems.push('配对载荷缺少 origin 或 code');

/** 7×7 定位图案：外框黑、内圈白、中心 3×3 黑 */
function finderAt(r0, c0) {
  const want = [
    [1,1,1,1,1,1,1],
    [1,0,0,0,0,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,1,1,1,0,1],
    [1,0,0,0,0,0,1],
    [1,1,1,1,1,1,1],
  ];
  for (let r = 0; r < 7; r += 1) {
    for (let c = 0; c < 7; c += 1) {
      if ((m[r0 + r]?.[c0 + c] ? 1 : 0) !== want[r][c]) return false;
    }
  }
  return true;
}
for (const [r, c, name] of [[0, 0, '左上'], [0, n - 7, '右上'], [n - 7, 0, '左下']]) {
  if (!finderAt(r, c)) problems.push(`${name}定位图案不正确（扫不出来）`);
}
// 时序图案：第 6 行/列在定位图案之外应交替
let timingOk = true;
for (let i = 8; i < n - 8; i += 1) {
  if (m[6][i] === m[6][i + 1]) timingOk = false;
  if (m[i][6] === m[i + 1][6]) timingOk = false;
}
if (!timingOk) problems.push('时序图案不是交替的（扫不出来）');

const svg = qrSvg(payload);
if (!/<svg/.test(svg)) problems.push('qrSvg 没有产出 svg');

if (problems.length) {
  console.error('❌ 配对二维码守卫失败：\n');
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  console.log(`✅ 配对二维码结构正确（${n}×${n} 模块 · 三个定位图案 · 时序图案 · 载荷 dshmobile://pair）`);
}
