import { app, dialog, BrowserWindow, shell } from 'electron';
import { autoUpdater, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { needsManualUpdate } from './mac-signature';

/**
 * update-manager.ts — 应用自动更新（electron-updater + GitHub Releases）
 *
 * ── 设计原则（与深鲸桌面既有功能完全隔离） ─────────────────────────────
 *  1. **纯增量**：不读写 settings 之外的任何既有模块，不触碰法律模式、
 *     桌宠、皮肤、用量面板、授权等任何现有逻辑。
 *  2. **只在打包态启用**：开发态（未打包）直接跳过，避免干扰本地调试。
 *  3. **静默检查，用户确认后才下载**：不偷占用户带宽。
 *  4. **失败只记日志**：自动检查出错绝不弹窗打扰；只有用户主动点
 *     "检查更新"时才把失败讲清楚。
 *  5. **不破坏现有安装**：下载与校验由 electron-updater 负责，失败不会
 *     影响正在运行的版本。
 *
 * ── 更新源 ──────────────────────────────────────────────────────────
 *  由 `electron-builder.yml` 的 `publish.provider: github` 决定，
 *  即读取本仓库的 GitHub Releases（`releaseType: draft`，发布后需手动转正式）。
 */

/** 更新流程所处的阶段（供托盘/菜单展示） */
export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export interface UpdateState {
  phase: UpdatePhase;
  /** 新版本号（available / downloading / downloaded 时有值） */
  version?: string;
  /** 下载进度 0–100（downloading 时有值） */
  percent?: number;
  /** 面向用户的简短说明 */
  message?: string;
}

export interface UpdateManagerOptions {
  /** 取主窗口；返回 null 时使用无父窗口的对话框 */
  getWindow: () => BrowserWindow | null;
  /** 状态变化回调（用于刷新托盘/菜单文案） */
  onStateChange?: (state: UpdateState) => void;
  /**
   * 是否启用自动检查。默认仅打包态启用。
   * 显式传 true 可在开发态测试（但 electron-updater 在未打包时不可用）。
   */
  enabled?: boolean;
}

/** 自动检查的启动延迟：等应用完全可用后再查，避免和 DSH 启动争抢资源 */
const FIRST_CHECK_DELAY_MS = 15_000;
/** 自动检查间隔：6 小时 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 下载完成后，用户选择"稍后"时也不重复打扰的时长 */
const SNOOZE_MS = 12 * 60 * 60 * 1000;

/** 官网下载页：macOS 无法自动安装时给用户的出口（这是真能用的那一步） */
const DOWNLOAD_PAGE = 'https://deepwhale.org.cn/download.html';

/**
 * macOS 上是否只能手动下载安装。判定逻辑与依据见 ./mac-signature.ts。
 *
 * 一句话：我们的包是 ad-hoc 签名，Squirrel.Mac 在安装前会拿**运行中那版**的
 * designated requirement（= cdhash，每次构建都变）去校验新包，必然失败 ——
 * Electron 官方文档明说 macOS 自动更新要求 App 已签名。所以这里改成如实告知，
 * 并把用户送到下载页，而不是演一遍"下载完成 → 重启 → 什么都没发生"。
 *
 * 用**运行时探测**而不是写死 process.platform === 'darwin'：哪天真去签名了，
 * 这里会自动判定为"可以自动更新"，不需要回来改代码。
 */
let cachedNeedsManual: boolean | null = null;

function macNeedsManualUpdate(): boolean {
  if (cachedNeedsManual !== null) return cachedNeedsManual;
  cachedNeedsManual = needsManualUpdate(process.platform, () => {
    try {
      // process.execPath = <Xxx>.app/Contents/MacOS/<Xxx> → 往上三层就是 .app 本体
      const bundle = path.resolve(process.execPath, '..', '..', '..');
      const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], {
        encoding: 'utf8',
        timeout: 10_000,
      });
      // codesign -dv 把签名信息写在 stderr 上，所以要两边一起看
      const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
      return text === '' ? null : text;
    } catch {
      return null;
    }
  });
  return cachedNeedsManual;
}

export class UpdateManager {
  private readonly getWindow: () => BrowserWindow | null;
  private readonly onStateChange: ((state: UpdateState) => void) | undefined;

  private readonly enabled: boolean;
  private state: UpdateState = { phase: 'idle' };
  private firstTimer: NodeJS.Timeout | null = null;
  private intervalTimer: NodeJS.Timeout | null = null;
  private snoozeUntil = 0;
  private disposed = false;
  /** 正在等待用户答复，避免并发弹窗 */
  private prompting = false;

  constructor(options: UpdateManagerOptions) {
    this.getWindow = options.getWindow;
    this.onStateChange = options.onStateChange;
    this.enabled = options.enabled ?? app.isPackaged;
  }

  /** 启动自动检查（幂等：重复调用不会叠加定时器） */
  start(): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    this.wireEvents();

    // 更新源是本仓库的 GitHub Releases；autoDownload 关闭，改由用户确认
    autoUpdater.autoDownload = false;
    // 用户选择"稍后"时，退出应用顺带安装，避免反复打扰。
    // macOS 上不能这么做：那里根本装不上（Squirrel 的签名校验过不去，见 macNeedsManualUpdate），
    // 开着它只会在退出时白折腾一次，所以按平台关掉。
    autoUpdater.autoInstallOnAppQuit = !macNeedsManualUpdate();

    this.firstTimer = setTimeout(() => {
      void this.check(false);
    }, FIRST_CHECK_DELAY_MS);
    // 单次延迟定时器不应阻止应用退出
    this.firstTimer.unref?.();

    this.intervalTimer = setInterval(() => {
      void this.check(false);
    }, CHECK_INTERVAL_MS);
    this.intervalTimer.unref?.();
  }

  /** 停止定时器（应用退出时调用） */
  dispose(): void {
    this.disposed = true;
    if (this.firstTimer !== null) {
      clearTimeout(this.firstTimer);
      this.firstTimer = null;
    }
    if (this.intervalTimer !== null) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /** 当前状态（供托盘/菜单读取） */
  getState(): UpdateState {
    return this.state;
  }

  /**
   * 手动检查更新（用户主动点击）。
   * 与自动检查的区别：**会把结果如实告诉用户**，包括"已是最新"和失败原因。
   */
  async checkNow(): Promise<void> {
    if (!app.isPackaged) {
      await this.alert('检查更新', '开发模式下不检查更新。请在正式安装包中验证。');
      return;
    }
    await this.check(true);
  }

  // ── 内部实现 ────────────────────────────────────────────────────────

  private setState(next: UpdateState): void {
    this.state = next;
    this.onStateChange?.(next);
  }

  private async check(interactive: boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    // 处于下载中/已下载，不做重复检查
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded') {
      return;
    }
    // 自动检查时，若用户刚选择过"稍后"，跳过
    if (!interactive && Date.now() < this.snoozeUntil) {
      return;
    }

    this.setState({ phase: 'checking', message: '正在检查更新…' });
    try {
      const result = await autoUpdater.checkForUpdates();
      // 没有可用更新时，electron-updater 会在 update-not-available 事件里通知；
      // 这里同时兜底处理返回 null 的情况。
      if (result === null) {
        this.setState({ phase: 'up-to-date', message: '已是最新版本' });
        if (interactive) {
          await this.alert('检查更新', `当前已是最新版本（${app.getVersion()}）。`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[update] 检查更新失败:', error);
      this.setState({ phase: 'error', message });
      if (interactive) {
        await this.alert('检查更新失败', `无法连接到更新服务器。\n\n${message}`);
      }
    }
  }

  /** 事件只在首次 start 时绑定，避免重复注册 */
  private wired = false;

  private wireEvents(): void {
    if (this.wired) {
      return;
    }
    this.wired = true;

    autoUpdater.on('update-available', (info: UpdateInfo) => {
      void this.onAvailable(info);
    });

    autoUpdater.on('update-not-available', () => {
      this.setState({ phase: 'up-to-date', message: '已是最新版本' });
    });

    autoUpdater.on('download-progress', (progress: ProgressInfo) => {
      this.setState({
        phase: 'downloading',
        percent: Math.round(progress.percent),
        message: `正在下载 ${String(Math.round(progress.percent))}%`,
      });
    });

    autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
      void this.onDownloaded(info);
    });

    autoUpdater.on('error', (error: Error) => {
      // 自动检查/下载期间的错误只记日志，不打扰用户
      console.error('[update] 更新出错:', error);
      this.setState({ phase: 'error', message: error.message });
      this.prompting = false;
    });
  }

  private async onAvailable(info: UpdateInfo): Promise<void> {
    this.setState({
      phase: 'available',
      version: info.version,
      message: `发现新版本 ${info.version}`,
    });
    if (this.prompting) {
      return;
    }
    this.prompting = true;
    try {
      // macOS + 未签名：不能走"下载→重启安装"，那条路必然失败。如实告知并给下载页。
      if (macNeedsManualUpdate()) {
        this.setState({
          phase: 'available',
          version: info.version,
          message: `发现新版本 ${info.version}（macOS 需手动安装）`,
        });
        const choice = await this.confirm(
          '发现新版本',
          `深鲸桌面 ${info.version} 已发布（当前 ${app.getVersion()}）。\n\n` +
            'macOS 版需要手动下载安装：当前安装包未做苹果开发者签名，' +
            '系统会拒绝自动替换应用，所以这里没法替你完成这一步（不是网络问题）。\n\n' +
            '要现在打开下载页吗？',
          ['打开下载页', '稍后再说'],
        );
        if (choice === 0) {
          await shell.openExternal(DOWNLOAD_PAGE);
        } else {
          this.snoozeUntil = Date.now() + SNOOZE_MS;
        }
        this.setState({ phase: 'idle' });
        return;
      }

      const choice = await this.confirm(
        '发现新版本',
        `深鲸桌面 ${info.version} 已发布（当前 ${app.getVersion()}）。\n\n是否现在下载？下载过程不影响你继续使用。`,
        ['立即下载', '稍后再说'],
      );
      if (choice === 0) {
        this.setState({ phase: 'downloading', percent: 0, message: '正在下载…' });
        try {
          await autoUpdater.downloadUpdate();
        } catch (error) {
          console.error('[update] 下载更新失败:', error);
          await this.alert('下载失败', error instanceof Error ? error.message : String(error));
          this.setState({ phase: 'error' });
        }
      } else {
        // 用户选择稍后：推迟一段时间再提示
        this.snoozeUntil = Date.now() + SNOOZE_MS;
        this.setState({ phase: 'idle' });
      }
    } finally {
      this.prompting = false;
    }
  }

  private async onDownloaded(info: UpdateInfo): Promise<void> {
    this.setState({
      phase: 'downloaded',
      version: info.version,
      percent: 100,
      message: `新版本 ${info.version} 已就绪`,
    });
    if (this.prompting) {
      return;
    }
    this.prompting = true;
    try {
      const choice = await this.confirm(
        '更新已就绪',
        `深鲸桌面 ${info.version} 已下载完成。\n\n重启后即可使用新版本。`,
        ['立即重启', '退出时自动安装'],
      );
      if (choice === 0) {
        // isSilent=false：显示安装界面；isForceRunAfter=true：装完自动启动
        setImmediate(() => {
          autoUpdater.quitAndInstall(false, true);
        });
      }
      // 选"退出时自动安装"时无需额外动作：autoInstallOnAppQuit 已开启
    } finally {
      this.prompting = false;
    }
  }

  /** 模态确认框；无主窗口时降级为无父对话框 */
  private async confirm(title: string, message: string, buttons: string[]): Promise<number> {
    const win = this.getWindow();
    const options = {
      type: 'info' as const,
      title,
      message,
      buttons,
      defaultId: 0,
      cancelId: buttons.length - 1,
      noLink: true,
    };
    const result =
      win !== null && !win.isDestroyed()
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
    return result.response;
  }

  private async alert(title: string, message: string): Promise<void> {
    const win = this.getWindow();
    const options = { type: 'info' as const, title, message, buttons: ['知道了'], noLink: true };
    if (win !== null && !win.isDestroyed()) {
      await dialog.showMessageBox(win, options);
    } else {
      await dialog.showMessageBox(options);
    }
  }
}
