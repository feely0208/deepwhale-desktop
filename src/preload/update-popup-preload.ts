/**
 * 更新弹窗的 preload（2026-10-04）
 * 只暴露三件小事：接收主进程推送、回报按钮动作、通知"已就绪"。
 * 刻意保持最小面：弹窗是纯展示 + 两个按钮，不需要任何文件系统或系统能力。
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('dshPopup', {
  on: (cb: (msg: unknown) => void) => {
    ipcRenderer.on('popup:msg', (_e, msg) => cb(msg));
  },
  action: (action: string) => ipcRenderer.send('popup:action', action),
  ready: () => ipcRenderer.send('popup:ready'),
});
