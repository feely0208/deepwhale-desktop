import { app, BrowserWindow, Menu, MenuItemConstructorOptions, ipcMain, screen, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';

/**
 * 桌面宠物：透明无边框置顶小窗口。
 * - 默认宠物：内置 Codex 风格 SVG 团子（CSS 动画）；
 * - 自定义宠物：放在用户宠物目录（userData/pets）里的 .gif 或 .svg，
 *   首次启动自动把内置示例（cat/frog/模板）复制过去，托盘菜单可"打开宠物目录"；
 * - 拖拽：页面 mousedown/mousemove → IPC → 主进程用光标位置 + 记录偏移 setPosition
 *   （不用 -webkit-app-region: drag，它会吞掉右键事件）；
 * - 右键菜单：IPC 通知主进程弹原生 Menu；
 * - 穿透点击：win.setIgnoreMouseEvents(true, { forward: true })。
 */
export class PetWindow {
  private win: BrowserWindow | null = null;
  private dragOffset: { x: number; y: number } | null = null;
  /** 打包内置宠物（app.asar 内，只读） */
  private readonly builtinPetsDir = path.join(__dirname, '../assets/pets');

  constructor(private store: Store) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** 用户宠物目录（可写）：首次启动时用内置示例填充 */
  userPetsDir(): string {
    return path.join(app.getPath('userData'), 'pets');
  }

  ensureUserPetsDir(): void {
    try {
      const dir = this.userPetsDir();
      if (fs.existsSync(dir)) return;
      fs.mkdirSync(dir, { recursive: true });
      for (const f of fs.readdirSync(this.builtinPetsDir)) {
        fs.copyFileSync(path.join(this.builtinPetsDir, f), path.join(dir, f));
      }
      console.log('[pet] 已初始化用户宠物目录:', dir);
    } catch (e) {
      console.error('[pet] 初始化宠物目录失败:', e);
    }
  }

  /** 在访达中打开用户宠物目录（不存在则先创建） */
  openPetsFolder(): void {
    this.ensureUserPetsDir();
    void shell.openPath(this.userPetsDir());
  }

  /** SVG 宠物预览（data URI，供设置页展示）；GIF 不支持预览返回 null */
  previewDataUri(): string | null {
    const name = this.store.get('petGif');
    if (!name || !/\.svg$/i.test(name)) return null;
    try {
      const buf = fs.readFileSync(path.join(this.userPetsDir(), name));
      return 'data:image/svg+xml;base64,' + buf.toString('base64');
    } catch {
      return null;
    }
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

    const file = this.store.get('petGif');
    void win.loadFile(path.join(__dirname, '../pet/pet.html'), {
      query: file ? { src: this.petFileUrl(file) } : {},
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
    const file = this.store.get('petGif');
    this.window?.loadFile(path.join(__dirname, '../pet/pet.html'), {
      query: file ? { src: this.petFileUrl(file) } : {},
    });
  }

  /** 列出用户宠物目录下的 .gif / .svg */
  listPets(): string[] {
    try {
      return fs
        .readdirSync(this.userPetsDir())
        .filter((f) => /\.(gif|svg)$/i.test(f))
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

    ipcMain.on('pet:select-pet', (_e, name: string | null) => {
      this.store.set('petGif', name);
      this.reload();
    });
  }

  private petFileUrl(name: string): string {
    return 'file://' + path.join(this.userPetsDir(), name).replace(/ /g, '%20');
  }

  private showContextMenu(): void {
    const pets = this.listPets();
    const current = this.store.get('petGif');

    const petItems: MenuItemConstructorOptions[] = [
      {
        label: '默认宠物（橙色小团子）',
        type: 'radio',
        checked: !current,
        click: () => {
          this.store.set('petGif', null);
          this.reload();
        },
      },
      ...pets.map(
        (p): MenuItemConstructorOptions => ({
          label: p,
          type: 'radio',
          checked: current === p,
          click: () => {
            this.store.set('petGif', p);
            this.reload();
          },
        })
      ),
    ];

    const template: MenuItemConstructorOptions[] = [
      { label: '宠物皮肤', submenu: petItems },
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
      { label: '打开宠物目录…', click: () => this.openPetsFolder() },
      { label: '隐藏宠物', click: () => this.hide() },
    ];

    Menu.buildFromTemplate(template).popup({ window: this.window ?? undefined });
  }
}
