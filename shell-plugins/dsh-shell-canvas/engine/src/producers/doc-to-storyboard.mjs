/**
 * 内置生产者示例 ②：文档 → 分镜（doc.storyboard）
 *
 * 与 ① 的区别（这是它存在的意义）：
 *   ① 吃"一段文案"，标题自己填；
 *   ② 吃"一整篇文档"（md/txt/纯文本），**自己从文档里提炼标题与分段**。
 *
 * 为什么要有第二个示例：
 *   只有一个生产者，接口是不是真"可插拔"是看不出来的 ——
 *   两个形态完全不同（短文案 vs 长文档）都插得进来，才证明这层设计成立。
 *   而"把已有文档变成视频"本身也是最常见的一类需求
 *   （公文/报告/案例/知识库 → 片子）。
 *
 * 它**故意不接 AI**：不调模型、不花钱、离线可跑。
 * "用 AI 提炼分镜"那是另一个 producer（`ai.storyboard`），进来就换这一个文件。
 */

/** 去掉 Markdown 语法噪音，得到"能念的正文"。 */
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, '')          // 代码块整块丢掉（念不出来）
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')      // 标题记号
    .replace(/^\s*[-*+]\s+/gm, '')           // 列表记号
    .replace(/^\s*\d+[.、)]\s+/gm, '')       // 有序列表
    .replace(/\*\*|__|`|~~/g, '')            // 强调记号
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')    // 图片
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接保留文字
    .replace(/^\s*>\s?/gm, '')               // 引用
    .replace(/\|/g, ' ')                     // 表格竖线
    .replace(/^[-\s:]+$/gm, '');             // 表格分隔行
}

/** 按标题切段；没有标题就整体一段。 */
function sections(text) {
  const lines = String(text || '').split('\n');
  const out = [];
  let cur = { title: '', body: [] };
  const isHead = (l) => /^\s{0,3}#{1,6}\s+\S/.test(l);
  for (const line of lines) {
    if (isHead(line)) {
      if (cur.title || cur.body.join('').trim()) out.push(cur);
      cur = { title: line.replace(/^\s{0,3}#{1,6}\s+/, '').trim(), body: [] };
    } else {
      cur.body.push(line);
    }
  }
  if (cur.title || cur.body.join('').trim()) out.push(cur);
  return out.length ? out : [{ title: '', body: [String(text || '')] }];
}

/** 拆句：优先按标点断；太长的句子再按逗号切，避免一句占满屏。 */
function sentences(text) {
  const raw = String(text || '')
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out = [];
  for (const s of raw) {
    if (s.length <= 34) { out.push(s); continue; }
    let buf = '';
    for (const piece of s.split(/(?<=[，,、])/)) {
      if ((buf + piece).length > 34 && buf) { out.push(buf.trim()); buf = piece; continue; }
      buf += piece;
    }
    if (buf.trim()) out.push(buf.trim());
  }
  return out;
}

function toSrt(list) {
  const fmt = (sec) => {
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.round((sec - Math.floor(sec)) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  };
  const PER = 2.5;   // 占位；管线会按真实配音时长重新对齐
  return list.map((s, i) => `${i + 1}\n${fmt(i * PER)} --> ${fmt((i + 1) * PER)}\n${s}\n`).join('\n');
}

function register(registerProducer) {
  registerProducer({
    id: 'doc.storyboard',
    title: '文档 → 分镜',
    describe: '把一整篇文档（md/txt）提炼成标题与分段字幕，配上素材交给模板出片。不联网、不花钱。',
    input: {
      text: { type: 'string', required: false, label: '文档正文（或与 file 二选一）' },
      file: { type: 'string', required: false, label: '文档路径（md/txt）' },
      title: { type: 'string', required: false, label: '标题（不给则取文档首个标题）' },
      maxSentences: { type: 'number', required: false, label: '最多取几句', default: 40 },
      shots: { type: 'array<string>', required: false, label: '素材图（绝对路径）', max: 6 },
      orientation: { type: 'string', required: false, label: '版式', enum: ['vertical', 'horizontal'], default: 'vertical' },
    },
    produce(input, ctx = {}) {
      if (!input.text && !input.file) throw new Error('要么给 text（正文），要么给 file（文档路径）');
      const doc = input.text ? String(input.text) : (ctx.readText ? ctx.readText(input.file) : '');
      if (!String(doc).trim()) throw new Error('文档是空的');

      const max = Number(input.maxSentences) > 0 ? Number(input.maxSentences) : 40;
      const secs = sections(doc);
      // 标题优先级：显式 title > 首个标题 > 第一句
      const headSeen = secs.find((s) => s.title);
      const plain = stripMarkdown(doc);
      const firstSentence = sentences(stripMarkdown(secs[0].body.join('\n')))[0] || '';
      const title = String(input.title || (headSeen && headSeen.title) || firstSentence).slice(0, 40);

      // 正文：把各段正文按顺序拼起来拆句（标题已进 title，不再念一遍）
      const bodyText = secs.map((s) => stripMarkdown(s.body.join('\n'))).join('\n');
      let list = sentences(bodyText);
      const truncated = list.length > max;
      if (truncated) list = list.slice(0, max);
      if (!list.length) throw new Error('文档里没有可念的正文（可能只有标题）');

      const orientation = input.orientation === 'horizontal' ? 'horizontal' : 'vertical';
      const shots = Array.isArray(input.shots) ? input.shots.filter(Boolean) : [];
      for (const s of shots) if (ctx.assertAsset) ctx.assertAsset(s);

      return {
        template: `01-narration/${orientation}`,
        vars: { title, subtitle: toSrt(list) },
        assets: shots.length ? { shots } : {},
        notes: [
          `文档 ${secs.length} 段 → 正文 ${list.length} 句${truncated ? `（已截断，原 ${sentences(bodyText).length} 句）` : ''}`,
          `标题取自${input.title ? '参数' : headSeen && headSeen.title ? '文档标题' : '首句'}：「${title}」`,
          shots.length ? `素材 ${shots.length} 张` : '未给素材（画面只有标题/字幕）',
        ],
      };
    },
  });
}

export { register, stripMarkdown, sentences, sections, toSrt };
