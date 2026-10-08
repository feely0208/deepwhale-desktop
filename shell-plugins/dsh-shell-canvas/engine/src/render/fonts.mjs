/**
 * 字体：字体 ID → CSS 字族栈。
 *
 * ⚠️ 产品规则（字体策略）：引擎只允许领域包 fonts 白名单里的字体 ID；
 * 这里把 ID 映射到 **可商用免费字体**，并允许回退到系统同族字体。
 * 若目标字体未安装，会给出告警（绝不静默变字形）。
 */

// ⚠️ 必须用单引号包字体名：这段会被塞进 style="..." 里，
//    用双引号会把 HTML 属性提前截断（曾导致所有文字按默认字号渲染）。
export const FONT_STACKS = {
  'source-han-sans': "'Source Han Sans SC','Noto Sans SC','思源黑体','PingFang SC','Hiragino Sans GB','Microsoft YaHei',sans-serif",
  'source-han-serif': "'Source Han Serif SC','Noto Serif SC','思源宋体','Songti SC','STSong','SimSun',serif",
  'lxgw-wenkai': "'LXGW WenKai','霞鹜文楷','Kaiti SC','STKaiti','KaiTi',serif",
};

export function fontStack(id) {
  return FONT_STACKS[id] || 'sans-serif';
}

/**
 * 在页面里做一次"字体是否真的生效"的探测：
 * 用同一段中文字分别以「声明字族」和「绝对不存在的字族」测量宽度——
 * 宽度完全一致说明声明字族没生效（被回退了）。
 */
export const FONT_PROBE_SCRIPT = `
window.__canvasProbeFonts = function (fontIds) {
  const probe = '鲸幕深鲸智能科技永';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  const measure = (family) => { ctx.font = '64px ' + family; return ctx.measureText(probe).width; };
  const missing = [];
  for (const id of fontIds) {
    const stack = window.__canvasFontStacks[id];
    const wDeclared = measure(stack);
    const wFallback = measure("'__no_such_font_family__'");
    if (Math.abs(wDeclared - wFallback) < 0.01) missing.push(id);
  }
  return missing;
};
`;
