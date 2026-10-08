/**
 * dsh-shell-canvas —— 宿主半边。
 *
 * ── 它是什么 ─────────────────────────────────────────────────────────
 * 把**深鲸画布引擎**（`canvas/`，独立工程，S0–S2 已冻结）包成深鲸桌面里的一个面板：
 * 选模板 → 填参数 → 校验 → 预览 → 出横竖双版成片 → 打开成片。
 *
 * 宿主半边负责"看得见机器"的那一半：
 *   · 定位引擎目录（探测链 + 用户可覆盖）；
 *   · 列模板目录、跑校验闸门（**校验不过不许进渲染**）；
 *   · 起子进程跑渲染（Chromium 后端 / Electron OSR 后端），收进度、取消、续渲；
 *   · 把产物目录通过一个受限的 HTTP 出口交给浏览器播放/打开。
 *
 * ── 为什么界面的数据走 HTTP 而不是走别的通道 ─────────────────────────
 * DSH 的命名路由（`ctx.webServer.register`）正是为"插件自己的 HTTP 出口"准备的：
 * 与页面同源、无需额外握手、`<video>` 能直接播、进度能用 SSE 推。
 * 安全边界：只接受**回环地址**来的请求，并且只对外暴露产物目录内的文件。
 *
 * ── 为什么渲染一定在子进程 ───────────────────────────────────────────
 * 见 `lib/jobs.mjs` 头注：本地神经 TTS 是原生库，崩了会 abort 整个进程。
 */

import { existsSync, mkdirSync, statSync, createReadStream, createWriteStream, rmSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';
import { JobManager, resolveNode, probeElectron, electronCandidates } from './jobs.mjs';
import {
  resolveEngineRoot, loadEngine, readCatalog, loadPair, validateGroup,
  writeOverride, probe, posterPath,
} from './engine.mjs';

export const name = 'shell-canvas';

/** 宿主必须有 web 载体（本插件的界面数据全靠它）。 */
export const inject = ['webServer'];

const ROUTE = '/dsh-canvas';
const MIME = {
  '.mp4': 'video/mp4', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.srt': 'text/plain; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.m4a': 'audio/mp4', '.wav': 'audio/wav',
};

export function apply(ctx) {
  // ── 运行时状态（引擎目录、输出目录、node/electron 二进制）──────────────
  const state = {
    engineExplicit: null,
    resolved: null,     // { ok, root, tried }
    node: null,
    electron: null,     // { ok, path, electron, chrome, reason }
    electronChecked: false,
  };

  const resolveNow = () => {
    const r = resolveEngineRoot(state.engineExplicit);
    state.resolved = r;
    state.node = state.node || resolveNode(null);
    return r;
  };
  resolveNow();

  const outputRoot = () => {
    const root = state.resolved?.root;
    if (!root) return join(process.env.DSH_HOME || process.cwd(), 'canvas-out');
    return join(root, 'out', 'app');
  };

  const runtime = () => ({
    engineRoot: state.resolved?.root || null,
    outputRoot: outputRoot(),
    node: state.node || resolveNode(null),
    electron: state.electron,
  });

  const jobs = new JobManager({ runtime });

  /** Electron 探测是异步的、要起进程，所以只做一次并缓存。 */
  async function ensureElectron(force = false) {
    if (state.electronChecked && !force) return state.electron;
    state.electronChecked = true;
    const candidates = electronCandidates(null);
    const tried = [];
    for (const c of candidates) {
      const r = await probeElectron(c);
      tried.push({ path: c, ...r });
      if (r.ok) {
        state.electron = { ok: true, path: c, electron: r.electron, chrome: r.chrome, tried };
        return state.electron;
      }
    }
    state.electron = {
      ok: false,
      path: null,
      tried,
      reason: candidates.length
        ? '找到的 Electron 都不能执行我们给的脚本（打包过的 .app 会无视脚本参数）'
        : '没找到 Electron 二进制（可执行脚本的那种）',
    };
    return state.electron;
  }

  // ── 组装任务规格 ─────────────────────────────────────────────────────
  function buildSpec(request) {
    const root = state.resolved?.root;
    if (!root) throw httpError(409, '还没找到深鲸画布引擎目录，先在面板顶部设置引擎目录');

    const group = String(request.group || '');
    const catalog = readCatalog(root);
    const entry = catalog.find((g) => g.id === group);
    if (!entry) throw httpError(404, `模板组不存在：${group}`);

    const reuse = request.resumeFrom && existsSync(request.resumeFrom) ? resolve(request.resumeFrom) : null;
    const outDir = reuse || join(outputRoot(), `${group}-${Date.now().toString(36)}`);

    const vars = { ...(request.vars || {}) };
    for (const v of entry.vars) if (vars[v.key] === undefined && v.default !== undefined) vars[v.key] = v.default;

    const spec = {
      kind: request.kind,
      engineRoot: root,
      outputRoot: outputRoot(),
      outDir,
      pack: 'video',
      pair: loadPair(root, group),
      vars,
      assets: request.assets || {},
      script: request.script || '',
      voiceoverFile: request.voiceoverFile || null,
      bgmId: request.bgmId || null,
      quality: request.quality || (request.kind === 'preview' ? 'preview' : 'final'),
      previewSeconds: Math.max(1, Math.min(30, Number(request.previewSeconds) || 4)),
      renderer: request.renderer === 'electron-osr' ? 'electron-osr' : 'chromium',
      resume: !!request.resume,
      fps: entry.canvas?.fps || 30,
      framesPadding: 90,
    };
    mkdirSync(outDir, { recursive: true });
    return { spec, entry, reuse };
  }

  function buildPosterSpec(request) {
    const root = state.resolved?.root;
    if (!root) throw httpError(409, '还没找到深鲸画布引擎目录');
    const catalog = readCatalog(root);
    const outDir = join(outputRoot(), 'posters');
    mkdirSync(outDir, { recursive: true });
    const posters = [];
    for (const g of catalog) {
      for (const [orientation, o] of Object.entries(g.orientations)) {
        const vars = {};
        for (const v of o.vars || []) if (v.default !== undefined) vars[v.key] = v.default;
        posters.push({ id: `${g.id}-${orientation}`, orientation, vars, doc: loadPair(root, g.id)[orientation] });
      }
    }
    // 海报任务也走同一个执行体：它只要 `pair` 存在（闸门会校验），这里给第一份。
    return {
      spec: {
        kind: 'posters', engineRoot: root, outputRoot: outputRoot(), outDir, pack: 'video',
        pair: { vertical: posters[0].doc }, vars: {}, assets: {}, script: '',
        renderer: request.renderer === 'electron-osr' ? 'electron-osr' : 'chromium',
        quality: 'preview', resume: false, fps: 30, posters,
      },
      catalog,
    };
  }

  // ── HTTP ────────────────────────────────────────────────────────────
  const handler = async (req, res) => {
    try {
      if (!isLoopback(req)) return send(res, 403, { error: '只接受本机请求' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;

      if (p === `${ROUTE}/api/events` && req.method === 'GET') return sse(req, res);

      // 上传本地素材：浏览器拿不到真实路径，所以把字节传上来，宿主落盘后给引擎一个绝对路径。
      if (p === `${ROUTE}/api/upload` && req.method === 'POST') return uploadFile(req, res, url);

      // 读文件（视频/海报/字幕）：只允许产物目录内的路径
      if (p === `${ROUTE}/api/file` && req.method === 'GET') return serveFile(req, res, url);

      const body = req.method === 'POST' ? await readJson(req) : {};

      if (p === `${ROUTE}/api/state` && req.method === 'GET') return send(res, 200, await apiState());
      if (p === `${ROUTE}/api/engine` && req.method === 'POST') return send(res, 200, await apiSetEngine(body));
      if (p === `${ROUTE}/api/validate` && req.method === 'POST') return send(res, 200, await apiValidate(body));
      if (p === `${ROUTE}/api/job` && req.method === 'POST') return send(res, 200, await apiStartJob(body));
      if (p === `${ROUTE}/api/jobs` && req.method === 'GET') return send(res, 200, { jobs: jobs.list() });
      if (p === `${ROUTE}/api/job` && req.method === 'GET') return send(res, 200, jobs.get(url.searchParams.get('id')));
      if (p === `${ROUTE}/api/cancel` && req.method === 'POST') return send(res, 200, jobs.cancel(body.id, body));
      if (p === `${ROUTE}/api/posters` && req.method === 'POST') return send(res, 200, apiPosters(body));
      if (p === `${ROUTE}/api/reveal` && req.method === 'POST') return send(res, 200, apiReveal(body));
      if (p === `${ROUTE}/api/osr` && req.method === 'POST') return send(res, 200, await ensureElectron(!!body.force));
      if (p === `${ROUTE}/api/engine` && req.method === 'GET') return send(res, 200, state.resolved);

      return send(res, 404, { error: `未知接口：${req.method} ${p}` });
    } catch (error) {
      const code = error && error.status ? error.status : 500;
      return send(res, code, {
        error: error && error.message ? error.message : String(error),
        ...(error && error.validation ? { validation: error.validation } : {}),
      });
    }
  };

  async function apiState() {
    const r = state.resolved;
    if (!r?.ok) {
      return {
        engine: { ok: false, root: null, tried: r?.tried || [] },
        runtime: { node: state.node, electron: state.electron, outputRoot: outputRoot() },
        templates: [], jobs: jobs.list(),
      };
    }
    let engineInfo = null;
    let templates = [];
    let catalogError = null;
    try {
      const e = await loadEngine(r.root);
      engineInfo = { version: e.engineVersion, pack: e.packVersion, packs: e.packs };
      templates = readCatalog(r.root).map((g) => ({
        ...g,
        poster: Object.fromEntries(Object.keys(g.orientations).map((o) => [o, posterUrl(g.id, o)])),
        varDefs: g.vars,
      }));
    } catch (error) {
      catalogError = error.message;
    }
    return {
      engine: { ok: true, root: r.root, tried: r.tried, ...(engineInfo || {}), error: catalogError },
      runtime: { node: state.node, electron: state.electron, outputRoot: outputRoot() },
      templates,
      jobs: jobs.list(),
      overrideFile: (await import('./engine.mjs')).overrideFile(),
    };
  }

  async function apiSetEngine(body) {
    const root = String(body.root || '').trim();
    if (!root) throw httpError(400, '缺少 root');
    const p = probe(root);
    if (!p.ok) {
      return { ok: false, root: p.root, missing: p.missing };
    }
    writeOverride(p.root);
    state.engineExplicit = p.root;
    state.electronChecked = false;
    resolveNow();
    return { ok: true, root: p.root };
  }

  async function apiValidate(body) {
    const root = state.resolved?.root;
    if (!root) throw httpError(409, '还没找到深鲸画布引擎目录');
    return validateGroup(root, String(body.group || ''), body.vars || {});
  }

  async function apiStartJob(body) {
    const kind = body.kind === 'preview' ? 'preview' : 'final';
    const root = state.resolved?.root;
    if (!root) throw httpError(409, '还没找到深鲸画布引擎目录');

    // 闸门放在**宿主这边**再走一遍，而不是只信界面的那次校验：
    // 界面可能被绕过（直接调接口、脚本、旧页面缓存），而"校验不通过不许进渲染"
    // 是规范层的事，不能只做成一个前端按钮。
    const gate = await validateGroup(root, String(body.group || ''), body.vars || {});
    if (!gate.ok) {
      const first = gate.templates.flatMap((t) => t.issues).find((i) => i.level === 'error');
      const err = httpError(422, first ? `校验不通过，已拦下渲染：[${first.code}] ${first.msg}` : '校验不通过，已拦下渲染');
      err.validation = gate;
      throw err;
    }

    const { spec, entry, reuse } = buildSpec({ ...body, kind });
    const title = `${entry.name}·${kind === 'preview' ? '预览' : '终版'}${spec.renderer === 'electron-osr' ? '（OSR）' : ''}`;
    return jobs.start(spec, { ...body, kind }, { title: reuse ? `${title}（续渲）` : title });
  }

  function apiPosters(body) {
    const { spec, catalog } = buildPosterSpec(body);
    return jobs.start(spec, { kind: 'posters' }, { title: `模板预览图（${catalog.length} 组）` });
  }

  function apiReveal(body) {
    const target = String(body.path || '');
    const root = outputRoot();
    const abs = resolve(target);
    if (!inside(abs, root) && !inside(abs, state.resolved?.root || '')) {
      throw httpError(403, '只允许打开产物目录里的文件');
    }
    if (!existsSync(abs)) throw httpError(404, `路径不存在：${abs}`);
    const dir = statSync(abs).isDirectory() ? abs : resolve(abs, '..');
    const cmd = process.platform === 'darwin' ? ['open', ['-R', abs]]
      : process.platform === 'win32' ? ['explorer', ['/select,', abs]]
        : ['xdg-open', [dir]];
    try {
      spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
    } catch (error) {
      throw httpError(500, `打不开：${error.message}`);
    }
    return { ok: true, path: abs };
  }

  function posterUrl(groupId, orientation) {
    const root = state.resolved?.root;
    if (!root) return null;
    return existsSync(posterPath(outputRoot(), groupId, orientation))
      ? `${ROUTE}/api/file?p=${encodeURIComponent(posterPath(outputRoot(), groupId, orientation))}`
      : null;
  }

  /**
   * 收一个本机素材。
   *
   * 为什么要走上传：引擎的素材槽位（`userSlots`）要的是**本机绝对路径**，
   * 而浏览器里的 `<input type=file>` 只给 File 对象、拿不到路径。
   * 走回环 HTTP 把字节交回宿主落盘，是唯一不改桌面端就能成立的做法。
   * 素材只写到本机产物目录下的 `uploads/`，不出机器。
   */
  function uploadFile(req, res, url) {
    const name = sanitizeName(url.searchParams.get('name') || 'file.bin');
    const dir = join(outputRoot(), 'uploads');
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${Date.now().toString(36)}-${name}`);
    const out = createWriteStream(dest);
    let size = 0;
    let aborted = false;
    const LIMIT = 1024 * 1024 * 1024; // 1GB 上限；素材本来就该是本机小文件
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMIT && !aborted) {
        aborted = true;
        out.destroy();
        try { rmSync(dest, { force: true }); } catch { /* ignore */ }
        send(res, 413, { error: '文件超过 1GB 上限' });
        req.destroy();
      }
    });
    req.on('error', () => { try { out.destroy(); } catch { /* ignore */ } });
    out.on('error', (e) => { if (!aborted) send(res, 500, { error: `写盘失败：${e.message}` }); });
    out.on('close', () => {
      if (aborted) return;
      if (!size) { try { rmSync(dest, { force: true }); } catch { /* ignore */ } return send(res, 400, { error: '空文件' }); }
      send(res, 200, { ok: true, path: dest, bytes: size, name });
    });
    req.pipe(out);
  }

  function serveFile(req, res, url) {
    const raw = url.searchParams.get('p');
    if (!raw) return send(res, 400, { error: '缺少 p' });
    const abs = resolve(raw);
    if (!inside(abs, outputRoot())) return send(res, 403, { error: '越界访问' });
    if (!existsSync(abs) || statSync(abs).isDirectory()) return send(res, 404, { error: '文件不存在' });
    const stat = statSync(abs);
    const type = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
    const range = req.headers.range;
    if (range) {
      // <video> 拖动进度条要靠 Range
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m && m[1] ? Number(m[1]) : 0;
      const end = m && m[2] ? Number(m[2]) : stat.size - 1;
      res.writeHead(206, {
        'content-type': type,
        'content-range': `bytes ${start}-${end}/${stat.size}`,
        'accept-ranges': 'bytes',
        'content-length': end - start + 1,
      });
      createReadStream(abs, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': stat.size, 'accept-ranges': 'bytes' });
    createReadStream(abs).pipe(res);
  }

  function sse(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const sendEvent = (payload) => {
      try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* 客户端走了 */ }
    };
    sendEvent({ t: 'hello', jobs: jobs.list() });
    const unsubscribe = jobs.subscribe((job, event) => sendEvent({ ...event, jobId: job.id, job: jobs.get(job.id) }));
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
    const close = () => { clearInterval(ping); unsubscribe(); };
    req.on('close', close);
    res.on('close', close);
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }), 'dsh-canvas: http 出口');
  ctx.effect(() => () => jobs.disposeAll(), 'dsh-canvas: 收掉子进程');

  // 供调试：把管理器挂到 ctx 上，方便在宿主里观测（不影响功能）
  ctx.effect(() => {
    ctx.provide?.('canvasJobs', jobs);
    return () => {};
  }, 'dsh-canvas: 调试句柄');

  ensureElectron(false).catch(() => { /* 探测失败不影响 Chromium 后端 */ });
}

// ── 小工具 ────────────────────────────────────────────────────────────

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function inside(abs, root) {
  if (!root) return false;
  const r = resolve(root);
  return abs === r || abs.startsWith(r + '/');
}

function isLoopback(req) {
  const addr = req.socket?.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr === '';
}

function send(res, status, payload) {
  const text = JSON.stringify(payload ?? null);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(text);
}

function sanitizeName(name) {
  return String(name).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_').slice(-80) || 'file.bin';
}

function readJson(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolveP, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return resolveP({});
      try { resolveP(JSON.parse(text)); } catch (e) { reject(httpError(400, `请求体不是合法 JSON：${e.message}`)); }
    });
    req.on('error', reject);
  });
}
