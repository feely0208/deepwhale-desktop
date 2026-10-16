// E2E：先用 token 建立 DSH cookie，再打开我们插件的 /mobile/，看真实会话是否渲染出来。
// 透明不可见窗口（show:false + opacity 0），不打扰用户。
const { app, BrowserWindow } = require('electron');
const base = process.env.DSH_E2E_BASE;      // http://127.0.0.1:PORT
const token = process.env.DSH_E2E_TOKEN;
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 390, height: 844, opacity: 0, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  try {
    await w.loadURL(`${base}/?token=${token}`);          // 拿 cookie
    await new Promise((r) => setTimeout(r, 1500));
    await w.loadURL(`${base}/mobile/`);                  // 我们的手机端界面
  } catch (e) { console.log('LOAD_ERR', e.message); }
  await new Promise((r) => setTimeout(r, 4000));
  const out = await w.webContents.executeJavaScript(`JSON.stringify({
    rows: document.querySelectorAll('.row-btn').length,
    firstTitle: (document.querySelector('.row-btn .title')||{}).textContent || null,
    firstId: (document.querySelector('.row-btn')||{}).dataset ? document.querySelector('.row-btn').dataset.id : null,
    health: typeof window.dshMobileApi,
  })`).catch((e) => 'EVAL_ERR ' + e.message);
  console.log('E2E_RESULT ' + out);
  app.exit(0);
});
