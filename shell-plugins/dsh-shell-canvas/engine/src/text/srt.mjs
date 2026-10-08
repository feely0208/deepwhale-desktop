/**
 * SRT 字幕：解析 / 生成 / 时间轴换算。
 *
 * 字幕是我们引擎的**一等公民**（P0 缺口之一），不是"烧完就算"的附属品：
 * 模板里放一个 subtitle 节点，引擎按帧号取出当前应该显示的那条。
 */

/** SRT 时间戳 "00:00:03,200" → 毫秒 */
export function parseTime(s) {
  const m = String(s).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) throw new Error(`SRT 时间戳格式不对: ${s}`);
  const [, h, mi, sec, ms] = m;
  return (+h * 3600 + +mi * 60 + +sec) * 1000 + +String(ms).padEnd(3, '0').slice(0, 3);
}

/** 毫秒 → SRT 时间戳 */
export function formatTime(ms) {
  const t = Math.max(0, Math.round(ms));
  const h = Math.floor(t / 3600000);
  const mi = Math.floor((t % 3600000) / 60000);
  const s = Math.floor((t % 60000) / 1000);
  const msec = t % 1000;
  return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(msec).padStart(3, '0')}`;
}

/** 解析 SRT → [{ index, startMs, endMs, text, lines[] }] */
export function parseSrt(text) {
  const blocks = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/^\uFEFF/, '')
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

  const cues = [];
  for (const b of blocks) {
    const lines = b.split('\n');
    let i = 0;
    // 序号行可缺省
    if (/^\d+$/.test(lines[0]?.trim())) i = 1;
    const timeLine = lines[i];
    const m = timeLine?.match(/(\d+:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d+:\d{2}:\d{2}[,.]\d{1,3})/);
    if (!m) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    cues.push({
      index: cues.length + 1,
      startMs: parseTime(m[1]),
      endMs: parseTime(m[2]),
      text: body,
      lines: body.split('\n').map((l) => l.trim()).filter(Boolean),
    });
  }
  if (!cues.length) throw new Error('没有解析出任何字幕条（检查 SRT 格式）');
  return cues;
}

/** cues → SRT 文本 */
export function buildSrt(cues) {
  return (
    cues
      .map((c, i) => `${i + 1}\n${formatTime(c.startMs)} --> ${formatTime(c.endMs)}\n${c.text}`)
      .join('\n\n') + '\n'
  );
}

/** 帧号 ↔ 毫秒（人写秒、内核认帧；这里是换算的唯一入口） */
export function frameToMs(frame, fps) {
  return (frame / fps) * 1000;
}

export function msToFrame(ms, fps) {
  return Math.round((ms / 1000) * fps);
}

/** 取某一帧应显示的字幕条（找不到就返回 null，画面就空着） */
export function cueAtFrame(cues, frame, fps) {
  const ms = frameToMs(frame, fps);
  return cues.find((c) => ms >= c.startMs && ms < c.endMs) || null;
}
