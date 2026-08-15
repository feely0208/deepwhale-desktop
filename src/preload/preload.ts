import { contextBridge, ipcRenderer } from 'electron';

/**
 * 最小 IPC 桥：宠物页与注入的用量面板共用。
 * contextIsolation 开启时，页面只能访问这里显式暴露的 API，不暴露 ipcRenderer 本体。
 */
contextBridge.exposeInMainWorld('dsh', {
  // ---- 桌面宠物 ----
  petDragStart: () => ipcRenderer.send('pet:drag-start'),
  petDragMove: () => ipcRenderer.send('pet:drag-move'),
  petDragEnd: () => ipcRenderer.send('pet:drag-end'),
  petContextMenu: () => ipcRenderer.send('pet:context-menu'),

  // ---- 用量面板 ----
  usageRefresh: () => ipcRenderer.send('usage:refresh'),
  onUsageUpdate: (callback: (data: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on('usage:update', listener);
    // 返回取消订阅函数
    return () => ipcRenderer.removeListener('usage:update', listener);
  },
});
