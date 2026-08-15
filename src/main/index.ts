import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  nativeTheme,
  Notification,
  Tray,
} from 'electron';
import * as path from 'path';
import { Store } from './store';
import { ServiceManager } from './service-manager';
import { createMainWindow } from './window';
import { SkinManager } from './skin-manager';
import { PetWindow } from './pet';
import { createTray, applyMenu, buildAppMenuTemplate, TrayMenuActions } from './tray';
import { UsageManager, UsageSnapshot } from './usage-manager';
import { injectSettingsExtension } from './settings-inject';

/** 冒烟测试模式：自动启动、打印关键事件、8 秒后退出（供 CI/自动化验证） */
const SMOKE = !!process.env.DSH_DESKTOP_SMOKE;

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
let quitting = false;
let service: ServiceManager | null = null;

const THEME_OPTIONS: Array<{ id: 'system' | 'light' | 'dark'; label: string }> = [
  { id: 'system', label: '跟随系统' },
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
];

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
  const currentTheme = store.get('theme');
  const themeSubmenu: MenuItemConstructorOptions[] = THEME_OPTIONS.map((t) => ({
    label: t.label,
    type: 'radio',
    checked: currentTheme === t.id,
    click: () => {
      if (mainWin) void skin.setTheme(mainWin, t.id);
      rebuildMenus();
    },
  }));

  const skinSubmenu: MenuItemConstructorOptions[] = [
    { label: '主题', submenu: themeSubmenu },
    { type: 'separator' },
    { label: '背景图片…', click: () => void pickBackgroundImage() },
    {
      label: '移除背景图片',
      enabled: !!store.get('skinImage'),
      click: () => {
        if (mainWin) void skin.clearBackground(mainWin);
        rebuildMenus();
      },
    },
    { type: 'separator' },
    { label: '自定义 CSS…', click: () => skin.openCustomCss() },
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

  // ---- 主题 / 背景皮肤（设置页/菜单共用） ----
  ipcMain.handle('theme:state', () => ({
    theme: store.get('theme'),
    skinImage: store.get('skinImage'),
    skinOpacity: store.get('skinOpacity'),
    customCssEnabled: store.get('customCssEnabled'),
    previewDataUri: skin.backgroundPreviewDataUri(),
  }));
  ipcMain.on('theme:set', (_e, theme: 'system' | 'light' | 'dark') => {
    if (mainWin) void skin.setTheme(mainWin, theme);
    rebuildMenus();
  });
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
}

// 单实例：多个实例会互相争抢 3080 端口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    // 原生界面主题跟随设置（跟随系统/浅色/深色），默认跟随系统
    nativeTheme.themeSource = store.get('theme');

    pet = new PetWindow(store);
    pet.ensureUserPetsDir();
    registerIpc();

    service = new ServiceManager(store.get('command'), {
      port: store.get('port'),
      onLogLine: (line) => usage.consumeLogLine(line),
    });
    usage.start();

    try {
      await service.ensureReady();
      if (SMOKE) console.log('[smoke] DSH ready (reused or spawned)');
    } catch (e) {
      console.error('[main] DSH 启动失败:', e);
      if (SMOKE) {
        console.error('[smoke] service failed');
        app.exit(1);
        return;
      }
      dialog.showErrorBox('DSH 启动失败', String(e));
      // 不退出：用户可修改命令后从托盘重启
    }

    mainWin = createMainWindow({
      port: store.get('port'),
      closeToTray: store.get('closeToTray'),
      isQuitting: () => quitting,
      onPageReady,
    });
    mainWin.on('closed', () => {
      mainWin = null;
    });

    if (store.get('petVisible')) pet.create();

    tray = createTray(buildMenuActions());
    rebuildMenus();

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
    if (service) void service.stop();
    store.save();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    showMainWindow();
  });
}
