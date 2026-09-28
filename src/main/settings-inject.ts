import { app, BrowserWindow } from 'electron';
import { DEV_REPO_ROOT } from './dsh-runtime';
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
    // 先把壳的版本号交给页面，再注入扩展脚本 —— 通用设置里的「当前版本」
    // 只显示 DSH 运行时版本，用户想知道壳是几版得翻安装包，很别扭。
    // 打包后 app.getVersion() 就是 package.json 里的壳版本；
    // 未打包时它返回的是 **Electron 自己的版本**（如 44.0.0），会误导人 ——
    // 开发态下改读仓库的 package.json，让冒烟验到的也是真实版本号。
    let shellVersion = app.getVersion();
    if (!app.isPackaged) {
      // ⚠️ 不能用 app.getAppPath() 顶替仓库根：以 `electron dist/main/index.js`
      //    启动时它返回入口脚本所在目录（`<repo>/dist/main`），不是仓库根。
      for (const root of [DEV_REPO_ROOT, process.cwd()]) {
        try {
          const pkg = JSON.parse(
            fs.readFileSync(path.join(root, 'package.json'), 'utf-8'),
          ) as { name?: string; version?: string };
          if (pkg.name === 'deepwhale-desktop' && pkg.version) {
            shellVersion = pkg.version;
            break;
          }
        } catch {
          // 换下一个候选
        }
      }
    }
    await win.webContents.executeJavaScript(
      `window.__dshShellVersion = ${JSON.stringify(shellVersion)};`,
    );
    const js = fs.readFileSync(path.join(__dirname, '../settings/settings-ext.js'), 'utf-8');
    await win.webContents.executeJavaScript(js);
  } catch (e) {
    console.error('[settings-ext] 脚本注入失败:', e);
  }
}
