/**
 * 手机端「在外面用」的隧道客户端（桌面端主动外连我们的中继）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要：手机在**外面**（4G/别人家 WiFi）时，电脑没有公网 IP，手机够不着 ✗。
 * 做法：本模块从桌面端**主动外连**中继（出站，不用开端口、不用公网 IP），中继把手机的
 * HTTP 请求转发回来，我们转给本机的手机网关（127.0.0.1:<gatewayPort>），响应再回传。
 *
 * 拓扑：
 *   手机 ──HTTPS──▶ https://deepwhale.org.cn/_relay/t/<隧道ID>/…（中继，VPS）
 *                                   ▲
 *                                   │ WSS（本模块主动连）
 *                                   │
 *                          桌面端（本文件的 startMobileTunnel）→ 127.0.0.1:<网关端口>
 *
 * 安全：
 *   · 隧道 ID = HMAC-SHA256(secret, 'deepwhale-tunnel')[:16]，secret 只在本机与中继之间
 *     用于认领隧道（本机生成并持久化，不经过任何第三方）；
 *   · 手机端仍要过我们网关自己的**一次性配对码 + 令牌** —— 中继只转发字节，不懂内容；
 *   · 全程 TLS（中继在 nginx 后面 + 中继↔桌面也是 WSS）。
 *
 * 为什么用 WebSocket：Electron 44 的主进程自带全局 WebSocket（Node 22），不需要额外依赖；
 * 且中继两侧都是"长连接 + 多路请求"，WS 比 SSE/轮询都合适。
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

/** 官方中继：手机侧访问的 HTTPS 前缀（默认值；换服务器只改这一处） */
export const OFFICIAL_RELAY_HTTP_BASE = 'https://deepwhale.org.cn/_relay';
/** 兼容旧导出：官方中继的 WS 地址 */
export const OFFICIAL_RELAY_WS_URL = 'wss://deepwhale.org.cn/_relay/ws';
/** 兼容旧导出：默认中继（手机侧 HTTP 前缀 / 桌面侧 WS 地址） */
export const RELAY_HTTP_BASE = OFFICIAL_RELAY_HTTP_BASE;
export const RELAY_WS_URL = OFFICIAL_RELAY_WS_URL;

/** 一对中继地址：手机用 HTTP 前缀，桌面用同一前缀下的 /ws（两者必须同源同路径） */
export interface RelayEndpoint {
  /** 手机侧地址前缀，如 https://relay.example.com/_relay */
  httpBase: string;
  /** 桌面侧 WebSocket 地址，如 wss://relay.example.com/_relay/ws */
  wsUrl: string;
}

/**
 * 把用户填的「中继地址」规范化成一对可用地址。
 *
 * 接受三种写法（容错，不要求用户懂路径）：
 *   · https://relay.example.com            → 补成 …/_relay（与我们 relay/deploy 的 nginx 约定一致）
 *   · https://relay.example.com/           → 同上（去尾斜杠）
 *   · https://relay.example.com/myrelay    → 原样作为前缀，WS 用 …/myrelay/ws
 *
 * 只允许 http/https；非法输入直接抛错（设置界面会把它当校验失败显示）。
 */
export function relayEndpointFor(raw: string): RelayEndpoint {
  const input = String(raw ?? '').trim();
  if (input === '') throw new Error('中继地址不能为空');
  let u: URL;
  try {
    u = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error('中继地址不是合法 URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('中继地址必须以 http:// 或 https:// 开头');
  if (u.search !== '' || u.hash !== '') throw new Error('中继地址里不要带查询串或锚点');
  let pathname = u.pathname.replace(/\/+$/, '');
  // 只给了域名（没给路径）→ 按部署约定补 /_relay
  if (pathname === '') pathname = '/_relay';
  const httpBase = `${u.protocol}//${u.host}${pathname}`;
  const wsUrl = `${httpBase.replace(/^http/, 'ws')}/ws`;
  return { httpBase, wsUrl };
}

/** 默认中继（官方） */
export const DEFAULT_RELAY: RelayEndpoint = {
  httpBase: OFFICIAL_RELAY_HTTP_BASE,
  wsUrl: OFFICIAL_RELAY_WS_URL,
};

export interface TunnelHandle {
  /** 隧道 ID（手机侧 URL 里那段） */
  tunnelId: string;
  /** 手机要填的地址：${RELAY_HTTP_BASE}/t/<tunnelId> */
  remoteOrigin: string;
  /** 是否已连上中继 */
  connected: () => boolean;
  /** 断开并停止重连 */
  stop: () => void;
}

/** 由 secret 推导隧道 ID（与中继端的算法必须一致） */
export function tunnelIdFor(secret: string): string {
  return crypto.createHmac('sha256', secret).update('deepwhale-tunnel').digest('hex').slice(0, 16);
}

/** 生成一个新的隧道密钥（32 字节 base64url） */
export function makeTunnelSecret(): string {
  return crypto.randomBytes(24).toString('base64url');
}

interface TunnelOptions {
  /** 本机手机网关的端口（127.0.0.1） */
  gatewayPort: number;
  /** 隧道密钥（持久化在壳的 userData 里） */
  secret: string;
  /** 中继 WS 地址（测试时可覆盖成本地；一般不直接用，改用 relayHttpBase） */
  relayUrl?: string;
  /** 自建中继的 HTTP 基址（如 https://relay.example.com/_relay）；缺省 = 官方中继 */
  relayHttpBase?: string;
  /** 诊断日志 */
  onLog?: (line: string) => void;
}

/**
 * 启动隧道客户端（失败会自动按 3s 退避重连；stop() 后不再重连）
 */
export function startMobileTunnel(opts: TunnelOptions): TunnelHandle {
  // 中继地址来自设置（自建）或默认（官方）；隧道 ID 算法不随中继变化，换中继只换入口
  const endpoint = relayEndpointFor(opts.relayHttpBase ?? OFFICIAL_RELAY_HTTP_BASE);
  const url = opts.relayUrl ?? endpoint.wsUrl;
  const tunnelId = tunnelIdFor(opts.secret);
  const remoteOrigin = `${endpoint.httpBase}/t/${tunnelId}`;
  const log = (m: string): void => {
    try {
      opts.onLog?.(`[tunnel] ${m}`);
    } catch {
      /* 日志失败不影响隧道 */
    }
  };

  let ws: WebSocket | null = null;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | null = null;
  let connected = false;

  const connect = (): void => {
    if (stopped) return;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log(`创建连接失败：${String((e as Error)?.message ?? e)}`);
      scheduleRetry();
      return;
    }

    ws.addEventListener('open', () => {
      connected = true;
      try {
        ws?.send(JSON.stringify({ t: 'hello', tunnel: tunnelId, secret: opts.secret }));
      } catch {
        /* 立即失败会走 close → 重连 */
      }
      log('已连上中继');
    });

    ws.addEventListener('message', (ev: MessageEvent) => {
      let msg: { t?: string; id?: number; method?: string; path?: string; headers?: Record<string, string>; body?: string };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.t !== 'req' || msg.id === undefined) return;
      forwardToGateway(opts.gatewayPort, msg, (frame) => {
        try {
          ws?.send(JSON.stringify(frame));
        } catch {
          /* 连接断了，中继会超时 */
        }
      });
    });

    ws.addEventListener('close', () => {
      if (connected) log('中继连接断开');
      connected = false;
      ws = null;
      scheduleRetry();
    });

    ws.addEventListener('error', () => {
      /* 交给 close 处理 */
    });
  };

  const scheduleRetry = (): void => {
    if (stopped || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, 3000);
  };

  connect();

  return {
    tunnelId,
    remoteOrigin,
    connected: () => connected,
    stop: () => {
      stopped = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      try {
        ws?.close();
      } catch {
        /* 已关闭 */
      }
      ws = null;
      connected = false;
    },
  };
}

/**
 * 把中继发来的一个 HTTP 请求转给本机网关，并把响应（含流式）拆成帧回传。
 *
 * 帧格式与 relay/server.js 约定一致：
 *   {t:'res', id, status, headers}       → 首帧（状态+头）
 *   {t:'res', id, body:<base64>}          → 若干数据帧
 *   {t:'res', id, end:true}               → 结束帧
 */
function forwardToGateway(
  port: number,
  req: { id?: number; method?: string; path?: string; headers?: Record<string, string>; body?: string },
  send: (frame: Record<string, unknown>) => void,
): void {
  const id = req.id;
  const headers: Record<string, string | string[]> = { ...(req.headers ?? {}) };
  // 中继传回来的是手机侧的 Host（域名）——网关只认本机地址，避免 DSH 的来源校验误判
  delete headers.host;
  if (typeof headers['content-length'] === 'string' && req.body) {
    headers['content-length'] = String(Buffer.from(req.body, 'base64').length);
  }

  const upstream = http.request(
    {
      host: '127.0.0.1',
      port,
      method: req.method ?? 'GET',
      path: req.path ?? '/',
      headers,
    },
    (res) => {
      const outHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) {
        // 逐跳头不能透传（会破坏中继那边的连接语义）
        if (k === 'connection' || k === 'transfer-encoding' || k === 'keep-alive') continue;
        outHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
      }
      send({ t: 'res', id, status: res.statusCode ?? 502, headers: outHeaders });
      res.on('data', (chunk: Buffer) => send({ t: 'res', id, body: chunk.toString('base64') }));
      res.on('end', () => send({ t: 'res', id, end: true }));
      res.on('error', () => send({ t: 'res', id, end: true }));
    },
  );
  upstream.on('error', (e: Error) => {
    send({
      t: 'res',
      id,
      status: 502,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
      body: Buffer.from(`gateway error: ${e.message}`, 'utf8').toString('base64'),
      end: true,
    });
  });
  if (req.body) upstream.write(Buffer.from(req.body, 'base64'));
  upstream.end();
}
