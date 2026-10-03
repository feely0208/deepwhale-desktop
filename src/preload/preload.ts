import { contextBridge, ipcRenderer } from 'electron';

/**
 * 最小 IPC 桥：宠物页、注入的用量面板、API Key 设置窗、设置页扩展共用。
 * contextIsolation 开启时，页面只能访问这里显式暴露的 API，不暴露 ipcRenderer 本体。
 */
contextBridge.exposeInMainWorld('dsh', {
  // ---- 桌面宠物（宠物页拖拽/右键） ----
  petDragStart: () => ipcRenderer.send('pet:drag-start'),
  petDragMove: () => ipcRenderer.send('pet:drag-move'),
  petDragEnd: () => ipcRenderer.send('pet:drag-end'),
  petContextMenu: () => ipcRenderer.send('pet:context-menu'),
  petSpriteInfo: (name: string) => ipcRenderer.invoke('pet:sprite-info', name),

  // ---- 用量面板 ----
  usageRefresh: () => ipcRenderer.send('usage:refresh'),
  onUsageUpdate: (callback: (data: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('usage:update', listener);
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener('usage:update', listener);
  },

  // ---- API Key 设置窗 ----
  setApiKey: (key: string) => ipcRenderer.send('usage:set-key', key),
  closeWindow: () => ipcRenderer.send('apikey:close'),

  // ---- 首次启动引导窗 ----
  // 引导只在全新安装的第一次出现（判断在主进程），完成后写入标记永不再显示
  welcomeFinish: () => ipcRenderer.send('welcome:finish'),
  welcomeOpenApiKey: () => ipcRenderer.send('welcome:open-api-key'),

  // ---- 通用设置读写（设置页扩展用） ----
  getSetting: (key: string) => ipcRenderer.invoke('settings:get', key),
  setSetting: (key: string, value: unknown) => ipcRenderer.send('settings:set', { key, value }),

  // ---- 主题 / 背景皮肤（设置页扩展） ----
  themeState: () => ipcRenderer.invoke('theme:state'),
  skinPickImage: () => ipcRenderer.send('skin:pick-image'),
  skinClearImage: () => ipcRenderer.send('skin:clear-image'),
  skinSetOpacity: (value: number) => ipcRenderer.send('skin:set-opacity', value),
  skinSetPreset: (preset: string) => ipcRenderer.send('skin:set-preset', preset),
  skinOpenCss: () => ipcRenderer.send('skin:open-css'),
  skinToggleCustomCss: (enabled: boolean) => ipcRenderer.send('skin:toggle-custom-css', enabled),

  // ---- 宠物（设置页扩展） ----
  petList: () => ipcRenderer.invoke('pet:list'),
  petState: () => ipcRenderer.invoke('pet:state'),
  petSelect: (name: string | null) => ipcRenderer.send('pet:select-pet', name),
  petSetVisible: (visible: boolean) => ipcRenderer.send('pet:set-visible', visible),
  petSetClickThrough: (enabled: boolean) => ipcRenderer.send('pet:set-click-through', enabled),
  petSetConfig: (frameMs: number, scale: number) => ipcRenderer.send('pet:set-config', { frameMs, scale }),
  petOpenFolder: () => ipcRenderer.send('pet:open-folder'),

  // ---- 宠物工坊 ----
  petStudioOpen: () => ipcRenderer.send('petstudio:open'),
  petStudioSave: (name: string, svg: string) => ipcRenderer.send('petstudio:save', { name, svg }),
  petStudioImport: () => ipcRenderer.invoke('petstudio:import-image'),

  // ---- 会话右键菜单的「在访达中打开 / 打开所在文件夹 / 复制文件路径 / 复制会话 ID」----
  // 由随包客户端插件 @deepwhale-cn/dsh-shell-session-actions 调用；主进程按会话 ID
  // 自己找回话文件（不信任前端传路径），返回 { ok, message? }。
  sessionAction: (payload: { kind: string; sessionId: string; title?: string }) =>
    ipcRenderer.invoke('session:action', payload),

  // ---- 文档预览的「打印」（PDF / 图片走主进程打印**文件本身**）----
  // 由随包客户端插件 @deepwhale-cn/dsh-shell-document-print 调用。
  // 渲染层只转交预览面板给出的路径，主进程自己校验它确实是本机一个可打印文件
  // （并纠正 /mac/... 这类省掉 /Users 前缀的显示形态），不做任何回读。
  printDocument: (payload: { path: string }) => ipcRenderer.invoke('document:print', payload),

  // ---- 设置页「检查更新 / 彻底退出后台 / 更新进度」（2026-10-03）----
  // 起因：Windows 用户托盘图标不可见时，「检查更新」「退出」只放在托盘菜单里 → 无路可走。
  checkUpdate: () => ipcRenderer.invoke('shell:check-update'),
  quitApp: () => ipcRenderer.invoke('shell:quit'),
  onUpdateState: (cb: (state: unknown) => void) => {
    const listener = (_e: unknown, state: unknown): void => cb(state);
    ipcRenderer.on('shell:update-state', listener);
    return () => ipcRenderer.removeListener('shell:update-state', listener);
  },
});
