import * as fs from 'fs';
import * as path from 'path';

/** 随包 DSH 运行时在资源目录下的相对路径（相对 `dsh-runtime/`）。 */
const RUNTIME_ENTRY = ['node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'] as const;

/**
 * 定位随包 DSH 运行时入口。
 *
 * 安装包把整个 DSH 运行时（`@deepseek-ai/dsh` 及其依赖）打进资源目录，主进程用
 * Electron 自带的 Node（`ELECTRON_RUN_AS_NODE`）拉起它。这样用户机器上：
 * 无需安装 Node.js、无需 npx、无需联网从 npm 下载，装完即用。
 *
 * @param isPackaged - `app.isPackaged`：打包态只在 resources 下找，开发态允许仓库根目录。
 * @param appPath - `app.getAppPath()`，开发态即仓库根目录。
 * @param resourcesPath - `process.resourcesPath`，打包态的资源目录。
 * @returns 运行时入口的绝对路径；未随包或文件缺失时返回 `undefined`，
 *          此时调用方回落到 settings.json 配置的 command。
 */
export function bundledDshBin(
  isPackaged: boolean,
  appPath: string,
  resourcesPath: string,
): string | undefined {
  const roots = isPackaged ? [resourcesPath] : [appPath, resourcesPath];
  for (const root of roots) {
    const candidate = path.join(root, 'dsh-runtime', ...RUNTIME_ENTRY);
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 目录不可读：继续尝试下一个根目录
    }
  }
  return undefined;
}

/**
 * 从 dsh 入口反推它所在的 `node_modules` 目录。
 *
 * 入口形如 `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js`，向上三级即为
 * `node_modules`。该目录是 `@deepseek-ai/dsh-persona` 等插件的解析根，
 * 调用方据此判定目标运行时的插件 schema 版本（见 legal-mode.ts）。
 *
 * @param bin - `bundledDshBin` 返回的入口绝对路径。
 * @returns `node_modules` 绝对路径；层级不符时返回 undefined。
 */
export function dshNodeModulesDir(bin: string | undefined): string | undefined {
  if (!bin) return undefined;
  const dir = path.resolve(path.dirname(bin), '..', '..', '..');
  return path.basename(dir) === 'node_modules' ? dir : undefined;
}
