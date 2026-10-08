import * as fs from 'fs';
import { profileDirOf } from './profile';
import * as path from 'path';
import { DEV_REPO_ROOT } from './dsh-runtime';

/**
 * 随包分发的「bundle 插件」—— 深鲸自己的能力包（中文合规、公文排版、法律模式预设、
 * 会话右键菜单四行）。
 *
 * 它们发布在 npm 上，但为了**装完即用、不依赖联网**而随 app 一起分发。
 * 与法律模式插件（客户端插件，靠往 patch 里插一行）不同，这些是**标准 bundle**：
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
  // 「法律模式」预设。**必须走 bundle**：0.1.7-rc.2 起预设不再是
  // `<home>/.agent-presets/<id>/` 目录（运行时文档原话：Nothing reads that
  // directory any more），而是 `@deepseek-ai/dsh-agent-preset` 的声明，由 bundle
  // 的 patch 携带。壳原来只写那个目录，于是「法律模式」从来不进花名册 ——
  // 用户在选择器里根本找不到它（2026-09-28 实测：--dump-config 只有 4 个随包预设）。
  // 产物由 scripts/build-legal-preset-bundle.js 从 legal-mode/preset/ 生成。
  { name: '@deepwhale-cn/dsh-legal-preset', dir: 'dsh-legal-preset' },
  // 会话右键菜单四行（在访达中打开 / 打开所在文件夹 / 复制文件路径 / 复制会话 ID）。
  // 同样是标准 bundle：宿主半边是空壳，功能全在客户端半边 lib/client.js ——
  // 正因为它以 bundle 行的形式被 loader 挂载，@deepseek-ai/dsh-client-modules
  // 才会扫到本包的 dsh.client 声明，把 ./client 下发给浏览器。
  { name: '@deepwhale-cn/dsh-shell-session-actions', dir: 'dsh-shell-session-actions' },
  // 右侧「文档预览」工具栏的「打印」按钮。官方只在 Excel 预览里有打印，
  // PDF / Word / PPT / Markdown / 文本 / 图片都没有 —— 本插件往
  // `sidebar.right.tab.document.actions` 插槽加一项，补上这块（2026-10-02）。
  { name: '@deepwhale-cn/dsh-shell-document-print', dir: 'dsh-shell-document-print' },
  // 只做"打开官方右栏网页浏览器"这一件事的补丁包（见该包 cordis.patch.yml 的说明）：
  // 官方把它挂在 `profileContext.name === 'desktop'` 条件下，而同一个条件还开着
  // 官方遥测与产品埋点 —— 所以我们不改 profile 名，只单独覆盖这一条 disabled。
  { name: '@deepwhale-cn/dsh-shell-web-preview', dir: 'dsh-shell-web-preview' },
  // ⛔ 品牌标记（空白会话顶部的青色大肥鱼）**不进包** —— 见文件末尾那条说明
  //    （2026-10-08 用户决定：保留 DSH 官方原生的品牌标记）。原来这里是它的声明，已摘掉。
  // 「深鲸画布」面板（2026-10-07，S3）：选模板 → 填参数 → 校验 → 预览 → 出横竖双版成片。
  // 宿主半边挂了 /dsh-canvas HTTP 出口并起渲染子进程；**引擎（canvas/）不在本仓库里**，
  // 由 `$DSH_HOME/dsh-canvas.json` 或面板里的「引擎设置」指定目录。
  // ⛔ 「深鲸画布」面板（`shell-plugins/dsh-shell-canvas`）**不进 1.0.54**（2026-10-07 定）。
  //
  // 理由（三条，按重要性排）：
  //   ① **我们自己都还没实测过它生成的成片效果** —— 没看过成片就谈"要不要发给用户"是本末倒置；
  //   ② 引擎（`canvas/`，模型 1.8GB）不随包分发，装上也只能看到"请指定引擎目录"的引导页；
  //   ③ 它本来就是插件 —— 插件可装可卸，没必要绑进版本。
  //
  // **怎么开**：把下面这两行取消注释，同时在 `scripts/build-bundled-plugins.js` 里
  // 把对应的拷贝步骤也取消注释 —— **两处必须同进同出**，否则就掉进 §十四 那个
  // "声明了但载荷里没有"的坑（`ensureBundledPlugins` 会静默跳过）。
  // 本机不受影响：开发机是手动装进 profile 的，不经过这张清单。
  // { name: '@deepwhale-cn/dsh-shell-canvas', dir: 'dsh-shell-canvas' },

  // ⌘R「重新加载界面」（2026-10-07）：应用菜单里没有 reload 角色 → Cmd+R 从来没绑上，
  // 「改完插件让用户刷新一下」变成一句空话。本插件用 DSH 的快捷键服务把这一键补回来。
  // 零界面、零依赖，解决的是"用户界面出问题时没有自救入口"，该随包发。
  { name: '@deepwhale-cn/dsh-shell-reload', dir: 'dsh-shell-reload' },
  // ⛔ 品牌标记（空白会话顶部的青色大肥鱼）—— **不进包**（2026-10-08 用户决定）。
  //
  // 用户原话：「不要换新会话的大肥鱼头像，还是用官方原生的」。
  // 即：空白会话顶部那个品牌标记**保留 DSH 官方原样**，不换成我们的大肥鱼。
  //
  // ⚠️ 别和 `sidebar.brand.mark`（侧栏左上那个 deepseek 鲸标）搞混：
  //    那个**任何时候都不要碰**，本插件也从来没占过它。
  //
  // 源码保留在 `shell-plugins/dsh-shell-brand-mark/`（1.0.48~1.0.53 期间丢过一次，
  // 现在源码已入库），谁想要谁自己装。
  // 要重新进包：把下面这行取消注释，**并同时**打开 `scripts/build-bundled-plugins.js`
  // 里对应的拷贝步骤 —— 两处必须同进同出（否则掉进"声明了但载荷里没有"的坑）。
  // { name: '@deepwhale-cn/dsh-shell-brand-mark', dir: 'dsh-shell-brand-mark' },
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

  const profileDir = profileDirOf(home);
  // 与 legal-mode / office 同一套时序约定：目录先于文件落盘，文件还没就位要算
  // pending，否则会静默放弃写入（详见 legal-mode.ts 里同处的说明）。
  const profilePending =
    !fs.existsSync(profileDir) ||
    !fs.existsSync(path.join(profileDir, 'package.json'));
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
