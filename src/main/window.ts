import { BrowserWindow, shell } from 'electron';
import * as path from 'path';

export interface MainWindowOptions {
  port: number;
  closeToTray: boolean;
  /** 是否正在退出（app 真正退出时放行 close 事件） */
  isQuitting: () => boolean;
  /** did-finish-load（含导航后重新触发）回调：应用皮肤 + 注入用量面板 */
  onPageReady: (win: BrowserWindow) => void;
  /**
   * 外部协议交系统打开失败时的回调。
   * 最典型的是 `deepwhale-law://start`（法律模式拉起律师端）—— 失败原因可能是
   * 未安装律师端、装完从未打开过（Windows/Linux 首次打开才登记协议）、或已被移走。
   * 不提供时仅打 console。
   */
  onOpenExternalFailed?: (url: string, error: unknown) => void;
  /**
   * 隐藏窗口（冒烟/自动化用，2026-10-14）：窗口不可见、不可聚焦、不进任务栏，
   * 但仍照常渲染 —— 这样"验证"不会把窗口弹到正在工作的用户脸上。
   * ⚠️ `show: false` 只是初始不显示；`index.ts` 后续的 `win.show()` 仍会执行，
   *    所以同时用 `opacity: 0` + `focusable: false` 保证它始终看不见、抢不到焦点。
   */
  hidden?: boolean;
}

/** 主窗口：加载本地 DSH Web UI */
export function createMainWindow(options: MainWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepWhale Desktop',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../assets/icons/icon.png'),
    backgroundColor: '#0f1115',
    // 「跑测试但不打扰人」（2026-10-14）：冒烟会开窗口 —— 而用户正在工作时被弹窗打断
    // 是不可接受的（他的原话：「搞得我什么都做不成」）。这个开关把窗口做成
    // **不可见、不可聚焦**：仍然照常渲染与截图（capturePage 抓的是页面表面，
    // 与窗口透明度无关），但不会出现在桌面上、也不会抢焦点。
    ...(options.hidden === true
      ? { opacity: 0, focusable: false, skipTaskbar: true, show: false }
      : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 隐藏模式（冒烟）必须关掉后台节流：窗口不可见时 Chromium 会把 rAF / 定时器降到
      // 1 次/秒，React 的渲染就永远"没完成" —— 实测表现是冒烟报
      // 「页面 45 秒内没有稳定下来（侧栏「设置」始终不可点）」且 `document.querySelector('nav')`
      // 为 null（sidebar-probe nCands=0）。那是**测试方式的副作用**，不是产品缺陷。
      backgroundThrottling: options.hidden === true ? false : undefined,
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });

  // 注意：DSH 页面由 index.ts 在服务就绪后加载（先显示"启动中"页面，避免冷启动无窗口）

  // 外部链接交给系统浏览器，不在应用内打开。
  // ⚠️ 失败必须上报：`shell.openExternal` 在"没有应用注册该协议"时会 **reject**，
  // 而这里原来是 `void shell.openExternal(url)` —— 异常被整个丢掉，用户端表现为
  // "选了法律模式毫无反应"：既分不清是没装、没打开过还是被移走，也没有任何可反馈的线索。
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch((error: unknown) => {
      console.error('[window] 交系统打开失败:', url, error);
      options.onOpenExternalFailed?.(url, error);
    });
    return { action: 'deny' };
  });

  // 皮肤/用量面板注入时机（含导航后重新触发）
  win.webContents.on('did-finish-load', () => options.onPageReady(win));

  // 关窗口：默认最小化到托盘而非退出（真正退出时放行）
  let toldAboutTray = false;
  win.on('close', (e) => {
    if (options.closeToTray && !options.isQuitting()) {
      e.preventDefault();
      win.hide();
      // 2026-10-03 新增：第一次隐藏时告诉用户程序去哪了。
      // 起因：有 Windows 用户托盘图标不可见 —— 关窗之后既找不到窗口、
      // 也点不到「退出」，连新安装包都替换不进去（旧进程退不出来）。
      // 一句通知 + 明确告诉退出位置，能避免"以为卡死"。
      if (!toldAboutTray) {
        toldAboutTray = true;
        try {
          const electron = require('electron') as typeof import('electron');
          if (electron.Notification.isSupported()) {
            new electron.Notification({
              title: '深鲸桌面仍在后台运行',
              body: '已最小化到托盘。右键托盘图标可退出；也可在设置页里彻底退出后台。',
            }).show();
          }
        } catch {
          /* 通知失败不影响关窗流程 */
        }
      }
    }
  });

  win.on('closed', () => {
    // 窗口已销毁（真正退出时）
  });

  return win;
}
