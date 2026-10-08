/**
 * 渲染入口：校验 → 出帧 → 合成 → 回读验证。
 *
 * ⚠️ 闸门原则：**模板校验不通过就不许渲染**（S0 的校验器在这里被消费）。
 */

import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { validateDocument } from '../validate.mjs';
import { applyVars } from './vars.mjs';
import { ChromiumAdapter } from './adapter-chromium.mjs';
import { ElectronOsrAdapter } from './adapter-electron.mjs';
import { planFrames, renderFrames, QUALITY } from './job.mjs';
import { encodeVideo, probe } from '../encode.mjs';

const MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4',
};

export function fileToDataUrl(p) {
  const abs = resolve(p);
  if (!existsSync(abs)) throw new Error(`素材不存在: ${abs}`);
  const buf = readFileSync(abs);
  const mime = MIME[extname(abs).toLowerCase()] || 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

export async function renderTemplate({
  doc,
  pack,
  outDir,
  quality = 'final',
  vars = {},
  userSlots = {},
  audioFile = null,
  framesOverride = null,
  adapter = null,
  adapterKind = 'chromium',
  resume = false,
  keepFrames = true,
  onProgress = null,
  signal = null,
}) {
  // ① 闸门：校验不通过，直接拒绝渲染
  const v = validateDocument(doc, pack);
  if (!v.ok) {
    const err = new Error(`模板校验未通过（${v.errors} 个 error），已拒绝渲染`);
    err.validation = v;
    throw err;
  }

  // ② 变量注入（{{key}} → 实际值）；缺必填变量直接报错，不静默出空片
  doc = applyVars(doc, vars);

  // ③ 素材槽位：读本地文件 → data URL（本地渲染，文件不出本机）
  const slots = {};
  for (const [slot, p] of Object.entries(userSlots)) slots[slot] = fileToDataUrl(p);
  doc.__slots = slots;

  const plan = planFrames({ doc, pack, quality, framesOverride });
  mkdirSync(outDir, { recursive: true });
  const frameDir = keepFrames ? join(outDir, 'frames') : join(outDir, '.frames-tmp');
  const outFile = join(outDir, `${doc.meta.id.replace('/', '-')}-${quality}.mp4`);

  // ③ 出帧
  const usedAdapter = adapter || new ChromiumAdapter({ width: plan.width, height: plan.height });
  let framesResult;
  try {
    framesResult = await renderFrames({ doc, pack, adapter: usedAdapter, plan, frameDir, resume, onProgress, signal });
  } finally {
    await usedAdapter.close();
  }

  // ④ 合成
  const enc = await encodeVideo({ frameDir, fps: plan.outFps, outFile, audioFile });
  const info = await probe(outFile, enc.ffmpeg).catch(() => null);

  const sha256 = createHash('sha256').update(readFileSync(outFile)).digest('hex');
  const per = framesResult.frames.length ? framesResult.elapsedMs / framesResult.frames.length : 0;

  return {
    ok: true,
    outFile,
    quality,
    qualityLabel: (QUALITY[quality] || QUALITY.final).label,
    width: plan.width,
    height: plan.height,
    fps: plan.outFps,
    frameCount: framesResult.frames.length,
    resumedFrames: framesResult.frames.filter((f) => f.resumed).length,
    renderedFrames: framesResult.rendered,
    renderMs: framesResult.elapsedMs,
    msPerFrame: per,
    warnings: [...framesResult.warnings, ...v.issues.filter((i) => i.level === 'warn').map((i) => i.msg)],
    frames: framesResult.frames,
    probe: info,
    videoSha256: sha256,
    frameDir: keepFrames ? frameDir : null,
    adapter: usedAdapter.id,
  };
}

export { ChromiumAdapter, ElectronOsrAdapter, planFrames };
