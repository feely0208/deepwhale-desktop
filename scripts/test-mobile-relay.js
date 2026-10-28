#!/usr/bin/env node
/**
 * 中继可自托管 + 二维码载荷 回归测试（离线，不联网）
 *
 * 为什么值得单独测：
 *  1. relayEndpointFor() 把「用户随手填的地址」变成一对必须同源的地址（手机用 HTTP、桌面用 WS）。
 *     写错一次 = 手机在外面永远连不上，而本地局域网一切正常 —— 这种 bug 最难被发现。
 *  2. pairPayload() 的字段顺序是对**已发布老 App** 的兼容承诺：remote 必须在最前、code 必须在最后。
 *     一旦顺序错了，老版本手机端会把 code 读成 "ABC123&remote=..."，配对直接全废（而且只在真机上暴露）。
 *
 * 用法：npm run build && node scripts/test-mobile-relay.js
 */
'use strict';

const path = require('path');

const REPO = path.join(__dirname, '..');
const TUNNEL = path.join(REPO, 'dist/main/mobile-tunnel.js');
const GATEWAY = path.join(REPO, 'dist/main/mobile-gateway.js');

for (const f of [TUNNEL, GATEWAY]) {
  if (!require('fs').existsSync(f)) {
    console.error(`\n❌ 找不到 ${f}\n   先跑 npm run build，再执行本测试。\n`);
    process.exit(1);
  }
}

const { relayEndpointFor, DEFAULT_RELAY, OFFICIAL_RELAY_HTTP_BASE, OFFICIAL_RELAY_WS_URL, tunnelIdFor } = require(TUNNEL);
const { pairPayload } = require(GATEWAY);

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

console.log('\nA. 中继地址规范化');
check('官方地址原样', (() => {
  const e = relayEndpointFor(OFFICIAL_RELAY_HTTP_BASE);
  return e.httpBase === 'https://deepwhale.org.cn/_relay' && e.wsUrl === 'wss://deepwhale.org.cn/_relay/ws';
})());
check('默认中继 = 官方', DEFAULT_RELAY.httpBase === OFFICIAL_RELAY_HTTP_BASE && DEFAULT_RELAY.wsUrl === OFFICIAL_RELAY_WS_URL);
check('只给域名 → 补 /_relay', (() => {
  const e = relayEndpointFor('https://relay.example.com');
  return e.httpBase === 'https://relay.example.com/_relay' && e.wsUrl === 'wss://relay.example.com/_relay/ws';
})());
check('尾斜杠被去掉', (() => {
  const e = relayEndpointFor('https://relay.example.com/');
  return e.httpBase === 'https://relay.example.com/_relay' && e.wsUrl === 'wss://relay.example.com/_relay/ws';
})());
check('漏写协议 → 自动补 https', (() => {
  const e = relayEndpointFor('relay.example.com');
  return e.httpBase === 'https://relay.example.com/_relay';
})());
check('自定义路径原样保留 + WS 同路径', (() => {
  const e = relayEndpointFor('https://relay.example.com/myrelay');
  return e.httpBase === 'https://relay.example.com/myrelay' && e.wsUrl === 'wss://relay.example.com/myrelay/ws';
})());
check('http → ws（内网/自签场景）', (() => {
  const e = relayEndpointFor('http://10.0.0.5:8080/_relay');
  return e.httpBase === 'http://10.0.0.5:8080/_relay' && e.wsUrl === 'ws://10.0.0.5:8080/_relay/ws';
})());
for (const bad of ['ftp://relay.example.com', 'https://relay.example.com/?a=1', 'https://relay.example.com/#x', '   ']) {
  let threw = false;
  try { relayEndpointFor(bad); } catch { threw = true; }
  check(`非法地址被拒绝：${JSON.stringify(bad)}`, threw);
}

console.log('\nB. 二维码载荷（老 App 兼容）');
const session = { origin: 'http://192.168.1.25:40671', pairCode: 'K7M2QP', token: 'x' };
const remote = 'https://relay.example.com/_relay/t/0123456789abcdef';

const withRemote = pairPayload(session, { remote });
check('remote 在最前', withRemote.startsWith('dshmobile://pair?remote='), withRemote.slice(0, 60));
check('code 在最后', withRemote.endsWith(`&code=${encodeURIComponent(session.pairCode)}`), withRemote.slice(-40));
{
  // 模拟【已发布老 App】的解析：origin 取到下一个 &；code 一直取到结尾
  const oKey = 'origin=';
  const cKey = 'code=';
  const oAt = withRemote.indexOf(oKey);
  const oEnd = withRemote.indexOf('&', oAt);
  const originRaw = withRemote.substring(oAt + oKey.length, oEnd > 0 ? oEnd : withRemote.length);
  const cAt = withRemote.indexOf(cKey);
  const codeRaw = withRemote.substring(cAt + cKey.length);
  check('老 App 仍能读出 origin', decodeURIComponent(originRaw) === session.origin, originRaw);
  check('老 App 仍能读出 code（不被 remote 污染）', decodeURIComponent(codeRaw) === session.pairCode, codeRaw);
}
{
  // 新 App 解析：三个字段各自取到 & 或结尾
  const param = (text, key) => {
    const at = text.indexOf(`${key}=`);
    if (at < 0) return '';
    const start = at + key.length + 1;
    const end = text.indexOf('&', start);
    return decodeURIComponent(text.substring(start, end < 0 ? text.length : end));
  };
  check('新 App 读出 remote', param(withRemote, 'remote') === remote);
}
const noRemote = pairPayload(session);
check('没有远程时不含 remote 字段', !noRemote.includes('remote=') && noRemote.startsWith('dshmobile://pair?origin='));
check('没有远程时 code 仍在最后', noRemote.endsWith(`&code=${encodeURIComponent(session.pairCode)}`));

console.log('\nC. 隧道 ID');
const id1 = tunnelIdFor('secret-abc');
const id2 = tunnelIdFor('secret-abc');
check('同 secret 稳定', id1 === id2);
check('长度 16 且是十六进制', /^[0-9a-f]{16}$/.test(id1), id1);
check('不同 secret 不同 ID', tunnelIdFor('secret-abd') !== id1);

console.log('');
if (failures > 0) {
  console.error(`❌ 失败 ${failures} 项\n`);
  process.exit(1);
}
console.log('✅ 中继/配对载荷回归测试全过\n');
