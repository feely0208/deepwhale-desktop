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
    onMobileConnect: () => void showMobileConnect(),
    skinSubmenu,
    petSubmenu,
    usagePanelVisible: store.get('usagePanelVisible'),
  };
}

function rebuildMenus(): void {
  // 应用菜单（macOS 顶栏/窗口菜单栏）：完整 macOS 结构（应用/文件/编辑/窗口/帮助）
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
  const icon = failed ? '⚠️' : '🐋';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0d1424;color:#e8eefc;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
    .box{text-align:center;padding:40px}.icon{font-size:56px}.title{font-size:26px;font-weight:700;margin:16px 0 10px}.msg{font-size:15px;color:${color}}
  </style></head><body><div class="box"><div class="icon">${icon}</div><div class="title">DeepWhale Desktop</div><p class="msg">${msg}</p></div></body></html>`;
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

  app.whenReady().then(async () => {
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
      officeSetup = ensureOfficeSetup(legalHome, officePayload, legalRuntimeDir, process.execPath);
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
      const dshAlreadyUp = await dshPortAnswered();
      if (dshAlreadyUp && SMOKE) {
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
      // 端到端检查：打开设置页 → 验证注入的"宠物/用量/皮肤"导航项与面板激活
      setTimeout(() => {
        void (async () => {
          try {
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
              return JSON.stringify({ navPet: has('dsh-ext-nav-pet'), navUsage: has('dsh-ext-nav-usage'), navSkin: has('dsh-ext-nav-skin'), panel: has('dsh-ext-panel'), activated, petNavOn, petItems, themeItems, usageRows, verText, verRow });
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
                console.log('[smoke] 设置页已显示壳版本：' + parsed.verRow);
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
              return JSON.stringify({
                count: document.querySelectorAll('#dsh-ext-dl').length,
                display: s ? s.style.display : 'missing',
                fillWidth: f ? f.style.width : 'missing',
                text: t ? t.textContent : 'missing',
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
              vw: number; vh: number; settingsRowVisible: boolean; settingsRowText: string;
            };
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
            } else if (!p2.text.includes('42%')) {
              console.error('[smoke] 侧栏进度条没显示百分比文字：' + p2.text);
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
              console.log('[smoke] 侧栏下载进度条可见：' + JSON.stringify(p2.rect) + ' 文字=' + p2.text);
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
            }
          } catch (e) {
            console.error('[smoke] 青色大肥鱼宠物检查失败:', e);
            process.exitCode = 1;
          }
        })();
      }, 2500);

      setTimeout(() => {
        console.log('[smoke] ok');
        app.quit();
      }, 15000);
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
      .finally(() => app.exit(0));
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    showMainWindow();
  });
}
