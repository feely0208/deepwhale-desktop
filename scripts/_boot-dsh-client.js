// 以"透明不可见"窗口加载一次官方客户端（不打扰用户：show:false + opacity 0 + 不聚焦）
const { app, BrowserWindow } = require('electron');
const os = require('os');
const pathMod = require('path');
// ⚠️ 每次运行用**隔离的 userData**：Electron 的 localStorage 会跨运行持久化，
//    上一次实验留下的"已配对"记录会让页面跳过连接页 → 断言假红/假绿（实测踩了很久）
app.setPath('userData', require('fs').mkdtempSync(pathMod.join(os.tmpdir(), 'dsh-e2e-userdata-')));
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
