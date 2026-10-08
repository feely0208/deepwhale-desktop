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
// ⚠️ 2026-10-01 从 #0a0a0a（中性纯黑）改成带蓝的深黑：
//    浅色的底色 #eaf1fb 本身就是"带蓝的"，所以整屏看着明朗；
//    深色用中性黑时，颜色**全靠辉光提供**，而辉光又被面板压掉大半 —— 结果就是一片死黑。
//    带蓝的底色让深色也自带"深蓝"基调，辉光只负责亮度层次。
export const PRESET_DARK_BASE = '#0b1018';
/** 浅色底 */
export const PRESET_LIGHT_BASE = '#eaf1fb';   // 浅色底色本身带蓝 —— 官方浅色就是这样，不是白底加蓝光

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

function glowGradientCss(mode: 'dark' | 'light'): string {
  // 深色＝深蓝；浅色＝**淡蓝**（不是把深色压低透明度 —— 那样白底上会发灰发脏）。
  const D = mode === 'dark';
  // ⚠️ 深色的不透明度 2026-10-01 上调过：原来 [0.38,0.46,0.26] 配 #1A3870 这类暗蓝，
  //    在 #0a0a0a 底上峰值只有 (19,34,56)/255 —— 用户直接说「深色的辉光给你搞没了」。
  //    色相仍用官网那三个（#1A3870 / #2D5F9E / #4A8AC4），只把强度提上来。
  // 深色的三个色相仍是官网那三个（#1A3870 / #2D5F9E / #4A8AC4）提亮而来 ——
  // 官网那套是配 `mix-blend-mode: screen` + blur 用的，纯渐变不复现 screen，
  // 用原值就会"在近黑底上几乎看不见"（实测峰值只有 (19,34,56)）。
  const rgb = D
    ? ['46,92,168', '82,146,214', '124,186,240']
    : ['160,197,241', '132,178,234', '190,218,248'];
  const a = D ? [0.90, 1.0, 0.80] : [0.9, 0.95, 0.8];
  return rgb
    .map((c, i) => {
      const o = a[i];
      return `radial-gradient(circle closest-side at center, rgba(${c},${o.toFixed(3)}) 0%, rgba(${c},${(o * 0.8).toFixed(3)}) 25%, rgba(${c},${(o * 0.48).toFixed(3)}) 50%, rgba(${c},${(o * 0.19).toFixed(3)}) 75%, rgba(${c},0) 100%)`;
    })
    .join(', ');
}

export function glowBackgroundCss(mode: 'dark' | 'light'): string {
  const base = mode === 'dark' ? PRESET_DARK_BASE : PRESET_LIGHT_BASE;
  return `
      background-color: ${base} !important;
      background-image: ${glowGradientCss(mode)} !important;
      background-size: ${GLOW_LAYER_SIZE.join(', ')} !important;
      background-repeat: no-repeat !important;
      background-position: ${GLOW_POS_BASE.join(', ')} !important;
      background-attachment: fixed !important;
      animation: dsh-skin-drift 26s ease-in-out infinite alternate !important;`;
}

export const GLOW_KEYFRAMES = `
      @keyframes dsh-skin-drift {
        from { background-position: ${GLOW_POS_BASE.join(', ')}; }
        to   { background-position: ${GLOW_POS_DRIFT.join(', ')}; }
      }
      @media (prefers-reduced-motion: reduce) {
        body { animation: none !important; }
      }`;

export function presetBackgroundCss(preset: string): string | null {
  if (preset !== 'deepseek-blue') return null;
  return `${GLOW_KEYFRAMES}
      /* ══ 深浅色到底该认哪个信号（2026-10-01 实测更正）══════════════════

         以前这里用的是 @media (prefers-color-scheme: dark/light)。
         **那是错的**，而且错得很隐蔽 —— 它和 DSH 界面的深浅是**两套互不相干的开关**：

           · preferds-color-scheme  ← 由**壳**的 nativeTheme.themeSource 决定
                                      （壳设置里的「原生界面主题」）
           · body[data-ds-dark-theme] ← 由 **DSH 自己**的主题偏好决定
                                      （profile patch 里 ui-theme 的 preference）

         DSH 源码里写得很清楚（dsh-client-ui-layout/lib/client.js）：
             const DARK_ATTRIBUTE = "data-ds-dark-theme";        // 挂在 body 上
             const THEME_SOURCE_ATTRIBUTE = "data-ds-theme-source";
         而 DSH 自己的样式表**全部**用 body[data-ds-dark-theme] 选深浅。

         两个开关不一致时，就会出现"文字按深色渲染、背景按浅色铺"——
         实测本机就是这个状态：DSH 的 preference = light（页面 boot 里写着），
         而壳的 theme = system，OS 深色时 prefers-color-scheme = dark，
         于是皮肤铺了深色背景，字却是深色 → **被洗白，什么都看不清**。

         结论：皮肤装饰的是 DSH 界面，就必须**认 DSH 的信号**。
         这里只用 body[data-ds-dark-theme]，不依赖 :has()，也不需要脚本。 */

      /* html 不留背景：html 无背景时 body 的背景会传播到画布，效果与挂在 html 上一致，
         而且这样能直接用 body[data-ds-dark-theme] 选深浅。 */
      html { background-color: transparent !important; background-image: none !important; }

      /* ── 浅色（body 上没有那个属性时走这里）── */
      body {${glowBackgroundCss('light')}
        --dsw-alias-bg-base: transparent !important;
        /* 面板偏实：设置页/浮层底下压着会话正文，太透就会两种字叠在一起
           （用户 2026-10-01「设置里面看有点透底」）。
           注意：**不要用 backdrop-filter 治透底** —— 选择器一旦匹配到根容器
           会把整个界面糊成一片（已踩过，见交接文档第四节第 5 条）。 */
        --dsw-alias-bg-layer-1: rgba(255, 255, 255, 0.95) !important;
        --dsw-alias-bg-layer-2: rgba(247, 249, 252, 0.97) !important;
        --dsw-alias-bg-overlay: rgba(255, 255, 255, 0.98) !important;
        --dsw-specific-sidebar-fill: rgba(246, 249, 253, 0.38) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(0, 0, 0, 0.06) !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(0, 0, 0, 0.04) !important;
      }
      [class*="sidebarCol"] { background: rgba(247, 248, 250, 0.40) !important; }

      /* ⚠️ 铺满视口的浮层必须**不透明**（2026-10-08 修）。
         病根：DSH 的账号/设置全屏层拿 var(--dsw-alias-bg-base) 当底色 ——
             「.<hash>_overlay{background:var(--dsw-alias-bg-base);position:fixed;inset:0}」
             （实测来自 dsh-client-ui-settings-account），
             而上面为了"让辉光透出来"把这个 token 设成了 transparent / 半透明 →
             全屏时底下的会话正文**整片透上来**，就是用户反复报的那句
             「全屏时一整片怪白页、会话文字透上来」。
         为什么只覆盖浮层子树、**不动 token 本身**：框架层（壁纸/辉光那一层）**不在**任何
             「*_overlay」子树里，所以主界面观感**按构造零变化** —— 这正是用户
             「修这个不能影响主界面白屏」的要求；改 token 本身会把框架层也做实、辉光就没了。
         核对过：全树只有「.<hash>_overlay」一条规则拿该 token 当背景；
             「VOzbGW_overlay」（设置弹窗遮罩）自身没有背景，只会让它的**子面板**变实
             —— 那恰好是用户 2026-10-01 提过的方向（「设置里面看有点透底」）。 */
      [class*="_overlay"], [class*="_Overlay"] { --dsw-alias-bg-base: #ffffff !important; }

      /* ── 深色 ── */
      body[data-ds-dark-theme] {${glowBackgroundCss('dark')}
        /* 正文底半实：辉光透一点、文字压得住（全透会让辉光糊到文字上） */
        /* 正文底：原来 0.62 把辉光压掉六成 → 深色看着就是一片黑。
           降到 0.42：辉光透得上来，而正文是近白字，在深蓝上对比仍然充足。 */
        --dsw-alias-bg-base: rgba(11, 16, 24, 0.42) !important;
        /* 面板/浮层比正文实：设置页盖在会话上，透底就是从这里来的 */
        --dsw-alias-bg-layer-1: rgba(23, 26, 32, 0.96) !important;
        --dsw-alias-bg-layer-2: rgba(32, 36, 43, 0.97) !important;
        --dsw-alias-bg-overlay: rgba(18, 21, 26, 0.98) !important;
        --dsw-specific-sidebar-fill: rgba(16, 19, 24, 0.80) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 255, 255, 0.08) !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 255, 255, 0.05) !important;
      }
      body[data-ds-dark-theme] [class*="sidebarCol"] { background: rgba(14, 17, 22, 0.78) !important; }
      /* 深色下同理：铺满视口的浮层用**实底色**（取值与本预设正文底同色 rgb(11,16,24)），
         这样全屏时不会透出底下的会话文字。见上面浅色那段的说明。 */
      body[data-ds-dark-theme] [class*="_overlay"],
      body[data-ds-dark-theme] [class*="_Overlay"] { --dsw-alias-bg-base: #0b1018 !important; }
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
