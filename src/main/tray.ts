import { app, Menu, MenuItemConstructorOptions, Tray, nativeImage } from 'electron';
import * as path from 'path';

export interface TrayMenuActions {
  showMainWindow: () => void;
  onQuit: () => void;
  onOpenCustomCss: () => void;
  onSetApiKey: () => void;
  onToggleUsagePanel: (visible: boolean) => void;
  onRefreshUsage: () => void;
  /** 打开设置（Cmd+,）：聚焦主窗口并打开 DSH 设置页 */
  onOpenSettings?: () => void;
  /** 打开宠物目录 */
  onOpenPetsFolder?: () => void;
  /** 皮肤子菜单（主题/背景图片，由调用方构建） */
  skinSubmenu: MenuItemConstructorOptions[];
  /** 宠物子菜单（含显示/隐藏） */
  petSubmenu: MenuItemConstructorOptions[];
  /** 用量面板当前可见状态 */
  usagePanelVisible: boolean;
}

/**
 * 托盘右键菜单（紧凑形态）。
 */
export function buildMenuTemplate(a: TrayMenuActions): MenuItemConstructorOptions[] {
  return [
    { label: '显示主窗口', click: () => a.showMainWindow() },
    { type: 'separator' },
    { label: '皮肤', submenu: a.skinSubmenu },
    { label: '宠物', submenu: a.petSubmenu },
    { type: 'separator' },
    {
      label: '用量面板',
      type: 'checkbox',
      checked: a.usagePanelVisible,
      click: (item) => a.onToggleUsagePanel(item.checked),
    },
    { label: '立即刷新余额', click: () => a.onRefreshUsage() },
    { label: '设置 API Key…', click: () => a.onSetApiKey() },
    { label: '自定义 CSS…', click: () => a.onOpenCustomCss() },
    { type: 'separator' },
    { label: '退出', click: () => a.onQuit() },
  ];
}

/**
 * 应用菜单（macOS 顶栏 / Windows·Linux 窗口菜单栏）：
 * 遵循 macOS 菜单惯例——应用菜单（关于/设置… Cmd+,/服务/隐藏/退出）、
 * 文件、编辑（复制粘贴）、窗口（最小化/前置）、帮助，再并上本应用功能菜单。
 */
export function buildAppMenuTemplate(a: TrayMenuActions): MenuItemConstructorOptions[] {
  const isMac = process.platform === 'darwin';
  return [
    // macOS 应用菜单（以应用名为标题，含关于/设置…/服务/隐藏/退出）
    ...(isMac
      ? ([
          {
            label: app.name,
            submenu: [
              { role: 'about' as const },
              { type: 'separator' as const },
              { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => a.onOpenSettings?.() },
              { type: 'separator' as const },
              { role: 'services' as const },
              { type: 'separator' as const },
              { role: 'hide' as const },
              { role: 'hideOthers' as const },
              { role: 'unhide' as const },
              { type: 'separator' as const },
              { role: 'quit' as const },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '文件',
      submenu: [
        { label: '显示主窗口', click: () => a.showMainWindow() },
        { type: 'separator' },
        ...(isMac ? ([{ role: 'close' as const }] as MenuItemConstructorOptions[]) : [{ role: 'quit' as const }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    { label: '皮肤', submenu: a.skinSubmenu },
    { label: '宠物', submenu: a.petSubmenu },
    {
      label: '用量',
      submenu: [
        {
          label: '用量面板',
          type: 'checkbox',
          checked: a.usagePanelVisible,
          click: (item) => a.onToggleUsagePanel(item.checked),
        },
        { label: '立即刷新余额', click: () => a.onRefreshUsage() },
        { label: '设置 API Key…', click: () => a.onSetApiKey() },
      ],
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        { type: 'separator' as const },
        { role: 'front' as const },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '打开宠物目录…', click: () => a.onOpenPetsFolder?.() },
        { label: '打开自定义 CSS…', click: () => a.onOpenCustomCss() },
      ],
    },
  ];
}

/** 创建托盘 */
export function createTray(actions: TrayMenuActions): Tray {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icons/tray.png'));
  // 模板图：macOS 自动根据菜单栏浅/深色渲染
  icon.setTemplateImage(true);
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('DeepWhale Desktop');
  applyMenu(tray, actions);
  tray.on('double-click', () => actions.showMainWindow());
  return tray;
}

/** 重建托盘菜单（皮肤/宠物/用量状态变化后调用） */
export function applyMenu(tray: Tray, actions: TrayMenuActions): void {
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(actions)));
}
