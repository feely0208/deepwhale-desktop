#!/usr/bin/env node
/**
 * 守卫（真机/真公网）：桌面端隧道客户端 ↔ **线上中继** ↔ 手机侧入口
 *
 * 这是"在外面用"的唯一验收：本地起一个假网关 → 用我们的隧道客户端连**线上中继**
 * （wss://deepwhale.org.cn/_relay/ws）→ 从公网 URL
 * （https://deepwhale.org.cn/_relay/t/<隧道ID>/…）取数据 → 断言能回来。
 * 只有这条通了，手机在 4G 下才真的能操控本机。
 *
 * 用法：node scripts/check-mobile-relay-live.js
 */
'use strict';
const http = require('node:http');
const path = require('node:path');
const https = require('node:https');
const REPO = path.join(__dirname, '..');
const { startMobileTunnel, tunnelIdFor } = require(path.join(REPO, 'dist', 'main', 'mobile-tunnel.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const UP_PORT = 8793;
const SECRET = 'guard-live-secret-' + Date.now().toString(36);

const get = (url) => new Promise((resolve) => {
  const req = https.get(url, { timeout: 15000 }, (res) => {
    let b = '';
    res.on('data', (c) => (b += c));
    res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
});

(async () => {
  const up = http.createServer((req, res) => {
    if (req.url.startsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        res.write(`data: live-chunk-${n}\n\n`);
        if (n >= 3) { clearInterval(t); res.end(); }
      }, 150);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, via: 'live-relay', path: req.url }));
  });
  await new Promise((r) => up.listen(UP_PORT, '127.0.0.1', r));

  const problems = [];
  const tunnel = startMobileTunnel({
    gatewayPort: UP_PORT,
    secret: SECRET,
    onLog: (l) => console.log(l),
  });
  const id = tunnelIdFor(SECRET);
  const base = tunnel.remoteOrigin;
  console.log('  隧道 ID:', id);
  console.log('  公网地址:', base);

  // 等隧道连上（最多 20s）
  for (let i = 0; i < 20 && !tunnel.connected(); i += 1) await wait(500);
  if (!tunnel.connected()) problems.push('隧道没有连上线上中继');

  if (tunnel.connected()) {
    const echo = await get(`${base}/echo?x=1`);
    if (echo.status !== 200) problems.push(`经公网中继取数失败（status=${echo.status} body=${String(echo.body).slice(0, 80)}）`);
    else {
      try {
        const j = JSON.parse(echo.body);
        if (!j.ok || j.via !== 'live-relay') problems.push('响应内容不是本机假网关给的（隧道串了？）');
      } catch { problems.push('响应不是 JSON'); }
    }

    // 流式：必须逐块（实时同步在外面也依赖这个）
    const chunks = await new Promise((resolve) => {
      const got = [];
      const req = https.get(`${base}/stream`, { timeout: 15000 }, (res) => {
        res.on('data', (c) => {
          const m = c.toString().match(/data: live-chunk-\d+/g);
          if (m) got.push(...m);
        });
        res.on('end', () => resolve(got));
      });
      req.on('error', () => resolve(got));
      req.on('timeout', () => { req.destroy(); resolve(got); });
    });
    if (chunks.length < 3) problems.push(`公网流式不完整（收到 ${chunks.length} 块）`);
    else console.log('  流式块数:', chunks.length);
  }

  tunnel.stop();
  up.close();

  if (problems.length) {
    console.error('❌ 公网中继端到端失败：\n');
    problems.forEach((x, i) => console.error(`   ${i + 1}. ${x}`));
    process.exitCode = 1;
  } else {
    console.log('✅ 公网中继端到端通过：桌面端主动外连 → 公网地址取数 → 流式逐块到达');
  }
})().catch((e) => {
  console.error('❌ 守卫自身异常：', e?.message ?? e);
  process.exitCode = 1;
});
