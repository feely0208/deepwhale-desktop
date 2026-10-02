import { app, dialog, BrowserWindow, shell } from 'electron';
import { autoUpdater, type UpdateCheckResult, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { needsManualUpdate } from './mac-signature';
import { CDN_FEED_URL, cdnFeedConfig, readPackagedUpdateConfig } from './update-feed';

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
  /** 用户已选过「退出时自动安装」的版本号 —— 记着就不再重复弹窗烦他（2026-10-02） */
  private deferredVersion: string | null = null;
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

    // 更新源是自建 CDN（dl.deepwhale.org.cn）——原注释写成"本仓库的 GitHub Releases"，早已不是，2026-10-02 更正。
    //
    // autoDownload：**Windows / Linux 自动在后台下载**，macOS 保持关闭。
    //   · 为什么开：用户是不懂技术的律师，"要不要现在下载"这一步对他们是纯负担；
    //     后台下好、只问一次"重启生效"才是贴心（下完 autoInstallOnAppQuit 还会兜底）。
    //   · 为什么 macOS 不开：未签名装不上（Squirrel 校验不过），下载 300MB 纯属浪费 ——
    //     macOS 那条分支会引导用户去下载页手动装。
    autoUpdater.autoDownload = !macNeedsManualUpdate();
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
      const result = await this.checkWithFeedFallback();
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

  /** 正在尝试自建 CDN 源（这期间的 error 事件可能马上被回退救回来，先不当成最终失败）。 */
  private tryingCdn = false;

  /**
   * 先用自建 CDN 检查更新，失败则回退到打包时写好的更新源（GitHub）。
   *
   * 为什么要回退：CDN 是自建的，某个版本忘了传 `latest*.yml`、或 CDN 抽风，
   * 只写 CDN 就等于**所有用户都收不到更新** —— 比原来更糟。
   * 回退配置读打包时的 `app-update.yml`（见 ./update-feed.ts），不硬编码 owner/repo。
   */
  private async checkWithFeedFallback(): Promise<UpdateCheckResult | null> {
    const packaged = readPackagedUpdateConfig(process.resourcesPath);
    autoUpdater.setFeedURL(cdnFeedConfig());
    this.tryingCdn = true;
    try {
      const result = await autoUpdater.checkForUpdates();
      // 成功也留一行日志：不然"到底走没走自建源"在打包态里完全不可观测，
      // 验收时只能靠猜（这是 2026-10-01 做 CDN 验收时补的）。
      console.log(
        `[update] 已通过自建更新源检查：${CDN_FEED_URL}（最新 ${result?.updateInfo?.version ?? '未知'}，当前 ${app.getVersion()}）`,
      );
      return result;
    } catch (cdnError) {
      if (packaged === null) throw cdnError;
      console.warn(
        '[update] 自建更新源不可用，回退到打包时的更新源（GitHub）：',
        cdnError instanceof Error ? cdnError.message : String(cdnError),
      );
      this.tryingCdn = false;
      // 形状来自 electron-builder 自己生成的 app-update.yml，与 PublishConfiguration 同源；
      // 但我们不引它的类型（那是 electron-updater 的传递依赖），只做一次局部断言。
      autoUpdater.setFeedURL(
        packaged as unknown as Parameters<typeof autoUpdater.setFeedURL>[0],
      );
      return await autoUpdater.checkForUpdates();
    } finally {
      this.tryingCdn = false;
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
      // 正在试自建 CDN 源时的错误先不当作"最终失败"：checkWithFeedFallback 可能马上
      // 回退到 GitHub 并成功。若这里就把状态打成 error，用户会看到一次假的报错闪烁。
      if (this.tryingCdn) {
        console.warn(
          '[update] 自建更新源出错（先不回退状态，交给回退逻辑判定）:',
          error.message,
        );
        return;
      }
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

      // ⚠️ 2026-10-02 改：**Windows / Linux 自动在后台下载**，不再弹「是否现在下载」。
      //
      // 为什么：我们的用户大多是不懂技术的执业律师。对他们讲"新版本、新插件、MCP"
      // 是鸡同鸭讲 —— 他们只关心"我不用管，重启一下就好了"。
      // 原来那一步询问是纯负担：他既不知道 1.0.39 是什么，也不知道要不要现在下。
      // 现在：后台静静下好（进度显示在托盘提示与任务栏进度条上、不打断使用），
      // 下完只问一次「立即重启 / 退出时自动安装」—— 全程他只需要点一下。
      // macOS 不走这条路（见上面的 macNeedsManualUpdate 分支）。
      // autoDownload = true 时 electron-updater **已经在下载了**，这里不再调 downloadUpdate()，
      // 只把状态摆出来给界面用（进度由 download-progress 推过来，下完由 update-downloaded 收尾）。
      this.setState({ phase: 'downloading', percent: 0, message: '正在后台下载新版本…' });
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
    // 他已经选过"退出时自动安装"（只是还没退出）→ 不必再问一遍：
    // 每 6 小时重复弹同一个窗，对用户就是"骚扰"，而我们本来就保证退出时会装。
    if (this.deferredVersion === info.version) {
      return;
    }
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
      // 选"退出时自动安装"：无需额外动作（autoInstallOnAppQuit 已开启），
      // 但记下这个版本，避免下次检查又弹一次同样的窗。
      else {
        this.deferredVersion = info.version;
      }
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
