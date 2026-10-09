#!/usr/bin/env node
/**
 * 可复用的隔离实例运行器。
 *
 * 为什么需要它（2026-10-08 连踩三次）：
 *   ① 直接跑 `electron .` 会**复用用户正在跑的服务** → 冒烟报出一串假红；
 *   ② 应用的服务端口与 `--remote-debugging-port` **设成同一个数** → 窗口被调试端点
 *      占住，直接开成「Content shell remote debugging」调试列表页，看起来像点不动；
 *   ③ 每次启动都 `rmSync(DSH_HOME)` → **刚 bootstrap 好的运行时被删掉**，
 *      于是每次都从头 `npx @deepseek-ai/dsh@…`，等几分钟也起不来。
 *
 * 本脚本的设计：
 *   · DSH_HOME 默认**保留**（第二次起几乎秒开）；`--reset` 才清空重来；
 *   · 应用服务端口用默认值，CDP 单独用 9333（**绝不撞车**）；
 *   · 清掉会泄漏进子进程的 DSH_* / ELECTRON_RUN_AS_NODE；
 *   · 等页面导航到 http://127.0.0.1:<port>/ 才认为"DSH 起来了"，
 *     期间每 15 秒打一次进度（能看到它是在装、还是在等）。
 *
 * 用法：
 *   node scripts/isolated-run.js              # 复用 home
 *   node scripts/isolated-run.js --reset      # 清空重建
 *   CANVAS_SHOT=1 node scripts/isolated-run.js   # 起来后点开画布面板并截图
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const path = require('path'); const http = require('http');
const net = require('net');

const ROOT = path.join(__dirname, '..');
const HOME_DIR = process.env.ISO_HOME || '/tmp/dw-iso-home';
const UD = '/tmp/dw-iso-ud';
const CDP_PORT = Number(process.env.ISO_CDP_PORT || 9333);
const RESET = process.argv.includes('--reset');
const DO_SHOT = process.env.CANVAS_SHOT === '1';
const OUT = '/tmp/dw-iso-shots';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (RESET) {
  console.log('[iso] --reset：清空 home 与 userData');
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
  fs.rmSync(UD, { recursive: true, force: true });
}
fs.mkdirSync(HOME_DIR, { recursive: true });
fs.mkdirSync(UD, { recursive: true });
// ⚠️ **服务端口也必须隔离**（2026-10-08 踩到）：
//    不写 settings.json 时应用用默认 3095 —— 正好和用户正在跑的服务撞上，
//    隔离实例会连到"别人的服务"且没有令牌 → 落到
//    「dsh web authentication required」页，侧栏根本没有插件入口。
//    这里给隔离实例一个专属服务端口（与 CDP 端口不同，两个都不撞）。
const APP_PORT = Number(process.env.ISO_APP_PORT || 3311);
fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({ port: APP_PORT }));
console.log('[iso] 应用服务端口=' + APP_PORT + '（与用户实例隔离）');

// ⚠️ **启动前清掉隔离端口上的残留服务**（2026-10-09 找到的真正原因）
//   DSH 的鉴权是「启动令牌 → 换持久化 Cookie」：
//     URL 带 token → 换成 dsh-auth-<hash> Cookie → 之后裸地址靠 Cookie 就能进。
//   应用只有在**自己拉起服务**时才拿得到那个启动令牌（从服务 stdout 解析）。
//   而应用退出时默认 keepDshRunning=true（下次秒开）——**复用已在跑的服务**时，
//   令牌日志行是上一次打的，本次拿不到；若此时 Cookie 又被清掉（--reset），
//   就成了"没有令牌可换 → 没有 Cookie → 认证页"。
//   这个组合**真实用户不会遇到**（正常使用 Cookie 一直在 userData 里）。
//   所以修的是测试环境：隔离端口上不许有残留服务，应用必须自己拉起来。
try {
  const { execFileSync } = require('child_process');
  const pids = execFileSync('lsof', ['-t', '-nP', '-iTCP:' + APP_PORT, '-sTCP:LISTEN'], { encoding: 'utf8' })
    .split('\n').map((x) => x.trim()).filter(Boolean)
    .filter((pid) => String(pid) !== String(process.pid));
  for (const pid of pids) {
    try { process.kill(Number(pid), 'SIGTERM'); console.log('[iso] 清掉隔离端口上的残留服务 pid=' + pid); } catch { /* 已退出 */ }
  }
  if (pids.length) require('child_process').execSync('sleep 2');
} catch {
  /* lsof 没找到就是不占，正常 */
}
fs.mkdirSync(OUT, { recursive: true });

const env = Object.assign({}, process.env);
for (const k of ['ELECTRON_RUN_AS_NODE', 'DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_PROFILE_DIR']) delete env[k];
env.DSH_HOME = HOME_DIR;
env.DSH_PROFILE = 'deepwhale';

const listTargets = () => new Promise((res) => {
  http.get({ host: '127.0.0.1', port: CDP_PORT, path: '/json/list' }, (r) => {
    let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch { res([]); } });
  }).on('error', () => res([]));
});

(async () => {
  console.log(`[iso] home=${HOME_DIR}  CDP=${CDP_PORT}`);
  const app = spawn(path.join(ROOT, 'node_modules', '.bin', 'electron'),
    ['.', '--user-data-dir=' + UD, '--remote-debugging-port=' + CDP_PORT],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], env });
  let log = '';
  app.stdout.on('data', (d) => { log += d; });
  app.stderr.on('data', (d) => { log += d; });

  let target = null; let lastSeen = '';
  const started = Date.now();
  for (let i = 0; i < 120 && !target; i++) {           // 最多等 10 分钟
    const targets = await listTargets();
    lastSeen = targets.map((t) => t.type + ':' + String(t.url || '').slice(0, 50)).join(' | ');
    target = targets.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url || ''));
    if (!target) {
      if (i % 15 === 0) {
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`[iso] 等页面… ${secs}s  targets=[${lastSeen.slice(0, 120)}]`);
        if (i > 0) fs.writeFileSync(path.join(OUT, 'boot.log'), log.slice(-4000));
      }
      await sleep(5000);
    }
  }
  fs.writeFileSync(path.join(OUT, 'app.log'), log.slice(-8000));
  if (!target) {
    console.log('[iso] ❌ 10 分钟内没等到 DSH 页面');
    console.log('[iso] 引导日志尾部：');
    console.log(log.slice(-1200).split('\n').map((l) => '    ' + l).join('\n'));
    app.kill('SIGTERM');
    process.exit(1);
  }
  const secs = ((Date.now() - started) / 1000).toFixed(0);
  console.log(`[iso] ✅ DSH 页面就绪（${secs}s）：${target.url}`);

  if (!DO_SHOT) { console.log('[iso] （未设 CANVAS_SHOT=1，只验证到"起来"这一步）'); app.kill('SIGTERM'); process.exit(0); }

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true }); });
  let seq = 0; const pend = new Map();
  ws.addEventListener('message', (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  const send = (method, params) => new Promise((res, rej) => { const id = ++seq; pend.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); ws.send(JSON.stringify({ id, method, params })); });
  let ev = async (fn, args) => { const r = await send('Runtime.evaluate', { expression: '(' + fn + ')(' + JSON.stringify(args || {}) + ')', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  let shot = async (f) => { const r = await send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); };

  // ⚠️ 关键：页面出现 != 应用就绪（2026-10-08 踩到）。
  //   应用先导航到 http://127.0.0.1:<port>/，此时可能还是
  //   「dsh web authentication required」中间态（令牌还没接上），
  //   紧接着才会二次导航到真正的界面。**必须等内容变成应用 UI 再动手**，
  //   否则后面"找不到侧栏入口"根本不是插件的问题，是等错了时机。
  let ready = false;
  for (let i = 0; i < 60 && !ready; i++) {
    const t = await ev(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 300), {});
    // 判据要**只认「是不是应用界面」**：早先我拿「重新连接中」当未就绪，
    // 但那是页面里**常驻**的一个状态元素 → 永远等不到，白等 110 秒。
    const isAuthPage = /authentication required/i.test(t || '');
    const isAppUi = /新会话|工作区|插件/.test(t || '');
    if (!isAuthPage && isAppUi) { ready = true; console.log('[iso] ✅ 应用界面就绪（等 ' + (i * 2) + 's）'); break; }
    if (i % 5 === 0) console.log('[iso] 等应用就绪… ' + (i * 2) + 's  当前: ' + String(t).slice(0, 60));
    await sleep(2000);
  }
  if (!ready) console.log('[iso] ⚠️ 页面始终不是应用界面，仍继续（结果可能不可信）');

  // ⚠️ 应用在起来后可能**还会补载一次**（令牌到位才 loadURL(dshTokenUrl)），
  //   那一下会把当前 CDP 执行上下文销毁 → "Inspected target navigated or closed"。
  //   所以：等它稳定，然后**重新取一次 target 并重连**再往下走。
  await sleep(6000);
  let t2 = null;
  for (let i = 0; i < 20 && !t2; i++) {
    const list = await listTargets();
    t2 = list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url || ''));
    if (!t2) await sleep(1000);
  }
  if (t2 && t2.webSocketDebuggerUrl !== target.webSocketDebuggerUrl) {
    console.log('[iso] 页面导航过 —— 重新连接 CDP');
    try { ws.close(); } catch { /* 已断 */ }
    target = t2;
    // eslint-disable-next-line no-global-assign
    const ws2 = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws2.addEventListener('open', res, { once: true }); ws2.addEventListener('error', () => rej(new Error('CDP 重连失败')), { once: true }); });
    seq = 0;
    pend.clear();
    ws2.addEventListener('message', (ev2) => { let m; try { m = JSON.parse(ev2.data); } catch { return; } if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
    const send2 = (method, params) => new Promise((res, rej) => { const id = ++seq; pend.set(id, (m) => (m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result))); ws2.send(JSON.stringify({ id, method, params })); });
    ev = async (fn, args) => { const r = await send2('Runtime.evaluate', { expression: '(' + fn + ')(' + JSON.stringify(args || {}) + ')', awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
    shot = async (f) => { const r = await send2('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(f, Buffer.from(r.data, 'base64')); };
  }

  const found = await ev(async () => {
    const all = [...document.querySelectorAll('button,a,[role="button"],li,div,span')];
    const btn = all.find((n) => (n.textContent || '').trim() === '深鲸画布');
    return { has: !!btn, text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 200) };
  }, {});
  console.log('[iso] 侧栏有「深鲸画布」入口:', found.has);
  console.log('[iso] 页面文本:', found.text.slice(0, 160));
  await shot(path.join(OUT, 'app.png'));
  if (found.has) {
    const r2 = await ev(async () => {
      const btn = [...document.querySelectorAll('button,a,[role="button"],li,div,span')].find((n) => (n.textContent || '').trim() === '深鲸画布');
      if (btn) btn.click();
      await new Promise((r) => setTimeout(r, 5000));
      const root = document.querySelector('.dshcv-root');
      // 等引擎状态：面板要先 fetch /api/state，慢的话多等一会
      for (let i = 0; i < 12; i++) {
        if (document.querySelectorAll('.dshcv-tpl').length > 0) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      // 直接看插件接口返回什么 —— 引擎没起来的话这里能看到原因
      let apiState = null;
      try {
        const r = await fetch('http://127.0.0.1:' + location.port + '/dsh-canvas/api/state');
        apiState = { status: r.status, body: (await r.text()).slice(0, 400) };
      } catch (e) { apiState = { error: String(e) }; }
      return {
        root: document.querySelectorAll('.dshcv-root').length,
        tpls: document.querySelectorAll('.dshcv-tpl').length,
        posters: document.querySelectorAll('.dshcv-poster').length,
        text: (root || document.body).innerText.replace(/\s+/g, ' ').slice(0, 400),
        apiState: apiState,
      };
    }, {});
    console.log('[iso] 画布面板:', JSON.stringify(r2).slice(0, 500));
    await shot(path.join(OUT, 'panel.png'));
    console.log('[iso] 截图：' + path.join(OUT, 'panel.png'));
  }
  ws.close();
  console.log('[iso] 完成（保留 home，下次秒开）');
  app.kill('SIGTERM');
  await sleep(2000);
  process.exit(0);
})();
