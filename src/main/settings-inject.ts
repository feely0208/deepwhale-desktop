import { BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 设置页扩展注入：把"宠物 / 用量 / 皮肤"三个设置栏顺延注入到
 * DSH 设置页左侧导航（通用设置/模型/插件/Agent 预设）之下。
 * 静态资源：dist/settings/settings-ext.css + settings-ext.js。
 */
export async function injectSettingsExtension(win: BrowserWindow): Promise<void> {
  try {
    const css = fs.readFileSync(path.join(__dirname, '../settings/settings-ext.css'), 'utf-8');
    await win.webContents.insertCSS(css, { cssOrigin: 'author' });
  } catch (e) {
    console.error('[settings-ext] 样式注入失败:', e);
  }
  try {
    const js = fs.readFileSync(path.join(__dirname, '../settings/settings-ext.js'), 'utf-8');
    await win.webContents.executeJavaScript(js);
  } catch (e) {
    console.error('[settings-ext] 脚本注入失败:', e);
  }
}
