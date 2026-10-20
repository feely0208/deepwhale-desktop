// Electron 驱动：Android 壳页面（Capacitor 的 web/index.html）握手流程断言
// 由 scripts/check-mobile-shell-android.js 拉起：env 提供 ANDROID_PAGE / GW / CODE
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-android-userdata-')));
const PAGE = process.env.ANDROID_PAGE;
const GW = process.env.GW;
const CODE = process.env.CODE;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 390, height: 844, opacity: 0, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  const out = { first: {}, second: {}, url: '' };
  try {
    // ① 首次：填地址+配对码 → 配对 → 跳 /mobile/ → 会话列出来
    await w.loadURL(PAGE);
    await wait(800);
    await w.webContents.executeJavaScript(`(function(){
      document.getElementById('serverUrl').value = ${JSON.stringify(GW)};
      document.getElementById('pairCode').value = ${JSON.stringify(CODE)};
      document.getElementById('connectBtn').click();
      return true;
    })()`);
    for (let i = 0; i < 30; i++) {
      await wait(500);
      if (/\/mobile\//.test(w.webContents.getURL())) break;
    }
    await wait(8000);
    out.first.url = w.webContents.getURL();
    out.first.diag = await w.webContents.executeJavaScript(`(async () => {
      try {
        var o = { href: location.href.slice(0, 100), hasUi: !!window.__dshMobile, state: {}, rows: null };
        if (window.__dshState) { try { o.state = window.__dshState(); } catch (e) {} }
        if (window.dshMobileApi && window.dshMobileApi.list) {
          try {
            var l = await window.dshMobileApi.list();
            o.rows = l && (l.rows || l.count || (l.sessions || []).length);
            o.listOk = !!(l && l.ok);
          } catch (e) { o.listErr = String(e && e.message ? e.message : e); }
        }
        return JSON.stringify(o);
      } catch (e) { return 'ERR ' + e.message; }
    })()`).catch((e) => 'EVAL_ERR ' + e.message);

    // ② 再进一次壳页面：有保存的令牌 → 应**自动**跳 /mobile/（不用再填任何东西）
    await w.loadURL(PAGE);
    await wait(4000);
    out.second.url = w.webContents.getURL();
    out.second.autoEntered = /\/mobile\//.test(out.second.url);
  } catch (e) {
    out.fatal = String(e && e.message ? e.message : e);
  }
  console.log('ANDROID_RESULT ' + JSON.stringify(out));
  app.exit(0);
});
