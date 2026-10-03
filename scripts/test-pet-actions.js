/* 桌面宠物「动作调度」自检（`npm run test:pet`）。
 *
 * 起因（2026-10-03 用户反馈）：「动作并没有那么多，只有原地的动效，拖拽也只有方向的变化，
 * 你之前设置的那十几组动作并没有生效」。
 * 这一块的问题出在**独立宠物窗口里的调度逻辑**，主界面完全看不见 —— 只跑冒烟
 * （断言"画出了不透明像素"）是发现不了的。所以单独立一个自检：
 *   ① manifest 里每一组动作都能被选中，并且**画面上真的不同**（画布校验和两两比较）；
 *   ② 闲置调度真的会换动作（不是永远 idle）；
 *   ③ 悬停期间会轮播动作（以前悬停锁死在挥手 → 用户觉得"只有原地动效"）；
 *   ④ 拖拽分级的倍率生效（快跑明显更快）。
 *
 * 用临时 userData + 很小的调度间隔，几秒内跑完，不影响用户正在用的应用。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const TMP = '/tmp/dw-pet-test';
const PET_NAME = '青色大肥鱼';

app.setPath('userData', TMP);

let failed = 0;
function ok(msg) {
  console.log('  ✅ ' + msg);
}
function bad(msg) {
  failed += 1;
  console.error('  ❌ ' + msg);
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.rmSync(TMP, { recursive: true, force: true });
  const petsDir = path.join(TMP, 'pets');
  copyDir(path.join(ROOT, 'dist', 'assets', 'pets'), petsDir);

  // 先造一份"旧副本"：去掉 sideView、改老时间戳 —— 模拟"用户机器上留着旧内置宠物"这个真事故
  const petDir = path.join(petsDir, PET_NAME);
  const manifestPath = path.join(petDir, 'manifest.json');
  const stale = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  delete stale.sideView;
  stale.rows = stale.rows.filter((r) => r.state !== 'flip');
  fs.writeFileSync(manifestPath, JSON.stringify(stale, null, 2));
  const old = new Date(Date.now() - 86400000);
  for (const f of fs.readdirSync(petDir)) fs.utimesSync(path.join(petDir, f), old, old);

  const { Store } = require(path.join(ROOT, 'dist', 'main', 'store.js'));
  const { PetWindow } = require(path.join(ROOT, 'dist', 'main', 'pet.js'));
  const store = new Store();
  store.set('petGif', PET_NAME);
  const pet = new PetWindow(store);
  pet.ensureUserPetsDir();         // 应当把上面那份旧副本刷成新版
  pet.registerIpc();               // 注册 pet:sprite-info，宠物窗口才能拿到 spritesheet
  const refreshed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (refreshed.sideView && refreshed.rows.some((r) => r.state === 'flip')) {
    ok('用户目录里的旧内置宠物会被自动刷新（sideView / flip 已补上）');
  } else {
    bad('旧内置宠物没被刷新 —— 新功能会"装上不生效"');
  }

  const win = new BrowserWindow({
    width: 200,
    height: 200,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(ROOT, 'dist', 'preload', 'preload.js'),
    },
  });
  await win.loadFile(path.join(ROOT, 'dist', 'pet', 'pet.html'), {
    query: { sprite: PET_NAME, frameMs: '40', actionMs: '300', actionSpanMs: '200', hoverMs: '250', holdMs: '260', holdLongMs: '300' },
  });

  // 等 spritesheet 解出来（3.4MB，给足时间）
  let info = null;
  for (let i = 0; i < 60; i += 1) {
    await sleep(200);
    info = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__petDebug ? window.__petDebug.info() : null)'));
    if (info && info.isSprite && info.rows && info.rows.length) break;
  }
  if (!info || !info.isSprite) {
    bad('宠物没有以 sprite 模式载入（petSpriteInfo 或 manifest 有问题）');
    return;
  }
  ok(`sprite 载入成功，manifest 动作数 = ${info.rows.length}`);

  const states = info.rows.map((r) => r.state);
  const wanted = ['idle', 'waving', 'jumping', 'flip', 'dash', 'standing', 'ball', 'running-left', 'running-right', 'sleeping'];
  const missing = wanted.filter((s) => !states.includes(s));
  if (missing.length) bad('缺少动作：' + missing.join(','));
  else ok('关键动作齐全：' + wanted.join(', '));

  // ① 每组动作画出来必须不一样
  const hashes = {};
  for (const st of states) {
    await win.webContents.executeJavaScript(`window.__petDebug.set(${JSON.stringify(st)}); null`);
    await sleep(90);
    const h = await win.webContents.executeJavaScript('window.__petDebug.hash()');
    hashes[st] = h;
  }
  const uniq = new Set(Object.values(hashes));
  if (uniq.size >= Math.max(10, Math.floor(states.length * 0.7))) {
    ok(`动作画面互不相同：${states.length} 组里有 ${uniq.size} 个不同画面`);
  } else {
    bad(`动作画面重复太多：${states.length} 组只有 ${uniq.size} 个不同画面 → ` +
        JSON.stringify(hashes));
  }

  // ② 闲置调度要真的换动作
  await win.webContents.executeJavaScript(`window.__petDebug.set('idle'); null`);
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    await sleep(120);
    const s = await win.webContents.executeJavaScript('window.__petDebug.info().state');
    seen.add(s);
  }
  if (seen.size >= 2) ok('闲置调度会换动作：观察到 ' + [...seen].join(' → '));
  else bad('闲置调度没换动作（一直停在 ' + [...seen].join(',') + '）');

  // ③ 悬停期间要轮播动作（这是用户抱怨的核心）
  await win.webContents.executeJavaScript('window.__petDebug.hover(true)');
  const seenHover = new Set();
  for (let i = 0; i < 16; i += 1) {
    await sleep(120);
    seenHover.add(await win.webContents.executeJavaScript('window.__petDebug.info().state'));
  }
  await win.webContents.executeJavaScript('window.__petDebug.hover(false)');
  if (seenHover.size >= 3) ok('悬停会轮播动作：观察到 ' + [...seenHover].join(' → '));
  else bad('悬停时动作太少（只看到 ' + [...seenHover].join(',') + '）');

  // ④a 侧面宠物按位置翻转（用户要求：拖到左半边应朝右）
  const dirInfo = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__petDebug.info())'));
  if (!dirInfo.sideView) {
    bad('manifest 没标 sideView，侧面宠物不会随位置转向');
  } else {
    await win.webContents.executeJavaScript(`window.__petDebug.set('idle', 1); window.__petDebug.setFacing(false); null`);
    await sleep(120);
    const leftHash = await win.webContents.executeJavaScript('window.__petDebug.hash()');
    await win.webContents.executeJavaScript('window.__petDebug.setFacing(true)');
    await sleep(120);
    const rightHash = await win.webContents.executeJavaScript('window.__petDebug.hash()');
    if (leftHash !== rightHash) ok('朝向翻转生效（朝左/朝右画面不同）');
    else bad('朝向翻转没生效：朝左与朝右画面一样');
  }

  // ⚠️ 前面的悬停/闲置轮播可能抽到"冲刺"，冲刺期间会**故意冻结**按位置调头 0.9s，
  //    这里先等它过去，否则测出来的是"被冻结"而不是"判定错"。
  await sleep(1100);

  // ④b 真实移动窗口：屏幕左半边应朝右、右半边应朝左（用户反馈"依旧没掉头"）
  const disp = require('electron').screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const probes = [
    { name: '屏幕左缘', x: wa.x + 4, expectRight: true },
    { name: '屏幕右缘', x: wa.x + wa.width - 204, expectRight: false },
  ];
  for (const pr of probes) {
    win.setPosition(pr.x, wa.y + 200);
    await sleep(350);
    const got = JSON.parse(await win.webContents.executeJavaScript(`(function () {
      window.__petDebug.set('idle');        // 归位并解除可能残留的冲刺冻结
      var before = window.__petDebug.info().faceRight;
      var sx = window.screenX;
      var right = window.__petDebug.updateFacing();
      return JSON.stringify({ screenX: sx, before: before, after: right, availW: window.screen.availWidth, availLeft: window.screen.availLeft });
    })()`));
    const okFacing = got.after === pr.expectRight;
    if (okFacing) ok(`${pr.name}：朝${pr.expectRight ? '右' : '左'} 判定正确（screenX=${got.screenX}）`);
    else bad(`${pr.name}：期望朝${pr.expectRight ? '右' : '左'}，实际 faceRight=${got.after}；` +
             `screenX=${got.screenX} availLeft=${got.availLeft} availW=${got.availW}`);
  }

  // ④c 冲刺划水：点一下默认动作 + 窗口真的窜出去半个屏幕（用户要求）
  await win.webContents.executeJavaScript(`window.__petDebug.set('idle'); null`);
  const hasDashBridge = await win.webContents.executeJavaScript('typeof window.dsh.petDash === "function"');
  if (hasDashBridge) ok('渲染层能请求冲刺（window.dsh.petDash 已暴露）');
  else bad('window.dsh.petDash 没暴露 —— 点了不会窜');
  const dashState = await win.webContents.executeJavaScript('window.__petDebug.dash()');
  if (dashState === 'dash') ok('点击默认动作 = 冲刺划水');
  else bad('点击默认动作不是冲刺，实际=' + dashState);

  // 冲刺不能被 pointerleave 掐断（窗口滑走必然触发 leave —— 用户实测的 bug）
  const afterLeave = await win.webContents.executeJavaScript(`(function () {
    window.__petDebug.set('idle');
    window.__petDebug.dash();
    document.getElementById('pet').dispatchEvent(new PointerEvent('pointerleave'));
    return window.__petDebug.info().state;
  })()`);
  if (afterLeave === 'dash') ok('冲刺不会被 pointerleave 掐断');
  else bad('冲刺被 pointerleave 掐断了（状态=' + afterLeave + '）');

  const petWin = pet.create();
  const { screen: scr } = require('electron');
  const wa2 = scr.getPrimaryDisplay().workArea;
  petWin.setPosition(wa2.x + 20, wa2.y + 300);
  await sleep(120);
  pet.dash(1);                       // 朝右冲
  await sleep(1000);
  const moved = petWin.getBounds().x - (wa2.x + 20);
  if (moved > wa2.width * 0.35) ok(`冲刺真的窜出去了：位移 ${moved}px（屏幕宽 ${wa2.width}）`);
  else bad(`冲刺没窜出去：位移只有 ${moved}px`);

  // ④ 拖拽分级倍率
  await win.webContents.executeJavaScript(`window.__petDebug.set('fast-running-right', 0.55); null`);
  const fast = JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__petDebug.info())'));
  const walkRow = JSON.parse(await win.webContents.executeJavaScript(
    `window.__petDebug.set('walking-right', 1.15); JSON.stringify(window.__petDebug.info())`));
  if (fast.speedMul === 0.55 && walkRow.speedMul === 1.15 && fast.row !== walkRow.row) {
    ok(`拖拽分级生效：快跑 row=${fast.row} 倍率=${fast.speedMul}；慢走 row=${walkRow.row} 倍率=${walkRow.speedMul}`);
  } else {
    bad('拖拽分级倍率不对：' + JSON.stringify({ fast, walkRow }));
  }
}

app.whenReady().then(async () => {
  try {
    await main();
  } catch (e) {
    bad('自检异常：' + (e && e.stack ? e.stack : String(e)));
  }
  console.log(failed === 0 ? '\n[pet-test] 全部通过 ✅' : `\n[pet-test] 失败 ${failed} 项 ❌`);
  app.exit(failed === 0 ? 0 : 1);
});
