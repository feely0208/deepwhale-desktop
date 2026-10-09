/**
 * 任务执行体 —— 真正调用深鲸画布引擎的地方。
 *
 * 两个入口共用本文件（同一份逻辑，只换渲染后端）：
 *   · `lib/worker.mjs`    普通 Node 子进程 → Chromium 后端（Playwright 驱动本机已有 Chromium）
 *   · `lib/osr-main.cjs`  Electron 主进程 → Electron OSR 后端（桌面端自带的 Chromium）
 *
 * ── 为什么不直接调 `produce()` ──────────────────────────────────────────
 * `src/pipeline.mjs` 的 `produce()` 是引擎的**一次性主入口**（S2 验收对象），
 * 但它没有对外暴露 `resume`，而 §4.2 要求"中途 kill 掉重跑能跳过已渲好的帧"。
 * S3 的约束是**不改内核**，所以这里由外壳把同一条链路按阶段拼出来：
 * 每一步都调引擎自己导出的函数（`synthVoiceTrack` / `buildCuesFromText` /
 * `renderTemplate` / `mixVoiceAndBgm` / `muxAudio`），外壳只负责"顺序 + 进度 + 取消 + 续渲"。
 * 分步顺序与 `produce()` 完全一致，见 `README.md` 的"与 produce() 的一致性"。
 *
 * ── 每步都保持引擎的既有约束（踩过的坑，别再踩）────────────────────────
 *   · ffmpeg concat 清单必须写**绝对路径**（引擎内部已处理，这里不碰）；
 *   · 预览档必须按设计尺寸建 DOM、只整体缩放（引擎 `renderFrames` 内部已处理）；
 *   · 渲染进程必须断网（两个适配器都装了 webRequest 过滤）。
 */

import { mkdirSync, writeFileSync, existsSync, readdirSync, statSync, readFileSync, rmSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/**
 * 重建断点清单。
 *
 * ── 为什么需要这一步（§4.2 第 2 条的实测坑）──────────────────────────
 * 引擎的断点续渲靠 `<outDir>/frames/manifest.json`：`renderFrames({resume:true})`
 * 只认清单里记着的帧。而清单是**渲完（或优雅取消）时才落盘**的。
 * 于是"中途 `kill -9`"这种最真实的场景：几十张 PNG 明明躺在盘上，
 * 重跑却是「续用 0」—— 因为没有任何东西告诉引擎"这些帧是好的"。
 *
 * 外壳能做的正确的事，不是伪造指纹，而是**按盘上真实的字节重算**：
 * 帧文件本身就是唯一事实来源，重新哈希一遍与当初写清单时记录的值等价
 * （编码阶段读的也是这些文件，指纹只进报告）。
 *
 * 只在"清单缺失"或"清单是我们重建的且这次的计划变了"时才动手：
 * 引擎自己写的完整清单永远优先。
 */
function recoverFrameManifest(frameDir, planSig, emit, orientation) {
  if (!frameDir || !existsSync(frameDir)) return 0;
  const manifestPath = join(frameDir, 'manifest.json');
  let existing = null;
  if (existsSync(manifestPath)) {
    try { existing = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { existing = null; }
    // 引擎写的（没有 recoveredBy 标记）→ 原样尊重，不碰。
    if (existing && !existing.recoveredBy) return 0;
    // 是我们上次重建的，但这次的渲染计划变了（画质/帧数不同）→ 作废重建。
    if (existing && existing.recoveredBy && existing.planSig === planSig) return 0;
  }

  const pngs = readdirSync(frameDir)
    .filter((f) => /^frame-\d{6}\.png$/.test(f))
    .sort();
  if (!pngs.length) return 0;

  const frames = pngs.map((file, i) => {
    const full = join(frameDir, file);
    const buf = readFileSync(full);
    return {
      outIndex: i,
      srcFrame: null, // 引擎恢复时用计划里的 srcFrame，不读这里
      file,
      sha256: createHash('sha256').update(buf).digest('hex'),
      bytes: statSync(full).size,
      resumed: true,
    };
  });
  writeFileSync(manifestPath, JSON.stringify({
    partial: true,
    recoveredBy: 'dsh-shell-canvas',
    recoveredAt: new Date().toISOString(),
    planSig,
    frameCount: frames.length,
    frames,
  }, null, 2) + '\n');
  emit({ t: 'log', msg: `${orientation === 'vertical' ? '竖版' : '横版'}：发现 ${frames.length} 张没有清单的残留帧（上次被强杀），已按盘上字节重建断点清单` });
  return frames.length;
}

/** 计划签名：画质 + 输出尺寸 + 输出帧数 —— 变了就不能续用旧帧。 */
function planSignature(plan) {
  return `${plan.quality.scale}x${plan.quality.step}@${plan.width}x${plan.height}/${plan.indices.length}`;
}

/** 按需 import 引擎模块（绝对路径；引擎目录带空格，必须用 pathToFileURL）。 */
async function imp(root, rel) {
  return import(pathToFileURL(join(root, rel)).href);
}

/**
 * 跑一个任务。
 *
 * @param {object} spec 任务规格（见 lib/jobs.mjs 的 buildSpec）
 * @param {object} host
 * @param {(e: object) => void} host.emit        向宿主吐一行 JSON 事件
 * @param {(o: {width:number,height:number}) => object} host.makeAdapter 造一个渲染适配器
 * @param {AbortSignal} host.signal              取消信号
 */
export async function runJob(spec, { emit, makeAdapter, signal }) {
  const root = resolve(spec.engineRoot);
  // 引擎里有若干相对路径（TTS 的 modelDir、packs 目录等）按 cwd 解析，先切过去。
  // 注意：必须在 import 之前切，`findChromium` 之类会读相对路径。
  process.chdir(root);

  const { loadRegistry, satisfiesEngineRange } = await imp(root, 'src/registry.mjs');
  const { validateDocument, ENGINE_VERSION } = await imp(root, 'src/validate.mjs');
  const { renderTemplate } = await imp(root, 'src/render/index.mjs');
  const { findFfmpeg } = await imp(root, 'src/paths.mjs');

  const packs = loadRegistry(join(root, 'packs'));
  const pack = packs.get(spec.pack || 'video');
  if (!pack) throw new Error(`领域包不存在: ${spec.pack || 'video'}`);
  pack.engineRangeCheck = satisfiesEngineRange(pack.domain.engineRange, ENGINE_VERSION);

  // ── 闸门：校验不通过，绝不进入渲染（S0 校验器在 S1 就被消费，这里同理）──
  const gate = [];
  for (const [orientation, doc] of Object.entries(spec.pair || {})) {
    const v = validateDocument(doc, pack);
    gate.push({ orientation, ok: v.ok, errors: v.errors, warnings: v.warnings, issues: v.issues });
  }
  const blocked = gate.filter((g) => !g.ok);
  if (blocked.length) {
    const err = new Error(`模板校验未通过（${blocked.map((b) => `${b.orientation} ${b.errors} 个 error`).join('，')}），已拒绝渲染`);
    err.validation = { ok: false, template: gate };
    throw err;
  }
  emit({ t: 'gate', value: { engineVersion: ENGINE_VERSION, pack: `${pack.domain.domain}@${pack.domain.version}`, templates: gate } });

  const ctx = { root, pack, renderTemplate, findFfmpeg, makeAdapter, emit, signal, spec };

  if (spec.kind === 'preview') return runPreview(ctx);
  if (spec.kind === 'final') return runFinal(ctx);
  if (spec.kind === 'posters') return runPosters(ctx);
  throw new Error(`未知任务类型: ${spec.kind}`);
}

/** 统一的进度上报：把引擎的 onProgress 翻译成宿主能画进度条的形状。 */
function progressReporter(emit, orientation, total) {
  let last = 0;
  return (p) => {
    const now = Date.now();
    if (now - last < 250 && p.done !== p.total) return;
    last = now;
    emit({
      t: 'progress',
      orientation,
      done: p.done,
      total,
      msPerFrame: p.msPerFrame,
      etaMs: p.etaMs,
      pct: total ? Math.min(1, p.done / total) : 0,
    });
  };
}

function renderPlan(root, doc, quality, framesOverride) {
  // 只为拿尺寸（适配器要按最终像素尺寸建窗口/视口）
  return import(pathToFileURL(join(root, 'src/render/job.mjs')).href).then((m) =>
    m.planFrames({ doc, pack: null, quality, framesOverride }),
  );
}

/** 逐版渲染（预览与终版共用）。返回每个方向的结果。 */
async function renderBothVersions(ctx, { outDir, quality, framesOverrideByOrientation, vars, subtitle, keepFrames, resume }) {
  const results = [];
  for (const [orientation, doc] of Object.entries(ctx.spec.pair)) {
    if (ctx.signal?.aborted) throw cancelled();
    const framesOverride = framesOverrideByOrientation[orientation] ?? null;
    const plan = await renderPlan(ctx.root, doc, quality, framesOverride);
    // 强杀遗留的帧：先把断点清单按盘上字节重建出来，否则引擎只会说"续用 0"。
    if (resume) recoverFrameManifest(join(outDir, orientation, 'frames'), planSignature(plan), ctx.emit, orientation);
    const adapter = ctx.makeAdapter({ width: plan.width, height: plan.height, quality });
    const t0 = Date.now();
    ctx.emit({ t: 'step', name: `渲染${orientation === 'vertical' ? '竖版' : '横版'} ${plan.width}×${plan.height}`, elapsedMs: 0 });
    const r = await ctx.renderTemplate({
      doc,
      pack: ctx.pack,
      outDir: join(outDir, orientation),
      quality,
      framesOverride,
      vars: { ...vars, subtitle },
      userSlots: ctx.spec.assets || {},
      keepFrames,
      resume: !!resume,
      adapter,
      signal: ctx.signal,
      onProgress: progressReporter(ctx.emit, orientation, plan.indices.length),
    });
    const resumed = r.resumedFrames || 0;
    ctx.emit({
      t: 'log',
      msg: `${orientation === 'vertical' ? '竖版' : '横版'}：${r.frameCount} 帧（新渲 ${r.renderedFrames}、续用 ${resumed}）` +
        `，${(r.renderMs / 1000).toFixed(1)}s，${r.msPerFrame.toFixed(0)} ms/帧` +
        (r.warnings?.length ? `，告警 ${r.warnings.length} 条` : ''),
    });
    results.push({ orientation, ...r, wallMs: Date.now() - t0 });
  }
  return results;
}

// ── 预览：低分辨率 / 低帧率，先让用户看到效果 ──────────────────────────
async function runPreview(ctx) {
  const { spec, emit } = ctx;
  const outDir = spec.outDir;
  mkdirSync(outDir, { recursive: true });

  const { buildCuesFromText, cuesToSrtText } = await imp(ctx.root, 'src/text/segment.mjs');
  const fps = firstDoc(spec).canvas.fps || 30;
  // 预览不做配音（TTS 是整条链路里最慢的一步），字幕按字数估时长即可 ——
  // 预览要看的是**版式与动效**，不是最终听感。
  const cues = buildCuesFromText(spec.script || '', { fps, maxCharsPerLine: 15, maxLines: 2 });
  const srt = cuesToSrtText(cues);

  const seconds = spec.previewSeconds || 4;
  const framesOverrideByOrientation = {};
  for (const [orientation, doc] of Object.entries(spec.pair)) {
    framesOverrideByOrientation[orientation] = Math.max(2, Math.round(seconds * (doc.canvas.fps || 30)));
  }

  emit({ t: 'log', msg: `预览：${seconds}s，${spec.pair.vertical?.canvas.w || 0}×${spec.pair.vertical?.canvas.h || 0} 半分辨率、隔帧` });
  const renders = await renderBothVersions(ctx, {
    outDir,
    quality: 'preview',
    framesOverrideByOrientation,
    vars: spec.vars || {},
    subtitle: srt,
    keepFrames: true,
    resume: !!spec.resume,
  });

  if (!spec.keepFramesAfterDone) pruneFrames(outDir, emit);

  return {
    ok: true,
    kind: 'preview',
    outDir,
    quality: 'preview',
    subtitle: { cues: cues.length, file: null },
    renders: renders.map(summarizeRender),
    finals: renders.map((r) => ({ orientation: r.orientation, file: r.outFile, bytes: null })),
    totalMs: renders.reduce((a, r) => a + r.wallMs, 0),
  };
}

// ── 终版：配音 + 字幕 + 横竖双版 + 混音合流（与 produce() 同序）──────────
async function runFinal(ctx) {
  const { spec, emit } = ctx;
  const outDir = spec.outDir;
  mkdirSync(outDir, { recursive: true });
  const audioDir = join(outDir, 'audio');
  mkdirSync(audioDir, { recursive: true });

  const { splitSentences, buildCuesFromText, cuesToSrtText } = await imp(ctx.root, 'src/text/segment.mjs');
  const { createTtsBackend, audioDurationMs } = await imp(ctx.root, 'src/audio/tts.mjs');
  const { synthVoiceTrack } = await imp(ctx.root, 'src/pipeline.mjs');
  const { mixVoiceAndBgm, muxAudio, resolveBgm } = await imp(ctx.root, 'src/audio/mix.mjs');
  const { probe } = await imp(ctx.root, 'src/encode.mjs');
  const { run } = await imp(ctx.root, 'src/encode.mjs');

  const ffmpeg = ctx.findFfmpeg();
  const fps = firstDoc(spec).canvas.fps || 30;
  const script = spec.script || '';
  const sentences = splitSentences(script);
  emit({ t: 'log', msg: `拆句：${sentences.length} 句` });

  // ① 配音（可复用：续渲重跑时脚本没变就不重新合成 —— TTS 是最慢的一步）
  const voiceWav = join(audioDir, 'voice.wav');
  const cacheFile = join(outDir, '.voice-cache.json');
  const scriptSha = sha256(script);
  let voice = null;
  if (existsSync(voiceWav) && existsSync(cacheFile)) {
    try {
      const c = JSON.parse(await (await import('node:fs/promises')).readFile(cacheFile, 'utf8'));
      if (c.scriptSha === scriptSha && Array.isArray(c.durationsMs)) {
        const totalMs = await audioDurationMs(voiceWav);
        if (totalMs) {
          voice = { voiceWav, durationsMs: c.durationsMs, gapMs: c.gapMs || 0, totalMs, sentenceCount: sentences.length, provided: !!c.provided, backend: c.backend, voiceName: c.voiceName, reused: true };
          emit({ t: 'log', msg: `配音：续用已有音轨（${(totalMs / 1000).toFixed(1)} 秒）` });
        }
      }
    } catch { /* 缓存坏了就重做 */ }
  }

  if (!voice) {
    if (spec.voiceoverFile) {
      // 【用户自带配音】给了这个就完全跳过我们的 TTS
      const src = resolve(spec.voiceoverFile);
      if (!existsSync(src)) throw new Error(`配音文件不存在：${src}`);
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', src, '-ar', '44100', '-ac', '1', voiceWav]);
      const totalMs = (await audioDurationMs(voiceWav)) || 0;
      if (!totalMs) throw new Error('配音文件读不出时长，请检查格式');
      const totalChars = sentences.reduce((n, s) => n + s.length, 0) || 1;
      voice = {
        voiceWav, totalMs, gapMs: 0, provided: true, backend: 'user-provided', voiceName: '用户自带配音',
        durationsMs: sentences.map((s) => Math.max(500, (s.length / totalChars) * totalMs)),
      };
      emit({ t: 'log', msg: `配音：使用你自带的文件（${(totalMs / 1000).toFixed(1)} 秒）` });
    } else {
      // 兜底音色：中英切段混读（华言 + lessac）。**不做音色选择 UI**（立项决策 6）：
      // 用户要么用这个兜底，要么给 voiceoverFile，要么走 external 接口。
      const ttsOpts = spec.tts || defaultTts(ctx.root);
      const tts = createTtsBackend(ttsOpts);
      let done = 0;
      const wrapped = {
        synthesize: async (args) => {
          if (ctx.signal?.aborted) throw cancelled();
          const r = await tts.synthesize(args);
          done++;
          emit({ t: 'progress', phase: 'tts', done, total: sentences.length, pct: sentences.length ? done / sentences.length : 0, text: `配音 ${done}/${sentences.length} 句` });
          return r;
        },
      };
      emit({ t: 'step', name: `配音（${tts.voice || tts.id}）`, elapsedMs: 0 });
      voice = await synthVoiceTrack({ sentences, tts: wrapped, workDir: audioDir, ffmpeg });
      voice.backend = tts.id;
      voice.voiceName = tts.voice || tts.id;
      emit({ t: 'log', msg: `配音完成：${(voice.totalMs / 1000).toFixed(1)} 秒（${voice.voiceName}）` });
    }
    writeFileSync(cacheFile, JSON.stringify({
      scriptSha, durationsMs: voice.durationsMs, gapMs: voice.gapMs,
      provided: !!voice.provided, backend: voice.backend, voiceName: voice.voiceName,
    }, null, 2) + '\n');
  }

  // ② 字幕：用真实配音时长对齐
  const cues = buildCuesFromText(script, {
    fps, maxCharsPerLine: 15, maxLines: 2, gapMs: voice.gapMs, durationsMs: voice.durationsMs,
  });
  const srt = cuesToSrtText(cues);
  const srtFile = join(outDir, 'subtitle.srt');
  writeFileSync(srtFile, srt);
  const framesPadding = spec.framesPadding ?? 90;
  const totalFrames = Math.ceil(((voice.totalMs + 500 + (framesPadding / fps) * 1000) / 1000) * fps);
  emit({ t: 'log', msg: `字幕：${cues.length} 条；成片 ${totalFrames} 帧（${(totalFrames / fps).toFixed(1)} 秒）` });

  // ③ 横竖双版（断点续渲在这里生效）
  const framesOverrideByOrientation = {};
  for (const [orientation, doc] of Object.entries(spec.pair)) {
    framesOverrideByOrientation[orientation] = Math.min(totalFrames, Math.round(doc.canvas.maxFramesHint || totalFrames));
  }
  const renders = await renderBothVersions(ctx, {
    outDir,
    quality: spec.quality || 'final',
    framesOverrideByOrientation,
    vars: spec.vars || {},
    subtitle: srt,
    keepFrames: true, // 保帧：这是"断点续渲"唯一的依据（manifest.json + PNG）
    resume: true,
  });

  // ④ BGM + 闪避混音 + 合流
  if (ctx.signal?.aborted) throw cancelled();
  let bgm = null;
  if (spec.bgmFile) {
    // 用户自己的背景音乐（2026-10-09 加）。
    // ⚠️ 这里**故意绕过** BGM 入库台账 —— 台账是给"我们提供的曲子"用的（版权审核过）；
    //    用户自己的曲子，版权责任在用户，我们只做混音。
    //    **必须记一条日志**，不许静默绕过合规设计。
    bgm = { id: 'user', file: spec.bgmFile, source: 'user' };
    emit({ t: 'log', msg: '背景音乐：用户提供的文件（版权责任由使用者承担）' });
  } else if (spec.bgmId) {
    bgm = resolveBgm(ctx.pack, spec.bgmId);
  }
  const mixed = await mixVoiceAndBgm({
    voiceWav: voice.voiceWav,
    bgmFile: bgm ? bgm.file : null,
    outFile: join(audioDir, 'mixed.m4a'),
    duck: !!bgm,
  });
  emit({ t: 'log', msg: `混音：${bgm ? `BGM（${bgm.id}）+ 闪避` : '仅人声'}` });

  const finals = [];
  for (const o of renders) {
    if (ctx.signal?.aborted) throw cancelled();
    const out = join(outDir, `${o.outFile.split('/').pop().replace('.mp4', '')}-配音版.mp4`);
    await muxAudio({ videoFile: o.outFile, audioFile: mixed.outFile, outFile: out });
    const info = await probe(out, ffmpeg).catch(() => null);
    finals.push({
      orientation: o.orientation,
      file: out,
      bytes: Number(info?.format?.size || 0),
      durationSec: Number(Number(info?.format?.duration || 0).toFixed(2)),
    });
  }
  emit({ t: 'step', name: '合流完成', elapsedMs: 0 });
  if (!spec.keepFramesAfterDone) pruneFrames(outDir, emit);

  return {
    ok: true,
    kind: 'final',
    outDir,
    quality: spec.quality || 'final',
    voice: { backend: voice.backend, voice: voice.voiceName, totalMs: voice.totalMs, reused: !!voice.reused },
    subtitle: { cues: cues.length, file: srtFile },
    renders: renders.map(summarizeRender),
    finals,
    totalMs: renders.reduce((a, r) => a + r.wallMs, 0),
  };
}

/**
 * 海报占位文案。
 *
 * 海报只给人看个版式，所以必填变量得给**示例值**而不是空着
 * （`applyVars` 对必填变量缺值会直接抛错 —— 第一次跑就是这么失败的）。
 * `subtitle` 给一条**样例字幕**而不是空串：空字幕会让模板里的字幕层落到引擎的
 * "字幕占位：subtitle 为空"占位文案上，海报缩略图里就是一行红字，很丑。
 */
const POSTER_SUBTITLE = '1\n00:00:00,000 --> 00:00:20,000\n字幕示例：这里显示这一句旁白\n';

const POSTER_PLACEHOLDERS = {
  title: '标题示例',
  kicker: '小标题',
  subtitle: POSTER_SUBTITLE,
  step1: '第一步',
  step2: '第二步',
  step3: '第三步',
  points: '要点一\n要点二',
};

function posterVars(doc, given = {}) {
  const out = { subtitle: POSTER_SUBTITLE, ...given };
  for (const v of doc.vars || []) {
    if (out[v.key] !== undefined && String(out[v.key]).length) continue;
    out[v.key] = v.default !== undefined ? v.default : (POSTER_PLACEHOLDERS[v.key] ?? (v.label || v.key));
  }
  return out;
}

/**
 * 海报取第几帧。
 *
 * ⚠️ **不能取第 0 帧**（第一次就是那么干的，出来的是一张近乎空白的深色图）：
 * 三个模板的入场动画都是从 0 帧起跑的（`slide-up` 0→45、`bar` 20→50、
 * 03-steps 的第三行要到 135→160 才落位），第 0 帧的画面是"所有层都还没进场"。
 * 180 帧（6 秒）之后三套模板的元素都已 hold 在终态。
 */
const POSTER_FRAME = 180;

/** 生成模板预览图：渲到"元素都已落位"的那一帧，只留那一张当海报。 */
async function runPosters(ctx) {
  const { spec, emit } = ctx;
  const outDir = spec.outDir;
  mkdirSync(outDir, { recursive: true });
  const targetFrame = Number(spec.posterFrame ?? POSTER_FRAME);
  const made = [];
  for (const item of spec.posters || []) {
    if (ctx.signal?.aborted) throw cancelled();
    const doc = item.doc;
    const plan = await renderPlan(ctx.root, doc, 'preview', targetFrame + 1);
    const adapter = ctx.makeAdapter({ width: plan.width, height: plan.height, quality: 'preview' });
    const r = await ctx.renderTemplate({
      doc, pack: ctx.pack, outDir: join(outDir, item.id), quality: 'preview',
      framesOverride: targetFrame + 1, vars: posterVars(doc, item.vars), userSlots: {},
      keepFrames: true, resume: false, adapter, signal: ctx.signal,
    });
    // 挑"目标帧"那一张，其余帧与那段预览视频都删掉 —— 海报目录里只留一张图，
    // 并且用宿主约定的固定文件名（`<id>/frames/frame-000000.png`）。
    const pick = r.frames.filter((f) => f.srcFrame <= targetFrame).pop() || r.frames[r.frames.length - 1];
    for (const f of r.frames) {
      if (f.file !== pick.file) { try { rmSync(join(r.frameDir, f.file), { force: true }); } catch { /* ignore */ } }
    }
    const canonical = join(r.frameDir, 'frame-000000.png');
    if (join(r.frameDir, pick.file) !== canonical) renameSync(join(r.frameDir, pick.file), canonical);
    try { rmSync(join(r.frameDir, 'manifest.json'), { force: true }); } catch { /* ignore */ }
    try { rmSync(r.outFile, { force: true }); } catch { /* ignore */ }
    made.push({ id: item.id, file: canonical, frame: pick.srcFrame });
    emit({ t: 'progress', phase: 'posters', done: made.length, total: spec.posters.length, pct: made.length / spec.posters.length, text: `预览图 ${made.length}/${spec.posters.length}（第 ${pick.srcFrame} 帧）` });
  }
  emit({ t: 'log', msg: `模板预览图：${made.length} 张（取第 ${targetFrame} 帧附近，此时元素已落位）` });
  return { ok: true, kind: 'posters', outDir, posters: made };
}

function summarizeRender(r) {
  return {
    orientation: r.orientation,
    file: r.outFile,
    width: r.width,
    height: r.height,
    fps: r.fps,
    frames: r.frameCount,
    rendered: r.renderedFrames,
    resumed: r.resumedFrames || 0,
    msPerFrame: Number((r.msPerFrame || 0).toFixed(2)),
    renderMs: r.renderMs,
    adapter: r.adapter,
    warnings: r.warnings || [],
    sha256: r.videoSha256,
  };
}

function firstDoc(spec) {
  return spec.pair.vertical || spec.pair.horizontal || Object.values(spec.pair)[0];
}

/** 兜底 TTS：中英切段混读（华言 + lessac）；模型不在就退回系统音色。 */
export function defaultTts(root) {
  const zh = join(root, 'models/vits-piper-zh_CN-huayan-medium');
  const en = join(root, 'models/vits-piper-en_US-lessac-medium');
  if (existsSync(zh) && existsSync(en)) {
    return { backend: 'code-switch', zh: { backend: 'local', modelDir: zh }, en: { backend: 'local', modelDir: en } };
  }
  if (existsSync(zh)) return { backend: 'local', modelDir: zh };
  return { backend: 'system' };
}

function cancelled() {
  const e = new Error('任务已取消');
  e.cancelled = true;
  return e;
}

/**
 * 成片合成之后清掉逐帧 PNG。
 *
 * 为什么要管这件事：`renderTemplate` 在 `keepFrames:true` 时会把每一帧 PNG 留在
 * `<outDir>/<orientation>/frames/`，而**引擎从来不清它们**（`produce()` 用的
 * `.frames-tmp` 也一样留着）。一条 12 秒的片子就是 700+ 张 1080×1920 的 PNG。
 * 实测：跑十几轮之后 `out/app` 累积到 **2.7 GB**。
 *
 * 保帧的唯一理由是**断点续渲**，而那只对"没跑完的任务"有意义：
 *   · 中途被杀 / 崩了 → 帧留着，重跑 `resume` 能跳过（这时**不会**走到这里）；
 *   · 正常跑完 → 成片已经在手，帧就是纯占地方。
 * 所以清理点放在"成功之后"，语义刚好。
 * 想要留着帧的人可以把 `spec.keepFramesAfterDone` 打开。
 */
function pruneFrames(outDir, emit) {
  let count = 0;
  let bytes = 0;
  for (const orientation of ['vertical', 'horizontal']) {
    for (const sub of ['frames', '.frames-tmp']) {
      const dir = join(outDir, orientation, sub);
      if (!existsSync(dir)) continue;
      try {
        for (const f of readdirSync(dir)) {
          try { bytes += statSync(join(dir, f)).size; count++; } catch { /* ignore */ }
        }
        rmSync(dir, { recursive: true, force: true });
      } catch { /* 清不掉不算失败，成片已经好了 */ }
    }
  }
  if (count) emit({ t: 'log', msg: `清理逐帧 PNG：${count} 张（释放约 ${(bytes / 1048576).toFixed(0)} MB）—— 成片已合成，帧不再需要` });
}
