/**
 * 桌面壳内置的「手机访问网关」（手机端 1.1.0 · M0）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么要有这个模块（2026-10-15 立项）
 * ──────────────────────────────────────────────────────────────────────
 * 现状：DSH 只监听 127.0.0.1，手机**无论如何连不上**；我们过去的做法是让用户
 *      "自己搭转发层 + 认证"，官网指南还明确写着"不指定、不推荐、不代配"。
 *      结果是 90% 的用户卡死在第一步 —— 而第三方（Whaleness）用"桌面出二维码 +
 *      手机扫码 + 隧道"把这一步做成了 10 秒。
 *
 * 我们的长板：**我们就是桌面壳** —— 转发与认证这件事我们能在壳里原生做掉，
 *      不必让用户配 nginx/frp，也不必依赖任何第三方隧道服务。
 *
 * 设计约束（对齐用户三条原则）
 *   1. **自己可控**：纯 Node 原生 http，不引入任何第三方隧道/代理依赖；
 *   2. **默认安全**：默认不监听；用户点「开启手机访问」才监听；只监听局域网/全部网卡但
 *      必须带令牌；令牌随会话生成、可撤销/轮换；配对码**一次性 + 5 分钟有效**；
 *   3. **不打扰**：只在面板里出一张二维码，不弹窗。
 *
 * 鉴权模型（两层，防止把"能执行任意命令的界面"裸奔到网上）
 *   · 配对码 pairCode：6 位、一次性、5 分钟过期 —— 手机扫码后拿它换令牌；
 *   · 会话令牌 token：32 字节随机，之后所有请求都要带（`?token=` 或 `Authorization: Bearer`）。
 *
 * ⚠️ 安全红线：**绝不能**在没有令牌的情况下把内容代理出去。这条由
 *   scripts/test-mobile-gateway.js 断言（无令牌必须 401）。
 */

import * as http from 'node:http';
import * as https from 'node:https';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as os from 'node:os';

export interface GatewayOptions {
  /** DSH 本机地址，形如 http://127.0.0.1:8080 */
  dshBase: string;
  /** DSH 自己的访问令牌（从它打印的 `dsh web: …?token=…` 里取的） */
  dshToken: string;
  /** 监听端口；默认自动选一个空闲端口 */
  port?: number;
  /** 配对码有效期（毫秒），默认 5 分钟 */
  pairTtlMs?: number;
}

export interface GatewaySession {
  /** 手机该打开的地址（不含令牌，令牌单独给） */
  origin: string;
  /** 会话令牌 */
  token: string;
  /** 一次性配对码 */
  pairCode: string;
  /** 配对码过期时间戳（ms） */
  pairExpiresAt: number;
}

export interface GatewayHandle {
  session: GatewaySession;
  port: number;
  /** 关闭服务（释放端口） */
  stop: () => Promise<void>;
  /** 轮换：换令牌与配对码（旧令牌立刻失效） */
  rotate: () => GatewaySession;
  /** 当前是否在监听 */
  listening: () => boolean;
}

/** 生成人类可读的一次性配对码：去掉容易混淆的 0/O/1/I */
export function makePairCode(): string {
  const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
  const bytes = randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 常量时间比较，避免令牌比较被计时探测 */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 从请求里取令牌：`?token=` 优先，其次 `Authorization: Bearer`，最后 cookie */
function tokenOf(req: IncomingMessage, url: URL): string {
  const q = url.searchParams.get('token');
  if (q) return q;
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  const cookie = req.headers.cookie ?? '';
  const m = /(?:^|;\s*)dsh_mobile=([^;]+)/.exec(cookie);
  return m ? decodeURIComponent(m[1]) : '';
}

/** 去掉我们自己的 token 参数，换成 DSH 自己的 token（DSH 首次加载认这个） */
function upstreamPath(url: URL, dshToken: string): string {
  const u = new URL(url.toString());
  u.searchParams.delete('token');
  if (dshToken) u.searchParams.set('token', dshToken);
  return u.pathname + (u.search || '');
}

const DENY_PAGE = `<!doctype html><meta charset="utf-8"><title>深鲸 · 手机访问</title>
<style>body{font:14px/1.6 -apple-system,system-ui,"PingFang SC",sans-serif;margin:0;padding:40px;background:#0f1115;color:#e6e8ea}
h1{font-size:16px;margin:0 0 8px}p{margin:6px 0;color:#9aa4ad}code{background:#1b1f27;padding:2px 6px;border-radius:4px}</style>
<h1>需要配对</h1><p>这个地址只能在配对后使用。请在电脑上打开「手机连接」，用深鲸 Mobile 扫描二维码。</p>
<p>如果你已经扫过码，请重新扫码 —— 配对码是一次性的，且 5 分钟内有效。</p>`;

/**
 * 启动网关。返回值里有手机要用的 origin / token / pairCode。
 * 调用方负责在不需要时 stop()（例如面板关闭、应用退出）。
 */
export function startMobileGateway(opts: GatewayOptions): Promise<GatewayHandle> {
  const dshUrl = new URL(opts.dshBase);
  const isHttps = dshUrl.protocol === 'https:';
  const agent = isHttps ? https : http;
  const pairTtlMs = opts.pairTtlMs ?? 5 * 60 * 1000;

  let token = randomBytes(24).toString('base64url');
  let pairCode = makePairCode();
  let pairExpiresAt = Date.now() + pairTtlMs;

  const newSession = (): GatewaySession => {
    token = randomBytes(24).toString('base64url');
    pairCode = makePairCode();
    pairExpiresAt = Date.now() + pairTtlMs;
    return {
      origin: `http://${currentHostForDisplay}:${String(currentPort)}`,
      token,
      pairCode,
      pairExpiresAt,
    };
  };

  let currentPort = opts.port ?? 0;
  let currentHostForDisplay = detectLanHost();

  const server: Server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  /** 普通 HTTP 请求：鉴权 → 反代 */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://placeholder');

    // ① 配对：`/__pair?code=XXXXXX` 用一次性码换令牌（只有这一个免鉴权入口）
    if (url.pathname === '/__pair') {
      const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      if (code === '' || Date.now() > pairExpiresAt || !safeEqual(code, pairCode)) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, reason: code === '' ? 'missing-code' : 'invalid-or-expired' }));
        return;
      }
      // 一次性：换完立刻作废配对码（令牌继续有效）
      pairExpiresAt = 0;
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, token, origin: `http://${currentHostForDisplay}:${String(currentPort)}` }));
      return;
    }

    // ② 其余请求一律要令牌 —— 没有令牌**绝不代理**
    const given = tokenOf(req, url);
    if (given === '' || !safeEqual(given, token)) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end(DENY_PAGE);
      return;
    }

    // ③ 反代到 127.0.0.1 上的 DSH（带上 DSH 自己的令牌）
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    delete headers.authorization;
    // 用我们自己的 cookie 名承载会话令牌，避免与 DSH 自身 cookie 冲突
    if (headers.cookie) {
      headers.cookie = String(headers.cookie)
        .split(';')
        .filter((c) => !c.trim().startsWith('dsh_mobile='))
        .join(';');
    }
    const upstreamReq = agent.request(
      {
        protocol: dshUrl.protocol,
        hostname: dshUrl.hostname,
        port: dshUrl.port || (isHttps ? 443 : 80),
        method: req.method,
        path: upstreamPath(url, opts.dshToken),
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res); // 流式（SSE 也走这里，不缓冲）
      },
    );
    upstreamReq.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`gateway upstream error: ${err.message}`);
    });
    req.pipe(upstreamReq);
  }

  /** WebSocket 之类的 upgrade：同样必须带令牌 */
  server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const given = tokenOf(req, url);
    if (given === '' || !safeEqual(given, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const upReq = agent.request({
      protocol: dshUrl.protocol,
      hostname: dshUrl.hostname,
      port: dshUrl.port || (isHttps ? 443 : 80),
      method: 'GET',
      path: upstreamPath(url, opts.dshToken),
      headers: { ...req.headers, host: dshUrl.host },
    });
    upReq.on('upgrade', (upRes, upSocket, upHead) => {
      const headers = Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v ?? '')}`)
        .join('\r\n');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
      if (upHead?.length) socket.write(upHead);
      if (head?.length) upSocket.write(head);
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    upReq.on('error', () => socket.destroy());
    upReq.end();
  });

  return new Promise<GatewayHandle>((resolve, reject) => {
    server.once('error', reject);
    server.listen(currentPort, '0.0.0.0', () => {
      const addr = server.address();
      currentPort = typeof addr === 'object' && addr ? addr.port : currentPort;
      currentHostForDisplay = detectLanHost();
      resolve({
        session: {
          origin: `http://${currentHostForDisplay}:${String(currentPort)}`,
          token,
          pairCode,
          pairExpiresAt,
        },
        port: currentPort,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            // 关掉残留连接，端口立刻释放
            server.closeAllConnections?.();
          }),
        rotate: () => newSession(),
        listening: () => server.listening,
      });
    });
  });
}

/** 取一个"手机能访问到"的本机地址用于展示（真正的可达性由用户网络决定） */
export function detectLanHost(): string {
  // 这里只做展示用途；真实地址列表由 mobile-connect.ts 的 lanAddresses() 提供。
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

/**
 * 二维码载荷：手机端拿到它就能完成"配对 + 打开"。
 * 用 `dshmobile://pair?...` 自定义协议，扫码后 App 直接进入连接流程；
 * 同时也把 origin/code 明文写进去，便于任何扫码器都能显示，人工输入也能用。
 */
export function pairPayload(session: GatewaySession): string {
  const q = new URLSearchParams({ origin: session.origin, code: session.pairCode });
  return `dshmobile://pair?${q.toString()}`;
}
