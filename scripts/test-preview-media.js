#!/usr/bin/env node
/**
 * 验证「本机内文件」预览：视频能不能播、网页能不能渲染。
 *
 * 为什么要有它（2026-10-08）：
 *   用户最早要的就是"预览里能看 mp4 / 打开 html 不是一串源码"，但这件事被拖了很久，
 *   期间还出现过"说做好了其实没做"的情况。所以这次不靠嘴说 —— 起一个**隔离实例**
 *   （独立 userData + 独立调试端口，不碰用户正在用的那个），自动打开面板、真的点这两个文件，
 *   用 DOM 断言 + 截图给证据。
 *
 * 用法：node scripts/test-preview-media.js [测试素材目录]
 * 产出：/tmp/dw-preview-evidence/*.png（视频帧、网页渲染）
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const DIR = process.argv[2] || path.join(process.env.HOME, 'DeepSeek Harness', '测试素材');
const PORT = 9333;
const USER_DATA = path.join('/tmp', 'dw-preview-verify-' + Date.now());
const OUT = '/tmp/dw-preview-evidence';
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitPort(port, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => {
        if (Date.now() - t0 > timeoutMs) return reject(new Error('调试端口迟迟没起来'));
        setTimeout(tick, 400);
      });
      req.on('timeout', () => { req.destroy(); });
    };
    tick();
  });
}

(async () => {
  // ⚠️ 必须清掉 ELECTRON_RUN_AS_NODE：在 DSH 桌面端的 shell 里跑本脚本时它是 1，
  // Electron 会退化成普通 Node（require('electron') 拿不到 app），启动立刻报
  // `Cannot read properties of undefined (reading 'getPath')`。实测踩过。
  const childEnv = Object.assign({}, process.env);
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const app = spawn(
    path.join(__dirname, '..', 'node_modules', '.bin', 'electron'),
    ['.', '--user-data-dir=' + USER_DATA, '--remote-debugging-port=' + PORT],
    { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'], env: childEnv },
  );
  let mainLog = '';
  app.stdout.on('data', (d) => { mainLog += d.toString(); });
  app.stderr.on('data', (d) => { mainLog += d.toString(); });

  const results = [];
  let failed = 0;
  const check = (name, ok, detail) => {
    results.push({ name, ok, detail });
    if (!ok) failed++;
    console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? ' —— ' + detail : ''}`);
  };
  try {
    await waitPort(PORT, 60000);

    // 用原生 WebSocket 直连 CDP（Node 22+ 自带），**不引第三方依赖** ——
    // 这样这个测试在任何一台装了本仓库的机器上都能跑，也不会和 canvas 那边的依赖耦合。
    // DSH 服务起得比 Electron 窗口慢：窗口先显示「启动中」页，服务就绪后才导航到
    // http://127.0.0.1:<port>。所以要**轮询等它**，不能只查一次（第一次查只会看到启动页）。
    const listTargets = () => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: PORT, path: '/json/list' }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
      }).on('error', reject);
    });
    let target = null;
    let lastSeen = '';
    for (let i = 0; i < 90 && !target; i++) {
      const targets = await listTargets().catch(() => []);
      lastSeen = (targets || []).map((t) => t.type + ':' + (t.url || '').slice(0, 50)).join(' | ');
      target = (targets || []).find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+\//.test(t.url || ''));
      if (!target) await sleep(1000);
    }
    if (!target) throw new Error('等不到 DSH 页面（最后看到的 target: ' + lastSeen + '）');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    let seq = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    const send = (method, params) => new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression, args) => {
      // expression 本身就是 `async (args) => {...}`，直接调用它；
      // awaitPromise 会等里面的 await 走完（之前写成 Promise.resolve(fn)(args)，
      // 等于先 resolve 再当函数调用 → TypeError: not a function）。
      const r = await send('Runtime.evaluate', {
        expression: '(' + expression + ')(' + JSON.stringify(args || {}) + ')',
        awaitPromise: true, returnByValue: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 200));
      return r.result.value;
    };
    const shot = async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    };
    await sleep(3000);

    for (const [file, kind, ext] of [
      ['示例视频.mp4', 'video', 'mp4'],
      ['示例网页.html', 'html', 'html'],
    ]) {
      const full = path.join(DIR, file);
      if (!fs.existsSync(full)) { check(file + ' 存在', false, '测试素材没找到：' + full); continue; }
      check(file + ' 存在', true);

      const out = await evaluate(async (args) => {
        // ① 主进程这一侧：接口返回什么
        const res = await window.dsh.localFilesPreview(args.full);
        // ② 打开面板 → 跳到素材目录 → 点这个文件
        if (window.__dshLocalFiles && typeof window.__dshLocalFiles.open === 'function') {
          window.__dshLocalFiles.open();
        }
        const input = document.querySelector('#dsh-local-files-panel-path');
        if (input) {
          input.value = args.dir;
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        }
        await new Promise((r) => setTimeout(r, 1200));
        const rows = Array.from(document.querySelectorAll('#dsh-local-files-panel-list > div'));
        const row = rows.find((x) => (x.title || '').indexOf(args.file) >= 0);
        if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 2500));
        const body = document.getElementById('dsh-local-files-panel-preview-body');
        const video = body ? body.querySelector('video') : null;
        const frame = body ? body.querySelector('iframe') : null;
        return {
          ipcKind: res && res.kind,
          ipcError: res && res.error,
          hasRow: !!row,
          hasVideo: !!video,
          videoW: video ? video.videoWidth : 0,
          videoH: video ? video.videoHeight : 0,
          videoDur: video ? video.duration : 0,
          hasIframe: !!frame,
          iframeSandbox: frame ? frame.getAttribute('sandbox') : null,
          iframeSrcdocLen: frame ? (frame.getAttribute('srcdoc') || '').length : 0,
          bodyHTML: body ? body.innerHTML.slice(0, 160) : '',
        };
      }, { full, dir: DIR, file });

      check(`${file} → 主进程返回 kind=${kind}`, out.ipcKind === kind, '实际: ' + (out.ipcKind || out.ipcError));
      check(`${file} → 面板里找到这一行`, out.hasRow, '');
      if (kind === 'video') {
        check('面板里生成了 <video>', out.hasVideo, '');
        check('视频**真的解码出画面**（videoWidth>0）', out.videoW > 0,
          `videoWidth=${out.videoW} videoHeight=${out.videoH} duration=${(out.videoDur || 0).toFixed(2)}s`);
      } else {
        check('面板里生成了 <iframe>', out.hasIframe, '');
        check('iframe 带 sandbox（脚本不许跑）', out.iframeSandbox === '', 'sandbox=' + JSON.stringify(out.iframeSandbox));
        check('iframe 拿到了网页内容', out.iframeSrcdocLen > 100, 'srcdoc 长度=' + out.iframeSrcdocLen);
      }
      await shot(path.join(OUT, ext + '.png'));
      console.log(`     截图: ${path.join(OUT, ext + '.png')}`);
    }

    // ③ 搜索栏（2026-10-08 用户要求：文件太多难找）
    const sr = await evaluate(async (args) => {
      if (window.__dshLocalFiles) window.__dshLocalFiles.open();
      const input = document.querySelector('#dsh-local-files-panel-path');
      if (input) { input.value = args.dir; input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); }
      await new Promise((r) => setTimeout(r, 1200));
      const rows = () => document.querySelectorAll('#dsh-local-files-panel-list > div').length;
      const s = document.querySelector('#dsh-local-files-panel-search');
      if (!s) return { hasSearch: false };
      const all = rows();
      s.value = 'mp4'; s.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const filtered = rows();
      s.value = 'zzzzz'; s.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 300));
      const none = rows();
      s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
      return { hasSearch: true, all: all, filtered: filtered, none: none };
    }, { dir: DIR });
    check('搜索栏存在', sr.hasSearch, '');
    check('搜索能过滤（mp4 → 行数变少）', sr.hasSearch && sr.filtered > 0 && sr.filtered < sr.all,
      `${sr.all} → ${sr.filtered}`);
    check('搜不到时有"无匹配"提示', sr.hasSearch && sr.none === 1, '行数=' + sr.none);

    // ④ 预览最大化（用户反复提的那件事）
    const mx = await evaluate(async (args) => {
      const rowsAll = Array.from(document.querySelectorAll('#dsh-local-files-panel-list > div'));
      const row = rowsAll.find((x) => (x.title || '').indexOf('示例视频.mp4') >= 0);
      if (row) row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 2200));
      const btn = document.querySelector('#dsh-local-files-panel-preview-max');
      const body = document.querySelector('#dsh-local-files-panel-preview-body');
      const list = document.querySelector('#dsh-local-files-panel-list');
      if (!btn || !body) return { hasBtn: false };
      const before = { maxH: body.style.maxHeight, listShown: list ? list.style.display !== 'none' : null };
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      const v = body.querySelector('video');
      const after = { maxH: body.style.maxHeight, listShown: list ? list.style.display !== 'none' : null,
        videoH: v ? v.style.height : '' };
      return { hasBtn: true, before: before, after: after };
    }, {});
    check('预览头有最大化按钮', mx.hasBtn, '');
    check('点最大化后预览铺满（不再 46vh，列表收起）',
      mx.hasBtn && mx.after.maxH === 'none' && mx.after.listShown === false,
      JSON.stringify(mx.after));
    check('最大化后视频跟着铺满', mx.hasBtn && mx.after.videoH === '100%', 'video height=' + (mx.after && mx.after.videoH));
    await shot(path.join(OUT, 'maximized.png'));
    console.log('     截图: ' + path.join(OUT, 'maximized.png'));

    // ⑤ 面板全屏（用户 2026-10-08：要像官方「工作区文件」那样全屏显示）
    // 分两步：先点全屏 → 截图 → 再还原（同一个 evaluate 里没法中途截图）
    const fsc1 = await evaluate(async () => {
      if (window.__dshLocalFiles) window.__dshLocalFiles.open();
      await new Promise((r) => setTimeout(r, 500));
      const panel = document.querySelector('#dsh-local-files-panel');
      const btn = document.querySelector('#dsh-local-files-panel-full');
      if (!panel || !btn) return { hasBtn: false };
      const before = getComputedStyle(panel).width;
      btn.click();
      await new Promise((r) => setTimeout(r, 500));
      return { hasBtn: true, before: before, full: getComputedStyle(panel).width, vw: window.innerWidth };
    }, {});
    await shot(path.join(OUT, 'fullscreen.png'));
    const fsc2 = await evaluate(async () => {
      const panel = document.querySelector('#dsh-local-files-panel');
      const btn = document.querySelector('#dsh-local-files-panel-full');
      btn.click();
      await new Promise((r) => setTimeout(r, 400));
      return { after: getComputedStyle(panel).width };
    }, {});
    const fsc = { hasBtn: fsc1.hasBtn, before: fsc1.before, full: fsc1.full, vw: fsc1.vw, after: fsc2.after };
    check('面板有全屏按钮', fsc.hasBtn, '');
    check('点全屏后铺满窗口宽度', fsc.hasBtn && Math.abs(parseFloat(fsc.full) - fsc.vw) < 2,
      `${fsc.before} → ${fsc.full}（窗口宽 ${fsc.vw}）`);
    check('还原后回到窄栏', fsc.hasBtn && fsc.after === fsc.before, '还原后=' + fsc.after);

    // ⑥ 关掉面板后主界面不能留痕迹（用户原话：「不能对主界面有干扰」）
    const clean = await evaluate(async () => {
      if (window.__dshLocalFiles && window.__dshLocalFiles.close) window.__dshLocalFiles.close();
      await new Promise((r) => setTimeout(r, 400));
      const panel = document.querySelector('#dsh-local-files-panel');
      return { display: panel ? getComputedStyle(panel).display : 'gone',
        count: document.querySelectorAll('#dsh-local-files-panel').length };
    }, {});
    check('关闭后面板不可见（主界面无残留）', clean.display === 'none' || clean.display === 'gone',
      'display=' + clean.display + ' · DOM 中面板数=' + clean.count);
    ws.close();
  } catch (e) {
    check('验证过程本身', false, e.message);
  } finally {
    app.kill('SIGTERM');
    await sleep(1500);
    try { app.kill('SIGKILL'); } catch (e) { /* 已退出 */ }
    fs.writeFileSync(path.join(OUT, 'app.log'), mainLog.slice(-4000));
  }

  console.log('\n' + (failed === 0 ? '✅ 全部通过（' + results.length + ' 项）' : `❌ ${failed} 项失败 / 共 ${results.length} 项`));
  console.log('证据目录: ' + OUT);
  process.exit(failed === 0 ? 0 : 1);
})();
