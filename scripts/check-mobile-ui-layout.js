#!/usr/bin/env node
/**
 * 手机端 UI 的**按钮排布**能力断言（手机端 1.1.0 · 验收首位）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么把这个单独做成断言：
 *   桌面端已经吃过两次亏 —— 更新弹窗按钮挤成两行、设置页版本行断行，
 *   两次都是"跑测试全绿、用户一眼看出难看"。手机端屏幕更小、错误更廉价地暴露，
 *   所以**排版必须由断言 + 真实渲染来保证，不靠肉眼**。
 *
 * 断言项（逐条都能红，实现见下方 assert 输出）：
 *   ① 无横向溢出：scrollWidth ≤ clientWidth
 *   ② 点按热区 ≥44×44（chip 用 ::after 撑热区，用 elementFromPoint 实测）
 *   ③ 同一行的按钮**等高**（±1px）且**垂直居中**（同一 y 中心 ±2px）
 *   ④ 按钮文字**不换行**（scrollWidth ≤ clientWidth、scrollHeight 不超过一行）
 *   ⑤ 主操作「发送」在**右下角**、≥48×48、且落在拇指热区（屏幕下方 40%）
 *   ⑥ safe-area：viewport-fit=cover + env(safe-area-inset-*) 已声明
 *   ⑦ 底部标签栏 4 个 tab **等宽**
 *
 * 用法：node scripts/check-mobile-ui-layout.js
 *   产物：/tmp/dsh-mobile-ui/<宽>x<高>.png（每个机型一张，供人工复核）
 */
'use strict';

const { app, BrowserWindow, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');

const REPO = path.join(__dirname, '..');
const PAGE = path.join(REPO, 'mobile-ui', 'index.html');
const OUT = '/tmp/dsh-mobile-ui';

/** 机型覆盖：iOS 两代 + Android 两种 + 鸿蒙一种（我们比第三方多的一端） */
const DEVICES = [
  { name: 'iPhone-SE', w: 375, h: 667 },
  { name: 'iPhone-15', w: 390, h: 844 },
  { name: 'Android-360', w: 360, h: 740 },
  { name: 'HarmonyOS-360', w: 360, h: 780 },
];

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 在页面里量所有需要的几何量 */
function measurePage() {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, w:r.width, h:r.height,
    cx:r.x + r.width/2, cy:r.y + r.height/2 }; };
  const interactive = Array.from(document.querySelectorAll('button, textarea, [role="button"], a[href]'))
    .filter((el) => el.offsetParent !== null && !el.hidden);
  const items = interactive.map((el) => {
    const cs = getComputedStyle(el);
    const r = rect(el);
    // chip 的视觉高度 30px，但 ::after 把热区撑到 44px —— 用命中测试实测热区
    let hit = { w: r.w, h: r.h };
    if (el.classList.contains('chip')) {
      const hitTop = (() => { for (let d = 0; d <= 24; d++) { const n = document.elementFromPoint(r.cx, r.cy - d); if (!(n === el || el.contains(n))) return d; } return 25; })();
      const hitBot = (() => { for (let d = 0; d <= 24; d++) { const n = document.elementFromPoint(r.cx, r.cy + d); if (!(n === el || el.contains(n))) return d; } return 25; })();
      hit = { w: r.w, h: hitTop + hitBot };
    }
    return {
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      cls: el.className || null,
      text: (el.textContent || '').trim().slice(0, 18),
      r,
      hit,
      lineClamp: cs.whiteSpace,
      // 单行是否放得下
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
      fs: parseFloat(cs.fontSize),
      lh: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5,
    };
  });
  const groups = {};
  for (const it of items) {
    if (it.tag !== 'button') continue;
    const key = String(Math.round(it.r.cy / 6));  // 同一条水平带
    (groups[key] = groups[key] || []).push(it);
  }
  const rows = Object.values(groups).filter((g) => g.length > 1).map((g) => g.map((i) => ({
    id: i.id, text: i.text, y: i.r.y, h: i.r.h, cy: i.r.cy, x: i.r.x,
  })));
  const tabbar = Array.from(document.querySelectorAll('.tabbar button')).map((b) => rect(b));
  const send = document.getElementById('btn-send');
  return {
    vw: document.documentElement.clientWidth,
    vh: document.documentElement.clientHeight,
    scrollW: document.documentElement.scrollWidth,
    safeCss: /viewport-fit=cover/.test(document.querySelector('meta[name=viewport]').content)
      && /env\(safe-area-inset-bottom/.test(document.querySelector('style').textContent),
    rows,
    tabbar,
    items,
    send: send ? rect(send) : null,
    // ⑧ 图标不许用 emoji（产品感）：扫标签栏 / 图标按钮 / 发送按钮的文字
    emojiInIcons: Array.from(document.querySelectorAll('.tabbar button, .icon-btn, .send'))
      .map((el) => ({ id: el.id || el.className, text: (el.textContent || '').trim() }))
      .filter((x) => /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}]/u.test(x.text)),
    // ⑨ chip 行溢出时必须有"还能横向滚"的渐隐提示
    chipsOverflow: (() => {
      const row = document.getElementById('chips');
      if (!row) return { over: false, fade: false };
      const wrap = row.parentElement;
      const after = wrap ? getComputedStyle(wrap, '::after') : null;
      return {
        over: row.scrollWidth > row.clientWidth + 1,
        fade: !!(after && after.content !== 'none' && /gradient/.test(after.backgroundImage || '')),
      };
    })(),
    // ⑩ 每个操作组里最多一个主操作（实心强调色）
    primaryCounts: Array.from(document.querySelectorAll('.acts, .input-row')).map((g) =>
      Array.from(g.querySelectorAll('button')).filter((b) => {
        const bg = getComputedStyle(b).backgroundColor || '';
                const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
        if (!m) return false;
        // 只认「强调色」为主操作（灰底算次要）—— 之前写成「任何非透明底色」，
        // 把输入行里的灰色 ＋ 也算成主操作，断言误报（已修）。
        const r2 = Number(m[1]); const g2 = Number(m[2]); const b2 = Number(m[3]);
        return Math.abs(r2 - 46) < 12 && Math.abs(g2 - 166) < 12 && Math.abs(b2 - 214) < 12;
      }).length),
  };
}

// 用 toString() 注入：**避免模板字面量吃掉正则里的反斜杠**（踩了三次：\(、\d、\s）
const MEASURE = '(' + measurePage.toString() + ')()';

async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  const problems = [];
  // ⚠️ 只建**一个**窗口，逐机型改尺寸 —— 每个机型都新建/销毁会撞上
  //   "上一条 loadFile 与下一条竞态"（实测第二个机型直接 ERR_FAILED）。
  const win = new BrowserWindow({
    width: DEVICES[0].w, height: DEVICES[0].h, show: false, frame: false, resizable: false,
    useContentSize: true,
    webPreferences: { backgroundThrottling: false, contextIsolation: true },
  });
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    const m = String(msg || '');
    if (!/Security Warning/.test(m)) console.error('   [renderer]', m.slice(0, 300));
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('   [renderer gone]', JSON.stringify(d)));
  await win.loadFile(PAGE);
  await wait(300);

  // 辉光是**深/浅两套**配色，两套都要验（只验深色会漏掉浅色下的对比度问题）
  for (const theme of ['dark', 'light']) {
  nativeTheme.themeSource = theme;
  await wait(120);
  for (const d of DEVICES) {
    win.setContentSize(d.w, d.h);
    await wait(260);
    const perPage = [];
    for (const page of ['list', 'chat']) {
      await win.webContents.executeJavaScript(`window.__dshMobile.showPage('${page}')`);
      await wait(180);
      // 在页面内 try/catch 后**转成 JSON 字符串**再返回：
      // 既能拿到真实报错，也避免"返回值里有不可序列化对象"导致
      // Electron 只抛一句 "Script failed to execute"（实测踩过：Element / SVGAnimatedString）。
      let m;
      {
        // ⚠️ 必须用**字符串拼接**把 MEASURE 拼进去：写成模板字面量会变成运行时插值，
        //    注入的 JS 直接语法错误（实测只看到 "Script failed to execute"）。
        const wrapped =
          '(() => { try { return JSON.stringify({ ok: true, data: (' + MEASURE + ') }); }' +
          ' catch (e) { return JSON.stringify({ ok: false, err: String(e && e.message),' +
          ' stack: String(e && e.stack).slice(0, 400) }); } })()';
        let raw;
        try {
          raw = await win.webContents.executeJavaScript(wrapped);
        } catch (e) {
          console.error(`  ✗ ${d.name}/${page} 注入失败：${String(e.message).slice(0, 200)}`);
          console.error('     注入串头部: ' + wrapped.slice(0, 160).replace(/\n/g, ' '));
          console.error('     注入串尾部: ' + wrapped.slice(-160).replace(/\n/g, ' '));
          throw e;
        }
        const parsed = JSON.parse(raw);
        if (!parsed.ok) {
          console.error(`  ✗ ${d.name}/${page} 量取抛错: ${parsed.err}`);
          console.error(`     ${parsed.stack}`);
          throw new Error(parsed.err);
        }
        m = parsed.data;
      }
      perPage.push({ page, m });
    }
    // 每个页面各存一张（列表页 / 会话页），便于人工复核
    for (const { page } of perPage) {
      await win.webContents.executeJavaScript(`window.__dshMobile.showPage('${page}')`);
      await wait(150);
      const shot = await win.webContents.capturePage();
      fs.writeFileSync(path.join(OUT, `${theme}-${d.name}-${page}-${d.w}x${d.h}.png`), shot.toPNG());
    }

    for (const { page, m } of perPage) {
      const tag = `${d.name}/${page}`;
      if (m.scrollW > m.vw + 1) problems.push(`${tag} 横向溢出：scrollWidth ${m.scrollW} > ${m.vw}`);
      for (const it of m.items) {
        if (it.tag === 'textarea') continue;
        const h = Math.max(it.r.h, it.hit.h), w = Math.max(it.r.w, it.hit.w);
        if (h < 43 || w < 43) {
          problems.push(`${tag} 点按热区不足 44：${it.text || it.id || it.cls} ${Math.round(w)}×${Math.round(h)}`);
        }
      }
      for (const row of m.rows) {
        const hs = row.map((r) => r.h), cys = row.map((r) => r.cy);
        if (Math.max(...hs) - Math.min(...hs) > 1) {
          problems.push(`${tag} 同行按钮不等高：${row.map((r) => `${r.text}:${Math.round(r.h)}`).join(' / ')}`);
        }
        if (Math.max(...cys) - Math.min(...cys) > 2) {
          problems.push(`${tag} 同行按钮未垂直居中：${row.map((r) => `${r.text}:${Math.round(r.cy)}`).join(' / ')}`);
        }
      }
      for (const it of m.items) {
        if (it.tag !== 'button') continue;
        if (it.overflowX > 1) problems.push(`${tag} 按钮文字横向溢出：${it.text}`);
        if (it.overflowY > 2) problems.push(`${tag} 按钮文字换行：${it.text}`);
      }
      if (m.send) {
        if (!(m.send.w >= 47 && m.send.h >= 47)) {
          problems.push(`${tag} 发送按钮尺寸不足 48：${Math.round(m.send.w)}×${Math.round(m.send.h)}`);
        }
        if (!(m.send.cx > m.vw * 0.6 && m.send.cy > m.vh * 0.6)) {
          problems.push(`${tag} 发送按钮不在右下拇指热区（cx=${Math.round(m.send.cx)}/${m.vw}, cy=${Math.round(m.send.cy)}/${m.vh}）`);
        }
      }
      if (!m.safeCss) problems.push(`${tag} 缺少 viewport-fit=cover 或 env(safe-area-inset-*)`);
      // ⑧ emoji 当图标 → 产品感不足
      for (const e of m.emojiInIcons) {
        problems.push(`${tag} 图标用了 emoji（应为矢量图标）：${e.id} → "${e.text}"`);
      }
      // ⑨ chip 行溢出但没渐隐提示 → 看起来像"被裁坏了"
      if (m.chipsOverflow.over && !m.chipsOverflow.fade) {
        problems.push(`${tag} chip 行已横向溢出，但缺少右侧渐隐提示`);
      }
      // ⑩ 主次：每个操作组最多一个实心主操作
      for (const n of m.primaryCounts) {
        if (n > 1) problems.push(`${tag} 同一操作组里有 ${n} 个主操作（主次不分）`);
      }
      if (m.tabbar.length) {
        const ws = m.tabbar.map((t) => t.w);
        if (Math.max(...ws) - Math.min(...ws) > 1) {
          problems.push(`${tag} 底部 tab 不等宽：${ws.map((w) => Math.round(w)).join(' / ')}`);
        }
      }
    }
    console.log(`  ✓ ${theme}/${d.name} ${d.w}×${d.h} 已量（列表页 + 会话页）`);
  }
  }
  win.destroy();

  if (problems.length) {
    console.error(`\n❌ 手机端排版断言失败 ${problems.length} 项：`);
    problems.slice(0, 20).forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
    if (problems.length > 20) console.error(`   … 还有 ${problems.length - 20} 项`);
    console.error(`\n截图见 ${OUT}/`);
    return 1;
  }
  console.log(`\n✅ 手机端排版断言全部通过（2 主题 × ${DEVICES.length} 机型 × 2 页面）· 截图见 ${OUT}/`);
  return 0;
}

app.commandLine.appendSwitch('disable-gpu-compositing');
app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await run();
  } catch (e) {
    console.error('断言脚本出错:', e);
  }
  app.exit(code);
});
