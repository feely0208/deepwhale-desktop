// 以"透明不可见"窗口加载一次官方客户端（不打扰用户：show:false + opacity 0 + 不聚焦）
const { app, BrowserWindow } = require('electron');
const url = process.env.DSH_BOOT_URL;
const ms = Number(process.env.DSH_BOOT_MS || 20000);
app.whenReady().then(async () => {
  const w = new BrowserWindow({
    show: false, width: 1200, height: 800, opacity: 0, focusable: false, skipTaskbar: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false },
  });
  try { await w.loadURL(url); } catch (e) {}
  setTimeout(() => app.exit(0), ms);
});
