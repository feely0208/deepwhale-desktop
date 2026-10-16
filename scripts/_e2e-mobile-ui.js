// E2E：① token 建 cookie → ② 打开我们插件的 /mobile/ → ③ 断言真实会话渲染 →
//      ④ 在页面里真的发一条消息 → ⑤ 断言会话页渲染出真实消息（核心回路）
// 透明不可见窗口，不打扰用户；DSH 由探针以 --no-open 启动。
const { app, BrowserWindow } = require('electron');
const os = require('os');
const pathMod = require('path');
// ⚠️ 每次运行用**隔离的 userData**：Electron 的 localStorage 会跨运行持久化，
//    上一次实验留下的"已配对"记录会让页面跳过连接页 → 断言假红/假绿（实测踩了很久）
app.setPath('userData', require('fs').mkdtempSync(pathMod.join(os.tmpdir(), 'dsh-e2e-userdata-')));
const fs = require('fs');
const SHOT_DIR = '/tmp/dsh-mobile-e2e';
const base = process.env.DSH_E2E_BASE;
const token = process.env.DSH_E2E_TOKEN;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 390, height: 844, opacity: 0, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  try {
    await w.loadURL(`${base}/?token=${token}`);   // 拿 DSH cookie
    await wait(1500);
    await w.loadURL(`${base}/mobile/`);           // 我们的手机端界面
  } catch (e) {
    console.log('E2E_RESULT ' + JSON.stringify({ error: 'load: ' + e.message }));
    app.exit(0);
    return;
  }
  await wait(3500);
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(`${SHOT_DIR}/list.png`, (await w.webContents.capturePage()).toPNG());
  } catch (e) {}

  const list = await w.webContents
    .executeJavaScript(`JSON.stringify({
      rows: document.querySelectorAll('.row-btn').length,
      firstId: (document.querySelector('.row-btn')||{dataset:{}}).dataset ? (document.querySelector('.row-btn')||{}).dataset.id : null,
      health: typeof window.dshMobileApi,
    })`)
    .catch((e) => JSON.stringify({ error: 'eval1: ' + e.message }));

  // ④ 发送一条真实消息（界面里的发送逻辑）
  await w.webContents
    .executeJavaScript(`window.dshMobileSend ? window.dshMobileSend('你好，报一下当前目录') : Promise.resolve({ok:false})`)
    .catch(() => {});
  await wait(8000);

  const chat = await w.webContents
    .executeJavaScript(`JSON.stringify({
      messages: document.querySelectorAll('#page-chat .msg').length,
      firstText: ((document.querySelector('#page-chat .msg')||{}).textContent || '').slice(0, 60),
      page: (document.getElementById('page-chat')||{}).hidden === false ? 'chat' : 'other',
    })`)
    .catch((e) => JSON.stringify({ error: 'eval2: ' + e.message }));

  try {
    fs.writeFileSync(`${SHOT_DIR}/chat.png`, (await w.webContents.capturePage()).toPNG());
  } catch (e) {}
  // ⑥ 轨迹 tab：点一下，断言渲染出事件行 + 出图
  await w.webContents
    .executeJavaScript(`(function(){var t=document.getElementById('tab-trace'); if(t) t.click(); return true;})()`)
    .catch(() => {});
  await wait(2500);
  const traj = await w.webContents
    .executeJavaScript(`JSON.stringify({
      rows: document.querySelectorAll('.traj-row').length,
      firstLabel: ((document.querySelector('.traj-badge')||{}).textContent || ''),
    })`)
    .catch((e) => JSON.stringify({ error: 'eval3: ' + e.message }));
  try {
    fs.writeFileSync(`${SHOT_DIR}/trajectory.png`, (await w.webContents.capturePage()).toPNG());
  } catch (e) {}

  let L = {}, C = {}, T = {};
  try { T = JSON.parse(traj); } catch (e) {}
  try { L = JSON.parse(list); } catch (e) {}
  try { C = JSON.parse(chat); } catch (e) {}
  console.log('E2E_RESULT ' + JSON.stringify(Object.assign({}, L, { chat: C, trajectory: T })));
  app.exit(0);
});
