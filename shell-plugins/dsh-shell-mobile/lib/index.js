/**
 * @deepwhale-cn/dsh-shell-mobile —— 深鲸 **手机端接口层**（宿主侧插件）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么有这个插件（2026-10-16 定案，方案 B）
 * ──────────────────────────────────────────────────────────────────────
 * 用户要求：手机端**必须有我们自己的东西**，DSH 只当底座。所以：
 *   · 不复用官方客户端模块；
 *   · 不逆向官方 RPC 协议（方法名藏在生成的 typert 层里，反推成本高且随版本漂移）；
 *   · 而是**我们自己在宿主里开一套接口**，手机端（我们的辉光 UI）只调它。
 *
 * 数据链路：
 *   手机端 UI →（我们的网关：局域网 + 一次性配对码 + 令牌）→ /mobile/api/*（本插件）
 *            → DSH 的插件服务（sessions / sessionQuery / …）
 *
 * 因此接口契约是**我们自己的**，可以像桌面端那样用断言守住；DSH 升级时唯一的
 * 适配点就是本文件。
 *
 * 安全边界（重要）
 *   · DSH 的 web 服务器只监听 127.0.0.1，外部设备**本来就到不了**本路由；
 *     手机必须经我们的网关（网关负责配对与令牌）。
 *   · 本插件只接受**回环地址**来的请求 —— 多一道闸，防止本机其它程序越权。
 *
 * 现阶段实现范围
 *   /mobile/api/health          健康检查（通了/没通一眼可见）
 *   /mobile/api/_services       **自报家底**：把注入到的服务与其方法名 dump 出来
 *   /mobile/api/sessions        会话列表（尽力而为：服务形状不认识时如实返回原因，不抛异常）
 *   /mobile/api/session?id=…    单个会话（详情/消息，同上"尽力而为"）
 *   /mobile/api/prompt          （未实现，明确返回 not-implemented，绝不假装成功）
 *
 * ⚠️ 「尽力而为 + 如实返回原因」是刻意的：宁可接口明确说"我还不认识这个服务的形状"，
 *    也不要返回一个看起来成功、实际是空的数据（那是假绿，桌面端已经吃过亏）。
 */

export const name = 'shell-mobile';

/**
 * cordis 的 `inject` 是"要什么写什么"，**缺一个就整个插件不 apply**（实测：写
 * `inject: ['webServer','sessions']` 时若 sessions 不在，插件直接挂掉）。
 * 所以这里只注入**一定存在**的 `webServer`；会话等服务用 `ctx.get(...)` 可选获取，
 * 取不到就如实返回原因（宁可接口说"我还没接上"，也不要整块功能不生效）。
 */
export const inject = ['webServer'];

/** 路由前缀（网关与手机端都按这个约定来） */
export const ROUTE = '/mobile/api';

const PLUGIN_VERSION = '0.1.0';

/** 只允许回环地址访问（DSH 本来也只监听回环；这是第二道闸） */
function isLoopback(req) {
  const addr = req?.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/** 把一个对象的方法名与属性名整理出来（用于自报家底） */
function describe(value, depth = 2, seen = new Set()) {
  if (value === null || value === undefined) return { type: String(value) };
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return { type: t, sample: t === 'string' ? value.slice(0, 80) : undefined };
  if (seen.has(value) || depth <= 0) return { type: t, circular: seen.has(value) };
  seen.add(value);
  const out = { type: t };
  if (t === 'function') {
    out.arity = value.length;
    return out;
  }
  const proto = Object.getPrototypeOf(value);
  const names = new Set();
  for (const k of Object.getOwnPropertyNames(value)) names.add(k);
  if (proto && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (k !== 'constructor') names.add(k);
    }
  }
  out.keys = [...names]
    .filter((k) => !k.startsWith('_'))
    .slice(0, 60)
    .map((k) => {
      let v;
      try {
        v = value[k];
      } catch {
        return `${k}: <getter threw>`;
      }
      const vt = typeof v;
      if (vt === 'function') return `${k}(${v.length})`;
      if (vt === 'object' && v !== null) return `${k}: ${Array.isArray(v) ? `array(${v.length})` : 'object'}`;
      return `${k}: ${vt}`;
    });
  return out;
}

export function apply(ctx) {
  const log = (m) => {
    try {
      ctx.logger?.info?.(`[shell-mobile] ${m}`);
    } catch {
      /* 日志失败不影响功能 */
    }
  };

  // 自报家底用：把 ctx 上能看到的服务名与形状记下来
  const services = {};
  let lastError = '';
  try {
    for (const key of ['sessions', 'sessionQuery', 'sessionProjections', 'agents', 'workspaceRegistry']) {
      let v;
      try {
        v = typeof ctx.get === 'function' ? ctx.get(key) : undefined;
      } catch {
        v = undefined;
      }
      services[key] = describe(v);
    }
  } catch (e) {
    services.__error = String(e?.message ?? e);
  }

  /**
   * 会话列表。**实测得出的正解**（而不是猜的）：
   *   · `sessions.list()` ✓ 存在；
   *   · `sessionQuery.searchSessions()` 在本部署被**禁用**
   *     （报 `session search is disabled: … index with openAt "never"`）→ 不能用。
   * 这正说明"自报家底 + 如实返回原因"的做法是对的：先说清哪条路能走，再写死。
   */
  async function listSessions() {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
    if (!sessions) return { ok: false, reason: 'no-sessions-service' };
    const attempts = [
      ['sessions.list()', () => sessions.list?.()],
      ['sessions.list({})', () => sessions.list?.({})],
    ];
    for (const [label, run] of attempts) {
      try {
        const v = await run();
        if (v === undefined || v === null) continue;
        const arr = Array.isArray(v) ? v : Array.isArray(v.items) ? v.items : Array.isArray(v.sessions) ? v.sessions : null;
        if (!arr) return { ok: false, reason: 'unexpected-shape', via: label, shape: describe(v, 2) };
        return {
          ok: true,
          via: label,
          count: arr.length,
          sampleKeys: arr[0] ? Object.keys(arr[0]).slice(0, 24) : [],
          sessions: arr.slice(0, 200).map((x) => ({
            id: x?.id ?? x?.sessionId ?? x?.key ?? null,
            title: x?.title ?? x?.name ?? null,
            updatedAt: x?.updatedAt ?? x?.lastActivityAt ?? null,
            workspace: x?.workspace ?? x?.workspacePath ?? null,
          })),
        };
      } catch (e) {
        lastError = String(e?.message ?? e);
      }
    }
    return { ok: false, reason: 'all-shapes-failed', lastError, services };
  }

  /** 单个会话：先取会话本体（sessions.get），消息等投影接口定型后再补 */
  async function getSession(id) {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
    if (!sessions?.get) return { ok: false, reason: 'no-sessions.get' };
    if (!id) return { ok: false, reason: 'missing-id' };
    try {
      const v = await sessions.get(id);
      return { ok: true, session: v ?? null, shape: v ? describe(v, 2) : null };
    } catch (e) {
      return { ok: false, reason: 'get-failed', error: String(e?.message ?? e) };
    }
  }

  async function handler(req, res) {
    if (!isLoopback(req)) {
      json(res, 403, { ok: false, reason: 'loopback-only' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    if (path === `${ROUTE}/health`) {
      json(res, 200, { ok: true, plugin: name, version: PLUGIN_VERSION, injected: Object.keys(services) });
      return;
    }

    if (path === `${ROUTE}/_services`) {
      json(res, 200, { ok: true, services });
      return;
    }

    if (path === `${ROUTE}/sessions`) {
      json(res, 200, await listSessions());
      return;
    }

    if (path === `${ROUTE}/session`) {
      json(res, 200, await getSession(url.searchParams.get('id') ?? ''));
      return;
    }

    if (path === `${ROUTE}/prompt`) {
      json(res, 501, { ok: false, reason: 'not-implemented' });
      return;
    }

    json(res, 404, { ok: false, reason: 'unknown-route', route: ROUTE });
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'dsh-shell-mobile: /mobile/api 出口',
  );
  log(`已挂载 ${ROUTE}（手机端接口层 v${PLUGIN_VERSION}）`);
}
