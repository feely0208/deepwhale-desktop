import { BrowserWindow, shell } from 'electron';
import * as path from 'path';

export interface MainWindowOptions {
  port: number;
  closeToTray: boolean;
  /** 是否正在退出（app 真正退出时放行 close 事件） */
  isQuitting: () => boolean;
  /** did-finish-load（含导航后重新触发）回调：应用皮肤 + 注入用量面板 */
  onPageReady: (win: BrowserWindow) => void;
}

/** 主窗口：加载本地 DSH Web UI */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepWhale Desktop',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../assets/icons/icon.png'),
    backgroundColor: '#0f1115',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

  // 注意：DSH 页面由 index.ts 在服务就绪后加载（先显示"启动中"页面，避免冷启动无窗口）

  // 外部链接交给系统浏览器，不在应用内打开
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // 皮肤/用量面板注入时机（含导航后重新触发）
  win.webContents.on('did-finish-load', () => options.onPageReady(win));

  // 关窗口：默认最小化到托盘而非退出（真正退出时放行）
  win.on('close', (e) => {
    if (options.closeToTray && !options.isQuitting()) {
      e.preventDefault();
      win.hide();
    }
  });

  win.on('closed', () => {
    // 窗口已销毁（真正退出时）
  });

  return win;
}
