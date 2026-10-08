/**
 * Chromium 适配器（Playwright 驱动）
 *
 * 为什么不用第三方渲染框架：我们本机已经有 Chromium（桌面端自带 / Playwright 缓存），
 * 出帧只需要"加载我们自己的 HTML + 逐帧截图"，没有额外下载，也没有许可问题。
 *
 * ⚠️ 确定性相关的启动参数都写在这里，改动请先跑 determinism 测试。
 */

// ⚠️ playwright-core **必须惰性加载**（2026-10-08）：
//   原来这里是静态 import，导致"只要加载 render/index.mjs 就要有 playwright"——
//   桌面端用的是宿主自带 Electron（ElectronOsrAdapter），根本不需要 playwright，
//   但静态 import 会让整个渲染模块加载失败。改成用到时才 import。
//   配套：插件里同时携带两个适配器，运行时按环境挑（适配器本身各 4~8 KB）。
let _chromium = null;
async function loadChromium() {
  if (!_chromium) {
    const mod = await import('playwright-core');
    _chromium = mod.chromium;
  }
  return _chromium;
}
import { RenderAdapter, frameFingerprint } from './adapter.mjs';
import { findChromium } from '../paths.mjs';

// 这些开关是为了让"同样的 DOM 出同样的像素"
const DETERMINISM_FLAGS = [
  '--force-color-profile=srgb',
  '--font-render-hinting=none',
  '--disable-lcd-text',
  '--disable-partial-raster',
  '--disable-threaded-animation',
  '--disable-threaded-scrolling',
  '--run-all-compositor-stages-before-draw',
  '--hide-scrollbars',
  '--mute-audio',
];

export class ChromiumAdapter extends RenderAdapter {
  constructor({ width, height, executablePath = null, timeoutMs = 60000 } = {}) {
    super();
    this.width = width;
    this.height = height;
    this.executablePath = executablePath || findChromium();
    this.timeoutMs = timeoutMs;
    this.browser = null;
    this.page = null;
  }

  get id() { return 'chromium'; }

  async prepare(html) {
    if (!this.executablePath) throw new Error('找不到 Chromium：设置 CANVAS_CHROMIUM 或先安装 Playwright 浏览器');
    const chromium = await loadChromium();
    this.browser = await chromium.launch({
      executablePath: this.executablePath,
      args: DETERMINISM_FLAGS,
      timeout: this.timeoutMs,
    });
    this.page = await this.browser.newPage({
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: 1,
      reducedMotion: 'reduce',
    });
    this.page.setDefaultTimeout(this.timeoutMs);
    await this.page.setContent(html, { waitUntil: 'load' });
    const warnings = await this.page.evaluate(() => window.__canvas.warnings || []);
    return { warnings };
  }

  async renderFrame(frameIndex) {
    await this.page.evaluate((f) => window.__canvas.setFrame(f), frameIndex);
    const buf = await this.page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: this.width, height: this.height },
      animations: 'disabled',
      caret: 'hide',
    });
    return { buffer: buf, sha256: frameFingerprint(buf), bytes: buf.length };
  }

  async close() {
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.page = null;
  }
}
