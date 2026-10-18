#!/usr/bin/env node
/**
 * 桌面端隧道客户端：把本机网关（127.0.0.1:<port>）接到中继上。
 *
 * 本地验证用法：
 *   RELAY_URL=ws://127.0.0.1:8790/ws SECRET=test-secret GATEWAY=http://127.0.0.1:49384 node relay/client.js
 * 之后访问：http://127.0.0.1:8790/t/<tunnelId>/mobile/api/health?token=…
 * （tunnelId = HMAC-SHA256(secret,'deepwhale-tunnel').hex[:16]）
 */
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:8790/ws';
const SECRET = process.env.SECRET || '';
const GATEWAY = process.env.GATEWAY || 'http://127.0.0.1:49384';
if (!SECRET) {
  console.error('缺少 SECRET');
  process.exit(1);
}
const tunnelId = crypto.createHmac('sha256', SECRET).update('deepwhale-tunnel').digest('hex').slice(0, 16);
const gw = new URL(GATEWAY);
console.log('[tunnel] id =', tunnelId);

function upstream(req, cb) {
  const r = http.request({
    host: gw.hostname, port: gw.port, method: req.method, path: req.path,
    headers: { ...req.headers, host: gw.host },
  }, (res) => {
    cb({ status: res.statusCode, headers: res.headers, stream: res });
  });
  r.on('error', (e) => cb({ status: 502, headers: { 'content-type': 'text/plain' }, body: String(e.message) }));
  if (req.body) r.write(Buffer.from(req.body, 'base64'));
  r.end();
}

function connect() {
  const ws = new WebSocket(RELAY_URL);
  ws.on('open', () => {
    ws.send(JSON.stringify({ t: 'hello', tunnel: tunnelId, secret: SECRET }));
    console.log('[tunnel] connected to relay');
  });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.t !== 'req') return;
    upstream(msg, (out) => {
      if (out.stream) {
        out.stream.on('data', (c) => ws.send(JSON.stringify({ t: 'res', id: msg.id, body: c.toString('base64') })));
        out.stream.on('end', () => ws.send(JSON.stringify({ t: 'res', id: msg.id, end: true })));
        // 首帧带上状态与头
        ws.send(JSON.stringify({ t: 'res', id: msg.id, status: out.status, headers: out.headers }));
      } else {
        ws.send(JSON.stringify({ t: 'res', id: msg.id, status: out.status, headers: out.headers, body: Buffer.from(out.body || '').toString('base64'), end: true }));
      }
    });
  });
  ws.on('close', () => {
    console.log('[tunnel] relay closed, retry in 3s');
    setTimeout(connect, 3000);
  });
  ws.on('error', () => { /* close 会触发重连 */ });
}
connect();
