/**
 * 中英混读（code-switch）：按语言切段 → 中文用中文音色、英文用英文音色 → 拼回一句话。
 *
 * 为什么需要它：中文 TTS 模型（如 Piper 华言）遇到英文词是按拼音念的，
 * "AI Prompt" 会被读成 "A-I-P-r-o-m-p-t" 或更糟。行业通用解法就是**分段合成再拼接**——
 * 不换模型、不加训练，效果立竿见影。
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN = /[A-Za-z]/;
const DIGIT = /[0-9]/;

/** 给一个字符分类：zh（汉字）/ en（拉丁字母）/ num（数字）/ other（标点、空白） */
function charLang(ch) {
  if (CJK.test(ch)) return 'zh';
  if (LATIN.test(ch)) return 'en';
  if (DIGIT.test(ch)) return 'num';
  return 'other';
}

/**
 * 切段规则：
 *   1. 连续汉字 = zh 段；连续拉丁字母 = en 段；连续数字跟随**前一段**的语言（"AI 2025" 一起读英文）
 *   2. 标点/空格跟随前一段（避免被当成独立段造成停顿）
 *   3. 过短的段（<2 个有效字符）并入相邻段，避免"一个一个词念"的碎裂感
 */
export function splitByScript(text) {
  const s = String(text);
  const raw = [];
  let cur = { lang: null, text: '' };

  for (const ch of s) {
    const l = charLang(ch);
    if (l === 'other') {
      cur.text += ch;
      continue;
    }
    const effective = l === 'num' ? (cur.lang || 'en') : l;
    if (cur.lang === null) {
      cur.lang = effective;
      cur.text += ch;
    } else if (cur.lang === effective) {
      cur.text += ch;
    } else {
      raw.push(cur);
      cur = { lang: effective, text: ch };
    }
  }
  if (cur.text) raw.push(cur);

  // 合并规则（关键）：纯标点段并回前一段；
  //   ⚠️ 绝不把**中文段**并进英文段——那会让英文音色去念汉字。
  //   反过来，单个拉丁字母（如"与 A 之间"的 A）并进中文段是可以接受的。
  const out = [];
  for (const seg of raw) {
    const core = seg.text.replace(/[\s\p{P}\p{S}]/gu, '');
    const prev = out[out.length - 1];
    const isPunctOnly = core.length === 0;
    const shortLatin = seg.lang === 'en' && core.length < 2;
    if (prev && (isPunctOnly || shortLatin)) {
      prev.text += seg.text;
    } else {
      out.push({ ...seg });
    }
  }
  return out.map((s) => ({ lang: s.lang || 'zh', text: s.text }));
}

/** 这段文本是否需要混读（同时含中日韩文字与拉丁字母） */
export function needsCodeSwitch(text) {
  return CJK.test(text) && LATIN.test(text);
}
