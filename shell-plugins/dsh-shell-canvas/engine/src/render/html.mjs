/**
 * 文档 → HTML：白名单节点的 2D 渲染器。
 *
 * 设计要点（确定性优先）：
 *   1. 动画**不依赖时间**：页面上没有任何 CSS transition/animation，全部由 setFrame(f) 计算；
 *   2. 所有插值都是 f 的纯函数（无随机、无 Date.now）；
 *   3. 渲染前等字体与图片就绪，避免"第一帧字体还没到"这种不确定。
 */

import { fontStack, FONT_STACKS, FONT_PROBE_SCRIPT } from './fonts.mjs';
import { parseSrt } from '../text/srt.mjs';

const EASINGS = {
  linear: (p) => p,
  'ease-out': (p) => 1 - Math.pow(1 - p, 3),
  'ease-in-out': (p) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2),
  spring: (p) => 1 - Math.exp(-6 * p) * Math.cos(10 * p), // 确定性阻尼
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function px(v) {
  return `${Number(v)}px`;
}

function layerStyle(node, width, height) {
  const t = node.transform || {};
  const base = [
    'position:absolute',
    `left:${px(t.x || 0)}`,
    `top:${px(t.y || 0)}`,
    'transform-origin:center center',
    'will-change:transform,opacity',
  ];
  return base.join(';');
}

/** 文本层：按语义宽度换行；行高/字距/描边都来自白名单 props */
function renderText(node, width) {
  const p = node.props;
  const size = p.size;
  const align = p.align || 'left';
  const boxW = width - ((node.transform?.x || 0) * 2);
  const style = [
    layerStyle(node, width),
    `width:${px(boxW)}`,
    `font-family:${fontStack(p.font)}`,
    `font-size:${px(size)}`,
    `font-weight:${p.weight || 400}`,
    `color:${p.color || '#FFFFFF'}`,
    `text-align:${align}`,
    `line-height:${p.lineHeight || 1.3}`,
    'white-space:pre-wrap',
    'word-break:break-word',
    p.letterSpacing ? `letter-spacing:${px(p.letterSpacing)}` : '',
    p.outline ? `-webkit-text-stroke:${px(p.outline)} rgba(0,0,0,.6)` : '',
    p.shadow ? 'text-shadow:0 4px 16px rgba(0,0,0,.45)' : '',
  ].filter(Boolean).join(';');
  return `<div id="layer-${esc(node.id)}" data-node="${esc(node.id)}" style="${style}">${esc(p.text)}</div>`;
}

function renderImage(node, slots) {
  const p = node.props;
  const t = node.transform || {};
  const w = p.width || 900;
  const h = p.height || 900;
  const style = [
    layerStyle(node),
    `width:${px(w)}`,
    `height:${px(h)}`,
    `border-radius:${px(p.radius || 0)}`,
    `opacity:${p.opacity ?? 1}`,
    p.blur ? `filter:blur(${px(p.blur)})` : '',
    'overflow:hidden',
    'background:#0E2233',
  ].filter(Boolean).join(';');

  const slotName = String(p.src).startsWith('user:') ? String(p.src).slice(5) : null;
  const dataUrl = slotName ? slots[slotName] : null;

  if (dataUrl) {
    const arr = Array.isArray(dataUrl) ? dataUrl : [dataUrl];
    const first = arr[0];
    const isVideo = /^data:video\//.test(String(first));
    // 多素材（2026-10-09）：一个槽位可以给多张图、或一个视频素材
    //   · 多张图 → 全部铺上，按时间轮播（切 display，在 setFrame 里做）
    //   · 视频   → <video muted>，逐帧 seek（画面才是"动"的）
    //   单图仍走最简单那条，不引入多余节点。
    if (arr.length > 1 || isVideo) {
      const inner = isVideo
        ? `<video src="${first}" muted playsinline style="width:100%;height:100%;object-fit:${p.fit || 'cover'};display:block"></video>`
        : arr.map((u, k) => `<img src="${u}" style="width:100%;height:100%;object-fit:${p.fit || 'cover'};display:${k === 0 ? 'block' : 'none'}">`).join('');
      return `<div id="layer-${esc(node.id)}" data-node="${esc(node.id)}" data-shots="1" style="${style}">${inner}</div>`;
    }
    return `<div id="layer-${esc(node.id)}" data-node="${esc(node.id)}" style="${style}"><img src="${first}" style="width:100%;height:100%;object-fit:${p.fit || 'cover'};display:block"></div>`;
  }
  // 没有素材时给一个确定性占位（而不是空白，避免"看起来渲成功了其实没内容"）
  return `<div id="layer-${esc(node.id)}" data-node="${esc(node.id)}" style="${style};display:flex;align-items:center;justify-content:center;color:#3E6B85;font-size:28px;font-family:${fontStack('source-han-sans')}">素材槽位：${esc(slotName || p.src)}</div>`;
}

/**
 * 字幕层：把 SRT 的每一条**预先渲成 HTML**（含关键词高亮），
 * 运行时只按帧号挑一条贴上去——不在页面里做任何解析，保证确定性与速度。
 */
function renderSubtitle(node, ctx) {
  const p = node.props;
  const srtText = ctx.vars[p.srtVar];
  if (!srtText) return `<div id="layer-${esc(node.id)}" data-node="${esc(node.id)}" data-subtitle="${esc(node.srtVar)}" style="position:absolute;left:0;right:0;bottom:0;color:#F66;font-family:${fontStack(p.font)};font-size:24px;text-align:center">字幕变量 ${esc(p.srtVar)} 为空</div>`;

  let cues = [];
  try { cues = parseSrt(srtText); } catch (e) { cues = []; }

  const keywords = (p.keywords || []).map((k) => esc(k));
  const cueHtml = cues.map((c) => {
    let html = esc(c.lines.join('\n'));
    for (const kw of keywords) html = html.split(kw).join(`<em class="kw">${kw}</em>`);
    return html;
  });

  const anchor = p.anchor || 'bottom';
  const pos = anchor === 'bottom' ? `bottom:${px(p.safeBottom ?? 320)}` : anchor === 'top' ? `top:${px(p.safeBottom ?? 160)}` : 'top:50%;transform:translateY(-50%)';
  const style = [
    'position:absolute', 'left:6%', 'right:6%', pos,
    `font-family:${fontStack(p.font)}`,
    `font-size:${px(p.size)}`,
    `color:${p.color || '#FFFFFF'}`,
    `text-align:${p.align || 'center'}`,
    `line-height:${p.lineHeight || 1.35}`,
    'white-space:pre-wrap',
    p.outline ? `-webkit-text-stroke:${px(p.outline)} rgba(0,0,0,.65)` : '',
    p.shadow ? 'text-shadow:0 3px 12px rgba(0,0,0,.6)' : '',
    'pointer-events:none',
  ].filter(Boolean).join(';');

  ctx.subtitles.push({
    nodeId: node.id,
    cueHtml,
    ranges: cues.map((c) => [Math.round((c.startMs / 1000) * (ctx.fps || 30)), Math.round((c.endMs / 1000) * (ctx.fps || 30))]),
    highlightColor: p.highlightColor || '#14A5B8',
  });

  return `<div id="layer-${esc(node.id)}" data-node="${esc(node.id)}" style="${style}"></div>`;
}

function renderShape(node, ctx) {
  const p = node.props;
  const FULL_W = ctx.width;
  const FULL_H = ctx.height;
  const style = [layerStyle(node), `opacity:${p.opacity ?? 1}`];
  if (p.shape === 'circle') {
    const d = p.width || 200;
    style.push(`width:${px(d)}`, `height:${px(d)}`, 'border-radius:50%');
  } else if (p.shape === 'line') {
    style.push(`width:${px(p.width || 600)}`, `height:${px(p.strokeWidth || 2)}`);
  } else {
    // 矩形不给尺寸 = 铺满画布（"背景板"的常见用法）
    style.push(`width:${px(p.width || FULL_W)}`, `height:${px(p.height || FULL_H)}`, `border-radius:${px(p.radius || 0)}`);
  }
  style.push(`background:${p.fill && p.fill !== 'none' ? p.fill : 'transparent'}`);
  if (p.stroke && p.stroke !== 'none') style.push(`border:${px(p.strokeWidth || 2)} solid ${p.stroke}`);
  return `<div id="layer-${esc(node.id)}" data-node="${esc(node.id)}" style="${style.join(';')}"></div>`;
}

function renderNode(node, ctx) {
  if (node.visible === false) return '';
  switch (node.type) {
    case 'text': return renderText(node, ctx.width);
    case 'image': return renderImage(node, ctx.slots);
    case 'shape': return renderShape(node, ctx);
    case 'subtitle': return renderSubtitle(node, ctx);
    default: return '';
  }
}

const IN_PAGE_SCRIPT = `
${FONT_PROBE_SCRIPT}
function ease(name, p) {
  switch (name) {
    case 'linear': return p;
    case 'ease-in-out': return p < 0.5 ? 4*p*p*p : 1 - Math.pow(-2*p+2,3)/2;
    case 'spring': return 1 - Math.exp(-6*p)*Math.cos(10*p);
    case 'ease-out':
    default: return 1 - Math.pow(1-p,3);
  }
}
function setFrame(f) {
  const timeline = window.__canvasDoc.timeline || [];
  const inTimeline = new Set(timeline.map(t => t.nodeId));
  document.querySelectorAll('[data-node]').forEach(el => {
    if (!inTimeline.has(el.dataset.node)) return;
    el.style.visibility = 'hidden';
    el.style.opacity = '0';
    el.style.transform = 'none';
  });
  for (const item of timeline) {
    const el = document.getElementById('layer-' + item.nodeId);
    if (!el) continue;
    // 语义（2026-10-07 修正）：
    //   f < from            → 还没入场，隐藏
    //   from <= f <= to     → 按进度播动画
    //   f > to              → hold（默认 true）保持动画终态；hold:false 才消失
    const hold = item.hold !== false;
    if (f < item.from) { el.style.visibility = 'hidden'; el.style.opacity = '0'; continue; }
    if (f > item.to && !hold) { el.style.visibility = 'hidden'; el.style.opacity = '0'; continue; }
    const span = Math.max(1, item.to - item.from);
    const p = f > item.to ? 1 : Math.min(1, Math.max(0, (f - item.from) / span));
    let x = 0, y = 0, scale = 1, scaleX = 1, opacity = 1, blur = 0, wipe = null;
    const anim = item.anim;
    if (anim) {
      const q = anim.params || {};
      const e = ease(q.easing || 'ease-out', p);
      const name = anim.name;
      /* ── 动效集（2026-10-08 从 2 个扩到 11 个）─────────────────────
         为什么要扩：引擎原本只有 slide-up 和 ken-burns。模板能做成什么样，
         完全取决于这里有什么 —— 这是"离 Remotion 差在哪"的根子。
         每个动效都是"进度 p(0..1) → 变换量"的纯函数，逐帧算，天然确定性。 */
      if (name === 'slide-up' || name === 'slide-down' || name === 'slide-left' || name === 'slide-right') {
        const d = q.distance ?? 60;
        const k = (1 - e) * d;
        if (name === 'slide-up') y = k;
        else if (name === 'slide-down') y = -k;
        else if (name === 'slide-left') x = k;
        else x = -k;
        opacity = Math.min(1, p * 4);
      } else if (name === 'fade-in') {
        opacity = e;
      } else if (name === 'scale-in') {
        const s0 = q.fromScale ?? 0.86;
        scale = s0 + (1 - s0) * e;
        opacity = Math.min(1, p * 3.5);
      } else if (name === 'blur-in') {
        blur = (1 - e) * (q.blur ?? 14);
        opacity = e;
      } else if (name === 'wipe-in') {
        // 按方向揭示（clip-path）：适合条带、强调线、图片入场
        // ⚠️ 这里在注入页面的 JS 字符串里，**不能用反引号**（会截断外层字符串，踩过）
        const d = q.direction ?? 'left';
        const rem = (100 - e * 100).toFixed(2);
        wipe = d === 'up' ? 'inset(' + rem + '% 0 0 0)'
          : d === 'down' ? 'inset(0 0 ' + rem + '% 0)'
            : d === 'right' ? 'inset(0 0 0 ' + rem + '%)'
              : 'inset(0 ' + rem + '% 0 0)';
      } else if (name === 'grow-x') {
        // 强调线从左长出（transform-origin 由 build 期设为 left center）
        scaleX = e;
      } else if (name === 'float') {
        // 环境元素缓慢浮动（循环，与入场解耦）：给画面"活着"的感觉
        y = Math.sin(p * Math.PI * 2 * (q.turns ?? 1)) * (q.distance ?? 14);
        x = Math.cos(p * Math.PI * 2 * (q.turns ?? 1)) * (q.distanceX ?? 0);
      } else if (name === 'pulse') {
        scale = 1 + Math.sin(p * Math.PI * 2 * (q.turns ?? 1)) * (q.amount ?? 0.04);
      } else if (name === 'ken-burns') {
        const s0 = q.fromScale ?? 1, s1 = q.toScale ?? 1;
        scale = s0 + (s1 - s0) * p;
        x = (q.panX ?? 0) * p;
        y = (q.panY ?? 0) * p;
      }
    }
    el.style.visibility = 'visible';
    el.style.transform = scaleX === 1
      ? 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ')'
      : 'translate(' + x + 'px,' + y + 'px) scale(' + scale + ') scaleX(' + scaleX + ')';
    el.style.opacity = String(opacity);
    if (el.style.filter || blur) el.style.filter = blur ? 'blur(' + blur.toFixed(2) + 'px)' : '';
    if (el.style.clipPath || wipe) el.style.clipPath = wipe || '';
  }
  // 字幕：按帧号挑当前条（内容在构建期就算好了，这里只是贴 HTML）
  for (const sub of window.__canvasSubtitles) {
    const el = document.getElementById('layer-' + sub.nodeId);
    if (!el) continue;
    let html = '';
    for (let i = 0; i < sub.ranges.length; i++) {
      const r = sub.ranges[i];
      if (f >= r[0] && f < r[1]) { html = sub.cueHtml[i]; break; }
    }
    if (el.__html !== html) { el.innerHTML = html; el.__html = html; }
  }
  // ── 多素材：同槽位多张图轮播 / 视频素材逐帧 seek（2026-10-09）──────────
  //   用户原话：「素材上传只能传一张？那就没得搞了」「视频最好能是动态的，图片静态是对的」
  //   轮播用节点自己的时间线区间切分；视频用 seek 把画面停在对应时刻。
  //   ⚠️ seek 是异步的：这里返回 Promise，适配器会 await 它 ——
  //      否则截到的是上一帧（那种"每帧慢一拍"的错最难查）。
  const __doc = window.__canvasDoc || {};
  const __fps = (__doc.canvas && __doc.canvas.fps) || 30;
  const __span = new Map((__doc.timeline || []).map((t) => [t.nodeId, t]));
  let __seeking = null;
  document.querySelectorAll('[data-shots]').forEach((el) => {
    const t = __span.get(el.dataset.node) || { from: 0, to: (__doc.canvas && __doc.canvas.frames) || 300 };
    const total = Math.max(1, t.to - t.from);
    const pr = Math.min(1, Math.max(0, (f - t.from) / total));
    const imgs = el.querySelectorAll('img');
    if (imgs.length > 1) {
      const want = Math.min(imgs.length - 1, Math.floor(pr * imgs.length));
      imgs.forEach((im, k) => { im.style.display = k === want ? 'block' : 'none'; });
    }
    const v = el.querySelector('video');
    if (v) {
      const dur = v.duration || 0;
      const target = dur ? Math.min(Math.max(0, dur - 0.001), (f - t.from) / __fps) : 0;
      if (Math.abs((v.currentTime || 0) - target) > 0.02) {
        __seeking = new Promise((res) => {
          const done = () => { try { v.removeEventListener('seeked', done); } catch (e) {} res(true); };
          try { v.addEventListener('seeked', done); } catch (e) { res(true); }
          setTimeout(done, 300);          // 兜底：解码慢/极短素材时别挂死
          try { v.currentTime = target; } catch (e) { done(); }
        });
      }
    }
  });
  window.__canvasFrame = f;
  return __seeking;
}
window.__canvas = {
  setFrame,
  fonts: window.__canvasFontStacks,
  warnings: [],
  ready: (async () => {
    if (document.fonts && document.fonts.ready) { try { await document.fonts.ready; } catch (e) {} }
    const imgs = Array.from(document.images);
    await Promise.all(imgs.map(img => img.decode ? img.decode().catch(() => {}) : Promise.resolve()));
    try {
      const missing = window.__canvasProbeFonts(Object.keys(window.__canvasFontStacks));
      for (const id of missing) window.__canvas.warnings.push('字体可能未安装，已回退到同族系统字体: ' + id);
    } catch (e) {}
    setFrame(0);
  })(),
};
`;

export function buildHtml({ doc, width, height, slots = {}, scale = 1 }) {
  const ctx = { width, height, slots, subtitles: [], vars: doc.__vars || {}, fps: doc.canvas.fps || 30 };
  const layers = (doc.nodes || []).map((n) => renderNode(n, ctx)).join('\n');

  const fontIds = [...new Set(collectFontIds(doc))];
  const subtitleData = JSON.stringify(ctx.subtitles);
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { margin:0; padding:0; box-sizing:border-box; transition:none !important; animation:none !important; }
  html,body { background:transparent; }
  .kw { font-style:normal; color:var(--kw); }
  #stage {
    position:relative; overflow:hidden;
    width:${width}px; height:${height}px;
    background:${doc.canvas.background || '#000'};
    transform:scale(${scale}); transform-origin:top left;
  }
</style></head>
<body>
<div id="stage" style="--kw:${ctx.subtitles[0]?.highlightColor || '#14A5B8'}">${layers}</div>
<script>
window.__canvasFontStacks = ${JSON.stringify(Object.fromEntries(fontIds.map((id) => [id, fontStack(id)])))};
window.__canvasDoc = ${JSON.stringify({ timeline: doc.timeline || [] })};
window.__canvasSubtitles = ${subtitleData};
${IN_PAGE_SCRIPT}
</script>
</body></html>`;
  return { html, fontIds };
}

function collectFontIds(doc) {
  const ids = [];
  const visit = (nodes) => {
    for (const n of nodes || []) {
      if (n.props && typeof n.props.font === 'string') ids.push(n.props.font);
      if (n.children) visit(n.children);
    }
  };
  visit(doc.nodes);
  return ids;
}
