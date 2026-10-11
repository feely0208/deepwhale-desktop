/**
 * 字体：字体 ID → CSS 字族栈。
 *
 * ⚠️ 产品规则（字体策略）：引擎只允许领域包 fonts 白名单里的字体 ID；
 * 这里把 ID 映射到 **可商用免费字体**，并允许回退到系统同族字体。
 * 若目标字体未安装，会给出告警（绝不静默变字形）。
 *
 * ── 关于"用户自备字体"（2026-10-10 结论：**不做**）─────────────────
 * 曾经实现过一套"用户把字体丢进目录、引擎内联加载"的接口，理由是插件塞不下中文字库
 * （余量 0.39MB，最小解析库 3.64MB）。**但那套东西跑不通，已整体拆除**：
 * 渲染页是 file:// 文档（不透明源），字体受 CORS 约束 ——
 * data: 内联与 file:// 引用两条路都实测回退到系统字体，探测一直报"已回退"。
 * 留在插件里只会误导人，所以删掉，不留半成品。
 *
 * 需要真字体（比如带描边的品牌字）时，走**工具层**：把文字转成 SVG 轮廓当素材用
 * （见 工具-字转轮廓/outline-text.py），完全不经过浏览器字体栈。
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
