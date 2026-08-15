import { BrowserWindow, app, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';

/**
 * 皮肤系统：
 * - 内置主题 = dist/skins/*.css（构建时从 src/skins 复制），菜单单选切换；
 * - 应用方式：insertCSS(css, { cssOrigin: 'author' })，切换前 removeInsertedCSS；
 * - 自定义 CSS：userData/custom.css，优先级最高，fs.watch 监听即时重注入。
 */
export class SkinManager {
  private insertedKeys: string[] = [];
  private watcher: fs.FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private readonly skinsDir = path.join(__dirname, '../skins');
  private readonly customCssFile = path.join(app.getPath('userData'), 'custom.css');

  constructor(private store: Store) {}

  /** 列出内置皮肤名（去掉 .css 后缀） */
  listSkins(): string[] {
    try {
      return fs
        .readdirSync(this.skinsDir)
        .filter((f) => f.endsWith('.css'))
        .map((f) => f.replace(/\.css$/, ''))
        .sort();
    } catch (e) {
      console.error('[skin] 读取皮肤目录失败:', e);
      return [];
    }
  }

  /** 应用当前皮肤 + 自定义 CSS（在 did-finish-load 后调用） */
  async apply(win: BrowserWindow): Promise<void> {
    await this.clear(win);
    this.stopWatch();

    const skin = this.store.get('skin');
    try {
      const css = fs.readFileSync(path.join(this.skinsDir, `${skin}.css`), 'utf-8');
      const key = await win.webContents.insertCSS(css, { cssOrigin: 'author' });
      this.insertedKeys.push(key);
    } catch (e) {
      console.error(`[skin] 皮肤 "${skin}" 加载失败（回退到无皮肤）:`, e);
    }

    if (this.store.get('customCssEnabled')) {
      await this.applyCustomCss(win);
      this.watchCustomCss(win);
    }
  }

  async setSkin(win: BrowserWindow, name: string): Promise<void> {
    this.store.set('skin', name);
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
