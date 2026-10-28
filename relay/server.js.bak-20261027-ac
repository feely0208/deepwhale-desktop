#!/usr/bin/env node
/**
 * 深鲸中继服务（自建，不依赖第三方隧道）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要：手机在**外面**（4G/别人家 WiFi）时，电脑没有公网 IP，手机够不着 ✗。
 * 做法：电脑上的网关**主动外连**本中继（出站，不用开端口/不用公网 IP），
 * 手机连中继；中继把 HTTP 请求/响应在两边之间转发。中继**只做传输**，不懂内容。
 *
 * 拓扑：
 *   手机  ──HTTPS──▶  中继（本文件，VPS）  ◀──WSS──  电脑上的隧道客户端
 *                                                      └─▶ 127.0.0.1:<网关端口>
 *
 * 安全：
 *   · 桌面端用 `secret`（设备密钥，面板里生成）认领隧道；没有 secret 建不了隧道；
 *   · 手机端仍要过我们网关自己的**配对码 + 令牌**（中继不校验也不懂）；
 *   · 全程 TLS（中继在 nginx 后面）+ 中继↔桌面也是 WSS。
 *
 * 协议（WS 上的 JSON 帧，base64 传 body）：
 *   桌面→中继  {t:'hello', tunnel, secret}         认领隧道
 *   中继→桌面  {t:'ready', tunnel}
 *   中继→桌面  {t:'req', id, method, path, headers, body}
 *   桌面→中继  {t:'res', id, status, headers, body}   body 可多次（流式），末帧 end:true
 *   中继→桌面  {t:'abort', id}                       手机端断开
 */
'use strict';
const http = require('node:http');
const { WebSocketServer } = require('ws');
const crypto = require('node:crypto');

const PORT = Number(process.env.RELAY_PORT || 8790);
/** tunnelId → { ws, pending: Map<seq, res> } */
const tunnels = new Map();
let seq = 0;

function log(...a) {
  console.log('[relay]', ...a);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url || '/', 'http://relay');
  const m = /^\/t\/([A-Za-z0-9_-]{6,64})(\/.*)?$/.exec(u.pathname);
  if (!m) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return;
  }
  const tunnelId = m[1];
  const rest = (m[2] || '/') + (u.search || '');
  const tun = tunnels.get(tunnelId);
  if (!tun) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('tunnel offline');
    return;
  }
  const id = ++seq;
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('base64');
    try {
      tun.ws.send(JSON.stringify({
        t: 'req', id, method: req.method, path: rest,
        headers: req.headers, body,
      }));
    } catch {
      res.writeHead(502); res.end('tunnel send failed'); return;
    }
    const pending = { res, headersSent: false, done: false, method: req.method, path: rest };
    tun.pending.set(id, pending);
    // ⚠️ 必须监听 **res** 的 close（= 手机端断开），不能监听 req 的 close ——
    //    req 的 close 在"请求体读完"时就触发（实测：响应还没回来就在这儿把 pending 删了 →
    //    手机端永远收不到响应 → 隧道看起来"卡死"）。
    res.on('close', () => {
      if (!pending.done && !res.writableEnded) {
        try { tun.ws.send(JSON.stringify({ t: 'abort', id })); } catch { /* 连接已断 */ }
        tun.pending.delete(id);
      }
    });
  });
});

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  let claimed = null;
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.t === 'hello') {
      if (typeof msg.tunnel !== 'string' || typeof msg.secret !== 'string') return;
      // 隧道 ID 与密钥配对：ID = HMAC(secret)[:16]（双方可各自算，中继不存密钥）
      const expect = crypto.createHmac('sha256', msg.secret).update('deepwhale-tunnel').digest('hex').slice(0, 16);
      if (msg.tunnel !== expect) { ws.close(4001, 'bad secret'); return; }
      claimed = msg.tunnel;
      tunnels.set(claimed, { ws, pending: new Map() });
      ws.send(JSON.stringify({ t: 'ready', tunnel: claimed }));
      log('tunnel up', claimed);
      return;
    }
    if (!claimed) return;
    const tun = tunnels.get(claimed);
    if (!tun) return;
    if (msg.t === 'res') {
      const p = tun.pending.get(msg.id);
      if (!p) return;
      const buf = msg.body ? Buffer.from(msg.body, 'base64') : Buffer.alloc(0);
      if (!p.headersSent) {
        p.headersSent = true;
        // 中继请求日志：手机上的「接口 404/500」能直接看到是哪条路径
        console.log(`[relay] ${p.method} ${p.path} → ${msg.status || 200}`);
        p.res.writeHead(msg.status || 200, msg.headers || {});
      }
      if (buf.length) p.res.write(buf);
      if (msg.end) {
        p.done = true;
        tun.pending.delete(msg.id);
        p.res.end();
      }
    }
  });
  ws.on('close', () => {
    if (claimed) {
      tunnels.delete(claimed);
      log('tunnel down', claimed);
    }
  });
});

server.listen(PORT, '127.0.0.1', () => log(`listening on 127.0.0.1:${PORT} (ws path /ws)`));
