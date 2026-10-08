/** ffmpeg 合成：逐帧 PNG + 可选音轨 → H.264/AAC MP4。 */

import { spawn } from 'node:child_process';
import { findFfmpeg, findFfprobe } from './paths.mjs';

export function run(bin, args, { onStderr = null } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d.toString();
      if (onStderr) onStderr(d.toString());
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve({ stderr: err }) : reject(new Error(`${bin} 退出码 ${code}\n${err.slice(-1200)}`))));
  });
}

export async function encodeVideo({ frameDir, fps, outFile, audioFile = null, ffmpeg = null, crf = 18, preset = 'medium' }) {
  const bin = ffmpeg || findFfmpeg();
  if (!bin) throw new Error('找不到 ffmpeg：设置 CANVAS_FFMPEG 环境变量');
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', `${frameDir}/frame-%06d.png`,
  ];
  if (audioFile) args.push('-i', audioFile);
  args.push(
    '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
  );
  if (audioFile) args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
  args.push(outFile);
  await run(bin, args);
  return { outFile, ffmpeg: bin };
}

/** 用 ffprobe 读回产物规格，证明"输出确实是我们要的" */
export async function probe(file, ffmpegPath = null) {
  const bin = findFfprobe(ffmpegPath || findFfmpeg());
  if (!bin) return null;
  return new Promise((resolve, reject) => {
    const p = spawn(bin, ['-v', 'error', '-show_entries', 'format=duration,size,bit_rate', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate', '-of', 'json', file]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe 退出码 ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}
