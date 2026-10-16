// 独立 App 场景：打开**本地**页面（与网关不同源）→ 走连接页 → 配对 → 断言列出会话
const { app, BrowserWindow } = require('electron');
const os = require('os');
const pathMod = require('path');
// ⚠️ 每次运行用**隔离的 userData**：Electron 的 localStorage 会跨运行持久化，
//    上一次实验留下的"已配对"记录会让页面跳过连接页 → 断言假红/假绿（实测踩了很久）
app.setPath('userData', require('fs').mkdtempSync(pathMod.join(os.tmpdir(), 'dsh-e2e-userdata-')));
const fs = require('fs');
const uiUrl = process.env.DSH_UI_URL;
const gwOrigin = process.env.DSH_GW_ORIGIN;
const code = process.env.DSH_GW_CODE;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 390, height: 844, opacity: 0, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, webSecurity: true },
  });
  w.webContents.on('console-message', (_e, _l, msg) => console.log('PAGE ' + String(msg).slice(0, 200)));
  const result = { paired: false, rows: 0, showedConnect: false, firstId: null };
  try {
    w.webContents.on('console-message', (_e, _l, m) => console.log('  [页面]', String(m).slice(0, 160)));
    await w.loadURL(uiUrl);
    await wait(3000);
    const dbg = await w.webContents.executeJavaScript(`JSON.stringify({
      hasApi: typeof window.__dshMobile,
      hidden: document.getElementById('page-connect').hidden,
      apiObj: typeof window.dshMobileApi,
      proto: location.protocol + '//' + location.host,
    })`).catch((e) => 'EVAL_ERR ' + e.message);
    console.log('  DEBUG ' + dbg);
    result.showedConnect = await w.webContents.executeJavaScript(
      "!document.getElementById('page-connect').hidden",
    );
    // 像用户那样填地址 + 配对码，点「连接」
    const pair = await w.webContents.executeJavaScript(
      `(async () => {
        document.getElementById('conn-origin').value = ${JSON.stringify(gwOrigin)};
        document.getElementById('conn-code').value = ${JSON.stringify(code)};
        const r = await window.dshMobileConnect(${JSON.stringify(gwOrigin)}, ${JSON.stringify(code)});
        return JSON.stringify(r);
      })()`,
    );
    const pr = JSON.parse(pair);
    result.paired = !!(pr && pr.ok);
    result.pairReason = pr && pr.reason;
    // 配对后：让界面拉真数据；若这台 DSH 还没有会话，就用官方 RPC 建一个
    if (result.paired) {
      await w.webContents.executeJavaScript(`window.dshMobileReload && window.dshMobileReload()`);
      await wait(1500);
      let n = await w.webContents.executeJavaScript("document.querySelectorAll('.row-btn').length").catch(() => 0);
      if (!n) {
        const cr = await w.webContents
          .executeJavaScript("window.dshMobileApi.create().then(function(r){return JSON.stringify(r);}).catch(function(e){return 'ERR '+e.message;})")
          .catch((e) => 'ERR ' + e.message);
        result.createResult = String(cr).slice(0, 300);
        await wait(1500);
        await w.webContents.executeJavaScript(`window.dshMobileReload && window.dshMobileReload()`);
        await wait(1500);
      }
    }
    const list = await w.webContents.executeJavaScript(`JSON.stringify({
      rows: document.querySelectorAll('.row-btn').length,
      firstId: (document.querySelector('.row-btn')||{dataset:{}}).dataset ? (document.querySelector('.row-btn')||{}).dataset.id : null,
    })`);
    Object.assign(result, JSON.parse(list));
    try {
      fs.mkdirSync('/tmp/dsh-mobile-e2e', { recursive: true });
      fs.writeFileSync('/tmp/dsh-mobile-e2e/standalone-list.png', (await w.webContents.capturePage()).toPNG());
    } catch (e) {}
  } catch (e) {
    result.error = e.message;
  }
  console.log('STANDALONE_RESULT ' + JSON.stringify(result));
  app.exit(0);
});
