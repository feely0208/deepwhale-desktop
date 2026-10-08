/**
 * sherpa-onnx 本地神经 TTS 封装。
 *
 * 支持三种模型结构（自动识别，见 detectModelType）：
 *   - vits   ：piper / icefall 的 vits（单 onnx + tokens，可带 lexicon/espeak data）
 *   - matcha ：acousticModel + vocoder（vocos）
 *   - kokoro ：model + voices + tokens + espeak-ng-data + lexicon，多语种
 *
 * 为什么选 sherpa-onnx：Apache-2.0、纯 ONNX、CPU 可跑、Node 绑定有 darwin-arm64 预编译包，
 * 模型 30MB 起——比"Python + torch + 数 GB 权重"的方案轻得多，适合塞进桌面端。
 */

import { readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

function listFiles(dir) {
  return readdirSync(dir).filter((f) => statSync(join(dir, f)).isFile());
}

/** 列出 models/ 下的模型目录 */
export function listModelDirs(root = 'models') {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .map((d) => join(root, d))
    .filter((p) => statSync(p).isDirectory() && listFiles(p).some((f) => f.endsWith('.onnx')))
    .sort();
}

/** 识别模型结构 */
export function detectModelType(dir) {
  const files = listFiles(dir);
  // ⚠️ 必须用 voices.bin 判 kokoro：piper 模型也带 espeak-ng-data，用它判会误分类
  if (files.includes('voices.bin')) return 'kokoro';
  if (files.includes('voices.txt')) return 'kitten';
  if (files.some((f) => /^encoder.*\.onnx$/.test(f)) && files.some((f) => /^decoder.*\.onnx$/.test(f))) return 'zipvoice';
  if (files.some((f) => /^model-steps-\d+\.onnx$/.test(f)) || files.some((f) => /vocos/i.test(f))) return 'matcha';
  return 'vits';
}

function findInDirOrParent(dir, pattern) {
  const cands = [
    ...listFiles(dir).map((f) => join(dir, f)),
    ...listFiles(join(dir, '..')).map((f) => join(dir, '..', f)),
  ];
  return cands.find((p) => pattern.test(p)) || '';
}

function buildConfig(dir, type, { numThreads = 4, lang = 'cmn' } = {}) {
  const files = listFiles(dir);
  const pick = (...names) => {
    for (const n of names) {
      const hit = files.find((f) => f === n) || files.find((f) => f.toLowerCase().includes(n.toLowerCase()));
      if (hit) return join(dir, hit);
    }
    return '';
  };
  const espeakDir = join(dir, 'espeak-ng-data');
  const base = { numThreads, provider: 'cpu', debug: false };

  if (type === 'kokoro') {
    return {
      model: {
        kokoro: {
          model: pick('model.onnx', 'model.int8.onnx'),
          voices: pick('voices.bin'),
          tokens: pick('tokens.txt'),
          dataDir: existsSync(espeakDir) ? espeakDir : '',
          lexicon: pick('lexicon-zh.txt', 'lexicon-us-en.txt', 'lexicon.txt'),
          // ⚠️ espeak-ng 里普通话的 voice 名是 cmn，写 'zh' 会报 "Failed to set eSpeak-ng voice"
          lang: lang || 'cmn',
        },
        ...base,
      },
      maxNumSentences: 1,
    };
  }
  if (type === 'zipvoice') {
    return {
      model: {
        zipvoice: {
          tokens: pick('tokens.txt'),
          encoder: pick('encoder.int8.onnx', 'encoder.onnx'),
          decoder: pick('decoder.int8.onnx', 'decoder.onnx'),
          // ⚠️ ZipVoice 要 24kHz 的 vocos（100 维 mel）；用 22kHz 那个会报 "Got 100 Expected 80"
          vocoder: findInDirOrParent(dir, /vocos[_-]?24khz.*\.onnx$/i) || findInDirOrParent(dir, /vocos.*\.onnx$/i),
          dataDir: existsSync(espeakDir) ? espeakDir : '',
          lexicon: pick('lexicon.txt'),
          featScale: 0.1, tShift: 0.5, targetRms: 0.01, guidanceScale: 1.0,
        },
        ...base,
      },
      maxNumSentences: 1,
    };
  }
  if (type === 'matcha') {
    return {
      model: {
        matcha: {
          acousticModel: pick('model-steps-3.onnx', 'model-steps-2.onnx', 'model.onnx'),
          vocoder: findInDirOrParent(dir, /vocos.*\.onnx$/i) || pick('vocos-22khz-univ.onnx', 'vocos'),
          tokens: pick('tokens.txt'),
          lexicon: pick('lexicon.txt'),
          dataDir: existsSync(espeakDir) ? espeakDir : '',
        },
        ...base,
      },
      maxNumSentences: 1,
    };
  }
  return {
    model: {
      vits: {
        model: pick('model.onnx', 'model.fp16.onnx', '.onnx'),
        tokens: pick('tokens.txt'),
        lexicon: pick('lexicon.txt'),
        dataDir: existsSync(espeakDir) ? espeakDir : '',
      },
      ...base,
    },
    maxNumSentences: 1,
  };
}

const ttsCache = new Map();

export function loadTts(modelDir, opts = {}) {
  const key = `${modelDir}::${JSON.stringify(opts)}`;
  if (ttsCache.has(key)) return ttsCache.get(key);
  const { OfflineTts } = require('sherpa-onnx-node');
  const type = detectModelType(modelDir);
  const cfg = buildConfig(modelDir, type, opts);
  const tts = new OfflineTts(cfg);
  const wrapped = { tts, type, sampleRate: tts.sampleRate, numSpeakers: tts.numSpeakers, config: cfg };
  ttsCache.set(key, wrapped);
  return wrapped;
}

/** 合成一段文本，返回 Float32 样本 */
export async function synthesizeWithModel({ modelDir, text, speakerId = 0, speed = 1.0, reference = null, opts = {} }) {
  const { tts, type, sampleRate, numSpeakers } = loadTts(modelDir, opts);
  const sid = numSpeakers > 0 ? Math.min(speakerId, numSpeakers - 1) : 0;
  // 零样本克隆（zipvoice 等）：给一段参考音频 + 它的文本，用那个音色来读新文本
  const req = reference
    ? {
        text,
        sid,
        speed,
        generationConfig: {
          referenceAudio: reference.samples,
          referenceSampleRate: reference.sampleRate,
          referenceText: reference.text || '',
          speed,
          numSteps: reference.numSteps ?? 4,
          extra: { min_char_in_sentence: 10 },
        },
      }
    : { text, sid, speed };
  const audio = tts.generate(req);
  if (!audio || !audio.samples || !audio.samples.length) throw new Error('合成结果为空');
  return { samples: audio.samples, sampleRate: audio.sampleRate || sampleRate, speakerId: sid, type };
}
