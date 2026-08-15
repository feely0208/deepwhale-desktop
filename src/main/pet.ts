import { BrowserWindow, Menu, MenuItemConstructorOptions, ipcMain, screen } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';

/**
 * 桌面宠物：透明无边框置顶小窗口。
 * - 拖拽：页面 mousedown/mousemove → IPC → 主进程用光标位置 + 记录偏移 setPosition
 *   （不用 -webkit-app-region: drag，它会吞掉右键事件）；
 * - 右键菜单：IPC 通知主进程弹原生 Menu；
 * - 穿透点击：win.setIgnoreMouseEvents(true, { forward: true })。
 */
export class PetWindow {
  private win: BrowserWindow | null = null;
  private dragOffset: { x: number; y: number } | null = null;
  private readonly petsDir = path.join(__dirname, '../assets/pets');

  constructor(private store: Store) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  create(): BrowserWindow {
    const existing = this.window;
    if (existing) {
      existing.show();
      this.store.set('petVisible', true);
      return existing;
    }

    const win = new BrowserWindow({
      width: 180,
      height: 180,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, '../preload/preload.js'),
      },
    });

    const gif = this.store.get('petGif');
    void win.loadFile(path.join(__dirname, '../pet/pet.html'), {
      query: gif ? { gif } : {},
    });

    // 初始位置：主屏工作区右下角
    const { workArea } = screen.getPrimaryDisplay();
    win.setPosition(workArea.x + workArea.width - 220, workArea.y + workArea.height - 220);
    win.setAlwaysOnTop(true, 'screen-saver');

    if (this.store.get('clickThrough')) {
      win.setIgnoreMouseEvents(true, { forward: true });
    }

    this.win = win;
    win.on('closed', () => {
      this.win = null;
    });

    return win;
  }

  show(): void {
    this.store.set('petVisible', true);
    const win = this.create();
    win.show();
  }

  hide(): void {
    this.store.set('petVisible', false);
    this.window?.hide();
  }

  toggle(): void {
    if (this.window?.isVisible()) this.hide();
    else this.show();
  }

  reload(): void {
    const gif = this.store.get('petGif');
    this.window?.loadFile(path.join(__dirname, '../pet/pet.html'), {
      query: gif ? { gif } : {},
    });
  }

  /** 列出用户自定义 GIF（assets/pets/*.gif） */
  listGifs(): string[] {
    try {
      return fs
        .readdirSync(this.petsDir)
        .filter((f) => f.toLowerCase().endsWith('.gif'))
        .sort();
    } catch {
      return [];
    }
  }

  /** 注册宠物相关 IPC（应用启动时调用一次） */
  registerIpc(): void {
    ipcMain.on('pet:drag-start', () => {
      const win = this.window;
      if (!win) return;
      const cursor = screen.getCursorScreenPoint();
      const bounds = win.getBounds();
      this.dragOffset = { x: cursor.x - bounds.x, y: cursor.y - bounds.y };
    });

    ipcMain.on('pet:drag-move', () => {
      const win = this.window;
      if (!win || !this.dragOffset) return;
      const cursor = screen.getCursorScreenPoint();
      win.setPosition(cursor.x - this.dragOffset.x, cursor.y - this.dragOffset.y);
    });

    ipcMain.on('pet:drag-end', () => {
      this.dragOffset = null;
    });

    ipcMain.on('pet:context-menu', () => {
      this.showContextMenu();
    });

    ipcMain.on('pet:select-gif', (_e, name: string | null) => {
      this.store.set('petGif', name);
      this.reload();
    });
  }

  private showContextMenu(): void {
    const gifs = this.listGifs();
    const current = this.store.get('petGif');

    const gifItems: MenuItemConstructorOptions[] = [
      {
        label: '默认宠物（CSS 动画）',
        type: 'radio',
        checked: !current,
        click: () => {
          this.store.set('petGif', null);
          this.reload();
        },
      },
      ...gifs.map(
        (g): MenuItemConstructorOptions => ({
          label: g,
          type: 'radio',
          checked: current === g,
          click: () => {
            this.store.set('petGif', g);
            this.reload();
          },
        })
      ),
    ];

    const template: MenuItemConstructorOptions[] = [
      { label: '宠物皮肤', submenu: gifItems },
      { type: 'separator' },
      {
        label: '穿透点击',
        type: 'checkbox',
        checked: this.store.get('clickThrough'),
        click: (item) => {
          this.store.set('clickThrough', item.checked);
          this.window?.setIgnoreMouseEvents(item.checked, { forward: true });
        },
      },
      { label: '隐藏宠物', click: () => this.hide() },
    ];

    Menu.buildFromTemplate(template).popup({ window: this.window ?? undefined });
  }
}
