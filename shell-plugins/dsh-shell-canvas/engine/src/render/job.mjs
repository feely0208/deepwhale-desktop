/**
 * 渲染任务：把「文档 + 领域包 + 适配器」变成一串逐帧 PNG。
 *
 * 必须有的能力（对齐立项文档）：
 *   - 进度回调（长任务要给用户看得见的进度）
 *   - 取消（AbortSignal）
 *   - **断点续渲**（已渲好的帧有哈希记录，重启后跳过）
 *   - 每帧指纹（渲染确定性的证据）
 */

import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHtml } from './html.mjs';

export const QUALITY = {
  final: { scale: 1, step: 1, label: '终版' },
  preview: { scale: 0.5, step: 2, label: '预览' },
};

export function planFrames({ doc, pack, quality = 'final', framesOverride = null }) {
  const q = QUALITY[quality] || QUALITY.final;
  const totalFrames = framesOverride || doc.canvas.frames || Math.round((doc.canvas.fps || 30) * 3);
  const indices = [];
  for (let f = 0; f < totalFrames; f += q.step) indices.push(f);
  const baseFps = doc.canvas.fps || 30;
  return {
    quality: q,
    outFps: baseFps / q.step,
    width: Math.round(doc.canvas.w * q.scale),
    height: Math.round(doc.canvas.h * q.scale),
    indices,
    totalFrames,
  };
}

export async function renderFrames({
  doc,
  pack,
  adapter,
  plan,
  frameDir,
  resume = false,
  onProgress = null,
  signal = null,
}) {
  if (frameDir) mkdirSync(frameDir, { recursive: true });
  const manifestPath = frameDir ? join(frameDir, 'manifest.json') : null;
  let done = new Map(); // outIndex -> {sha256, bytes}
  if (resume && manifestPath && existsSync(manifestPath)) {
    const prev = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const f of prev.frames || []) {
      const p = join(frameDir, f.file);
      if (existsSync(p)) done.set(f.outIndex, f);
    }
  }

  // ⚠️ 预览档必须按**设计尺寸**建 HTML、只把 stage 整体缩放：
  //    否则模板里的绝对坐标（按 1080×1920 写的）会被套到 540×960 上，字号与换行全乱。
  const { html, fontIds } = buildHtml({
    doc,
    width: doc.canvas.w,
    height: doc.canvas.h,
    slots: doc.__slots || {},
    scale: plan.quality.scale,  // 注意：plan 上的是 quality 对象，没有平铺的 scale
  });
  const prep = await adapter.prepare(html);
  const warnings = [...(prep.warnings || [])];

  const frames = [];
  const t0 = Date.now();
  let rendered = 0;

  for (let i = 0; i < plan.indices.length; i++) {
    if (signal?.aborted) {
      if (frameDir) writeManifest(manifestPath, frames, plan, warnings, true);
      const err = new Error('渲染已取消');
      err.cancelled = true;
      err.frames = frames;
      throw err;
    }
    const srcFrame = plan.indices[i];
    const file = `frame-${String(i).padStart(6, '0')}.png`;

    if (done.has(i)) {
      const rec = done.get(i);
      frames.push({ outIndex: i, srcFrame, file, sha256: rec.sha256, bytes: rec.bytes, resumed: true });
    } else {
      const { buffer, sha256, bytes } = await adapter.renderFrame(srcFrame);
      if (frameDir) writeFileSync(join(frameDir, file), buffer);
      frames.push({ outIndex: i, srcFrame, file, sha256, bytes, resumed: false });
      rendered++;
    }

    if (onProgress) {
      const elapsed = Date.now() - t0;
      const per = elapsed / (i + 1);
      onProgress({
        done: i + 1,
        total: plan.indices.length,
        msPerFrame: per,
        etaMs: per * (plan.indices.length - i - 1),
        elapsedMs: elapsed,
      });
    }
  }

  const elapsedMs = Date.now() - t0;
  if (frameDir) writeManifest(manifestPath, frames, plan, warnings, false);
  return { frames, warnings, rendered, elapsedMs, fontIds };
}

function writeManifest(path, frames, plan, warnings, partial) {
  if (!path) return;
  writeFileSync(
    path,
    JSON.stringify(
      {
        partial: !!partial,
        width: plan.width,
        height: plan.height,
        outFps: plan.outFps,
        frameCount: frames.length,
        expectedFrames: plan.indices.length,
        warnings,
        frames,
      },
      null,
      2,
    ) + '\n',
  );
}
