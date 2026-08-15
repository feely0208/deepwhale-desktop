import { BrowserWindow, app, nativeImage, nativeTheme, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';

/**
 * 皮肤系统（按用户需求重构）：
 * - 主题：原生界面 跟随系统 / 浅色 / 深色（nativeTheme.themeSource）；
 * - 背景皮肤：用户选择一张图片完全覆盖原界面——复制到 userData/skins/，
 *   对 html/body 做 cover 平铺，并把 DSH 界面层（--dsw-alias-*）改为半透明，
 *   让图片透出；透明度可调（skinOpacity 0.3~1）；
 * - 自定义 CSS：userData/custom.css 优先级最高，fs.watch 即时重注入。
 */
export class SkinManager {
  private insertedKeys: string[] = [];
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private readonly userSkinsDir = path.join(app.getPath('userData'), 'skins');
  private readonly customCssFile = path.join(app.getPath('userData'), 'custom.css');

  constructor(private store: Store) {}

  /** 应用当前主题 + 背景皮肤 + 自定义 CSS（did-finish-load 后调用） */
  async apply(win: BrowserWindow): Promise<void> {
    await this.clear(win);
    this.stopWatch();

    await this.applyBackground(win);

    if (this.store.get('customCssEnabled')) {
      await this.applyCustomCss(win);
      this.watchCustomCss(win);
    }
  }

  /** 设置原生界面主题（跟随系统/浅色/深色） */
  async setTheme(win: BrowserWindow, theme: 'system' | 'light' | 'dark'): Promise<void> {
    this.store.set('theme', theme);
    nativeTheme.themeSource = theme;
    await this.apply(win);
  }

  /** 选择背景图片：复制到 userData/skins/ 并应用 */
  async setBackgroundFromFile(win: BrowserWindow, srcPath: string): Promise<void> {
    const ext = path.extname(srcPath).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) {
      throw new Error('不支持的图片格式：' + ext);
    }
    fs.mkdirSync(this.userSkinsDir, { recursive: true });
    const dest = path.join(this.userSkinsDir, 'background' + ext);
    fs.copyFileSync(srcPath, dest);
    this.store.set('skinImage', 'background' + ext);
    await this.apply(win);
  }

  /** 移除背景皮肤 */
  async clearBackground(win: BrowserWindow): Promise<void> {
    this.store.set('skinImage', null);
    await this.apply(win);
  }

  /** 调整背景可见度（0.3~1） */
  async setOpacity(win: BrowserWindow, value: number): Promise<void> {
    const v = Math.min(1, Math.max(0.3, value));
    this.store.set('skinOpacity', v);
    await this.apply(win);
  }

  setCustomCssEnabled(win: BrowserWindow, enabled: boolean): Promise<void> {
    this.store.set('customCssEnabled', enabled);
    return this.apply(win);
  }

  /** 打开/创建自定义 CSS 文件（菜单项"自定义 CSS…"） */
  openCustomCss(): void {
    try {
      if (!fs.existsSync(this.customCssFile)) {
        fs.mkdirSync(path.dirname(this.customCssFile), { recursive: true });
        fs.writeFileSync(
          this.customCssFile,
          '/* 在此粘贴你的自定义 CSS，保存后即时生效 */\n',
          'utf-8'
        );
      }
      shell.openPath(this.customCssFile);
    } catch (e) {
      console.error('[skin] 打开自定义 CSS 失败:', e);
    }
  }

  /** 背景皮肤文件绝对路径（存在则返回，否则 null） */
  backgroundPath(): string | null {
    const name = this.store.get('skinImage');
    if (!name) return null;
    const file = path.join(this.userSkinsDir, name);
    return fs.existsSync(file) ? file : null;
  }

  /** 背景皮肤预览（data URI，供设置页展示；压缩到 600px 内） */
  backgroundPreviewDataUri(): string | null {
    const file = this.backgroundPath();
    if (!file) return null;
    return this.buildDataUri(file, 600);
  }

  /**
   * 把背景图编码为 data URI（http 页面禁止加载 file:// 子资源，必须内联）。
   * 用 nativeImage 压缩到 maxDim 内再编码，避免超大 CSS。
   * GIF 保留原样（可动图）。
   */
  private buildDataUri(file: string, maxDim: number): string | null {
    try {
      const ext = path.extname(file).toLowerCase();
      if (ext === '.gif') {
        const buf = fs.readFileSync(file);
        return 'data:image/gif;base64,' + buf.toString('base64');
      }
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) return null;
      const size = img.getSize();
      let resized = img;
      if (size.width > maxDim || size.height > maxDim) {
        const scale = maxDim / Math.max(size.width, size.height);
        resized = img.resize({
          width: Math.max(1, Math.round(size.width * scale)),
          height: Math.max(1, Math.round(size.height * scale)),
          quality: 'best',
        });
      }
      if (ext === '.jpg' || ext === '.jpeg') {
        const buf = resized.toJPEG(88);
        return 'data:image/jpeg;base64,' + buf.toString('base64');
      }
      const buf = resized.toPNG();
      return 'data:image/png;base64,' + buf.toString('base64');
    } catch (e) {
      console.error('[skin] 背景图编码失败:', e);
      return null;
    }
  }

  private async applyBackground(win: BrowserWindow): Promise<void> {
    const file = this.backgroundPath();
    if (!file) return;

    const alpha = Math.min(1, Math.max(0.3, this.store.get('skinOpacity')));
    const dark = nativeTheme.shouldUseDarkColors;
    const layer1 = dark ? `rgba(16, 18, 22, ${alpha})` : `rgba(255, 255, 255, ${alpha})`;
    const layer2 = dark ? `rgba(24, 27, 33, ${alpha})` : `rgba(244, 246, 248, ${alpha})`;
    const dataUri = this.buildDataUri(file, 2560);
    if (!dataUri) return;

    const css = `
      html, body {
        background-image: url("${dataUri}") !important;
        background-size: cover !important;
        background-position: center !important;
        background-repeat: no-repeat !important;
        background-attachment: fixed !important;
      }
      html { background-color: transparent !important; }
      body {
        background-color: transparent !important;
        --dsw-alias-bg-base: transparent !important;
        --dsw-alias-bg-layer-1: ${layer1} !important;
        --dsw-alias-bg-layer-2: ${layer2} !important;
        --dsw-alias-bg-overlay: ${layer1} !important;
        --dsw-specific-sidebar-fill: ${layer2} !important;
        --dsw-specific-sidebar-nav-item-active: ${dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'} !important;
        --dsw-specific-sidebar-nav-item-hover: ${dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'} !important;
      }
    `;
    try {
      const key = await win.webContents.insertCSS(css, { cssOrigin: 'author' });
      this.insertedKeys.push(key);
    } catch (e) {
      console.error('[skin] 背景皮肤应用失败:', e);
    }
  }

  private async applyCustomCss(win: BrowserWindow): Promise<void> {
    try {
      const css = fs.readFileSync(this.customCssFile, 'utf-8');
      if (css.trim()) {
        const key = await win.webContents.insertCSS(css, { cssOrigin: 'author' });
        this.insertedKeys.push(key);
      }
    } catch (e) {
      console.error('[skin] 自定义 CSS 应用失败:', e);
    }
  }

  private watchCustomCss(win: BrowserWindow): void {
    try {
      this.watcher = fs.watch(this.customCssFile, () => {
        if (this.watchTimer) clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => void this.apply(win), 200);
      });
    } catch (e) {
      console.error('[skin] 监听 custom.css 失败:', e);
    }
  }

  private stopWatch(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
  }

  private async clear(win: BrowserWindow): Promise<void> {
    for (const key of this.insertedKeys) {
      try {
        await win.webContents.removeInsertedCSS(key);
      } catch {
        // 页面已导航，忽略
      }
    }
    this.insertedKeys = [];
  }
}
