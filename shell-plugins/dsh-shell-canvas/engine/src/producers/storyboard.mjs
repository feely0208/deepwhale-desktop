/**
 * 内置生产者 ④：分镜表 → 完整文档（story.board）
 *
 * 用户要的东西（2026-10-09 原话）：
 *   「素材什么时间节点出现，需要合成视频的时长是多少，
 *     什么时间字幕搭配什么样的素材图片，这个应该是可以自主选择搭配的才是最好的效果」
 *
 * 这正是「分镜」的定义 —— 也是这个工具区别于"随机拼图"的地方。
 * 前面的生产者（文案/文档/AI 生图）都只能**平均摊素材**，用户没法控制；
 * 这一个让用户**逐句指定**：这句配哪张素材、从第几秒开始、停多久。
 *
 * 关键设计：它返回的**不是模板变量，而是一份完整的 Document**
 *   （节点 + 时间线 + 字幕），因为"每句一个镜头、各自时长"这件事
 *   模板变量表达不了 —— 只有文档能表达。
 *   框架因此多了一条能力：**生产者可以产出完整文档**（不止填模板）。
 */

const DEFAULT_FPS = 30;
const CANVAS = { w: 1080, h: 1920 };

function buildSrt(items, fps) {
  const fmt = (sec) => {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return `${p(Math.floor(sec / 3600))}:${p(Math.floor((sec % 3600) / 60))}:${p(Math.floor(sec % 60))},${p(Math.round((sec - Math.floor(sec)) * 1000), 3)}`;
  };
  return items
    .map((it, i) => `${i + 1}\n${fmt(it.start)} --> ${fmt(it.start + it.duration)}\n${it.text}\n`)
    .join('\n');
}

/** 一句按 4 字/秒估时长（没给 duration 时的兜底，用户可覆盖）。 */
function estimateSeconds(text) {
  const n = String(text || '').replace(/\s/g, '').length;
  return Math.max(1.5, Math.round((n / 4) * 10) / 10);
}

function register(registerProducer) {
  registerProducer({
    id: 'story.board',
    title: '分镜表 → 成片',
    describe: '逐句指定：这句说什么、配哪张素材、从第几秒开始、停多久 —— 产出完整分镜文档。',
    input: {
      title: { type: 'string', required: false, label: '标题' },
      items: {
        type: 'array<object>', required: true, label: '分镜表',
        item: {
          text: '这句字幕（必填）',
          shot: '素材图绝对路径（可选；不给则该镜头不放图）',
          start: '开始秒数（可选，不给就接着上一句）',
          duration: '持续秒数（可选，不给按字数估）',
        },
      },
      orientation: { type: 'string', required: false, enum: ['vertical', 'horizontal'], default: 'vertical' },
    },
    produce(input, ctx = {}) {
      const raw = Array.isArray(input.items) ? input.items : [];
      const items = raw
        .map((x) => ({ text: String((x && x.text) || '').trim(), shot: (x && x.shot) || null, start: x && x.start, duration: x && x.duration }))
        .filter((x) => x.text);
      if (!items.length) throw new Error('分镜表是空的（items 必填，至少一句）');

      // 时间轴：没给 start 就接着上一句；没给 duration 就按字数估
      let cursor = 0;
      const laid = items.map((it) => {
        const start = Number.isFinite(Number(it.start)) ? Number(it.start) : cursor;
        const duration = Number.isFinite(Number(it.duration)) && Number(it.duration) > 0 ? Number(it.duration) : estimateSeconds(it.text);
        cursor = start + duration;
        return { ...it, start, duration };
      });

      const orientation = input.orientation === 'horizontal' ? 'horizontal' : 'vertical';
      const w = orientation === 'horizontal' ? 1920 : CANVAS.w;
      const h = orientation === 'horizontal' ? 1080 : CANVAS.h;
      const totalSec = laid.reduce((m, x) => Math.max(m, x.start + x.duration), 0);
      const frames = Math.max(1, Math.round(totalSec * DEFAULT_FPS));

      // 素材槽位：每个镜头一个（user:shotN），这样能走现有的素材通路
      const assets = {};
      const nodes = [
        { id: 'bg', type: 'shape', props: { shape: 'rect', fill: '#071523' } },
        { id: 'glow', type: 'shape', props: { shape: 'circle', fill: '#0E2C42', width: 1200, height: 1200 }, transform: { x: -360, y: -420 } },
        { id: 'title', type: 'text', props: { text: '{{title}}', font: 'source-han-sans', size: 76, weight: 700, color: '#FFFFFF', align: 'left', lineHeight: 1.25, maxLines: 2 }, transform: { x: 90, y: 300 } },
        { id: 'bar', type: 'shape', props: { shape: 'rect', fill: '#14A5B8', width: 120, height: 8, radius: 4 }, transform: { x: 90, y: 560 } },
      ];
      const timeline = [
        { nodeId: 'title', from: 0, to: 40, anim: { name: 'slide-up', params: { distance: 70 } } },
        { nodeId: 'bar', from: 20, to: 50, anim: { name: 'wipe-in', params: { direction: 'left' } } },
      ];
      // 每镜的版位（用户反馈：「图片在视频中都是固定位置的，这个问题你要考虑下怎么解决」）。
      // 同一个位置钉到底 = 看起来不像视频。所以按镜头序号轮换**尺寸/位置/入场方式**，
      // 让每个镜头"换一个机位"。这是最朴素的编排，够用即停。
      const LAYOUTS = [
        { w: 0.78, h: 0.40, x: 0.11, y: 0.355, anim: 'scale-in' },
        { w: 0.88, h: 0.34, x: 0.06, y: 0.40, anim: 'slide-up' },
        { w: 0.66, h: 0.46, x: 0.17, y: 0.33, anim: 'wipe-in' },
        { w: 0.92, h: 0.32, x: 0.04, y: 0.42, anim: 'fade-in' },
      ];
      laid.forEach((it, i) => {
        const from = Math.round(it.start * DEFAULT_FPS);
        const to = Math.round((it.start + it.duration) * DEFAULT_FPS);
        const id = `shot${i + 1}`;
        const lay = LAYOUTS[i % LAYOUTS.length];
        if (it.shot) {
          const slot = `shot${i + 1}`;
          assets[slot] = it.shot;
          nodes.push({
            id, type: 'image',
            // 每个镜头自己的槽位 → 素材与"哪一句"一一对应（不再平均摊）
            props: {
              src: `user:${slot}`, fit: 'cover', radius: 28,
              width: Math.round(w * lay.w),
              height: Math.round(h * lay.h),
            },
            transform: { x: Math.round(w * lay.x), y: Math.round(h * lay.y) },
          });
        }
        if (to > from) {
          timeline.push({ nodeId: id, from, to, hold: true,
            anim: it.shot ? (lay.anim === 'slide-up' ? { name: 'slide-up', params: { distance: 60 } }
              : lay.anim === 'wipe-in' ? { name: 'wipe-in', params: { direction: 'left' } }
              : lay.anim === 'fade-in' ? { name: 'fade-in', params: {} }
              : { name: 'scale-in', params: { fromScale: 1.04 } }) : undefined });
        }
      });
      // 字幕节点：整片时长（时序由 SRT 决定，管线仍会按真实配音重新对齐）
      nodes.push({
        id: 'sub', type: 'subtitle',
        props: {
          srtVar: 'subtitle', font: 'source-han-sans', size: 50, color: '#FFFFFF',
          highlightColor: '#3FD0E0', outline: 3, shadow: true, safeBottom: 330,
        },
      });

      const doc = {
        spec: 1,
        domain: 'video',
        domainVersion: '1.0.0',
        canvas: { units: 'px', w, h, fps: DEFAULT_FPS, frames, preset: orientation === 'horizontal' ? '横版 1920x1080' : '竖版 1080x1920', background: '#071523', safeArea: { bottom: 330 } },
        vars: [
          { key: 'title', type: 'text', required: true, label: '标题' },
          { key: 'subtitle', type: 'text', required: true, label: '字幕' },
        ],
        nodes,
        timeline,
        meta: { id: `storyboard/${orientation}`, name: '分镜表', author: '深鲸', license: 'CC-BY-4.0', version: '1.0.0', aiGenerated: false, tags: ['分镜', '自定义'] },
      };

      return {
        doc,
        vars: { title: String(input.title || laid[0].text).slice(0, 40), subtitle: buildSrt(laid, DEFAULT_FPS) },
        assets,
        notes: [
          `分镜 ${laid.length} 个镜头 · 总时长 ${totalSec.toFixed(1)}s`,
          `有素材的镜头 ${Object.keys(assets).length} 个`,
          laid.map((x, i) => `  镜${i + 1} ${x.start.toFixed(1)}s→${(x.start + x.duration).toFixed(1)}s ${x.shot ? '有图' : '无图'}`).join('\n'),
        ],
      };
    },
  });
}

export { register, buildSrt, estimateSeconds };
