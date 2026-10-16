const { app, BrowserWindow } = require('electron');
const url = process.argv[2];
const ms = Number(process.env.DSH_CAPTURE_MS || 20000);
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 420, height: 900, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  try { await w.loadURL(url); } catch (e) { /* 页面加载失败也继续等 */ }
  setTimeout(() => app.exit(0), ms);
});
