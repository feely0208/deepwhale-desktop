/**
 * 内置生产者示例 ③：文案 + **AI 生图** → 分镜（ai.shots）
 *
 * 这是"内容力"的那一块 —— 前面两个生产者（文案/文档）都只能用**已有的图片**；
 * 这一个会去调**用户自己配置的生图接口**，为每个分镜现场生成画面。
 *
 * 设计要点（为什么这样才对）：
 *   · 我们**不内置模型、不代持 key**：provider 由用户在 $DSH_HOME/canvas-providers.json 里配；
 *   · 没配 provider 时**明确报错**（不是悄悄退回"无素材"）——否则用户以为出图了其实没有；
 *   · 每句生成一张图是**最朴素的策略**，够用即可；更好的分镜策略是另一个 producer 的事。
 *
 * 由此，"换个生图服务"= 改用户自己的配置，**引擎与插件一行都不用动**。
 */

function splitSentences(text) {
  return String(text || '').replace(/\r/g, '').trim()
    .split(/(?<=[。！？!?；;])/).map((s) => s.trim()).filter(Boolean);
}
function toSrt(list, per = 2.5) {
  const fmt = (sec) => {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(Math.floor(sec % 60))},${p(Math.round((sec - Math.floor(sec)) * 1000), 3)}`;
  };
  return list.map((s, i) => `${i + 1}\n${fmt(i * per)} --> ${fmt((i + 1) * per)}\n${s}\n`).join('\n');
}

function register(registerProducer) {
  registerProducer({
    id: 'ai.shots',
    title: '文案 + AI 生图 → 分镜',
    describe: '按分镜逐句调用户自己配置的生图接口生成画面，再交给模板出片。（需要先在 provider 配置里接一个生图服务）',
    input: {
      text: { type: 'string', required: true, label: '文案' },
      title: { type: 'string', required: false, label: '标题' },
      count: { type: 'number', required: false, label: '生成张数（默认每句一张，最多 6）', default: 6 },
      style: { type: 'string', required: false, label: '风格提示词（拼在每句前面）' },
      provider: { type: 'string', required: false, label: '指定 provider id（不给则用第一个生图 provider）' },
      orientation: { type: 'string', required: false, label: '版式', enum: ['vertical', 'horizontal'], default: 'vertical' },
    },
    async produce(input, ctx = {}) {
      const list = splitSentences(input.text);
      if (!list.length) throw new Error('文案是空的（text 必填）');
      if (typeof ctx.provider !== 'function') throw new Error('当前环境没有 provider 能力（请在 CLI/面板里跑）');

      const want = Math.max(1, Math.min(6, Number(input.count) > 0 ? Number(input.count) : 6));
      const pick = input.provider || 'image';
      const p = ctx.provider(pick);
      if (!p) {
        throw new Error('没有可用的生图 provider。请在 $DSH_HOME/canvas-providers.json 里配置一个'
          + '（adapter 可选 http 或 command），否则这一条没法出图。');
      }

      const n = Math.min(want, list.length || 1);
      const shots = [];
      for (let i = 0; i < n; i++) {
        const line = list[i] || list[0];
        const prompt = `${input.style ? input.style + '；' : ''}${line}`;
        // 每张图单独 try：一张失败不该让整条片子废掉，但失败必须记在 notes 里
        try {
          const file = await p.generate({ prompt, outDir: ctx.assetDir || ctx.outDir || '.', index: i });
          if (ctx.assertAsset) ctx.assertAsset(file);
          shots.push(file);
        } catch (e) {
          console.error(`[ai.shots] 第 ${i + 1} 张生成失败：${e.message}`);
        }
      }
      if (!shots.length) throw new Error(`生图全部失败（provider=${p.id}）—— 检查配置与网络/命令`);

      const orientation = input.orientation === 'horizontal' ? 'horizontal' : 'vertical';
      return {
        template: `01-narration/${orientation}`,
        vars: { title: String(input.title || list[0]).slice(0, 40), subtitle: toSrt(list) },
        assets: { shots },
        notes: [
          `provider=${p.id}（${p.kind}/${p.adapter}）`,
          `生成 ${shots.length}/${n} 张${shots.length < n ? '（有失败，见日志）' : ''}`,
        ],
      };
    },
  });
}

export { register };
