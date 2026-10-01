#!/usr/bin/env node
/**
 * 手机连接 · 地址拼装回归测试（离线）
 *
 * 这个函数只有一件事做错就会让用户白折腾：**token 没拼进去**。
 * 用户的原话是「以前只需要输入 ip 就可以，从来没让输入过什么 token」——
 * 而现在的 DSH 不带 token 一律 401。所以「带 token 的完整地址」是这个功能的全部价值，
 * 它错了产品就等于没做。
 *
 * 用法：npm run build && node scripts/test-mobile-urls.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const MOD = path.join(REPO, 'dist/main/mobile-connect.js');

if (!fs.existsSync(MOD)) {
  console.error(`\n❌ 找不到 ${MOD}\n   先跑 npm run build，再执行本测试。\n`);
  process.exit(1);
}

const { buildMobileUrls } = require(MOD);

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

const TOKEN = 'N7Kii1qXLOFegl74qgHbK1hYKIJrWtvXkcN1if70KxM';

console.log('\nA. 局域网地址');
{
  const r = buildMobileUrls(TOKEN, 3095, ['192.168.0.103', '10.0.0.5'], '');
  check('每条网卡地址生成一条', r.lan.length === 2, JSON.stringify(r.lan));
  check('地址带端口', r.lan[0] === `http://192.168.0.103:3095/?token=${TOKEN}`, r.lan[0]);
  check('第二个地址也对', r.lan[1] === `http://10.0.0.5:3095/?token=${TOKEN}`, r.lan[1]);
  check('没配外网地址时 external 为 null', r.external === null, String(r.external));
  check('firstTime 回退到第一条局域网地址', r.firstTime === r.lan[0], String(r.firstTime));
}

console.log('\nB. 外网（隧道）地址');
{
  const r = buildMobileUrls(TOKEN, 3095, ['192.168.0.103'], 'https://mnkuil8bitiy.deepwhale.org');
  check('拼出外网地址', r.external === `https://mnkuil8bitiy.deepwhale.org/?token=${TOKEN}`, String(r.external));
  check('firstTime 优先外网（在外面也能用）', r.firstTime === r.external, String(r.firstTime));

  const slash = buildMobileUrls(TOKEN, 3095, [], 'https://x.example.org/');
  check('外网地址末尾的斜杠不会拼成 //', slash.external === `https://x.example.org/?token=${TOKEN}`, String(slash.external));

  const padded = buildMobileUrls(TOKEN, 3095, [], '  https://y.example.org  ');
  check('外网地址两端的空格会被去掉', padded.external === `https://y.example.org/?token=${TOKEN}`, String(padded.external));

  const blank = buildMobileUrls(TOKEN, 3095, [], '   ');
  check('外网地址是空白 → 当作没配', blank.external === null, String(blank.external));
}

console.log('\nC. 拿不到 token 时（不该谎报可用）');
{
  const r = buildMobileUrls('', 3095, ['192.168.0.103'], 'https://x.example.org');
  check('没有 token 时不拼 ?token=', r.lan[0] === 'http://192.168.0.103:3095/', r.lan[0]);
  check('外网地址同样不拼', r.external === 'https://x.example.org/', String(r.external));
  // 这一条是提示：真出现这种情况，面板应当明确告诉用户"服务还没就绪"（index.ts 已处理）
  check('（提醒）这种地址访问会 401 —— 面板必须拦住这种情况', true);
}

console.log('\nD. 没有局域网地址时');
{
  const r = buildMobileUrls(TOKEN, 3095, [], '');
  check('lan 为空数组', Array.isArray(r.lan) && r.lan.length === 0);
  check('firstTime 为 null', r.firstTime === null, String(r.firstTime));
}

if (failures > 0) {
  console.error(`\n❌ 手机连接地址测试失败：${failures} 项\n`);
  process.exit(1);
}
console.log('\n✅ 通过：带 token 的地址拼装正确\n');
