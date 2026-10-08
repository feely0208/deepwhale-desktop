/**
 * 渲染适配器 —— 统一接口，多个后端（契约：内核只认接口，不认后端）。
 *
 *   prepare(html)            准备一页（载入 DOM、等字体与素材就绪）
 *   renderFrame(frameIndex)  产出**某一帧**的 PNG（必须是纯函数：同帧同结果）
 *   close()                  释放资源
 *
 * S1 实现了 Chromium（Playwright 驱动，本地已有浏览器，零下载）。
 * Electron(OSR) 版本见 adapter-electron.mjs —— 同一接口，S3 接进桌面端。
 */

import { createHash } from 'node:crypto';

export function frameFingerprint(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export class RenderAdapter {
  get id() { return 'abstract'; }
  async prepare() { throw new Error('未实现'); }
  async renderFrame() { throw new Error('未实现'); }
  async close() {}
}
