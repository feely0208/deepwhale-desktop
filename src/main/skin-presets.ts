/**
 * 内置背景预设 —— 纯 CSS 绘制，不需要图片文件。
 *
 * ── 来由（2026-09-29，用户的原话）────────────────────────────────
 *   「https://www.deepseek.com/harness/ 你看下官方这个网页背景，我很喜欢，
 *     能做成新版深鲸壳的默认背景吗？」
 *
 * ── 第一版为什么不像（用户看了实机截图后的反馈：「差距比较大，没官网的好看」）
 *
 * 把官方那页的 DOM 原样扒下来对照，第一版漏了四件事，每一件都是关键：
 *
 *   ① **没有模糊**。官方三层各自带 `filter: blur()`，而且是**不同的值**：
 *        blob1 blur(80px) / blob2 **blur(100px)** / blob3 **blur(60px)**
 *      第一版用的是不带 filter 的径向渐变 —— 那出来是"三个彩色圆盘"，
 *      而官方是"三团化开的光"。这是最大的差距。
 *
 *   ② **尺寸按百分比写**。官方是**固定像素**：500×500 / 700×400 / 400×400。
 *      写成百分比之后，壳的窗口越高，椭圆就被拉得越长越扁，
 *      于是光摊成一大片、颜色被摊淡。**必须用 px**。
 *
 *   ③ **没有 screen 混合**。官方的辉光容器是
 *      `mix-blend-mode: screen` —— 光是在底色上"加"上去的（越叠越亮），
 *      不是盖上去的。少了这个，辉光显得发闷、发脏。
 *
 *   ④ **底色不对**。官网的页面底色是 `#0a0a0a`（**中性**近黑），
 *      第一版用了 #0a0c11（偏蓝的近黑），蓝色底把本来就不亮的辉光又压了一层。
 *
 * 还有一点必须说清楚：官网上那团光是**首屏 hero 的光**，它天生是
 * "宽而矮的一块"（容器 top:80px、高 500px，外面还套着 max-height:720px 裁切）。
 * 壳的窗口是**高而窄**的，照搬位置必然不一样 —— 所以这里做成两种锚点：
 *   · bottom（默认）：光在窗口底部，像台灯打在桌面上，侧栏与内容区之间最自然
 *   · hero：照官方位置放在上方 80px 那一段，最大程度接近官网观感
 *
 * 官方原值（实测抓取，非估算）：
 *   blob1 500×500 左侧 10%、下 −100px  opacity .30  blur(80px)
 *         radial-gradient(circle, #1A3870 0%, transparent 70%)
 *   blob2 700×400 水平居中、下 −50px   opacity .40  blur(100px)
 *         radial-gradient(ellipse at center, #2D5F9E 0%, #1A3870 40%, transparent 70%)
 *   blob3 400×400 右侧 10%、下 −80px   opacity .20  blur(60px)
 *         radial-gradient(circle, #4A8AC4 0%, #2D5F9E 30%, transparent 70%)
 */

/** 深色底：官网的 --ds-color-bg-page（中性近黑，不偏蓝）。 */
export const PRESET_DARK_BASE = '#0a0a0a';
/** 浅色底 */
export const PRESET_LIGHT_BASE = '#f7f8fa';

/** 预设名 */
export type SkinPreset = 'none' | 'deepseek-blue';

/**
 * 三团光的几何（与官方逐项对齐：像素尺寸 + 锚点 + 透明度 + 模糊半径）。
 * `x` 用视口宽度表达（官方的 left:10% / right:10%），`bottom` 为官方负偏移。
 */
interface Blob {
  w: number;
  h: number;
  /** 左边缘（CSS 长度表达式，以视口宽为参照） */
  x: string;
  /** 底边相对视口底部的偏移（负值 = 露出到视口外） */
  bottom: number;
  opacity: number;
  blur: number;
  gradient: string;
}

const BLOBS: Blob[] = [
  {
    w: 500,
    h: 500,
    x: '10vw',
    bottom: -100,
    opacity: 0.3,
    blur: 80,
    gradient: 'radial-gradient(circle, #1A3870 0%, rgba(26,56,112,0) 70%)',
  },
  {
    w: 700,
    h: 400,
    x: 'calc(50vw - 350px)',
    bottom: -50,
    opacity: 0.4,
    blur: 100,
    gradient:
      'radial-gradient(ellipse at center, #2D5F9E 0%, #1A3870 40%, rgba(26,56,112,0) 70%)',
  },
  {
    w: 400,
    h: 400,
    x: 'calc(90vw - 400px)',
    bottom: -80,
    opacity: 0.2,
    blur: 60,
    gradient:
      'radial-gradient(circle, #4A8AC4 0%, #2D5F9E 30%, rgba(45,95,158,0) 70%)',
  },
];

/**
 * 每个光斑的**独立样式**（照抄官方：各自像素尺寸、各自 blur、各自 opacity）。
 *
 * 为什么要一个个建成真 DOM 元素，而不是塞进一个伪元素的 background-image：
 * `filter` 是**整体**作用于元素的，一个伪元素里放三层就只能共用一个模糊值，
 * 而官方三层是 **80 / 100 / 60**。第一版就是栽在这 —— 没有模糊，
 * 出来的是"三个彩色圆盘"，而官方是"三团化开的光"。
 */
export function blobElementStyles(anchor: 'bottom' | 'hero'): string[] {
  return BLOBS.map((b) => {
    // 官方那三团光锚在一个 top:80px、高 500px 的带子上（带子底边距视口底 = 100vh − 580px）。
    // hero 锚点照这个来；bottom 锚点直接锚在视口底边。
    const base = anchor === 'hero' ? `calc(100vh - 580px + ${b.bottom}px)` : `${b.bottom}px`;
    return [
      'position:absolute',
      `left:${b.x}`,
      `bottom:${base}`,
      `width:${b.w}px`,
      `height:${b.h}px`,
      `opacity:${b.opacity}`,
      `background:${b.gradient}`,
      `filter:blur(${b.blur}px)`,
    ].join(';');
  });
}

/** 光斑容器的样式（铺满视口、压在最底层、不挡点击）。 */
export function glowContainerStyle(): string {
  return [
    'position:fixed',
    'inset:0',
    'z-index:-1',
    'pointer-events:none',
    'overflow:hidden',
    `background:${PRESET_DARK_BASE}`,
    // 顶部渐隐：官方的光带上下都有 mask 渐隐，硬切会在窗口上沿留一条分界线
    '-webkit-mask-image:linear-gradient(to bottom,transparent 0%,#000 32%,#000 100%)',
    'mask-image:linear-gradient(to bottom,transparent 0%,#000 32%,#000 100%)',
  ].join(';');
}

/**
 * 预设名 → 注入用的 CSS（**只含底色与面板色**，光斑由 DOM 层负责）。
 * 返回 null 表示"没有这个预设/不需要注入"。
 *
 * 面板色沿用背景图那一套（深色面板不透明、基础底色透明）：
 * 辉光只在"没有面板盖住"的地方透出来，正文可读性不受影响。
 */
export function presetBackgroundCss(preset: string): string | null {
  if (preset !== 'deepseek-blue') return null;
  return `
      html { background-color: transparent !important; }
      body { background-color: transparent !important; }
      /* 深色：面板不透明、基础底色透明 —— 辉光只在空隙里透出来 */
      body[data-ds-dark-theme] {
        --dsw-alias-bg-base: transparent !important;
        --dsw-alias-bg-layer-1: #1c1f25 !important;
        --dsw-alias-bg-layer-2: #23272e !important;
        --dsw-alias-bg-overlay: #16191e !important;
        --dsw-specific-sidebar-fill: #16191e !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 255, 255, 0.08) !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 255, 255, 0.05) !important;
      }
      body[data-ds-dark-theme] [class*="sidebarCol"] {
        background: #14171c !important;
      }
      /* 浅色：底色换成近白，并把光斑整体压淡（screen 混合在白底上会糊成一片） */
      body:not([data-ds-dark-theme]) #dsh-skin-glow {
        background: ${PRESET_LIGHT_BASE} !important;
        opacity: 0.45 !important;
      }
      body:not([data-ds-dark-theme]) {
        --dsw-alias-bg-base: transparent !important;
        --dsw-alias-bg-layer-1: #ffffff !important;
        --dsw-alias-bg-layer-2: #f4f6f8 !important;
        --dsw-alias-bg-overlay: #ffffff !important;
        --dsw-specific-sidebar-fill: #f4f6f8 !important;
        --dsw-specific-sidebar-nav-item-active: rgba(0, 0, 0, 0.06) !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(0, 0, 0, 0.04) !important;
      }
      body:not([data-ds-dark-theme]) [class*="sidebarCol"] {
        background: linear-gradient(to right, rgba(247, 248, 250, 0.94), rgba(247, 248, 250, 0.18)) !important;
      }
    `;
}

/** 设置页预览用：把同一个预设渲染成一小块色板（纯 CSS 近似，仅供选颜色）。 */
export function presetPreviewStyle(preset: string): string | null {
  if (preset !== 'deepseek-blue') return null;
  const layers = BLOBS.map(
    (b) => `${b.gradient} ${b.x} calc(50% + ${b.bottom / 2}px) / ${b.w}px ${b.h}px no-repeat`,
  );
  return `background-color: ${PRESET_DARK_BASE}; background-image: ${layers.join(', ')};`;
}


/**
 * 生成"把光斑层建进页面"的 JS。
 *
 * 为什么是建 DOM 而不是只用 CSS：官方三层光的模糊半径**各不相同**（80/100/60），
 * 而 `filter` 是整体作用于一个元素的 —— 想精确复刻就必须一层一个元素。
 * 壳本来就在往页面注入 JS（settings-ext），这里沿用同一套做法。
 *
 * 幂等：已存在就原地更新样式，不重复插入（页面重载/主题切换会反复调用）。
 */
export function glowInjectionScript(anchor: 'bottom' | 'hero'): string {
  const styles = blobElementStyles(anchor);
  const container = glowContainerStyle();
  return `(() => {
  try {
    const ID = 'dsh-skin-glow';
    let box = document.getElementById(ID);
    if (!box) {
      box = document.createElement('div');
      box.id = ID;
      // 插到 body 最前面，尽量少影响既有布局
      document.body.insertBefore(box, document.body.firstChild);
    }
    box.setAttribute('style', ${JSON.stringify(container)});
    box.innerHTML = '';
    for (const s of ${JSON.stringify(styles)}) {
      const d = document.createElement('div');
      d.setAttribute('style', s);
      box.appendChild(d);
    }
    return true;
  } catch (e) { return false; }
})()`;
}

/** 移除光斑层（切到"纯色"或用户自己选了背景图时调用）。 */
export function glowRemovalScript(): string {
  return `(() => { const el = document.getElementById('dsh-skin-glow'); if (el) el.remove(); return true; })()`;
}
