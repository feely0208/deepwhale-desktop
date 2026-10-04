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
  /** 手动检查更新（有结果会如实告知，含"已是最新"与失败原因） */
  onCheckUpdate?: () => void;
  /** 预览侧栏下载进度条（走与真实下载相同的状态通路，但纯假数据：不下载、不安装） */
  onPreviewUpdateProgress?: () => void;
  /** 打开「本版更新内容」窗口（用户要求：放帮助菜单里，别塞设置页） */
  onShowWhatsNew?: () => void;
  /** 打开「本机内文件」（任何会话都能用；与 ⌘⇧O 同一动作） */
  onOpenLocalFiles?: () => void;
  /** 诊断与关于：版本/更新状态/日志路径，一键复制或打开日志（用户反馈问题时能直接给全信息） */
  onShowDiagnostics?: () => void;
  /** 手机连接：显示「用手机打开」的地址（地址里已带 token，用户不用手打） */
  onMobileConnect?: () => void;
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
    { label: '本机内文件…', click: () => a.onOpenLocalFiles?.() },
    { label: '诊断与关于…', click: () => a.onShowDiagnostics?.() },
    { label: '手机连接…', click: () => a.onMobileConnect?.() },
    { type: 'separator' },
    { label: '检查更新…', click: () => a.onCheckUpdate?.() },
    // 进度条只在"正在下载更新"时出现 —— 升到最新版后用户根本没机会看它长什么样。
    // 这一项让用户随时能预览（走同一条 shell:update-state 通路，纯假数据）。
    { label: '预览更新进度条', click: () => a.onPreviewUpdateProgress?.() },
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
            // ⚠️ role 只给行为与快捷键，**标签要自己写** ——
            // 只写 role 不写 label，Electron 显示它内置的英文标签
            // （About / Services / Hide / Quit…），于是出现「顶级是中文、
            // 子项是英文」的割裂。每个 role 都配上中文 label。
            submenu: [
              { role: 'about' as const, label: '关于 ' + app.name },
              { type: 'separator' as const },
              { label: '设置…', accelerator: 'CmdOrCtrl+,', click: () => a.onOpenSettings?.() },
              { type: 'separator' as const },
              { role: 'services' as const, label: '服务' },
              { type: 'separator' as const },
              { role: 'hide' as const, label: '隐藏 ' + app.name },
              { role: 'hideOthers' as const, label: '隐藏其他' },
              { role: 'unhide' as const, label: '全部显示' },
              { type: 'separator' as const },
              { role: 'quit' as const, label: '退出 ' + app.name },
            ],
          },
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '文件',
      submenu: [
        { label: '显示主窗口', click: () => a.showMainWindow() },
        { type: 'separator' },
        ...(isMac
          ? ([{ role: 'close' as const, label: '关闭窗口' }] as MenuItemConstructorOptions[])
          : [{ role: 'quit' as const, label: '退出' }]),
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' as const, label: '撤销' },
        { role: 'redo' as const, label: '重做' },
        { type: 'separator' as const },
        { role: 'cut' as const, label: '剪切' },
        { role: 'copy' as const, label: '复制' },
        { role: 'paste' as const, label: '粘贴' },
        { role: 'selectAll' as const, label: '全选' },
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
        { role: 'minimize' as const, label: '最小化' },
        { role: 'zoom' as const, label: '缩放' },
        { type: 'separator' as const },
        { role: 'front' as const, label: '前置全部窗口' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        // 用户要求（2026-10-04）：「更新内容在设置页面就不要显示了，增加一个选项按钮在帮助里面」
        { label: '本版更新内容…', click: () => a.onShowWhatsNew?.() },
        { label: '本机内文件…', click: () => a.onOpenLocalFiles?.() },
        { label: '诊断与关于…', click: () => a.onShowDiagnostics?.() },
        { type: 'separator' as const },
        { label: '打开宠物目录…', click: () => a.onOpenPetsFolder?.() },
        { label: '打开自定义 CSS…', click: () => a.onOpenCustomCss() },
        { type: 'separator' as const },
        { label: '手机连接…', click: () => a.onMobileConnect?.() },
        { label: '检查更新…', click: () => a.onCheckUpdate?.() },
        { label: '预览更新进度条', click: () => a.onPreviewUpdateProgress?.() },
      ],
    },
  ];
}

/** 创建托盘 */
export function createTray(actions: TrayMenuActions): Tray {
  // 2026-10-03 修：托盘图标**绝不允许为空**。
  //
  // 旧写法是 `new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)` ——
  // 图片一旦加载失败就退化成空图，而空图在 Windows 上表现为
  // 「托盘里看不见、但进程确实在」：用户既点不到「检查更新…」也点不到「退出」，
  // 关窗口又是最小化到托盘，于是彻底无路可走（有 Windows 用户实测反馈，
  // 还导致新安装包装不进去 —— 因为旧进程退不出来）。
  //
  // 现在按优先级回退，只要有一张能看见的图就绝不空着。
  const candidates = [
    path.join(__dirname, '../assets/icons/tray.png'),
    path.join(__dirname, '../assets/icons/icon.png'),
    path.join(__dirname, '../assets/icons/icon.ico'),
    path.join(process.resourcesPath || '', 'icon.ico'),
  ];
  let icon = nativeImage.createEmpty();
  for (const candidate of candidates) {
    try {
      const img = nativeImage.createFromPath(candidate);
      if (!img.isEmpty()) {
        icon = img;
        break;
      }
    } catch {
      /* 试下一个 */
    }
  }
  // 模板图只对 macOS 有意义（让图标自适应菜单栏浅/深色）；Windows 上是无操作。
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  const tray = new Tray(icon);
  tray.setToolTip('DeepWhale Desktop');
  applyMenu(tray, actions);
  tray.on('double-click', () => actions.showMainWindow());
  return tray;
}

/** 重建托盘菜单（皮肤/宠物/用量状态变化后调用） */
export function applyMenu(tray: Tray, actions: TrayMenuActions): void {
  tray.setContextMenu(Menu.buildFromTemplate(buildMenuTemplate(actions)));
}
