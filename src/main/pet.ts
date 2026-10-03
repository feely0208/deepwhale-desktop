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
  /** 冲刺滑行的动画定时器 */
  private dashTimer: NodeJS.Timeout | null = null;
  /** 宠物素材文件监视（素材一变自动重载，改图不用重启/切宠物） */
  private spriteWatcher: fs.FSWatcher | null = null;
  private spriteWatchTimer: NodeJS.Timeout | null = null;

  constructor(private store: Store) {}

  get window(): BrowserWindow | null {
    return this.win && !this.win.isDestroyed() ? this.win : null;
  }

  /** 用户宠物目录（可写）：首次启动时用内置示例填充（文件 + 帧动画宠物目录） */
  userPetsDir(): string {
    return path.join(app.getPath('userData'), 'pets');
  }

  /**
   * 确保内置宠物（app.asar 内）已就位到用户宠物目录。
   *
   * ⚠️ 2026-10-03 踩坑：原来"已存在就完全不动"，导致**内置宠物永远更新不了** ——
   *    用户机器上留着一份旧副本（旧 manifest：没有 sideView、没有翻跟头、帧率也旧），
   *    新版本启动后读的还是那份旧的，表现为"新功能全都没生效"
   *    （用户实测：拖到左边不掉头、看不到翻跟头）。
   *    现在改成**按文件新旧同步**：缺文件、或内置文件比用户目录里的新 → 覆盖；
   *    用户自己改过（mtime 更新）或自己加的宠物 → 一律不动。
   *    "想自定义内置宠物就复制一份改名"——这条写进 README 的宠物说明。
   *
   * 不用 fs.cpSync —— 它在 Electron 的 asar 虚拟文件系统下不可靠（asar 内目录无法被
   * cpSync 递归拷贝，导致内置宠物 spritesheet/manifest 拷不出来，宠物只显示 'pet' 占位）。
   * 改为 readdirSync + mkdirSync + copyFileSync 逐文件递归复制（三者 asar 均支持）。
   */
  ensureUserPetsDir(): void {
    try {
      const dir = this.userPetsDir();
      fs.mkdirSync(dir, { recursive: true });
      let copied = 0;
      for (const entry of fs.readdirSync(this.builtinPetsDir, { withFileTypes: true })) {
        const src = path.join(this.builtinPetsDir, entry.name);
        const dest = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          copied += syncDirIfNewer(src, dest) ? 1 : 0;
        } else if (shouldCopy(src, dest)) {
          fs.copyFileSync(src, dest);
          copied += 1;
        }
      }
      console.log(`[pet] 用户宠物目录已就位: ${dir}${copied ? `（本次更新了 ${String(copied)} 项内置宠物）` : ''}`);
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

    const scale = Math.min(2, Math.max(0.6, this.store.get('petScale')));
    const win = new BrowserWindow({
      width: Math.round(180 * scale),
      height: Math.round(180 * scale),
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
    const frameMs = this.store.get('petFrameMs');
    void win.loadFile(path.join(__dirname, '../pet/pet.html'), {
      query: file
        ? this.isSpritePet(file)
          ? { sprite: file, frameMs: String(frameMs) }
          : { src: this.petFileUrl(file) }
        : {},
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
    this.watchCurrentPet();

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
    const frameMs = this.store.get('petFrameMs');
    this.window?.loadFile(path.join(__dirname, '../pet/pet.html'), {
      query: file
        ? this.isSpritePet(file)
          ? { sprite: file, frameMs: String(frameMs) }
          : { src: this.petFileUrl(file) }
        : {},
    });
    this.watchCurrentPet();
  }

  /**
   * 冲刺划水：把宠物窗口朝 direction（+1 右 / -1 左）缓动滑出去约半个屏幕。
   *
   * 为什么放在主进程：宠物是独立小窗，渲染层改不了自己的位置；而"真的窜出去"
   * 正是用户要的观感（"滑水能不能直接窜半个屏幕"），顺带避免和"按位置调头"起冲突 ——
   * 冲完落到另一半，朝向判定自然变成面向屏幕中间。
   * 贴边时会自动反向，保证每次都能窜出去一段；滑完不做任何朝向假设，交给渲染层按新位置判定。
   */
  dash(direction: number): void {
    const win = this.window;
    if (!win) return;
    const dir = direction === 1 ? 1 : -1;
    const b = win.getBounds();
    const { workArea } = screen.getDisplayMatching(b);
    const maxX = workArea.x + workArea.width - b.width;
    const travel = Math.round(workArea.width * 0.5);
    let targetX = b.x + dir * travel;
    if (targetX < workArea.x || targetX > maxX) {
      targetX = b.x - dir * travel; // 贴边了就反向窜，别原地不动
    }
    targetX = Math.max(workArea.x, Math.min(maxX, targetX));
    const startX = b.x;
    const dx = targetX - startX;
    if (Math.abs(dx) < 40) return; // 实在没地方去就算了

    const DURATION = 760;
    const t0 = Date.now();
    if (this.dashTimer) clearInterval(this.dashTimer);
    // 缓出（起步快、收尾滑停），像真的冲出去再滑住
    this.dashTimer = setInterval(() => {
      const w = this.window;
      if (!w) {
        this.stopDash();
        return;
      }
      const p = Math.min(1, (Date.now() - t0) / DURATION);
      const ease = 1 - (1 - p) * (1 - p);
      const cb = w.getBounds();
      w.setPosition(Math.round(startX + dx * ease), cb.y);
      if (p >= 1) this.stopDash();
    }, 16);
  }

  private stopDash(): void {
    if (this.dashTimer) clearInterval(this.dashTimer);
    this.dashTimer = null;
  }

  /** 应用宠物配置（帧率/大小）：更新窗口尺寸并重载 */
  applyConfig(): void {
    const win = this.window;
    if (!win) return;
    const scale = Math.min(2, Math.max(0.6, this.store.get('petScale')));
    const w = Math.round(180 * scale);
    const h = Math.round(180 * scale);
    // 保持右下角位置不变
    const b = win.getBounds();
    win.setBounds({ x: b.x + b.width - w, y: b.y + b.height - h, width: w, height: h });
    this.reload();
  }

  /**
   * 盯着"当前宠物"的素材文件：一变就重载宠物窗口。
   *
   * 为什么要它：素材是在宠物窗口加载时读一次并常驻内存的，改完素材必须手动
   * "切一下宠物"或重启才生效 —— 我们自己迭代素材时被这个绊了好几次
   * （用户实测："水花是肉眼见大，划水还是之前一样"，就是因为没重载）。
   * 用 fs.watch（macOS 支持 recursive），300ms 去抖，只认当前宠物名下的变化。
   */
  private watchCurrentPet(): void {
    const name = this.store.get('petGif');
    try {
      if (this.spriteWatcher) {
        this.spriteWatcher.close();
        this.spriteWatcher = null;
      }
      if (!name) return;
      const dir = this.userPetsDir();
      this.spriteWatcher = fs.watch(dir, { recursive: true }, (_ev, filename) => {
        const f = filename ? String(filename) : '';
        // 只看当前宠物自己的文件；其它宠物/无关文件不动
        if (f && !f.startsWith(name)) return;
        if (this.spriteWatchTimer) clearTimeout(this.spriteWatchTimer);
        this.spriteWatchTimer = setTimeout(() => {
          this.spriteWatchTimer = null;
          console.log('[pet] 监测到素材变化，自动重载:', f || name);
          this.reload();
        }, 300);
      });
    } catch (e) {
      console.error('[pet] 素材监视启动失败（不影响使用）:', e);
    }
  }

  /** 是否为帧动画宠物（目录内含 manifest.json） */
  isSpritePet(name: string): boolean {
    try {
      return fs.existsSync(path.join(this.userPetsDir(), name, 'manifest.json'));
    } catch {
      return false;
    }
  }

  /** 列出用户宠物目录下的宠物（文件 + 帧动画宠物目录；排除工坊模板） */
  listPets(): string[] {
    const names: string[] = [];
    try {
      names.push(
        ...fs
          .readdirSync(this.userPetsDir())
          .filter((f) => /\.(gif|svg|png|jpe?g|webp)$/i.test(f) && !/template/i.test(f))
          .sort()
      );
    } catch {
      // ignore
    }
    try {
      for (const d of fs.readdirSync(this.userPetsDir(), { withFileTypes: true })) {
        if (
          d.isDirectory() &&
          fs.existsSync(path.join(this.userPetsDir(), d.name, 'manifest.json')) &&
          !/template/i.test(d.name)
        ) {
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
      this.stopDash(); // 用户上手拖了，冲刺立刻让位
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

    // 冲刺划水：宠物页报上"往哪边冲"，主进程把窗口缓动滑过去半个屏幕。
    // 为什么必须主进程移：宠物是独立小窗，渲染层动不了自己的位置；而且"真的窜出去"
    // 正是用户要的观感，顺带避免和"按位置调头"打架（冲完落到另一边，朝向判定自然
    // 变成面向屏幕中间）。
    ipcMain.on('pet:dash', (_e, direction: number) => {
      this.dash(direction);
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

    const petItems: MenuItemConstructorOptions[] = pets.map(
      (p): MenuItemConstructorOptions => ({
        label: p,
        type: 'radio',
        checked: current === p,
        click: () => {
          this.store.set('petGif', p);
          this.reload();
        },
      })
    );

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

/** 递归复制目录（逐文件），用于从 asar 内置宠物目录拷到用户目录。
 *  避免用 fs.cpSync —— 其在 Electron 的 asar 虚拟文件系统下无法递归拷贝。 */
function copyDirSync(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirSync(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** 目标不存在、或内置文件比目标新（>1s 容差）→ 需要复制 */
function shouldCopy(src: string, dest: string): boolean {
  try {
    const s = fs.statSync(src);
    let d: fs.Stats;
    try {
      d = fs.statSync(dest);
    } catch {
      return true; // 目标缺失
    }
    return s.mtimeMs > d.mtimeMs + 1000;
  } catch {
    return false; // 源读不到（asar 异常）就别动
  }
}

/** 按文件新旧同步一个内置宠物目录；返回是否真的更新过 */
function syncDirIfNewer(src: string, dest: string): boolean {
  let changed = false;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      changed = syncDirIfNewer(s, d) || changed;
    } else if (shouldCopy(s, d)) {
      fs.copyFileSync(s, d);
      // 保持时间戳，避免"内置比目标新"的判断每次都成立
      try {
        const st = fs.statSync(s);
        fs.utimesSync(d, st.atime, st.mtime);
      } catch {
        /* 时间戳设置失败无所谓 */
      }
      changed = true;
    }
  }
  return changed;
}
