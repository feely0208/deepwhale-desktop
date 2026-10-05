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
import type { Store } from './store';
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

/**
 * 记住用户拖动后的位置（2026-10-04）
 *
 * 用户实测：弹窗无边框、抓哪儿都拖不动 → 加了拖拽区之后，必须把位置存下来，
 * 否则每次打开又回到居中，等于白拖。位置越界（换显示器/改分辨率）时自动回退。
 */
const POS_KEY = 'updatePopupPos';

/** 由 index.ts 注入的 store（与其它模块共用同一个实例，避免各自 new 出多份状态） */
let storeRef: Store | null = null;

export function bindUpdatePopupStore(s: Store): void {
  storeRef = s;
}

function savedPosition(): { x: number; y: number } | null {
  try {
    const p = storeRef?.get(POS_KEY as never) as { x?: number; y?: number } | undefined;
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return null;
    // 必须落在某个显示器的工作区内（否则窗口会开在看不见的地方）
    for (const d of screen.getAllDisplays()) {
      const a = d.workArea;
      const insideX = p.x >= a.x - 40 && p.x <= a.x + a.width - 80;
      const insideY = p.y >= a.y - 20 && p.y <= a.y + a.height - 60;
      if (insideX && insideY) return { x: Math.round(p.x), y: Math.round(p.y) };
    }
    return null;
  } catch {
    return null;
  }
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
  // 拖动结束就记住位置（debounce，避免拖动过程中频繁写盘）
  let saveTimer: NodeJS.Timeout | null = null;
  popup.on('moved', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        const w = popup;
        if (w && !w.isDestroyed()) {
          const [x, y] = w.getPosition();
          storeRef?.set(POS_KEY as never, { x, y } as never);
        }
      } catch {
        /* 忽略 */
      }
    }, 400);
  });
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
  const saved = savedPosition();
  try {
    if (saved) win.setPosition(saved.x, saved.y);
    else place(win);
  } catch (e) {
    // 定位失败绝不能影响弹窗显示（宁可位置默认，也不能不弹）
    console.warn('[update-popup] 定位失败，使用默认位置:', e);
  }
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
  const saved2 = savedPosition();
  try {
    if (saved2) win.setPosition(saved2.x, saved2.y);
    else place(win);
  } catch (e) {
    console.warn('[update-popup] 定位失败，使用默认位置:', e);
  }
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
  // 自己实现的拖拽：渲染层给出鼠标处的目标位置，这里设窗位（并夹在显示器工作区内）
  ipcMain.on('popup:move', (_e, x: number, y: number) => {
    const win = popup;
    if (!win || win.isDestroyed()) return;
    try {
      const [w, h] = win.getSize();
      const d = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) });
      const a = d.workArea;
      const nx = Math.min(Math.max(Math.round(x), a.x - 20), a.x + a.width - w + 20);
      const ny = Math.min(Math.max(Math.round(y), a.y - 10), a.y + a.height - h + 10);
      win.setPosition(nx, ny);
    } catch {
      /* 忽略拖动中的瞬时错误 */
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
