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
/**
 * 三层辉光：**可动画**的纯 CSS 实现。
 *
 * ── 为什么长这样（两个约束叠在一起）─────────────────────────────
 * ① 不能再用"插 DOM + z-index:-1"（2026-10-01：升级到 1.0.28 后静默失效，
 *    用户只看到"背景变灰、蓝光没了"）。所以必须挂在 html 的 background 上。
 * ② 用户要求"像官方那样会动"。
 *
 * 而**渐变里写死 `at X Y` 是动不了的** —— CSS 没法直接动画渐变的几何。
 * 所以改成：每个光斑做成一个**固定尺寸的图层**，光斑居中在图层里，
 * 再用 `background-position` 把图层摆到位 —— 而 `background-position` 是
 * 可以正常用 @keyframes 动画的属性（不需要 @property，兼容性更好）。
 *
 * 图层尺寸 = 光斑尺寸 + 2×模糊半径（用大半径的径向渐变近似 filter:blur）。
 * 位置 = 目标中心 − 图层尺寸/2：
 *   L1 660×660  中心(10vw+250, 100vh−150) → 左上(10vw−80,  100vh−480)
 *   L2 900×600  中心(50vw,     100vh−150) → 左上(50vw−450, 100vh−450)
 *   L3 520×520  中心(90vw−200, 100vh−120) → 左上(90vw−460, 100vh−380)
 */
/**
 * 光斑图层与位置 —— **严格按官网 geometry 反推**（2026-10-01 从 deepseek.com 扒到的原样）：
 *
 *   官网容器：`absolute top-[80px] left-0 w-full h-[500px]`
 *   三个光斑各自 `bottom:-100 / -50 / -80`，即底边落在带子底边(80+500=580)之下
 *   → 光心：
 *        L1 500×500 bottom:-100 → 底边680、高500 → 中心 y = 430
 *        L2 700×400 bottom:-50  → 底边630、高400 → 中心 y = 430
 *        L3 400×400 bottom:-80  → 底边660、高400 → 中心 y = 460
 *     x：L1 = 10vw+250 ／ L2 = 50vw ／ L3 = 90vw−200
 *
 * ⚠️ 我中途按旧壳代码把光挪到过"窗口下方"，那是**错的** —— 官网就在上方这个位置。
 *
 * 图层尺寸 = 光斑尺寸 + 2×模糊半径（用多档渐隐近似 filter:blur）：
 *   L1 500+2×80=660   L2 700+2×100=900×600   L3 400+2×60=520
 */
const GLOW_LAYER_SIZE: string[] = ['660px 660px', '900px 600px', '520px 520px'];

const GLOW_POS_BASE: string[] = [
  'calc(10vw - 80px) 430px',
  'calc(50vw - 450px) 430px',
  'calc(90vw - 460px) 460px',
];

/** 漂移终点：三层各走各的、幅度很小 —— 官网那种"在动但不明显"的调子。 */
const GLOW_POS_DRIFT: string[] = [
  'calc(10vw - 44px) 414px',
  'calc(50vw - 512px) 444px',
  'calc(90vw - 424px) 448px',
];

function glowGradientCss(scale: number): string {
  const a = (v: number) => (v * scale).toFixed(3);
  // ★ 必须写 `closest-side`：
  //   径向渐变默认半径是"到**最远角**"（660×660 图层里 = 467px），
  //   比图层半宽（330px）大 —— 于是渐变在图层边缘**还没淡到 0** 就被 background-size
  //   硬切一刀，屏幕上就是一个个方块边（用户 2026-10-01 直接指出"看起来是色块"）。
  //   改成 closest-side：半径正好等于到最近边的距离，渐隐刚好在边界归零，边缘干净。
  //   中间补一档 stop，让衰减更接近原版的 filter:blur()（纯线性淡出会显得扁）。
  return [
    `radial-gradient(circle closest-side at center, rgba(26,56,112,${a(0.3)}) 0%, rgba(26,56,112,${a(0.24)}) 25%, rgba(26,56,112,${a(0.13)}) 50%, rgba(26,56,112,${a(0.05)}) 75%, rgba(26,56,112,0) 100%)`,
    `radial-gradient(ellipse closest-side at center, rgba(45,95,158,${a(0.4)}) 0%, rgba(38,74,140,${a(0.33)}) 25%, rgba(26,56,112,${a(0.19)}) 50%, rgba(26,56,112,${a(0.07)}) 75%, rgba(26,56,112,0) 100%)`,
    `radial-gradient(circle closest-side at center, rgba(74,138,196,${a(0.2)}) 0%, rgba(60,116,176,${a(0.15)}) 25%, rgba(45,95,158,${a(0.08)}) 50%, rgba(45,95,158,${a(0.03)}) 75%, rgba(45,95,158,0) 100%)`,
  ].join(', ');
}

/** 生成 `html` 上那整段"底色 + 三层可动辉光 + 动画"。scale 用于浅色模式压淡。 */
export function glowBackgroundCss(scale: number, base: string): string {
  return `
      background-color: ${base} !important;
      background-image: ${glowGradientCss(scale)} !important;
      background-size: ${GLOW_LAYER_SIZE.join(', ')} !important;
      background-repeat: no-repeat !important;
      background-position: ${GLOW_POS_BASE.join(', ')} !important;
      background-attachment: fixed !important;
      animation: dsh-skin-drift 26s ease-in-out infinite alternate !important;`;
}

/** 漂移关键帧。放在预设 CSS 里一起注入（只注入一次，靠 animation-name 去重）。 */
export const GLOW_KEYFRAMES = `
      @keyframes dsh-skin-drift {
        from { background-position: ${GLOW_POS_BASE.join(', ')}; }
        to   { background-position: ${GLOW_POS_DRIFT.join(', ')}; }
      }
      @media (prefers-reduced-motion: reduce) {
        html { animation: none !important; }
      }`;

export function presetBackgroundCss(preset: string): string | null {
  if (preset !== 'deepseek-blue') return null;
  return `${GLOW_KEYFRAMES}
      /* ★ 辉光挂在 html 上：根元素背景 = 画布背景，天然在最底层，不受界面改版影响 */
      html {${glowBackgroundCss(1, PRESET_DARK_BASE)}
      }
      body { background-color: transparent !important; }
      /* 深色：面板不透明、基础底色透明 —— 辉光只在空隙里透出来 */
      body[data-ds-dark-theme] {
        --dsw-alias-bg-base: transparent !important;
        /* ★ 面板改成半透明 —— 这是让辉光"透上来"的关键。
           官网的辉光铺在空旷 hero 区上所以好看；桌面端正文面板如果不透明，
           就把光整块盖死了（用户 2026-10-01 看到"一片灰"就是这个原因）。
           做成 rgba 之后，光从面板底下透出来，接近官网那种"雾"的感觉。
           透明度取值原则：**正文可读性优先** —— 0.70 左右是实测能兼顾的档位。 */
        --dsw-alias-bg-layer-1: rgba(24, 28, 34, 0.70) !important;
        --dsw-alias-bg-layer-2: rgba(32, 37, 44, 0.74) !important;
        --dsw-alias-bg-overlay: rgba(18, 21, 26, 0.80) !important;
        --dsw-specific-sidebar-fill: rgba(16, 19, 24, 0.62) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 255, 255, 0.08) !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 255, 255, 0.05) !important;
      }
      body[data-ds-dark-theme] [class*="sidebarCol"] {
        background: rgba(14, 17, 22, 0.58) !important;
      }
      /* 面板加一点毛玻璃，半透明才不会"脏"（Electron/Chromium 支持） */
      body[data-ds-dark-theme] [class*="sidebarCol"],
      body[data-ds-dark-theme] [class*="panel"],
      body[data-ds-dark-theme] [class*="Card"] {
        backdrop-filter: blur(16px) saturate(1.15);
        -webkit-backdrop-filter: blur(16px) saturate(1.15);
      }
      /* 浅色：底色换成近白，并把光斑整体压淡（screen 混合在白底上会糊成一片） */
      /* 浅色：近白底 + 辉光压淡（白底上原强度会糊成一片） */
      html:has(body:not([data-ds-dark-theme])) {${glowBackgroundCss(0.45, PRESET_LIGHT_BASE)}
      }
      body:not([data-ds-dark-theme]) { background-color: transparent !important; }
      body:not([data-ds-dark-theme]) {
        --dsw-alias-bg-base: transparent !important;
        /* 浅色同样半透明，否则白底面板会把辉光完全挡住 */
        --dsw-alias-bg-layer-1: rgba(255, 255, 255, 0.72) !important;
        --dsw-alias-bg-layer-2: rgba(244, 246, 248, 0.76) !important;
        --dsw-alias-bg-overlay: rgba(255, 255, 255, 0.82) !important;
        --dsw-specific-sidebar-fill: rgba(244, 246, 248, 0.62) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(0, 0, 0, 0.06) !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(0, 0, 0, 0.04) !important;
      }
      body:not([data-ds-dark-theme]) [class*="sidebarCol"] {
        background: linear-gradient(to right, rgba(247, 248, 250, 0.66), rgba(247, 248, 250, 0.16)) !important;
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
