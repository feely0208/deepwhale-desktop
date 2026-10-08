/**
 * 自动断句 + 自动分行 + 时间轴分配。
 *
 * 输入一段旁白稿，输出可以直接写回 SRT 的字幕条：
 *   1. 先按标点切句（优先在句末切，句太长再按逗号切）；
 *   2. 每句按最大字数**折行**（中文字按字符数算，英文按词）；
 *   3. 时长按语速（字/秒）分配，或按真实配音时长（有 TTS 结果时优先）；
 *   4. 相邻字幕之间留一点间隔，避免"上一句刚走下一句就来"。
 */

const HARD_BREAK = /([。！？；…\n]+)/; // 句末
const SOFT_BREAK = /([，、：,]+)/; // 句内可切

/** 视觉宽度：中文/全角算 1，半角算 0.5（和字体渲染的近似关系） */
export function visualLength(s) {
  let n = 0;
  for (const ch of String(s)) n += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.5;
  return n;
}

/** 按标点切句 */
export function splitSentences(text) {
  const chunks = String(text)
    .replace(/\r/g, '')
    .split(HARD_BREAK)
    .reduce((acc, part) => {
      if (!part) return acc;
      if (HARD_BREAK.test(part) && acc.length) acc[acc.length - 1] += part;
      else acc.push(part);
      return acc;
    }, [])
    .map((s) => s.trim())
    .filter(Boolean);
  return chunks;
}

/** 折行：优先在标点后断，其次按宽度硬断 */
export function wrapText(text, maxCharsPerLine = 16, maxLines = 2) {
  const limit = maxCharsPerLine * maxLines;
  const sentences = String(text).length > limit ? splitSentences(text) : [text];
  const out = [];
  for (const s of sentences) {
    if (visualLength(s) <= maxCharsPerLine) {
      out.push(s);
      continue;
    }
    // 按软标点切成小段再拼行
    const parts = s.split(SOFT_BREAK).reduce((acc, p) => {
      if (!p) return acc;
      if (SOFT_BREAK.test(p) && acc.length) acc[acc.length - 1] += p;
      else acc.push(p);
      return acc;
    }, []);
    let line = '';
    for (const p of parts) {
      if (visualLength(line + p) <= maxCharsPerLine) {
        line += p;
      } else {
        if (line) out.push(line);
        // 单段仍超长 → 硬断
        let rest = p;
        while (visualLength(rest) > maxCharsPerLine) {
          let cut = 0;
          let w = 0;
          for (const ch of rest) {
            w += visualLength(ch);
            if (w > maxCharsPerLine) break;
            cut += ch.length;
          }
          out.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        line = rest;
      }
    }
    if (line) out.push(line);
  }
  return out.filter(Boolean);
}

/**
 * 主入口：旁白稿 → 字幕条
 * @param {string} text           旁白全文
 * @param {object} opts
 * @param {number} opts.fps       帧率（用于对齐到帧）
 * @param {number} opts.cps       语速（字/秒），默认 4.6（中文解说常见值）
 * @param {number} opts.startMs   起始偏移
 * @param {number} opts.gapMs     条与条之间的间隔
 * @param {number} opts.maxCharsPerLine
 * @param {number} opts.maxLines
 * @param {Array}  opts.durationsMs 可选：每条的真实配音时长（用了 TTS 就传进来，最准）
 */
export function buildCuesFromText(text, opts = {}) {
  const {
    fps = 30,
    cps = 4.6,
    startMs = 0,
    gapMs = 80,
    maxCharsPerLine = 16,
    maxLines = 2,
    durationsMs = null,
  } = opts;

  const sentences = splitSentences(text);
  const cues = [];
  let cursor = startMs;

  sentences.forEach((s, i) => {
    const lines = wrapText(s, maxCharsPerLine, maxLines);
    // 一句折行后超过 maxLines → 拆成多条字幕（每条最多 maxLines 行），
    // 时长按各块的视觉字数比例分配，避免"长句挤成四行"或"字幕一闪而过"。
    const chunks = [];
    for (let k = 0; k < lines.length; k += maxLines) chunks.push(lines.slice(k, k + maxLines));

    const total = chunks.reduce((n, c) => n + visualLength(c.join('')), 0) || 1;
    const natural = Math.max(600, (visualLength(s) / cps) * 1000);
    const sentenceDur = durationsMs && durationsMs[i] ? durationsMs[i] : natural;

    chunks.forEach((chunk) => {
      const weight = visualLength(chunk.join('')) / total;
      const dur = Math.max(500, sentenceDur * weight);
      const start = cursor;
      const end = start + dur;
      cues.push({
        index: cues.length + 1,
        startMs: Math.round((start / 1000) * fps) * (1000 / fps), // 对齐到帧
        endMs: Math.round((end / 1000) * fps) * (1000 / fps),
        text: chunk.join('\n'),
        lines: chunk,
        sentence: s,
      });
      cursor = end + gapMs;
    });
  });

  return cues.map((c, i) => ({ ...c, index: i + 1 }));
}

/** 把字幕条导出成"可以贴进模板的 SRT 字符串" */
export function cuesToSrtText(cues) {
  return cues
    .map((c, i) => {
      const fmt = (ms) => {
        const t = Math.max(0, Math.round(ms));
        const h = Math.floor(t / 3600000);
        const mi = Math.floor((t % 3600000) / 60000);
        const s = Math.floor((t % 60000) / 1000);
        const ms3 = t % 1000;
        return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms3).padStart(3, '0')}`;
      };
      return `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.text}`;
    })
    .join('\n\n') + '\n';
}
