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
      ];
      // 标题与强调条**跟着每一镜的版位换边**，所以在下面的 forEach 里按镜生成。
      // 这里不再放一份固定的 —— 固定那一份正是"一张图钉在全片同一个位置"的来源。
      const timeline = [];
      // 每镜的版位（2026-10-10 二次修正）
      //   上一版用 W 的百分比当宽、H 的百分比当高，算出宽扁长条还压字幕；
      //   改成"方形"之后，为了彻底不压字，又把四档的 xr 全设成 1 ——
      //   不压了，但版位钉死在右边，优势清单 #7「每镜换版位」等于没做。
      //   这一轮按"图换边、文案跟着换边"来做，既不压字又真轮换：
      //     图在右 → 标题左对齐；图在左 → 标题右对齐，强调条同步镜像。
      //   几何上互斥：图 S、文案最宽约 456，横版画布两边放得下。
      //   只用现有的 from/to/hold/anim，不新增任何机制。
      const narrow = w < h;                                 // 竖版画布窄，图文并排必须一起收
      const S = Math.round(Math.min(w, h) * (narrow ? 0.36 : 0.46));   // 方形边长（横版 497 / 竖版 389）
      const TITLE_SIZE = narrow ? 60 : 76;                  // 标题字号（竖版 6 字×60=360，与图 389 并排放得下）
      const M = Math.round(w * 0.055);                      // 边距
      const TITLE_X = 90;                                   // 文字盒基准（renderText 的盒宽 = w - x*2，左右对称内缩）
      const BAR_W = 120;
      const LAYOUTS = [
        { side: 'right', yr: 0.10 },   // 图右上，文案在左
        { side: 'left', yr: 0.16 },    // 图左中，文案在右
        { side: 'right', yr: 0.20 },   // 图右下一点，文案在左
        { side: 'left', yr: 0.08 },    // 图左上，文案在右
      ];
      laid.forEach((it, i) => {
        const from = Math.round(it.start * DEFAULT_FPS);
        const to = Math.round((it.start + it.duration) * DEFAULT_FPS);
        const id = `shot${i + 1}`;
        const lay = LAYOUTS[i % LAYOUTS.length];
        const mirrored = lay.side === 'left';   // 图在左 → 文案靠右
        if (it.shot) {
          const slot = `shot${i + 1}`;
          assets[slot] = it.shot;
          nodes.push({
            id, type: 'image',
            // 每个镜头自己的槽位 → 素材与"哪一句"一一对应（不再平均摊）
            props: { src: `user:${slot}`, fit: 'cover', radius: 32, width: S, height: S },
            transform: {
              x: mirrored ? M : Math.round(w - M - S),
              y: Math.round(h * lay.yr),
            },
          });
        }
        // 标题 + 强调条：每镜各一份，位置跟着图文分栏走（这一镜图在哪边，文案就去对面）
        const tId = `title${i + 1}`;
        const bId = `bar${i + 1}`;
        nodes.push({
          id: tId, type: 'text',
          props: { text: '{{title}}', font: 'source-han-sans', size: TITLE_SIZE, weight: 700, color: '#FFFFFF', align: mirrored ? 'right' : 'left', lineHeight: 1.25, maxLines: 2 },
          transform: { x: TITLE_X, y: 300 },
        });
        nodes.push({
          id: bId, type: 'shape',
          props: { shape: 'rect', fill: '#14A5B8', width: BAR_W, height: 8, radius: 4 },
          transform: { x: mirrored ? Math.round(w - TITLE_X - BAR_W) : TITLE_X, y: 560 },
        });
        if (to > from) {
          // 标题/强调条走整镜窗口：入场动画走完即定格，镜末随之离场（hold:false）。
          timeline.push({ nodeId: tId, from, to, hold: false, anim: { name: 'slide-up', params: { distance: 40 } } });
          timeline.push({ nodeId: bId, from, to, hold: false, anim: { name: 'wipe-in', params: { direction: mirrored ? 'right' : 'left' } } });
          timeline.push({
            nodeId: id, from, to, hold: false,   // 只在自己那段出现，之后消失（否则图片一张张叠上来）
            anim: it.shot ? { name: 'ken-burns', params: { fromScale: 1.06, toScale: 1.0 } } : undefined,
          });
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
