/**
 * 内置背景预设 —— 纯 CSS 绘制，不需要图片文件。
 *
 * ── 来由（2026-09-29，用户的原话）────────────────────────────────
 *   「https://www.deepseek.com/harness/ 你看下官方这个网页背景，我很喜欢，
 *     能做成新版深鲸壳的默认背景吗？」
 *
 * 于是把官方那个页面的背景抄了下来。**它不是一张图**，是三段
 * 带模糊（filter: blur(80px)）的径向渐变叠出来的辉光，实测抓到的原值：
 *
 *   ① 500×500 在左侧 10%、底 −100px，opacity .30
 *      radial-gradient(circle, #1A3870 0%, transparent 70%)
 *   ② 700×400 在水平中央、底 −50px，opacity .40
 *      radial-gradient(ellipse at center, #2D5F9E 0%, #1A3870 40%, transparent 70%)
 *   ③ 400×400 在右侧 10%、底 −80px，opacity .20
 *      radial-gradient(circle, #4A8AC4 0%, #2D5F9E 30%, transparent 70%)
 *
 * 用 CSS 复刻而不是存一张 png 的好处：**任意分辨率都清晰、零字节、不用下载**，
 * 而且窗口拉伸时辉光跟着走，不会出现"背景图被拉扯变形"。
 * 代价是没法做到像素级一致（官方那三层是真实高斯模糊），
 * 这里用多层渐变的柔和过渡去逼近 —— 观感上等价，肉眼分不出。
 *
 * 两套（深色 / 浅色）分开写：深色是"近黑底 + 深蓝辉光"，
 * 浅色是"近白底 + 淡蓝辉光"，直接照搬深色那套会在浅色主题下变成一块脏蓝色。
 */

/** 深色主题下的辉光层（与官方同色）。 */
const GLOW_DARK = `
    /* 底部主辉光：偏心椭圆，最亮的一团 */
    radial-gradient(ellipse 46% 26% at 50% 104%, rgba(45, 95, 158, 0.62) 0%, rgba(26, 56, 112, 0.34) 42%, rgba(26, 56, 112, 0) 72%),
    /* 左下 */
    radial-gradient(circle 22% at 10% 103%, rgba(26, 56, 112, 0.70) 0%, rgba(26, 56, 112, 0) 70%),
    /* 右下：偏亮的天蓝，官方那层 opacity 最低 */
    radial-gradient(circle 18% at 90% 102%, rgba(74, 138, 196, 0.42) 0%, rgba(45, 95, 158, 0.22) 34%, rgba(45, 95, 158, 0) 70%),
    /* 顶部一条很淡的冷光，避免上半屏死黑 */
    radial-gradient(ellipse 60% 30% at 50% -12%, rgba(26, 56, 112, 0.42) 0%, rgba(26, 56, 112, 0) 70%)`;

/** 浅色主题下的同构图（换成淡蓝，亮度提上去）。 */
const GLOW_LIGHT = `
    radial-gradient(ellipse 46% 26% at 50% 104%, rgba(45, 95, 158, 0.26) 0%, rgba(26, 56, 112, 0.12) 42%, rgba(26, 56, 112, 0) 72%),
    radial-gradient(circle 22% at 10% 103%, rgba(26, 56, 112, 0.22) 0%, rgba(26, 56, 112, 0) 70%),
    radial-gradient(circle 18% at 90% 102%, rgba(74, 138, 196, 0.24) 0%, rgba(45, 95, 158, 0.12) 34%, rgba(45, 95, 158, 0) 70%),
    radial-gradient(ellipse 60% 30% at 50% -12%, rgba(26, 56, 112, 0.14) 0%, rgba(26, 56, 112, 0) 70%)`;

/** 深色底：近黑，带一点点冷调（纯 #000 会让蓝辉光显得脏）。 */
export const PRESET_DARK_BASE = '#0a0c11';
/** 浅色底 */
export const PRESET_LIGHT_BASE = '#f7f9fc';

/**
 * 预设名 → 注入用的 CSS。返回 null 表示"没有这个预设/不需要注入"。
 *
 * 面板色沿用背景图那一套（深色面板不透明、基础底色透明）：
 * 这样辉光只在"没有面板盖住"的地方透出来，正文区域的可读性不受影响。
 */
export function presetBackgroundCss(preset: string): string | null {
  if (preset !== 'deepseek-blue') return null;

  return `
      html { background-color: transparent !important; }
      body { background-color: transparent !important; }
      body::before {
        content: '' !important;
        position: fixed !important;
        inset: 0 !important;
        z-index: -1 !important;
        pointer-events: none !important;
        background-color: ${PRESET_DARK_BASE} !important;
        background-image: ${GLOW_DARK} !important;
        background-repeat: no-repeat !important;
      }
      /* 深色：面板改不透明，基础底色透明 —— 辉光只在空隙里透出来 */
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
      /* 浅色：换淡蓝辉光 + 近白底，并把面板压回浅色实色 */
      body:not([data-ds-dark-theme])::before {
        background-color: ${PRESET_LIGHT_BASE} !important;
        background-image: ${GLOW_LIGHT} !important;
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

/** 设置页预览用：把同一个预设渲染成一小块色板（不含 DSH 变量，纯粹看颜色）。 */
export function presetPreviewStyle(preset: string): string | null {
  if (preset !== 'deepseek-blue') return null;
  return `background-color: ${PRESET_DARK_BASE}; background-image: ${GLOW_DARK.replace(/\s+/g, ' ')};`;
}
