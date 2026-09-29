#!/usr/bin/env node
/**
 * 生成「内置背景预设」的预览页，供人工判定观感。
 *
 * 为什么需要：背景好不好看**只能靠眼睛判断**，脚本断言不了。
 * 而把它烘进安装包再看一轮，代价是十分钟构建 + 装一次。
 * 所以先把同一个 CSS（用的是 dist/main/skin-presets.js 里那份，
 * 不是这里另抄一遍 —— 抄一遍就会变成"预览好看、装上是另一个样"）
 * 渲染成一个模拟界面，用浏览器打开看一眼。
 *
 * 用法：node scripts/preview-skin-preset.js [输出路径]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { presetBackgroundCss, presetPreviewStyle } = require(path.join(ROOT, 'dist', 'main', 'skin-presets.js'));

const dark = presetBackgroundCss('deepseek-blue');
if (!dark) {
  console.error('❌ 拿不到 deepseek-blue 预设的 CSS —— dist 是不是没构建？');
  process.exit(1);
}

const out = process.argv[2] || '/tmp/deepwhale-bg-preview.html';

const html = `<!doctype html>
<html lang="zh-CN" data-ds-dark-theme>
<head>
<meta charset="utf-8">
<title>深鲸壳 · 内置背景预览</title>
<style>
  /* 先摆一个"没有背景"的基准，模拟 DSH 默认外观 */
  :root { color-scheme: dark; }
  body { margin: 0; font: 13px/1.6 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; }

  /* ↓↓↓ 下面这段就是壳会注入进去的那份 CSS（来自 dist/main/skin-presets.js）↓↓↓ */
${dark}
  /* ↑↑↑ 结束 ↑↑↑ */

  /* 下面是模拟 DSH 界面用的骨架，与预设无关 */
  .app { display: flex; height: 100vh; }
  .sidebarCol { width: 260px; padding: 14px; box-sizing: border-box; }
  .main { flex: 1; padding: 22px 26px; box-sizing: border-box; }
  .card { background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 16px 18px; margin-bottom: 14px; }
  .muted { color: #8b93a1; }
  .row { display: flex; gap: 10px; align-items: center; padding: 7px 10px; border-radius: 8px; }
  .row.active { background: var(--dsw-specific-sidebar-nav-item-active); }
  .pill { display:inline-block; padding:2px 9px; border-radius:99px; background:#2b3242; font-size:12px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  h3 { font-size: 13px; margin: 0 0 10px; color:#c3cad6; }
  .swatch { display:flex; gap:14px; margin: 18px 0 0; }
  .swatch figure { margin:0; }
  .swatch .box { width: 240px; height: 120px; border-radius: 10px; border:1px solid #2b3242; }
  .swatch figcaption { font-size:12px; color:#8b93a1; margin-top:6px; }
</style>
</head>
<body>
<div class="app">
  <div class="sidebarCol">
    <div class="row active">💬 新会话</div>
    <div class="row">🧩 插件</div>
    <div class="row">🗂️ 工作区</div>
    <div class="row">⚙️ 设置</div>
    <div style="height:18px"></div>
    <div class="muted" style="padding:0 10px;font-size:12px">最近会话</div>
    <div class="row">案件材料整理</div>
    <div class="row">合同风险点核查</div>
    <div class="row">举证期限提醒</div>
  </div>
  <div class="main">
    <h1>深鲸桌面 · 内置背景预览</h1>
    <div class="muted">这块区域下面就是壳注入的背景。看两点：① 底部那团深蓝辉光够不够、位置对不对；② 面板与辉光的衔接有没有发脏。</div>
    <div style="height:18px"></div>
    <div class="card"><h3>会话</h3>这是一段正文，用来判断可读性。面板是不透明的，辉光只在面板之间的空隙里透出来。</div>
    <div class="card"><h3>法律模式</h3>案件 / 证据 / 文书生成 / 授权签批 / 日历看板 <span class="pill">法律模式</span></div>
    <div class="swatch">
      <figure><div class="box" style="${presetPreviewStyle('deepseek-blue')}"></div><figcaption>深蓝辉光（深色主题）</figcaption></figure>
      <figure><div class="box" style="background:#0a0c11"></div><figcaption>关掉预设 = 纯色</figcaption></figure>
    </div>
  </div>
</div>
</body>
</html>
`;

fs.writeFileSync(out, html, 'utf-8');
console.log(`已生成预览：${out}`);
console.log('（用的是 dist/main/skin-presets.js 里那份 CSS，和壳实际注入的是同一份）');
