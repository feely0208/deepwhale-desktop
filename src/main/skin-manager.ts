import { BrowserWindow, app, nativeImage, nativeTheme, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { presetBackgroundCss, glowRemovalScript } from './skin-presets';

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
    // 自定义背景图优先；没设图时才用内置预设。
    // 这样"用户自己选过图"永远赢，不会被我们换默认背景时覆盖掉。
    const file = this.backgroundPath();
    if (!file) {
      await this.applyPreset(win);
      return;
    }
    // 用户自己选了图 —— 内置光斑层必须撤掉，否则会和图叠在一起
    await this.removeGlow(win);

    const alpha = Math.min(1, Math.max(0.3, this.store.get('skinOpacity')));
    const dataUri = this.buildDataUri(file, 2560);
    if (!dataUri) return;

    // 背景图放在 body::before（z-index:-1），滤镜只作用于背景图、不影响内容。
    // 深浅色模式都显示背景皮肤；层色/滤镜跟随 DSH 实时主题属性（data-ds-dark-theme），
    // 不改变 DSH 本身的基础深浅色外观。
    const css = `
      html { background-color: transparent !important; }
      body { background-color: transparent !important; --dsh-skin-alpha: ${alpha}; }
      body::before {
        content: '' !important;
        position: fixed !important;
        inset: 0 !important;
        z-index: -1 !important;
        background-image: url("${dataUri}") !important;
        background-size: cover !important;
        background-position: center !important;
        background-repeat: no-repeat !important;
        background-attachment: fixed !important;
        pointer-events: none !important;
      }
      /* 浅色：提亮背景图，白色半透明层（不改变浅色外观） */
      body:not([data-ds-dark-theme])::before {
        filter: brightness(1.38) saturate(0.95) !important;
      }
      /* ⚠️ 2026-10-04 修（用户截图：全屏时"怪异的大白页"、会话文字透上来）：
         这里原来写的是 CSS 变量 --dsw-alias-bg-base: transparent !important，但那个 token
         同时是**平台浮层 / onboarding 层的底色** —— DSH 自己的 CSS 形如
             [class*="overlay"] { background: var(--dsw-alias-bg-base); position: fixed; inset: 0 }
         一改透明，整片浮层就变成透明纸片（用户截图里那个"怪白页"）。
         正确做法：**只把框架层（frame / centerCol）改透明**，token 保持 DSH 默认值。 */
      /* ⚠️ 2026-10-04 修正（用户实机反馈"辉光给你搞没了"）：
         辉光/壁纸本来就是靠基础底色透明才透出来的 —— 之前为了修"浮层被掏空"直接
         不覆盖这个 token，结果连同辉光一起被 DSH 自己的实色盖住了。
         正确做法：**基础底色照旧透明**（辉光透出来）+ **单独把浮层补成不透明**（不被掏空）。 */
      body:not([data-ds-dark-theme]) {
        --dsw-alias-bg-base: transparent !important;
        --dsw-alias-bg-layer-1: rgba(255, 255, 255, var(--dsh-skin-alpha)) !important;
        --dsw-alias-bg-layer-2: rgba(244, 246, 248, var(--dsh-skin-alpha)) !important;
        --dsw-alias-bg-overlay: rgba(255, 255, 255, var(--dsh-skin-alpha)) !important;
        --dsw-specific-sidebar-fill: rgba(244, 246, 248, var(--dsh-skin-alpha)) !important;
        --dsw-specific-sidebar-nav-item-active: rgba(0, 0, 0, 0.06) !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(0, 0, 0, 0.04) !important;
      }
      body:not([data-ds-dark-theme]) [class*="sidebarCol"] {
        background: linear-gradient(to right, rgba(247, 248, 250, 0.94), rgba(247, 248, 250, 0.18)) !important;
      }
      /* 深色：壁纸必须压得够暗。只压到 0.92 的话，浅色壁纸（雾/白底图）会把
         整个内容区托成灰蓝，而侧栏和卡片是深色 → "只有模块是黑的、背景一片灰"。
         0.30 让壁纸退成质感，底色重新掌握在深色主题手里。 */
      body[data-ds-dark-theme]::before {
        filter: brightness(0.30) saturate(0.7) contrast(1.05) !important;
      }
      /* 深色：面板/卡片改为不透明。原来是 rgba(...,alpha) 半透明，壁纸会透上来，
         于是面板发灰、和黑色模块割裂——这正是用户反馈的观感问题。
         基础底色保持 transparent，壁纸只在"没有面板覆盖"的地方透出。 */
      /* 深色同理：基础底色透明（辉光透出来） */
      body[data-ds-dark-theme] {
        --dsw-alias-bg-base: transparent !important;
        --dsw-alias-bg-layer-1: #1c1f25 !important;
        --dsw-alias-bg-layer-2: #23272e !important;
        --dsw-alias-bg-overlay: #16191e !important;
        --dsw-specific-sidebar-fill: #16191e !important;
        --dsw-specific-sidebar-nav-item-active: rgba(255, 255, 255, 0.08) !important;
        --dsw-specific-sidebar-nav-item-hover: rgba(255, 255, 255, 0.05) !important;
      }
      /* ⚠️ 浮层必须单独补成不透明：DSH 的 [class*="overlay"] / onboarding 层
         用基础底色当背景且 position:fixed;inset:0 —— 底色透明了它们就变透明纸片
         （用户截图里那块"怪白页"）。两层主题各用各自的层色。 */
      body[data-ds-dark-theme] [class*="overlay"],
      body[data-ds-dark-theme] [class*="Overlay"] {
        background: #16191e !important;
      }
      body:not([data-ds-dark-theme]) [class*="overlay"],
      body:not([data-ds-dark-theme]) [class*="Overlay"] {
        background: rgba(255, 255, 255, 0.98) !important;
      }
      /* 侧栏改成不透明实色：原来的渐变尾端有 0.25 透明度，壁纸直接透进导航区。 */
      body[data-ds-dark-theme] [class*="sidebarCol"] {
        background: #14171c !important;
      }
    `;
    try {
      const key = await win.webContents.insertCSS(css, { cssOrigin: 'author' });
      this.insertedKeys.push(key);
    } catch (e) {
      console.error('[skin] 背景皮肤应用失败:', e);
    }
  }

  /**
   * 应用内置背景预设（纯 CSS，见 skin-presets.ts）。
   * 用户没设自己的背景图时，这就是"默认长什么样"。
   */
  private async applyPreset(win: BrowserWindow): Promise<void> {
    const preset = this.store.get('skinPreset');
    const css = presetBackgroundCss(preset);
    if (!css) {
      await this.removeGlow(win);
      return;
    }
    try {
      const key = await win.webContents.insertCSS(css, { cssOrigin: 'author' });
      this.insertedKeys.push(key);
    } catch (e) {
      console.error('[skin] 内置背景预设应用失败:', e);
    }
    // 光斑层用真 DOM 建（三层模糊半径不同，一个伪元素塞不下），见 skin-presets.ts
    try {
      // ★ 已改用纯 CSS 承载辉光（挂在 html 的 background 上）——
      //   原来这里插 DOM + z-index:-1，DSH 界面一改版就静默失效，
      //   用户升级到 1.0.28 后「背景变灰、蓝光没了」就是这个原因。
      //   现在和面板色走同一条 CSS 注入通道，不再依赖 DOM 结构。
      //   （保留 glowInjectionScript 导出仅作兜底，不再调用）
    } catch (e) {
      console.error('[skin] 内置背景光斑注入失败:', e);
    }
  }

  /** 移除光斑层（切"纯色"、或用户改用自己的背景图时）。 */
  private async removeGlow(win: BrowserWindow): Promise<void> {
    try {
      await win.webContents.executeJavaScript(glowRemovalScript());
    } catch {
      // 页面已导航，忽略
    }
  }

  /** 切换内置背景预设 */
  async setPreset(win: BrowserWindow, preset: 'none' | 'deepseek-blue'): Promise<void> {
    this.store.set('skinPreset', preset);
    await this.apply(win);
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
