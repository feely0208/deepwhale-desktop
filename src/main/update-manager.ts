import { app, dialog, BrowserWindow, shell } from 'electron';
import * as fs from 'fs';
import { autoUpdater, CancellationToken, type UpdateCheckResult, type UpdateInfo, type ProgressInfo } from 'electron-updater';
import { spawnSync } from 'child_process';
import * as path from 'path';
import { needsManualUpdate } from './mac-signature';
import { CDN_FEED_URL, cdnFeedConfig, readPackagedUpdateConfig } from './update-feed';
import { notesFor, summarize } from './whatsnew';

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
   * 首次进入「下载中」时回调一次 —— 用户要求（2026-10-04）：
   * 「弹出更新面板应该在更新同时弹出，而不是藏在那个后面」。
   * 主进程用它把窗口前置 + 发系统通知，让下载一开始用户就知道。
   */
  onDownloadStart?: () => void;
  /**
   * 发现新版本、**还没开始下载**时回调一次（2026-10-14 起 Win/Linux 走这条路）。
   *
   * 为什么要单独一个：自动下载关掉之后，"发现新版本"与"开始下载"变成两件事 ——
   * 弹窗要在**发现的那一刻**就弹出来，让用户看到「现在更新 / 这个版本不再提醒」，
   * 而不是像以前那样"先悄悄下、下完才告诉他有新版本"。
   */
  onUpdateAvailable?: (version: string) => void;
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

/** 自建 CDN 的站点根（用于拼安装包直链）。 */
function cdnOrigin(): string {
  try {
    return new URL(CDN_FEED_URL).origin;
  } catch {
    return 'https://dl.deepwhale.org.cn';
  }
}

/** macOS 安装包文件名（electron-builder 的产物命名）。 */
function macDmgName(version: string): string {
  return `DeepWhale-Desktop-${version}-${process.arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
}

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
  private readonly onUpdateAvailable: ((version: string) => void) | undefined;
  private readonly onDownloadStart: (() => void) | undefined;
  /** 本次下载是否已经通知过（避免每个百分比都弹一次） */
  private downloadNotified = false;
  /** 正在下载时的取消令牌（用户点「取消更新」用它真正中断下载） */
  private downloadToken: CancellationToken | null = null;
  /** 用户主动取消了本次下载（用于把 electron-updater 抛出的取消错误与真失败区分开） */
  private cancelRequested = false;
  /** 用户选了「这个版本不再提醒」的版本号（持久化，重启后依然不打扰） */
  private skippedVersion: string | null = null;

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
    this.onDownloadStart = options.onDownloadStart;
    this.onUpdateAvailable = options.onUpdateAvailable;
    this.enabled = options.enabled ?? app.isPackaged;
  }

  /** 启动自动检查（幂等：重复调用不会叠加定时器） */
  start(): void {
    if (!this.enabled || this.disposed) {
      return;
    }
    this.wireEvents();

    // ── Windows 自动更新：把安装目标钉死在「当前正在运行的安装目录」──
    //
    // 为什么必须钉（2026-10-04 事故的正解）：一旦允许用户自选安装目录，更新若走安装器的
    // 默认目录，就会把新版装到另一个位置、旧安装被挪进 %TEMP%\old-install，
    // 用户看到的就是「更新完应用不见了」。NsisUpdater 支持 installDirectory，设了它就会给
    // 安装器加 `/D=<目录>`（electron-builder 的 NSIS 模板会手动解析该参数），
    // 于是"装到哪"由我们自己决定，与用户当初选的目录保持一致。
    //
    // ⚠️ 这句与 electron-builder.yml 的 `allowToChangeInstallationDirectory: true` 是
    //    **成对约束**：scripts/check-installer-config.js 在发布 CI 里强制两者同进同出
    //    （npm run check:installer）。谁单独改一边，那个守卫直接红。
    if (process.platform === 'win32') {
      (autoUpdater as unknown as { installDirectory?: string }).installDirectory = path.dirname(
        app.getPath('exe'),
      );
    }

    // 更新源是自建 CDN（dl.deepwhale.org.cn）——原注释写成"本仓库的 GitHub Releases"，早已不是，2026-10-02 更正。
    //
    // autoDownload：**Windows / Linux 自动在后台下载**，macOS 保持关闭。
    //   · 为什么开：用户是不懂技术的律师，"要不要现在下载"这一步对他们是纯负担；
    //     后台下好、只问一次"重启生效"才是贴心（下完 autoInstallOnAppQuit 还会兜底）。
    //   · 为什么 macOS 不开：未签名装不上（Squirrel 校验不过），下载 300MB 纯属浪费 ——
    //     macOS 那条分支会引导用户去下载页手动装。
    // ⚠️ 1.0.54 计划：用户要求「增加取消按钮 / 别打乱节奏」→ 目标是**点了才下载**
    //   （autoDownload=false + 我们自己带 CancellationToken 下载，这样「取消」能真正中断）。
    //   但那需要同时接上弹窗里的「现在更新」按钮，否则会出现"永远下不了更新"。
    //   因此本版**保持原行为**，完整实现放到 1.0.54 一起做（见 1.0.54 待发布清单）。
    // 用户此前选过「这个版本不再提醒」→ 读回来，别再打扰（用户原话："很多人是不想更新的"）
    this.loadSkippedVersion();

    // ── 2026-10-14：不再让 electron-updater 自己偷偷下 ─────────────────────
    //
    // 用户实测（Win 1.0.54 → 1.0.55）：弹窗里点「取消」只关了窗口，主界面进度条继续走 ——
    // 下载根本没停。原因是 `autoDownload = true` 时下载由 electron-updater 自己在后台做，
    // **第三方没有任何取消接口**（只有 `downloadUpdate(token)` 那条路支持取消）。
    // 现在改成：先问「现在更新 / 这个版本不再提醒」，用户点了才带 CancellationToken 下载，
    // 于是「停止更新」是真的能停（见 stopDownload / downloadNow）。
    // macOS 一向走自己的手动下载分支，不受影响。
    autoUpdater.autoDownload = false;
    // ⚠️ 2026-10-15（Windows 用户实测「80% 以后越来越慢、卡在 95%」）：
    //    **必须关掉差分下载**。原因是我们的 CDN（华为 CDN / openresty）**不支持多段 range**：
    //      发 `Range: bytes=0-999,2000-2999,…` 它返回 **200 + 整个文件**，
    //      但响应头里却带着 `Accept-Ranges: bytes`。
    //    electron-updater 的判据（multipleRangeDownloader.js: checkIsRangesSupported）是
    //      "状态码 200 时只要 Accept-Ranges 在，就认为分片受支持" → 继续按 multipart 解析，
    //      而拿到的其实是整包裸数据 → DataSplitter 永远凑不齐分片 → **越下越慢**。
    //    为什么以前没这毛病：**以前 CDN 上根本没有 blockmap**（403）→ 差分前缀就失败 →
    //      自动退回全量下载（快）。2026-10-14 我给 CDN 补了 blockmap（P1-3），
    //      等于把这条坏路打开了 —— 所以"以前很快、今天开始慢"。
    //    关掉之后：一律全量单连接下载（实测 44 MB/s）。等哪天 CDN 真支持多段 range，
    //      再由 scripts/check-updater-differential.js 的一致性断言提醒我们放开。
    autoUpdater.disableDifferentialDownload = true;
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
  /**
   * 立即重启并安装（更新弹窗的「立即重启」按钮用）。
   * 静默安装（isSilent=true）：不弹 NSIS 向导，复用已注册的安装目录 ——
   * 这条是为了 Windows 快捷方式那个历史坑（见 windows-shortcut.ts）。
   */
  quitAndInstallNow(): void {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      console.error('[update] 立即重启失败:', e);
    }
  }

  getState(): UpdateState {
    return this.state;
  }

  /** 用户点了「这个版本不再提醒」的版本号（null = 没跳过任何版本） */
  getSkippedVersion(): string | null {
    return this.skippedVersion;
  }

  /**
   * 用户点了「现在更新」：带 CancellationToken 开始下载。
   *
   * 这是 autoDownload=false 之后唯一的下载入口 —— 好处是**取消真的能取消**
   * （electron-updater 只在这条路上支持取消）。
   */
  async downloadNow(): Promise<void> {
    if (this.state.phase === 'downloading' || this.state.phase === 'downloaded') return;
    const version = (this.state as { version?: string }).version ?? '';
    if (version !== '' && version === this.skippedVersion) return;

    // ⚠️ 2026-10-18：先清掉旧版本的下载残留，否则会「秒跳到某百分比然后卡死」
    //    （用户实测：1.0.57 中断过下载 → 1.0.58 卡片停在 79% 不动）。
    this.cleanStaleDownloadCache(version);

    this.cancelRequested = false;
    this.downloadToken = new CancellationToken();
    this.setState({ phase: 'downloading', message: '正在下载新版本…' });
    try {
      await autoUpdater.downloadUpdate(this.downloadToken);
    } catch (error) {
      if (this.cancelRequested) {
        console.log('[update] 用户停止了下载（不是失败）');
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error('[update] 下载失败:', error);
      this.setState({ phase: 'error', message });
    } finally {
      this.downloadToken = null;
      this.cancelRequested = false;
    }
  }

  /**
   * 用户点了「停止更新」：真正中断下载。
   *
   * 之前这个按钮根本不存在（弹窗只有「稍后」+「立即重启」），而"点取消却继续下载"
   * 就是这个缺口的用户可见表现。停完回到 available —— 用户随时可以再点「现在更新」。
   */
  stopDownload(): void {
    const token = this.downloadToken;
    // 只有"确实在下载"才置取消标记 —— 否则会把之后一次真的下载错误误判成"用户取消"
    this.cancelRequested = token !== null;
    try {
      token?.cancel();
    } catch (e) {
      console.warn('[update] 取消令牌失败（继续按已停止处理）:', e);
    }
    this.downloadToken = null;
    // 任务栏/Dock 上的进度条必须一起清掉，否则"停了但还在走"
    try {
      for (const w of BrowserWindow.getAllWindows()) w.setProgressBar(-1);
    } catch {
      /* 忽略 */
    }
    const version = (this.state as { version?: string }).version;
    this.setState({
      phase: version === undefined ? 'idle' : 'available',
      ...(version === undefined ? {} : { version }),
      message: '已停止下载，可稍后再更新',
    });
  }

  /**
   * 用户点了「这个版本不再提醒」：记下来（持久化），以后不再为这一版弹窗/下载。
   *
   * 用户原话：「很多人是不想更新的」—— 那就必须有一条真的不再打扰的出路，
   * 而不是每次检查都问一遍。
   */
  skipVersion(): void {
    const version = (this.state as { version?: string }).version;
    if (version === undefined) return;
    this.stopDownload();
    this.skippedVersion = version;
    this.persistSkippedVersion(version);
    console.log(`[update] 用户选择跳过版本 ${version}（不再自动提示/下载）`);
    this.setState({ phase: 'idle', message: `已跳过 ${version}` });
  }

  /** 跳过记录落盘的位置（与 settings 同一个 userData 目录） */
  private skipFile(): string {
    return path.join(app.getPath('userData'), 'update-skip.json');
  }

  private loadSkippedVersion(): void {
    try {
      const raw = fs.readFileSync(this.skipFile(), 'utf-8');
      const doc = JSON.parse(raw) as { skipped?: unknown };
      if (typeof doc.skipped === 'string' && doc.skipped !== '') {
        this.skippedVersion = doc.skipped;
        console.log(`[update] 已跳过版本 ${doc.skipped}（用户此前选择"不再提醒"）`);
      }
    } catch {
      // 没有文件 / 读不动：都当作"没跳过"
    }
  }

  private persistSkippedVersion(version: string): void {
    try {
      fs.writeFileSync(this.skipFile(), JSON.stringify({ skipped: version, at: new Date().toISOString() }), 'utf-8');
    } catch (e) {
      console.warn('[update] 跳过版本落盘失败（本次仍生效）:', e);
    }
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

  /**
   * 清掉「**不属于当前目标版本**」的下载残留（2026-10-18 修复 58 的「更新卡在固定百分比」）。
   *
   * ── 事故 ────────────────────────────────────────────────────────────
   *   用户 1.0.57 → 1.0.58 时，更新弹窗**秒跳到 79% 然后永远不动**。
   *   排查发现 `~/Library/Caches/deepwhale-desktop-updater/pending/` 里躺着
   *   **上一次中断留下的旧版本半截包**（实测 289 MB 的 1.0.57 zip）。
   *   electron-updater 看到 pending 里已有同族文件就以为「可以续传」，进度直接跳；
   *   但旧包与新包的 size / sha512 对不上，**校验永远失败 → 卡死，点重试也没用**。
   *
   * ── 修法 ────────────────────────────────────────────────────────────
   *   开始下载前，把 pending 里**文件名不含目标版本号**的残留、和旧的 update.zip 删掉。
   *   目标版本自己的分片保留（那是合法续传）。目录名按 electron-updater 的规则推，
   *   找不到就静默跳过 —— **绝不因为清理失败而阻断更新**。
   */
  private cleanStaleDownloadCache(targetVersion: string): void {
    try {
      const adapter = (autoUpdater as unknown as {
        app?: { baseCachePath?: string; name?: string };
      }).app;
      const cacheRoot = adapter?.baseCachePath;
      if (!cacheRoot || targetVersion === '') return;

      // electron-updater 的目录名规则：<baseCachePath>/<app.name>-updater；
      // 打包名可能是 productName 也可能是 package name —— 两种都试。
      const names = [adapter?.name, 'deepwhale-desktop', 'DeepWhale Desktop'].filter(
        (n): n is string => typeof n === 'string' && n !== '',
      );
      const dir = names
        .map((n) => path.join(cacheRoot, `${n}-updater`))
        .find((d) => {
          try {
            return fs.existsSync(d);
          } catch {
            return false;
          }
        });
      if (!dir) return;

      let removed = 0;
      const pending = path.join(dir, 'pending');
      if (fs.existsSync(pending)) {
        for (const name of fs.readdirSync(pending)) {
          if (name.includes(targetVersion)) continue; // 目标版本的分片保留（合法续传）
          try {
            fs.rmSync(path.join(pending, name), { recursive: true, force: true });
            removed += 1;
          } catch {
            /* 单个删不掉不影响其它 */
          }
        }
      }
      for (const stale of ['update.zip', 'update.exe', 'update.dmg']) {
        const p = path.join(dir, stale);
        if (fs.existsSync(p)) {
          try {
            fs.rmSync(p, { force: true });
            removed += 1;
          } catch {
            /* ignore */
          }
        }
      }
      if (removed > 0) {
        console.log(`[update] 已清理 ${removed} 个不属于 ${targetVersion} 的下载残留（防止卡在固定百分比）`);
      }
    } catch (error) {
      console.warn('[update] 清理下载残留失败（忽略，继续更新）:', error instanceof Error ? error.message : String(error));
    }
  }

  private setState(next: UpdateState): void {
    const prevPhase = this.state.phase;
    this.state = next;
    // 下载一开始就通知（而不是等下载完）—— 见 onDownloadStart 的说明
    if (next.phase === 'downloading' && prevPhase !== 'downloading' && !this.downloadNotified) {
      this.downloadNotified = true;
      try {
        this.onDownloadStart?.();
      } catch (e) {
        console.warn('[update] 下载开始通知失败（已忽略）:', e);
      }
    }
    if (next.phase === 'idle' || next.phase === 'up-to-date' || next.phase === 'error') {
      this.downloadNotified = false;
    }
    this.onStateChange?.(next);
    // 2026-10-03：把更新状态广播给渲染层 —— 设置页版本号那一行用它画下载进度条。
    // mac 上是「静默下载 285MB」，一路上不给任何反馈，用户会以为卡死。
    try {
      const payload = {
        phase: next.phase,
        percent: (next as { percent?: number }).percent,
        message: next.message,
      };
      // 用户要求「就是一个下载过程的进度条可视化，要不要百分比都无所谓，只要能看到」，
      // 而设置页那条只有开着设置页才看得到 —— 徽标补足"任何时刻都看得见"。
      try {
        const pct = typeof payload.percent === 'number' ? payload.percent : null;
        if (next.phase === 'downloading' && pct !== null) {
        } else if (next.phase !== 'downloading') {
        }
      } catch {
        /* 非 macOS 或不可用 */
      }
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.webContents.send('shell:update-state', payload);
      }
    } catch {
      /* 广播失败不影响更新流程 */
    }
  }

  /** 手动检查在途：用于在 update-not-available 时补一次反馈（见 wireEvents）。 */
  private interactiveCheckPending = false;

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
    this.interactiveCheckPending = interactive;
    try {
      const result = await this.checkWithFeedFallback();
      // 没有可用更新时，electron-updater 会在 update-not-available 事件里通知；
      // 这里同时兜底处理返回 null 的情况。
      if (result === null) {
        this.setState({ phase: 'up-to-date', message: '已是最新版本' });
        if (interactive && this.interactiveCheckPending) {
          this.interactiveCheckPending = false;   // 事件已弹过就不重复
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
      // 2026-10-02 修：手动点「检查更新…」时必须给反馈。
      // 原来这里只改状态、不弹窗，而 check() 的弹窗只在 result === null 时触发 ——
      // 正常『已是最新』走的正是这个事件，于是用户点下去毫无反应，以为功能坏了。
      // 自动检查保持静默是对的，所以只在手动检查时弹。
      if (this.interactiveCheckPending) {
        this.interactiveCheckPending = false;
        void this.alert('检查更新', `当前已是最新版本（${app.getVersion()}）。`);
      }
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
      // ⚠️ 用户主动「停止更新」时 electron-updater 也会走到这儿（取消表现为失败）——
      //    那不是错误，别再报一次、也不要把状态打回 error（否则界面像"停止失败"）。
      if (this.cancelRequested) {
        console.log('[update] 下载被用户取消（不是错误）:', error.message);
        return;
      }
      console.error('[update] 更新出错:', error);
      this.setState({ phase: 'error', message: error.message });
      this.prompting = false;
        this.interactiveCheckPending = false;
    });
  }

  /**
   * mac 专用：把安装包 dmg 下到「下载」目录，返回本地路径；失败返回 null。
   *
   * ⚠️ 刻意**不走** autoUpdater.downloadUpdate() —— 那条路是给 Squirrel 装更新用的，
   *    未签名 mac 必然失败。这里只要"把文件拿到手"。
   */
  private async downloadMacDmg(version: string): Promise<string | null> {
    const file = path.join(app.getPath('downloads'), macDmgName(version));
    try {
      // 已经下过就不重复下（用户可能点了几次"检查更新"）
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) return file;
      const response = await fetch(`${cdnOrigin()}/${macDmgName(version)}`);
      if (!response.ok || response.body === null) return null;
      const total = Number(response.headers.get('content-length') ?? '0');
      const stream = fs.createWriteStream(file);
      let received = 0;
      let lastPercent = -1;
      for await (const chunk of response.body) {
        const buf = chunk as Buffer;
        received += buf.length;
        stream.write(buf);
        if (total > 0) {
          const percent = Math.round((received / total) * 100);
          if (percent !== lastPercent) {
            lastPercent = percent;
            this.setState({ phase: 'downloading', percent, message: '正在下载新版本安装包…' });
            // 用户会以为卡死。setProgressBar(-1) 清除。
            // 2026-10-04 用户要求：**去掉 Dock 图标上的红色角标**（原本 setBadge('15%')），
            // 只保留"图标下面的进度条"（setProgressBar）。侧栏那条进度条照旧。
            for (const w of BrowserWindow.getAllWindows()) w.setProgressBar(percent / 100);
          }
        }
      }
      await new Promise<void>((resolve) => stream.end(() => resolve()));
      for (const w of BrowserWindow.getAllWindows()) w.setProgressBar(-1);
      return fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024 ? file : null;
    } catch {
      return null;
    }
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

        // ── 2026-10-02：mac 上**替用户把 dmg 下好**，他只差最后一步 ─────────
        // 为什么：mac 没有苹果开发者签名，Squirrel 装不了更新，这一步**永远**得手动。
        // 但"下载"完全可以替他做 —— 用户从「找链接 + 下载 + 拖」变成「点一下 + 拖一下」。
        // 这是 Windows 上那句"直接下载好，他还觉得很贴心"在 mac 上的等价物。
        const macDmg = await this.downloadMacDmg(info.version);
        if (macDmg !== null) {
          this.setState({
            phase: 'available',
            version: info.version,
            message: `新版本已下载好（${path.basename(macDmg)}）`,
          });
          const dmgChoice = await this.confirm(
            '新版本已下载好',
            `深鲸桌面 ${info.version} 的安装包已经下载完成。\n\n` +
              'macOS 版没有苹果开发者签名，系统不允许自动替换应用 —— ' +
              '所以最后一步要你亲手拖一下（不是网络问题）：\n\n' +
              '   ① 点「打开安装包」\n' +
              '   ② 把里面的图标拖进「应用程序」\n' +
              '   ③ 系统问「替换吗」→ 替换\n\n' +
              `文件位置：${macDmg}`,
            ['打开安装包', '稍后再说'],
          );
          if (dmgChoice === 0) {
            await shell.openPath(macDmg);
          } else {
            shell.showItemInFolder(macDmg);
            this.snoozeUntil = Date.now() + SNOOZE_MS;
          }
          this.setState({ phase: 'idle' });
          return;
        }

        // 下载失败（网络不通等）→ 老实退回"下载页"，别让用户卡死
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

      // ── Windows / Linux：先问，再下（2026-10-14 改）─────────────────────────
      //
      // 原来这里是"后台静静下好，下完只问一次重启"——出发点是用户不懂技术。
      // 但用户实测反馈了两件事：①「点了取消，进度条还在走」②「很多人是不想更新的」。
      // 所以改成：发现新版本 → 弹窗给「现在更新 / 停止更新 / 这个版本不再提醒」，
      // 点了才带 CancellationToken 下载（这样停止是真停），不想更新可以真正跳过。
      // 代价是用户要多点一下 —— 换来的是"更新这件事由他掌控"。
      if (info.version === this.skippedVersion) {
        console.log(`[update] 新版本 ${info.version} 已被用户标记"不再提醒"，跳过`);
        this.setState({ phase: 'idle', message: `已跳过 ${info.version}` });
        return;
      }
      this.setState({
        phase: 'available',
        version: info.version,
        message: `发现新版本 ${info.version}，可随时更新`,
      });
      try {
        this.onUpdateAvailable?.(info.version);
      } catch (e) {
        console.warn('[update] 新版本提示回调失败（已忽略）:', e);
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
      // 「这版改了什么」：用户提议（2026-10-04）——升级前就让他看到具体内容，
      // 而不是装完一头雾水。取不到（离线/首次）就不显示，绝不影响更新本身。
      const highlights = summarize(await notesFor(info.version), 5);
      const choice = await this.confirm(
        `深鲸桌面 ${info.version} 更新已完成`,
        `新版本已下载完成，重启应用后生效。\n\n` +
          (highlights ? `本版更新内容：\n${highlights}\n\n` : '') +
          '是否立即重启应用以完成更新？',
        ['立即重启', '退出时自动安装'],
      );
      if (choice === 0) {
        // ⚠️ 2026-10-03 改成**静默**安装（isSilent=true）：
        //    原来传 false 会弹 NSIS 完整安装向导；配合 nsis.allowToChangeInstallationDirectory
        //    一旦目录被改成默认值/临时目录，桌面快捷方式就跟着指歪（Windows 用户实测：
        //    快捷方式被指到 %TEMP%\...\old-install\，而且普通用户根本不会去开始菜单找）。
        //    静默安装会复用注册表里登记的安装目录 → 快捷方式重建正确；
        //    isForceRunAfter=true 保持不变：装完自动启动。
        setImmediate(() => {
          autoUpdater.quitAndInstall(true, true);
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
