import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeTheme,
  Notification,
  shell,
  Tray,
} from 'electron';
import { clipboard } from 'electron';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { pathToFileURL } from 'url';
import { Store } from './store';
import { ServiceManager } from './service-manager';
import { ensureLegalModeSetup, legalModeHome, legalModePayloadDir, migrateLegacyHomeOnce } from './legal-mode';
import { bundledDshBin, dshNodeModulesDir } from './dsh-runtime';
import { ensureOfficeSetup, officePayloadDir } from './office-runtime';
import { ensureBundledPlugins, bundledPluginsPayloadDir } from './bundled-plugins';
import { createMainWindow } from './window';
import { SkinManager } from './skin-manager';
import { PetWindow } from './pet';
import { createTray, applyMenu, buildAppMenuTemplate, TrayMenuActions } from './tray';
import { UsageManager, UsageSnapshot } from './usage-manager';
import { injectSettingsExtension, expectedVersionRow, resolveShellVersion } from './settings-inject';
import { ensureFeedbackEntry, feedbackUrlForSession } from './feedback';
import {
  buildMobileUrls,
  ensureMobileAccess,
  lanAddresses,
  mobileAddressFileText,
  writeMobileAddressFile,
} from './mobile-connect';
import { profileDirOf } from './profile';
import { UpdateManager } from './update-manager';
import type { UpdateState } from './update-manager';
import { installCrashGuard, crashLogDir, appendCrashLog } from './crash-guard';
import { repairWindowsShortcuts } from './windows-shortcut';
import { healPatchFiles } from './patch-heal';
import { registerLocalFilesIpc } from './localfiles';
import { notesFor } from './whatsnew';
import {


  bindUpdatePopupStore,
  showUpdatePopup,
  showWhatsNewWindow,
  updatePopupState,
  registerUpdatePopupIpc,
} from './update-popup';

/**
 * 「本机内文件」快捷键的解析（2026-10-04）
 *
 * 为什么做可配置：原来的 `Cmd+Shift+O` 与系统/其它软件冲突（用户实测）。
 * 规格串形如 `Alt+Cmd+O`、`Alt+F`、`Ctrl+Alt+O`；`off`（或空）表示关闭。
 * 无 Shift 需求时不写 Shift 即代表"必须不按"——避免误触。
 */
const DEFAULT_LOCAL_FILES_SHORTCUT = 'Alt+Cmd+O';

function parseShortcut(spec: string):
  | { key: string; alt: boolean; shift: boolean; ctrl: boolean; meta: boolean }
  | null {
  const raw = String(spec || '').trim();
  if (!raw || raw.toLowerCase() === 'off') return null;
  const parts = raw.split('+').map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  if (!key || parts.length < 2) return null;
  const mods = new Set(parts.slice(0, -1));
  return {
    key,
    alt: mods.has('alt') || mods.has('option') || mods.has('⌥'),
    shift: mods.has('shift') || mods.has('⇧'),
    ctrl: mods.has('ctrl') || mods.has('control') || mods.has('⌃'),
    meta: mods.has('cmd') || mods.has('command') || mods.has('meta') || mods.has('⌘'),
  };
}

/** 冒烟测试模式：自动启动、打印关键事件、8 秒后退出（供 CI/自动化验证） */
const SMOKE = !!process.env.DSH_DESKTOP_SMOKE;

/**
 * 载荷/ profile 注入失败统一处置：既打 console，**也写进 fault.log**。
 *
 * 这些 catch 刻意设计成"不影响壳启动"，但如果只打 console，问题在打包应用里等于
 * 扔进黑洞：用户看到的现象只有"选了法律模式没反应""排版没生效"，无从反馈，
 * 支持侧也拿不到线索。写进 fault.log 后，用户端「帮助 → 查看日志」即可取到。
 *
 * @param scope - 出错的子系统（legal-mode / office / plugins）。
 * @param stage - 出错阶段（载荷注入 / profile 注入）。
 * @param error - 捕获到的异常。
 */
function logInjectionFailure(scope: string, stage: string, error: unknown): void {
  console.error(`[${scope}] ${stage}失败（不影响启动）:`, error);
  appendCrashLog({
    kind: 'injection-failed',
    summary: `${scope} ${stage}失败`,
    detail:
      error instanceof Error
        ? `${error.name}: ${error.message}\n${error.stack ?? '(无堆栈)'}`
        : String(error),
    at: new Date().toISOString(),
  });
}

/** 深链接通知只弹一次，避免连续触发时刷屏。 */
let lawyerUnreachableNotified = false;

/**
 * 深链接拉起律师端失败时的**可操作**提示。
 *
 * 三种最常见原因都写清楚，并给一个「去下载律师端」入口 —— 比"点了没反应"强得多；
 * 同时落 fault.log，支持侧据此就能判断是"没装"还是"没打开过"。
 */
async function notifyLawyerAppUnreachable(): Promise<void> {
  if (lawyerUnreachableNotified) return;
  lawyerUnreachableNotified = true;

  appendCrashLog({
    kind: 'deep-link-failed',
    summary: '法律模式拉起律师端失败',
    detail: 'deepwhale-law:// 协议未被系统接受（未安装 / 从未打开过 / 已被移走）',
    at: new Date().toISOString(),
  });

  const { response } = await dialog.showMessageBox({
    type: 'warning',
    title: '未找到深鲸律师端',
    message: '法律模式需要「深鲸律师端」配合，但这个应用没能被系统拉起。',
    detail: [
      '常见原因：',
      '· 还没有安装深鲸律师端；',
      '· 装好了但从未打开过 —— Windows / Linux 需要至少打开一次才会登记链接协议；',
      '· 律师端被移动或删除了。',
      '',
      '你也可以直接从开始菜单 / 启动台手动打开深鲸律师端，功能不受影响。',
    ].join('\n'),
    buttons: ['去下载律师端', '我知道了'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });
  if (response === 0) void shell.openExternal('https://deepwhale.org.cn/download.html');
}

const store = new Store();
const skin = new SkinManager(store);
const usage = new UsageManager(
  store,
  (snapshot) => pushUsageToWindow(snapshot),
  (threshold) => notifyLowBalance(threshold)
);

let mainWin: BrowserWindow | null = null;
let pet: PetWindow | null = null;
let tray: Tray | null = null;
let apiKeyWin: BrowserWindow | null = null;
let petStudioWin: BrowserWindow | null = null;
/** 首次启动引导窗（仅全新安装的第一次出现） */
let welcomeWin: BrowserWindow | null = null;
let quitting = false;
let service: ServiceManager | null = null;
/**
 * 自动更新：读取本仓库 GitHub Releases。
 * 纯增量模块，不参与法律模式/桌宠/皮肤/用量等任何既有逻辑；
 * 只在打包态启用，失败只记日志。
 */
let updates: UpdateManager | null = null;
/** DSH 日志里解析出的带 token 访问地址（鉴权部署时由 dsh web 打印） */
let dshTokenUrl = '';

// 崩溃兜底：全局异常只记**本地**日志（绝不上传），并在必要时给可操作提示。
// 冒烟测试下关闭弹窗，避免卡住自动化。
installCrashGuard({
  interactive: !SMOKE,
  getWindow: () => (mainWin !== null && !mainWin.isDestroyed() ? mainWin : null),
});

function pushUsageToWindow(snapshot: UsageSnapshot): void {
  if (mainWin && !mainWin.isDestroyed()) {
    mainWin.webContents.send('usage:update', snapshot);
  }
}

function notifyLowBalance(threshold: number): void {
  if (Notification.isSupported()) {
    new Notification({
      title: 'DeepSeek 余额不足',
      body: `可用余额已低于 ¥${threshold}，请及时充值，避免任务中断。`,
    }).show();
  } else {
    console.warn(`[usage] 余额低于阈值 ¥${threshold}`);
  }
}

/** did-finish-load 回调：应用主题/背景皮肤 + 注入用量面板 + 注入设置页扩展 */
async function onPageReady(win: BrowserWindow): Promise<void> {
  // 启动中页面（data: URL）不注入皮肤/用量/设置扩展
  if (!win.webContents.getURL().startsWith('http://127.0.0.1:')) return;
  await skin.apply(win);
  if (store.get('usagePanelVisible')) {
    await usage.applyPanel(win);
  }
  await injectSettingsExtension(win);

  // 「本机内文件」快捷键：**可配置**（用户实测 Cmd+Shift+O 与系统快捷键冲突）。
  // 默认 Alt+Cmd+O；可在 帮助 →「本机内文件快捷键」里改，或直接写 settings.json 的
  // localFilesShortcut（'Alt+Cmd+O' / 'Alt+F' / 'Ctrl+Alt+O' / 'off'）。
  // 用 before-input-event 而不是 globalShortcut：只在应用窗口聚焦时生效，不抢系统快捷键。
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const spec = store.get('localFilesShortcut') || DEFAULT_LOCAL_FILES_SHORTCUT;
    const want = parseShortcut(spec);
    if (!want) return;
    const pressed = {
      key: String(input.key).toLowerCase(),
      alt: !!input.alt,
      shift: !!input.shift,
      ctrl: !!input.control,
      meta: !!input.meta,
    };
    if (
      pressed.key === want.key &&
      pressed.alt === want.alt &&
      pressed.shift === want.shift &&
      pressed.ctrl === want.ctrl &&
      pressed.meta === want.meta
    ) {
      void win.webContents
        .executeJavaScript('window.__dshLocalFiles && window.__dshLocalFiles.open(); true')
        .catch(() => {});
    }
  });
  // 「本机内文件」：往「开始」面板补第三张卡片 + 面板 UI（见 src/localfiles/localfiles.js 的注释，
  // 为什么不是插件插槽：hero 的插槽是单占用，没有 list 槽可追加）
  try {
    const lfJs = fs.readFileSync(path.join(__dirname, '../localfiles/localfiles.js'), 'utf-8');
    await win.webContents.executeJavaScript(lfJs);
  } catch (e) {
    console.error('[localfiles] 注入失败:', e);
  }
  if (SMOKE) console.log('[smoke] page ready (skin + usage panel + settings ext injected)');
}

function showMainWindow(): void {
  if (mainWin) {
    mainWin.show();
    mainWin.focus();
  }
}

/** 打开"设置 API Key…"模态窗（safeStorage 加密保存） */
function openApiKeyDialog(): void {
  if (apiKeyWin && !apiKeyWin.isDestroyed()) {
    apiKeyWin.focus();
    return;
  }
  apiKeyWin = new BrowserWindow({
    width: 460,
    height: 300,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '设置 API Key',
    parent: mainWin ?? undefined,
    modal: !!mainWin,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });
  void apiKeyWin.loadFile(path.join(__dirname, '../apikey/apikey.html'));
  apiKeyWin.on('closed', () => {
    apiKeyWin = null;
  });
}

/**
 * 首次启动引导窗。
 *
 * 仅在**全新安装的第一次启动**由 whenReady 调用（判断见该处注释）。
 * 用户点「开始使用」或按 Esc/Enter 后写入 onboarded 标记并关闭，永不再显示。
 * 老用户升级路径完全不经过这里。
 */
function openWelcomeWindow(): void {
  if (welcomeWin !== null && !welcomeWin.isDestroyed()) {
    welcomeWin.focus();
    return;
  }
  welcomeWin = new BrowserWindow({
    width: 460,
    height: 460,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '欢迎使用深鲸桌面',
    // 引导期间不挂 parent：主窗口此刻可能还在显示"正在启动 DSH"
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });
  void welcomeWin.loadFile(path.join(__dirname, '../welcome/welcome.html'));
  welcomeWin.on('closed', () => {
    welcomeWin = null;
  });
}

/** 结束引导：写标记并关窗（重复调用安全） */
function finishWelcome(): void {
  store.set('onboarded', true);
  store.save();
  if (welcomeWin !== null && !welcomeWin.isDestroyed()) {
    welcomeWin.close();
  }
}

/** 选择背景图片（原生文件对话框） */
async function pickBackgroundImage(): Promise<void> {
  if (!mainWin) return;
  const res = await dialog.showOpenDialog(mainWin, {
    title: '选择背景皮肤图片',
    properties: ['openFile'],
    filters: [
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (res.canceled || !res.filePaths[0]) return;
  try {
    await skin.setBackgroundFromFile(mainWin, res.filePaths[0]);
    rebuildMenus();
  } catch (e) {
    dialog.showErrorBox('背景图片设置失败', e instanceof Error ? e.message : String(e));
  }
}

/** 打开"宠物工坊"窗口（自制宠物） */
function openPetStudio(): void {
  if (petStudioWin && !petStudioWin.isDestroyed()) {
    petStudioWin.focus();
    return;
  }
  petStudioWin = new BrowserWindow({
    width: 780,
    height: 680,
    minWidth: 640,
    minHeight: 520,
    title: '宠物工坊',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, '../preload/preload.js'),
    },
  });
  void petStudioWin.loadFile(path.join(__dirname, '../petstudio/petstudio.html'));
  petStudioWin.on('closed', () => {
    petStudioWin = null;
  });
}

/** 打开 DSH 设置页（应用菜单"设置…" Cmd+,） */
function openSettingsPage(): void {
  if (!mainWin) return;
  mainWin.show();
  mainWin.focus();
  void mainWin.webContents.executeJavaScript(
    `(() => { const els = [...document.querySelectorAll('span')].filter(e => e.textContent.trim() === '设置'); if (els[0]) { els[0].click(); return true; } return false; })()`
  );
}

/** 构建统一菜单动作（托盘 + macOS 顶栏共用） */
/**
 * 「手机连接」—— 把**带 token 的完整地址**交给用户，他不用手打 token。
 *
 * ── 为什么必须由我们拼 token ────────────────────────────────────────
 * 用户的原话：「以前只需要输入 ip 就可以，从来没有让输入过什么 token」。
 * 而现在的 DSH 有鉴权：不带 token 一律 401。DSH 的行为是「用带 token 的根地址访问一次
 * → 种 cookie → 跳到干净的 ./」，所以**第一次用我们给的完整地址打开，之后浏览器记住
 * cookie，用户再直接输 IP / 隧道地址就能进** —— 正是他记忆里的体验。
 *
 * 鉴权**保持开启**：0.0.0.0 意味着同网段可达，关掉 token 等于把会话记录对同 WiFi 敞开。
 */
async function showMobileConnect(): Promise<void> {
  if (!store.get('lanAccess')) {
    await dialog.showMessageBox({
      type: 'info',
      title: '手机连接',
      message: '「允许手机连接」当前是关闭的。',
      detail: '打开后深鲸桌面才会在局域网里可被访问。可以在设置里打开，或联系支持。',
      buttons: ['知道了'],
    });
    return;
  }

  const token = (() => {
    try {
      return new URL(dshTokenUrl).searchParams.get('token') ?? '';
    } catch {
      return '';
    }
  })();

  if (token === '') {
    await dialog.showMessageBox({
      type: 'info',
      title: '手机连接',
      message: '服务还没就绪，暂时拿不到连接地址。',
      detail: '等深鲸桌面完全启动后（界面能正常聊天）再打开这个面板。',
      buttons: ['知道了'],
    });
    return;
  }

  const urls = buildMobileUrls(token, store.get('port'), lanAddresses(), store.get('publicUrl'));
  const lines: string[] = [];
  if (urls.lan.length > 0) {
    lines.push('【同一 WiFi】');
    for (const u of urls.lan) lines.push(u);
  } else {
    lines.push('【同一 WiFi】没检测到局域网地址（可能没连 WiFi）');
  }
  if (urls.external !== null) {
    lines.push('', '【在外面用】', urls.external);
  }
  lines.push(
    '',
    '手机浏览器打开上面的地址即可。**第一次打开之后，浏览器会记住登录状态，' +
      '以后直接输 IP（或隧道地址）就能进**，不用再管 token。',
  );

  const buttons = ['复制局域网地址', '写到桌面文件', '关闭'];
  if (urls.external !== null) buttons.splice(1, 0, '复制外网地址');

  const result = await dialog.showMessageBox({
    type: 'info',
    title: '手机连接',
    message: '用手机浏览器打开下面的地址',
    detail: lines.join('\n'),
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1,
    noLink: true,
  });

  const picked = buttons[result.response];
  if (picked === '复制局域网地址') {
    clipboard.writeText(urls.lan[0] ?? '');
  } else if (picked === '复制外网地址') {
    clipboard.writeText(urls.external ?? '');
  } else if (picked === '写到桌面文件') {
    // 用户明确要过之后，才持续维护这个文件（见 refreshMobileAddressFile 的说明）
    store.set('mobileAddressFile', true);
    refreshMobileAddressFile();
    await dialog.showMessageBox({
      type: 'info',
      title: '手机连接',
      message: '已在桌面生成「手机连接地址.txt」',
      detail:
        '换网络或服务重启后它会自动更新，不用你再管。\n' +
        '把这个文件的内容发到手机，打开里面的地址即可。',
      buttons: ['好'],
    });
  }
}

/**
 * DSH 端口上是否已经有服务在应答。
 *
 * 用来判断"这次是冷启动（要先把注入写进盘、再拉起 DSH）还是复用已有 DSH"。
 * 复用时**绝不能写任何配置文件**：DSH 运行期间外部改动 `cordis.patch.yml` 会让
 * chokidar 触发第二次 HMR runExclusive，直接抛 `HMR transactions cannot be nested`。
 */
function dshPortAnswered(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: '127.0.0.1', port: store.get('port'), path: '/', timeout: 1500 },
      (res) => {
        res.resume();
        resolve(true);
      },
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/**
 * 刷新桌面那份「手机连接地址.txt」。
 *
 * 只在用户**明确要过**（设置里 mobileAddressFile=true，由面板上的
 * 「写到桌面文件」按钮点亮）时才写 —— 往所有人桌面丢文件是失礼的。
 * 一旦打开，每次启动 + 每次 token 变化都会自动刷新，用户不用管它过期。
 */
/**
 * 带 token 的地址落盘，供"壳重启但 DSH 还在跑"时复用。
 *
 * ── 为什么必须存 ────────────────────────────────────────────────
 * token 只在 DSH **启动日志**里出现一次，而 `ServiceManager.ensureReady()` 在
 * 端口已就绪时直接复用、不再拉起进程 —— 于是壳重启后**永远拿不到 token**，
 * 窗口只能加载裸地址、拿到 401 认证页（表现为"应用打开是一片空白/需要认证"）。
 * 存一份就解决了：同一个 DSH 进程的 token 不变，复用时可继续用；
 * 万一 DSH 其实换过了（token 失效），校验会失败并退回裸地址，不会更糟。
 *
 * 仅本机可读（0600）。token 是本机服务的凭据，不该让同机其他用户读走。
 */
function tokenUrlFile(): string {
  return path.join(app.getPath('userData'), 'dsh-token-url.txt');
}

function persistTokenUrl(url: string): void {
  try {
    fs.writeFileSync(tokenUrlFile(), url, { mode: 0o600 });
  } catch (error) {
    console.error('[main] 保存 token 地址失败（不影响使用）:', error);
  }
}

/** 校验一个带 token 的地址是否还能用：401 表示失效，其余（200/302）都算可用 */
function tokenUrlUsable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 3000 }, (res) => {
      res.resume();
      resolve(res.statusCode !== 401);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => resolve(false));
  });
}

/** 壳重启且 DSH 已被复用时，把上次存的 token 地址捞回来 */
async function restorePersistedTokenUrl(): Promise<string> {
  try {
    const saved = fs.readFileSync(tokenUrlFile(), 'utf8').trim();
    if (saved === '') return '';
    return (await tokenUrlUsable(saved)) ? saved : '';
  } catch {
    return '';
  }
}

function refreshMobileAddressFile(): void {
  if (!store.get('mobileAddressFile')) return;
  const token = (() => {
    try {
      return new URL(dshTokenUrl).searchParams.get('token') ?? '';
    } catch {
      return '';
    }
  })();
  if (token === '') return;
  try {
    const urls = buildMobileUrls(token, store.get('port'), lanAddresses(), store.get('publicUrl'));
    const at = new Date().toLocaleString('zh-CN');
    writeMobileAddressFile(app.getPath('desktop'), mobileAddressFileText(urls, at));
  } catch (error) {
    // 桌面文件写不出来（比如桌面被改了权限）绝不能影响别的功能
    console.error('[mobile] 写桌面地址文件失败:', error);
  }
}

/**
 * 预览侧栏下载进度条（托盘菜单「预览更新进度条」）。
 *
 * 为什么需要：进度条**只在真实下载更新时出现**，而用户升到最新版后就再没机会看到它
 * ——2026-10-03 就吃过这个亏（用户装完 1.0.47 问"新的粗条在哪"，可当时没有更新可下）。
 *
 * 做法：走与真实下载**完全相同的状态通路**（`shell:update-state` → 渲染层那套
 * renderUpdateProgress），但**是纯假数据**：不下载、不安装、不写任何持久化状态。
 * 真实的下载正在进行时直接不动它（别把真实进度顶掉）。
 */
function previewUpdateProgress(): void {
  const win = mainWin;
  if (!win || win.isDestroyed()) return;
  const phase = updates?.getState().phase;
  if (phase === 'downloading' || phase === 'downloaded') {
    console.log('[preview] 真实更新正在进行，跳过预览');
    return;
  }
  const send = (st: Record<string, unknown>): void => {
    try {
      win.webContents.send('shell:update-state', st);
    } catch (e) {
      console.warn('[preview] 发送状态失败:', e);
    }
  };
  // 1) 百分比未知（不定态）→ 2) 缓动推进到 100% → 3) 已下载好（满条+闪光）→ 4) 收起
  send({ phase: 'downloading', percent: null, message: '正在下载…' });
  const steps: Array<[number, number]> = [
    [700, 6],
    [1400, 19],
    [2100, 38],
    [2800, 56],
    [3500, 79],
    [4200, 100],
  ];
  for (const [delay, percent] of steps) {
    setTimeout(() => send({ phase: 'downloading', percent, message: `正在下载 ${percent}%` }), delay);
  }
  setTimeout(() => send({ phase: 'downloaded', percent: 100, message: '已下载好，重启生效' }), 5200);
  setTimeout(() => send({ phase: 'idle', percent: null, message: '' }), 7600);
}

/**
 * 「诊断与关于」（2026-10-04 用户要的 B1/B5）
 *
 * 为什么值得做：用户反馈问题时，我们每次都要问「哪个版本 / DSH 是哪个版本 / 更新什么状态 /
 * 日志在哪」——有它就能一键给全，支撑成本直接降一个量级。
 * 做成原生对话框（不新开窗口、不占内存），按钮点完立即有反馈。
 */
function showDiagnostics(): void {
  const shellVer = resolveShellVersion();
  const runtimeVer = (() => {
    try {
      // 随包运行时版本由构建期生成（见 scripts/dsh-runtime-version.js）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      return String(require('./dsh-version.generated').DSH_RUNTIME_VERSION || '未知');
    } catch {
      return '未知';
    }
  })();
  const st = updates?.getState();
  const updateLine = st
    ? `${st.phase}${typeof (st as { percent?: number }).percent === 'number' ? ' ' + String((st as { percent?: number }).percent) + '%' : ''}${st.message ? '（' + st.message + '）' : ''}`
    : '未知';
  const lines = [
    `深鲸桌面：${shellVer}`,
    `随包 DSH 运行时：${runtimeVer}`,
    `更新状态：${updateLine}`,
    `DSH 端口：${store.get('port')}`,
    `系统：${process.platform} ${process.arch} · Electron ${process.versions.electron}`,
    `用户数据：${app.getPath('userData')}`,
    `日志目录：${crashLogDir()}`,
  ];
  const detail = lines.join('\n');
  const choice = dialog.showMessageBoxSync({
    type: 'info',
    title: '诊断与关于',
    message: `深鲸桌面 ${shellVer}`,
    detail,
    buttons: ['复制诊断信息', '打开日志文件夹', '关闭'],
    defaultId: 0,
    cancelId: 2,
  });
  if (choice === 0) {
    clipboard.writeText(`深鲸桌面诊断信息\n${detail}\n`);
    // 给一个明确反馈：菜单栏下没有提示的话用户不知道复制成功没有
    void dialog.showMessageBox({ type: 'info', message: '已复制', detail: '诊断信息已复制到剪贴板，可直接粘贴给我们。', buttons: ['好'] });
  } else if (choice === 1) {
    void shell.openPath(crashLogDir());
  }
}

function buildMenuActions(): TrayMenuActions {
  const skinSubmenu: MenuItemConstructorOptions[] = [
    { label: '背景图片…', click: () => void pickBackgroundImage() },
    {
      label: '移除背景图片',
      enabled: !!store.get('skinImage'),
      click: () => {
        if (mainWin) void skin.clearBackground(mainWin);
        rebuildMenus();
      },
    },
  ];

  const pets = pet ? pet.listPets() : [];
  const currentPet = store.get('petGif');
  const petSubmenuItems: MenuItemConstructorOptions[] = pets.map(
    (p): MenuItemConstructorOptions => ({
      label: p,
      type: 'radio',
      checked: currentPet === p,
      click: () => {
        store.set('petGif', p);
        pet?.reload();
      },
    })
  );
  const petSubmenu: MenuItemConstructorOptions[] = [
    {
      label: '显示宠物',
      type: 'checkbox',
      checked: store.get('petVisible'),
      click: (item) => {
        if (item.checked) pet?.show();
        else pet?.hide();
        rebuildMenus();
      },
    },
    { label: '宠物皮肤', submenu: petSubmenuItems },
    {
      label: '穿透点击',
      type: 'checkbox',
      checked: store.get('clickThrough'),
      click: (item) => {
        store.set('clickThrough', item.checked);
        pet?.window?.setIgnoreMouseEvents(item.checked, { forward: true });
      },
    },
    { label: '打开宠物目录…', click: () => pet?.openPetsFolder() },
    { label: '宠物工坊…', click: () => openPetStudio() },
  ];

  return {
    showMainWindow,
    onQuit: () => app.quit(),
    onOpenCustomCss: () => skin.openCustomCss(),
    onSetApiKey: () => openApiKeyDialog(),
    onOpenSettings: () => openSettingsPage(),
    // 视图菜单的「重新加载界面」（⇧⌘R）。用**显式回调**而不是 `role: 'reload'`：
    // role 自带 ⌘R 默认键，而 ⌘R 已经被官方右侧栏的「刷新当前页面」占着
    // （`@deepseek-ai/dsh-client-ui-sidebar-right` 的 page.refresh），
    // 菜单快捷键会把它吞掉。详见 TrayMenuActions.reloadMainWindow 的说明。
    reloadMainWindow: () => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.reload();
    },
    onOpenPetsFolder: () => pet?.openPetsFolder(),
    onToggleUsagePanel: (visible) => {
      store.set('usagePanelVisible', visible);
      if (mainWin) {
        if (visible) void usage.applyPanel(mainWin);
        else void usage.hidePanel(mainWin);
      }
      rebuildMenus();
    },
    onRefreshUsage: () => void usage.refresh(),
    onCheckUpdate: () => void updates?.checkNow(),
    onPreviewUpdateProgress: () => previewUpdateProgress(),
    // ⚠️ 这个开关原来**从来没有被传过**（2026-10-08 修）：`tray.ts` 里
    //    「预览更新进度条（测试）」那一项是 `...(a.showDevMenu ? [...] : [])`，
    //    而这里不传 → `showDevMenu` 恒为 undefined → **那一项永远进不了菜单**，
    //    于是冒烟里"开发菜单里缺「预览更新进度条」"**必然失败**。
    //    判断口径与冒烟里那条断言（`!app.isPackaged || DSH_DEV_MENU==='1'`）保持一致：
    //    开发态可见、打包后对用户隐藏（用户实测反馈过"这是我们测试时的东西"）。
    showDevMenu: !app.isPackaged || process.env.DSH_DEV_MENU === '1',
    onOpenLocalFiles: () => {
      try {
        if (mainWin && !mainWin.isDestroyed()) {
          if (!mainWin.isVisible()) mainWin.show();
          mainWin.focus();
          void mainWin.webContents.executeJavaScript(
            'window.__dshLocalFiles && window.__dshLocalFiles.open(); true',
          );
        }
      } catch (e) {
        console.warn('[localfiles] 菜单打开失败:', e);
      }
    },
    onShowDiagnostics: () => showDiagnostics(),
    onShowWhatsNew: () => {
      const ver = String(app.getVersion() || '').replace(/^v/, '');
      void showWhatsNewWindow(ver);
    },
    onMobileConnect: () => void showMobileConnect(),
    skinSubmenu,
    petSubmenu,
    usagePanelVisible: store.get('usagePanelVisible'),
  };
}

function rebuildMenus(): void {
  // 应用菜单（macOS 顶栏/窗口菜单栏）：完整 macOS 结构（应用/文件/编辑/视图/皮肤/宠物/窗口/帮助）
  //
  // ⚠️ 这一行**不能**放在 `if (!tray) return` 之后（2026-10-02 修）：
  //    托盘创建失败（图标缺失、菜单栏异常）时，原写法会连应用菜单一起跳过，
  //    于是 Electron 显示**自带的英文默认模板** —— 用户看到"菜单怎么变英文了"，
  //    却完全找不到原因。菜单是所有功能的唯一中文入口，必须与托盘解耦。
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(buildMenuActions())));
  if (!tray) return;
  applyMenu(tray, buildMenuActions());
}

/**
 * 按会话 ID 找出该会话的落盘文件（`session.jsonl.zstd`）。
 *
 * DSH 的会话按 workspace 分目录存放：
 *   `<home>/sessions/<workspace 编码>/<sessionId>/session.jsonl.zstd`
 * 前端只传会话 ID、**不传路径** —— 路径在这里自己扫出来，界面塞不进任意路径。
 *
 * @param sessionId - 会话 ID（UUID 形态）。
 * @returns 会话文件的绝对路径；找不到返回 null。
 */
function sessionFileOf(sessionId: string): string | null {
  // 只接受 UUID 形态的 ID：既挡住路径穿越（../），也避免把特殊字符拼进路径。
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId === '.' || sessionId === '..') return null;
  const root = path.join(legalModeHome(app.getPath('userData')), 'sessions');
  let workspaces: fs.Dirent[];
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of workspaces) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(root, entry.name, sessionId, 'session.jsonl.zstd');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 单个目录不可读：继续找下一个
    }
  }
  return null;
}

function registerIpc(): void {
  pet?.registerIpc();

  // ---- 用量 ----
  ipcMain.on('usage:refresh', () => void usage.refresh());
  ipcMain.on('usage:record', (_e, payload: { inputTokens?: number; outputTokens?: number }) => {
    usage.recordUsage(payload?.inputTokens ?? 0, payload?.outputTokens ?? 0);
  });
  ipcMain.on('usage:set-key', (_e, key: string) => {
    try {
      usage.setApiKey(key);
    } catch (err) {
      dialog.showErrorBox('API Key 保存失败', err instanceof Error ? err.message : String(err));
    }
  });

  // ---- 通用设置读写（设置页扩展用） ----
  ipcMain.handle('settings:get', (_e, key: string) => store.get(key as never) ?? null);
  ipcMain.on('settings:set', (_e, payload: { key: string; value: unknown }) => {
    if (!payload || typeof payload.key !== 'string') return;
    try {
      store.set(payload.key as never, payload.value as never);
      store.save();
      // ★ 主题必须**立即**生效。
      //   原来 nativeTheme.themeSource 只在启动流程里设一次（index.ts:803），
      //   所以用户在设置里点「深色」只是写进了配置文件，界面要**重启**才变 ——
      //   用户 2026-10-01 反馈「设置里切不了深色模式」就是这个原因，不是没写进去。
      if (payload.key === 'theme') {
        const next = payload.value;
        if (next === 'light' || next === 'dark' || next === 'system') {
          nativeTheme.themeSource = next;
        }
      }
    } catch (err) {
      console.error('[main] 设置保存失败:', payload.key, err);
    }
  });

  // ---- 会话右键菜单：在访达中打开 / 打开所在文件夹 / 复制文件路径 / 复制会话 ID / 反馈问题 ----
  // 由随包客户端插件 @deepwhale-cn/dsh-shell-session-actions 调用。前端只给会话 ID，
  // 会话文件在主进程里按 ID 扫出来（见 sessionFileOf），返回 { ok, message? }。
  // ---- 文档预览的「打印」（PDF / 图片）----
  //
  // 为什么不让渲染层直接 window.print()：PDF 在预览里是 Chromium 的**扩展查看器**
  // （chrome-extension:// 跨源），拿不到 contentWindow，只能退回"打印预览区" ——
  // 实测打印出来顶部还带着应用工具栏、四周大片留白（窄面板被缩到 A4 上）。
  // 所以 PDF / 图片由主进程把**文件本身**装进隐藏窗口交给系统打印：
  // 满版、能选页/缩放/双面/另存 PDF，与用户在 macOS 里直接打印该文件一致。
  /** 需要先转 PDF 再打印的 Office 文档扩展名。 */
  const OFFICE_EXT = new Set([
    '.doc', '.docx', '.odt', '.rtf',
    '.xls', '.xlsx', '.ods', '.csv',
    '.ppt', '.pptx', '.odp',
  ]);

  /**
   * 用随包的 libreoffice-kit 把 Office 文档转成 PDF（临时文件）。
   *
   * 为什么放在主进程：渲染层没有文件系统能力；而且引擎必须从**真实路径**调用 ——
   * asar 里的文件没有执行位，kit 会抛 'Installed LibreOfficeKit executable is not
   * executable'（这就是 1.0.39 之前 Office 预览一直坏的原因，见 electron-builder.yml）。
   */
  async function convertOfficeToPdf(file: string): Promise<{ ok: boolean; output: string; message?: string }> {
    const fsMod = await import('fs');
    const pathMod = await import('path');
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const run = promisify(execFile);

    const nodeBin = pathMod.join(legalModeHome(app.getPath('userData')), 'office-runtime', 'bin', 'node');
    const nmDir = dshNodeModulesDir(bundledDshBin(app.isPackaged, app.getAppPath(), process.resourcesPath));
    if (!nmDir) return { ok: false, output: '', message: 'Office 转换器未就绪' };
    const cli = pathMod.join(nmDir, '@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js');
    if (!fsMod.existsSync(nodeBin) || !fsMod.existsSync(cli)) {
      return { ok: false, output: '', message: 'Office 转换器未就绪' };
    }
    const outDir = fsMod.mkdtempSync(pathMod.join(app.getPath('temp'), 'dsh-print-'));
    const output = pathMod.join(outDir, 'converted.pdf');
    try {
      await run(nodeBin, [cli, 'convert', '--input', file, '--output', output], { timeout: 120_000 });
      if (!fsMod.existsSync(output)) return { ok: false, output: '', message: 'Office 转换未产出文件' };
      return { ok: true, output };
    } catch (error) {
      return { ok: false, output: '', message: error instanceof Error ? error.message : 'Office 转换失败' };
    }
  }

  const PRINTABLE_EXT = new Set([
    '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.svg',
  ]);

  /**
   * 把预览面板给出的路径解析成本机上真实存在的可打印文件。
   *
   * 面板显示的路径可能是 `/mac/Desktop/...` 这种**省掉 /Users 前缀**的形态，
   * 因此逐个候选试探；只接受**确实存在的普通文件**，不信任前端。
   */
  function resolvePrintableFile(raw: string): string | null {
    const candidates = [raw, path.join('/', raw.replace(/^\/+/, ''))];
    if (raw.startsWith('/')) candidates.push(path.join(homedir(), raw.slice(1)));
    if (raw.startsWith('/')) candidates.push(path.join('/Users', raw.slice(1)));
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // 下一个候选
      }
    }
    return null;
  }

  /** 在隐藏窗口里把文件交给系统打印，完成后销毁窗口。 */
  async function printFileInHiddenWindow(file: string): Promise<{ ok: boolean; message?: string }> {
    const ext = path.extname(file).toLowerCase();
    // ⚠️ Office 扩展名也要放行 —— 它们先转 PDF 再打印（见下面的 OFFICE_EXT 分支）。
    //    只在 PRINTABLE_EXT 里判断的话，docx 会被挡在这一行，永远走不到转换。
    if (!PRINTABLE_EXT.has(ext) && !OFFICE_EXT.has(ext)) {
      return { ok: false, message: '这类文件请在预览区里打印' };
    }
    // Office 文档：先用同目录的 libreoffice-kit 转成 PDF，再按 PDF 打印 ——
    // 直接打印预览区会把整个应用界面打出去（实测），转 PDF 才是满版且内容正确。
    let target = file;
    if (OFFICE_EXT.has(ext)) {
      const pdf = await convertOfficeToPdf(file);
      if (!pdf.ok) return { ok: false, message: pdf.message ?? 'Office 转换失败' };
      target = pdf.output;
    }
    const win = new BrowserWindow({
      show: false,
      webPreferences: { plugins: true, contextIsolation: true, nodeIntegration: false },
    });
    try {
      await win.loadURL(pathToFileURL(target).toString());
      // 等 PDF 查看器把首页渲染出来再调打印，否则可能打出空白页
      await new Promise((resolve) => setTimeout(resolve, 500));
      const ok = await new Promise<boolean>((resolve) => {
        win.webContents.print({ silent: false, printBackground: true }, (success) => resolve(success));
      });
      return ok ? { ok: true } : { ok: false, message: '打印已取消' };
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      // 用户在系统打印面板里点了"打印"后立即销毁窗口会打断任务，留一点余量
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 2000);
    }
  }

  // ---- 设置页两个按钮（2026-10-03）----
  // 与托盘菜单同源：检查更新 = tray.ts → onCheckUpdate → UpdateManager.checkNow()；
  // 退出 = tray.ts → onQuit → app.quit()。按钮比菜单项更容易误点，所以退出先确认。
  ipcMain.handle('shell:check-update', async (): Promise<{ ok: boolean }> => {
    await updates?.checkNow();
    return { ok: true };
  });
  ipcMain.handle('shell:quit', async (): Promise<{ ok: boolean }> => {
    if (mainWin && !mainWin.isDestroyed()) {
      const { response } = await dialog.showMessageBox(mainWin, {
        type: 'question',
        buttons: ['彻底退出', '取消'],
        defaultId: 1,
        cancelId: 1,
        message: '要彻底退出 DeepWhale Desktop 吗？',
        detail: '退出后后台进程会一并结束，需要重新启动应用。',
      });
      if (response !== 0) return { ok: false };
    }
    app.quit();
    return { ok: true };
  });

  ipcMain.handle(
    'document:print',
    async (_e, payload: { path?: string }): Promise<{ ok: boolean; message?: string }> => {
      const raw = typeof payload?.path === 'string' ? payload.path.trim() : '';
      if (raw.length === 0) return { ok: false, message: '缺少文件路径' };
      const resolved = resolvePrintableFile(raw);
      if (!resolved) return { ok: false, message: '这个文件不在本机，无法直接打印' };
      return await printFileInHiddenWindow(resolved);
    },
  );

  ipcMain.handle(
    'session:action',
    async (
      _e,
      payload: { kind?: string; sessionId?: string; title?: string },
    ): Promise<{ ok: boolean; message?: string }> => {
      const kind = payload?.kind;
      const sessionId = payload?.sessionId;
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { ok: false, message: '缺少会话 ID' };
      }
      if (typeof kind !== 'string' || kind.length === 0) {
        return { ok: false, message: '缺少操作类型' };
      }

      // 反馈问题：打开官网反馈页，把本会话的 ID 与标题预填进去（用户不用自己抄）。
      // 刻意放在 sessionFileOf **之前**：这个动作不需要会话文件 ——
      // 会话可能已被删除或还没落盘，那种情况下更要能反馈，不能因为找不到文件就失败。
      // 只传 ID 与标题，不带任何路径（见 feedback.ts 的 feedbackUrlForSession）。
      if (kind === 'feedback') {
        await shell.openExternal(
          feedbackUrlForSession(resolveShellVersion(), { sessionId, title: payload?.title }),
        );
        return { ok: true };
      }

      const file = sessionFileOf(sessionId);
      const dir = file ? path.dirname(file) : null;

      switch (kind) {
        case 'reveal': {
          if (!file || !dir) return { ok: false, message: '找不到该会话的文件' };
          // Linux 上 showItemInFolder 依赖桌面环境的文件管理器，不可靠；退化为开目录。
          if (process.platform === 'linux') {
            const error = await shell.openPath(dir);
            return error ? { ok: false, message: error } : { ok: true };
          }
          shell.showItemInFolder(file);
          return { ok: true };
        }
        case 'openFolder': {
          if (!dir) return { ok: false, message: '找不到该会话的文件夹' };
          const error = await shell.openPath(dir);
          return error ? { ok: false, message: error } : { ok: true };
        }
        case 'copyPath': {
          if (!file) return { ok: false, message: '找不到该会话的文件' };
          clipboard.writeText(file);
          return { ok: true, message: file };
        }
        case 'copyId': {
          clipboard.writeText(sessionId);
          return { ok: true, message: sessionId };
        }
        default:
          return { ok: false, message: `未知操作：${kind}` };
      }
    },
  );

  // ---- 主题 / 背景皮肤（设置页/菜单共用） ----
  // 2026-10-04 一次性迁移：辉光是我们花大力气做的视觉，
  // 但早期默认/应急指引会把 skinPreset 停在 'none' → 用户永远看不到辉光（用户实测"辉光还是没回来"）。
  // 规则：**没主动选过**皮肤的用户，启动时把默认预设开回来；主动选过的永久尊重。
  try {
    if (!store.get('skinPresetChosen') && store.get('skinPreset') === 'none') {
      store.set('skinPreset', 'deepseek-blue');
      store.set('skinPresetChosen', true);
      console.log('[skin] 一次性迁移：辉光预设已开启（用户此前未主动选择过皮肤）');
    }
  } catch (e) {
    console.warn('[skin] 预设迁移失败:', e);
  }

  ipcMain.handle('theme:state', () => ({
    skinImage: store.get('skinImage'),
    skinPreset: store.get('skinPreset'),
    skinOpacity: store.get('skinOpacity'),
    customCssEnabled: store.get('customCssEnabled'),
    previewDataUri: skin.backgroundPreviewDataUri(),
  }));
  ipcMain.on('skin:pick-image', () => void pickBackgroundImage());
  ipcMain.on('skin:clear-image', () => {
    if (mainWin) void skin.clearBackground(mainWin);
    rebuildMenus();
  });
  ipcMain.on('skin:set-preset', (_e, preset: string) => {
    // 只接受已知预设名 —— 这个值会被拼进注入的 CSS，不能让界面塞任意串进来
    const safe = preset === 'deepseek-blue' ? 'deepseek-blue' : 'none';
    store.set('skinPresetChosen', true);   // 用户主动选过 → 以后不再自动开辉光
    if (mainWin) void skin.setPreset(mainWin, safe);
    rebuildMenus();
  });
  ipcMain.on('skin:set-opacity', (_e, value: number) => {
    if (mainWin) void skin.setOpacity(mainWin, value);
  });
  ipcMain.on('skin:open-css', () => skin.openCustomCss());
  ipcMain.on('skin:toggle-custom-css', (_e, enabled: boolean) => {
    if (mainWin) void skin.setCustomCssEnabled(mainWin, enabled);
  });

  // ---- 宠物（设置页/菜单共用） ----
  // 2026-10-04 事故修复：Windows 自动更新中途杀进程 → patch 文件留下空字节 →
  // DSH 解析失败 → 用户看到「无法连接到 DSH 服务」。启动时先自愈（必须在拉起 DSH 之前）。
  try {
    const healed = healPatchFiles(legalModeHome(app.getPath('userData')));
    if (healed.healed.length) console.log('[patch-heal] 启动自愈完成：', healed.healed.length, '个文件');
  } catch (e) {
    console.warn('[patch-heal] 自愈检查失败（不影响启动）:', e);
  }

  // 关于面板（2026-10-05 用户：「后面不应该是 feely0208…权属应该是公司的」）：
  // 原来版权行来自 package.json 的 author（个人 GitHub 账号）→ 现在显式写成公司。
  // 1.0.54 计划：改用我们自己的品牌关于窗（辉光底 + 大肥鱼），见 1.0.54 待发布清单。
  try {
    app.setAboutPanelOptions({
      applicationName: '深鲸桌面',
      applicationVersion: resolveShellVersion(),
      version: `随包 DSH 运行时 ${(app.getVersion && app.getVersion()) || ''}`.trim(),
      copyright: 'Copyright © 2026 温州深鲸智能科技有限公司',
      credits: '本地运行 · 不上传你的文件\nhttps://deepwhale.org.cn',
      authors: ['温州深鲸智能科技有限公司'],
    });
  } catch (e) {
    console.warn('[about] 设置关于面板信息失败:', e);
  }

  registerLocalFilesIpc();
  // 更新弹窗的按钮：立即重启 / 稍后（与更新管理器同源）
  bindUpdatePopupStore(store);
  registerUpdatePopupIpc({
    onRestart: () => {
      try {
        (updates as unknown as { quitAndInstallNow?: () => void })?.quitAndInstallNow?.();
      } catch (e) {
        console.warn('[update-popup] 立即重启失败:', e);
      }
    },
    onLater: () => {
      // 稍后：什么都不做（autoInstallOnAppQuit 已开启，退出时会装）
    },
  });
  // 「这版改了什么」：给渲染层（设置页卡片）用
  ipcMain.handle('shell:whatsnew', (_e, version: string) => notesFor(version));

  ipcMain.handle('pet:list', () => pet?.listPets() ?? []);
  ipcMain.handle('pet:state', () => ({
    current: store.get('petGif'),
    visible: store.get('petVisible'),
    clickThrough: store.get('clickThrough'),
    frameMs: store.get('petFrameMs'),
    scale: store.get('petScale'),
    list: pet?.listPets() ?? [],
    previewDataUri: pet?.previewDataUri() ?? null,
  }));
  ipcMain.on('pet:set-config', (_e, payload: { frameMs?: number; scale?: number }) => {
    if (typeof payload?.frameMs === 'number') {
      store.set('petFrameMs', Math.min(400, Math.max(50, Math.round(payload.frameMs))));
    }
    if (typeof payload?.scale === 'number') {
      store.set('petScale', Math.min(2, Math.max(0.6, payload.scale)));
    }
    pet?.applyConfig();
  });
  ipcMain.on('pet:set-visible', (_e, visible: boolean) => {
    if (visible) pet?.show();
    else pet?.hide();
    rebuildMenus();
  });
  ipcMain.on('pet:set-click-through', (_e, enabled: boolean) => {
    store.set('clickThrough', enabled);
    pet?.window?.setIgnoreMouseEvents(enabled, { forward: true });
  });
  // 光标进入/离开宠物：穿透模式下"只在宠物身上才可点"（见 PetManager.setHovering）
  ipcMain.on('pet:hover', (_e, hovering: boolean) => pet?.setHovering(!!hovering));
  ipcMain.on('pet:open-folder', () => pet?.openPetsFolder());

  // ---- 宠物工坊 ----
  ipcMain.on('petstudio:open', () => openPetStudio());
  ipcMain.on('petstudio:save', (_e, payload: { name?: string; svg?: string }) => {
    const name = (payload?.name || '').trim();
    const svg = payload?.svg || '';
    if (!name || !/\.svg$/i.test(name)) {
      dialog.showErrorBox('保存失败', '宠物名需以 .svg 结尾');
      return;
    }
    try {
      pet?.saveSvgPet(name, svg);
    } catch (err) {
      dialog.showErrorBox('保存失败', err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle('petstudio:import-image', async () => {
    if (!mainWin) return { ok: false, error: '主窗口未就绪' };
    const res = await dialog.showOpenDialog(mainWin, {
      title: '选择图片生成宠物（自动去除白色背景）',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }],
    });
    if (res.canceled || !res.filePaths[0]) return { ok: false, canceled: true };
    try {
      const name = pet!.importImageAsPet(res.filePaths[0]);
      return { ok: true, name };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });

  ipcMain.on('apikey:close', () => apiKeyWin?.close());

  // ---- 首次启动引导窗 ----
  ipcMain.on('welcome:finish', () => finishWelcome());
  ipcMain.on('welcome:open-api-key', () => openApiKeyDialog());
}

// 单实例：多个实例会互相争抢 3080 端口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());


/** 启动中 / 启动失败提示页（先出窗口，DSH 后台启动） */
function startingPageHtml(failed: boolean): string {
  const msg = failed
    ? 'DSH 服务启动失败。请检查设置中的 command 命令，或查看错误弹窗中的日志。'
    : '正在启动 DSH 服务，首次启动可能需要 30~60 秒…';
  const color = failed ? '#f87171' : '#38bdf8';
  // 启动页的标记也用「青色大肥鱼」（用户要求统一；之前是个 🐋 emoji）
  // data: URL 页面读不到相对路径的本地图片，所以内联成 data URI（见 assets/brand/whale-mark-small.png）。
  let brand = '';
  try {
    const p = path.join(__dirname, '../assets/brand/whale-mark-small.png');
    brand = 'data:image/png;base64,' + fs.readFileSync(p).toString('base64');
  } catch (e) {
    console.warn('[start] 启动页品牌图读取失败（退回文字）:', e);
  }
  const mark = brand
    ? `<img class="fish" src="${brand}" alt="" width="132" height="106" />`
    : '';
  const warn = failed ? '<div class="warn">⚠️</div>' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1424;color:#e8eefc;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
    .box{text-align:center;padding:40px}
    .fish{display:block;margin:0 auto 6px;filter:drop-shadow(0 10px 26px rgba(20,165,184,.55));animation:bob 4.5s ease-in-out infinite}
    @keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}
    @media (prefers-reduced-motion: reduce){.fish{animation:none}}
    .warn{font-size:40px;margin-bottom:8px}
    .title{font-size:26px;font-weight:700;margin:10px 0 10px}
    .msg{font-size:15px;color:${color}}
  </style></head><body><div class="box">${warn}${mark}<div class="title">DeepWhale Desktop</div><p class="msg">${msg}</p></div></body></html>`;
}

/**
 * DSH 启动失败时的可操作恢复流程。
 *
 * 原实现只弹一个 `showErrorBox`（仅"确定"按钮），用户拿不到任何操作入口。
 * 现在给出四个选项，并支持**原地重试**——DSH 启动失败常见于端口占用、
 * 依赖未就绪等瞬时原因，重试往往就能成功。
 *
 * @param firstError - 首次失败的原因
 * @returns 重试成功返回 true；用户放弃返回 false（调用方据此显示失败页）
 */
async function handleDshStartFailure(firstError: unknown): Promise<boolean> {
  let error: unknown = firstError;

  for (;;) {
    const tail = service?.lastOutput() ?? '';
    const detail = [
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      tail ? `\n--- DSH 输出（末尾 20 行）---\n${tail}` : '',
    ].join('\n');

    // 记本地日志：每次都记，便于还原"重试了几次、每次什么原因"
    appendCrashLog({
      kind: 'dsh-start-failed',
      summary: 'DSH 服务启动失败',
      detail,
      at: new Date().toISOString(),
    });

    const buttons = ['重试', '查看日志', '打开设置', '退出'];
    const options = {
      type: 'error' as const,
      title: 'DSH 启动失败',
      message: '深鲸桌面无法连接到 DSH 服务',
      detail: `${detail}\n\n可以先点「重试」；若反复失败，请查看日志并把内容反馈给我们。`,
      buttons,
      defaultId: 0,
      cancelId: 3,
      noLink: true,
    };
    const win = mainWin !== null && !mainWin.isDestroyed() ? mainWin : null;
    const result =
      win !== null ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);

    // 重试
    if (result.response === 0) {
      try {
        if (service === null) {
          throw new Error('服务管理器未初始化');
        }
        await service.ensureReady();
        console.log('[main] DSH 启动重试成功');
        return true;
      } catch (retryError) {
        console.error('[main] DSH 启动重试仍失败:', retryError);
        error = retryError;
        continue;
      }
    }

    // 查看日志：打开本地日志目录（含 fault.log 与 Electron 的 minidump）
    if (result.response === 1) {
      void shell.openPath(crashLogDir());
      continue;
    }

    // 打开设置：定位 settings.json，便于用户改 command / port
    if (result.response === 2) {
      const settingsFile = path.join(app.getPath('userData'), 'settings.json');
      try {
        fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
        if (!fs.existsSync(settingsFile)) {
          fs.writeFileSync(settingsFile, '{}\n', 'utf-8');
        }
        shell.showItemInFolder(settingsFile);
      } catch (openError) {
        console.error('[main] 打开设置失败:', openError);
        dialog.showErrorBox('无法打开设置', String(openError));
      }
      continue;
    }

    // 退出
    return false;
  }
}

async function showStartingPage(win: BrowserWindow, failed = false): Promise<void> {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(startingPageHtml(failed)));
}

  // ⚠️ 2026-10-03：Windows 的 Chromium 遮挡检测很激进 —— 透明 + 无焦点 + 置顶的宠物窗口
  //    经常被判成"被遮挡"，渲染进程被降频，requestAnimationFrame 几乎不再回调：
  //    用户看到的是"宠物冻住、动作全不触发、点击也不冲刺"（Windows 用户实测）。
  //    关掉"被遮挡即后台化"，配合 pet.ts 里该窗口的 backgroundThrottling:false。
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

  app.whenReady().then(async () => {
    // Windows：自愈被更新搞歪的桌面/开始菜单快捷方式（只在 win32 + 打包态执行）。
    //    用户实测：自动更新后桌面快捷方式被指到 %TEMP%\…\old-install\，而普通用户
    //    不会去开始菜单重建 → 必须在启动时自动修（见 windows-shortcut.ts 的注释）。
    void repairWindowsShortcuts({ isPackaged: app.isPackaged }).catch((e) => {
      console.warn('[win-shortcut] 自愈失败（已忽略）:', e instanceof Error ? e.message : String(e));
    });

    // ⚠️ 首次启动判断必须在**任何 store.set()/save() 之前**取值：
    //    settings.json 由本应用在保存设置时创建，所以"本次启动前它不存在"
    //    就等价于"全新安装"。老用户升级时该文件早已存在 → 永不显示引导。
    //    第二道保险是 onboarded 标记（走完引导后写入）。
    const settingsFilePath = path.join(app.getPath('userData'), 'settings.json');
    let firstRun = false;
    try {
      firstRun = !fs.existsSync(settingsFilePath) && !store.get('onboarded');
    } catch (error) {
      console.error('[welcome] 首次启动判断失败（按非首次处理）:', error);
      firstRun = false;
    }

    // 原生界面主题跟随设置（跟随系统/浅色/深色），默认跟随系统
    nativeTheme.themeSource = store.get('theme');

    pet = new PetWindow(store);
    pet.ensureUserPetsDir();
    registerIpc();

    // 法律模式载荷：把随包的 ui-legal-mode 插件与 legal-mode 预设注入本应用的
    // 专属 DSH home（与用户自己的 ~/.dsh 隔离），使"任何渠道切到法律模式都拉起
    // 律师端"在用户机器上生效。首次启动时 profile 目录还不存在，就绪后会再补一次。
    const legalHome = legalModeHome(app.getPath('userData'));
    const payloadDir = legalModePayloadDir(app.isPackaged, app.getAppPath(), process.resourcesPath);
    // 老的壳（有内置运行时之前）把 DSH_HOME 指向 ~/.deepwhale-legal/dsh-home（由
    // settings.json 的 command 脚本自己设置）。升级到随包运行时后改用
    // <userData>/dsh-home，若不迁移，老用户会看到空白 workspace（数据其实还在旧目录）。
    // 只在目标尚无用户数据时搬一次，且是复制而非移动，旧目录原样保留。
    try {
      migrateLegacyHomeOnce(legalHome, [
        path.join(app.getPath('home'), '.deepwhale-legal', 'dsh-home'),
      ]);
    } catch (error) {
      console.error('[legal-mode] 旧 home 迁移失败（不影响启动）:', error);
    }
    // 随包 DSH 运行时：安装包内置整套 DSH，用 Electron 自带 Node 拉起，
    // 用户机器无需 Node.js / npx / 联网下载。缺失时回落到 settings.json 的 command。
    // 注意要在注入预设之前解析：预设里的 persona 字段名必须跟随目标运行时的版本
    // （0.1.2 用 text、0.1.5 用 prefix，写错会让整个法律模式预设挂载失败）。
    const bundledBin = bundledDshBin(app.isPackaged, app.getAppPath(), process.resourcesPath);
    const legalRuntimeDir = dshNodeModulesDir(bundledBin);
    if (SMOKE) {
      console.log(`[smoke] bundled DSH runtime: ${bundledBin ?? '(none)'}`);
    }
    // 注入失败绝不能影响壳启动（例如文件系统不支持创建链接/权限不足）：
    // 这里整体兜底，最坏情况只是"用户端没有法律模式联动"。
    let setup: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
    try {
      setup = ensureLegalModeSetup(legalHome, payloadDir, legalRuntimeDir);
    } catch (error) {
      logInjectionFailure('legal-mode', '载荷注入', error);
    }
    if (SMOKE) {
      console.log(`[smoke] legal-mode setup: changed=${String(setup.changed)} pending=${String(setup.profilePending)}`);
    }

    // office 能力（Word / Excel / PPT 生成 + 内置 LibreOffice 渲染 PDF）：
    // 纯增量，只往 profile patch 追加自己的 insert 行，不碰法律模式的任何行。
    const officePayload = officePayloadDir(app.isPackaged, app.getAppPath(), process.resourcesPath);
    let officeSetup: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
    try {
      officeSetup = ensureOfficeSetup(legalHome, officePayload, legalRuntimeDir, process.execPath, app.getVersion());
    } catch (error) {
      logInjectionFailure('office', '载荷注入', error);
    }
    if (SMOKE) {
      console.log(`[smoke] office setup: changed=${String(officeSetup.changed)} pending=${String(officeSetup.profilePending)} payload=${officePayload}`);
    }

    // 随包插件（中文合规 + 公文排版）：从 npm 拉取的正式包随 app 分发，
    // 装完即用、不依赖联网。走标准 bundle 机制（dsh.profile.bundles）。
    const pluginsPayload = bundledPluginsPayloadDir(
      app.isPackaged,
      app.getAppPath(),
      process.resourcesPath,
    );
    let pluginsSetup: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
    try {
      pluginsSetup = ensureBundledPlugins(legalHome, pluginsPayload);
    } catch (error) {
      logInjectionFailure('plugins', '载荷注入', error);
    }
    if (SMOKE) {
      console.log(`[smoke] bundled plugins: changed=${String(pluginsSetup.changed)} pending=${String(pluginsSetup.profilePending)} payload=${pluginsPayload}`);
    }

    // 手机连接：让局域网里的手机能连上（DSH 默认只绑 127.0.0.1，手机够不着）。
    // 详见 src/main/mobile-connect.ts —— 地址是运行时探测的，不写死。
    //
    // ⚠️ 默认关闭，别删这个 if。用户叫停了手机端方向，原话是
    //    「我当场能连不够，要用户从官网下载安装好后也能用才行」——
    //    做到那一步还需要把「地址 + token」露到界面上（用户从来没见过 token）。
    //    只开端口、不给钥匙 = 用户拿不到任何好处，同 WiFi 下的其他人却多了一个入口。
    //    开关是设置里的 lanAccess；等手机端一次做全（绑 0.0.0.0 + 探测地址 + 露出凭据 + 发版）再打开。
    if (!store.get('lanAccess')) {
      if (SMOKE) console.log('[smoke] mobile access: disabled（lanAccess=false，默认）');
    } else {
      try {
        const mobile = ensureMobileAccess(legalHome, store.get('port'));
        if (SMOKE) console.log(`[smoke] mobile access: changed=${String(mobile.changed)} addrs=${mobile.addresses.join(',')}`);
      } catch (error) {
        logInjectionFailure('mobile', '手机连接配置', error);
      }
    }

    // 把「意见反馈」指到我们自己的反馈页 —— 不做的话它指向 DeepSeek 官方的飞书表单，
    // 我们用户的反馈我们一条都收不到（详见 src/main/feedback.ts）。
    try {
      const feedbackChanged = ensureFeedbackEntry(legalHome, resolveShellVersion());
      if (SMOKE) console.log(`[smoke] feedback entry: changed=${String(feedbackChanged)}`);
    } catch (error) {
      logInjectionFailure('feedback', '意见反馈入口注入', error);
    }

    service = new ServiceManager(store.get('command'), {
      port: store.get('port'),
      bundledBin,
      // 让壳拉起的 DSH 使用应用专属 home：会话与设置不落到用户自己的 ~/.dsh
      env: { DSH_HOME: legalHome },
      onLogLine: (line) => {
        usage.consumeLogLine(line);
        // DSH 开启鉴权时会把带 token 的访问地址打到日志（dsh web: http://127.0.0.1:<port>/?token=…），
        // 解析出来供加载使用；解析不到则回落裸端口地址（无鉴权部署）。
        const m = line.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/);
        if (m) {
          dshTokenUrl = m[1];
          // 冒烟专用：把带 token 的地址打出来，测试才能去查 DSH 界面。
          // 没有这一行，冒烟就只能断言"注入写了盘"，而本轮踩的坑恰恰是
          // "写盘了但界面看不到" —— 断言必须落在用户实际能看到的那个结果上。
          if (SMOKE) console.log(`[smoke] dsh token url: ${m[1]}`);
          persistTokenUrl(dshTokenUrl);
          // 用户开了「桌面地址文件」的话，token 一变就刷新它 ——
          // 否则 DSH 重启换了 token，桌面那份就是过期的，用户照着输还是进不去。
          refreshMobileAddressFile();
          // 服务就绪后窗口可能已按裸地址加载（拿到 401 鉴权页），拿到 token 立即补载
          if (mainWin && !mainWin.isDestroyed() && !mainWin.webContents.getURL().includes('token=')) {
            void mainWin.loadURL(dshTokenUrl).catch(() => {});
          }
        }
      },
    });
    usage.start();

    // 先创建窗口并显示"正在启动 DSH"页面，DSH 在后台拉起——
    // 避免冷启动时长时间无窗口（表现为"启动了没反应"）
    mainWin = createMainWindow({
      port: store.get('port'),
      closeToTray: store.get('closeToTray'),
      isQuitting: () => quitting,
      onPageReady,
      // 深链接（法律模式拉起律师端）失败时给出可操作提示，而不是静默无反应。
      onOpenExternalFailed: (url) => {
        if (/^deepwhale-law:/i.test(url)) void notifyLawyerAppUnreachable();
      },
    });
    mainWin.on('closed', () => {
      mainWin = null;
    });
    await showStartingPage(mainWin);

    /*
     * ⚠️ 这个探测必须在**拉起 DSH 之前**做（2026-10-08 修）。
     *
     * 它问的是"用户的 DSH 是不是本来就在跑"。原来它写在 `service.ensureReady()`
     * **之后** —— 而 ensureReady 会顺手把 DSH 拉起来，于是端口必然已经有应答，
     * `dshAlreadyUp` 恒为 true，下面那整段"首次启动补注入"（含 INJECT_ATTEMPTS 重试）
     * **从来没执行过**（死代码）。
     *
     * 后果（用户可见）：全新安装第一次打开时，profile 还不存在 →
     * `ensureBundledPlugins` 只能把包拷进 `<home>/plugins/`、profile 侧写不进去、
     * 返回 `profilePending: true`；而唯一的补救路径就是这段死代码 →
     * **第一次启动没有任何随包插件**（法律模式 / 右键菜单 / 打印 / 品牌标记 / 网页预览…），
     * 要等第二次启动才出现。
     *
     * 实测：冒烟在全新 home 上跑，报 `品牌标记插件没被加载（boot 列表里没有 dsh-shell-brand-mark）`。
     * 挪到前面之后，语义恢复成最初注释里写的那样：
     * "复用已在跑的 DSH 时**一个字都不能写**"（否则 DSH 的 chokidar 会触发第二次
     * HMR runExclusive，抛 `HMR transactions cannot be nested`）；
     * 而"我们自己刚把它拉起来"这条路径，正该补写。
     */
    const dshAlreadyUp = await dshPortAnswered();

    let dshReady = false;
    try {
      await service.ensureReady();
      dshReady = true;
      if (SMOKE) console.log('[smoke] DSH ready (reused or spawned)');
      // 首次启动：DSH 这时才建好 profiles/web，补齐 profile 侧注入并让窗口重载，
      // 否则页面已经按"没有该插件"的入口图渲染过了。
      // 这一段单独兜底：注入失败不能被当成"DSH 启动失败"弹错框。
      // ⚠️ 不能只看"函数返回了 changed"就收工，也不能只看写完那一刻。
      // 实测：DSH 首次启动会把旧 home 的设置**分阶段**写进
      // profiles/web/cordis.patch.yml（217 → 343 → 1529/2153 字节），
      // 而这一次写入可能落在我们追加**之后**，把刚写进去的三行整段覆盖掉 ——
      // 同一个包连跑四次全新启动，两次 0/3、两次 3/3；失败那两次的
      // package.json 注入都是好的，只有 patch 被覆盖。
      // 所以：**按文件内容校验，并要求连续两轮都看到三行**才认为稳定，
      // 中途被覆盖就重新注入（三个 ensure 都是幂等的，重跑无副作用）。
      const INJECT_ATTEMPTS = 12;
      const INJECT_RETRY_MS = 1500;
      const injectedIds = ['ui-legal-mode', 'skill-office', 'tool-workspace-dependencies'];
      // ⚠️ 看护的是 **home 级** patch，不再看 profile 级（2026-10-01 去重复）。
      //    home 级是壳自己创建、DSH 不会重写的那个文件，也是真正生效的那份；
      //    profile 级归 DSH 管（它改设置时会重写），我们的行已从那里清掉。
      const injectPatchPath = (): string => path.join(legalHome, 'cordis.patch.yml');
      const patchHasAllRows = (): boolean => {
        try {
          const text = fs.readFileSync(injectPatchPath(), 'utf8');
          return injectedIds.every((id) => text.includes(id));
        } catch {
          return false;
        }
      };
      let after: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
      let afterOffice: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
      let afterPlugins: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
      let stableRounds = 0;
      // ⚠️ 累计标记：**有没有任何一轮写过盘**。
      //
      // 不能拿循环结束后 `after.changed` 来判断「要不要重载窗口」——
      // 那是**最后一轮**的结果，而循环必然停在「连续两轮都没改动」的那一轮
      // （stableRounds >= 2 才 break），所以它几乎永远是 false。
      //
      // 后果（实测，2026-09-27）：
      //   首次启动时注入确实写进了磁盘，但重载没发生 —— 窗口里的 DSH 界面
      //   是**注入之前**加载的，不认识 ui-legal-mode 插件、花名册里也没有
      //   「法律模式」。用户看到的就是「装完没有法律模式」。
      //   这个缺陷是 v1.0.18 引入「连续两轮稳定」时带进来的：
      //   加之前最后一轮可能是 changed，加了之后必然不是。
      let anyChanged = false;
      // ⚠️ 复用已在跑的 DSH 时**一个字都不能写**（2026-10-01）：
      //   DSH 运行期间由外部改 `cordis.patch.yml`，chokidar 会触发第二次 HMR
      //   runExclusive，直接抛 `HMR transactions cannot be nested`
      //   （dsh-hmr/lib/index.js:280）—— 用户在插件页点「启用」失败就是这么来的。
      //   而 DSH 还活着，说明它早把这份配置读进去了，此刻重写没有任何收益。
      const dshAlreadyUpNote = dshAlreadyUp; // 探测已上移到 ensureReady() 之前
      if (dshAlreadyUpNote && SMOKE) {
        console.log('[smoke] DSH 已在运行 —— 跳过注入写盘（避免与其配置写入冲突）');
      }
      if (!dshAlreadyUp) {
        for (let attempt = 1; attempt <= INJECT_ATTEMPTS; attempt += 1) {
          try {
            after = ensureLegalModeSetup(legalHome, payloadDir, legalRuntimeDir);
          } catch (error) {
            logInjectionFailure('legal-mode', 'profile 注入', error);
          }
          try {
            afterOffice = ensureOfficeSetup(legalHome, officePayload, legalRuntimeDir, process.execPath);
          } catch (error) {
            logInjectionFailure('office', 'profile 注入', error);
          }
          try {
            afterPlugins = ensureBundledPlugins(legalHome, pluginsPayload);
          } catch (error) {
            logInjectionFailure('plugins', 'profile 注入', error);
          }
          anyChanged =
            anyChanged || after.changed || afterOffice.changed || afterPlugins.changed;
          const ready =
            !after.profilePending && !afterOffice.profilePending && !afterPlugins.profilePending;
          const rows = patchHasAllRows();
          if (ready && rows) {
            stableRounds += 1;
          } else {
            stableRounds = 0;
          }
          if (SMOKE) {
            console.log(
              `[smoke] profile injection (第 ${String(attempt)} 次): legal=${String(after.changed)} ` +
                `office=${String(afterOffice.changed)} plugins=${String(afterPlugins.changed)} ` +
                `ready=${String(ready)} rows=${String(rows)} stable=${String(stableRounds)}`,
            );
          }
          if (stableRounds >= 2) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, INJECT_RETRY_MS));
        }
      }
      // 兜底看护：DSH 的设置导入可能在我们收工之后才写 patch，把三行覆盖掉
      // （实测 6 次全新启动里有 1 次发生在上面那个窗口之外）。
      // 每 2 秒确认一次，发现三行不见了就补回去；连续 10 次（20 秒）都在就撤，
      // 最长看护 60 秒。只读文件 + 幂等重写，代价可忽略，
      // 且 60 秒后一定停止，不会长期干扰用户自己编辑这个文件。
      //
      // ✅ 已处理（2026-09-28）：这三行现在**优先写在 home 级** `<home>/cordis.patch.yml`。
      //   DSH 的客户端插件清单在**服务启动那一刻定型**，事后连页面重载都不变；
      //   而 profile 目录是 DSH 首次启动时才创建的 —— 所以只写 profile 级
      //   在结构上就"来不及"，这正是「首启看不到法律模式」的根因。
      //   home 级由 shell 自己创建、设置在导入时也不碰它，因此首启即可见。
      //   实测：首次启动的插件清单里直接含 @deepseek-ai/dsh-client-ui-legal-mode。
      //   profile 级仍然照写，是为了兼容已经装过 1.0.17/1.0.18 的用户；
      //   两边同时存在会插两行同 id 的条目，实测插件只挂载一次、无告警，故不做数据迁移。
      let guardTicks = 0;
      let steadyTicks = 0;
      const injectGuard = setInterval(() => {
        guardTicks += 1;
        // patch 文件本身还没落盘时**没有可看护的东西**，要算"稳定"。
        const patchReady = fs.existsSync(injectPatchPath());
        if (patchReady && patchHasAllRows()) {
          steadyTicks += 1;
        } else if (!patchReady) {
          steadyTicks += 1;
        } else {
          steadyTicks = 0;
          // ⚠️ 这里**不再重写**（2026-10-01，由另一条线交回的诊断定位）：
          //   DSH 运行期间由外部改 `cordis.patch.yml`，会和 DSH 自己的配置写入撞上 ——
          //   chokidar 触发第二次 HMR runExclusive，直接抛
          //   `HMR transactions cannot be nested`（dsh-hmr/lib/index.js:280）。
          //   用户升级 1.0.28 后遇到的闪退 / 插件异常，根因就是这个：
          //   一个"看护"动作每 2 秒重写一次配置文件，最长 60 秒。
          //
          //   改成**只读校验 + 告警**：真正的落盘只发生在"拉起 DSH 之前"那一次。
          //   （home 级的 patch 本来就不被 DSH 的设置导入覆盖，见上面 1050 行的说明，
          //     所以这里丢掉"自动补回"不会影响法律模式预设的可见性。）
          try {
            console.warn(
              '[inject] 注入行不见了 —— DSH 运行期间只读不写（避免与 DSH 的配置写入冲突）；' +
                '下次启动会在拉起 DSH 之前重新写入',
            );
          } catch (error) {
            logInjectionFailure('inject-guard', 'profile 注入补回', error);
          }
        }
        if (steadyTicks >= 10 || guardTicks >= 30) {
          clearInterval(injectGuard);
        }
      }, 2000);

      // 任一轮注入写过盘且 profile 已就位，就重载一次让新入口图生效。
      //
      // ⚠️ 这里必须用累计的 `anyChanged`，不能用最后一轮的 `after.*.changed`：
      //    循环停在「连续两轮无改动」的那一轮，最后一轮必然什么都没改，
      //    用它判断会导致**首次启动永远不重载** —— 注入写进了磁盘，
      //    窗口里的界面却还是注入前那份，「法律模式」不出现。
      //    这是 2026-09-27 实测出来的根因，v1.0.18 引入「连续两轮稳定」时带进来的。
      const profileReady =
        !after.profilePending && !afterOffice.profilePending && !afterPlugins.profilePending;
      if (anyChanged && profileReady && mainWin !== null) {
        // 等带 token 的那次导航落定再重载：两次并发导航会互相 abort
        // （表现为一条 ERR_ABORTED 告警），这里让重载晚一步。
        const win = mainWin;
        setTimeout(() => {
          if (win.isDestroyed()) {
            if (SMOKE) console.log('[smoke] reload skipped (window destroyed)');
            return;
          }
          const url = dshTokenUrl || `http://127.0.0.1:${store.get('port')}/`;
          // 「重载必须发生」在冒烟里是要断言的：只打印"已安排重载"没有意义 ——
          // 真正决定用户看到什么的是这次 loadURL 有没有跑完。
          void win
            .loadURL(url)
            .catch(() => {})
            .finally(() => {
              if (SMOKE) console.log('[smoke] reload done');
            });
        }, 800);
        if (SMOKE) console.log('[smoke] legal-mode profile injection applied; reload scheduled');
      }
    } catch (e) {
      console.error('[main] DSH 启动失败:', e);
      if (SMOKE) {
        console.error('[smoke] service failed');
        app.exit(1);
        return;
      }
      // 记入本地故障日志（不上传），并把原先"只有确定按钮"的提示改成可操作对话框：
      // 用户可以重试、看日志、打开设置，不必自己去找原因。
      dshReady = await handleDshStartFailure(e);
    }

    if (dshReady) {
      // 复用已在跑的 DSH 时，token 不会再次打日志 —— 把上次存的捞回来，
      // 否则窗口只会加载裸地址、拿到 401 认证页（见 restorePersistedTokenUrl 的说明）。
      if (dshTokenUrl === '') dshTokenUrl = await restorePersistedTokenUrl();
      if (dshTokenUrl !== '') refreshMobileAddressFile();
      // ⚠️ loadURL 是会 reject 的（本地故障日志里出现过
      //    `Error: (-3) loading 'http://127.0.0.1:3095/'`：首次加载被中止）。
      //    原来这一行抛出后，会**跳过紧随其后的托盘与应用菜单创建** ——
      //    界面最终靠后续重载兜底显示出来了，但菜单永远停在 Electron 的英文默认模板，
      //    表现成"GUI 好好的、只有菜单变英文了"，极难定位。
      //    加载本身有重载兜底，这里只记录、不向上抛。
      try {
        await mainWin.loadURL(dshTokenUrl || `http://127.0.0.1:${store.get('port')}`);
      } catch (e) {
        console.warn('[main] 首次加载界面失败（后续重载兜底）：', e);
      }
    } else {
      await showStartingPage(mainWin, true);
    }

    if (store.get('petVisible')) pet.create();

    tray = createTray(buildMenuActions());
    rebuildMenus();

    // 自动更新：**无条件启动**（2026-10-02 改）。
    //
    // ⚠️ 这段原来关在 `if (dshReady)` 里，理由是"DSH 没起来时用户有更紧急的问题要处理"。
    //    那个理由**恰好反了**：DSH 起不来时，用户唯一的出路就是**装上修好的新版** ——
    //    而这道 guard 让更新检查根本不跑，于是他被永久困住。
    //    真实场景（用户报上来的）：1.0.37 因配置写坏起不来 → **永远等不到更新提示** →
    //    只能手动下载覆盖安装，而他是小白，做不了。
    //    更新检查与 DSH 是否就绪无关，必须无条件启动
    //    （UpdateManager 自己会处理"没有窗口"的情况，下面的回调也都有空值保护）。
    {
            updates = new UpdateManager({
        // 用户要求（2026-10-04）：「弹出更新面板应该在更新同时弹出，而不是藏在那个后面」。
        // 下载一开始：把主窗口前置 + 发系统通知（不阻塞），让用户立刻知道在更新。
        onDownloadStart: () => {
          try {
            if (mainWin && !mainWin.isDestroyed()) {
              if (!mainWin.isVisible()) mainWin.show();
              mainWin.focus();
            }
            // 用户要求：「弹出更新面板应该在更新同时弹出」——用精心设计的弹窗，而不是系统对话框
            const ver = (updates?.getState() as { version?: string } | undefined)?.version || '';
            void showUpdatePopup(ver, {
              phase: 'downloading',
              percent: (updates?.getState() as { percent?: number } | undefined)?.percent ?? null,
            });

            try {
              if (app.dock && typeof app.dock.bounce === 'function') app.dock.bounce('informational');
            } catch {
              /* 非 mac 没有 dock */
            }
            if (Notification.isSupported()) {
              new Notification({
                title: '正在下载深鲸桌面更新',
                body: '下载完成后会提示重启应用，本版更新内容可在提示中查看。',
              }).show();
            }
          } catch (e) {
            console.warn('[update] 下载开始前置/通知失败（已忽略）:', e);
          }
        },
       getWindow: () => (mainWin !== null && !mainWin.isDestroyed() ? mainWin : null),
        // ★ 进度**采了必须显示出来**。
        //   原来这里没有接 onStateChange —— 下载进度被采到了、然后直接扔掉，
        //   用户点了「立即下载」之后只看得到一个弹窗，之后什么都没有。
        //   官方有进度条、我们没有，缺的就是这一段。
        //   两处可见反馈，都不需要新开窗口：
        //     ① 托盘提示文字：悬停就能看到百分比
        //     ② Dock / 任务栏上的进度条：setProgressBar
        onStateChange: (state) => {
          try {
            updatePopupState({ phase: state.phase, percent: (state as { percent?: number }).percent ?? null, message: state.message });
          } catch {
            /* 弹窗不在就算了 */
          }
          try {
            const pct = typeof state.percent === 'number' ? state.percent : null;
            const downloading = state.phase === 'downloading' && pct !== null;
            if (downloading) {
              tray?.setToolTip(`深鲸桌面 · 正在下载更新 ${String(pct)}%`);
              if (mainWin !== null && !mainWin.isDestroyed()) {
                // 传 0 会被当成"无进度"，所以最小给 0.01
                mainWin.setProgressBar(Math.max(0.01, pct / 100));
              }
            } else {
              tray?.setToolTip('DeepWhale Desktop');
              if (mainWin !== null && !mainWin.isDestroyed()) mainWin.setProgressBar(-1);
            }
          } catch {
            // 进度显示失败绝不能影响更新本身
          }
        },
      });
      try {
        updates.start();
      } catch (error) {
        console.error('[update] 自动更新启动失败（不影响使用）:', error);
      }
    }

    // 首次启动引导：只在全新安装且未标记 onboarded 时弹出。
    // 放在主窗口可用之后，避免与"正在启动 DSH"页抢焦点；
    // 老用户升级时 firstRun 恒为 false，这条分支不会进入。
    if (firstRun) {
      openWelcomeWindow();
    }

    if (SMOKE) {
      /**
       * 检查链是否真的跑完了。
       *
       * ⚠️ 2026-10-08 修：这里原来是 `setTimeout(() => { …app.quit(); }, 15000)` —— **写死 15 秒**。
       *    而下面那条检查链里的显式 sleep 合计就有 **34 秒**，于是从"whatsnew 回源"（约 2413 行）
       *    往后的断言（**品牌标记** / 快捷键 / 菜单 / 宠物动画…）**从来没执行过**，
       *    而冒烟照样打印 `[smoke] ok`、照样退 0 —— 这道门实际上一直是摆设。
       *    这正是 brand-mark / web-preview 两个插件能丢失两个多月没人发现的原因之一。
       */
      let smokeChecksDone = false;
      // 端到端检查：打开设置页 → 验证注入的"宠物/用量/皮肤"导航项与面板激活
      setTimeout(() => {
        void (async () => {
          try {
            /**
             * 页面稳定闸门（2026-10-08 加）。
             *
             * 为什么必须有：首次启动时 profile 还不存在，`ensureBundledPlugins` 会返回
             * `profilePending: true`，等 DSH 建好 profile 后**补注入并让窗口重载一次**
             * （见本文件"首次启动：DSH 这时才建好 profiles/web"那段）。
             *
             * 重载期间页面是空的 —— 此时任何 DOM 探测都会得到**假失败**。实测（隔离实例、
             * 全新 home）：`settings-ext` 全 false、`sidebar-probe` 的 sidebarNav=null、
             * `skin` 外圈与中心同色（辉光没出来）、`进度条 runner=false`。
             * 这些都不是功能坏了，是**探测撞在重载的空窗期里**。
             *
             * 所以先等到"侧栏「设置」可点 + 正文有内容"再开始查。
             * 注意这**不是**放宽断言：等不到照样记失败（下面会 exitCode=1）。
             */
            const settled = await (async () => {
              for (let i = 0; i < 90; i += 1) {
                const ok = await mainWin!.webContents
                  .executeJavaScript(
                    `(() => {
                       const els = [...document.querySelectorAll('span')];
                       const s = els.find((e) => e.textContent.trim() === '设置');
                       return !!(s && s.closest('button,[role="button"],a') && document.body.innerText.length > 200);
                     })()`,
                  )
                  .catch(() => false);
                if (ok) return i;
                await new Promise((r) => setTimeout(r, 500));
              }
              return -1;
            })();
            if (settled < 0) {
              console.error('[smoke] ❌ 页面 45 秒内没有稳定下来（侧栏「设置」始终不可点）—— 后续探测不可信');
              process.exitCode = 1;
            } else if (settled > 0) {
              console.log(`[smoke] 等页面稳定：重试 ${settled} 次（首启补注入会触发一次重载）`);
            }

            const r = await mainWin!.webContents.executeJavaScript(`(async () => {
              const clickTxt = (txt) => { const els = [...document.querySelectorAll('span')].filter(e => e.textContent.trim() === txt); if (els[0]) { els[0].click(); return true; } return false; };
              clickTxt('设置');
              await new Promise(r => setTimeout(r, 1500));
              const has = (id) => !!document.getElementById(id);
              const petNav = document.getElementById('dsh-ext-nav-pet');
              let activated = false, petItems = 0, themeItems = 0, usageRows = 0, petNavOn = false;
              if (petNav) {
                petNav.click();
                await new Promise(r => setTimeout(r, 700));
                const panel = document.getElementById('dsh-ext-panel');
                activated = !!panel && panel.style.display !== 'none';
                petNavOn = petNav.classList.contains('dsh-ext-nav-on');
                petItems = document.querySelectorAll('#dsh-ext-pet-list .dsh-ext-item').length;
                const skinNav = document.getElementById('dsh-ext-nav-skin');
                if (skinNav) { skinNav.click(); await new Promise(r => setTimeout(r, 400)); themeItems = document.querySelectorAll('#dsh-ext-theme-list .dsh-ext-item').length; }
                const usageNav = document.getElementById('dsh-ext-nav-usage');
                if (usageNav) { usageNav.click(); await new Promise(r => setTimeout(r, 400)); usageRows = document.querySelectorAll('#dsh-ext-usage-body .row').length || document.querySelectorAll('#dsh-ext-panel .dsh-ext-grid .row').length; }
              }
              // 「当前版本」那行旁边应当有壳的版本号（用户在通用设置里就能看到）
              const verEl = document.getElementById('dsh-ext-shell-version');
              const verText = verEl ? verEl.textContent.trim() : '';
              // 直接读我们贴上去那个节点的父元素 —— 别再遍历找"叶子节点"：
              // 那行被我们加了子元素之后就不再是叶子，遍历会把它跳过（第一版就踩了这个）。
              const verRow = verEl && verEl.parentElement ? verEl.parentElement.textContent.trim() : '';
              return JSON.stringify({ navPet: has('dsh-ext-nav-pet'), navUsage: has('dsh-ext-nav-usage'), navSkin: has('dsh-ext-nav-skin'), panel: has('dsh-ext-panel'), privacy: !!document.getElementById('dsh-ext-privacy'), activated, petNavOn, petItems, themeItems, usageRows, verText, verRow });
            })()`);
            console.log('[smoke] settings-ext:', r);
            // ★ 断言落在用户看得见的地方：通用设置里「当前版本」旁边必须有壳版本号，
            //   而且**随包 DSH 运行时的版本也必须在这行里**。
            //   只断言"注入脚本没报错"是不够的 —— 找错节点、DSH 改了结构，
            //   都会静默变成"界面上什么都没有"。
            //   加 DSH 版本这一条是 2026-09-29 升级 0.2.0-rc.2 时加的：
            //   换随包运行时是壳里最容易"装着新的其实跑着旧的"的地方
            //   （asar 里那份没更新、兜底 npx 命令指向旧版，从外面都看不出来），
            //   而这行显示的正是**当前真正在跑的那个运行时**的版本。
            try {
              const parsed = JSON.parse(r);
              const want = expectedVersionRow();
              if (!parsed.verText) {
                console.error('[smoke] 壳版本号未出现在设置页（verRow=' + parsed.verRow + '）');
                process.exitCode = 1;
              } else if (!parsed.verText.includes(want.shell)) {
                console.error('[smoke] 壳版本号不对：界面显示 "' + parsed.verText + '"，期望含 ' + want.shell);
                process.exitCode = 1;
              } else if (!parsed.verRow.includes(want.dsh)) {
                console.error(
                  '[smoke] 设置页显示的 DSH 版本不对：那行是 "' + parsed.verRow +
                  '"，期望含随包运行时版本 ' + want.dsh + '（说明真正在跑的不是随包那份）',
                );
                process.exitCode = 1;
              } else {
                if (!(parsed as { privacy?: boolean }).privacy) {
                  console.error('[smoke] 设置页没有「本机运行 · 遥测与埋点默认关闭」说明（用户实测找不到）');
                  process.exitCode = 1;
                } else {
                  console.log('[smoke] 设置页隐私说明已显示 ✓');
                }
                console.log('[smoke] 设置页已显示壳版本：' + parsed.verRow);
                try {
                  // 先切到「通用设置」（「当前版本」那行在这里，隐私说明挂在它下面）
                  await mainWin!.webContents.executeJavaScript(`(async () => {
                    const items = Array.from(document.querySelectorAll('div,span,li,button'));
                    const nav = items.find((n) => n.children.length === 0 && (n.textContent || '').trim() === '通用设置');
                    if (nav) (nav.closest('[role="button"],button,li,div') || nav).click();
                    await new Promise((r) => setTimeout(r, 700));
                    return true;
                  })()`);
                  await new Promise((r) => setTimeout(r, 500));
                  const shot = await mainWin!.webContents.capturePage();
                  fs.mkdirSync('/tmp/dsh-privacy-shot', { recursive: true });
                  fs.writeFileSync('/tmp/dsh-privacy-shot/general.png', shot.toPNG());
                  console.log('[smoke] 通用设置页截图：/tmp/dsh-privacy-shot/general.png');
                } catch (e9) {
                  console.warn('[smoke] 设置页截图失败:', e9);
                }
              }
            } catch (e) {
              console.error('[smoke] 壳版本号断言无法解析结果:', e);
              process.exitCode = 1;
            }
          } catch (e) {
            console.error('[smoke] settings-ext 检查失败:', e);
          }

          // ── 侧栏「设置」右侧下载进度条：定位探针 + 通路探针 + 硬断言 ───────
          // 起因（2026-10-03 用户反馈）：下载时 Dock 图标有进度，侧栏「设置」旁边什么也没有。
          // 实测结论：1.0.45 的条**插上了、也跟得上进度**，但只有 6px 高、无文字，
          // 用户根本注意不到。所以断言必须落在"尺寸 / 文字 / 位置"这些用户真能感知的量上 ——
          // 只断言"节点存在"是不够的：细到看不见、被挤出视口时节点照样在。
          try {
            const probe = await mainWin!.webContents.executeJavaScript(`(() => {
              const desc = (el) => {
                if (!el) return 'null';
                const cls = (el.className && typeof el.className === 'string') ? el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '';
                return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '');
              };
              const chain = (el, n) => { const out = []; let p = el; for (let i = 0; i < n && p; i++) { out.push(desc(p)); p = p.parentElement; } return out.join(' < '); };
              const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
              const cands = [...document.querySelectorAll('button,[role="button"],a,div,span')]
                .filter((e) => e.children.length === 0 && e.textContent.trim() === '设置');
              const side = document.getElementById('dsh-ext-dl');
              const label = cands[0] ?? null;
              const anc = [];
              if (label) {
                let p = label.parentElement;
                for (let i = 0; i < 4 && p; i++) {
                  const cs = getComputedStyle(p);
                  anc.push(desc(p) + ' ' + JSON.stringify(rect(p)) + ' display=' + cs.display + ' overflow=' + cs.overflow);
                  p = p.parentElement;
                }
              }
              const navEl = document.querySelector('nav');
              return JSON.stringify({
                vp: { w: innerWidth, h: innerHeight },
                nCands: cands.length,
                cands: cands.slice(0, 6).map((e) => ({ at: desc(e), chain: chain(e, 4), rect: rect(e), clickable: !!e.closest('button,[role="button"],a') })),
                labelAncestors: anc,
                sidebarNav: navEl ? rect(navEl) : null,
                side: side ? { chain: chain(side, 4), display: side.style.display, rect: rect(side) } : null,
              });
            })()`);
            console.log('[smoke] sidebar-probe:', probe);

            // ⚠️ 2026-10-04 回归断言（用户实机："全屏时一整片怪白页、会话文字透上来"）：
            //    皮肤不能把 `--dsw-alias-bg-base` 打薄 —— DSH **铺满视口**的平台浮层
            //    （实测：`.<hash>_overlay{background:var(--dsw-alias-bg-base);position:fixed;inset:0}`，
            //     来自 dsh-client-ui-settings-account）就是用它当底色的。
            //
            // ⚠️ 2026-10-08：**这道断言此前是坏的**，永远通过 —— 这正是白屏反复复发的原因。
            //    两个毛病：
            //      ① 探针元素 `className = 'dsh-probe-overlay'` **匹配不到任何 CSS 规则**
            //         （真实类是带 hash 的 `.<hash>_overlay`）→ 量到的永远是 `rgba(0,0,0,0)`；
            //      ② 判定写成 `!/rgba\([^)]*,\s*0?\.\d+\)|transparent/`：
            //         `rgba(0, 0, 0, 0)` 里既没有 `0.xx` 也没有 `transparent` 这个词，
            //         于是**全透明被判成"不透明"**，还打印「浮层不透明（不会被掏空）」。
            //    现在改成：从**真实存在的浮层元素**上取计算样式，并按 alpha 数值判定（必须 =1）。
            const skinProbe = await mainWin!.webContents.executeJavaScript(`(() => {
              const cs = getComputedStyle(document.body);
              const token = (cs.getPropertyValue('--dsw-alias-bg-base') || '').trim();
              const frame = document.querySelector('[class*="frame"]');
              const frameBg = frame ? getComputedStyle(frame).backgroundColor : 'no-frame';

              // 找出**真正拿 --dsw-alias-bg-base 当背景**的浮层规则。
              // 为什么要查规则而不是查元素：透明的浮层分两种 ——
              //   ① 合法的：纯布局包装层（如设置弹窗的 VOzbGW_overlay，自身没有背景）
              //   ② 有病的：铺满视口、用该 token 当底色（如 _44HXVa_overlay，账号/设置全屏层）
              // 只看计算样式分不出来（token 是 transparent 时两者都算出 rgba(0,0,0,0)），
              // 所以直接读规则里有没有 background: var(--dsw-alias-bg-base)。
              const basePainters = [];
              for (const sheet of Array.from(document.styleSheets)) {
                let rules;
                try { rules = sheet.cssRules; } catch (e) { continue; } // 跨域表会抛
                for (const r of Array.from(rules || [])) {
                  const sel = r.selectorText || '';
                  if (!sel || sel.indexOf('_overlay') < 0) continue;
                  const bg = (r.style && r.style.getPropertyValue('background')) || '';
                  const bgi = (r.style && r.style.getPropertyValue('background-image')) || '';
                  if (/--dsw-alias-bg-base/.test(bg + ' ' + bgi)) basePainters.push({ sel: sel.slice(0, 80), bg: bg.slice(0, 80) });
                }
              }

              // 页面上真有这种浮层时，直接量它的实际底色
              const live = [...document.querySelectorAll('[class*="_overlay"]')]
                .map((el) => {
                  const s = getComputedStyle(el);
                  return { cls: String(el.className || '').slice(0, 60), bg: s.backgroundColor, pos: s.position };
                })
                .filter((o) => o.pos === 'fixed' && o.bg && o.bg !== 'rgba(0, 0, 0, 0)');

              // 关键探针：在**一个匹配 [class*="_overlay"] 的真实元素**上量 token。
              // 这正是原来那条断言想做但做错的事 —— 它用的类名匹配不到任何 CSS 规则，
              // 所以永远量到 rgba(0,0,0,0)。这里让探针**真的命中我们的覆盖规则**。
              const probe = document.createElement('div');
              probe.className = 'dsh-probe-x_overlay';
              probe.style.cssText = 'position:fixed;left:-9999px;top:0;width:4px;height:4px;';
              document.body.appendChild(probe);
              const probeToken = getComputedStyle(probe).getPropertyValue('--dsw-alias-bg-base').trim();
              const probeBg = getComputedStyle(probe).backgroundColor;
              probe.remove();

              return JSON.stringify({ token, frameBg, basePainters, live, probeToken, probeBg });
            })()`);
            console.log('[smoke] skin-token:', skinProbe);
            {
              const sp = JSON.parse(skinProbe) as {
                token: string;
                frameBg: string;
                basePainters?: { sel: string; bg: string }[];
                live?: { cls: string; bg: string; pos: string }[];
                probeToken?: string;
              };
              // 皮肤底色按 1.0.47 标准（用户拍板）：**不对 token 本身做要求** ——
              // 47 的深色预设本来就是半透明底色，那是对的（辉光要靠它透出来）。
              console.log('[smoke] 皮肤底色（按 47 标准，不做限制）：' + sp.token);

              /** 按计算样式的 alpha 数值判定是否不透明（支持 rgb()/rgba()/transparent/百分比）。 */
              const alphaOf = (v: string): number => {
                const s = String(v || '').trim();
                if (!s || s === 'transparent') return 0;
                const m = s.match(/rgba?\(([^)]+)\)/i);
                if (!m) return 1; // 非 rgb 形式按不透明处理，避免误报
                const parts = m[1].split(/[,/]/).map((x) => x.trim()).filter((x) => x !== '');
                if (parts.length < 4) return 1;
                const raw = parts[3];
                const a = Number(raw.replace('%', ''));
                if (Number.isNaN(a)) return 1;
                return raw.includes('%') ? a / 100 : a;
              };

              const painters = sp.basePainters || [];
              const live = (sp.live || []).filter((o) => alphaOf(o.bg) < 1);
              const probeAlpha = alphaOf(String(sp.probeToken || ''));
              if (painters.length === 0) {
                // 没找到"拿 token 当底色"的浮层规则 —— 可能 DSH 换了实现，值得知道
                console.log('[smoke] 没有找到拿 --dsw-alias-bg-base 当背景的浮层规则（DSH 实现可能变了）');
              } else if (probeAlpha < 1) {
                console.error(
                  '[smoke] ❌ 浮层子树里的 --dsw-alias-bg-base 仍是半透明（' + String(sp.probeToken) +
                    '）→ 全屏会出现"怪白页/会话文字透上来"。受影响规则=' + JSON.stringify(painters),
                );
                process.exitCode = 1;
              } else if (live.length > 0) {
                console.error(
                  '[smoke] ❌ 页面上铺满视口的浮层底色不是不透明的 → 全屏会出现"怪白页/会话文字透上来"：' +
                    JSON.stringify(live),
                );
                process.exitCode = 1;
              } else {
                console.log(
                  '[smoke] ✅ 浮层不透明：拿 bg-base 当底色的规则 ' + String(painters.length) +
                    ' 条；浮层子树内 token=' + String(sp.probeToken) +
                    '（正文层仍是 ' + sp.token + '，辉光不受影响）',
                );
              }
            }

            // —— 「本机内文件」第三张卡片 + 面板（2026-10-04，用户要求并列第三位）——
            //    ⚠️「开始」面板只在**空白会话**时渲染 → 这里先点一次「新会话」把它带出来，
            //       否则断言会假失败（第一版就栽在这）。
            try {
              await mainWin!.webContents.executeJavaScript(`(async () => {
                const clickByText = (text) => {
                  const all = document.querySelectorAll('button, [role="button"], a, div, span');
                  for (const n of all) {
                    if (n.children.length === 0 && (n.textContent || '').trim() === text) {
                      const target = n.closest('button,[role="button"],a') || n;
                      target.click();
                      return true;
                    }
                  }
                  return false;
                };
                clickByText('新会话');
                await new Promise((r) => setTimeout(r, 1200));
                return true;
              })()`);
            } catch (e) {
              console.warn('[smoke] 点新会话失败（不影响后续断言）:', e);
            }
            try {
              const lf = await mainWin!.webContents.executeJavaScript(`(async () => {
                const card = document.getElementById('dsh-local-files-card');
                if (!card) {
                  // 诊断：首屏到底有没有「开始」面板的那两张卡
                  const hasWsCard = Array.from(document.querySelectorAll('*')).some(
                    (n) => n.children.length === 0 && (n.textContent || '').trim() === '工作区文件',
                  );
                  return JSON.stringify({ card: false, hasWsCard, hash: location.hash });
                }
                if (!card) return JSON.stringify({ card: false });
                const r = card.getBoundingClientRect();
                const txt = card.textContent || '';
                card.click();
                await new Promise((res) => setTimeout(res, 700));
                const panel = document.getElementById('dsh-local-files-panel');
                const rows = document.querySelectorAll('#dsh-local-files-panel-list > div').length;
                const crumbs = document.getElementById('dsh-local-files-panel-crumbs');
                return JSON.stringify({
                  card: true,
                  w: Math.round(r.width), h: Math.round(r.height),
                  hasText: txt.indexOf('本机内文件') >= 0,
                  panelOpen: !!panel && panel.style.display !== 'none',
                  rows: rows,
                  dir: crumbs ? crumbs.textContent : '',
                });
              })()`);
              const l = JSON.parse(lf) as {
                card: boolean; w?: number; h?: number; hasText?: boolean; panelOpen?: boolean;
                rows?: number; dir?: string; hasWsCard?: boolean; hash?: string;
              };
              if (!l.card) {
                // 「开始」面板只在空白会话时渲染 → 冒烟环境里没有它是正常的。
                // 真正的硬断言放在下面（设置页那条**永远可达**的入口 + 面板能否列出内容）。
                console.log(
                  '[smoke] 「开始」面板本次未渲染（hasWsCard=' + String(l.hasWsCard) +
                    '，hash=' + String(l.hash) + '）→ 第三张卡片跳过校验，改验设置页入口',
                );
              } else if (!l.hasText || (l.w ?? 0) < 200 || (l.h ?? 0) < 44) {
                console.error('[smoke] 卡片尺寸/文案不对：' + lf);
                process.exitCode = 1;
              } else if (!l.panelOpen || (l.rows ?? 0) < 1) {
                console.error('[smoke] 点卡片没打开面板或没列出内容：' + lf);
                process.exitCode = 1;
              } else {
                console.log('[smoke] 本机内文件：卡片 ' + String(l.w) + '×' + String(l.h) + '，面板列出 ' + String(l.rows) + ' 项，目录=' + String(l.dir));
              }
            } catch (e) {
              console.error('[smoke] 本机内文件检查失败:', e);
              process.exitCode = 1;
            }

            // —— 本机内文件面板：形态校验 + 出图（放这里是因为这段每次都会执行）——
            try {
              const pc = JSON.parse(
                await mainWin!.webContents.executeJavaScript(`(async () => {
                  // 先造"开始"面板的同结构假壳（真面板只在空白会话出现，冒烟里没有），
                  // 本机内文件卡片是常驻 MutationObserver 补插的，造好等它插进来即可
                  if (!document.getElementById('smoke-fake-hero')) {
                    const box = document.createElement('div');
                    box.id = 'smoke-fake-hero';
                    box.style.cssText = 'position:fixed;left:-9999px;top:0;width:620px;';
                    box.innerHTML =
                      '<div style="width:560px">' +
                      '<div role="button" style="width:560px;height:96px"><span>工作区文件</span><span>浏览会话工作区的文件</span></div>' +
                      '<div role="button" style="width:560px;height:96px"><span>新建终端</span><span>在会话工作区运行命令</span></div>' +
                      '</div>';
                    document.body.appendChild(box);
                    await new Promise((r) => setTimeout(r, 2600));
                  }
                  const card = document.getElementById('dsh-local-files-card');
                  if (!card) return JSON.stringify({ ok: false, why: 'no-card' });
                  card.click();
                  await new Promise((r) => setTimeout(r, 1000));
                  const panel = document.getElementById('dsh-local-files-panel');
                  const input = document.getElementById('dsh-local-files-panel-path');
                  return JSON.stringify({
                    ok: !!panel && panel.style.display !== 'none',
                    hasInput: !!input,
                    path: input ? input.value : '',
                    rows: document.querySelectorAll('#dsh-local-files-panel-list > div').length,
                    svgs: document.querySelectorAll('#dsh-local-files-panel-list svg').length,
                    buttons: document.querySelectorAll('#dsh-local-files-panel-list button').length,
                  });
                })()`),
              ) as { ok: boolean; hasInput?: boolean; path?: string; rows?: number; svgs?: number; buttons?: number; why?: string };
              if (!pc.ok || !pc.hasInput || (pc.rows ?? 0) < 1) {
                console.error('[smoke] 本机内文件面板异常：' + JSON.stringify(pc));
                process.exitCode = 1;
              } else if ((pc.buttons ?? 0) !== 0) {
                console.error('[smoke] 面板行里还有按钮（应已去掉「显示」）：' + String(pc.buttons));
                process.exitCode = 1;
              } else {
                console.log(
                  '[smoke] 本机内文件面板 ✓ 行 ' + String(pc.rows) + ' · SVG 图标 ' + String(pc.svgs) +
                    ' · 行内按钮 ' + String(pc.buttons) + ' · 路径=' + String(pc.path),
                );
                try {
                  const shot = await mainWin!.webContents.capturePage();
                  fs.mkdirSync('/tmp/dsh-localfiles', { recursive: true });
                  fs.writeFileSync('/tmp/dsh-localfiles/panel.png', shot.toPNG());
                  console.log('[smoke] 面板截图：/tmp/dsh-localfiles/panel.png');
                } catch (e6) {
                  console.warn('[smoke] 面板截图失败:', e6);
                }
                // 面板内预览（新增能力）：拿应用里的一个文本文件试一下
                const pv = JSON.parse(
                  await mainWin!.webContents.executeJavaScript(`(async () => {
                    const probe = ${JSON.stringify(path.join(app.getAppPath(), 'package.json'))};
                    if (!window.dsh || typeof window.dsh.localFilesPreview !== 'function') {
                      return JSON.stringify({ ok: false, why: 'no-bridge' });
                    }
                    const r = await window.dsh.localFilesPreview(probe);
                    return JSON.stringify({ ok: !!(r && r.ok), kind: r && r.kind, len: r && r.text ? r.text.length : 0 });
                  })()`),
                ) as { ok: boolean; kind?: string; len?: number; why?: string };
                if (!pv.ok || pv.kind !== 'text') {
                  console.error('[smoke] 面板内预览不可用：' + JSON.stringify(pv));
                  process.exitCode = 1;
                } else {
                  console.log('[smoke] 面板内预览 ✓（kind=' + String(pv.kind) + '，' + String(pv.len) + ' 字符）');
                }

                // 关掉面板，免得影响后面的截图
                await mainWin!.webContents.executeJavaScript(
                  "const p=document.getElementById('dsh-local-files-panel'); if(p) p.style.display='none'; true",
                );
              }
            } catch (e) {
              console.warn('[smoke] 面板检查异常:', e);
            }

            // —— 演示模式（DSH_PROMO_DEMO=1）：**只切状态不截图**，每 90 秒一个，
            //    供用户自己从容截图；应用保持运行不退出。
            if (process.env.DSH_PROMO_DEMO === '1') {
              const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
              const js2 = (code: string) => mainWin!.webContents.executeJavaScript(code).catch(() => null);
              const setTheme = (dark: boolean) =>
                js2(dark
                  ? "document.body.setAttribute('data-ds-dark-theme','');document.documentElement.setAttribute('data-ds-dark-theme','');true"
                  : "document.body.removeAttribute('data-ds-dark-theme');document.documentElement.removeAttribute('data-ds-dark-theme');true");
              void (async () => {
                // ① 自动点掉首启「预览版说明」弹窗
                for (let i = 0; i < 10; i++) {
                  await wait(2000);
                  const clicked = await mainWin!.webContents.executeJavaScript(`(() => {
                    const b = Array.from(document.querySelectorAll('button'))
                      .find((e) => ['继续','知道了','我知道了','开始使用'].includes((e.textContent||'').trim()));
                    if (b) { b.click(); return true; }
                    return false;
                  })()`).catch(() => false);
                  if (clicked) break;
                }
                console.log('[demo] ===== 演示模式开始（每 90 秒换一个状态）=====');
                console.log('[demo] 状态 1/4：主界面 · 深色   （90 秒）');
                await setTheme(true);
                await wait(90_000);
                console.log('[demo] 状态 2/4：主界面 · 浅色   （90 秒）');
                await setTheme(false);
                await wait(90_000);
                console.log('[demo] 状态 3/4：本机内文件面板（示例文件）· 浅色（90 秒）');
                await js2("window.__dshLocalFiles && window.__dshLocalFiles.open && window.__dshLocalFiles.open(); true");
                await wait(1200);
                await js2(`(() => { const i = document.getElementById('dsh-local-files-panel-path'); if (i) { i.value = '/Users/mac/DeepSeek Harness/演示素材/示例案件材料'; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } return true; })()`);
                await wait(90_000);
                console.log('[demo] 状态 4/4：文档预览（点开示例合同）· 浅色（90 秒）');
                await js2("(() => { const rows = Array.from(document.querySelectorAll('#dsh-local-files-panel-list > div')); const d = rows.find((r) => (r.textContent||'').indexOf('示例-采购合同') >= 0); if (d) d.click(); return true; })()");
                await wait(120_000);
                console.log('[demo] 演示结束：应用保持打开，你可以继续截任何状态');
              })();
            }

            // —— 宣传截图采集（DSH_PROMO_SHOTS=1）：深色/浅色 × 本机内文件面板/文档预览 ——
            // 用全新 user-data-dir 跑，所以会话列表天然为空（无需折叠，也更干净）。
            if (process.env.DSH_PROMO_SHOTS === '1') {
              const dir = '/tmp/dsh-promo';
              fs.mkdirSync(dir, { recursive: true });
              const shot = async (name: string) => {
                try {
                  const img = await mainWin!.webContents.capturePage();
                  fs.writeFileSync(path.join(dir, name + '.png'), img.toPNG());
                  console.log('[promo] ok ' + name);
                } catch (e) {
                  console.error('[promo] 失败 ' + name + ': ' + String(e));
                }
              };
              const js = async (code: string): Promise<void> => {
                try {
                  await mainWin!.webContents.executeJavaScript(code);
                } catch (e) {
                  console.error('[promo] 脚本失败: ' + String(e).slice(0, 120));
                }
              };
              // PROMO_NO_THEME_FORCE：不改主题（由 settings.json 决定），避免重渲染打断采集
              const theme = async (_dark?: boolean) => { await new Promise((r) => setTimeout(r, 600)); };
              const demo = '/Users/mac/DeepSeek Harness/演示素材/示例案件材料';
              // ① 打开本机内文件面板并进入示例目录
              // PROMO_V3：**必须先退出设置页**，否则截到的是设置 ✗
              //   ① Esc ② 关掉可能的遮罩 ③ 点侧栏「新会话」（多策略，避免点不动）
              await js(`(async () => {
                document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise((r) => setTimeout(r, 400));
                const leaves = Array.from(document.querySelectorAll('span,div,a,button'))
                  .filter((e) => e.children.length === 0 && (e.textContent || '').trim() === '新会话');
                for (const leaf of leaves) {
                  let p = leaf;
                  for (let i = 0; i < 5 && p; i++) {
                    if (p.tagName === 'BUTTON' || p.getAttribute && p.getAttribute('role') === 'button' || p.tagName === 'A') {
                      p.click();
                      break;
                    }
                    p = p.parentElement;
                  }
                }
                return true;
              })()`);
              // PROMO_V4：先点掉「预览版说明」等首启弹窗（它们会挡住整个工作区）
              await js(`(async () => {
                for (let round = 0; round < 3; round++) {
                  const btns = Array.from(document.querySelectorAll('button,div,span'))
                    .filter((e) => ['继续', '知道了', '我知道了', '开始使用'].includes((e.textContent || '').trim()));
                  if (!btns.length) break;
                  let p = btns[0];
                  for (let i = 0; i < 4 && p; i++) { if (p.tagName === 'BUTTON') { p.click(); break; } p = p.parentElement; }
                  await new Promise((r) => setTimeout(r, 600));
                }
                return true;
              })()`);
              await new Promise((r) => setTimeout(r, 2000));
              await shot('0-正面全景');
              await new Promise((r) => setTimeout(r, 300));
              await shot('0b-主界面');
              await js("window.__dshLocalFiles && window.__dshLocalFiles.open && window.__dshLocalFiles.open(); true");
              await new Promise((r) => setTimeout(r, 900));
              await js(`(() => { const i = document.getElementById('dsh-local-files-panel-path'); if (i) { i.value = ${JSON.stringify(demo)}; i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); } return true; })()`);
              await new Promise((r) => setTimeout(r, 1200));
              await theme(true);
              await shot('1-深色-本机内文件面板');
              await theme(false);
              await shot('2-浅色-本机内文件面板');
              // ② 点开示例 docx → 侧栏预览（转换要几秒）
              await js("(() => { const rows = Array.from(document.querySelectorAll('#dsh-local-files-panel-list > div')); const d = rows.find((r) => (r.textContent||'').indexOf('示例-采购合同') >= 0); if (d) d.click(); return true; })()");
              await new Promise((r) => setTimeout(r, 4000));
              await theme(true);
              await shot('3-深色-文档预览');
              await theme(false);
              await shot('4-浅色-文档预览');
              // ③ 单独截桌面宠物（大肥鱼）→ 后续合成到画面右下角
              try {
                const all = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w !== mainWin);
                const petWin = all.find((w) => {
                  const [ww, hh] = w.getSize();
                  return ww > 60 && ww < 600 && hh > 60 && hh < 600;
                });
                if (petWin) {
                  const img = await petWin.webContents.capturePage();
                  fs.writeFileSync(path.join(dir, 'pet.png'), img.toPNG());
                  console.log('[promo] ok pet（大肥鱼）');
                } else {
                  console.log('[promo] 未找到宠物窗（可能未开启）');
                }
              } catch (e) {
                console.error('[promo] 截宠物失败: ' + String(e));
              }
              await theme(true);
              console.log('[promo] 采集结束 → ' + dir);
            }

            // —— 皮肤：双主题截图 + 像素验证（用户要求"确切验证辉光和洗白"）——
            // 教训：第一版这里①截图太早（抓到白页）②主题标签靠猜（写反了）。
            // 现在：等页面稳定 → 从 DOM 读实际主题 → 截图 → 再切主题截第二张 → 逐像素验证。
            try {
              const shotDir = '/tmp/dsh-skin-themes';
              fs.mkdirSync(shotDir, { recursive: true });
              // 等界面真的就绪（frame 出现 + 稳定 800ms），否则截到的是"正在启动"白页
              for (let i = 0; i < 20; i++) {
                const ready = await mainWin!.webContents.executeJavaScript(
                  '!!document.querySelector("[class*=frame]")',
                );
                if (ready) break;
                await new Promise((r) => setTimeout(r, 400));
              }
              await new Promise((r) => setTimeout(r, 800));

              // 辉光的 CSS 硬断言：body 上必须有 radial-gradient（预设把辉光画在 body 上）
              const glowCss = await mainWin!.webContents.executeJavaScript(
                "getComputedStyle(document.body).backgroundImage",
              );
              if (String(glowCss).indexOf('radial-gradient') < 0) {
                console.error('[smoke] body 上没有辉光渐变（皮肤预设没生效）：' + String(glowCss).slice(0, 60));
                process.exitCode = 1;
              } else {
                console.log('[smoke] 辉光渐变在 body 上 ✓');
              }

              const capture = async (name: string) => {
                const img = await mainWin!.webContents.capturePage();
                fs.writeFileSync(path.join(shotDir, name + '.png'), img.toPNG());
                return img;
              };
              const themeNow = async (): Promise<boolean> =>
                Boolean(
                  await mainWin!.webContents.executeJavaScript(
                    "!!(document.body.hasAttribute('data-ds-dark-theme') || document.documentElement.hasAttribute('data-ds-dark-theme'))",
                  ),
                );

              const isDarkNow = await themeNow();
              const firstImg = await capture(isDarkNow ? 'dark' : 'light');
              // 切到另一主题
              await mainWin!.webContents.executeJavaScript(
                isDarkNow
                  ? "document.body.removeAttribute('data-ds-dark-theme');document.documentElement.removeAttribute('data-ds-dark-theme');true"
                  : "document.body.setAttribute('data-ds-dark-theme','');document.documentElement.setAttribute('data-ds-dark-theme','');true",
              );
              await new Promise((r) => setTimeout(r, 900));
              const isDarkNow2 = await themeNow();
              const secondImg = await capture(isDarkNow2 ? 'dark' : 'light');
              // 还原
              await mainWin!.webContents.executeJavaScript(
                isDarkNow
                  ? "document.body.setAttribute('data-ds-dark-theme','');document.documentElement.setAttribute('data-ds-dark-theme','');true"
                  : "document.body.removeAttribute('data-ds-dark-theme');document.documentElement.removeAttribute('data-ds-dark-theme');true",
              );

              const probe = (img: Electron.NativeImage, label: string, wantDark: boolean) => {
                const bmp = img.getBitmap() as unknown as Buffer;
                const { width, height } = img.getSize();
                const at = (x: number, y: number) => {
                  const i = (y * width + x) * 4;
                  return { b: bmp[i], g: bmp[i + 1], r: bmp[i + 2] };
                };
                const corner = at(3, 3);                 // 最外圈：背景/辉光
                const center = at(Math.round(width / 2), Math.round(height / 2));
                const sum = (c: { r: number; g: number; b: number }) => c.r + c.g + c.b;
                // ① 背景（外圈）必须和画面中心**不一样** —— 说明面板没有盖满、辉光/背景透出来了
                const differs = Math.abs(sum(corner) - sum(center)) >= 12;
                // ② 主题方向：深色主题整体偏暗、浅色偏亮
                const avg = Math.round((sum(corner) + sum(center)) / 2 / 3);
                const themeOk = wantDark ? avg <= 140 : avg >= 150;
                if (!differs) {
                  console.error(
                    '[smoke] ' + label + '主题：外圈与中心几乎同色（辉光/背景没透出来）corner=' +
                      JSON.stringify(corner) + ' center=' + JSON.stringify(center),
                  );
                  process.exitCode = 1;
                } else if (!themeOk) {
                  console.error(
                    '[smoke] ' + label + '主题：整体亮度异常（均值 ' + String(avg) + '）→ 可能洗白/发黑',
                  );
                  process.exitCode = 1;
                } else {
                  console.log(
                    '[smoke] ' + label + '主题像素验证 ✓（外圈 ' + JSON.stringify(corner) +
                      ' vs 中心 ' + JSON.stringify(center) + '，均值 ' + String(avg) + '）',
                  );
                }
              };
              probe(firstImg, isDarkNow ? '深色' : '浅色', isDarkNow);
              probe(secondImg, isDarkNow2 ? '深色' : '浅色', isDarkNow2);
              console.log('[smoke] 皮肤双主题截图：' + shotDir + '/dark.png + light.png');
            } catch (e) {
              console.warn('[smoke] 皮肤截图/验证失败:', e);
            }

            // —— 皮肤/背景层栈诊断（临时）：查清"整片发白"是哪一层造成的 ——
            try {
              const stack = await mainWin!.webContents.executeJavaScript(`(() => {
                const out = [];
                const pick = (el) => {
                  if (!el) return null;
                  const cs = getComputedStyle(el);
                  return {
                    cls: String(el.className || el.tagName).slice(0, 60),
                    bg: cs.backgroundColor,
                    bgi: (cs.backgroundImage || '').slice(0, 40),
                  };
                };
                out.push({ what: 'html', ...pick(document.documentElement) });
                out.push({ what: 'body', ...pick(document.body) });
                const frame = document.querySelector('[class*="frame"]');
                out.push({ what: 'frame', ...pick(frame) });
                const center = document.querySelector('[class*="centerCol"]');
                out.push({ what: 'centerCol', ...pick(center) });
                const sidebar = document.querySelector('[class*="sidebarCol"]');
                out.push({ what: 'sidebarCol', ...pick(sidebar) });
                const token = getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-base').trim();
                const tokens = {
                  base: token,
                  l1: getComputedStyle(document.body).getPropertyValue('--dsw-alias-bg-layer-1').trim(),
                };
                return JSON.stringify({ tokens, out });
              })()`);
              console.log('[smoke] skin-stack: ' + stack);
            } catch (e) {
              console.warn('[smoke] 皮肤层栈诊断失败:', e);
            }

            // —— 回归：旧缓存里没有当前版本时，必须强制回源（用户 1.0.49 实测踩到）——
            try {
              const stalePath = path.join(app.getPath('userData'), 'whatsnew-cache.json');
              // 先写一份"只有 1.0.0"的假缓存，模拟升级前抓到的旧快照
              fs.writeFileSync(
                stalePath,
                JSON.stringify({ versions: { '1.0.0': { title: '旧快照', items: [{ kind: 'fix', text: 'x' }] } } }),
                'utf-8',
              );
              const { notesFor } = await import('./whatsnew');
              const got = await notesFor(String(app.getVersion()).replace(/^v/, ''));
              if (!got || !got.items || got.items.length === 0) {
                console.error('[smoke] 旧缓存里没有当前版本时没能回源（用户会看到"本版暂无更新说明"）');
                process.exitCode = 1;
              } else {
                console.log('[smoke] 旧缓存缺当前版本 → 已强制回源，拿到 ' + String(got.items.length) + ' 条说明 ✓');
              }
            } catch (e) {
              console.error('[smoke] 回源回归检查失败:', e);
              process.exitCode = 1;
            }

            // —— 更新弹窗（用户要求"精心设计一个"）——
            //    冒烟里没有真实下载，所以直接调 showWhatsNewWindow 打开它，验内容 + 出一张图。
            try {
              const { showWhatsNewWindow } = await import('./update-popup');
              void showWhatsNewWindow(String(app.getVersion() || '').replace(/^v/, ''));
              await new Promise((r) => setTimeout(r, 2200));
              const wins = BrowserWindow.getAllWindows().filter((w) => w.getTitle().indexOf('深鲸桌面') >= 0);
              const pw = wins[0];
              if (!pw) {
                console.error('[smoke] 更新弹窗没能创建');
                process.exitCode = 1;
              } else {
                const probe = await pw.webContents.executeJavaScript(`(() => {
                  const items = document.querySelectorAll('#items li').length;
                  const tag = document.getElementById('notes-tag');
                  const title = document.getElementById('title');
                  const glow = getComputedStyle(document.querySelector('.glow-a')).backgroundImage;
                  return JSON.stringify({
                    items,
                    tag: tag ? tag.textContent : '',
                    title: title ? title.textContent : '',
                    hasGlow: /radial-gradient/.test(glow),
                  });
                })()`);
                const pp = JSON.parse(probe) as { items: number; tag: string; title: string; hasGlow: boolean };
                if (pp.items < 1 || !pp.hasGlow) {
                  console.error('[smoke] 更新弹窗内容不完整：' + probe);
                  process.exitCode = 1;
                } else {
                  console.log('[smoke] 更新弹窗：' + pp.title + ' ' + pp.tag + '，更新条目 ' + String(pp.items) + ' 条，辉光已生效');
                }
                // —— 1.0.54 已实现项：① 弹窗可移动（自实现拖拽的 IPC 通路）② 关闭提醒 ——
                try {
                  // ① 拖拽：让弹窗页调用 moveWindow，断言窗口真的动了 + 出图
                  const before = pw.getPosition();
                  await pw.webContents.executeJavaScript(
                    "window.dshPopup && window.dshPopup.moveWindow(160, 120); true",
                  );
                  await new Promise((r) => setTimeout(r, 600));
                  const after = pw.getPosition();
                  const moved = Math.abs(after[0] - before[0]) > 20 || Math.abs(after[1] - before[1]) > 20;
                  if (!moved) {
                    console.error(
                      '[smoke] 弹窗拖拽通路无效：before=' + JSON.stringify(before) + ' after=' + JSON.stringify(after),
                    );
                    process.exitCode = 1;
                  } else {
                    console.log(
                      '[smoke] 弹窗可移动 ✓（' + JSON.stringify(before) + ' → ' + JSON.stringify(after) + '）',
                    );
                    const shot = await pw.webContents.capturePage();
                    fs.mkdirSync('/tmp/dsh-154', { recursive: true });
                    fs.writeFileSync('/tmp/dsh-154/1-弹窗已移动到(160,120).png', shot.toPNG());
                  }
                  // ② 关闭提醒：把面板摆成"下载中"，点关闭 → 应出现「后台继续」提示
                  const tipCycle = await pw.webContents.executeJavaScript(`(async () => {
                    const wrap = document.getElementById('progress-wrap');
                    if (wrap) wrap.hidden = false;               // 伪装成下载中
                    document.getElementById('btn-close').click();
                    await new Promise((r) => setTimeout(r, 250));
                    const tip = document.getElementById('close-tip');
                    return JSON.stringify({ tipShown: !!tip, text: tip ? tip.textContent : '' });
                  })()`);
                  const tc = JSON.parse(tipCycle) as { tipShown: boolean; text?: string };
                  if (!tc.tipShown) {
                    console.error('[smoke] 下载中关闭弹窗没有出现「后台继续」提醒');
                    process.exitCode = 1;
                  } else {
                    console.log('[smoke] 关闭提醒 ✓：' + String(tc.text));
                  }
                } catch (e) {
                  console.warn('[smoke] 弹窗拖拽/关闭提醒检查异常:', e);
                }

                try {
                  const img = await pw.webContents.capturePage();
                  fs.mkdirSync('/tmp/dsh-update-popup', { recursive: true });
                  fs.writeFileSync('/tmp/dsh-update-popup/popup.png', img.toPNG());
                  console.log('[smoke] 更新弹窗截图：/tmp/dsh-update-popup/popup.png');
                } catch (e2) {
                  console.warn('[smoke] 弹窗截图失败:', e2);
                }
                pw.hide();
              }
            } catch (e) {
              console.error('[smoke] 更新弹窗检查失败:', e);
              process.exitCode = 1;
            }

            // —— 「开始」面板第三张卡片：造同结构假面板，验证注入逻辑 ——
            //    真面板只在空白会话时出现，冒烟里出不来；这里验证"定位 + 并列插在第二张卡之后
            //    + 常驻补插（面板晚出现也能补上）"这三件事。
            try {
              await mainWin!.webContents.executeJavaScript(`(() => {
                if (document.getElementById('smoke-fake-hero')) return true;
                const box = document.createElement('div');
                box.id = 'smoke-fake-hero';
                box.style.cssText = 'position:fixed;left:-9999px;top:0;width:620px;';
                box.innerHTML =
                  '<div style="width:560px">' +
                  '<div role="button" style="width:560px;height:96px"><span>工作区文件</span><span>浏览会话工作区的文件</span></div>' +
                  '<div role="button" style="width:560px;height:96px"><span>新建终端</span><span>在会话工作区运行命令</span></div>' +
                  '</div>';
                document.body.appendChild(box);
                return true;
              })()`);
              await new Promise((r) => setTimeout(r, 2800));
              const hero = await mainWin!.webContents.executeJavaScript(`(() => {
                const box = document.getElementById('smoke-fake-hero');
                const card = document.getElementById('dsh-local-files-card');
                if (!box) return JSON.stringify({ card: !!card, insideFake: false, order: -1, total: 0 });
                const kids = Array.from(box.querySelectorAll('[role="button"], #dsh-local-files-card'));
                return JSON.stringify({
                  card: !!card,
                  insideFake: !!card && box.contains(card),
                  order: card ? kids.indexOf(card) : -1,
                  total: kids.length,
                  text: card ? (card.textContent || '').slice(0, 12) : '',
                });
              })()`);
              const h = JSON.parse(hero) as { card: boolean; insideFake: boolean; order: number; total: number; text?: string };
              if (!h.card) {
                console.error('[smoke] 「开始」面板的第三张卡片没能注入（面板晚出现也没补上）');
                process.exitCode = 1;
              } else if (!h.insideFake || h.order !== 2) {
                console.error('[smoke] 卡片没并列在第二张卡之后（order=' + String(h.order) + '/' + String(h.total) + '）');
                process.exitCode = 1;
              } else {
                console.log('[smoke] 本机内文件卡片：与两张自带卡并列，插在第三位 ✓（' + String(h.text) + '…）');
                // 顺着这张卡点开面板：验形态（SVG 图标、无「显示」按钮、行数）+ 出一张图给用户看
                const pc = JSON.parse(
                  await mainWin!.webContents.executeJavaScript(`(async () => {
                    const card = document.getElementById('dsh-local-files-card');
                    if (!card) return JSON.stringify({ ok: false });
                    card.click();
                    await new Promise((r) => setTimeout(r, 1000));
                    const panel = document.getElementById('dsh-local-files-panel');
                    const input = document.getElementById('dsh-local-files-panel-path');
                    return JSON.stringify({
                      ok: !!panel && panel.style.display !== 'none',
                      hasInput: !!input,
                      path: input ? input.value : '',
                      rows: document.querySelectorAll('#dsh-local-files-panel-list > div').length,
                      svgs: document.querySelectorAll('#dsh-local-files-panel-list svg').length,
                      buttons: document.querySelectorAll('#dsh-local-files-panel-list button').length,
                    });
                  })()`),
                ) as { ok: boolean; hasInput?: boolean; path?: string; rows?: number; svgs?: number; buttons?: number };
                if (!pc.ok || !pc.hasInput || (pc.rows ?? 0) < 1) {
                  console.error('[smoke] 点卡片没打开本机内文件面板：' + JSON.stringify(pc));
                  process.exitCode = 1;
                } else if ((pc.buttons ?? 0) !== 0) {
                  console.error('[smoke] 面板行里还有按钮（应已去掉「显示」）：' + String(pc.buttons));
                  process.exitCode = 1;
                } else {
                  console.log(
                    '[smoke] 本机内文件面板 ✓ 行 ' + String(pc.rows) + ' · SVG 图标 ' + String(pc.svgs) +
                      ' · 行内按钮 ' + String(pc.buttons) + '（已按官方去掉「显示」）· 路径=' + String(pc.path),
                  );
                  try {
                    const shot = await mainWin!.webContents.capturePage();
                    fs.mkdirSync('/tmp/dsh-localfiles', { recursive: true });
                    fs.writeFileSync('/tmp/dsh-localfiles/panel.png', shot.toPNG());
                    console.log('[smoke] 面板截图：/tmp/dsh-localfiles/panel.png');
                  } catch (e4) {
                    console.warn('[smoke] 面板截图失败:', e4);
                  }
                }
              }
            } catch (e) {
              console.error('[smoke] 卡片注入检查失败:', e);
              process.exitCode = 1;
            }

            // —— 本机内文件面板：独立校验（不依赖"开始"面板是否渲染）+ 出图 ——
            //    用户 2026-10-04 反馈过这个面板"白底浅灰字看不见"，所以要留图 + 断言行数与图标
            try {
              const panelChk = await mainWin!.webContents.executeJavaScript(`(async () => {
                let card = document.getElementById('dsh-local-files-card');
                if (!card) return JSON.stringify({ ok: false, why: 'no-card' });
                card.click();
                await new Promise((r) => setTimeout(r, 900));
                const panel = document.getElementById('dsh-local-files-panel');
                const input = document.getElementById('dsh-local-files-panel-path');
                const rows = document.querySelectorAll('#dsh-local-files-panel-list > div').length;
                const firstRowText = (document.querySelector('#dsh-local-files-panel-list > div') || {}).textContent || '';
                const revealBtns = Array.from(document.querySelectorAll('#dsh-local-files-panel-list button')).length;
                const svgs = document.querySelectorAll('#dsh-local-files-panel-list svg').length;
                return JSON.stringify({
                  ok: !!panel && panel.style.display !== 'none',
                  hasInput: !!input,
                  path: input ? input.value : '',
                  rows, firstRowText: firstRowText.slice(0, 20), svgs, revealBtns,
                });
              })()`);
              const pc = JSON.parse(panelChk) as {
                ok: boolean; hasInput?: boolean; path?: string; rows?: number;
                firstRowText?: string; svgs?: number; revealBtns?: number; why?: string;
              };
              if (!pc.ok || !pc.hasInput || (pc.rows ?? 0) < 1) {
                console.error('[smoke] 本机内文件面板不可用：' + panelChk);
                process.exitCode = 1;
              } else if ((pc.svgs ?? 0) < 1 || (pc.revealBtns ?? 0) !== 0) {
                console.error(
                  '[smoke] 面板行样式不符（应 SVG 图标、无「显示」按钮）：svg=' + String(pc.svgs) +
                    ' 按钮=' + String(pc.revealBtns),
                );
                process.exitCode = 1;
              } else {
                console.log(
                  '[smoke] 本机内文件面板 ✓ ' + String(pc.rows) + ' 项 · SVG 图标 ' + String(pc.svgs) +
                    ' 个 · 无「显示」按钮 · 路径=' + String(pc.path),
                );
                try {
                  const shot = await mainWin!.webContents.capturePage();
                  fs.mkdirSync('/tmp/dsh-localfiles', { recursive: true });
                  fs.writeFileSync('/tmp/dsh-localfiles/panel.png', shot.toPNG());
                  console.log('[smoke] 本机内文件面板截图：/tmp/dsh-localfiles/panel.png');
                } catch (e3) {
                  console.warn('[smoke] 面板截图失败:', e3);
                }
              }
            } catch (e) {
              console.warn('[smoke] 本机内文件面板检查异常:', e);
            }

            // —— 安装器冻结项：打包态也校验一次（Windows 用户安装被破坏那次事故）——
            try {
              const conf = fs.readFileSync(path.join(app.getAppPath(), 'electron-builder.yml'), 'utf-8');
              const must = [
                ['oneClick: true', '一键安装器'],
                ['allowToChangeInstallationDirectory: false', '固定安装目录'],
                ['deleteAppDataOnUninstall: false', '卸载不删用户数据'],
                ['appId: com.deepwhale.desktop', 'appId 冻结'],
              ] as Array<[string, string]>;
              const missing = must.filter(([k]) => conf.indexOf(k) < 0).map(([, n]) => n);
              if (missing.length) {
                console.error('[smoke] 安装器冻结项被改动：' + missing.join('、'));
                process.exitCode = 1;
              } else {
                console.log('[smoke] 安装器冻结项齐备（一键安装 / 固定目录 / 不删数据 / appId 未变）✓');
              }
            } catch (e) {
              console.warn('[smoke] 安装器冻结项检查跳过（开发态无该文件）:', e);
            }

            // —— 关于面板权属：版权必须是公司，不许再出现个人账号 ——
            try {
              const pkg = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf-8')) as {
                author?: string;
              };
              const author = String(pkg.author || '');
              const bad = ['feely0208', 'gmail.com'];
              const hit = bad.filter((b) => author.includes(b));
              if (hit.length) {
                console.error('[smoke] 关于面板权属不对：package.json 的 author 仍含个人账号 ' + hit.join('、'));
                process.exitCode = 1;
              } else if (!author.includes('深鲸')) {
                console.error('[smoke] package.json 的 author 不是公司名：' + author);
                process.exitCode = 1;
              } else {
                console.log('[smoke] 关于面板权属 ✓ 公司：' + author);
              }
            } catch (e) {
              console.warn('[smoke] 关于面板权属检查跳过:', e);
            }

            // —— Office 预览链路（2026-10-04 修复）：硬判"物化产物 + 引擎执行位"，
            //    软判"真实转换"（需要 python-docx，环境没有就跳过）。
            //    背景：打包版一直报 "Installed LibreOfficeKit executable is not executable"
            //    （asar 里的引擎没有执行位）→ 修法是把转换栈物化到真实目录，见 office-runtime.ts。
            try {
              const { spawnSync } = await import('child_process');
              const home = path.join(app.getPath('userData'), 'dsh-home');
              const nodeBin = path.join(home, 'office-runtime', 'bin', 'node');
              const kitDir = path.join(home, 'office-runtime', 'kit', 'node_modules', '@deepseek-ai');
              const cli = path.join(kitDir, 'libreoffice-kit', 'lib', 'cli.js');
              let engines: string[] = [];
              try {
                engines = fs.readdirSync(kitDir).filter((n) => n.startsWith('libreoffice-kit-'));
              } catch {
                engines = [];
              }
              // 硬判 ①：cli 与引擎包都在
              if (!fs.existsSync(nodeBin) || !fs.existsSync(cli) || engines.length === 0) {
                console.error(
                  '[smoke] Office 物化产物缺失（node=' + String(fs.existsSync(nodeBin)) +
                    ' cli=' + String(fs.existsSync(cli)) + ' engines=' + String(engines.length) + '）',
                );
                process.exitCode = 1;
              } else {
                // 硬判 ②：引擎二进制必须有执行位（这正是打包版坏掉的那一点）
                let execFound = false;
                for (const e of engines) {
                  const dir = path.join(kitDir, e);
                  const walk = (d: string, depth: number): void => {
                    if (execFound || depth > 4) return;
                    let ents: fs.Dirent[] = [];
                    try {
                      ents = fs.readdirSync(d, { withFileTypes: true });
                    } catch {
                      return;
                    }
                    for (const it of ents) {
                      const full = path.join(d, it.name);
                      if (it.isSymbolicLink() || it.isDirectory()) walk(full, depth + 1);
                      else if (it.name.indexOf('libreoffice-kit') >= 0) {
                        try {
                          fs.accessSync(full, fs.constants.X_OK);
                          execFound = true;
                        } catch {
                          /* 没有执行位 */
                        }
                      }
                    }
                  };
                  walk(dir, 0);
                }
                if (!execFound) {
                  console.error('[smoke] Office 引擎没有可执行文件（打包版预览 docx 会失败）');
                  process.exitCode = 1;
                } else {
                  console.log('[smoke] Office 链路：物化产物齐备，引擎带执行位 ✓');
                }
                // 软判：真实 docx→pdf（需要 python-docx）
                try {
                  const tmp = path.join(app.getPath('temp'), 'dsh-office-smoke');
                  fs.mkdirSync(tmp, { recursive: true });
                  const docx = path.join(tmp, 't.docx');
                  const pdf = path.join(tmp, 't.pdf');
                  try {
                    fs.rmSync(pdf, { force: true });
                  } catch {
                    /* 忽略 */
                  }
                  const mk = spawnSync('python3', ['-c', `from docx import Document;d=Document();d.add_paragraph('深鲸桌面 Office 冒烟');d.save(r'${docx}')`], { encoding: 'utf-8', timeout: 30000 });
                  if (mk.status !== 0) {
                    console.log('[smoke] 跳过真实转换（本机没有 python-docx）');
                  } else {
                    const r = spawnSync(nodeBin, [cli, 'convert', '--input', docx, '--output', pdf], {
                      encoding: 'utf-8',
                      timeout: 90000,
                    });
                    const out = String(r.stdout || '').trim();
                    if (out.indexOf('"backend"') >= 0 && fs.existsSync(pdf)) {
                      console.log('[smoke] Office 真实转换通过：docx → pdf（' + String(fs.statSync(pdf).size) + 'B）');
                    } else {
                      console.error('[smoke] Office 真实转换失败：' + (out || String(r.stderr || '').slice(0, 200)));
                      process.exitCode = 1;
                    }
                  }
                } catch (e2) {
                  console.warn('[smoke] Office 真实转换检查异常:', e2);
                }
              }
            } catch (e) {
              console.warn('[smoke] Office 链路检查异常（不影响其它断言）:', e);
            }

            // —— ⌘⇧O：任何会话都能开「本机内文件」（用户明确要求，不能只靠开始面板）——
            try {
              await mainWin!.webContents.executeJavaScript(
                "document.getElementById('dsh-local-files-panel') && (document.getElementById('dsh-local-files-panel').style.display='none'); true",
              );
              // 默认已改为 ⌥⌘O（用户实测 ⌘⇧O 与系统冲突）→ 这里按新默认发按键
              const hotMods: Array<'meta' | 'alt' | 'control'> =
                process.platform === 'darwin' ? ['meta', 'alt'] : ['control', 'alt'];
              mainWin!.webContents.sendInputEvent({
                type: 'keyDown',
                keyCode: 'O',
                modifiers: hotMods,
              });
              mainWin!.webContents.sendInputEvent({
                type: 'keyUp',
                keyCode: 'O',
                modifiers: hotMods,
              });
              await new Promise((r) => setTimeout(r, 700));
              const hot = await mainWin!.webContents.executeJavaScript(`(() => {
                const panel = document.getElementById('dsh-local-files-panel');
                return JSON.stringify({ open: !!panel && panel.style.display !== 'none' });
              })()`);
              const hj = JSON.parse(hot) as { open: boolean };
              if (!hj.open) {
                console.error('[smoke] ⌘⇧O 没能打开「本机内文件」面板');
                process.exitCode = 1;
              } else {
                console.log('[smoke] ⌥⌘O（可配置，默认值）可在任意会话打开「本机内文件」✓');
              }
            } catch (e) {
              console.warn('[smoke] 快捷键检查异常:', e);
            }

            // —— 品牌标记：空白会话顶部**保留 DSH 官方原生标记**（2026-10-08 用户决定）——
            //
            // 用户原话：「不要换新会话的大肥鱼头像，还是用官方原生的」。
            // 所以本断言**跟着决定反过来**：`dsh-shell-brand-mark` **不该**被加载；
            // 一旦它又进了 boot 列表，说明有人把插件加回了随包清单，这里必须报红。
            //
            // ⚠️ 别和 `sidebar.brand.mark`（侧栏左上那个 deepseek 鲸标）搞混 ——
            //    那个任何时候都不许碰，从来没被占过。
            try {
              const mark = await mainWin!.webContents.executeJavaScript(`(async () => {
                const el = document.querySelector('[data-dsh-brand-mark]');
                let loaded = false;
                try {
                  const r = await fetch('/', { credentials: 'same-origin' });
                  const html = await r.text();
                  loaded = html.indexOf('dsh-shell-brand-mark') >= 0;
                } catch (e) { loaded = false; }
                return JSON.stringify({ present: !!el, loaded: loaded });
              })()`);
              const mk = JSON.parse(mark) as { present: boolean; loaded: boolean };
              if (mk.loaded || mk.present) {
                console.error(
                  '[smoke] ❌ 空白会话的品牌标记被替换了（dsh-shell-brand-mark 出现在 boot 列表里，' +
                    'present=' + String(mk.present) + '）—— 用户要求保留官方原生标记',
                );
                process.exitCode = 1;
              } else {
                console.log('[smoke] ✅ 空白会话品牌标记保持官方原生（没被我们的插件替换）');
              }
            } catch (e) {
              console.warn('[smoke] 品牌标记检查异常:', e);
            }

            // —— 托盘/应用菜单里的「预览更新进度条」（用户要"随时能看到进度条长什么样"）——
            try {
              const appMenu = Menu.getApplicationMenu();
              const labels: string[] = [];
              const walk = (items: Electron.MenuItem[]): void => {
                for (const it of items) {
                  labels.push(it.label || '');
                  if (it.submenu) walk(it.submenu.items);
                }
              };
              // ⚠️ 这一行原来**漏了**（2026-10-08 修）：`walk` 只被定义、从来没被调用，
              //    于是 `labels` 永远是空数组 —— 下面两条菜单断言**只要跑到就必然失败**
              //    （报"开发菜单里缺…""菜单里没有「本机内文件…」"），而实际菜单是好的。
              //    之所以一直没暴露：整条检查链被 15 秒写死的计时器截断，这段根本没执行过
              //    （见本文件 SMOKE 段开头关于 `smokeChecksDone` 的说明）。
              if (appMenu) walk(appMenu.items);

              // 诊断：断言失败时光说"缺"没法定位 —— 把实际扫到的 label 打出来，
              // 一眼就能分清"菜单没建起来"和"模板里那一项没进去"。
              const hasPreview = labels.some((l) => l.indexOf('预览更新进度条') >= 0);
              const hasLocalFiles = labels.some((l) => l.indexOf('本机内文件') >= 0);
              if (!hasPreview || !hasLocalFiles) {
                console.log(
                  '[smoke] 菜单实际扫到 ' + String(labels.length) + ' 项：' +
                    JSON.stringify(labels.filter((l) => l !== '').slice(0, 45)),
                );
              }
              // 预览进度条是开发/测试用的，用户菜单里不应该出现（用户实测反馈）
              const devMenu = !app.isPackaged || process.env.DSH_DEV_MENU === '1';
              if (devMenu && !hasPreview) {
                console.error('[smoke] 开发菜单里缺「预览更新进度条」');
                process.exitCode = 1;
              } else if (!devMenu && hasPreview) {
                console.error('[smoke] 用户菜单里出现了测试项「预览更新进度条」（应只在开发菜单）');
                process.exitCode = 1;
              } else {
                console.log('[smoke] 「预览更新进度条」仅在开发菜单 ✓（用户菜单里没有）');
              }
              if (!labels.some((l) => l.indexOf('本机内文件') >= 0)) {
                console.error('[smoke] 菜单里没有「本机内文件…」入口（非空白会话下用户找不到入口）');
                process.exitCode = 1;
              } else {
                console.log('[smoke] 菜单里有「本机内文件…」入口');
              }
            } catch (e) {
              console.warn('[smoke] 菜单检查异常（不影响其它断言）:', e);
            }

            // —— 本机内文件（设置页入口，永远可达）+ 设置页「本版更新内容」卡片 ——
            try {
              const lf2 = await mainWin!.webContents.executeJavaScript(`(async () => {
                const entry = document.getElementById('dsh-ext-localfiles');
                const wnew = document.getElementById('dsh-ext-whatsnew');
                const wnItems = wnew ? wnew.querySelectorAll('div > span:last-child').length : 0;
                if (!entry) return JSON.stringify({ entry: false, wnew: !!wnew });
                const btn = entry.querySelector('button');
                if (btn) btn.click();
                await new Promise((r) => setTimeout(r, 800));
                const panel = document.getElementById('dsh-local-files-panel');
                const rows = document.querySelectorAll('#dsh-local-files-panel-list > div').length;
                const crumbs = document.getElementById('dsh-local-files-panel-crumbs');
                return JSON.stringify({
                  entry: true,
                  panelOpen: !!panel && panel.style.display !== 'none',
                  rows: rows,
                  dir: crumbs ? crumbs.textContent : '',
                  wnew: !!wnew,
                  wnItems: Date.now() ? wnItems : 0,
                });
              })()`);
              const l2 = JSON.parse(lf2) as {
                entry: boolean; panelOpen?: boolean; rows?: number; dir?: string; wnew?: boolean; wnItems?: number;
              };
              if (l2.entry) {
                console.error('[smoke] 设置页又出现了「本机内文件」入口（用户要求撤销）');
                process.exitCode = 1;
              } else {
                console.log('[smoke] 设置页已无「本机内文件」入口（按用户要求撤销）✓');
              }
              // 面板功能改由「开始」面板那张卡片点开验证（见上面的假面板用例）
              // 面板形态按用户要求改成了"只给路径"（官方选目录那种），断言随之调整
              const openFromCard = await mainWin!.webContents.executeJavaScript(`(async () => {
                const card = document.getElementById('dsh-local-files-card');
                if (!card) return JSON.stringify({ ok: false, why: 'no-card' });
                card.click();
                await new Promise((r) => setTimeout(r, 500));
                const panel = document.getElementById('dsh-local-files-panel');
                const input = document.getElementById('dsh-local-files-panel-path');
                const rows = document.querySelectorAll('#dsh-local-files-panel-list > div').length;
                return JSON.stringify({
                  ok: !!panel && panel.style.display !== 'none',
                  hasInput: !!input,
                  path: input ? input.value : '',
                  rows: rows,
                });
              })()`);
              const oc = JSON.parse(openFromCard) as {
                ok: boolean; hasInput?: boolean; path?: string; rows?: number; why?: string;
              };
              // 面板形状对齐官方「工作区文件」：页签 + 路径条 + 条目列表
              if (!oc.ok || !oc.hasInput || (oc.rows ?? 0) < 1) {
                console.error('[smoke] 本机内文件面板不完整（要路径条 + 文件列表）：' + openFromCard);
                process.exitCode = 1;
              } else {
                console.log(
                  '[smoke] 本机内文件面板：路径=' + String(oc.path) + '，列出 ' + String(oc.rows) + ' 项（对齐官方文件面板形状）',
                );
                try {
                  const shot = await mainWin!.webContents.capturePage();
                  fs.mkdirSync('/tmp/dsh-localfiles', { recursive: true });
                  fs.writeFileSync('/tmp/dsh-localfiles/panel.png', shot.toPNG());
                  console.log('[smoke] 本机内文件面板截图：/tmp/dsh-localfiles/panel.png');
                } catch (e3) {
                  console.warn('[smoke] 面板截图失败:', e3);
                }
              }
            } catch (e) {
              console.error('[smoke] 本机内文件/更新内容检查失败:', e);
              process.exitCode = 1;
            }

            // —— 网页预览开关的红线断言（2026-10-04）——
            //    我们要的是官方右栏浏览器（sidebar-browser）启用；但**绝不能**连带打开
            //    官方遥测（product-telemetry）与产品埋点（product-analytics）——
            //    三者在同一条 `profileContext.name === 'desktop'` 条件下，所以只能用
            //    自有 patch 单独覆盖 browser 那一条（见 bundled-plugins/dsh-shell-web-preview）。
            try {
              const plug = await mainWin!.webContents.executeJavaScript(`(async () => {
                try {
                  const r = await fetch('/', { credentials: 'same-origin' });
                  const html = await r.text();
                  return JSON.stringify({
                    hasBrowser: html.indexOf('dsh-client-ui-sidebar-browser') >= 0,
                    hasTelemetry: html.indexOf('product-telemetry') >= 0,
                    hasAnalytics: html.indexOf('product-analytics') >= 0,
                  });
                } catch (e) { return JSON.stringify({ err: String(e) }); }
              })()`);
              const pj = JSON.parse(plug) as { hasBrowser?: boolean; hasTelemetry?: boolean; hasAnalytics?: boolean; err?: string };
              if (pj.err) {
                console.warn('[smoke] 插件清单探测失败（不影响其它断言）:', pj.err);
              } else {
                if (!pj.hasBrowser) {
                  console.error('[smoke] 官方网页预览（sidebar-browser）没被启用 —— 右栏开不了网页');
                  process.exitCode = 1;
                } else {
                  console.log('[smoke] 官方网页预览已启用（sidebar-browser 在 boot 列表里）');
                }
                if (pj.hasTelemetry || pj.hasAnalytics) {
                  console.error(
                    '[smoke] 危险：官方遥测/埋点被连带打开了（telemetry=' + String(pj.hasTelemetry) +
                      ' analytics=' + String(pj.hasAnalytics) + '）—— 法律行业产品不允许',
                  );
                  process.exitCode = 1;
                } else {
                  console.log('[smoke] 遥测/埋点仍关闭（红线守住了）');
                }
              }
            } catch (e) {
              console.warn('[smoke] 插件清单检查异常（不影响其它断言）:', e);
            }

            mainWin!.webContents.send('shell:update-state', { phase: 'downloading', percent: 42, message: '正在下载 42%' });
            await new Promise((r) => setTimeout(r, 500));
            const probe2 = await mainWin!.webContents.executeJavaScript(`(() => {
              const s = document.getElementById('dsh-ext-dl');
              const f = document.getElementById('dsh-ext-dl-fill');
              const t = document.getElementById('dsh-ext-dl-text');
              const r = s ? s.getBoundingClientRect() : null;
              const row = document.getElementById('dsh-ext-update-progress');
              const rowLabel = document.getElementById('dsh-ext-update-progress-label');
              const rowR = row ? row.getBoundingClientRect() : null;
              // 2026-10-03（1.0.47）：用户要求进度条"铺满到便捷框"且"加粗"，
              // 这里把条与所在行的几何一起带出来，便于断言"真的铺满了"。
              const host = s ? s.parentElement : null;
              const sibs = host
                ? Array.from(host.children).map((c) => {
                    const rr = c.getBoundingClientRect();
                    return (c.id || c.className || c.tagName) + '@' + Math.round(rr.x) + ',' + Math.round(rr.width);
                  })
                : [];
              const trackEl = s ? s.querySelector('span') : null;
              const trackR = trackEl ? trackEl.getBoundingClientRect() : null;
              const hostRow = s && s.parentElement ? s.parentElement.getBoundingClientRect() : null;
              return JSON.stringify({
                count: document.querySelectorAll('#dsh-ext-dl').length,
                trackW: trackR ? Math.round(trackR.width) : -1,
                trackH: trackR ? Math.round(trackR.height) : -1,
                gapRight: hostRow && trackR ? Math.round(hostRow.right - trackR.right) : -1,
                hostW: hostRow ? Math.round(hostRow.width) : -1,
                sibs: sibs,
                display: s ? s.style.display : 'missing',
                fillWidth: f ? f.style.width : 'missing',
                text: t ? t.textContent : 'missing',   // 条上已不放文字（用户 2026-10-04 要求）
                rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null,
                vw: innerWidth,
                vh: innerHeight,
                settingsRowVisible: !!(rowR && rowR.width > 0 && rowR.height > 0),
                settingsRowText: rowLabel ? rowLabel.textContent : 'missing',
              });
            })()`);
            console.log('[smoke] sidebar-probe2:', probe2);
            const p2 = JSON.parse(probe2) as {
              count: number; display: string; fillWidth: string; text: string;
              rect: { x: number; y: number; w: number; h: number } | null;
              trackW: number; trackH: number; gapRight: number; hostW: number; sibs: string[];
              vw: number; vh: number; settingsRowVisible: boolean; settingsRowText: string;
            };
            // —— 动效 / 不定态 / 完成态回归（2026-10-04，用户要求"别傻傻的跑"）——
            try {
              const animProbe = await mainWin!.webContents.executeJavaScript(`(() => {
                const st = document.getElementById('dsh-ext-anim');
                const wrap = document.getElementById('dsh-ext-dl');
                const runner = document.getElementById('dsh-ext-dl-runner');
                return JSON.stringify({
                  hasAnim: !!st,
                  hasRunner: !!runner,
                  cls: wrap ? wrap.className : 'no-wrap',
                });
              })()`);
              const ap = JSON.parse(animProbe) as { hasAnim: boolean; hasRunner: boolean; cls: string };
              if (!ap.hasAnim || !ap.hasRunner) {
                console.error('[smoke] 进度条动效没注入（anim=' + String(ap.hasAnim) + ' runner=' + String(ap.hasRunner) + '）');
                process.exitCode = 1;
              } else {
                console.log('[smoke] 进度条动效已注入（流光 + 不定态游走层都在）');
              }

              // 不定态：percent=null → 应有 indet 类、游走段可见、文字是"正在下载…"
              mainWin!.webContents.send('shell:update-state', { phase: 'downloading', percent: null, message: '正在下载…' });
              await new Promise((r) => setTimeout(r, 400));
              const indetProbe = await mainWin!.webContents.executeJavaScript(`(() => {
                const wrap = document.getElementById('dsh-ext-dl');
                const runner = document.getElementById('dsh-ext-dl-runner');
                const txt = document.getElementById('dsh-ext-dl-text');
                const rs = runner ? getComputedStyle(runner) : null;
                return JSON.stringify({
                  cls: wrap ? wrap.className : 'no-wrap',
                  runnerDisplay: rs ? rs.display : 'no-runner',
                  runnerAnim: rs ? rs.animationName : '',
                  text: txt ? txt.textContent : '',
                });
              })()`);
              const ip = JSON.parse(indetProbe) as { cls: string; runnerDisplay: string; runnerAnim: string; text?: string };
              if (ip.cls.indexOf('indet') < 0 || ip.runnerDisplay === 'none' || ip.runnerAnim === 'none') {
                console.error('[smoke] 百分比未知时没走"不定态"游走：' + indetProbe);
                process.exitCode = 1;
              } else {
                console.log('[smoke] 不定态游走生效：' + ip.runnerDisplay + ' / ' + ip.runnerAnim);
              }

              // 已知百分比：宽度必须是缓动推进（transition 不是 .2s linear 那种硬走）
              mainWin!.webContents.send('shell:update-state', { phase: 'downloading', percent: 62, message: '' });
              await new Promise((r) => setTimeout(r, 300));
              const fillT = await mainWin!.webContents.executeJavaScript(
                "getComputedStyle(document.getElementById('dsh-ext-dl-fill')).transition",
              );
              if (!/cubic-bezier/.test(String(fillT))) {
                console.error('[smoke] 进度条宽度推进没有缓动（transition=' + String(fillT) + '）');
                process.exitCode = 1;
              } else {
                console.log('[smoke] 宽度推进有缓动：' + String(fillT));
              }

              // 完成态：downloaded → done 类 + 文案
              mainWin!.webContents.send('shell:update-state', { phase: 'downloaded', percent: 100, message: '' });
              await new Promise((r) => setTimeout(r, 300));
              const doneProbe = await mainWin!.webContents.executeJavaScript(`(() => {
                const wrap = document.getElementById('dsh-ext-dl');
                return JSON.stringify({ cls: wrap ? wrap.className : '' });
              })()`);
              const dp2 = JSON.parse(doneProbe) as { cls: string; text?: string };
              if (dp2.cls.indexOf('done') < 0) {
                console.error('[smoke] 下载完成后没有进入 done（闪光）态：' + doneProbe);
                process.exitCode = 1;
              } else {
                console.log('[smoke] 完成态（满条 + 闪光）生效');
              }

              // —— 抓帧，供生成"动效 GIF"（用户要肉眼验收）——
              try {
                const frameDir = '/tmp/dsh-bar-frames';
                fs.mkdirSync(frameDir, { recursive: true });
                const rect = p2.rect!;
                const clip = {
                  x: 0,
                  y: Math.max(0, rect.y - 34),
                  width: Math.min(420, p2.vw),
                  height: Math.min(96, p2.vh - Math.max(0, rect.y - 34)),
                };
                const frames: Array<[number | null, number]> = [[8, 220], [30, 220], [58, 220], [86, 220]];
                let idx = 0;
                for (const [pctv] of frames) {
                  mainWin!.webContents.send('shell:update-state', { phase: 'downloading', percent: pctv, message: '' });
                  await new Promise((r) => setTimeout(r, 260));
                  const img = await mainWin!.webContents.capturePage(clip);
                  fs.writeFileSync(`${frameDir}/frame-${idx++}.png`, img.toPNG());
                }
                // 不定态连抓 3 帧 —— GIF 里能看出"游走"
                mainWin!.webContents.send('shell:update-state', { phase: 'downloading', percent: null, message: '' });
                for (let i = 0; i < 3; i++) {
                  await new Promise((r) => setTimeout(r, 200));
                  const img = await mainWin!.webContents.capturePage(clip);
                  fs.writeFileSync(`${frameDir}/frame-${idx++}.png`, img.toPNG());
                }
                mainWin!.webContents.send('shell:update-state', { phase: 'downloaded', percent: 100, message: '' });
                await new Promise((r) => setTimeout(r, 200));
                const doneImg = await mainWin!.webContents.capturePage(clip);
                fs.writeFileSync(`${frameDir}/frame-${idx++}.png`, doneImg.toPNG());
                console.log('[smoke] 动效帧已保存：' + frameDir + '（' + String(idx) + ' 帧）');
              } catch (frameErr) {
                console.warn('[smoke] 抓帧失败（不影响断言）:', frameErr);
              }
            } catch (e) {
              console.error('[smoke] 动效检查失败:', e);
              process.exitCode = 1;
            }

            if (p2.display === 'missing') {
              console.error('[smoke] 侧栏「设置」旁的下载进度条没被注入（用户会"看不到下载中"）');
              process.exitCode = 1;
            } else if (p2.count !== 1) {
              console.error('[smoke] 侧栏下载进度条重复注入：count=' + String(p2.count));
              process.exitCode = 1;
            } else if (p2.display === 'none') {
              console.error('[smoke] 下载中（42%）时侧栏进度条仍是隐藏的');
              process.exitCode = 1;
            } else if (!p2.rect || p2.rect.w <= 0 || p2.rect.h <= 0) {
              console.error('[smoke] 侧栏进度条尺寸为 0：' + JSON.stringify(p2.rect));
              process.exitCode = 1;
            } else if (p2.trackH < 10) {
              // 用户实机验收提的："进度条要适当宽大些"（原来 8px 太细）
              console.error('[smoke] 侧栏进度条太细（' + String(p2.trackH) + 'px），用户看不见');
              process.exitCode = 1;
            } else if (p2.trackW < 120) {
              // 用户实机验收提的："要在设置后面铺满到便捷框"（原来固定 64px）
              console.error(
                '[smoke] 侧栏进度条没有铺满（宽 ' + String(p2.trackW) + 'px，应 >=120px；右侧间隙 ' + String(p2.gapRight) + 'px）',
              );
              process.exitCode = 1;
            } else if (
              p2.rect.x < 0 || p2.rect.y < 0 ||
              p2.rect.x + p2.rect.w > p2.vw || p2.rect.y + p2.rect.h > p2.vh
            ) {
              console.error('[smoke] 侧栏进度条超出窗口，用户看不见：' + JSON.stringify(p2.rect) + ' 视口 ' + String(p2.vw) + 'x' + String(p2.vh));
              process.exitCode = 1;
            } else if (!p2.settingsRowText.includes('42%')) {
              // 设置页那一行只在"设置页开着"时可见（冒烟此时停在宠物面板），
              // 所以只断言它的文字被驱动了；可见性由侧栏那条兜底。
              console.error('[smoke] 设置页版本行的进度没跟上：label=' + p2.settingsRowText);
              process.exitCode = 1;
            } else {
              // 顺手截一张侧栏区域的真图（冒烟专用）：给"新进度条长什么样"留存证据，
              // 不用等下一个版本发布才能看到。
              try {
                const pad = 40;
                const top = Math.max(0, p2.rect!.y - pad);
                // 取景涵盖整个侧栏宽度（而不是只围住条），这样能看出"到便捷框还差多少"
                const shot = await mainWin!.webContents.capturePage({
                  x: 0,
                  y: top,
                  width: Math.min(420, p2.vw),
                  height: Math.min(120, p2.vh - top),
                });
                fs.writeFileSync('/tmp/dsh-sidebar-bar.png', shot.toPNG());
                console.log('[smoke] 侧栏进度条截图已保存：/tmp/dsh-sidebar-bar.png');
              } catch (shotErr) {
                console.warn('[smoke] 截图失败（不影响断言）:', shotErr);
              }

              console.log(
                '[smoke] 侧栏下载进度条可见：' + JSON.stringify(p2.rect) +
                  ' 条=' + String(p2.trackW) + '×' + String(p2.trackH) +
                  ' 距行右缘=' + String(p2.gapRight) + 'px（条上不放文字）',
              );
            }

            // 下载结束（或中断）后必须自己消失，不留残影
            mainWin!.webContents.send('shell:update-state', { phase: 'idle', message: '' });
            await new Promise((r) => setTimeout(r, 400));
            const afterIdle = await mainWin!.webContents.executeJavaScript(
              `(() => { const s = document.getElementById('dsh-ext-dl'); return s ? s.style.display : 'missing'; })()`,
            );
            if (afterIdle !== 'none') {
              console.error('[smoke] 下载结束后侧栏进度条没隐藏：' + String(afterIdle));
              process.exitCode = 1;
            }
          } catch (e) {
            console.error('[smoke] 侧栏进度条检查失败:', e);
            process.exitCode = 1;
          }

          // ── 内置宠物「青色大肥鱼」：就位了没 + 在宠物窗口里真的画出来了没 ──────
          // 起因（2026-10-03 用户要求）：再加一条自家 logo 的青色鲸鱼宠物。
          // 断言分两段：① asar 里的内置宠物有没有被复制到用户宠物目录；
          // ② 宠物窗口的 canvas 里有没有**真的画出不透明像素**（只断言文件存在，
          //    会出现"图在、但窗口一片空白"这种最难查的故障）。
          try {
            const whaleDir = path.join(pet!.userPetsDir(), '青色大肥鱼');
            const manifestPath = path.join(whaleDir, 'manifest.json');
            const sheetPath = path.join(whaleDir, 'spritesheet.png');
            if (!fs.existsSync(manifestPath) || !fs.existsSync(sheetPath)) {
              console.error('[smoke] 内置宠物「青色大肥鱼」没复制到用户宠物目录：' + whaleDir);
              process.exitCode = 1;
            } else {
              const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
                rows?: { state?: string; frames?: number }[];
              };
              const states = (manifest.rows ?? []).map((r) => r.state ?? '');
              for (const want of ['idle', 'waving', 'jumping', 'standing', 'ball', 'running-left', 'running-right']) {
                if (!states.includes(want)) {
                  console.error('[smoke] 「青色大肥鱼」缺少动作：' + want + '（现有：' + states.join(',') + '）');
                  process.exitCode = 1;
                }
              }
              store.set('petGif', '青色大肥鱼');
              const petWin = pet!.create();
              store.set('petVisible', true);
              pet!.reload();
              await new Promise((r) => setTimeout(r, 2500));
              const drawn = await petWin.webContents.executeJavaScript(`(() => {
                const c = document.getElementById('sprite-pet');
                if (!c) return JSON.stringify({ err: 'no canvas' });
                const ctx = c.getContext('2d');
                const d = ctx.getImageData(0, 0, c.width, c.height).data;
                let opaque = 0;
                for (let i = 3; i < d.length; i += 4) if (d[i] > 24) opaque++;
                return JSON.stringify({ w: c.width, h: c.height, hidden: c.hidden, opaque });
              })()`);
              console.log('[smoke] whale-pet:', drawn);
              const dp = JSON.parse(drawn) as { w?: number; h?: number; hidden?: boolean; opaque?: number; err?: string };
              if (dp.err) {
                console.error('[smoke] 宠物窗口里没有 canvas：' + dp.err);
                process.exitCode = 1;
              } else if (dp.hidden) {
                console.error('[smoke] 宠物窗口的 canvas 还是 hidden（选择器没生效）');
                process.exitCode = 1;
              } else if ((dp.opaque ?? 0) < 2000) {
                console.error('[smoke] 「青色大肥鱼」在宠物窗口里几乎没画出东西：不透明像素=' + String(dp.opaque));
                process.exitCode = 1;
              } else {
                console.log('[smoke] 「青色大肥鱼」已就位并画出：' + String(dp.w) + '×' + String(dp.h) + ' 不透明像素 ' + String(dp.opaque));
              }

              // —— Windows 实测的"宠物冻住"回归断言（2026-10-03）——
              // ① 该窗口必须关掉后台节流：透明置顶窗口在 Windows 上容易被判成"被遮挡"，
              //    一旦节流，requestAnimationFrame 几乎不回调，宠物就停在某一帧、
              //    悬停点击全无反应（用户就是这么反馈的）。
              // ② 采样两次帧号，必须真的在往前走 —— 直接验"动没动"，而不是只看配置。
              const bgThrottling =
                typeof (petWin.webContents as unknown as { getBackgroundThrottling?: () => boolean })
                  .getBackgroundThrottling === 'function'
                  ? (petWin.webContents as unknown as { getBackgroundThrottling: () => boolean }).getBackgroundThrottling()
                  : null;
              if (bgThrottling === true) {
                console.error('[smoke] 宠物窗口仍开着后台节流（Windows 上会冻住不动）');
                process.exitCode = 1;
              } else {
                console.log('[smoke] 宠物窗口后台节流：' + String(bgThrottling));
              }
              const frameA = await petWin.webContents.executeJavaScript(
                'window.__petDebug ? window.__petDebug.info().frame : -1',
              );
              await new Promise((r) => setTimeout(r, 700));
              const frameB = await petWin.webContents.executeJavaScript(
                'window.__petDebug ? window.__petDebug.info().frame : -1',
              );
              if (frameA === frameB && frameA !== -1) {
                console.error(
                  '[smoke] 宠物动效没在走：700ms 内帧号没变（frame=' + String(frameA) + '，用户会看到"冻住"）',
                );
                process.exitCode = 1;
              } else {
                console.log('[smoke] 宠物动效在走：' + String(frameA) + ' → ' + String(frameB));
              }
            }
          } catch (e) {
            console.error('[smoke] 青色大肥鱼宠物检查失败:', e);
            process.exitCode = 1;
          } finally {
            // 链跑完（无论成败）才置位；看门狗计时器等它。
            smokeChecksDone = true;
          }
        })();
      }, 2500);

      // 等检查链真的跑完再退（原来写死 15 秒，导致后半段断言根本没跑；见上面的说明）。
      // 300 秒是看门狗：真卡住了也要退出，并且**明确报错**而不是假装成功。
      const smokeDeadline = Date.now() + 300_000;
      const smokeWatchdog = setInterval(() => {
        if (!smokeChecksDone && Date.now() < smokeDeadline) return;
        clearInterval(smokeWatchdog);
        if (!smokeChecksDone) {
          console.error('[smoke] ❌ 检查链没有在 300 秒内跑完 —— 有断言未执行，本次结果不可信');
          process.exitCode = 1;
        }
        console.log('[smoke] ok');
        app.quit();
      }, 500);
    }
  });

  app.on('before-quit', () => {
    quitting = true;
    usage.stop();
    updates?.dispose();
    if (service) {
      // 冒烟模式不保留服务（见下面的 will-quit），其余情况沿用用户的 keepDshRunning。
      if (!SMOKE && store.get('keepDshRunning')) {
        console.log('[main] 退出时保留 DSH 服务（keepDshRunning=true，下次启动秒开）');
      }
    }
    store.save();
  });

  // ⚠️ 冒烟模式的 DSH 回收必须在这里做，不能放进 before-quit：
  // `service.stop()` 是异步的，而 before-quit 里 await 不了 —— app 会立刻退出，
  // DSH 子进程变成孤儿，继续占着端口（下一次冒烟就会被 isPortReady 误判为"已就绪"
  // 而复用，测出假结果）。这里先拦住退出，等回收真正完成再退。
  let smokeCleanedUp = false;
  app.on('will-quit', (event) => {
    if (!SMOKE || smokeCleanedUp || !service) return;
    smokeCleanedUp = true;
    event.preventDefault();
    console.log('[smoke] 停掉 DSH 服务（冒烟模式不保留）');
    void service
      .stop()
      .catch((error: unknown) => {
        console.error('[smoke] 停止 DSH 服务失败:', error);
      })
      .finally(() => {
        // ⚠️ 2026-10-08 修：原来是 `app.exit(0)` —— 它会**直接忽略 `process.exitCode`**
        //    （Electron 的 app.exit(code) 立即终止，不等正常退出流程）。
        //    于是所有断言写的 `process.exitCode = 1` 全被吞掉，**冒烟永远退 0**，
        //    "红了"这件事根本没有出口。现在把真实退出码带出去。
        app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0);
      });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    showMainWindow();
  });
}
