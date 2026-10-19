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
 * 现阶段实现范围（v0.2.0，2026-10-19）
 *   /mobile/api/health          健康检查（通了/没通一眼可见）
 *   /mobile/api/_services       **自报家底**：把注入到的服务与其方法名 dump 出来
 *   /mobile/api/sessions        会话列表（尽力而为：服务形状不认识时如实返回原因，不抛异常）
 *   /mobile/api/session?id=…    单个会话（详情/消息 + chips 元信息 + chat）
 *   /mobile/api/chat?id=…       **聊天全文 + 附件元数据**（增量解析事件日志，见 readSessionChat）
 *   /mobile/api/attachment?id=&sid=…  附件字节（只允许本会话日志引用过的 id）
 *   /mobile/api/stream?id=…     SSE：chat（全文/附件）+ turns（投影）+ approval（待审批）
 *   /mobile/api/approvals?sid=… 待审批列表（轮询兜底）
 *   /mobile/api/approval/answer 手机批准/拒绝（POST {id,outcome}）
 *   /mobile/api/prompt          发消息（文本；附件走 DSH 官方 RPC，见交接文档）
 *   /mobile/api/trajectory      轨迹（事件时间线）
 *   /mobile/api/trace           思考 + 工具调用（按轮）
 *   /mobile/api/tasks           定时任务
 *   /mobile/api/plugins         插件清单
 *
 * ⚠️ 「尽力而为 + 如实返回原因」是刻意的：宁可接口明确说"我还不认识这个服务的形状"，
 *    也不要返回一个看起来成功、实际是空的数据（那是假绿，桌面端已经吃过亏）。
 */

import { statSync as statSyncFs, createReadStream as createReadStreamFs, readFileSync as readFileSyncFs, readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
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

const PLUGIN_VERSION = '0.2.0';

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

/**
 * 从 DSH 投影缓存里读出"每一轮的问与答"。
 *
 * 为什么需要：`deriveMessages()` 只有输入侧（实测 allRoles 里没有 assistant），
 * 助手回复在投影缓存 `record.rows.turnOutline.val.turns[] = {turn, prompt, response}`。
 *
 * ⚠️ 这个文件是 **ESM**（package.json type=module），**不能用 require()** ——
 *    2026-10-18 我第一次写成 require 直接抛错、被 catch 吞掉，结果手机端还是只看得到
 *    用户自己的话（真机复现）。改用文件顶部已有的 import，并导出本函数供守卫测试真代码。
 */
export function readProjectionTurns(id, home) {
  try {
    const base = home || process.env.DSH_HOME || '';
    if (!base || !id) return [];
    const file = joinPath(base, 'storages', 'session_projcache', 'sessions', `${id}.json`);
    const rec = JSON.parse(readFileSyncFs(file, 'utf8'));
    const outline = rec?.record?.rows?.turnOutline?.val ?? rec?.rows?.turnOutline?.val ?? null;
    if (!outline || !Array.isArray(outline.turns)) return [];
    return outline.turns.map((t) => ({
      turn: t?.turn ?? null,
      prompt: String(t?.prompt ?? ''),
      response: String(t?.response ?? ''),
    }));
  } catch {
    return [];
  }
}

/**
 * 读会话投影里的「模型 / 强度 / 预设 / 工作区」——手机端 chips 显示真值用。
 *
 * 为什么读投影文件：这些值在 DSH 内部服务里是活对象，形状随版本变；投影是稳定的落盘快照，
 * 且手机端本来就是只读展示（切换模型以后再说），读文件最稳、可核对。
 */
export function readProjectionMeta(id, home) {
  const empty = { model: '', effort: '', preset: '', workspace: '' };
  try {
    const base = home || process.env.DSH_HOME || '';
    if (!base || !id) return empty;
    const file = joinPath(base, 'storages', 'session_projcache', 'sessions', `${id}.json`);
    const rows = JSON.parse(readFileSyncFs(file, 'utf8'))?.record?.rows ?? {};
    // ⚠️ modelSelection.val 是**嵌套**的（实测：{current:{model,reasoningEffort}, pending:null}）——
    //    直接读 sel.model 会得到空串（第一次就踩了 ✗）。这里在当前层 + 一层子对象里找。
    const sel = rows.modelSelection?.val ?? {};
    const pick = (key) => {
      if (typeof sel?.[key] === 'string') return sel[key];
      for (const v of Object.values(sel ?? {})) {
        if (v && typeof v === 'object' && typeof v[key] === 'string') return v[key];
      }
      return '';
    };
    return {
      model: pick('model'),
      effort: pick('reasoningEffort'),
      preset: typeof rows.agentPreset?.val === 'string' ? rows.agentPreset.val : '',
      workspace: typeof rows.workingDirectory?.val === 'string' ? rows.workingDirectory.val : '',
    };
  } catch {
    return empty;
  }
}


/**
 * 会话摘要（标题/最后活动/工作区/轮数/预览）—— 从投影缓存读，按 mtime 缓存。
 *
 * 为什么列表不能只靠 `sessions.list()`：那个接口返回的是**进程内活着的会话**
 * （dsh-session 的 SessionManager.list() = store 里的 live sessions）。
 * 桌面重启后 DSH 是全新进程，除非桌面 UI 恰好把某个会话重新打开，否则**一个都不活**
 * → 手机端列表直接空白（2026-10-19 发现：临时 DSH 里创建过带附件的会话，
 * 重启后 /mobile/api/sessions 返回 count=0）。
 * 所以列表必须**以磁盘上的会话为准**，live 信息只作为补充/覆盖。
 */
const projSummaryCache = new Map();
function readProjectionSummary(id, home) {
  const base = home || process.env.DSH_HOME || '';
  if (!base || !id) return null;
  const file = joinPath(base, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  try {
    const st = statSyncFs(file);
    const cached = projSummaryCache.get(id);
    if (cached && cached.file === file && cached.mtimeMs === st.mtimeMs) return cached;
    const rec = JSON.parse(readFileSyncFs(file, 'utf8'))?.record ?? {};
    const rows = rec.rows ?? {};
    const title = typeof rows.title?.val === 'string' ? rows.title.val : '';
    const lastPromptAt = typeof rows.sessionListMetadata?.val?.lastPromptAt === 'number' ? rows.sessionListMetadata.val.lastPromptAt : null;
    const workspace = typeof rows.workingDirectory?.val === 'string' ? rows.workingDirectory.val : '';
    const turns = readProjectionTurns(id, home);
    const last = turns.length ? turns[turns.length - 1] : null;
    const preview = last ? String(last.response || last.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
    const summary = { file, mtimeMs: st.mtimeMs, title, lastPromptAt, workspace, turnCount: turns.length, preview };
    if (projSummaryCache.size > 400) projSummaryCache.clear(); // 防内存无界（正常用户远小于此）
    projSummaryCache.set(id, summary);
    return summary;
  } catch {
    return null;
  }
}

/** 磁盘上存在的事件日志里，这个会话的「最后活动时间」近似值（投影缓存没有时用文件 mtime） */
function sessionFileMtime(dirPath) {
  try {
    return statSyncFs(joinPath(dirPath, 'session.v4.jsonl.zstd')).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 枚举 `<DSH_HOME>/sessions/<workspace>/<sessionId>/` 得到**持久化会话列表**。
 * 只读；目录形状不稳定时返回部分结果（不抛）。
 */
export function listPersistedSessions(home) {
  const base = home || process.env.DSH_HOME || '';
  if (!base) return [];
  const root = joinPath(base, 'sessions');
  const out = [];
  let workspaces = [];
  try {
    workspaces = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const ws of workspaces) {
    const wsDir = joinPath(root, ws.name);
    let ids = [];
    try {
      ids = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const entry of ids) {
      const id = entry.name;
      if (!id || id.startsWith('.')) continue;
      const dir = joinPath(wsDir, id);
      const mtime = sessionFileMtime(dir);
      const summary = readProjectionSummary(id, home);
      out.push({
        id,
        title: summary?.title && summary.title.trim() !== '' ? summary.title : null,
        updatedAt: summary?.lastPromptAt ?? mtime ?? null,
        workspace: summary?.workspace || null,
        turnCount: summary?.turnCount ?? 0,
        preview: summary?.preview ?? '',
      });
    }
  }
  return out;
}

/** 时间比较用：number 直接用、字符串尽力 parse（解析不了当 0） */
function numericTime(row) {
  const v = row?.updatedAt;
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  return 0;
}

/** live 行（进程内）优先覆盖磁盘行；合并后按最后活动倒序 */
function mergeSessionRows(liveRows, diskRows) {
  const byId = new Map();
  for (const row of diskRows || []) if (row?.id) byId.set(row.id, row);
  for (const row of liveRows || []) {
    if (!row?.id) continue;
    const prev = byId.get(row.id);
    if (!prev) {
      byId.set(row.id, row);
      continue;
    }
    // live 的 title/updatedAt 可能更准（刚聊完），磁盘的 turnCount/preview 更全 → 合并而不是覆盖
    byId.set(row.id, {
      ...prev,
      ...row,
      title: row.title ?? prev.title,
      updatedAt: row.updatedAt ?? prev.updatedAt,
      workspace: row.workspace ?? prev.workspace,
      turnCount: row.turnCount || prev.turnCount || 0,
      preview: row.preview || prev.preview || '',
    });
  }
  return [...byId.values()].sort((a, b) => numericTime(b) - numericTime(a));
}

/**
 * 读会话事件流里的**思考过程 + 工具调用**（手机端聊天里"思考"折叠块的数据源）。
 *
 * 数据源：`<DSH_HOME>/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd`
 *   —— 这是 DSH 真正的事件日志（zstd **多帧**追加，必须用流解，一次性解只出第一帧 ✗）。
 * 事件形状（实测）：
 *   {"type":"assistant/message","data":{"turn":1,"step":2,"message":{"content":[
 *      {"type":"reasoning","text":"…思考…"}, {"type":"tool-call","name":"bash","arguments":"…"}]}}}
 *
 * 只读、不改；解析失败就返回空（不抛）。
 */
export async function readSessionTrace(id, home) {
  const base = home || process.env.DSH_HOME || '';
  if (!base || !id) return { ok: false, reason: 'bad-input', turns: [] };
  const root = joinPath(base, 'sessions');
  let file = '';
  try {
    for (const ws of readdirSync(root)) {
      const cand = joinPath(root, ws, id, 'session.v4.jsonl.zstd');
      try {
        statSyncFs(cand);
        file = cand;
        break;
      } catch {
        /* 不在这个工作区 */
      }
    }
  } catch {
    return { ok: false, reason: 'no-sessions-dir', turns: [] };
  }
  if (!file) return { ok: false, reason: 'session-file-not-found', turns: [] };

  // ⚠️ DSH 的 .zstd 是**多个独立 zstd 帧拼接**（实测魔数在 0 和 155…）：
  //    Node 的 createZstdDecompress 流解到第二帧就报 "Unknown frame descriptor" ✗；
  //    Python zstandard 也只出第一帧 ✗。唯一稳的办法：按 zstd 魔数 28 B5 2F FD 切成单帧逐个解。
  const text = (() => {
    const buf = readFileSyncFs(file);
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const out = [];
    let start = buf.indexOf(MAGIC);
    while (start >= 0) {
      const next = buf.indexOf(MAGIC, start + 4);
      const end = next < 0 ? buf.length : next;
      try {
        out.push(zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
      } catch {
        /* 坏帧/误判跳过 */
      }
      start = next;
    }
    return out.join('');
  })();

  const byTurn = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev?.type !== 'assistant/message') continue;
    const turn = ev?.data?.turn;
    const step = ev?.data?.step;
    const content = ev?.data?.message?.content;
    if (!Array.isArray(content) || typeof turn !== 'number') continue;
    if (!byTurn.has(turn)) byTurn.set(turn, []);
    for (const part of content) {
      if (part?.type === 'reasoning' && typeof part.text === 'string' && part.text.trim() !== '') {
        byTurn.get(turn).push({ kind: 'reasoning', step, text: part.text });
      } else if (part?.type === 'tool-call' && part.name) {
        byTurn.get(turn).push({ kind: 'tool', step, name: String(part.name), args: String(part.arguments ?? '').slice(0, 400) });
      }
    }
  }
  return {
    ok: true,
    turns: Array.from(byTurn.entries()).map(([turn, items]) => ({ turn, items })),
  };
}

/* ══════════════════════════════════════════════════════════════════════
 * 会话聊天全文 + 附件（手机端聊天页的数据源）
 * ──────────────────────────────────────────────────────────────────────
 * 为什么不用投影里的 turnOutline：
 *   · prompt 被**截断到 50 字符**（PROMPT_PREVIEW_LIMIT），手机上看不到完整用户话；
 *   · 只有 text 块 —— 图片/文件附件在里面**完全不存在**（2026-10-19 实测真会话日志：
 *     user/message.data.content 里是 {type:'image'|'file', attachment:{…}}）。
 * 所以直接读 DSH 真正的事件日志（session.v4.jsonl.zstd），**增量解析 + 内存缓存**：
 *   · .zstd 是多帧拼接 → 按魔数切帧逐个解（同一套已验证的逻辑，见 readSessionTrace）；
 *   · 文件只会追加 → 记下已消费到的字节偏移，下次只解新帧（不重复解十几 MB）；
 *   · 末帧可能正在写 → 解不开就**不推进偏移**，下一秒重试。
 * 事件形状（2026-10-19 在用户真会话里核对过）：
 *   {"type":"user/message","data":{"content":[
 *      {"type":"image","attachment":{"attachmentId":"sha256:…","mediaType":"image/png","width":…,"height":…,"bytes":…,"name":"…"}},
 *      {"type":"file","attachment":{"attachmentId":"sha256:…","name":"fault.log","bytes":66042}},
 *      {"type":"text","text":"…"}],"source":{"kind":"user"},…}}
 *   {"type":"assistant/message","data":{"turn":…,"message":{"content":[{"type":"text","text":"…"}]}}}
 * 只读、不改；解析失败返回已有的（不抛）。
 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** 会话 id → 日志文件路径（避免每次全盘 readdir） */
const sessionFileCache = new Map();
/** 会话 id → 增量解析状态 {file, offset, size, mtimeMs, lineTail, turns, byTurn, currentTurn} */
const chatCache = new Map();
/** 缓存上限：手机端最多同时看几个会话；超了丢最老的，防内存涨 */
const CHAT_CACHE_MAX = 24;

function findSessionFile(id, base) {
  const cached = sessionFileCache.get(id);
  if (cached && cached.base === base) {
    try {
      statSyncFs(cached.file);
      return cached.file;
    } catch {
      sessionFileCache.delete(id);
    }
  }
  const root = joinPath(base, 'sessions');
  let file = '';
  try {
    for (const ws of readdirSync(root)) {
      const cand = joinPath(root, ws, id, 'session.v4.jsonl.zstd');
      try {
        if (statSyncFs(cand).isFile()) {
          file = cand;
          break;
        }
      } catch {
        /* 不在这个工作区 */
      }
    }
  } catch {
    return '';
  }
  if (file) sessionFileCache.set(id, { base, file });
  return file;
}

/** 把 DSH 的 content 块整理成手机端认的附件元数据（**不带字节**，字节走 /mobile/api/attachment） */
function mobilePartsOf(content) {
  const out = [];
  for (const part of Array.isArray(content) ? content : []) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      out.push({ type: 'text', text: part.text });
    } else if (part.type === 'image' && part.attachment && typeof part.attachment === 'object') {
      const a = part.attachment;
      out.push({
        type: 'image',
        attachmentId: String(a.attachmentId ?? ''),
        mediaType: String(a.mediaType ?? ''),
        width: typeof a.width === 'number' ? a.width : null,
        height: typeof a.height === 'number' ? a.height : null,
        bytes: typeof a.bytes === 'number' ? a.bytes : null,
        name: typeof a.name === 'string' ? a.name : '',
      });
    } else if (part.type === 'file' && part.attachment && typeof part.attachment === 'object') {
      const a = part.attachment;
      out.push({
        type: 'file',
        attachmentId: String(a.attachmentId ?? ''),
        name: typeof a.name === 'string' ? a.name : '',
        bytes: typeof a.bytes === 'number' ? a.bytes : null,
      });
    }
  }
  return out;
}

function emptyChatState(file) {
  return {
    file,
    offset: 0,
    size: 0,
    mtimeMs: 0,
    lineTail: '',
    turns: [],
    byTurn: new Map(),
    currentTurn: null,
  };
}

function applyChatEvent(state, ev) {
  const type = String(ev?.type ?? '');
  const d = ev?.data ?? {};
  if (type === 'turn/start') {
    const n = typeof d.turn === 'number' ? d.turn : state.turns.length + 1;
    const turn = { turn: n, prompt: '', promptParts: [], response: '', time: ev?.time ?? null };
    state.currentTurn = n;
    state.turns.push(turn);
    state.byTurn.set(n, turn);
    return;
  }
  if (type === 'user/message') {
    if (d?.source?.kind !== 'user') return; // 运行时上下文/技能清单等注入不算聊天
    const turn = state.byTurn.get(state.currentTurn);
    if (!turn || turn.prompt !== '' || turn.promptParts.length > 0) return;
    const parts = mobilePartsOf(d.content);
    turn.promptParts = parts;
    turn.prompt = parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    return;
  }
  if (type === 'assistant/message') {
    const turn = state.byTurn.get(state.currentTurn);
    if (!turn) return;
    const text = mobilePartsOf(d?.message?.content)
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n')
      .trim();
    if (text !== '') turn.response = text; // 最新一条文本即本轮可见回复（与投影 turnOutline 一致）
  }
}

function applyChatText(state, text) {
  const combined = state.lineTail + text;
  const lines = combined.split('\n');
  state.lineTail = lines.pop() ?? '';
  for (const line of lines) {
    if (line.trim() === '') continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      applyChatEvent(state, ev);
    } catch {
      /* 单条坏事件不影响整体 */
    }
  }
}

/**
 * 读一个会话的聊天（全文 + 附件元数据），增量解析、带缓存。
 * @param {string} id 会话 id
 * @param {string} [home] DSH_HOME（测试可传）
 * @returns {{ok:boolean, reason?:string, turns:Array, count:number, changed:boolean}}
 */
export function readSessionChat(id, home) {
  const base = home || process.env.DSH_HOME || '';
  if (!base || !id) return { ok: false, reason: 'bad-input', turns: [], count: 0, changed: false };
  const file = findSessionFile(id, base);
  if (!file) return { ok: false, reason: 'session-file-not-found', turns: [], count: 0, changed: false };
  let st;
  try {
    st = statSyncFs(file);
  } catch {
    return { ok: false, reason: 'stat-failed', turns: [], count: 0, changed: false };
  }
  let state = chatCache.get(id);
  if (state && state.file !== file) state = null;
  if (state && state.size === st.size && state.mtimeMs === st.mtimeMs) {
    return { ok: true, turns: state.turns, count: state.turns.length, changed: false };
  }
  if (!state) {
    state = emptyChatState(file);
    if (chatCache.size >= CHAT_CACHE_MAX) {
      const oldest = chatCache.keys().next().value;
      if (oldest !== undefined) chatCache.delete(oldest);
    }
    chatCache.set(id, state);
  }
  let buf;
  try {
    buf = readFileSyncFs(file);
  } catch {
    return { ok: false, reason: 'read-failed', turns: state.turns, count: state.turns.length, changed: false };
  }
  if (buf.length < state.offset) {
    // 文件被替换/截断 → 从头来
    state = emptyChatState(file);
    chatCache.set(id, state);
  }
  let pos = state.offset;
  let consumed = state.offset;
  for (;;) {
    const magic = buf.indexOf(ZSTD_MAGIC, pos);
    if (magic < 0) break;
    const next = buf.indexOf(ZSTD_MAGIC, magic + 4);
    const end = next < 0 ? buf.length : next;
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(magic, end)).toString('utf8');
    } catch {
      // 最后一帧可能还在写 → 不推进偏移，下次重试；中间坏帧 → 跳过
      if (next < 0) break;
      pos = next;
      consumed = next;
      continue;
    }
    applyChatText(state, text);
    if (next < 0) {
      consumed = buf.length;
      break;
    }
    pos = next;
    consumed = next;
  }
  state.offset = consumed;
  state.size = st.size;
  state.mtimeMs = st.mtimeMs;
  return { ok: true, turns: state.turns, count: state.turns.length, changed: true };
}

/** 从聊天缓存里按 attachmentId 找到附件元数据（看图/下文件要用） */
export function findChatAttachment(id, attachmentId, home) {
  const chat = readSessionChat(id, home);
  for (const turn of chat.turns || []) {
    for (const part of turn.promptParts || []) {
      if (part.type !== 'text' && part.attachmentId === attachmentId) return part;
    }
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════
 * 审批（手机批准 / 拒绝）
 * ──────────────────────────────────────────────────────────────────────
 * 宿主侧的审批是 `approval/request` **waterfall**：answerer 返回
 * allowed-once / rejected / cancelled；返回 undefined 表示交给下一个 listener。
 * 桌面网页的审批面板也是 waterfall 里的一个 listener（经 Remote Event 转发）。
 *
 * 策略（手机优先，但不霸占）：
 *   · 只有**手机正开着这个会话的实时流**（SSE，页面可见）时才接管 ——
 *     因为此时用户显然在看手机；
 *   · 接管后等手机上点「允许/拒绝」；超时（60s）或请求被 abort → 交回桌面
 *     （`next()`），桌面面板照常出现，不会把桌面卡死；
 *   · 手机页面不可见就断开 SSE（app.js 里做了 visibilitychange）→ 不会出现
 *     "手机在口袋里，桌面干等"的情况。
 * 这是取舍，不是完美方案：桌面端面板在超时后才出现（最长 60s）。理由写在
 * 交接文档里，别偷偷改策略。
 */
const APPROVAL_WAIT_MS = 60 * 1000;
/** sessionId → SSE 连接数（>0 表示手机正看着这个会话） */
const watchingSessions = new Map();
/** 待回答的审批：id → {id, sessionId, toolName, callId, reason, displayReason, createdAt, finish, timer} */
const pendingApprovals = new Map();
/** sessionId → Set<{send}>（SSE 推送审批变化用） */
const sseClients = new Map();
let approvalCounter = 0;

function publicApproval(entry) {
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    toolName: entry.toolName,
    callId: entry.callId,
    reason: entry.reason,
    displayReason: entry.displayReason,
    createdAt: entry.createdAt,
    ageMs: Date.now() - entry.createdAt,
    timeoutMs: APPROVAL_WAIT_MS,
  };
}

function approvalsFor(sessionId) {
  const out = [];
  for (const entry of pendingApprovals.values()) {
    if (!sessionId || entry.sessionId === sessionId) out.push(publicApproval(entry));
  }
  return out;
}

function notifyApprovals(sessionId) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const payload = { approvals: approvalsFor(sessionId) };
  for (const client of clients) {
    try {
      client.send('approval', payload);
    } catch {
      /* 单个连接坏了不影响别人 */
    }
  }
}

export function apply(ctx) {
  const log = (m) => {
    try {
      ctx.logger?.info?.(`[shell-mobile] ${m}`);
    } catch {
      /* 日志失败不影响功能 */
    }
  };
  const warn = (m) => {
    try {
      ctx.logger?.warn?.(`[shell-mobile] ${m}`);
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

  // ── 手机审批 answerer：只在手机正看着这个会话时接管 ────────────────────
  /**
   * 等待手机上的一次点击。
   * @returns Promise<null|string>：null=超时/取消（交回桌面），否则是审批结果词
   */
  function waitMobileDecision(request, sessionId) {
    return new Promise((resolve) => {
      approvalCounter += 1;
      const id = `ap-${Date.now().toString(36)}-${String(approvalCounter)}`;
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        const entry = pendingApprovals.get(id);
        if (entry?.timer) clearTimeout(entry.timer);
        pendingApprovals.delete(id);
        notifyApprovals(sessionId);
        resolve(outcome);
      };
      pendingApprovals.set(id, {
        id,
        sessionId,
        toolName: String(request?.toolName ?? ''),
        callId: request?.callId ?? null,
        reason: typeof request?.reason === 'string' ? request.reason : '',
        displayReason: request?.displayReason ?? null,
        createdAt: Date.now(),
        finish,
        timer: setTimeout(() => finish(null), APPROVAL_WAIT_MS),
      });
      notifyApprovals(sessionId);
      const signal = request?.signal;
      if (signal && typeof signal.addEventListener === 'function') {
        if (signal.aborted) finish('cancelled');
        else signal.addEventListener('abort', () => finish('cancelled'), { once: true });
      }
    });
  }

  try {
    // waterfall listener：审批请求进来时，手机在看这个会话就接管，否则原样交给桌面
    ctx.on(
      'approval/request',
      (request, next) => {
        try {
          const sessionId = request?.agent?.session?.id;
          if (!sessionId) return next();
          if (!(watchingSessions.get(sessionId) > 0)) return next();
          return waitMobileDecision(request, sessionId).then((outcome) => (outcome === null ? next() : outcome));
        } catch (e) {
          warn(`审批接管失败（交回桌面）：${String(e?.message ?? e)}`);
          return next();
        }
      },
      'dsh-shell-mobile: 手机审批 answerer',
    );
  } catch (e) {
    warn(`注册手机审批 answerer 失败（不影响其它功能）：${String(e?.message ?? e)}`);
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
    // ⚠️ 列表**以磁盘为准**：sessions.list() 只有"进程内活着的会话"，桌面重启后是空的
    //    （2026-10-19 实测：临时 DSH 里带附件的会话重启后 /mobile/api/sessions = 0 条）。
    //    磁盘列表（listPersistedSessions）保证"重启后手机上还能看到历史会话"。
    const diskRows = listPersistedSessions();
    if (!sessions) {
      if (diskRows.length) return { ok: true, via: 'disk-only', count: diskRows.length, sessions: diskRows.slice(0, 200) };
      return { ok: false, reason: 'no-sessions-service' };
    }
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
        const liveRows = arr.map((x) => {
          const h = x?.header && typeof x.header === 'object' ? x.header : {};
          const sid = x?.id ?? x?.sessionId ?? x?.key ?? null;
          // 列表要"看得出内容"：附上最后一轮预览与轮数（真机反馈"很不好用"——以前只有一行「新会话」）
          let turns = [];
          try { turns = readProjectionTurns(sid); } catch { turns = []; }
          const last = turns.length ? turns[turns.length - 1] : null;
          const preview = last ? String(last.response || last.prompt || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
          return {
            id: sid,
            title: h.title ?? x?.title ?? null,
            updatedAt: h.updatedAt ?? h.lastActivityAt ?? x?.updatedAt ?? null,
            workspace: h.workspace ?? h.workspacePath ?? x?.workspace ?? null,
            turnCount: turns.length,
            preview,
          };
        });
        const merged = mergeSessionRows(liveRows, diskRows);
        return {
          ok: true,
          via: `${label}+disk`,
          count: merged.length,
          liveCount: liveRows.length,
          diskCount: diskRows.length,
          sessions: merged.slice(0, 200),
        };
      } catch (e) {
        lastError = String(e?.message ?? e);
      }
    }
    if (diskRows.length) {
      return { ok: true, via: 'disk-fallback', count: diskRows.length, sessions: diskRows.slice(0, 200) };
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
      turns: readProjectionTurns(id),
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

    // ── 会话事件流（SSE）：手机端"实时同步"用 ──
    // 两路数据：
    //   ① chat  —— 事件日志（session.v4.jsonl.zstd）增量解析出的**全文 + 附件**（首帧全量，之后只推尾巴）
    //   ② turns —— 投影缓存的 turnOutline（兼容旧界面 / 列表预览用，小、稳）
    //   ③ approval —— 有待审批时推送（手机在看这个会话时审批由手机接管，见 apply 里的 answerer）
    // 1 秒粒度；不订阅 DSH 内部事件 API（升级不易坏）。
    if (path === `${ROUTE}/stream`) {
      const sid = url.searchParams.get('id') ?? '';
      if (!sid) {
        json(res, 400, { ok: false, reason: 'missing-id' });
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let lastMtime = -1;
      let closed = false;
      let chatSig = '';
      let sentChatTurns = 0;
      const send = (event, data) => {
        if (!closed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };
      const flush = () => {
        if (closed) return;
        // ① 聊天全文 + 附件
        try {
          const chat = readSessionChat(sid);
          if (chat.ok) {
            const turns = chat.turns || [];
            const last = turns[turns.length - 1];
            // 签名只看"变了没有"：轮数 + 最后一轮的 prompt/response 长度（文本替换等长这种极端忽略）
            const sig = `${String(turns.length)}|${String(last?.prompt?.length ?? 0)}|${String(last?.response?.length ?? 0)}`;
            if (sig !== chatSig) {
              const first = sentChatTurns === 0;
              const from = first ? 0 : Math.max(0, sentChatTurns - 1);
              chatSig = sig;
              sentChatTurns = turns.length;
              send('chat', { turns: first ? turns : turns.slice(from), replace: first, from });
            }
          }
        } catch {
          /* 日志还没生成：等下次 */
        }
        // ② 投影（兼容旧界面）
        try {
          const home = process.env.DSH_HOME || '';
          const file = joinPath(home, 'storages', 'session_projcache', 'sessions', `${sid}.json`);
          const st = statSyncFs(file);
          if (st.mtimeMs !== lastMtime) {
            lastMtime = st.mtimeMs;
            send('turns', { turns: readProjectionTurns(sid), mtime: st.mtimeMs });
          }
        } catch {
          /* 投影文件还没生成：等下次 */
        }
      };
      // 登记"手机正看着这个会话"：审批接管靠它判断（页面隐藏时前端会断开 SSE）
      watchingSessions.set(sid, (watchingSessions.get(sid) ?? 0) + 1);
      let clients = sseClients.get(sid);
      if (!clients) {
        clients = new Set();
        sseClients.set(sid, clients);
      }
      const client = { send };
      clients.add(client);
      flush(); // 立刻给一次当前状态（含待审批）
      const pending = approvalsFor(sid);
      if (pending.length > 0) send('approval', { approvals: pending });
      const timer = setInterval(flush, 1000);
      const beat = setInterval(() => {
        if (!closed) res.write(': ping\n\n');
      }, 15000);
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(timer);
        clearInterval(beat);
        const left = (watchingSessions.get(sid) ?? 1) - 1;
        if (left <= 0) watchingSessions.delete(sid);
        else watchingSessions.set(sid, left);
        const set = sseClients.get(sid);
        if (set && client) {
          set.delete(client);
          if (set.size === 0) sseClients.delete(sid);
        }
      };
      req.on('close', stop);
      res.on('close', stop);
      return;
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
      const sid = url.searchParams.get('id') ?? '';
        const detail = await getSession(sid);
        // 模型/强度/预设/工作区：chips 显示真值（读投影，稳定可核对）
        json(res, 200, { ...detail, meta: readProjectionMeta(sid), chat: readSessionChat(sid) });
      return;
    }

    if (path === `${ROUTE}/chat`) {
      // 会话聊天全文 + 附件元数据（手机端聊天页；SSE 不可用时的兜底，也是首屏快照）
      const chatId = url.searchParams.get('id') ?? '';
      json(res, 200, readSessionChat(chatId));
      return;
    }

    if (path === `${ROUTE}/attachment`) {
      // 附件字节：图片 <img src> 直接用（GET+令牌，同源/网关都行），文件走下载。
      // 安全：只允许**本会话日志里真实引用过**的 attachmentId（先查聊天缓存，再读字节校验）。
      const sessionId = url.searchParams.get('sid') ?? '';
      const attachmentId = url.searchParams.get('id') ?? '';
      if (!sessionId || !attachmentId) {
        json(res, 400, { ok: false, reason: 'need-sid-and-id' });
        return;
      }
      const found = findChatAttachment(sessionId, attachmentId);
      if (!found) {
        json(res, 404, { ok: false, reason: 'attachment-not-in-session' });
        return;
      }
      const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
      if (!attachments) {
        json(res, 501, { ok: false, reason: 'no-attachments-service' });
        return;
      }
      const isImage = found.type === 'image';
      const ref = isImage
        ? { attachmentId, mediaType: found.mediaType, bytes: found.bytes ?? 0, width: found.width ?? 0, height: found.height ?? 0, ...(found.name ? { name: found.name } : {}) }
        : { attachmentId, name: found.name || 'file', bytes: found.bytes ?? 0 };
      try {
        if (isImage) {
          const stored = await attachments.readImage(ref);
          const buf = Buffer.from(stored.data);
          res.writeHead(200, {
            'content-type': ref.mediaType || 'application/octet-stream',
            'content-length': buf.length,
            'cache-control': 'private, max-age=3600, immutable',
            'x-content-type-options': 'nosniff',
          });
          res.end(buf);
          return;
        }
        // 文件：流式回传（不整份读进内存）
        const chunks = [];
        for await (const chunk of attachments.readFileStream(ref)) chunks.push(Buffer.from(chunk));
        const buf = Buffer.concat(chunks);
        const safeName = encodeURIComponent(ref.name || 'file');
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': buf.length,
          'content-disposition': `attachment; filename*=UTF-8''${safeName}`,
          'cache-control': 'private, no-store',
        });
        res.end(buf);
      } catch (e) {
        json(res, 500, { ok: false, reason: 'read-failed', error: String(e?.message ?? e).slice(0, 200) });
      }
      return;
    }

    if (path === `${ROUTE}/approvals`) {
      // 手机端轮询待审批（SSE 里也会有 approval 事件；轮询是兜底）
      const sid = url.searchParams.get('sid') ?? url.searchParams.get('id') ?? '';
      json(res, 200, { ok: true, approvals: approvalsFor(sid), watching: (watchingSessions.get(sid) ?? 0) > 0 });
      return;
    }

    if (path === `${ROUTE}/approval/answer`) {
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
        json(res, 405, { ok: false, reason: 'use-post' });
        return;
      }
      let body = '';
      req.on('data', (c) => {
        body += c;
      });
      req.on('end', () => {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          payload = {};
        }
        const entry = pendingApprovals.get(String(payload.id ?? ''));
        if (!entry) {
          json(res, 200, { ok: false, reason: 'not-pending' });
          return;
        }
        const outcome = payload.outcome === 'rejected' ? 'rejected' : payload.outcome === 'allowed-once' ? 'allowed-once' : '';
        if (outcome === '') {
          json(res, 200, { ok: false, reason: 'bad-outcome' });
          return;
        }
        entry.finish(outcome);
        json(res, 200, { ok: true, id: entry.id, outcome });
      });
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

    if (path === `${ROUTE}/tasks`) {
      // 任务页（真数据）：读 DSH 的定时任务表 <DSH_HOME>/storages/schedule.json
      // 形状：{tables:{tasks:{<id>:{sessionId, record:{id,kind,title,prompt,...}}}}}
      const homeT = process.env.DSH_HOME || '';
      const out = [];
      try {
        const sf = joinPath(homeT, 'storages', 'schedule.json');
        const tables = JSON.parse(readFileSyncFs(sf, 'utf8'))?.tables ?? {};
        const tasks = tables.tasks ?? {};
        for (const [id, row] of Object.entries(tasks)) {
          const r = row?.record ?? {};
          out.push({
            id: r.id ?? id,
            kind: typeof r.kind === 'string' ? r.kind : '',
            title: typeof r.title === 'string' ? r.title : String(r.prompt ?? '').split('\n')[0].slice(0, 60),
            prompt: typeof r.prompt === 'string' ? r.prompt.slice(0, 200) : '',
            nextAt: r.nextAt ?? r.nextRunAt ?? r.at ?? null,
            enabled: r.enabled !== false,
          });
        }
      } catch {
        /* 没有定时任务 */
      }
      json(res, 200, { ok: true, count: out.length, tasks: out });
      return;
    }

    if (path === `${ROUTE}/trace`) {
      // 思考过程 + 工具调用（桌面端"思考…"那一块，手机端要用）
      const traceId = url.searchParams.get('id') ?? '';
      json(res, 200, await readSessionTrace(traceId));
      return;
    }

    if (path === `${ROUTE}/plugins`) {
      // 插件页（真数据）：直接读 dsh-home/plugins/*/package.json。
      // 不依赖 DSH 内部服务形状（那会变），磁盘布局稳定、结果可核对 —— 手机上看"装了哪些插件"。
      const home = process.env.DSH_HOME || '';
      const dir = joinPath(home, 'plugins');
      const out = [];
      try {
        for (const id of readdirSync(dir)) {
          try {
            const pkg = JSON.parse(readFileSyncFs(joinPath(dir, id, 'package.json'), 'utf8'));
            out.push({
              id,
              name: typeof pkg.name === 'string' ? pkg.name : id,
              version: typeof pkg.version === 'string' ? pkg.version : '',
              description: typeof pkg.description === 'string' ? pkg.description.slice(0, 140) : '',
            });
          } catch {
            out.push({ id, name: id, version: '', description: '' });
          }
        }
      } catch {
        /* 目录不存在 = 还没装插件 */
      }
      out.sort((a, b) => String(a.id).localeCompare(String(b.id)));
      json(res, 200, { ok: true, count: out.length, plugins: out });
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
