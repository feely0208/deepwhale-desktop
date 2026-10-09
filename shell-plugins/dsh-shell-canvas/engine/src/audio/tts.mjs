/**
 * 配音（TTS）适配器层。
 *
 * 为什么做成适配器：立项文档里的 P0 要求是"人声不能像机器"，
 * 真答案是**本地神经 TTS**（CosyVoice2 / IndexTTS2 / F5-TTS / sherpa-onnx）。
 * 但那需要额外装模型（几十 MB 到几 GB），不能塞进 S1/S2 的引擎里。
 * 所以：
 *   - `system`：macOS `say`（**本机即时可用**，用于打通链路与做占位，音色偏机械）
 *   - `local` ：本地神经 TTS 适配器（**接口就位**，装上模型即可切换），见后端清单
 *   - `cloud` ：云 TTS（**默认关闭**：文本会离开本机，与"素材不出本机"冲突，要用户显式同意）
 *
 * 无论用哪个后端，产物都是 44.1kHz 单声道 wav，后续混流一条链路。
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { run } from '../encode.mjs';
import { findFfmpeg, findFfprobe } from '../paths.mjs';
import { splitByScript, needsCodeSwitch } from './codeswitch.mjs';

export class TtsBackend {
  get id() { return 'abstract'; }
  get leavesMachine() { return false; }
  async synthesize() { throw new Error('未实现'); }
}

/** macOS 系统 TTS：链路验证用，音色一般；不联网。 */
export class SystemTts extends TtsBackend {
  constructor({ voice = 'Tingting (中文（中国大陆）)', rate = 180 } = {}) {
    super();
    this.voice = voice;
    this.rate = rate;
  }

  get id() { return 'system'; }

  async synthesize({ text, outWav, tmpDir = tmpdir() }) {
    // ⚠️ 2026-10-09 改：原来这里**硬编码 macOS**（非 darwin 直接 throw），
    //    于是 Windows/Linux 用户「点出片 → 报一句看不懂的错」。
    //    三平台各接一条系统语音通路，都不需要装任何东西：
    //      macOS  → say（自带）
    //      Windows→ PowerShell + System.Speech（自带）
    //      Linux  → espeak-ng / espeak（多数发行版可装；装了就能用）
    const plat = process.platform;
    const ffmpeg = findFfmpeg();
    if (plat === 'darwin') {
      const aiff = join(tmpDir, `tts-${Date.now()}.aiff`);
      await run('say', ['-v', this.voice, '-r', String(this.rate), '-o', aiff, text]);
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', aiff, '-ar', '44100', '-ac', '1', outWav]);
      if (existsSync(aiff)) rmSync(aiff);
    } else if (plat === 'win32') {
      // PowerShell 里单引号字符串的转义：把 ' 变成 ''
      const safe = String(text).replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName System.Speech;',
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;',
        `$s.SetOutputToWaveFile('${outWav.replace(/'/g, "''")}');`,
        `$s.Speak('${safe}');`,
        '$s.Dispose();',
      ].join(' ');
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps]);
      // 统一成 44.1k 单声道（与 macOS/Linux 通路一致，后面混音才可预期）
      const norm = outWav.replace(/\.wav$/, '.norm.wav');
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outWav, '-ar', '44100', '-ac', '1', norm]);
      renameSync(norm, outWav);
    } else {
      // Linux：优先 espeak-ng（发音更自然），退回 espeak
      const bin = ['espeak-ng', 'espeak'].find((b) => {
        try { execFileSync('which', [b], { stdio: 'ignore' }); return true; } catch { return false; }
      });
      if (!bin) {
        throw new Error('系统配音不可用：Linux 上请安装 espeak-ng（apt install espeak-ng），'
          + '或在面板里改用「我自己的配音文件」。');
      }
      const lang = /^[\u4e00-\u9fff]/.test(String(text).trim()) ? 'zh' : 'en';
      await run(bin, ['-v', lang, '-s', String(Math.min(400, Math.round(this.rate * 1.6))), '-w', outWav, text]);
    }
    return { outWav, durationMs: await audioDurationMs(outWav), voice: this.voice, backend: this.id };
  }
}

/**
 * 本地神经 TTS（接口就位，尚未安装模型）。
 *
 * 推荐后端（按"中文自然度 / 体积 / 是否需要 GPU"权衡）：
 *   - **sherpa-onnx**（vits-zh / matcha-zh）：ONNX + Node 绑定，CPU 可跑，模型 50~200MB，**首选**
 *   - **IndexTTS2 / CosyVoice2**：音色更像真人、可克隆，但要 Python + 数百 MB~GB 权重
 *   - **F5-TTS**：零样本克隆，质量好，同样偏重
 *
 * 装上之后实现本类并注册到 createTtsBackend 即可，模板与流水线不用改。
 */
export class LocalNeuralTts extends TtsBackend {
  constructor({ modelDir, speakerId = 0, speed = 1.0, numThreads = 4, lang = null } = {}) {
    super();
    if (!modelDir) throw new Error('local TTS 需要 modelDir（models/ 下的模型目录）');
    this.modelDir = modelDir;
    this.speakerId = speakerId;
    this.speed = speed;
    this.numThreads = numThreads;
    // 音素语言：多语模型（kokoro）读英文段时必须给 en-us，否则会按中文音素念
    this.lang = lang;
  }
  get id() { return 'local'; }
  get voice() {
    const base = String(this.modelDir).split('/').filter(Boolean).slice(-1)[0];
    const spk = this.speakerId ? `·说话人${this.speakerId}` : '';
    const lg = this.lang ? `·${this.lang}` : '';
    return `${base}${spk}${lg}`;
  }

  async synthesize({ text, outWav }) {
    const { synthesizeWithModel } = await import('./sherpa.mjs');
    const { samples, sampleRate } = await synthesizeWithModel({
      modelDir: this.modelDir,
      text,
      speakerId: this.speakerId,
      speed: this.speed,
      opts: { numThreads: this.numThreads, ...(this.lang ? { lang: this.lang } : {}) },
    });
    writeWav16(outWav, samples, sampleRate);
    const ffmpeg = findFfmpeg();
    const norm = outWav.replace(/\.wav$/, '.norm.wav');
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outWav, '-ar', '44100', '-ac', '1', norm]);
    renameSync(norm, outWav);
    return { outWav, durationMs: await audioDurationMs(outWav), voice: `${this.modelDir}#${this.speakerId}`, backend: this.id };
  }
}

/** 写 16-bit PCM WAV（sherpa 给的是 Float32 样本） */
export function writeWav16(path, samples, sampleRate) {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  writeFileSync(path, buf);
}

/**
 * 中英混读：中文段用中文音色、英文段用英文音色，段内拼接（不加停顿，保持一口气）。
 * 例：zh = Piper 华言，en = Piper lessac。
 */
export class CodeSwitchTts extends TtsBackend {
  constructor({ zh, en, tmpDir = '/tmp' } = {}) {
    super();
    if (!zh || !en) throw new Error('code-switch 需要同时给 zh 与 en 两个后端配置');
    this.zh = createTtsBackend(zh);
    this.en = createTtsBackend(en);
    this.tmpDir = tmpDir;
  }
  get id() { return 'code-switch'; }
  get voice() {
    const name = (b) => (b.voice ? String(b.voice).split('/').slice(-1)[0] : b.id);
    return `${name(this.zh)} + ${name(this.en)}`;
  }

  async synthesize({ text, outWav, tmpDir = this.tmpDir }) {
    if (!needsCodeSwitch(text)) {
      const only = /[A-Za-z]/.test(text) && !/[\u4e00-\u9fff]/.test(text) ? this.en : this.zh;
      return only.synthesize({ text, outWav, tmpDir });
    }
    const segs = splitByScript(text);
    const ffmpeg = findFfmpeg();
    const parts = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg.text.trim()) continue;
      const backend = seg.lang === 'en' ? this.en : this.zh;
      const raw = join(tmpDir, `cs-${Date.now()}-${i}-raw.wav`);
      await backend.synthesize({ text: seg.text.trim(), outWav: raw, tmpDir });
      // ⚠️ 拼接质量的关键两步（不然听着就是"半拍空档 + 忽大忽小"）：
      //   ① 去掉每段前后的静音（TTS 普遍会在首尾塞 100~300ms）
      //   ② 把每段响度对齐到同一目标（huayan 与 kokoro 的原始响度不一样）
      const wav = join(tmpDir, `cs-${Date.now()}-${i}.wav`);
      await run(ffmpeg, [
        '-y', '-hide_banner', '-loglevel', 'error', '-i', raw,
        '-af',
        'silenceremove=start_periods=1:start_silence=0.03:start_threshold=-45dB,' +
          'areverse,silenceremove=start_periods=1:start_silence=0.03:start_threshold=-45dB,areverse,' +
          'loudnorm=I=-16:TP=-1.5:LRA=11',
        '-ar', '44100', '-ac', '1', wav,
      ]);
      rmSync(raw, { force: true });
      parts.push(wav);
    }
    if (!parts.length) throw new Error('混读切段后没有可合成的片段');
    if (parts.length === 1) {
      await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', parts[0], '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', outWav]);
    } else {
      // ③ 段间做 45ms 淡接，抹掉拼接处的"咔"和硬切（acrossfade 会把两段叠一点，听感更连贯）
      const args = ['-y', '-hide_banner', '-loglevel', 'error'];
      for (const p of parts) args.push('-i', p);
      const chains = [];
      let prev = '[0:a]';
      for (let i = 1; i < parts.length; i++) {
        const out = i === parts.length - 1 ? '[mix]' : `[x${i}]`;
        chains.push(`${prev}[${i}:a]acrossfade=d=0.045:c1=tri:c2=tri${out}`);
        prev = out;
      }
      args.push('-filter_complex', chains.join(';'), '-map', '[mix]', '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '1', outWav);
      await run(ffmpeg, args);
    }
    for (const p of parts) rmSync(p, { force: true });
    return { outWav, durationMs: await audioDurationMs(outWav), voice: this.voice, backend: this.id, segments: segs.length };
  }
}

/**
 * 【外部 TTS】用户接自己的配音服务——我们不提供音色，只提供接口。
 *
 * 两种模式（任选其一）：
 *   · 命令模式：command = 'my-tts --text "{text}" --out "{out}"'（{voice}/{out} 会被替换）
 *       —— 用户可以用任何本地工具：自己买的 TTS、自己的脚本、甚至剪映导出的流程
 *   · HTTP 模式：url = 'https://api.example.com/tts'（POST {text, voice} → 返回音频字节）
 *       —— 适合 ElevenLabs / 讯飞 / 火山 等云端 TTS（⚠️ 文本会离开本机，必须显式告知用户）
 *
 * 与「字体」策略完全一致：内置只用开源可商用，商业的让用户自己接、我们不提供也不分发。
 */
export class ExternalTts extends TtsBackend {
  constructor({ command = null, url = null, apiKey = null, voice = null, headers = {}, timeoutMs = 180000 } = {}) {
    super();
    if (!command && !url) throw new Error('外部 TTS 需要 command 或 url 之一');
    this.command = command;
    this.url = url;
    this.apiKey = apiKey;
    this.voice = voice;
    this.headers = headers;
    this.timeoutMs = timeoutMs;
  }
  get id() { return 'external'; }
  get voice_() { return this.voice; }
  /** 走 HTTP 的外部服务 = 文本会离开本机，UI 必须提示 */
  get leavesMachine() { return !!this.url; }

  async synthesize({ text, outWav, tmpDir = '/tmp' }) {
    const ffmpeg = findFfmpeg();
    mkdirSync(dirname(outWav), { recursive: true });   // 输出目录得先在
    if (this.command) {
      const q = (v) => `'${String(v).replace(/'/g, "'\\''")}'`;
      const cmd = this.command
        .replaceAll('{text}', q(text))
        .replaceAll('{voice}', q(this.voice || ''))
        .replaceAll('{out}', q(outWav));
      const r = spawnSync('bash', ['-lc', cmd], { encoding: 'utf8', timeout: this.timeoutMs });
      if (r.status !== 0) throw new Error(`外部 TTS 命令失败(${r.status}): ${(r.stderr || '').slice(-300)}`);
      if (!existsSync(outWav)) throw new Error('外部 TTS 命令没有产出音频文件');
    } else {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}), ...this.headers },
        body: JSON.stringify({ text, voice: this.voice }),
      });
      if (!res.ok) throw new Error(`外部 TTS 接口返回 ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(outWav, buf);
    }
    // 统一成 44.1k 单声道 wav，后续混流一条链路
    const norm = outWav.replace(/\.wav$/, '.norm.wav');
    await run(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', outWav, '-ar', '44100', '-ac', '1', norm]);
    renameSync(norm, outWav);
    return { outWav, durationMs: await audioDurationMs(outWav), voice: this.voice || 'external', backend: this.id };
  }
}

/**
 * 按主语言自动选音色（**不做混编**）——2026-10-07 定稿：
 *   中文稿 → 中文音色（huayan）；英文稿 → 英文音色（kokoro）
 * 为什么不混编：分句合成再拼接，接缝处永远不自然（实测过，音节/语调都断）。
 * 一条片子一个音色，听感统一，也没有拼接问题。
 *
 * 附带**读法替换表**：字幕显示 `AI`，配音读"人工智能"——中文稿里夹英文词的标准解法
 * （只影响配音文本，不影响字幕）。
 */
export class AutoTts extends TtsBackend {
  constructor({ zh, en, pronunciation = {} } = {}) {
    super();
    if (!zh || !en) throw new Error('auto 模式需要同时给 zh 与 en 两套音色配置');
    this.zh = createTtsBackend(zh);
    this.en = createTtsBackend(en);
    this.pronunciation = pronunciation;
  }
  get id() { return 'auto'; }
  get voice() { return `自动：中文→${this.zh.voice}｜英文→${this.en.voice}`; }

  /** 主语言判定：拉丁字母占"有效字符"的比例过半就算英文稿 */
  pick(text) {
    const cjk = (String(text).match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    const latin = (String(text).match(/[A-Za-z]/g) || []).length;
    if (cjk + latin === 0) return this.zh;
    return latin / (cjk + latin) > 0.6 ? this.en : this.zh;
  }

  /** 读法替换（只改配音文本） */
  applyPron(text) {
    let out = String(text);
    for (const [from, to] of Object.entries(this.pronunciation || {})) {
      if (from) out = out.split(from).join(to);
    }
    return out;
  }

  async synthesize({ text, outWav, tmpDir = '/tmp' }) {
    const spoken = this.applyPronunciationSafe(text);
    const backend = this.pick(spoken);
    const r = await backend.synthesize({ text: spoken, outWav, tmpDir });
    return { ...r, backend: 'auto', voice: backend.voice, spoken };
  }

  applyPronunciationSafe(text) { return this.applyPron(text); }
}

export function createTtsBackend({ backend = 'system', ...opts } = {}) {
  switch (backend) {
    case 'system': return new SystemTts(opts);
    case 'local': return new LocalNeuralTts(opts);
    case 'code-switch': return new CodeSwitchTts(opts);
    case 'external': return new ExternalTts(opts);
    case 'auto': return new AutoTts(opts);
    case 'cloud':
      throw new Error('cloud TTS 默认禁用：文本会离开本机，需显式开启并与用户确认');
    default:
      throw new Error(`未知 TTS 后端: ${backend}`);
  }
}

export async function audioDurationMs(file) {
  const probe = findFfprobe(findFfmpeg());
  if (!probe) return null;
  const out = await new Promise((resolve, reject) => {
    const p = spawn(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file]);
    let s = '';
    p.stdout.on('data', (d) => (s += d.toString()));
    p.on('error', reject);
    p.on('close', () => resolve(s.trim()));
  });
  const sec = parseFloat(out);
  return Number.isFinite(sec) ? Math.round(sec * 1000) : null;
}
