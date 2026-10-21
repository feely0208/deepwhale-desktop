import { app, BrowserWindow } from 'electron';
import { DEV_REPO_ROOT } from './dsh-runtime';
import { DSH_RUNTIME_VERSION } from './dsh-version.generated';
import * as fs from 'fs';
import * as path from 'path';

/**
 * 取「壳」自己的版本号 —— 打包后就是 package.json 里的壳版本。
 *
 * ⚠️ 未打包时必须绕开 `app.getVersion()`：它以 `electron dist/main/index.js` 启动时
 *    返回的是 **Electron 自己的版本**（如 44.0.0），不是壳的版本。
 *    这个坑已经害过我们一次 —— 冒烟脚本当时拿 `app.getVersion()` 当"期望值"，
 *    于是它在界面上明明显示的是壳版本 1.0.24 时反而报「壳版本号不对」，
 *    一条永远失败的断言比没有断言更糟：真出问题时没人再信它。
 *    所以这个函数是**唯一**的取法，界面注入和冒烟断言都从这里拿。
 */
export function resolveShellVersion(): string {
  if (app.isPackaged) return app.getVersion();
  // ⚠️ 不能用 app.getAppPath() 顶替仓库根：以 `electron dist/main/index.js`
  //    启动时它返回入口脚本所在目录（`<repo>/dist/main`），不是仓库根。
  for (const root of [DEV_REPO_ROOT, process.cwd()]) {
    try {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(root, 'package.json'), 'utf-8'),
      ) as { name?: string; version?: string };
      if (pkg.name === 'deepwhale-desktop' && pkg.version) return pkg.version;
    } catch {
      // 换下一个候选
    }
  }
  return app.getVersion();
}

/** 设置页「当前版本」那行在我们注入之后应该长这样，冒烟用它做断言。 */
export function expectedVersionRow(): { shell: string; dsh: string } {
  return { shell: resolveShellVersion(), dsh: DSH_RUNTIME_VERSION };
}

/**
 * 设置页扩展注入：把"宠物 / 用量 / 皮肤"三个设置栏顺延注入到
 * DSH 设置页左侧导航（通用设置/模型/插件/Agent 预设）之下。
 * 静态资源：dist/settings/settings-ext.css + settings-ext.js。
 */
/**
 * 交给页面的平台标识。
 *
 * ⚠️ 2026-10-15：**只在隐藏冒烟模式下允许用 `DSH_SMOKE_PLATFORM` 覆盖**。
 * 为什么需要这个缝：设置页「本版更新内容」按钮**只对 Windows/Linux 注入**，而本机与 CI 的
 * 冒烟都跑在 macOS 上 —— 没有这个开关，这类"平台专属 UI"永远没法被截图/断言验证
 * （这正是"mac 有、win 没有"那类问题能溜过去的原因）。
 * 生产路径不受影响：只有 `DSH_DESKTOP_SMOKE_HIDDEN=1` 时才读这个环境变量。
 */
function smokePlatform(): string {
  if (process.env.DSH_DESKTOP_SMOKE_HIDDEN === '1') {
    const forced = process.env.DSH_SMOKE_PLATFORM;
    if (forced) return forced;
  }
  return process.platform;
}

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
    const shellVersion = resolveShellVersion();
    await win.webContents.executeJavaScript(
      // 连同平台一起交进去：非 macOS 才在设置页注入「本版更新内容」按钮
      // （mac 顶部系统菜单栏一眼就有，设置页不必再放一个 —— 用户 2026-10-15 的口径）。
      `window.__dshShellVersion = ${JSON.stringify(shellVersion)};` +
        `window.__dshShellPlatform = ${JSON.stringify(smokePlatform())};`,
    );
    const js = fs.readFileSync(path.join(__dirname, '../settings/settings-ext.js'), 'utf-8');
    await win.webContents.executeJavaScript(js);
  } catch (e) {
    console.error('[settings-ext] 脚本注入失败:', e);
  }
}
