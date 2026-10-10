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

import { existsSync, mkdirSync, statSync, createReadStream, createWriteStream, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { homedir } from 'node:os';
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

  /**
   * 成片保存位置（2026-10-09 用户要求：「第一张图生成的视频位置不能选，是默认位置，
   * 这个要修改下，尤其是后面我们做 win 版，如果都默认 c 盘就惨了，要求保存位置可以选择」）
   *
   * 原来默认塞在**插件目录**里（engine/out/app）—— 用户永远找不到，
   * Windows 上更是 AppData 深处（C 盘）。现在：
   *   · 默认 = 用户自己的影片目录下建一个「深鲸画布」
   *   · 用户可以在面板里改（state.outputDir），改完所有任务都落在那儿
   */
  const defaultOutputRoot = () => join(homedir(), 'Movies', '深鲸画布');

  // 保存位置要**记得住**（用户选过一次，重启不该忘）。
  // 存成 DSH home 下的小文件；读失败/写失败都不影响主流程（只是回到默认位置），
  // 但要打日志，不许完全无声。
  const prefsFile = () => join(process.env.DSH_HOME || homedir(), '.dsh-canvas-prefs.json');
  const readPrefs = () => {
    try { return JSON.parse(readFileSync(prefsFile(), 'utf8')); } catch { return {}; }
  };
  const writePrefs = (obj) => {
    try { writeFileSync(prefsFile(), JSON.stringify(obj, null, 2)); } catch (e) { console.warn('[canvas] 偏好写不进去：' + e.message); }
  };
  if (!state.outputDir) {
    const p0 = readPrefs().outputDir;
    if (p0 && typeof p0 === 'string') state.outputDir = p0;
  }
  const outputRoot = () => (state.outputDir ? resolve(state.outputDir) : defaultOutputRoot());

  /**
   * 默认渲染后端（2026-10-09 修）。
   * 原来写死 'chromium' —— 真机上没有 playwright-core，
   * 于是"重做模板预览图"直接报 `Cannot find package 'playwright-core'`（用户实测）。
   * 现在：有系统浏览器就用它（零依赖）；显式要求才用别的。
   * ⚠️ 对**所有**任务生效，不只是预览图。
   */
  const pickRenderer = (req) => {
    if (req && req.renderer === 'chromium') return 'chromium';
    if (req && req.renderer === 'electron-osr') return 'electron-osr';
    return state.electron && state.electron.systemBrowser ? 'electron-osr' : 'chromium';
  };

  /**
   * 常用保存位置（2026-10-09）。
   * 为什么不用系统"选择文件夹"对话框：在这类嵌入式窗口里，macOS 给的是个
   * **残缺的 Finder 窗口**（没有确定按钮），用户实测「我选择文件位置了，但没有确定，这搞毛啊」。
   * 结论：**不依赖系统对话框** —— 直接把常用目录给成按钮，点一下填进去，再点「确定」。
   * 这是按"插件自身实用性"走（用户定：不等宿主以后可能开放的能力）。
   */
  const commonDirs = () => {
    const home = homedir();
    const cands = [
      { label: '桌面', dir: join(home, 'Desktop') },
      { label: '影片', dir: join(home, 'Movies') },
      { label: '文稿', dir: join(home, 'Documents') },
      { label: '下载', dir: join(home, 'Downloads') },
      { label: '主目录', dir: home },
    ];
    return cands.map((c) => ({ ...c, exists: existsSync(c.dir) }));
  };

  const runtime = () => ({
    commonDirs: commonDirs(),
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

    // ★ 首选：**进程内 OSR**（2026-10-09）
    //   本插件跑在桌面端**主进程**里 —— `BrowserWindow` 现成可用，
    //   直接用宿主自带的 Chromium 离屏渲染即可。
    //   之前的设计是"另起一个 Electron 进程跑 osr-main.cjs"，于是要先找一个
    //   **能接受脚本参数的 Electron 二进制**；而安装版是打包过的 .app，
    //   它忽略脚本参数 → 探测必然失败 → 回落到 Playwright Chromium →
    //   真机上没有 playwright → 出片直接失败。
    //   进程内这条路把"找二进制"整个环节去掉了。
    // ★ 次选：**系统自带的 Chromium 系浏览器**（2026-10-09 定为主力）
    //   渲染只需要"一个有 Chromium 的东西"，而用户机器上本来就有：
    //   Windows 自带 Edge、macOS 多数人装了 Chrome。
    //   这条路**纯 Node、零 npm 依赖、不绑桌面端版本** —— 插件在 1.0.55 上也能用。
    //   客户端只认 osr.ok 这个开关（ok → 走非 playwright 后端），所以这里把
    //   "系统浏览器可用"也算作 ok，任务层再决定用哪个适配器。
    try {
      const { findSystemBrowser } = await import('./adapter-system-browser.mjs');
      const bin = findSystemBrowser();
      if (bin) {
        state.electron = {
          ok: true,
          systemBrowser: bin,
          path: bin,
          tried: [],
          reason: '',
        };
        return state.electron;
      }
    } catch { /* 探测失败就当没有，继续回落 */ }

    if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
      state.electron = {
        ok: true,
        inProcess: true,
        path: null,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        tried: [],
        reason: '',
      };
      return state.electron;
    }
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
    // 自定义文档（分镜表产出）：模板组可能根本不存在，这时**不查目录**，
    // 直接把它当作 pair 里那个方向 —— 流程各处只认 spec.pair，所以不用改流程。
    const customDoc = request.doc && typeof request.doc === 'object' ? request.doc : null;
    const orient = request.orientation === 'horizontal' ? 'horizontal' : 'vertical';
    const entry = customDoc
      ? { id: group || 'storyboard', name: '分镜表', vars: (customDoc.vars || []), orientations: { [orient]: {} } }
      : catalog.find((g) => g.id === group);
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
      pair: customDoc ? { [orient]: customDoc } : loadPair(root, group),
      customDoc: !!customDoc,
      vars,
      assets: request.assets || {},
      script: request.script || '',
      voiceoverFile: request.voiceoverFile || null,
      bgmId: request.bgmId || null,
      // 用户自己的背景音乐文件（绕过版权台账，责任在用户）
      bgmFile: (() => {
        const f = request.bgmFile || null;
        if (!f) return null;
        if (!existsSync(f)) throw httpError(400, `背景音乐文件不存在：${f}`);
        return f;
      })(),
      quality: request.quality || (request.kind === 'preview' ? 'preview' : 'final'),
      previewSeconds: Math.max(1, Math.min(30, Number(request.previewSeconds) || 4)),
      renderer: pickRenderer(request),
      rendererExtra: state.electron && state.electron.systemBrowser ? { systemBrowser: state.electron.systemBrowser } : null,
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
        renderer: pickRenderer(request),
      rendererExtra: state.electron && state.electron.systemBrowser ? { systemBrowser: state.electron.systemBrowser } : null,
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
      // ── 框架面（A）：把「生产者 / Provider / 批量」开给面板 ──────────────
      if (p === `${ROUTE}/api/output-dir` && req.method === 'POST') return send(res, 200, apiSetOutputDir(body));
      if (p === `${ROUTE}/api/pick-dir` && req.method === 'POST') return send(res, 200, await apiPickDir());
      if (p === `${ROUTE}/api/env-check` && req.method === 'GET') return send(res, 200, await apiEnvCheck());
      if (p === `${ROUTE}/api/producers` && req.method === 'GET') return send(res, 200, await apiProducers());
      if (p === `${ROUTE}/api/produce` && req.method === 'POST') return send(res, 200, await apiProduce(body));
      if (p === `${ROUTE}/api/providers` && req.method === 'GET') return send(res, 200, await apiProviders());
      if (p === `${ROUTE}/api/providers` && req.method === 'POST') return send(res, 200, await apiSaveProviders(body));
      if (p === `${ROUTE}/api/batch` && req.method === 'POST') return send(res, 200, await apiBatch(body));
      if (p === `${ROUTE}/api/engine` && req.method === 'POST') return send(res, 200, await apiSetEngine(body));
      if (p === `${ROUTE}/api/validate` && req.method === 'POST') return send(res, 200, await apiValidate(body));
      if (p === `${ROUTE}/api/job` && req.method === 'POST') return send(res, 200, await apiStartJob(body));
      if (p === `${ROUTE}/api/jobs` && req.method === 'GET') return send(res, 200, { jobs: jobs.list() });
      if (p === `${ROUTE}/api/job` && req.method === 'GET') return send(res, 200, jobs.get(url.searchParams.get('id')));
      if (p === `${ROUTE}/api/cancel` && req.method === 'POST') return send(res, 200, jobs.cancel(body.id, body));
      if (p === `${ROUTE}/api/posters` && req.method === 'POST') return send(res, 200, apiPosters(body));
      if (p === `${ROUTE}/api/reveal` && req.method === 'POST') return send(res, 200, apiReveal(body));
      if (p === `${ROUTE}/api/open` && req.method === 'POST') return send(res, 200, apiOpen(body));
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

  /* ── 框架面实现（A）───────────────────────────────────────────────
   * 面板从这里调「生产者 / Provider / 批量」，全部复用插件自带的引擎（engine/），
   * 不再另起一套。任何一条失败都要**抛出去**（面板要看得见），不许静默。
   */
  const engineRootFor = () => {
    const r = state.resolved;
    if (!r || !r.ok) throw httpError(409, '引擎未就绪，先在面板里指定引擎目录');
    return r.root;
  };

  /**
   * 环境自检（2026-10-10）：出片依赖两个"用户机器上不一定有"的东西 ——
   *   ① ffmpeg       合成编码的硬依赖
   *   ② 一个 Chromium 浏览器（Chrome/Edge）  出帧要用
   * 缺了不是"报个错就完事"：用户不知道怎么装。这里把**分平台的安装指引**一起给出去。
   * 别人的 DSH 上装我们的插件、或者新同事的电脑，第一步就会撞上这个。
   */
  async function apiEnvCheck() {
    const root = state.resolved?.root || null;
    let ffmpeg = { ok: false, path: null };
    if (root) {
      try {
        const { findFfmpeg } = await import(pathToFileURL(join(root, 'src/paths.mjs')).href);
        const f = findFfmpeg();
        ffmpeg = { ok: !!f, path: f };
      } catch (e) { ffmpeg = { ok: false, path: null, error: e.message }; }
    }
    const browser = state.electron && state.electron.systemBrowser
      ? { ok: true, name: state.electron.systemBrowser.name || '系统浏览器', path: state.electron.systemBrowser.path || null }
      : { ok: false, name: null, path: null };
    const guides = {
      macos: {
        ffmpeg: '在终端执行：brew install ffmpeg（没有 Homebrew 就先装 Homebrew）',
        browser: '安装 Google Chrome 或 Microsoft Edge 即可',
      },
      win32: {
        ffmpeg: '在 PowerShell 执行：winget install Gyan.FFmpeg（或去 ffmpeg.org 下载后把 bin 目录加进 PATH）',
        browser: '系统自带的 Microsoft Edge 就够（不用额外装）',
      },
      linux: {
        ffmpeg: 'apt install ffmpeg（或 dnf install ffmpeg）',
        browser: 'apt install chromium（或安装 Chrome / Edge）',
      },
    };
    return {
      ffmpeg, browser,
      platform: process.platform,
      guide: guides[process.platform] || guides.linux,
      ok: ffmpeg.ok && browser.ok,
    };
  }

  /**
   * 弹**系统自己的**文件夹对话框（2026-10-09 用户要求）。
   *
   * 为什么不能用网页那套：`<input webkitdirectory>` 在嵌入式窗口里给的是个
   * **残缺的 Finder 面板**（只有文件列表，没有确定按钮）—— 用户实测「我选择文件位置了，
   * 但没有确定，这搞毛啊」。用户判断：**得按系统的步骤来**。
   *
   * 所以改成调各平台自带的选择器：macOS 用 osascript（choose folder）、
   * Windows 用 PowerShell + FolderBrowserDialog、Linux 用 zenity。
   * 系统对话框**自带"选取/取消"**，选完即生效 —— 插件不该再多一个"确定"。
   * 取消返回 {cancelled:true}（不是错误，不能报成红字）。
   */
  async function apiPickDir() {
    // ⚠️ 2026-10-09 用户实测：「选择文件夹点了没反应」。
    //    最可能是原来用 **spawnSync 同步**调 osascript —— 对话框弹出来之前，
    //    整个插件服务（单线程）被卡住，那个 POST 一直挂着，界面看着就是"没反应"。
    //    改成**异步 spawn**：服务照常响应，弹窗照常出现，失败也能带出原因。
    const runAsync = (cmd, args, label) => new Promise((res) => {
      let out = '';
      let err = '';
      let done = false;
      const finish = (r) => { if (!done) { done = true; res(r); } };
      let child;
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        console.error(`[canvas] ${label} 起不来：${e.message}`);
        return finish({ ok: false, err: e.message });
      }
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', (e) => {
        console.error(`[canvas] ${label} 错误：${e.message}`);
        finish({ ok: false, err: e.message });
      });
      child.on('close', (code) => finish({ ok: true, code, out: out.trim(), err: err.trim() }));
      setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish({ ok: false, err: '超时（3 分钟没操作）' }); }, 180000);
    });

    const plat = process.platform;
    console.log('[canvas] 弹系统文件夹对话框：' + plat);
    if (plat === 'darwin') {
      const r = await runAsync('osascript', ['-e',
        'try\nPOSIX path of (choose folder with prompt "选择成片保存位置")\non error number -128\nreturn "CANCELLED"\nend try',
      ], 'osascript');
      if (!r.ok) throw httpError(500, `弹系统对话框失败：${r.err}（可以直接点上面的常用位置按钮）`);
      if (r.out === 'CANCELLED' || !r.out) return { cancelled: true };
      return { dir: r.out.replace(/\/+$/, '') };
    }
    if (plat === 'win32') {
      const ps = "Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '选择成片保存位置'; if ($d.ShowDialog() -eq 'OK') { Write-Output $d.SelectedPath }";
      const r = await runAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 'powershell');
      if (!r.ok) throw httpError(500, `弹系统对话框失败：${r.err}（可以直接点上面的常用位置按钮）`);
      return r.out ? { dir: r.out } : { cancelled: true };
    }
    const r = await runAsync('zenity', ['--file-selection', '--directory', '--title=选择成片保存位置'], 'zenity');
    if (!r.ok) throw httpError(500, `弹不出来（这台机器可能没装 zenity）：${r.err}。可以直接点上面的常用位置按钮`);
    return r.out ? { dir: r.out } : { cancelled: true };
  }

  /** 设/读成片保存位置。目录不存在就建；建不了就明确报错（不静默回退）。 */
  function apiSetOutputDir(body) {
    const dir = body && body.dir ? String(body.dir).trim() : '';
    if (!dir) return { ok: false, error: '没给目录' };
    const abs = resolve(dir);
    try {
      mkdirSync(abs, { recursive: true });
      // 真写一次，确认可写（只 stat 不够：可能有目录但只读）
      const probe = join(abs, '.dsh-canvas-write-test');
      writeFileSync(probe, 'ok');
      rmSync(probe, { force: true });
    } catch (e) {
      throw httpError(400, `这个位置不能写：${abs}（${e.message}）`);
    }
    state.outputDir = abs;
    writePrefs({ ...readPrefs(), outputDir: abs });   // 记住，重启不丢
    return { ok: true, dir: abs };
  }

  async function apiProducers() {
    const root = engineRootFor();
    const { listProducers, loadBuiltins } = await import(pathToFileURL(join(root, 'src/producers/index.mjs')).href);
    await loadBuiltins();
    return { producers: listProducers() };
  }

  async function apiProduce(body) {
    const root = engineRootFor();
    const { runProducer, loadBuiltins, assertAssetAllowed } = await import(pathToFileURL(join(root, 'src/producers/index.mjs')).href);
    const { providerAccessor, loadProvidersFromConfig } = await import(pathToFileURL(join(root, 'src/providers/index.mjs')).href);
    await loadBuiltins();
    try { loadProvidersFromConfig(); } catch (e) { /* 没配是正常情况 */ }
    // 素材白名单：允许"引擎目录 + 产物目录 + 用户显式给的目录"
    const allowRoots = [root, outputRoot(), ...(Array.isArray(body.allowRoots) ? body.allowRoots : [])];
    const assetDir = join(outputRoot(), 'assets');
    const doc = await runProducer(String(body.producer || ''), body.input || {}, {
      allowRoots,
      assertAsset: (f) => assertAssetAllowed(f, allowRoots),
      readText: (f) => readFileSync(resolve(f), 'utf8'),
      provider: providerAccessor(assetDir),
      assetDir,
      outDir: outputRoot(),
    });
    return { doc };
  }

  async function apiProviders() {
    const root = engineRootFor();
    const { listProviders, loadProvidersFromConfig } = await import(pathToFileURL(join(root, 'src/providers/index.mjs')).href);
    let info = null;
    try { info = loadProvidersFromConfig(); } catch (e) { info = { error: e.message }; }
    // ⚠️ 只回"有没有配 key"，**绝不回 key 本身**
    return { providers: listProviders(), config: info };
  }

  async function apiSaveProviders(body) {
    const file = join(process.env.DSH_HOME || homedir(), 'canvas-providers.json');
    const list = Array.isArray(body.providers) ? body.providers : [];
    writeFileSync(file, JSON.stringify({ providers: list }, null, 2) + '\n');
    return { ok: true, file, count: list.length };
  }

  async function apiBatch(body) {
    const root = engineRootFor();
    const { runBatch } = await import(pathToFileURL(join(root, 'src/batch.mjs')).href);
    const { runProducer, loadBuiltins, assertAssetAllowed } = await import(pathToFileURL(join(root, 'src/producers/index.mjs')).href);
    const { providerAccessor, loadProvidersFromConfig } = await import(pathToFileURL(join(root, 'src/providers/index.mjs')).href);
    await loadBuiltins();
    try { loadProvidersFromConfig(); } catch (e) { /* ignore */ }
    const allowRoots = [root, outputRoot()];
    const assetDir = join(outputRoot(), 'assets');
    const res = await runBatch(
      { producer: body.producer, quality: body.quality || 'final', jobs: body.jobs || [] },
      {
        outDir: body.outDir || join(outputRoot(), 'batch'),
        runProducer: (id, input) => runProducer(id, input, {
          allowRoots,
          assertAsset: (f) => assertAssetAllowed(f, allowRoots),
          readText: (f) => readFileSync(resolve(f), 'utf8'),
          provider: providerAccessor(assetDir),
          assetDir,
          outDir: outputRoot(),
        }),
        log: (m) => console.log('[canvas-batch] ' + m),
      },
    );
    return { manifest: { total: res.manifest.total, ok: res.manifest.ok, failed: res.manifest.failed }, manifestFile: res.manifestFile, items: res.manifest.items.map((x) => ({ id: x.id, ok: x.ok, out: x.out, error: x.error })) };
  }

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
    // 自定义文档（分镜表）没有"模板组"可校验 —— 跳过这一层，
    // 但**不跳过所有校验**：渲染时引擎仍会按文档 schema 校验。
    const gate = body.doc
      ? { ok: true, templates: [], skippedForCustomDoc: true }
      : await validateGroup(root, String(body.group || ''), body.vars || {});
    if (!gate.ok) {
      const first = gate.templates.flatMap((t) => t.issues).find((i) => i.level === 'error');
      const err = httpError(422, first ? `校验不通过，已拦下渲染：[${first.code}] ${first.msg}` : '校验不通过，已拦下渲染');
      err.validation = gate;
      throw err;
    }

    const { spec, entry, reuse } = buildSpec({ ...body, kind });   // body.doc 会被 buildSpec 用上
    // 标题只用中文（用户：要用中文就都中文，别中英混用）—— 不再拼（OSR）这种技术缩写
    const title = `${entry.name}·${kind === 'preview' ? '预览' : '终版'}`;
    return jobs.start(spec, { ...body, kind }, { title: reuse ? `${title}（续渲）` : title });
  }

  function apiPosters(body) {
    const { spec, catalog } = buildPosterSpec(body);
    return jobs.start(spec, { kind: 'posters' }, { title: `模板预览图（${catalog.length} 组）` });
  }

  /** 用系统默认程序打开文件本身（2026-10-08）——评审成片要看真实色彩/流畅度，
   *  浏览器里的 <video> 看不准，得能在系统播放器里放。
   *  与 apiReveal 的区别：reveal 是"在文件夹里选中它"，open 是"直接打开它"。
   *  权限与 reveal 一致：**只允许产物目录/引擎目录里的文件**（别让它变成任意文件执行口）。 */
  function apiOpen(body) {
    const target = String(body.path || '');
    const root = outputRoot();
    const abs = resolve(target);
    if (!inside(abs, root) && !inside(abs, state.resolved?.root || '')) {
      throw httpError(403, '只允许打开产物目录里的文件');
    }
    if (!existsSync(abs)) throw httpError(404, `路径不存在：${abs}`);
    if (statSync(abs).isDirectory()) throw httpError(400, '这是目录，用「打开位置」');
    const cmd = process.platform === 'darwin' ? ['open', [abs]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', abs]]
        : ['xdg-open', [abs]];
    try {
      spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref();
    } catch (error) {
      throw httpError(500, `打不开：${error.message}`);
    }
    return { ok: true, path: abs };
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
