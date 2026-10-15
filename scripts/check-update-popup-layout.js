#!/usr/bin/env node
/**
 * 能力基线 · 更新弹窗的按钮排版（2026-10-15 用户指出「按钮排列一点都不严谨」后新加）
 *
 * ── 为什么要有这条 ────────────────────────────────────────────────
 *   用户看的不是 CSS，是**画出来的那一屏**。这次实测的四个问题全是"代码看着对、
 *   画出来不对"：
 *     ① footer 拆成上下两行 → 「发现新版本」屏主按钮孤零零落在第二行右下（Z 字形）
 *     ② 两行按钮高度 39 vs 37（差 2px），基线不齐
 *     ③ 一行贴左、一行贴右，两端都不齐
 *     ④ 修 ① 时我写了 `display:inline-flex`，把浏览器对 `[hidden]` 的 `display:none`
 *        盖掉 → **五个按钮全画出来了**；而按 `hidden` 属性过滤的检查完全看不出来
 *        （这正是"断言机制 ≠ 断言能力"的又一例）。
 *
 * ── 判据（全部按**渲染结果**判，不看 DOM 属性）────────────────────
 *   对 available / downloading / downloaded / error / idle 五个阶段各渲染一次，断言：
 *     A. 每个阶段"实际可见"的按钮集合与预期一致（多一个少一个都算失败）
 *     B. 同一阶段所有可见按钮**同一行**（top 相同）且**高度相同**
 *     C. 主按钮（primary）永远是最靠右的那个
 *     D. footer 高度跨阶段稳定（不跳）
 *     E. idle 阶段不残留上一阶段的 status 文案
 *
 * 用法：node scripts/check-update-popup-layout.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const POPUP_DIR = path.join(REPO, 'src', 'update-popup');

/** 期望：每个阶段"实际渲染"出来的按钮（按显示文本） */
const EXPECT = {
  available: ['这个版本不再提醒', '稍后', '现在更新'],
  downloading: ['停止更新'],
  downloaded: ['稍后', '立即重启'],
  error: ['这个版本不再提醒', '稍后', '重试更新'],
  idle: ['知道了'],
};

let electronPath;
try {
  // 在**普通 node** 下 require('electron') 返回 Electron 可执行文件路径（官方行为）
  electronPath = require('electron');
} catch {
  electronPath = null;
}
if (typeof electronPath !== 'string' || !fs.existsSync(electronPath)) {
  console.error('❌ 找不到 Electron 可执行文件（node_modules/electron 没装？）—— 本断言需要它来真渲染');
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-layout-'));
fs.writeFileSync(
  path.join(tmp, 'preload.js'),
  `const { contextBridge } = require('electron');
let cb = null;
contextBridge.exposeInMainWorld('dshPopup', { on: (fn) => { cb = fn; }, action: () => {} });
contextBridge.exposeInMainWorld('__probe', { push: (m) => { if (cb) cb(m); } });
`,
);
fs.writeFileSync(
  path.join(tmp, 'main.js'),
  `const { app, BrowserWindow } = require('electron');
const path = require('path');
const NOTES = { type: 'notes', version: '1.0.58', items: [{ kind: 'fix', text: 'A' }] };
const PHASES = ${JSON.stringify(Object.keys(EXPECT))};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 560, height: 620, show: false, frame: false,
    webPreferences: { preload: ${JSON.stringify(path.join(tmp, 'preload.js'))}, contextIsolation: true,
      backgroundThrottling: false } });
  await win.loadFile(${JSON.stringify(path.join(POPUP_DIR, 'update-popup.html'))});
  await sleep(500);
  const out = [];
  for (const ph of PHASES) {
    await win.webContents.executeJavaScript(
      'window.__probe.push(' + JSON.stringify(NOTES) + ');' +
      'window.__probe.push(' + JSON.stringify({ type: 'state', percent: 42 }) .replace('"phase"', '"phase"') + ');' +
      'window.__probe.push(' + JSON.stringify({ type: 'state', phase: ph, version: '1.0.58', percent: 42,
        message: ph === 'error' ? '网络中断' : '' }) + '); 1');
    // ⚠️ 等待必须放**主进程**：隐藏窗口里页面的 setTimeout 会被节流（实测会把探针挂死）
    await sleep(400);
    const snap = await win.webContents.executeJavaScript(\`(function(){
      const vis = [];
      document.querySelectorAll('.foot button').forEach((b) => {
        if (getComputedStyle(b).display === 'none') return;   // 按渲染结果判可见
        const r = b.getBoundingClientRect();
        vis.push({ text: b.textContent.trim(), primary: b.classList.contains('primary'),
                   x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) });
      });
      const f = document.querySelector('.foot').getBoundingClientRect();
      return JSON.stringify({ phase: '\${ph}', status: document.getElementById('status').textContent,
        footH: Math.round(f.height), buttons: vis });
    })()\`);
    out.push(JSON.parse(snap));
  }
  console.log('__RESULT__' + JSON.stringify(out));
  app.exit(0);
}).catch((e) => { console.log('__ERROR__' + (e && e.message)); app.exit(1); });
`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 会当 Node 跑，拿不到 app/BrowserWindow
const r = spawnSync(electronPath, [path.join(tmp, 'main.js')], { env, encoding: 'utf-8', timeout: 120000 });
const text = `${r.stdout || ''}${r.stderr || ''}`;

if (text.includes('__ERROR__')) {
  console.error('❌ 渲染弹窗失败：' + (text.split('__ERROR__')[1] || '').split('\n')[0]);
  process.exit(1);
}
const m = text.match(/__RESULT__(.*)/);
if (!m) {
  console.error('❌ 没拿到渲染结果（Electron 没跑起来？）');
  console.error(text.split('\n').slice(-8).join('\n'));
  process.exit(1);
}

const snaps = JSON.parse(m[1]);
const problems = [];
for (const s of snaps) {
  const expect = EXPECT[s.phase] || [];
  const got = s.buttons.map((b) => b.text);
  const shown = `「${got.join(' / ')}」`;
  if (JSON.stringify(got) !== JSON.stringify(expect)) {
    problems.push(
      `${s.phase}：实际画出来的按钮 ${shown}，期望 「${expect.join(' / ')}」` +
        (got.length > expect.length ? '（有该藏的按钮被画出来了 —— 检查是否给按钮写了 display 覆盖了 [hidden]）' : ''),
    );
    continue;
  }
  // B 同一行 + 等高
  const ys = new Set(s.buttons.map((b) => b.y));
  const hs = new Set(s.buttons.map((b) => b.h));
  if (ys.size > 1) problems.push(`${s.phase}：按钮不在同一行（top = ${[...ys].join(', ')}）—— 主次按钮被拆成了两行`);
  if (hs.size > 1) problems.push(`${s.phase}：按钮高度不一致（${[...hs].join(', ')} px）—— 基线会错开`);
  // C 主按钮最右
  if (s.buttons.length > 1) {
    const primaries = s.buttons.filter((b) => b.primary);
    const rightMost = s.buttons.reduce((a, b) => (b.x > a.x ? b : a));
    if (primaries.length !== 1) problems.push(`${s.phase}：可见主按钮 ${primaries.length} 个（应为 1）`);
    else if (rightMost.text !== primaries[0].text) {
      problems.push(`${s.phase}：最靠右的是「${rightMost.text}」，而主按钮是「${primaries[0].text}」—— 主操作必须在最右`);
    }
  }
  if (s.phase === 'idle' && s.status.trim() !== '') {
    problems.push(`idle：status 残留了上一阶段的文案「${s.status}」（手动打开弹窗时会显示别人留下的错误信息）`);
  }
}
const footHs = new Set(snaps.map((s) => s.footH));
if (footHs.size > 1) problems.push(`footer 高度跨阶段变化（${[...footHs].join(', ')} px）—— 切状态时整个底栏会跳`);

if (problems.length) {
  console.error('❌ 更新弹窗排版能力断言失败：\n');
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  const active = snaps.find((s) => s.phase === 'available');
  console.log(`✅ 更新弹窗排版通过（${snaps.length} 个阶段）：单行 · 等高 ${active.buttons[0].h}px · 主按钮最右 · 底栏高度恒定 ${active.footH}px`);
  for (const s of snaps) console.log(`   · ${s.phase.padEnd(12)} ${s.buttons.map((b) => b.text).join(' / ')}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
