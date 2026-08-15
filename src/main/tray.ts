import { Menu, MenuItemConstructorOptions, Tray, nativeImage } from 'electron';
import * as path from 'path';

export interface TrayMenuActions {
  showMainWindow: () => void;
  onQuit: () => void;
  onOpenCustomCss: () => void;
  onSetApiKey: () => void;
  onToggleUsagePanel: (visible: boolean) => void;
  onRefreshUsage: () => void;
  /** 皮肤子菜单（单选，radio 项已由调用方构建） */
  skinSubmenu: MenuItemConstructorOptions[];
  /** 宠物子菜单（含显示/隐藏） */
  petSubmenu: MenuItemConstructorOptions[];
  /** 用量面板当前可见状态 */
  usagePanelVisible: boolean;
}

/**
 * 构建统一菜单模板（托盘右键菜单 + macOS 顶栏应用菜单同构复用）。
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

/** 创建托盘 */
export function createTray(actions: TrayMenuActions): Tray {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/icons/tray.png'));
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('DeepSeek Harness Desktop');
  applyMenu(tray, actions);
  tray.on('double-click', () => actions.showMainWindow());
  return tray;
}

/** 重建托盘菜单（皮肤/宠物/用量状态变化后调用） */
export function applyMenu(tray: Tray, actions: TrayMenuActions): void {
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(actions)));
}
