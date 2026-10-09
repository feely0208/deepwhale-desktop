/**
 * Electron(OSR) 适配器 —— 桌面端内置渲染用（同一接口，S3 接进深鲸桌面）。
 *
 * 为什么是离屏渲染（offscreen）而不是隐藏窗口 + capturePage()：
 *   隐藏窗口截图在长任务里会丢帧/出黑帧，OSR 的 paint 事件是逐帧驱动的，可控得多。
 *
 * ⚠️ 本文件在 S1 未被执行——它需要 Electron 宿主。S1 只验证接口形态与实现路径，
 *    真正接线在 S3（画布插件）。
 *
 * 用法（S3）：
 *   const win = new BrowserWindow({ show:false, webPreferences:{ offscreen:true, nodeIntegration:false, contextIsolation:true } });
 *   win.webContents.setFrameRate(fps);
 *   const adapter = new ElectronOsrAdapter({ window: win, width, height, fps });
 */

import { RenderAdapter, frameFingerprint } from './adapter.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

export class ElectronOsrAdapter extends RenderAdapter {
  constructor({ window, width, height, fps = 30, session, frameTimeoutMs = 15000, warmupPaints = 1, confirmAttempts = 3 } = {}) {
    super();
    this.window = window;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.session = session;
    this.frameTimeoutMs = frameTimeoutMs;
    this.warmupPaints = warmupPaints;
    this.confirmAttempts = Math.max(2, confirmAttempts);
    this._pending = null;
    this._timer = null;
    this._paints = 0;
  }

  get id() { return 'electron-osr'; }

  /**
   * 让页面把 `setFrame(f)` 的结果真的**提交到合成器**，再请求下一次重绘。
   *
   * 为什么非等不可（S3 实测）：`executeJavaScript(setFrame)` 只保证 JS 跑完，
   * 样式 / 布局 / 绘制 / 合成还在后面几拍。紧接着调 `invalidate()` 拿到的 paint
   * 往往是**上一帧**的合成结果 —— 表现为整条片子每一帧都慢一帧
   * （第 N 次取到的是第 N-1 帧的像素）。两次 rAF 之后合成器已吃下这次变更，
   * 此时 invalidate 出来的才是这一帧。
   *
   * `void document.documentElement.offsetHeight` 强制一次同步布局，
   * 防止样式变更被推迟到下一次 rAF 之后。
   */
  _settle(frameIndex) {
    return this.window.webContents.executeJavaScript(`new Promise((resolve) => {
  window.__canvas.setFrame(${frameIndex});
  void document.documentElement.offsetHeight;
  requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
})`);
  }

  /** 请求一次重绘并等它的 paint。`_pending` 必须先挂上再 invalidate，否则漏掉这次 paint 会挂死。 */
  _nextPaint(frameIndex) {
    const wc = this.window.webContents;
    const painted = new Promise((resolve, reject) => {
      this._pending = resolve;
      this._timer = setTimeout(() => {
        this._pending = null;
        this._timer = null;
        reject(new Error(`OSR 出帧超时：第 ${frameIndex} 帧 ${this.frameTimeoutMs}ms 内没有 paint（断网过滤/窗口状态异常？）`));
      }, this.frameTimeoutMs);
    });
    wc.invalidate();
    return painted;
  }

  async prepare(html) {
    const wc = this.window.webContents;
    // 断网：渲染会话不允许任何**网络**请求（连"外链"这条路都要物理堵死）。
    //
    // ⚠️ 必须是"按协议列白名单式的黑名单"，不能一刀切 cancel 所有请求：
    //    本适配器是用 `data:text/html,...` 装载页面本身的，全量 cancel 会把
    //    **文档自己**也拦掉，loadURL 直接 ERR_BLOCKED_BY_CLIENT(-20)。
    //    （S3 实测踩到；S1 因为没真正执行过这个文件，一直没暴露。）
    if (this.session?.webRequest) {
      this.session.webRequest.onBeforeRequest(
        { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'] },
        (_details, cb) => cb({ cancel: true }),
      );
    }
    wc.on('paint', (_e, _dirty, image) => {
      this._paints++;
      if (this._pending) {
        const resolve = this._pending;
        this._pending = null;
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        const buf = image.toPNG();
        resolve({ buffer: buf, sha256: frameFingerprint(buf), bytes: buf.length });
      }
    });
    wc.setFrameRate?.(this.fps);
    // ⚠️ 2026-10-09 修：同上 —— 内联 base64 素材会让 data URL 过大，
    //   浏览器直接 ERR_INVALID_URL。改成写临时文件 + file:// 加载。
    const tmpHtml = join(this.session?.getStoragePath?.() || tmpdir(), `canvas-frame-${Date.now()}.html`);
    writeFileSync(tmpHtml, html, 'utf-8');
    await wc.loadURL('file://' + tmpHtml);
    // 等页面**自报就绪**：字体加载完、<img> 解码完、`setFrame(0)` 跑过第一遍。
    await wc.executeJavaScript('window.__canvas && window.__canvas.ready');
    // 预热：加载期那一次 paint 是 `setFrame(0)` **之前**的合成结果 ——
    // 画面看着像、状态其实不对。必须在这里丢掉，否则它会被第一帧吃掉，
    // 表现为「只有第 0 帧与 Chromium 对不上、第 1 帧起逐字节一致」。
    for (let i = 0; i < this.warmupPaints; i++) {
      await this._settle(0).then(() => this._nextPaint(0)).catch(() => {});
    }
    const warnings = await wc.executeJavaScript('window.__canvas.warnings || []');
    return { warnings };
  }

  async renderFrame(frameIndex) {
    // 自证式取帧：同一帧连取两次，**两次哈希一致才认**。
    //
    // 为什么不能"取一次就走"（S3 实测）：OSR 的 paint 偶尔落在**上一次提交**上，
    // 把上一帧的像素交出来（8 帧里偶发 1 帧，且不是固定偏移 —— 第 199 帧交出的是
    // 第 45 帧的画面）。这类"偶发、非固定"的错帧，靠"多取一次/固定偏移补偿"
    // 都治不干净；只有"要求结果可复现"才成立：同一帧两次独立重绘给出同一份字节，
    // 才说明合成器已经稳定在这一帧上。
    let prev = null;
    for (let attempt = 0; attempt < this.confirmAttempts; attempt++) {
      await this._settle(frameIndex);
      const shot = await this._nextPaint(frameIndex);
      if (prev && prev.sha256 === shot.sha256) return shot;
      prev = shot;
    }
    return prev;
  }

  async close() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    this._pending = null;
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    this.window = null;
  }
}
