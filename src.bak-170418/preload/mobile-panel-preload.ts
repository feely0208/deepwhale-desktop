/**
 * 手机连接面板的 preload：只暴露必要的四件事，其它一律不给。
 * （面板是本地页面，但按最小权限原则只放白名单方法 —— 与壳里其它 preload 一致。）
 */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('mobilePanel', {
  status: (): Promise<unknown> => ipcRenderer.invoke('mobile:status'),
  start: (): Promise<unknown> => ipcRenderer.invoke('mobile:start'),
  stop: (): Promise<unknown> => ipcRenderer.invoke('mobile:stop'),
  rotate: (): Promise<unknown> => ipcRenderer.invoke('mobile:rotate'),
  copy: (text: string): void => {
    void ipcRenderer.invoke('mobile:copy', text);
  },
  onState: (cb: (s: unknown) => void): (() => void) => {
    const listener = (_e: unknown, s: unknown): void => cb(s);
    ipcRenderer.on('mobile:state', listener);
    return () => ipcRenderer.removeListener('mobile:state', listener);
  },
});
