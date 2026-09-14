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
import * as fs from 'fs';
import * as path from 'path';
import { Store } from './store';
import { ServiceManager } from './service-manager';
import { ensureLegalModeSetup, legalModeHome, legalModePayloadDir } from './legal-mode';
import { bundledDshBin } from './dsh-runtime';
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
/** DSH 日志里解析出的带 token 访问地址（鉴权部署时由 dsh web 打印） */
let dshTokenUrl = '';

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

async function showStartingPage(win: BrowserWindow, failed = false): Promise<void> {
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(startingPageHtml(failed)));
}

  app.whenReady().then(async () => {
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
    // 注入失败绝不能影响壳启动（例如文件系统不支持创建链接/权限不足）：
    // 这里整体兜底，最坏情况只是"用户端没有法律模式联动"。
    let setup: { changed: boolean; profilePending: boolean } = { changed: false, profilePending: false };
    try {
      setup = ensureLegalModeSetup(legalHome, payloadDir);
    } catch (error) {
      console.error('[legal-mode] 载荷注入失败（不影响启动）:', error);
    }
    if (SMOKE) {
      console.log(`[smoke] legal-mode setup: changed=${String(setup.changed)} pending=${String(setup.profilePending)}`);
    }

    // 随包 DSH 运行时：安装包内置整套 DSH，用 Electron 自带 Node 拉起，
    // 用户机器无需 Node.js / npx / 联网下载。缺失时回落到 settings.json 的 command。
    const bundledBin = bundledDshBin(app.isPackaged, app.getAppPath(), process.resourcesPath);
    if (SMOKE) {
      console.log(`[smoke] bundled DSH runtime: ${bundledBin ?? '(none)'}`);
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
        after = ensureLegalModeSetup(legalHome, payloadDir);
      } catch (error) {
        console.error('[legal-mode] profile 注入失败（不影响启动）:', error);
      }
      if (after.changed && !after.profilePending && mainWin !== null) {
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
      const detail = service.lastOutput() ? `\n\n--- DSH 输出 ---\n${service.lastOutput()}` : '';
      dialog.showErrorBox('DSH 启动失败', `${String(e)}${detail}`);
      // 不退出：用户可修改命令后从托盘重启
    }

    if (dshReady) {
      await mainWin.loadURL(dshTokenUrl || `http://127.0.0.1:${store.get('port')}`);
    } else {
      await showStartingPage(mainWin, true);
    }

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
    if (service) {
      if (store.get('keepDshRunning')) {
        console.log('[main] 退出时保留 DSH 服务（keepDshRunning=true，下次启动秒开）');
      } else {
        void service.stop();
      }
    }
    store.save();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    showMainWindow();
  });
}
