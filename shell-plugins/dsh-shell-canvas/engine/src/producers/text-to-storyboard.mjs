/**
 * 内置生产者示例 ①：文案 → 分镜（text.storyboard）
 *
 * 它做的事**故意很简单**，因为它的作用是**证明接口能用**，不是把内容做得多高级：
 *   一段文案 → 拆句 → 生成 SRT（时序先占位，管线会按**真实配音时长**重新对齐）
 *            → 配上素材与标题 → 交给模板渲染
 *
 * 为什么这一步重要：
 *   以前"内容 → 片子"是写死在引擎里的（只能拿模板变量直接渲染）。
 *   有了生产者接口，**换成"文档 → 分镜""表格 → 分镜""数据库 → 分镜"
 *   都只是再加一个文件，引擎一行都不用改。**
 */

/** 极简拆句：中文标点断句，保留标点；过滤空串。 */
function splitSentences(text) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  return t
    .split(/(?<=[。！？!?；;])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 把句子拼成 SRT。时间先按"每句 2.5 秒"占位 —— 管线会用真实配音时长覆盖。 */
function toSrt(sentences) {
  const fmt = (sec) => {
    const h = String(Math.floor(sec / 3600)).padStart(2, '0');
    const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
    const s = String(Math.floor(sec % 60)).padStart(2, '0');
    const ms = String(Math.round((sec - Math.floor(sec)) * 1000)).padStart(3, '0');
    return `${h}:${m}:${s},${ms}`;
  };
  const PER = 2.5;
  return sentences
    .map((s, i) => `${i + 1}\n${fmt(i * PER)} --> ${fmt((i + 1) * PER)}\n${s}\n`)
    .join('\n');
}

function register(registerProducer) {
  registerProducer({
    id: 'text.storyboard',
    title: '文案 → 分镜',
    describe: '把一段文案拆句、生成字幕、配上素材与标题，交给模板出片。',
    input: {
      text: { type: 'string', required: true, label: '文案' },
      title: { type: 'string', required: false, label: '标题' },
      shots: { type: 'array<string>', required: false, label: '素材图（绝对路径）', max: 6 },
      orientation: { type: 'string', required: false, label: '版式', enum: ['vertical', 'horizontal'], default: 'vertical' },
    },
    produce(input, ctx = {}) {
      const sentences = splitSentences(input.text);
      if (sentences.length === 0) throw new Error('文案是空的（text 必填）');

      const orientation = input.orientation === 'horizontal' ? 'horizontal' : 'vertical';
      const shots = Array.isArray(input.shots) ? input.shots.filter(Boolean) : [];
      // 素材白名单：第三方 producer 不许把任意文件塞进成片
      for (const s of shots) {
        // 延迟 import，避免循环依赖；这里只在有素材时才用得上
        if (ctx.assertAsset) ctx.assertAsset(s);
      }

      const title = String(input.title || sentences[0]).slice(0, 40);
      const vars = { title, subtitle: toSrt(sentences) };
      const assets = shots.length ? { shots } : {};

      return {
        template: `01-narration/${orientation}`,
        vars,
        assets,
        notes: [
          `拆成 ${sentences.length} 句`,
          shots.length ? `素材 ${shots.length} 张` : '未给素材（画面只有标题/字幕）',
        ],
      };
    },
  });
}

export { register, splitSentences, toSrt };
