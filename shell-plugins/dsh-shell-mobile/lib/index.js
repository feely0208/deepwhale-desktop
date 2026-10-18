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

import { statSync as statSyncFs, createReadStream as createReadStreamFs, readFileSync as readFileSyncFs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join as joinPath, normalize as normPath } from 'node:path';

export const name = 'shell-mobile';

/** 手机端界面所在目录（构建时由 scripts/build-bundled-plugins.js 把 mobile-ui/ 拷进来） */
const UI_DIR = joinPath(dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

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

/** 事件类型 → 中文标签（轨迹视图用）。未知类型保留原样，**不假装知道**。 */
const EVENT_LABELS = {
  'turn/start': '回合开始',
  'turn/end': '回合结束',
  'step/start': '步骤开始',
  'step/end': '步骤结束',
  'user/message': '用户消息',
  'system/message': '系统消息',
  'assistant/attempt': '模型回复',
  'assistant/stream': '模型输出',
  'session/title': '会话标题',
  'request/header': '请求头',
  'request/context': '请求上下文',
  'approval/policy': '审批策略',
  'permission/preset': '权限预设',
  'sandbox/mode': '沙箱模式',
  'agent/inbox/spliced': '队列变更',
  'tool/use': '工具调用',
  'tool/result': '工具结果',
};

function textOf(message) {
  const parts = Array.isArray(message?.content) ? message.content : [];
  return parts
    .filter((p) => p?.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text)
    .join('\n');
}

/** 把 DSH 的事件整理成手机端轨迹要的形态（对外契约，收在插件里） */
function normalizeEvents(events) {
  return (events || []).slice(-300).map((e) => {
    const type = String(e?.type ?? '');
    const d = e?.data ?? {};
    let detail = '';
    if (type === 'session/title') detail = String(d.title ?? '');
    else if (type === 'user/message') detail = textOf(d.message).slice(0, 120);
    else if (type === 'system/message') detail = textOf(d.message).slice(0, 80);
    // 编号用原始值：实测数据本身就是 1-based，之前 +1 会多算一轮（截图里"第 2 轮"其实只有 1 轮）
    else if (type === 'turn/start') detail = `第 ${String(d.turn ?? 1)} 轮`;
    else if (type === 'step/start') detail = `第 ${String(d.step ?? 1)} 步`;
    else if (type === 'tool/use') detail = String(d.name ?? d.tool ?? '');
    else if (type === 'approval/policy') detail = String(d.policy ?? '');
    else if (type === 'sandbox/mode') detail = String(d.mode ?? '');
    else if (type === 'permission/preset') detail = String(d.preset ?? '');
    return {
      seq: e?.seq ?? null,
      type,
      label: EVENT_LABELS[type] ?? type,
      time: e?.time ?? null,
      detail,
    };
  });
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
    for (const key of [
      'sessions',
      'sessionQuery',
      'sessionProjections',
      'agents',
      'workspaceRegistry',
      // 宿主把会话接口实现挂成服务时可能叫这些名字（生成代码里出现过 sessionController）
      'sessionController',
      'sessionApi',
      'apiSession',
      'attachments',
      'connection',
      'typert',
    ]) {
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
          sessions: arr.slice(0, 200).map((x) => {
            const h = x?.header && typeof x.header === 'object' ? x.header : {};
            return {
              id: x?.id ?? x?.sessionId ?? x?.key ?? null,
              title: h.title ?? x?.title ?? null,
              updatedAt: h.updatedAt ?? h.lastActivityAt ?? x?.updatedAt ?? null,
              workspace: h.workspace ?? h.workspacePath ?? x?.workspace ?? null,
            };
          }),
        };
      } catch (e) {
        lastError = String(e?.message ?? e);
      }
    }
    return { ok: false, reason: 'all-shapes-failed', lastError, services };
  }

  /**
   * 单个会话 + 消息。实测形状（见探针输出）：
   *   会话对象：`id` / `header`（标题等在这里）/ `log` / `seq`
   *             方法：`deriveMessages()` / `snapshotEvents()` / `requestHeader()` …
   * → 所以标题从 `header` 取、消息从 `deriveMessages()` 取，**都是实测出来的**。
   */
  async function getSession(id) {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
    if (!sessions?.get) return { ok: false, reason: 'no-sessions.get' };
    if (!id) return { ok: false, reason: 'missing-id' };
    let v;
    try {
      v = await sessions.get(id);
    } catch (e) {
      return { ok: false, reason: 'get-failed', error: String(e?.message ?? e) };
    }
    if (!v) return { ok: false, reason: 'not-found', id };

    const header = v.header && typeof v.header === 'object' ? v.header : null;
    let messages = null;
    let messagesError = '';
    try {
      if (typeof v.deriveMessages === 'function') messages = v.deriveMessages();
      else if (typeof v.snapshotEvents === 'function') messages = v.snapshotEvents();
    } catch (e) {
      messagesError = String(e?.message ?? e);
    }
    const arr = Array.isArray(messages) ? messages : null;
    return {
      ok: true,
      id: v.id ?? id,
      title: header?.title ?? null,
      headerKeys: header ? Object.keys(header).slice(0, 24) : [],
      header: header ? describe(header, 2) : null,
      // 规范化消息：**这是我们自己的接口契约**（把 DSH 的内部形状收在插件里，
      // 手机端只认 role/text/source —— 上游怎么变都只改这一处）。
      messages: arr
        ? arr.slice(-200).map((m) => ({
            id: m?.id ?? null,
            role: m?.role ?? null,
            text: (Array.isArray(m?.content) ? m.content : [])
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text)
              .join('\n'),
            source: m?.source?.kind ?? null,
            // 区分"真聊天"与"上下文注入"：DSH 会把运行时上下文/skill 清单作为
            // user 角色塞进来（实测首条就是 <system-reminder>…）——手机端不该显示它们。
            kind: (() => {
              const src = String(m?.source?.kind ?? '');
              const txt = (Array.isArray(m?.content) ? m.content : [])
                .filter((part) => part?.type === 'text' && typeof part.text === 'string')
                .map((part) => part.text)
                .join('\n');
              if (src && src !== 'user' && src !== 'assistant') return 'context';
              if (/^\s*<(system-reminder|available_skills|runtime-context)\b/i.test(txt)) return 'context';
              if (/^\s*<[a-z_-]+>\s*$/i.test(txt)) return 'context';
              return 'chat';
            })(),
          }))
        : [],
      messageCount: arr ? arr.length : null,
      messageKeys: arr?.[0] ? Object.keys(arr[0]).slice(0, 24) : [],
      messagesSample: arr ? arr.slice(0, 2).map((m) => describe(m, 2)) : null,
      contentPartTypes: arr && arr[0] && Array.isArray(arr[0].content)
        ? arr[0].content.slice(0, 8).map((p) => String(p?.type ?? typeof p))
        : null,
      contentPartKeys: arr && arr[0] && Array.isArray(arr[0].content)
        ? arr[0].content.slice(0, 4).map((p) => (p && typeof p === 'object' ? Object.keys(p) : null))
        : null,
      allRoles: arr ? arr.map((m) => m.role ?? null) : null,
      // ⚠️ 真机实测：`deriveMessages()` 只有"输入侧"（allRoles 里一个 assistant 都没有），
      //    助手回复在 DSH 的**投影**里：rows.turnOutline.val.turns[] = {turn, prompt, response}。
      //    手机端聊天必须用这个，否则只能看到用户自己说的话（用户实测反馈）。
      turns: (() => {
        try {
          const proj = typeof ctx.get === "function" ? ctx.get("sessionProjections") : undefined;
          const st = proj?.stateOf ? proj.stateOf(id) : null;
          const outline = st?.rows?.turnOutline?.val ?? st?.turnOutline?.val ?? null;
          if (!outline || !Array.isArray(outline.turns)) return [];
          return outline.turns.map((t) => ({
            turn: t?.turn ?? null,
            prompt: String(t?.prompt ?? ""),
            response: String(t?.response ?? ""),
          }));
        } catch (e) {
          return [];
        }
      })(),
      messagesError,
    };
  }

  /**
   * 新建会话（手机端"新建会话"要用）。`sessions.create(2)` 实测存在，但入参形状未知 →
   * 多试几种，把有效的那种报出去。
   */
  async function createSession(payload) {
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
    if (!sessions?.create) return { ok: false, reason: 'no-sessions.create' };
    const attempts = [
      ['create()', () => sessions.create()],
      ['create({})', () => sessions.create({})],
      ['create(payload)', () => sessions.create(payload ?? {})],
    ];
    for (const [label, run] of attempts) {
      try {
        const v = await run();
        if (v === undefined || v === null) continue;
        return {
          ok: true,
          via: label,
          id: v?.id ?? v?.sessionId ?? null,
          shape: describe(v, 2),
        };
      } catch (e) {
        lastError = String(e?.message ?? e);
      }
    }
    return { ok: false, reason: 'all-shapes-failed', lastError };
  }

  /**
   * 发消息（prompt）。**按宿主实现的真实流程来**（读 `dsh-api-session-controller` 的
   * `prompt()` 得出，不是猜）：
   *   const agent = agents.get(sessionId)
   *   const message = createUserMessage({ content, source })
   *   agent.followup(message)        // mode === 'steer' 时用 agent.steer(message)
   * `createUserMessage` 来自 DSH 的基础包 `@deepseek-ai/dsh-llm`（**底座 API**，可以 import）。
   */
  async function sendPrompt({ sessionId, text, mode } = {}) {
    if (!sessionId) return { ok: false, reason: 'missing-sessionId' };
    if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty-text' };
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    if (!agents?.get) return { ok: false, reason: 'no-agents.get' };
    let agent;
    try {
      agent = agents.get(sessionId);
    } catch (e) {
      return { ok: false, reason: 'agent-get-failed', error: String(e?.message ?? e) };
    }
    if (!agent) return { ok: false, reason: 'agent-not-found', sessionId, hint: '先 POST /mobile/api/session 新建，或确认 sessionId' };

    let createUserMessage;
    try {
      ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'));
    } catch (e) {
      return { ok: false, reason: 'cannot-import-dsh-llm', error: String(e?.message ?? e) };
    }
    const rpcId = `mobile-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      // 文本内容先经 attachments 准入（与宿主一致）；该服务取不到时退回裸文本块
      const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
      let content = [{ type: 'text', text }];
      if (attachments?.admitPromptContent) {
        try {
          content = await attachments.admitPromptContent(content);
        } catch {
          /* 准入失败就按裸文本走，让下游给出真实错误 */
        }
      }
      const message = createUserMessage({ content, source: { kind: 'user', rpcId } });
      const fn = mode === 'steer' ? agent.steer : agent.followup;
      if (typeof fn !== 'function') {
        return { ok: false, reason: mode === 'steer' ? 'no-agent.steer' : 'no-agent.followup', agentKeys: describe(agent, 2).keys };
      }
      await fn.call(agent, message);
      return { ok: true, accepted: true, rpcId, mode: mode ?? 'followup' };
    } catch (e) {
      return { ok: false, reason: 'prompt-failed', error: String(e?.message ?? e) };
    }
  }

  /**
   * 【开发用】把"让某个会话拥有活跃 agent"这一步**试出来**（宿主内部有 resolve/resume
   * 机制，但那是 controller 私有面；插件能用的是 sessions/agents 两个服务）。
   * 逐个候选调用，**报出哪一个真的让 agents.get(id) 变成有值** —— 不猜。
   */
  async function activateAgent(sessionId) {
    const agents = typeof ctx.get === 'function' ? ctx.get('agents') : undefined;
    const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
    if (!agents?.get || !sessions) return { ok: false, reason: 'bad-input' };
    const id = sessionId && sessionId !== '' ? sessionId : `mobile-${Date.now().toString(36)}`;
    const already = agents.get(id);
    if (already) return { ok: true, already: true, via: 'agents.get', id };

    const tried = [];
    // 候选链（每个都试，报出返回了什么 / 抛了什么）
    const chains = [
      ['prepare→enter(obs)→get', async () => {
        const obs = await sessions.prepare(id, {});
        const entered = await sessions.enter(obs);
        return { obs, entered };
      }],
      ['prepare→get', async () => sessions.prepare(id, {})],
      ['enter(prepare(id,{}))→get', async () => sessions.enter(await sessions.prepare(id, {}))],
    ];
    for (const [label, run] of chains) {
      try {
        const v = await run();
        const live = agents.get(id);
        tried.push(`${label}: ok，get→${live ? '有 agent' : '仍为空'}`);
        if (live) {
          return {
            ok: true,
            via: label,
            id,
            agentKeys: describe(live, 2).keys,
            preparedKeys: describe(v?.obs ?? v, 1).keys,
            tried,
          };
        }
      } catch (e) {
        tried.push(`${label}: 抛错 ${String(e?.message ?? e).slice(0, 140)}`);
      }
    }
    return { ok: false, reason: 'no-chain-worked', id, tried };
  }

  async function handler(req, res) {
    if (!isLoopback(req)) {
      json(res, 403, { ok: false, reason: 'loopback-only' });
      return;
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;

    // ── 手机端界面本体：/mobile/ → 插件自带 ui/ 目录（与 API 同源，手机端免跨域）──
    // ⚠️ 必须排除 API 前缀：只写 `startsWith('/mobile/')` 会把 /mobile/api/* 也吃进来
    // （实测：所有 API 都变成 404 "mobile ui not found"）。API 优先。
    if ((path === '/mobile' || path.startsWith('/mobile/')) && !path.startsWith(`${ROUTE}`)) {
      const rel = path === '/mobile' || path === '/mobile/' ? 'index.html' : path.slice('/mobile/'.length);
      const target = joinPath(UI_DIR, normPath(rel).replace(/^(\.\.[/\\])+/, ''));
      try {
        const st = statSyncFs(target);
        if (!st.isFile()) throw new Error('not a file');
        const ext = target.slice(target.lastIndexOf('.'));
        res.writeHead(200, {
          'content-type': MIME[ext] ?? 'application/octet-stream',
          'content-length': st.size,
          'cache-control': 'no-store',
        });
        createReadStreamFs(target).pipe(res);
        return;
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('mobile ui not found（构建时是否把 mobile-ui/ 拷进插件？）');
        return;
      }
    }

    if (path === `${ROUTE}/health`) {
      json(res, 200, { ok: true, plugin: name, version: PLUGIN_VERSION, injected: Object.keys(services) });
      return;
    }

    if (path === `${ROUTE}/_dev/activate`) {
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', async () => {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          payload = {};
        }
        json(res, 200, await activateAgent(payload.sessionId));
      });
      return;
    }

    if (path === `${ROUTE}/_dev/routes`) {
      const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
      const conn = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
      const keys = (o) => (o ? Object.keys(o).filter((k) => !k.startsWith('_')).slice(0, 40) : null);
      const dump = {
        webServerKeys: keys(ws),
        exact: ws?.exact ? [...ws.exact.keys()].slice(0, 80) : null,
        prefixes: ws?.prefixes ? [...ws.prefixes.keys()].slice(0, 80) : null,
        upgrades: ws?.upgrades ? [...ws.upgrades.keys()].slice(0, 40) : null,
        connectionKeys: keys(conn),
        fetchKeys: conn?.fetch ? keys(conn.fetch) : null,
        fetchRoutes: conn?.fetchRoutes
          ? conn.fetchRoutes instanceof Map
            ? [...conn.fetchRoutes.keys()].slice(0, 120)
            : Object.keys(conn.fetchRoutes).slice(0, 120)
          : null,
        exactRoutes: ws?.exact ? [...ws.exact.keys()] : null,
        // /api 前缀路由是谁注册的（谁就掌握方法名映射）
        apiRoute: (() => {
          try {
            const r = ws?.prefixes?.get?.('/api');
            if (!r) return null;
            return { kind: r.kind, path: r.path, ownerKeys: r.handler ? Object.keys(r.handler).slice(0, 20) : null, ownerName: r.handler?.name ?? null };
          } catch (e) {
            return String(e?.message ?? e);
          }
        })(),
        // typert 的远端面（方法名可能在这里）
        rpcNames: (() => {
          const t = typeof ctx.get === 'function' ? ctx.get('typert') : undefined;
          if (!t) return null;
          const keysOf = (o) => {
            try {
              if (o instanceof Map) return [...o.keys()];
              if (o && typeof o === 'object') return Object.keys(o);
            } catch {}
            return null;
          };
          const desc = t.remoteStore?.descriptors;
          const entries = desc?.entries;
          return {
            descriptors: keysOf(desc)?.slice(0, 120) ?? null,
            entries: keysOf(entries)?.slice(0, 200) ?? null,
            ids: keysOf(desc?.ids)?.slice(0, 200) ?? null,
            definitions: keysOf(t.lookupStore?.definitions)?.slice(0, 200) ?? null,
          };
        })(),
        typertStores: (() => {
          const t = typeof ctx.get === 'function' ? ctx.get('typert') : undefined;
          if (!t) return null;
          const sh = (o) => (o && typeof o === 'object' ? Object.keys(o).slice(0, 60) : null);
          return { remoteStore: sh(t.remoteStore), lookupStore: sh(t.lookupStore), contextStore: sh(t.contextStore), packages: sh(t.packages) };
        })(),
      };
      json(res, 200, { ok: true, dump });
      return;
    }

    if (path === `${ROUTE}/_dev/events`) {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      const id = url.searchParams.get('id') ?? '';
      const sess = id && sessions?.get ? sessions.get(id) : null;
      if (!sess) {
        json(res, 200, { ok: false, reason: 'session-not-found', id });
        return;
      }
      const out = { ok: true };
      try {
        const evs = sess.snapshotEvents();
        const counts = {};
        (evs || []).forEach((e) => {
          const t = String(e?.type ?? '?');
          counts[t] = (counts[t] ?? 0) + 1;
        });
        out.typeCounts = counts;
        const first = (evs || []).find((e) => /tool/i.test(String(e?.type ?? '')));
        out.firstTool = first ? { type: first.type, dataKeys: first.data ? Object.keys(first.data).slice(0, 16) : null } : null;
        const typesWithData = {};
        (evs || []).slice(0, 8).forEach((e) => {
          typesWithData[String(e?.type)] = e?.data && typeof e.data === 'object' ? Object.keys(e.data).slice(0, 10) : null;
        });
        out.sampleDataKeys = typesWithData;
      } catch (e) {
        out.typeCounts = 'ERR ' + String(e?.message ?? e).slice(0, 120);
      }
      for (const fn of ['snapshotEvents', 'ownEvents', 'deriveMessages']) {
        try {
          const v = typeof sess[fn] === 'function' ? sess[fn]() : undefined;
          out[fn] = Array.isArray(v)
            ? { count: v.length, sample: v.slice(0, 2).map((e) => describe(e, 2)) }
            : describe(v, 2);
        } catch (e) {
          out[fn] = 'ERR ' + String(e?.message ?? e).slice(0, 100);
        }
      }
      json(res, 200, out);
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

    if (path === `${ROUTE}/trajectory`) {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      const id = url.searchParams.get('id') ?? '';
      const sess = id && sessions?.get ? sessions.get(id) : null;
      if (!sess) {
        json(res, 200, { ok: false, reason: 'session-not-found', id });
        return;
      }
      let events = [];
      try {
        events = typeof sess.snapshotEvents === 'function' ? sess.snapshotEvents() : [];
      } catch (e) {
        json(res, 200, { ok: false, reason: 'events-failed', error: String(e?.message ?? e) });
        return;
      }
      json(res, 200, { ok: true, count: events.length, events: normalizeEvents(events) });
      return;
    }

    if (path === `${ROUTE}/session`) {
      if ((req.method ?? 'GET').toUpperCase() === 'POST') {
        let body = '';
        req.on('data', (c) => {
          body += c;
        });
        req.on('end', async () => {
          let payload = {};
          try {
            payload = body ? JSON.parse(body) : {};
          } catch {
            payload = {};
          }
          json(res, 200, await createSession(payload));
        });
        return;
      }
      json(res, 200, await getSession(url.searchParams.get('id') ?? ''));
      return;
    }

    if (path === `${ROUTE}/prompt`) {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        json(res, 405, { ok: false, reason: 'use-post' });
        return;
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', async () => {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          payload = {};
        }
        json(res, 200, await sendPrompt(payload));
      });
      return;
    }

    json(res, 404, { ok: false, reason: 'unknown-route', route: ROUTE });
  }

  // ⚠️ 注册的是 **/mobile**（不是 /mobile/api）：手机端界面(/mobile/)与接口(/mobile/api/*)
  // 都要经过这里。只注册 /mobile/api 时 /mobile/ 根本进不来（实测 404）。
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: '/mobile', handler }),
    'dsh-shell-mobile: /mobile 出口（界面 + 接口）',
  );
  log(`已挂载 ${ROUTE}（手机端接口层 v${PLUGIN_VERSION}）`);
}
