/**
 * 系统浏览器出帧适配器（Chromium over CDP）。
 *
 * 为什么是它（2026-10-09 定，替代前面两个方案）：
 *   插件的宿主半边跑在 DSH 服务进程里，那是 **ELECTRON_RUN_AS_NODE** 模式的 Electron，
 *   `require('electron')` 拿不到 BrowserWindow → 进程内离屏渲染不可行；
 *   而"另起一个 Electron 进程"要求机器上存在**能接受脚本参数的 Electron 二进制**，
 *   安装版是打包过的 .app，它忽略脚本参数 → 这条路在真实用户机器上必然失败
 *   （表现为任务失败：Cannot find package 'playwright-core'）。
 *
 *   渲染其实只需要**一个有 Chromium 的东西**，而用户机器上本来就有：
 *   Windows 自带 Edge、macOS 多数人装了 Chrome。于是：自己把系统浏览器
 *   headless 起起来、走 CDP 逐帧出图 —— **零额外依赖、不绑桌面端版本**，
 *   连"必须用我们的桌面端"这个前提都去掉了。
 *
 * 与 ChromiumAdapter（playwright）的区别：不依赖任何 npm 包，只用 Node 内置能力
 * + CDP 的 WebSocket 会话（Node 22+ 自带全局 WebSocket）。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import http from 'node:http';

/** 各平台常见的 Chromium 系浏览器位置（顺序即优先级）。 */
const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
  linux: ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge', '/snap/bin/chromium'],
};

/** 本机可用的 Chromium 系浏览器（找不到返回 null）。 */
export function findSystemBrowser() {
  for (const p of CANDIDATES[process.platform] || []) {
    if (existsSync(p)) return p;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 拿一个空闲端口（让系统分配，避免与用户的东西撞车）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function getJson(port, path) {
  return new Promise((resolve) => {
    http
      .get({ host: '127.0.0.1', port, path, timeout: 2000 }, (r) => {
        let b = '';
        r.on('data', (c) => { b += c; });
        r.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } });
      })
      .on('error', () => resolve(null))
      .on('timeout', function () { this.destroy(); resolve(null); });
  });
}

export class SystemBrowserAdapter {
  constructor({ width, height, fps = 30, frameTimeoutMs = 20000, browserPath = null } = {}) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.frameTimeoutMs = frameTimeoutMs;
    this.browserPath = browserPath || findSystemBrowser();
    this.child = null;
    this.port = 0;
    this.profile = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.targetId = null;
  }

  get id() {
    return 'system-browser';
  }

  _send(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const msg = { id, method, params: params || {} };
      if (sessionId) msg.sessionId = sessionId;
      this.pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + m.error.message)) : resolve(m.result)));
      this.ws.send(JSON.stringify(msg));
    });
  }

  async prepare(html) {
    if (!this.browserPath) {
      throw new Error('找不到可用的 Chromium 系浏览器（Chrome / Edge / Chromium）。装一个即可，或改用其它渲染后端。');
    }
    this.profile = mkdtempSync(join(tmpdir(), 'dw-render-'));
    this.port = await freePort();
    this.child = spawn(this.browserPath, [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--hide-scrollbars',
      '--mute-audio',
      // 断网：渲染会话不允许任何网络请求（与 Electron 适配器同一条红线）
      '--host-resolver-rules=MAP * 0.0.0.0',
      `--remote-debugging-port=${this.port}`,
      `--user-data-dir=${this.profile}`,
      `--window-size=${this.width},${this.height}`,
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'ignore'] });

    // 等调试端点
    let ver = null;
    for (let i = 0; i < 60 && !ver; i++) {
      ver = await getJson(this.port, '/json/version');
      if (!ver) await sleep(500);
    }
    if (!ver) throw new Error('系统浏览器起来了但调试端点没应答（headless 被禁用？）');

    this.ws = new WebSocket(ver.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && this.pending.has(m.id)) { this.pending.get(m.id)(m); this.pending.delete(m.id); }
      if (m.method === 'Event') return;
    });

    const { targetId } = await this._send('Target.createTarget', { url: 'about:blank' });
    this.targetId = targetId;
    const attached = await this._send('Target.attachToTarget', { targetId, flatten: true });
    this.sessionId = attached.sessionId;

    await this._send('Page.enable', {}, this.sessionId);
    await this._send('Runtime.enable', {}, this.sessionId);
    await this._send('Emulation.setDeviceMetricsOverride',
      { width: this.width, height: this.height, deviceScaleFactor: 1, mobile: false }, this.sessionId);
    await this._send('Page.navigate',
      { url: 'data:text/html;charset=utf-8,' + encodeURIComponent(html) }, this.sessionId);

    // 等页面自报就绪（字体/图片/setFrame(0) 都跑完）
    for (let i = 0; i < 100; i++) {
      const r = await this._send('Runtime.evaluate',
        { expression: 'window.__canvas && window.__canvas.ready ? 1 : 0', returnByValue: true }, this.sessionId).catch(() => null);
      if (r && r.result && r.result.value === 1) break;
      await sleep(100);
    }
    await this._settle(0);
    const warnings = await this._send('Runtime.evaluate',
      { expression: 'window.__canvas.warnings || []', returnByValue: true }, this.sessionId).catch(() => null);
    return { warnings: (warnings && warnings.result && warnings.result.value) || [] };
  }

  /** 让这一帧真的提交到合成器：两次 rAF 之后再截图，才不会截到上一帧。 */
  async _settle(frameIndex) {
    await this._send('Runtime.evaluate', {
      expression: `new Promise((resolve) => {
 window.__canvas.setFrame(${frameIndex});
 void document.documentElement.offsetHeight;
 requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
})`,
      awaitPromise: true,
      returnByValue: true,
    }, this.sessionId);
  }

  async renderFrame(frameIndex) {
    // 与 Electron 适配器同一条纪律：**同一帧连取两次、字节一致才认**，
    // 避免偶发把上一帧交出去（那种"每帧慢一拍"的错最难查）。
    let prev = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this._settle(frameIndex);
      const shot = await this._send('Page.captureScreenshot', { format: 'png' }, this.sessionId);
      const buffer = Buffer.from(shot.data, 'base64');
      const cur = { buffer, bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') };
      if (prev && prev.sha256 === cur.sha256) return cur;
      prev = cur;
    }
    return prev;
  }

  async close() {
    try { if (this.ws) this.ws.close(); } catch { /* ignore */ }
    try { if (this.child) this.child.kill('SIGKILL'); } catch { /* ignore */ }
    this.child = null;
    this.ws = null;
    if (this.profile) {
      try { rmSync(this.profile, { recursive: true, force: true }); } catch { /* ignore */ }
      this.profile = null;
    }
  }
}
