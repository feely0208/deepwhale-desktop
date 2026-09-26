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
import * as fs from 'fs';
import * as path from 'path';
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
import { injectSettingsExtension } from './settings-inject';
import { UpdateManager } from './update-manager';
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
    title: '欢迎使用深鲸壳',
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
    skinSubmenu,
    petSubmenu,
    usagePanelVisible: store.get('usagePanelVisible'),
  };
}

function rebuildMenus(): void {
  if (!tray) return;
  applyMenu(tray, buildMenuActions());
  // 应用菜单（macOS 顶栏/窗口菜单栏）：完整 macOS 结构（应用/文件/编辑/窗口/帮助）
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildAppMenuTemplate(buildMenuActions())));
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
    } catch (err) {
      console.error('[main] 设置保存失败:', payload.key, err);
    }
  });

  // ---- 主题 / 背景皮肤（设置页/菜单共用） ----
  ipcMain.handle('theme:state', () => ({
    skinImage: store.get('skinImage'),
    skinOpacity: store.get('skinOpacity'),
    customCssEnabled: store.get('customCssEnabled'),
    previewDataUri: skin.backgroundPreviewDataUri(),
  }));
  ipcMain.on('skin:pick-image', () => void pickBackgroundImage());
  ipcMain.on('skin:clear-image', () => {
    if (mainWin) void skin.clearBackground(mainWin);
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
      message: '深鲸壳无法连接到 DSH 服务',
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
      let after: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
      try {
        after = ensureLegalModeSetup(legalHome, payloadDir, legalRuntimeDir);
      } catch (error) {
        logInjectionFailure('legal-mode', 'profile 注入', error);
      }
      let afterOffice: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
      try {
        afterOffice = ensureOfficeSetup(legalHome, officePayload, legalRuntimeDir, process.execPath);
      } catch (error) {
        logInjectionFailure('office', 'profile 注入', error);
      }
      let afterPlugins: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
      try {
        afterPlugins = ensureBundledPlugins(legalHome, pluginsPayload);
      } catch (error) {
        logInjectionFailure('plugins', 'profile 注入', error);
      }
      if (SMOKE) {
        console.log(`[smoke] profile injection: legal=${String(after.changed)} office=${String(afterOffice.changed)} plugins=${String(afterPlugins.changed)}`);
      }
      // 任一注入写了盘且 profile 已就位，就重载一次让新入口图生效。
      const profileReady =
        !after.profilePending && !afterOffice.profilePending && !afterPlugins.profilePending;
      if ((after.changed || afterOffice.changed || afterPlugins.changed) && profileReady && mainWin !== null) {
        // 等带 token 的那次导航落定再重载：两次并发导航会互相 abort
        // （表现为一条 ERR_ABORTED 告警），这里让重载晚一步。
        const win = mainWin;
        setTimeout(() => {
          if (win.isDestroyed()) return;
          const url = dshTokenUrl || `http://127.0.0.1:${store.get('port')}/`;
          void win.loadURL(url).catch(() => {});
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
      await mainWin.loadURL(dshTokenUrl || `http://127.0.0.1:${store.get('port')}`);
    } else {
      await showStartingPage(mainWin, true);
    }

    if (store.get('petVisible')) pet.create();

    tray = createTray(buildMenuActions());
    rebuildMenus();

    // 自动更新：等应用完全可用后再启动，避免与 DSH 冷启动争抢资源。
    // DSH 没起来时（dshReady=false）不启动——此时用户有更紧急的问题要处理。
    // 整个流程纯增量，出错只记日志，不影响任何既有功能。
    if (dshReady) {
      updates = new UpdateManager({
        getWindow: () => (mainWin !== null && !mainWin.isDestroyed() ? mainWin : null),
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
              return JSON.stringify({ navPet: has('dsh-ext-nav-pet'), navUsage: has('dsh-ext-nav-usage'), navSkin: has('dsh-ext-nav-skin'), panel: has('dsh-ext-panel'), activated, petNavOn, petItems, themeItems, usageRows });
            })()`);
            console.log('[smoke] settings-ext:', r);
          } catch (e) {
            console.error('[smoke] settings-ext 检查失败:', e);
          }
        })();
      }, 2500);

      setTimeout(() => {
        console.log('[smoke] ok');
        app.quit();
      }, 8000);
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
