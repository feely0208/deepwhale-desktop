#!/usr/bin/env node
/**
 * 守卫：自建中继（手机在外面用）必须能把请求/响应（含流式）带回桌面端
 *
 * 为什么单独一条：这是"外面操控本机"的唯一通道，坏了就等于手机端只能在同 WiFi 用。
 * 真跑：假上游（模拟网关）+ 中继 + 隧道客户端 → 经中继取 HTTP → 断言
 *   ① 普通响应能回来 ② **流式（SSE）能逐块回来**（否则实时同步在外面断掉）。
 * 用法：node scripts/check-mobile-relay.js
 */
'use strict';
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const RELAY_PORT = 8791;
const UP_PORT = 8792;
const SECRET = 'test-secret-for-guard';
const tunnelId = crypto.createHmac('sha256', SECRET).update('deepwhale-tunnel').digest('hex').slice(0, 16);

(async () => {
  // 假上游：/echo 普通 JSON；/stream 每 100ms 推一块（模拟 SSE）
  const up = http.createServer((req, res) => {
    if (req.url.startsWith('/stream')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let n = 0;
      const t = setInterval(() => {
        n += 1;
        res.write(`data: chunk-${n}\n\n`);
        if (n >= 3) { clearInterval(t); res.end(); }
      }, 100);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, via: 'tunnel', path: req.url }));
  });
  await new Promise((r) => up.listen(UP_PORT, '127.0.0.1', r));

  const relay = spawn(process.execPath, [path.join(REPO, 'relay', 'server.js')], {
    env: { ...process.env, RELAY_PORT: String(RELAY_PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let relayLog = '';
  relay.stdout.on('data', (d) => (relayLog += d));
  relay.stderr.on('data', (d) => (relayLog += d));
  await wait(1200);

  const client = spawn(process.execPath, [path.join(REPO, 'relay', 'client.js')], {
    env: { ...process.env, RELAY_URL: `ws://127.0.0.1:${RELAY_PORT}/ws`, SECRET, GATEWAY: `http://127.0.0.1:${UP_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let clientLog = '';
  client.stdout.on('data', (d) => (clientLog += d));
  client.stderr.on('data', (d) => (clientLog += d));
  await wait(2000);

  const problems = [];
  const get = (p) => new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: `/t/${tunnelId}${p}`, method: 'GET' }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    r.end();
  });

  // ① 普通响应
  const echo = await get('/echo');
  if (echo.status !== 200) problems.push(`普通请求失败（status=${echo.status} body=${echo.body.slice(0, 60)}）`);
  else {
    try {
      const j = JSON.parse(echo.body);
      if (!j.ok || j.via !== 'tunnel') problems.push('响应内容不对（不是经隧道回来的）');
    } catch { problems.push('响应不是 JSON'); }
  }

  // ② 流式（SSE）：必须逐块到达，而不是攒完一次给
  const chunks = await new Promise((resolve) => {
    const got = [];
    const r = http.request({ host: '127.0.0.1', port: RELAY_PORT, path: `/t/${tunnelId}/stream`, method: 'GET' }, (res) => {
      res.on('data', (c) => {
        const txt = c.toString();
        const m = txt.match(/data: chunk-\d+/g);
        if (m) got.push(...m);
      });
      res.on('end', () => resolve(got));
    });
    r.on('error', () => resolve(got));
    r.end();
  });
  if (chunks.length < 3) problems.push(`流式数据没有完整到达（收到 ${chunks.length} 块）`);

  try { client.kill('SIGKILL'); } catch { /* 已退出 */ }
  try { relay.kill('SIGKILL'); } catch { /* 已退出 */ }
  up.close();

  if (problems.length) {
    console.error('❌ 中继隧道守卫失败：\n');
    problems.forEach((x, i) => console.error(`   ${i + 1}. ${x}`));
    console.error('\n  relay 日志:', relayLog.slice(0, 300));
    console.error('  client 日志:', clientLog.slice(0, 300));
    process.exitCode = 1;
  } else {
    console.log(`✅ 中继隧道通过：HTTP 经隧道回传 ✓ · 流式 ${chunks.length} 块逐块到达 ✓`);
  }
})().catch((e) => {
  console.error('❌ 守卫自身异常：', e?.message ?? e);
  process.exitCode = 1;
});
