import { app, BrowserWindow, Menu, MenuItemConstructorOptions, ipcMain, nativeImage, screen, shell } from 'electron';
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

  /** 宠物预览（data URI，供设置页展示）：SVG 直接读；帧动画宠物读目录 preview.png；其余返回 null */
  previewDataUri(): string | null {
    const name = this.store.get('petGif');
    if (!name) return null;
    try {
      if (/\.svg$/i.test(name)) {
        const buf = fs.readFileSync(path.join(this.userPetsDir(), name));
        return 'data:image/svg+xml;base64,' + buf.toString('base64');
      }
      if (this.isSpritePet(name)) {
        const p = path.join(this.userPetsDir(), name, 'preview.png');
        if (fs.existsSync(p)) {
          const buf = fs.readFileSync(p);
          return 'data:image/png;base64,' + buf.toString('base64');
        }
      }
    } catch {
      // ignore
    }
    return null;
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
      query: file ? (this.isSpritePet(file) ? { sprite: file } : { src: this.petFileUrl(file) }) : {},
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
      query: file ? (this.isSpritePet(file) ? { sprite: file } : { src: this.petFileUrl(file) }) : {},
    });
  }

  /** 是否为帧动画宠物（目录内含 manifest.json） */
  isSpritePet(name: string): boolean {
    try {
      return fs.existsSync(path.join(this.userPetsDir(), name, 'manifest.json'));
    } catch {
      return false;
    }
  }

  /** 列出用户宠物目录下的宠物（文件 + 帧动画宠物目录） */
  listPets(): string[] {
    const names: string[] = [];
    try {
      names.push(
        ...fs
          .readdirSync(this.userPetsDir())
          .filter((f) => /\.(gif|svg|png|jpe?g|webp)$/i.test(f))
          .sort()
      );
    } catch {
      // ignore
    }
    try {
      for (const d of fs.readdirSync(this.userPetsDir(), { withFileTypes: true })) {
        if (d.isDirectory() && fs.existsSync(path.join(this.userPetsDir(), d.name, 'manifest.json'))) {
          names.push(d.name);
        }
      }
    } catch {
      // ignore
    }
    return names.sort();
  }

  /**
   * 导入图片生成宠物：自动去除白色背景 → 透明 PNG 存入宠物目录。
   * @returns 生成的文件名
   */
  importImageAsPet(srcPath: string): string {
    const base =
      path
        .basename(srcPath, path.extname(srcPath))
        .replace(/[^\w\u4e00-\u9fa5-]/g, '_')
        .slice(0, 40) || 'pet';
    const dest = path.join(this.userPetsDir(), base + '.png');
    const img = nativeImage.createFromPath(srcPath);
    if (img.isEmpty()) throw new Error('无法读取图片');
    const cleaned = removeWhiteBackground(img);
    fs.mkdirSync(this.userPetsDir(), { recursive: true });
    fs.writeFileSync(dest, cleaned.toPNG());
    return base + '.png';
  }

  /** 保存 SVG 宠物（宠物工坊） */
  saveSvgPet(name: string, svg: string): void {
    const safe = path.basename(name);
    fs.mkdirSync(this.userPetsDir(), { recursive: true });
    fs.writeFileSync(path.join(this.userPetsDir(), safe), svg, 'utf-8');
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

    // 帧动画宠物：返回 manifest + spritesheet data URI
    ipcMain.handle('pet:sprite-info', (_e, name: string) => {
      const dir = path.join(this.userPetsDir(), name);
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf-8'));
        const sheetFile = path.join(dir, 'spritesheet.png');
        if (!fs.existsSync(sheetFile)) return null;
        const buf = fs.readFileSync(sheetFile);
        return { manifest, sheetDataUri: 'data:image/png;base64,' + buf.toString('base64') };
      } catch (e) {
        console.error('[pet] 帧动画宠物加载失败:', e);
        return null;
      }
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

/** 去除近白背景 → 透明（BGRA 像素级处理），用于"图片生成宠物" */
function removeWhiteBackground(img: Electron.NativeImage): Electron.NativeImage {
  const size = img.getSize();
  const bitmap = img.toBitmap(); // BGRA
  const out = Buffer.from(bitmap);
  for (let i = 0; i < bitmap.length; i += 4) {
    if (bitmap[i + 3] === 0) continue; // 原透明保持
    const r = bitmap[i + 2];
    const g = bitmap[i + 1];
    const b = bitmap[i];
    const min = Math.min(r, g, b);
    let a = 255;
    if (min >= 240) a = 0;
    else if (min >= 215) a = Math.round(255 * ((255 - min) / 25));
    out[i + 3] = a;
  }
  return nativeImage.createFromBitmap(out, size);
}
