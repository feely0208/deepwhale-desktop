#!/usr/bin/env node
/**
 * 生成「内置背景」的对照预览页，供人工判定。
 *
 * 为什么要有这个：背景像不像**只能靠眼睛判断**，脚本断言不了；
 * 而每改一版都重新打包（约 8 分钟）再让用户装一次，迭代一次就是半小时。
 * 所以把三块并排画出来，用浏览器直接看：
 *
 *   ① 官方原版 —— **逐项照抄官方 DOM**（像素尺寸、各自的 blur、各自 opacity、
 *      底色 #0a0a0a），当作基准。这一块就是"标准答案"。
 *   ② 我们的 · 底部锚点 —— 壳的默认值。光在窗口底部。
 *   ③ 我们的 · hero 锚点 —— 照官方那条 top:80px、高 500px 的光带锚。
 *
 * 用的是 dist/main/skin-presets.js 里那份样式（不是这里另抄一遍 ——
 * 抄一遍就会变成"预览好看、装上是另一个样"）。
 *
 * 用法：node scripts/preview-skin-preset.js [输出路径]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const P = require(path.join(ROOT, 'dist', 'main', 'skin-presets.js'));

const BASE = P.PRESET_DARK_BASE;
const OFFICIAL_BLOBS = [
  { w: 500, h: 500, x: '10%', bottom: -100, opacity: 0.3, blur: 80, g: 'radial-gradient(circle,#1A3870 0%,transparent 70%)' },
  { w: 700, h: 400, x: 'calc(50% - 350px)', bottom: -50, opacity: 0.4, blur: 100, g: 'radial-gradient(ellipse at center,#2D5F9E 0%,#1A3870 40%,transparent 70%)' },
  { w: 400, h: 400, x: 'calc(90% - 400px)', bottom: -80, opacity: 0.2, blur: 60, g: 'radial-gradient(circle,#4A8AC4 0%,#2D5F9E 30%,transparent 70%)' },
];

function officialPanel() {
  const blobs = OFFICIAL_BLOBS.map(
    (b) =>
      `<div style="position:absolute;left:${b.x};bottom:${b.bottom}px;width:${b.w}px;height:${b.h}px;` +
      `opacity:${b.opacity};background:${b.g};filter:blur(${b.blur}px)"></div>`,
  ).join('\n      ');
  // 官方的结构：一层 overflow:hidden 的带子（top:80px / 高 500px）里放三团光
  return `<div class="stage" style="background:${BASE}">
      <div style="position:absolute;top:80px;left:0;width:100%;height:500px;overflow:hidden">
      ${blobs}
      </div>${mockUi()}
    </div>`;
}

function oursPanel(anchor, label) {
  const container = P.glowContainerStyle();
  const blobs = P.blobElementStyles(anchor)
    .map((s) => `<div style="${s}"></div>`)
    .join('\n      ');
  return `<div class="stage" style="background:transparent">
      <div style="${container}">
      ${blobs}
      </div>${mockUi()}
    </div>`;
}

/** 一个模拟 DSH 界面的骨架，用来判断"光落在界面后面好不好看"。 */
function mockUi() {
  return `
      <div class="ui">
        <div class="side">
          <div class="sbtn">＋ 新会话</div>
          <div class="sitem">插件</div>
          <div class="sitem">工作区</div>
          <div class="sgap"></div>
          <div class="slabel">最近会话</div>
          <div class="sitem">案件材料整理</div>
          <div class="sitem">合同风险点核查</div>
          <div class="sitem">举证期限提醒</div>
        </div>
        <div class="main">
          <div class="card"><b>会话</b><div class="mut">面板是不透明的，光只在面板之间的空隙里透出来。</div></div>
          <div class="card"><b>法律模式</b><div class="mut">案件 / 证据 / 文书生成 / 授权签批 / 日历看板</div></div>
        </div>
      </div>`;
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>深鲸壳 · 内置背景对照</title>
<style>
  body{margin:0;background:#111;color:#e6ebf2;
    font:13px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  h1{font-size:16px;margin:16px 20px 4px}
  .hint{margin:0 20px 16px;color:#8b93a1;font-size:12.5px;line-height:1.9}
  .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;padding:0 20px 24px}
  .col h2{font-size:13px;margin:0 0 2px;font-weight:700}
  .col .sub{font-size:11.5px;color:#8b93a1;margin-bottom:7px;min-height:32px}
  .stage{position:relative;height:520px;border-radius:12px;overflow:hidden;
    border:1px solid #2b3242;isolation:isolate}
  .ui{position:absolute;inset:0;display:flex;z-index:1}
  .side{width:32%;padding:10px;box-sizing:border-box;background:#14171c}
  .main{flex:1;padding:12px;box-sizing:border-box}
  .sbtn{background:#2b3242;border-radius:8px;padding:7px 10px;margin-bottom:10px;font-size:12px}
  .sitem{padding:6px 9px;font-size:12px;color:#aeb8c6}
  .slabel{font-size:11px;color:#6b7b8d;padding:8px 9px 4px}
  .sgap{height:14px}
  .card{background:#1c1f25;border-radius:10px;padding:11px 13px;margin-bottom:10px;font-size:12px}
  .mut{color:#8b93a1;margin-top:3px}
</style>
</head>
<body>
  <h1>深鲸壳 · 内置背景对照（左边是官方原版，右边两个是我们的实现）</h1>
  <p class="hint">
    重点看三件事：① 光够不够亮、颜色对不对；② 光的边缘是"化开的"还是"一圈硬的"；③ 光落在侧栏与内容区后面好不好看。<br>
    ① 是照抄官方 DOM 画出来的基准；② ③ 用的是壳里那份代码（dist/main/skin-presets.js），所以这里什么样，装上去就是什么样。
  </p>
  <div class="grid">
    <div class="col"><h2>① 官方原版（基准）</h2><div class="sub">像素尺寸 + 各自 blur(80/100/60) + 底色 #0a0a0a，位置照官方那条 top:80px 的光带</div>${officialPanel()}</div>
    <div class="col"><h2>② 我们的 · 底部锚点</h2><div class="sub">壳的默认值：三团光锚在窗口底边（blur 相同，取中位 88）</div>${oursPanel('bottom')}</div>
    <div class="col"><h2>③ 我们的 · hero 锚点</h2><div class="sub">和官方一样锚在上方 80px 那一段，位置最接近官网</div>${oursPanel('hero')}</div>
  </div>
</body>
</html>
`;

const out = process.argv[2] || '/tmp/deepwhale-bg-preview.html';
fs.writeFileSync(out, html, 'utf-8');
console.log('已生成对照预览：' + out);
