/**
 * 更新弹窗（2026-10-04）
 *
 * 用户要求：
 *   ·「还有弹出更新面板应该在更新同时弹出，而不是藏在那个后面」
 *   ·「弹出的更新页面需要你精心设计一个，不要太敷衍的那种，用辉光底加一些你的创意就好」
 *   ·「更新内容在设置页面就不要显示了，增加一个选项按钮在帮助里面」
 *
 * 形态：一个无边框、圆角、置顶的小窗口（HTML/CSS 见 src/update-popup/），
 *   两个入口共用：
 *     A. 下载开始时自动弹出（进度 + 本版更新内容 + 「立即重启」）
 *     B. 帮助菜单「本版更新内容…」手动打开（只显示说明）
 * 关掉只是隐藏，不销毁，避免下次弹出闪烁；应用退出时随之销毁。
 */
import { BrowserWindow, ipcMain, screen, app } from 'electron';
import * as path from 'path';
import { notesFor, WhatsNewEntry } from './whatsnew';

interface PopupState {
  phase: string;
  percent: number | null;
  message?: string;
}

let popup: BrowserWindow | null = null;
/** 手动打开（帮助菜单）时为 true：不显示进度区，只显示说明 */
let notesOnly = false;
/** 当前显示的版本（弹窗请求重试说明时要用） */
let currentVersion = '';

function popupFile(): string {
  return path.join(__dirname, '../update-popup/update-popup.html');
}

/** 选一个「最像主屏」的显示器，把弹窗放在屏幕中上部（不遮挡输入区） */
function place(win: BrowserWindow): void {
  try {
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.workAreaSize;
    const [w] = win.getSize();
    const [, h] = win.getSize();
    win.setPosition(
      Math.round(display.workArea.x + (width - w) / 2),
      Math.round(display.workArea.y + Math.max(24, (height - h) * 0.18)),
    );
  } catch {
    /* 定位失败就用默认位置 */
  }
}

function ensurePopup(): BrowserWindow {
  if (popup && !popup.isDestroyed()) return popup;
  popup = new BrowserWindow({
    width: 560,
    height: 620,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: false,
    alwaysOnTop: true,
    hasShadow: true,
    title: '深鲸桌面 更新',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, '../preload/update-popup-preload.js'),
    },
  });
  void popup.loadFile(popupFile());
  popup.on('closed', () => {
    popup = null;
  });
  return popup;
}

function push(msg: Record<string, unknown>): void {
  const win = popup;
  if (!win || win.isDestroyed()) return;
  const send = (): void => {
    try {
      win.webContents.send('popup:msg', msg);
    } catch {
      /* 页面还没加载好，忽略 */
    }
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

/** 下载开始：弹窗 + 推状态 + 推本版说明 */
export async function showUpdatePopup(version: string, state: PopupState): Promise<void> {
  notesOnly = false;
  currentVersion = version;
  const win = ensurePopup();
  place(win);
  win.show();
  win.focus();
  try {
    win.setAlwaysOnTop(true, 'floating');
  } catch {
    /* 忽略 */
  }
  const notes = await notesFor(version);
  push({ type: 'notes', version, title: notes?.title, date: notes?.date, items: notes?.items ?? [] });
  push({ type: 'state', ...state });
}

/** 帮助菜单「本版更新内容…」：只显示说明 */
export async function showWhatsNewWindow(version: string): Promise<void> {
  notesOnly = true;
  currentVersion = version;
  const win = ensurePopup();
  place(win);
  win.setSize(560, 620);
  win.show();
  win.focus();
  const notes: WhatsNewEntry | null = await notesFor(version);
  push({ type: 'notes', version, title: notes?.title, date: notes?.date, items: notes?.items ?? [] });
  push({ type: 'state', phase: 'idle', percent: null });
}

/** 更新过程中的进度推送 */
export function updatePopupState(state: PopupState): void {
  if (notesOnly) return;
  const win = popup;
  if (!win || win.isDestroyed() || !win.isVisible()) return;
  push({ type: 'state', ...state });
  if (state.phase === 'idle' || state.phase === 'up-to-date' || state.phase === 'error') {
    // 更新结束/取消：收起弹窗，别一直挂在屏幕上
    setTimeout(() => {
      if (popup && !popup.isDestroyed() && !notesOnly) popup.hide();
    }, 1200);
  }
}

export function closeUpdatePopup(): void {
  if (popup && !popup.isDestroyed()) popup.hide();
}

/** 弹窗里的按钮回调（由 index.ts 注入实际动作） */
export interface UpdatePopupActions {
  onRestart: () => void;
  onLater: () => void;
}

export function registerUpdatePopupIpc(actions: UpdatePopupActions): void {
  ipcMain.on('popup:action', (_e, action: string) => {
    if (action === 'refresh-notes') {
      // 弹窗说"正在获取更新说明…"时，我们强制回源一次再推给它
      void (async () => {
        try {
          const n = await notesFor(currentVersion);
          push({ type: 'notes', version: currentVersion, title: n?.title, date: n?.date, items: n?.items ?? [] });
        } catch (e) {
          console.warn('[update-popup] 重试获取更新说明失败:', e);
        }
      })();
      return;
    }
    if (action === 'restart') {
      closeUpdatePopup();
      actions.onRestart();
    } else if (action === 'later') {
      closeUpdatePopup();
      actions.onLater();
    } else {
      closeUpdatePopup();
    }
  });
  ipcMain.on('popup:ready', () => {
    if (notesOnly) {
      const win = popup;
      if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, 'floating');
    }
  });
  app.on('before-quit', () => {
    if (popup && !popup.isDestroyed()) popup.destroy();
  });
}
