import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItemConstructorOptions,
  Notification,
  Tray,
} from 'electron';
import * as path from 'path';
import { Store } from './store';
import { ServiceManager } from './service-manager';
import { createMainWindow } from './window';
import { SkinManager } from './skin-manager';
import { PetWindow } from './pet';
import { createTray, applyMenu, buildMenuTemplate, TrayMenuActions } from './tray';
import { UsageManager, UsageSnapshot } from './usage-manager';

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
let quitting = false;
let service: ServiceManager | null = null;

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

/** did-finish-load 回调：应用皮肤 + 注入用量面板 */
async function onPageReady(win: BrowserWindow): Promise<void> {
  await skin.apply(win);
  if (store.get('usagePanelVisible')) {
    await usage.applyPanel(win);
  }
  if (SMOKE) console.log('[smoke] page ready (skin + usage panel injected)');
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

/** 构建统一菜单动作（托盘 + macOS 顶栏共用） */
function buildMenuActions(): TrayMenuActions {
  const skins = skin.listSkins();
  const currentSkin = store.get('skin');
  const skinSubmenu: MenuItemConstructorOptions[] = skins.map((s) => ({
    label: s,
    type: 'radio',
    checked: s === currentSkin,
    click: () => {
      if (mainWin) void skin.setSkin(mainWin, s);
      rebuildMenus();
    },
  }));

  const gifs = pet ? pet.listPets() : [];
  const currentGif = store.get('petGif');
  const gifSubmenu: MenuItemConstructorOptions[] = [
    {
      label: '默认宠物（CSS 动画）',
      type: 'radio',
      checked: !currentGif,
      click: () => {
        store.set('petGif', null);
        pet?.reload();
      },
    },
    ...gifs.map(
      (g): MenuItemConstructorOptions => ({
        label: g,
        type: 'radio',
        checked: currentGif === g,
        click: () => {
          store.set('petGif', g);
          pet?.reload();
        },
      })
    ),
  ];
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
    { label: '宠物皮肤', submenu: gifSubmenu },
    {
      label: '穿透点击',
      type: 'checkbox',
      checked: store.get('clickThrough'),
      click: (item) => {
        store.set('clickThrough', item.checked);
        pet?.window?.setIgnoreMouseEvents(item.checked, { forward: true });
      },
    },
  ];

  return {
    showMainWindow,
    onQuit: () => app.quit(),
    onOpenCustomCss: () => skin.openCustomCss(),
    onSetApiKey: () => openApiKeyDialog(),
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
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate(buildMenuActions())));
}

function registerIpc(): void {
  pet?.registerIpc();
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
  ipcMain.on('apikey:close', () => apiKeyWin?.close());
}

// 单实例：多个实例会互相争抢 3080 端口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(async () => {
    pet = new PetWindow(store);
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
