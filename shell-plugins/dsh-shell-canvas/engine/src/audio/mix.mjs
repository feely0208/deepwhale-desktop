/**
 * 音频混流：配音 + BGM（自动闪避）+ 与画面合流。
 *
 * 闪避（ducking）用 ffmpeg 的 sidechaincompress：
 *   人声一响，BGM 自动让路；人声停下，BGM 回位——这是"听起来专业"的关键一步，
 *   也是当初"不想用剪映"时明确点名的缺口之一。
 */

import { run } from '../encode.mjs';
import { audioDurationMs } from './tts.mjs';
import { findFfmpeg } from '../paths.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** 从 BGM 台账里按 id 取曲目（模板只能引用台账里的 id） */
export function resolveBgm(pack, bgmId) {
  const tracks = pack?.bgmRegistry?.tracks || [];
  const t = tracks.find((x) => x.id === bgmId);
  if (!t) throw new Error(`BGM 不在入库台账: ${bgmId}`);
  const packDir = pack.dir;
  const file = resolve(packDir, t.file.path);
  if (!existsSync(file)) throw new Error(`台账里的 BGM 文件不存在: ${file}`);
  return { ...t, file };
}

/**
 * 配音 + BGM → 混合音轨（含闪避）
 * @returns {Promise<{outFile:string, durationMs:number, ducked:boolean}>}
 */
export async function mixVoiceAndBgm({
  voiceWav,
  bgmFile,
  outFile,
  bgmVolume = 0.22,      // BGM 基础音量（相对）
  duck = true,           // 是否闪避
  duckRatio = 8,
  duckThreshold = 0.03,
  fadeOutSec = 1.5,
}) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('找不到 ffmpeg');

  // 淡出必须给"正数起点"：先量出人声时长，再从结尾往前 fadeOutSec
  const voiceMs = await audioDurationMs(voiceWav);
  const fadeStart = voiceMs ? Math.max(0, voiceMs / 1000 - fadeOutSec) : 0;

  const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', voiceWav];
  if (bgmFile) args.push('-i', bgmFile);

  if (!bgmFile) {
    args.push('-c:a', 'aac', '-b:a', '192k', outFile);
  } else if (duck) {
    // [1] BGM 调音量 → [2] 用 voice 做侧链压缩（人声一响就让路）→ 与人声混合
    const filter = [
      `[1:a]volume=${bgmVolume}[bgm]`,
      `[bgm][0:a]sidechaincompress=threshold=${duckThreshold}:ratio=${duckRatio}:attack=20:release=400[ducked]`,
      `[0:a][ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
      `[mix]afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeOutSec},dynaudnorm=p=0.9[mixout]`,
    ].join(';');
    args.push('-filter_complex', filter, '-map', '[mixout]', '-c:a', 'aac', '-b:a', '192k', outFile);
  } else {
    const filter = [
      `[1:a]volume=${bgmVolume}[bgm]`,
      `[0:a][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mix]`,
    ].join(';');
    args.push('-filter_complex', filter, '-map', '[mix]', '-c:a', 'aac', '-b:a', '192k', outFile);
  }

  await run(ffmpeg, args);
  return { outFile, ducked: !!duck && !!bgmFile };
}

/** 把音轨合进已经渲好的无声视频 */
export async function muxAudio({ videoFile, audioFile, outFile, keepVideoAudio = false }) {
  const ffmpeg = findFfmpeg();
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', videoFile,
    '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart',
    outFile,
  ];
  await run(ffmpeg, args);
  return { outFile };
}

/** 生成一条"测试用 BGM"（合成音，不是曲库曲目）——只用于链路验证 */
export async function generateTestToneBgm(outFile, { seconds = 60 } = {}) {
  const ffmpeg = findFfmpeg();
  // 一个柔和的和弦垫底：三个正弦 + 缓慢颤音，听感不刺耳，够用来验证闪避
  const filter = [
    'sine=frequency=220:duration=' + seconds + '[a]',
    'sine=frequency=277:duration=' + seconds + '[b]',
    'sine=frequency=330:duration=' + seconds + '[c]',
    '[a][b][c]amix=inputs=3:normalize=0,volume=0.5,tremolo=f=0.15:d=0.35,lowpass=f=1200[out]',
  ].join(';');
  await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-filter_complex', filter, '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', outFile]);
  return outFile;
}
