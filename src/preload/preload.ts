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
  usageLog: (msg: string) => ipcRenderer.send('usage:log', msg),
  onUsageUpdate: (callback: (data: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('usage:update', listener);
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener('usage:update', listener);
  },

  // ---- API Key 设置窗 ----
  setApiKey: (key: string) => ipcRenderer.send('usage:set-key', key),
  closeWindow: () => ipcRenderer.send('apikey:close'),

  // ---- 主题 / 背景皮肤（设置页扩展） ----
  themeState: () => ipcRenderer.invoke('theme:state'),
  skinPickImage: () => ipcRenderer.send('skin:pick-image'),
  skinClearImage: () => ipcRenderer.send('skin:clear-image'),
  skinSetOpacity: (value: number) => ipcRenderer.send('skin:set-opacity', value),
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
});
