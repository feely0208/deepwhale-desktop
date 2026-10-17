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

/**
 * 去掉我们自己的 token 参数，必要时换成 DSH 自己的 token。
 *
 * ⚠️ 2026-10-16 真机联调第二个 bug（替身测不出来）：
 *   DSH 只要发现 URL 里带 `token` 就**一直 303 去把它洗掉**（避免令牌留在地址栏/历史里）。
 *   我最初**每次**都给上游补上 DSH 令牌 → 令牌永远在 → **无限重定向**（手机端白屏）。
 *   正确做法：**只在客户端还没有 DSH 的鉴权 cookie 时才注入**；之后让 cookie 说话。
 */
function upstreamPath(rawUrl: string, dshToken: string, hasDshCookie: boolean): string {
  // ⚠️ 绝不能在这里用 `new URL()` 重新解析再拼回去（2026-10-16 真机联调第三个 bug）：
  //    DSH 的客户端资源路径形如 `plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=…`，
  //    `new URL()` 会把**第一个 `?` 当成 query 边界** → pathname 被截断成 `plugins/` → 404，
  //    手机端就是白屏（直连 DSH 同一路径实测 200 / 40KB）。
  //    所以：只在原始串上摘掉"我们自己的 token 参数"，必要时再追加 DSH 的令牌。
  let out = rawUrl.replace(/([?&])token=[^&]*/g, '$1');
  // ⚠️ 剥掉 token 后必须把**分隔符收拾干净**（2026-10-17 实测踩到）：
  //    `/mobile/?token=X&dshApp=1` → 朴素替换会变成 `/mobile/&dshApp=1`
  //    → 插件把整串当文件名 → 404「mobile ui not found」→ 手机端白屏。
  //    规则：`/&` → `/?`（路径后重新开查询），`?&`/`&&` 收敛，尾部 `?`/`&` 去掉。
  out = out.replace('/&', '/?').replace(/\?&+/g, '?').replace(/&&+/g, '&').replace(/[?&]+$/, '');
  if (out === '') out = '/';
  if (!out.startsWith('/')) out = '/' + out;
  if (dshToken && !hasDshCookie) {
    out += (out.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(dshToken);
  }
  return out;
}

/**
 * 跨域支持（独立安装的手机 App 需要）：
 * App 里的页面来自本地壳（origin 与网关不同），要访问 `/__pair` 与 `/mobile/api/*` 就必须过 CORS。
 * 我们的鉴权**只用显式令牌**（不依赖 cookie），所以允许 `*` 是安全的；
 * App 侧用 `credentials: 'omit'`，不带任何凭据。
 */
/**
 * ⚠️ 必须**回显 Origin + 允许凭据**（不能用 `*`）：
 *   独立 App 的页面与网关不同源，而 DSH 的鉴权是 cookie —— 跨域请求必须带凭据，
 *   浏览器规定"带凭据时 Allow-Origin 不能是 `*`"。只回显 Origin 才走得通（实测：写 `*` 时
 *   DSH 侧一律 403，因为 cookie 根本没带上）。
 */
function corsHeaders(req: IncomingMessage): Record<string, string> {
  const origin = String(req.headers.origin ?? '');
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'vary': 'Origin',
    'access-control-max-age': '600',
  };
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

  /**
   * 网关自己持有的 DSH 鉴权 cookie。
   *
   * ⚠️ 2026-10-16 关键修正（独立 App 流程实测暴露）：
   *   手机端只跟**网关**打交道（有我们自己的令牌），它**不可能**有 DSH 的 cookie。
   *   之前把 DSH 的令牌/cookie 透传指望浏览器带着 —— 独立 App 场景下浏览器根本没有，
   *   于是到了 DSH 侧全部未认证（403/401）。
   *   正确做法：**网关在服务端自己跟 DSH 建立会话**（用 DSH 的 token 换 cookie 并缓存），
   *   转发时注入这个 cookie。这样手机端只需要我们自己的令牌，DSH 的凭据不出网关。
   */
  let dshCookie = '';
  let dshAuthPromise: Promise<string> | null = null;
  function ensureDshAuth(): Promise<string> {
    if (dshCookie || dshAuthPromise) return dshAuthPromise ?? Promise.resolve(dshCookie);
    dshAuthPromise = new Promise<string>((resolve) => {
      try {
        const req = agent.request(
          {
            protocol: dshUrl.protocol,
            hostname: dshUrl.hostname,
            port: dshUrl.port || (isHttps ? 443 : 80),
            method: 'GET',
            path: `/?token=${encodeURIComponent(opts.dshToken)}`,
            headers: { host: dshUrl.host },
          },
          (res) => {
            const sc = res.headers['set-cookie'];
            const list = Array.isArray(sc) ? sc : sc ? [sc] : [];
            const auth = list.map((c) => String(c).split(';')[0]).filter((c) => c.startsWith('dsh-auth-'));
            dshCookie = auth.join('; ');
            res.resume();
            resolve(dshCookie);
          },
        );
        req.on('error', () => resolve(''));
        req.end();
      } catch {
        resolve('');
      }
    });
    return dshAuthPromise;
  }

  const server: Server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  /** 普通 HTTP 请求：鉴权 → 反代 */
  async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    // CORS：预检直接放行；其余响应统一带上（独立 App 从本地壳访问网关时必需）
    const cors = corsHeaders(req);
    if ((req.method ?? '').toUpperCase() === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

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

    // 调试：把经网关的 /api/* 请求记下来（手机端 1.1.0 要自己实现通信层，
    // 这是"读官方客户端实际发了什么"的最可靠手段 —— 比翻生成代码快得多）。
    // 记录所有**非静态资源**请求（资源路径形如 plugins/??…/client.js，量太大不要记）
    const isAsset = url.pathname.startsWith('/plugins/') || /\.(js|css|map|png|svg|woff2?|ico)$/.test(url.pathname);
    if (process.env.DSH_GW_DEBUG === '1' && !isAsset) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        chunks.push(c);
        if (chunks.reduce((n, b) => n + b.length, 0) < 4096) return;
      });
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 400);
        console.error(`[gw] ${req.method ?? ''} ${url.pathname} body=${body}`);
      });
    }

    // ③ 反代到 127.0.0.1 上的 DSH。先确保网关自己已与 DSH 建立会话（服务端持有 cookie）。
    await ensureDshAuth();

    // ③ 反代到 127.0.0.1 上的 DSH（带上 DSH 自己的令牌）
    //
    // ⚠️ 2026-10-16 真机联调抓到的 bug（替身测试永远测不出来）：
    //    DSH 第一次带 `?token=` 访问会 **303 重定向到 `./`**，而那个**相对地址把我们自己的
    //    令牌丢了** —— 浏览器随后只带 cookie 来。过去我们只在 `?token=`/请求头里认令牌、
    //    却**从不下发自己的 cookie** → 手机端一过重定向就 401 卡死（页面白屏）。
    //    修法：令牌来自 query 时，顺手下发一个 HttpOnly 的 `dsh_mobile` cookie（见下方
    //    setCookieOnProxy）。DSH 自己的 `dsh-auth-*` cookie 照旧透传。
    const fromQuery = (url.searchParams.get('token') ?? '') !== '';
    const headers: http.OutgoingHttpHeaders = { ...req.headers };
    delete headers.host;
    delete headers.authorization;
    // 用我们自己的 cookie 名承载会话令牌，避免与 DSH 自身 cookie 冲突
    // 用**网关自己的** DSH cookie 覆盖浏览器带来的 cookie（浏览器那份跟我们无关）；
    // 同时确保 `dsh_mobile`（我们自己的令牌）不外传。
    headers.cookie = dshCookie;

    // ⚠️ 去掉浏览器的 `Origin`/`Referer`：对 DSH 来说，真正的调用方是**网关**（服务端），
    //    带着手机页面的来源会被 DSH 的来源校验挡下 —— 实测表现为 `/mobile/api/*`（我们插件，
    //    不校验来源）200，而 DSH 自己的 `/api/*` 一律 403。
    delete headers.origin;
    delete headers.referer;
    delete headers['sec-fetch-site'];
    delete headers['sec-fetch-mode'];
    delete headers['sec-fetch-dest'];
    const upstreamReq = agent.request(
      {
        protocol: dshUrl.protocol,
        hostname: dshUrl.hostname,
        port: dshUrl.port || (isHttps ? 443 : 80),
        method: req.method,
        path: upstreamPath(req.url ?? '/', opts.dshToken, dshCookie !== ''),
        headers,
      },
      (upstreamRes) => {
        if (process.env.DSH_GW_DEBUG === '1') {
          const code = String(upstreamRes.statusCode);
          console.error(`[gw] upstream ${code} ${req.url ?? ''} cookie=${dshCookie ? '有' : '无'}`);
          // 4xx 时把上游正文打出来（定位 403 到底是谁拒绝、为什么 —— 只看状态码查不动）
          if (/^4/.test(code)) {
            const chunks: Buffer[] = [];
            upstreamRes.on('data', (c: Buffer) => chunks.push(c));
            upstreamRes.on('end', () => {
              console.error(`[gw] upstream body ${code}: ${Buffer.concat(chunks).toString('utf8').slice(0, 300)}`);
            });
          }
          console.error(`[gw] sent headers: ${JSON.stringify({ host: headers.host, cookie: String(headers.cookie ?? '').slice(0, 40), origin: headers.origin ?? null, referer: headers.referer ?? null, 'content-type': headers['content-type'] })}`);
        }
        const outHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
        if (fromQuery) {
          // 把 DSH 原本的 Set-Cookie 保留，并**追加**我们自己的会话 cookie
          const existing = upstreamRes.headers['set-cookie'];
          const list = Array.isArray(existing) ? [...existing] : existing ? [existing] : [];
          list.push(
            `dsh_mobile=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${String(Math.floor(pairTtlMs / 1000) + 3600)}`,
          );
          outHeaders['set-cookie'] = list;
        }
        res.writeHead(upstreamRes.statusCode ?? 502, outHeaders);
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
    void ensureDshAuth();
    const url = new URL(req.url ?? '/', 'http://placeholder');
    if (process.env.DSH_GW_DEBUG === '1') {
      console.error(`[gw] WS ${req.url ?? ''}`);
    }
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
      path: upstreamPath(req.url ?? '/', opts.dshToken, dshCookie !== ''),
      headers: { ...req.headers, cookie: dshCookie, host: dshUrl.host },
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
 * 本地生成二维码 SVG（**不联网**）。
 *
 * 为什么不用在线二维码服务：配对载荷里含一次性配对码与网关地址 —— 发给第三方服务
 * 等于把"临时钥匙"递给别人。用 `qrcode-generator`（MIT、无依赖）在本地画。
 */
/** 二维码模块矩阵（true=黑）。用于**结构断言**：模块数、三个定位图案、时序图案。 */
export function qrMatrix(text: string): boolean[][] {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const qrcode = require('qrcode-generator') as (
    type: number,
    ec: string,
  ) => { addData(d: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean };
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const m: boolean[][] = [];
  for (let r = 0; r < n; r += 1) {
    const row: boolean[] = [];
    for (let c = 0; c < n; c += 1) row.push(qr.isDark(r, c));
    m.push(row);
  }
  return m;
}

export function qrSvg(text: string, size = 260): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const qrcode = require('qrcode-generator') as (
    type: number,
    ec: string,
  ) => { addData(d: string): void; make(): void; createSvgTag(o: Record<string, unknown>): string; getModuleCount(): number };
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const cell = Math.max(2, Math.floor(size / (qr.getModuleCount() + 4)));
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
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
