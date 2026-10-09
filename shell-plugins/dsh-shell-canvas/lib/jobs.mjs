/**
 * 任务管理器 —— 起子进程、收进度、取消、续渲。
 *
 * 一条硬规则：**渲染永远在子进程里**（交接文档 §4.3）。
 *   · Chromium 后端 → `node lib/worker.mjs`
 *   · Electron OSR 后端 → `<Electron 二进制> lib/osr-main.cjs`
 * 两个入口的 stdout 协议逐字相同，宿主这边只有一套解析。
 *
 * 取消 vs 杀掉（§4.2 第 2 条把这两件事分开要求，所以要分别实现）：
 *   · **取消**（界面按钮）→ SIGTERM → 引擎优雅收手（落 partial manifest）→ 宿主**清掉产物目录**
 *     ⇒ "取消后不残留半成品"；
 *   · **被杀**（kill -9 / 进程崩）→ 宿主不清理 → 帧与 manifest 留在盘上
 *     ⇒ 重跑时 `resume: true` 能跳过已渲好的帧（日志里会出现"续用 N"）。
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_LIMIT = 300;
const KILL_GRACE_MS = 8000;

// ── 运行时探测 ────────────────────────────────────────────────────────

/**
 * 找一个**真正的独立 Node**（不是 Electron 的 Node）。
 *
 * 为什么不能直接用 `process.execPath`：DSH 宿主是 `ELECTRON_RUN_AS_NODE` 起来的，
 * `process.execPath` 是 Electron 二进制；而画布引擎的本地 TTS 依赖
 * `sherpa-onnx-node` 这种**原生模块**，它是按独立 Node 的 ABI 编的，
 * 在 Electron 的 Node ABI 下加载不了。所以优先找独立 Node，找不到才退回并告警。
 */
export function resolveNode(explicit) {
  const tried = [];
  const cands = [explicit, process.env.DSH_CANVAS_NODE, '/usr/local/bin/node', '/opt/homebrew/bin/node', '/usr/bin/node'];
  for (const c of cands) {
    if (!c) continue;
    tried.push(c);
    if (existsSync(c)) return { path: c, source: 'absolute', tried, warn: null };
  }
  // PATH 里找
  for (const dir of String(process.env.PATH || '').split(':')) {
    if (!dir) continue;
    const p = join(dir, 'node');
    if (existsSync(p)) return { path: p, source: 'PATH', tried, warn: null };
  }
  return {
    path: process.execPath,
    source: 'process.execPath',
    tried,
    warn: '没有找到独立的 Node，退回到 DSH 宿主自己的运行时（Electron 的 Node）。'
      + '渲染本身能跑，但**本地神经 TTS 的原生模块可能加载不了**，配音会回落到系统音色。',
  };
}

let electronProbeCache = null;

/** 用"能不能真的跑一个脚本"来判定一个 Electron 二进制可用 —— 只看文件存在是不够的：
 *  打包过的 .app 会**无视** argv 里的脚本路径、直接加载自己的 app.asar。 */
export function probeElectron(bin, timeoutMs = 25000) {
  if (!bin || !existsSync(bin)) return { ok: false, reason: '文件不存在' };
  const out = join(tmpdir(), `dsh-canvas-elprobe-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolveP) => {
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolveP(r); } };
    let child;
    try {
      child = spawn(bin, [join(HERE, 'electron-probe.cjs'), out], { env, stdio: ['ignore', 'ignore', 'ignore'] });
    } catch (e) {
      return finish({ ok: false, reason: `起不来：${e.message}` });
    }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } finish({ ok: false, reason: `探测超时（${timeoutMs}ms）` }); }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, reason: e.message }); });
    child.on('exit', () => {
      clearTimeout(timer);
      try {
        const info = JSON.parse(readFileSync(out, 'utf8'));
        finish({ ok: true, ...info });
      } catch {
        finish({ ok: false, reason: '跑起来了，但没有产出探测结果（不是可执行脚本的 Electron）' });
      } finally {
        try { rmSync(out, { force: true }); } catch { /* ignore */ }
      }
    });
  });
}

/** Electron 候选：环境变量 → 用户设定 → 引擎/桌面端仓库里的 node_modules/electron。 */
export function electronCandidates(explicit) {
  const list = [explicit, process.env.DSH_CANVAS_ELECTRON];
  const home = homedir();
  const probes = [
    join(home, 'dsh-desktop', 'node_modules', 'electron'),
    join(home, 'DeepSeek Harness', 'canvas', 'node_modules', 'electron'),
  ];
  for (const pkg of probes) {
    try {
      const rel = readFileSync(join(pkg, 'path.txt'), 'utf8').trim();
      list.push(join(pkg, 'dist', rel));
    } catch { /* 没装就没有 */ }
  }
  return list.filter(Boolean);
}

// ── 任务管理器 ────────────────────────────────────────────────────────

export class JobManager {
  /**
   * @param {object} deps
   * @param {() => {engineRoot:string|null, outputRoot:string, node:object, electron:object|null}} deps.runtime
   */
  constructor(deps) {
    this.deps = deps;
    this.jobs = new Map();
    this.subscribers = new Set();
    this.seq = 0;
  }

  subscribe(fn) {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  _publish(job, event) {
    for (const fn of this.subscribers) {
      try { fn(job, event); } catch { /* 单个订阅者出错不能影响任务 */ }
    }
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt).map(snapshot);
  }

  get(id) {
    const j = this.jobs.get(id);
    return j ? snapshot(j) : null;
  }

  /** 丢掉已经在跑或刚跑完的任务记录（保留最近 50 条）。 */
  prune() {
    const done = [...this.jobs.values()].filter((j) => !j.child).sort((a, b) => a.createdAt - b.createdAt);
    while (done.length > 50) {
      const j = done.shift();
      this.jobs.delete(j.id);
    }
  }

  /**
   * 起一个任务。
   * @param {object} spec      完整的 worker 规格（见 lib/index.js 的 buildSpec）
   * @param {object} request   原始请求（用于展示与"重跑"）
   * @param {object} opts      { title }
   */
  start(spec, request, opts = {}) {
    const runtime = this.deps.runtime();
    const id = `${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const job = {
      id,
      kind: spec.kind,
      title: opts.title || spec.kind,
      status: 'queued',
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      engineRoot: spec.engineRoot,
      renderer: spec.renderer,
      outDir: spec.outDir,
      request,
      spec,
      progress: null,
      gate: null,
      result: null,
      error: null,
      logs: [],
      pid: null,
      cancelRequested: false,
      cleanupOnExit: false,
      child: null,
      _stdout: '',
    };
    this.jobs.set(id, job);
    this.prune();

    mkdirSync(spec.outDir, { recursive: true });
    const jobFile = join(spec.outDir, 'job.json');
    writeFileSync(jobFile, JSON.stringify(spec, null, 2) + '\n');

    const isOsr = spec.renderer === 'electron-osr';

    // ★ 进程内 OSR（2026-10-09）：插件本就在桌面端主进程里，BrowserWindow 现成 ——
    //   不必另起 Electron 进程，也就没有"找不到可执行 Electron"这一说。
    if (isOsr && runtime.electron && runtime.electron.ok && (runtime.electron.inProcess || runtime.electron.systemBrowser)) {
      job.status = 'running';
      job.startedAt = Date.now();
      job.pid = 0;
      const ac = new AbortController();
      job.child = { kill: () => ac.abort() };   // 「取消」沿用既有逻辑
      this._log(job, '引擎：' + spec.engineRoot);
      this._log(job, runtime.electron.systemBrowser
        ? ('后端：系统浏览器（' + runtime.electron.systemBrowser + '）')
        : '后端：Electron OSR（进程内，宿主自带 Chromium）');
      this._publish(job, { t: 'status' });
      void this._runInProcess(job, spec, ac.signal);
      return snapshot(job);
    }

    let bin;
    let args;
    let env = { ...process.env, DSH_CANVAS_ROOT: spec.engineRoot };
    if (isOsr) {
      if (!runtime.electron?.ok) {
        job.status = 'failed';
        job.error = { message: `Electron OSR 后端不可用：${runtime.electron?.reason || '没找到可执行的 Electron'}`, advice: '在面板的「引擎设置」里指定 Electron 二进制，或改用 Chromium 后端（默认）。' };
        job.endedAt = Date.now();
        this._publish(job, { t: 'status' });
        return snapshot(job);
      }
      bin = runtime.electron.path;
      args = [join(HERE, 'osr-main.cjs'), jobFile];
      // ⚠️ 必须去掉：否则 Electron 会退化成纯 Node，`require('electron')` 拿不到 BrowserWindow。
      delete env.ELECTRON_RUN_AS_NODE;
      for (const extra of String(process.env.DSH_CANVAS_ELECTRON_ARGS || '').split(/\s+/).filter(Boolean)) args.unshift(extra);
    } else {
      bin = runtime.node.path;
      args = [join(HERE, 'worker.mjs'), jobFile];
    }

    this._log(job, `引擎：${spec.engineRoot}`);
    if (!isOsr && runtime.node.warn) this._log(job, `⚠️ ${runtime.node.warn}`);

    let child;
    try {
      child = spawn(bin, args, { cwd: spec.engineRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      job.status = 'failed';
      job.error = { message: `起子进程失败：${e.message}` };
      job.endedAt = Date.now();
      this._publish(job, { t: 'status' });
      return snapshot(job);
    }
    job.child = child;
    job.pid = child.pid;
    job.status = 'running';
    job.startedAt = Date.now();
    this._log(job, `子进程已起：pid ${child.pid}（${isOsr ? 'Electron OSR' : 'Chromium'} 后端）`);
    this._publish(job, { t: 'status' });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onStdout(job, chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      // Electron 会往 stderr 吐 crashpad/GPU 之类的噪声，别原样灌给用户；
      // 只留真正像错误的那几行，并且截断长度。
      if (!text) return;
      for (const line of text.split('\n')) {
        if (/(ERROR|FATAL|Error:|失败|错误)/.test(line) && !/crashpad|mach_vm_read|GPU process isn't usable/.test(line)) {
          this._log(job, `stderr: ${line.slice(0, 300)}`);
        }
      }
    });
    child.on('error', (e) => {
      job.error = { message: `子进程错误：${e.message}` };
    });
    child.on('exit', (code, signal) => this._onExit(job, code, signal));
    return snapshot(job);
  }

  /**
   * 进程内跑任务（OSR）：与 osr-main.cjs 完全同构，只是不跨进程。
   * 事件走同一条 _onEvent；结束走同一条 _onExit（code=0 且 result 才算成功）。
   */
  async _runInProcess(job, spec, signal) {
    const windows = [];
    try {
      const { runJob } = await import('./pipeline-run.mjs');
      const emit = (e) => this._onEvent(job, e);
      let makeAdapter;
      if (spec.rendererExtra && spec.rendererExtra.systemBrowser) {
        // 系统浏览器：纯 Node，不需要 Electron
        const { SystemBrowserAdapter } = await import('./adapter-system-browser.mjs');
        const bin = spec.rendererExtra.systemBrowser;
        makeAdapter = ({ width, height }) => new SystemBrowserAdapter({
          width, height, fps: spec.fps || 30, browserPath: bin,
        });
      } else {
        const { BrowserWindow } = await import('electron');
        const { pathToFileURL } = await import('node:url');
        const { ElectronOsrAdapter } = await import(
          pathToFileURL(join(spec.engineRoot, 'src/render/adapter-electron.mjs')).href
        );
        makeAdapter = ({ width, height }) => {
          const win = new BrowserWindow({
            show: false,
            width,
            height,
            webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
          });
          windows.push(win);
          return new ElectronOsrAdapter({
            window: win,
            width,
            height,
            fps: spec.fps || 30,
            session: win.webContents.session,
          });
        };
      }
      const value = await runJob(spec, { emit, makeAdapter, signal });
      emit({ t: 'result', value });
      this._onExit(job, 0, null);
    } catch (error) {
      this._onEvent(job, { t: 'error', message: error && error.message ? error.message : String(error) });
      this._onExit(job, 1, null);
    } finally {
      for (const w of windows) {
        try { if (!w.isDestroyed()) w.destroy(); } catch { /* 退出中，忽略 */ }
      }
    }
  }

  _onStdout(job, chunk) {
    job._stdout += chunk;
    let i;
    while ((i = job._stdout.indexOf('\n')) >= 0) {
      const line = job._stdout.slice(0, i).trim();
      job._stdout = job._stdout.slice(i + 1);
      if (!line) continue;
      let e;
      try { e = JSON.parse(line); } catch { this._log(job, line.slice(0, 300)); continue; }
      this._onEvent(job, e);
    }
  }

  _onEvent(job, e) {
    if (e.t === 'log') { this._log(job, e.msg); return; }
    if (e.t === 'step') { this._log(job, `· ${e.name}`); return; }
    if (e.t === 'gate') { job.gate = e.value; this._log(job, `校验通过：引擎 ${e.value.engineVersion}｜领域包 ${e.value.pack}`); return; }
    if (e.t === 'progress') {
      job.progress = { ...e, at: Date.now() };
      this._publish(job, { t: 'progress' });
      return;
    }
    if (e.t === 'result') { job.result = e.value; return; }
    if (e.t === 'error') { job.error = { message: e.message, validation: e.validation || null }; return; }
  }

  _log(job, msg) {
    const entry = { at: Date.now(), msg: String(msg) };
    job.logs.push(entry);
    if (job.logs.length > LOG_LIMIT) job.logs.splice(0, job.logs.length - LOG_LIMIT);
    this._publish(job, { t: 'log', entry });
  }

  _onExit(job, code, signal) {
    job.child = null;
    job.endedAt = Date.now();
    if (job.cancelRequested) {
      job.status = 'cancelled';
      if (job.cleanupOnExit) {
        try {
          rmSync(job.outDir, { recursive: true, force: true });
          this._log(job, '已取消，产物目录已清理（不残留半成品）');
        } catch (e) {
          this._log(job, `清理产物目录失败：${e.message}`);
        }
      } else {
        this._log(job, '已取消；断点保留，可「续渲」接着跑');
      }
    } else if (code === 0 && job.result) {
      job.status = 'done';
      this._log(job, '完成');
    } else {
      job.status = 'failed';
      if (!job.error) {
        job.error = {
          message: code === 0
            ? '子进程正常退出，但没有返回结果（多半是它自己提前退了；OSR 后端尤要留意 Electron 的 window-all-closed）'
            : signal
              ? `子进程被信号 ${signal} 终止（多半是被外部 kill 了）`
              : `子进程退出码 ${code}`,
        };
      }
      job.error.retryable = true;
      this._log(job, `失败：${job.error.message}`);
    }
    this._publish(job, { t: 'status' });
  }

  /**
   * 取消。
   * @param {string} id
   * @param {{cleanup?: boolean}} opts cleanup=true 时连产物目录一起清掉（默认，对齐 §4.2 的"取消后不残留半成品"）
   */
  cancel(id, opts = {}) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, message: '任务不存在' };
    if (!job.child) return { ok: false, message: `任务已经结束（${job.status}）` };
    job.cancelRequested = true;
    job.cleanupOnExit = opts.cleanup !== false;
    this._log(job, job.cleanupOnExit ? '收到取消请求：终止子进程并清理产物' : '收到取消请求：保留断点');
    try { job.child.kill('SIGTERM'); } catch (e) { this._log(job, `SIGTERM 失败：${e.message}`); }
    const child = job.child;
    setTimeout(() => {
      if (job.child === child && job.child) {
        this._log(job, '子进程没有在 8 秒内收手，强杀');
        try { job.child.kill('SIGKILL'); } catch { /* ignore */ }
      }
    }, KILL_GRACE_MS).unref?.();
    return { ok: true };
  }

  /** 关机时把还活着的子进程都收掉，别留孤儿。 */
  disposeAll() {
    for (const job of this.jobs.values()) {
      if (job.child) { try { job.child.kill('SIGKILL'); } catch { /* ignore */ } }
    }
  }
}

/** 对外快照：去掉 child / spec 这类不该过 HTTP 的东西。 */
function snapshot(job) {
  return {
    id: job.id,
    kind: job.kind,
    title: job.title,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    outDir: job.outDir,
    renderer: job.renderer,
    pid: job.pid,
    progress: job.progress,
    gate: job.gate,
    result: job.result,
    error: job.error,
    logs: job.logs.slice(-80),
    retryable: !!job.error?.retryable && existsSync(job.outDir),
    renderedAlready: countRenderedFrames(job.outDir),
  };
}

/** 已经渲好多少帧（用来在界面上显示"可续渲 N 帧"）。 */
export function countRenderedFrames(outDir) {
  let n = 0;
  for (const orientation of ['vertical', 'horizontal']) {
    const dir = join(outDir, orientation, 'frames');
    try {
      n += readdirSync(dir).filter((f) => f.endsWith('.png')).length;
    } catch { /* 还没渲 */ }
  }
  return n;
}
