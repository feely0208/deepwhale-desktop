import * as fs from 'fs';
import * as path from 'path';
import { DEV_REPO_ROOT } from './dsh-runtime';

/**
 * 随包分发的「bundle 插件」—— 深鲸自己的两个能力包。
 *
 * 它们发布在 npm 上，但为了**装完即用、不依赖联网**而随 app 一起分发。
 * 与法律模式插件（客户端插件，靠往 patch 里插一行）不同，这两个是**标准 bundle**：
 * 各自带 `dsh.bundle.patch`，官方约定是把包名列进 profile 的 `dsh.profile.bundles`，
 * 由它们自己的 patch 把插件行挂进组合。因此这里**不手动插行**，只做三件事：
 *   ① 把包体复制到 `<home>/plugins/`
 *   ② 软链进 `<home>/profiles/web/node_modules/`
 *   ③ 在 profile 的 `dependencies` 里声明 `link:`，并把包名加进 `dsh.profile.bundles`
 */

interface BundledPlugin {
  /** npm 包名（也是 profile `bundles` 里的条目名，必须与包自身 package.json 的 name 完全一致）。 */
  name: string;
  /** 载荷下的目录名（= 包名去掉 scope）。 */
  dir: string;
}

/** 随包分发的插件清单。 */
const BUNDLED_PLUGINS: BundledPlugin[] = [
  { name: '@deepwhale-cn/dsh-cn-compliance', dir: 'dsh-cn-compliance' },
  { name: '@deepwhale-cn/dsh-cn-doc-formatter', dir: 'dsh-cn-doc-formatter' },
];

/** 注入结果。 */
export interface BundledPluginsResult {
  /** 本次是否写盘。 */
  changed: boolean;
  /** profile 目录尚未由 DSH 创建，调用方需在 DSH 就绪后再调一次。 */
  profilePending: boolean;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 逐文件比较后同步目录（内容一致则不写，避免每次启动重写几十个文件）。 */
function copyTreeIfChanged(srcDir: string, destDir: string): boolean {
  let changed = false;
  const walk = (src: string, dest: string): void => {
    const entries = fs.readdirSync(src, { withFileTypes: true });
    if (!fs.existsSync(dest)) {
      fs.mkdirSync(dest, { recursive: true });
      changed = true;
    }
    for (const entry of entries) {
      const from = path.join(src, entry.name);
      const to = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        walk(from, to);
        continue;
      }
      let same = false;
      try {
        same = fs.readFileSync(from).equals(fs.readFileSync(to));
      } catch {
        same = false;
      }
      if (!same) {
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
        changed = true;
      }
    }
  };
  walk(srcDir, destDir);
  return changed;
}

/** 随包插件载荷目录：打包后在 `Resources/bundled-plugins`，开发态在仓库根 `bundled-plugins`。 */
export function bundledPluginsPayloadDir(
  isPackaged: boolean,
  appPath: string,
  resourcesPath: string,
): string {
  if (isPackaged) return path.join(resourcesPath, 'bundled-plugins');
  for (const root of [appPath, DEV_REPO_ROOT, process.cwd()]) {
    const candidate = path.join(root, 'bundled-plugins');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 目录不可读：继续下一个候选
    }
  }
  return path.join(appPath, 'bundled-plugins');
}

/** 建立（或修正）插件到 profile node_modules 的软链；不支持软链时退回拷贝。 */
function ensurePluginEntry(entryPath: string, pluginDir: string): boolean {
  try {
    if (fs.readlinkSync(entryPath) === pluginDir) return false;
  } catch {
    // 不是软链，或尚不存在
  }
  if (fs.existsSync(entryPath)) fs.rmSync(entryPath, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  try {
    fs.symlinkSync(pluginDir, entryPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    fs.cpSync(pluginDir, entryPath, { recursive: true });
  }
  return true;
}

/**
 * 把包名与 `link:` 依赖写进 profile 的 package.json。
 *
 * `dsh.profile.bundles` 决定 DSH 会加载哪些 bundle 的组合层；
 * `dependencies` 里的 `link:` 保证这些包名能从 profile 作用域解析到。
 * 两者缺一不可（官方 `verify-cordis-config` 会强制 bundle 行能从本包自身作用域解析）。
 */
function ensureProfileEntry(file: string, plugins: Array<{ name: string; dir: string }>): boolean {
  const current = readText(file);
  if (current === null) return false;
  let manifest: {
    dependencies?: Record<string, string>;
    dsh?: { profile?: { bundles?: string[] } };
  };
  try {
    manifest = JSON.parse(current) as typeof manifest;
  } catch {
    return false;
  }

  const dependencies = { ...(manifest.dependencies ?? {}) };
  const bundles = [...(manifest.dsh?.profile?.bundles ?? [])];
  let changed = false;

  for (const plugin of plugins) {
    if (dependencies[plugin.name] !== plugin.dir) {
      dependencies[plugin.name] = plugin.dir;
      changed = true;
    }
    if (!bundles.includes(plugin.name)) {
      bundles.push(plugin.name);
      changed = true;
    }
  }
  if (!changed) return false;

  manifest.dependencies = dependencies;
  manifest.dsh = { ...(manifest.dsh ?? {}), profile: { ...(manifest.dsh?.profile ?? {}), bundles } };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

/**
 * 幂等注入随包插件。
 *
 * @param home - 本应用专属的 DSH home。
 * @param payloadDir - 随包插件载荷目录。
 * @returns 是否写盘，以及 profile 是否还没就位。
 */
export function ensureBundledPlugins(home: string, payloadDir: string): BundledPluginsResult {
  // 载荷缺失就整体跳过：宁可少两个插件，也不要注入指向空目录的链接。
  const available = BUNDLED_PLUGINS.filter((plugin) => {
    try {
      return fs.existsSync(path.join(payloadDir, plugin.dir, 'cordis.patch.yml'));
    } catch {
      return false;
    }
  });
  if (available.length === 0) return { changed: false, profilePending: false };

  fs.mkdirSync(home, { recursive: true });
  let changed = false;
  const resolved: Array<{ name: string; dir: string }> = [];

  for (const plugin of available) {
    const pluginDir = path.join(home, 'plugins', plugin.dir);
    changed = copyTreeIfChanged(path.join(payloadDir, plugin.dir), pluginDir) || changed;
    resolved.push({ name: plugin.name, dir: `link:${pluginDir}` });
  }

  const profileDir = path.join(home, 'profiles', 'web');
  const profilePending = !fs.existsSync(profileDir);
  if (!profilePending) {
    for (const plugin of available) {
      const pluginDir = path.join(home, 'plugins', plugin.dir);
      changed =
        ensurePluginEntry(
          path.join(profileDir, 'node_modules', ...plugin.name.split('/')),
          pluginDir,
        ) || changed;
    }
    changed = ensureProfileEntry(path.join(profileDir, 'package.json'), resolved) || changed;
  }

  return { changed, profilePending };
}
