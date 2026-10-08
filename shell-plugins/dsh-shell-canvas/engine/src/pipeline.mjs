/**
 * 成片流水线：**旁白稿 + 素材 → 横竖双版成片**。
 *
 * 这是 S2 的验收对象：立项要求「素材 → 横竖双版成片 ≤ 30 分钟」。
 *
 * 步骤：
 *   ① 拆句 → 逐句配音（拿到**真实时长**，字幕时间轴据此对齐，而不是靠估）
 *   ② 拼人声轨（句间插静音，与字幕时间轴一致）
 *   ③ 生成 SRT（关键词高亮在模板里声明）
 *   ④ 渲染竖版 / 横版（同一份内容、两份模板）
 *   ⑤ BGM（台账里取）+ 冲避混音 + 合流
 */

import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { splitSentences, buildCuesFromText, cuesToSrtText } from './text/segment.mjs';
import { audioDurationMs, createTtsBackend } from './audio/tts.mjs';
import { run } from './encode.mjs';
import { mixVoiceAndBgm, muxAudio, resolveBgm } from './audio/mix.mjs';
import { renderTemplate } from './render/index.mjs';

/** 用 ffmpeg 生成一段静音（作为句间间隔） */
function makeSilence(ffmpeg, outFile, ms) {
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=mono`, '-t', (ms / 1000).toFixed(3), '-c:a', 'pcm_s16le', outFile]);
}

/** 逐句配音 → 人声轨 + 每句真实时长 */
export async function synthVoiceTrack({ sentences, tts, workDir, gapMs = 120, ffmpeg }) {
  // ⚠️ 必须用绝对路径：ffmpeg 的 concat demuxer 是按**清单文件所在目录**解析相对路径的，
  //    用相对路径会变成 out/x/audio/out/x/audio/xxx.wav（本轮踩到过）。
  workDir = resolve(workDir);
  mkdirSync(workDir, { recursive: true });
  const parts = [];
  const durations = [];

  for (let i = 0; i < sentences.length; i++) {
    const wav = join(workDir, `sentence-${String(i).padStart(3, '0')}.wav`);
    const r = await tts.synthesize({ text: sentences[i], outWav: wav });
    durations.push(r.durationMs || (await audioDurationMs(wav)) || 0);
    parts.push(wav);
  }

  // 句间插静音，让人声轨与字幕时间轴天然对齐
  const silence = join(workDir, 'gap.wav');
  makeSilence(ffmpeg, silence, gapMs);
  const list = [];
  parts.forEach((p, i) => {
    list.push(p);
    if (i < parts.length - 1) list.push(silence);
  });
  const listFile = join(workDir, 'concat.txt');
  writeFileSync(listFile, list.map((f) => `file '${f}'`).join('\n') + '\n');

  const voiceWav = join(workDir, 'voice.wav');
  execFileSync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', voiceWav]);

  const totalMs = (await audioDurationMs(voiceWav)) || durations.reduce((a, b) => a + b, 0) + gapMs * (durations.length - 1);
  return { voiceWav, durationsMs: durations, gapMs, totalMs, sentenceCount: sentences.length };
}

/**
 * 主流水线
 * @param {object} p
 * @param {string} p.script          旁白稿（纯文本）
 * @param {object} p.pair            { vertical: doc, horizontal: doc }
 * @param {object} p.pack            领域包
 * @param {object} p.assets          槽位素材 { shots: '/path/a.png' }
 * @param {string} p.outDir
 * @param {object} p.ttsOpts         { backend, voice }
 * @param {string} p.bgmId           台账里的 BGM id（可空）
 * @param {string} p.quality
 * @param {function} p.onStep
 */
export async function produce({
  script,
  pair,
  pack,
  vars = {},
  assets = {},
  outDir,
  ttsOpts = { backend: 'system', voice: 'Tingting (中文（中国大陆）)' },
  // 【用户自带配音】给了这个就跳过 TTS，直接用用户的音频（自己录 / 自己用别的工具生成）
  voiceoverFile = null,
  // 用户自带字幕（可选）：有就给，没有就按脚本估算
  srtFile = null,
  bgmId = null,
  quality = 'final',
  fps = 30,
  keepFrames = false,   // 成片合流后默认清掉逐帧 PNG（一次 20 秒片子就是几百 MB）
  framesPadding = 90, // 收尾留一点余量，别让最后一句字幕一出现就结束
  onStep = () => {},
}) {
  const t0 = Date.now();
  const marks = [];
  const mark = (name) => { marks.push({ name, atMs: Date.now() - t0 }); onStep({ step: name, elapsedMs: Date.now() - t0 }); };

  mkdirSync(outDir, { recursive: true });
  const { findFfmpeg } = await import('./paths.mjs');
  const ffmpeg = findFfmpeg();

  // ① 拆句
  const sentences = splitSentences(script);
  mark(`拆句：${sentences.length} 句`);

  // ② 配音：优先用**用户自带的配音文件**；没有才走我们的 TTS
  const audioDir = join(outDir, 'audio');
  mkdirSync(audioDir, { recursive: true });
  let voice;
  let tts = null;
  if (voiceoverFile) {
    const src = resolve(voiceoverFile);
    if (!existsSync(src)) throw new Error(`配音文件不存在: ${src}`);
    const wav = join(audioDir, 'voice.wav');
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-ar', '44100', '-ac', '1', wav]);
    const totalMs = (await audioDurationMs(wav)) || 0;
    if (!totalMs) throw new Error('配音文件读不出时长，请检查格式');
    // 用户自带配音时，逐句时长按"字数占比"摊到整条音轨上（有 SRT 就用 SRT）
    const totalChars = sentences.reduce((n, s) => n + s.length, 0) || 1;
    const durationsMs = sentences.map((s) => Math.max(500, (s.length / totalChars) * totalMs));
    voice = { voiceWav: wav, durationsMs, gapMs: 0, totalMs, sentenceCount: sentences.length, provided: true };
    mark(`配音：使用用户自带文件（${(totalMs / 1000).toFixed(1)} 秒）`);
  } else {
    tts = createTtsBackend(ttsOpts);
    voice = await synthVoiceTrack({ sentences, tts, workDir: audioDir, ffmpeg });
    mark(`配音完成：${(voice.totalMs / 1000).toFixed(1)} 秒（音色 ${tts.voice || tts.id}）`);
  }

  // ③ 字幕：用真实配音时长对齐
  let cues;
  if (srtFile) {
    const { parseSrt } = await import('./text/srt.mjs');
    cues = parseSrt(readFileSync(resolve(srtFile), 'utf8'));
  } else {
    cues = buildCuesFromText(script, {
      fps,
      maxCharsPerLine: 15,
      maxLines: 2,
      gapMs: voice.gapMs,
      durationsMs: voice.durationsMs,
    });
  }
  const srt = cuesToSrtText(cues);
  writeFileSync(join(outDir, 'subtitle.srt'), srt);
  const totalFrames = Math.ceil(((voice.totalMs + 500 + framesPadding / fps * 1000) / 1000) * fps);
  mark(`字幕：${cues.length} 条，成片 ${totalFrames} 帧（${(totalFrames / fps).toFixed(1)} 秒）`);

  // ④ 横竖双版渲染
  const outputs = [];
  for (const [orientation, doc] of Object.entries(pair)) {
    if (!doc) continue;
    const frames = Math.min(totalFrames, Math.round((doc.canvas.maxFramesHint || totalFrames)));
    const r = await renderTemplate({
      doc,
      pack,
      outDir: join(outDir, orientation),
      quality,
      framesOverride: frames,
      vars: { ...vars, subtitle: srt },
      userSlots: assets,
      keepFrames,
    });
    mark(`渲染 ${orientation}：${r.frameCount} 帧 / ${(r.renderMs / 1000).toFixed(1)} 秒`);
    outputs.push({ orientation, ...r });
  }

  // ⑤ BGM + 混音 + 合流
  let bgm = null;
  if (bgmId) bgm = resolveBgm(pack, bgmId);
  const mixed = await mixVoiceAndBgm({
    voiceWav: voice.voiceWav,
    bgmFile: bgm ? bgm.file : null,
    outFile: join(outDir, 'audio', 'mixed.m4a'),
    duck: !!bgm,
  });
  mark(`混音：${bgm ? `BGM（${bgm.id}）+ 闪避` : '仅人声'}`);

  const finals = [];
  for (const o of outputs) {
    const out = join(outDir, `${o.outFile.split('/').pop().replace('.mp4', '')}-配音版.mp4`);
    await muxAudio({ videoFile: o.outFile, audioFile: mixed.outFile, outFile: out });
    finals.push({ orientation: o.orientation, file: out });
  }
  mark('合流完成');

  return {
    ok: true,
    outDir,
    script: { chars: script.length, sentences: sentences.length },
    voice: voice.provided
      ? { backend: 'user-provided', voice: null, totalMs: voice.totalMs, file: null }
      : { backend: tts.id, voice: tts.voice || null, totalMs: voice.totalMs },
    subtitle: { cues: cues.length, srtFile: join(outDir, 'subtitle.srt') },
    bgm: bgm ? { id: bgm.id, ducked: true } : null,
    frames: totalFrames,
    finals,
    renders: outputs.map((o) => ({ orientation: o.orientation, frames: o.frameCount, renderMs: o.renderMs, msPerFrame: Number(o.msPerFrame.toFixed(2)), warnings: o.warnings })),
    timeline: marks,
    totalMs: Date.now() - t0,
  };
}
