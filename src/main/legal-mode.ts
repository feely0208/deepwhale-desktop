import * as fs from 'fs';
import * as path from 'path';
import { DEV_REPO_ROOT } from './dsh-runtime';

/** 插件包名（行 id 与此不同，行 id 是 `ui-legal-mode`）。 */
const PLUGIN_NAME = '@deepseek-ai/dsh-client-ui-legal-mode';
/** loader 行 id：注入到 profile patch 里的条目 id。 */
const PLUGIN_ROW_ID = 'ui-legal-mode';
/** 预设 id：DSH 侧 `agentPresets` 用它判定"是否法律模式"，必须与插件约定一致。 */
const PRESET_ID = 'legal-mode';

/** 注入结果。 */
export interface LegalModeSetupResult {
  /** 本次是否写盘（首次启动或载荷更新时为 true）。 */
  changed: boolean;
  /**
   * profile 目录尚未由 DSH 创建（首次启动）：本轮注入只能落下插件与预设，
   * 调用方需在 DSH 就绪后再跑一次，并让窗口重载以拿到新的客户端入口图。
   */
  profilePending: boolean;
}

/** 本应用专属的 DSH home（与用户自己的 ~/.dsh 隔离，互不影响）。 */
export function legalModeHome(userDataDir: string): string {
  return path.join(userDataDir, 'dsh-home');
}

/** 随包载荷目录：打包后在 `Resources/legal-mode`，开发态在仓库根 `legal-mode`。 */
export function legalModePayloadDir(isPackaged: boolean, appPath: string, resourcesPath: string): string {
  if (isPackaged) return path.join(resourcesPath, 'legal-mode');
  // 开发态：app.getAppPath() 在 `electron dist/main/index.js` 下是入口脚本所在目录，
  // 不是仓库根（见 dsh-runtime.ts 的 DEV_REPO_ROOT 说明），所以按存在性依次探测。
  for (const root of [appPath, DEV_REPO_ROOT, process.cwd()]) {
    const candidate = path.join(root, 'legal-mode');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 目录不可读：继续下一个候选
    }
  }
  return path.join(appPath, 'legal-mode');
}

/** 迁移标记文件：存在即表示已迁移过，避免重复搬运。 */
const MIGRATION_MARKER = '.migrated-from-legacy-home';
/** 迁移时要从旧 home 带过来的条目（不含 profiles：它由 DSH 按当前版本重建）。 */
const MIGRATED_ENTRIES = [
  'sessions',
  'storages',
  'attachments',
  'llm-deepseek',
  '.agent-presets',
  'settings.yaml',
  '.credentials.yaml',
  '.anonymous-user-id',
];

/** 会话目录里是否有真实会话（递归一层，DSH 按 workspace 分目录存放）。 */
function hasSessions(home: string): boolean {
  const sessions = path.join(home, 'sessions');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(sessions, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      if (fs.readdirSync(path.join(sessions, entry.name)).length > 0) return true;
    } catch {
      // 子目录不可读：跳过，继续看下一个
    }
  }
  return false;
}

/** 判断一个 home 是否已有用户数据（以会话为准）。 */
function homeHasUserData(home: string): boolean {
  return hasSessions(home);
}

/**
 * 把旧 home 的会话目录合并进目标 home。
 *
 * 不能像其他条目那样"目标已存在就跳过"：DSH 首次启动会先把 `sessions/` 建出来（空目录），
 * 若按目录粒度跳过，历史会话会全部漏掉。这里按 workspace 子目录合并：
 * 目标已有同名 workspace 就保留目标自己的，只补目标缺的。
 *
 * @param from - 旧 home 的 sessions 目录。
 * @param to - 目标 home 的 sessions 目录。
 * @returns 是否写入了任何内容。
 */
function mergeSessionsDir(from: string, to: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(from, { withFileTypes: true });
  } catch {
    return false;
  }
  let merged = false;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    try {
      // 目标已有同名 workspace：保留目标自己的，不合并内部文件（避免半覆盖出乱状态）
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(to, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
      merged = true;
    } catch (error) {
      console.error(`[legal-mode] 迁移会话 ${entry.name} 失败（跳过）:`, error);
    }
  }
  return merged;
}

/**
 * 一次性把旧的外部 DSH home 搬进本应用的 userData home。
 *
 * 背景：早期版本的壳把 DSH_HOME 指向 `~/.deepwhale-legal/dsh-home`（由
 * settings.json 的 command 脚本自己设置）；v1.0.13 起改用随包运行时后，壳一律用
 * `<userData>/dsh-home`。如果不迁移，老用户升级后会看到**全新空白 workspace**，
 * 会话全部"消失"（数据其实还在旧目录里）。
 *
 * 判据只看**会话**：目标 home 里没有任何会话、且旧 home 确实有会话时，才搬一次并落标记。
 * 之所以不以"整个 home 为空"为判据，是因为 DSH 首次启动可能已经在目标 home 里写了
 * 凭据/设置，那样会导致明明有历史会话却不迁移。
 *
 * 已存在的条目一律不覆盖（尤其凭据：目标已有就保留目标自己的）。
 * 搬运是复制而非移动，旧目录原样保留，出错也不至于丢数据。
 *
 * @param home - 目标 home（本应用 userData 下的 dsh-home）。
 * @param legacyHomes - 候选旧 home，按优先级排列。
 * @returns 是否执行了迁移。
 */
export function migrateLegacyHomeOnce(home: string, legacyHomes: string[]): boolean {
  if (fs.existsSync(path.join(home, MIGRATION_MARKER))) return false;
  if (hasSessions(home)) return false;
  const source = legacyHomes.find((dir) => dir !== home && hasSessions(dir));
  if (!source) return false;

  fs.mkdirSync(home, { recursive: true });
  let copied = 0;
  // 会话单独走合并逻辑（见 mergeSessionsDir）：DSH 会先把 sessions/ 建成空目录，
  // 按目录粒度"已存在就跳过"会把历史会话全漏掉。
  if (mergeSessionsDir(path.join(source, 'sessions'), path.join(home, 'sessions'))) {
    copied += 1;
  }
  for (const name of MIGRATED_ENTRIES) {
    if (name === 'sessions') continue;
    const from = path.join(source, name);
    const to = path.join(home, name);
    try {
      if (!fs.existsSync(from) || fs.existsSync(to)) continue;
      fs.cpSync(from, to, { recursive: true });
      copied += 1;
    } catch (error) {
      console.error(`[legal-mode] 迁移 ${name} 失败（跳过该项）:`, error);
    }
  }
  try {
    fs.writeFileSync(path.join(home, MIGRATION_MARKER), `migrated from ${source}\n`);
  } catch (error) {
    console.error('[legal-mode] 写迁移标记失败:', error);
  }
  console.log(`[legal-mode] 已从旧 home 迁移 ${copied} 项数据: ${source} -> ${home}`);
  return true;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function sameFile(left: string, right: string): boolean {
  try {
    return fs.readFileSync(left).equals(fs.readFileSync(right));
  } catch {
    return false;
  }
}

/** 需要时复制文件/目录，内容一致则不动（幂等，避免每次启动都写盘）。 */
function copyIfChanged(src: string, dest: string): boolean {
  if (fs.existsSync(dest) && sameFile(src, dest)) return false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return true;
}

/** 递归复制目录（载荷很小，直接整目录比对）。 */
function copyTreeIfChanged(srcDir: string, destDir: string): boolean {
  if (!fs.existsSync(srcDir)) return false;
  let changed = false;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) changed = copyTreeIfChanged(src, dest) || changed;
    else if (entry.isFile()) changed = copyIfChanged(src, dest) || changed;
  }
  return changed;
}

/**
 * 让 profile 的 patch 层包含本插件的 loader 行。
 *
 * 文件是 `$DSH_HOME/profiles/web/cordis.patch.yml`：DSH 生成的是注释 + `[]`，
 * 用户也可能自己写过条目。只做两件事：已含本行则原样返回；否则在保留原有内容
 * （含注释）的前提下追加一个 `- insert:` 块。
 */
function ensurePatchRow(file: string): boolean {
  const current = readText(file);
  if (current === null) return false;
  if (current.includes(PLUGIN_ROW_ID)) return false;

  const block = [
    '- insert:',
    `    - id: ${PLUGIN_ROW_ID}`,
    `      name: '${PLUGIN_NAME}'`,
    '',
  ].join('\n');

  // 只看有效内容（去掉注释与空行）判断是否为"空数组"。
  const effective = current
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    .join('\n')
    .trim();
  const comments = current
    .split('\n')
    .filter((line) => line.trim().startsWith('#'))
    .join('\n');

  const next = effective === '' || effective === '[]'
    ? `${comments === '' ? '' : `${comments}\n`}${block}`
    : `${current.replace(/\s*$/, '')}\n\n${block}`;
  fs.writeFileSync(file, next);
  return true;
}

/** 在 profile 的 package.json 里声明本地依赖（DSH 借此把插件纳入 profile 依赖图）。 */
function ensureProfileDependency(file: string, pluginDir: string): boolean {
  const current = readText(file);
  if (current === null) return false;
  let manifest: { dependencies?: Record<string, string> };
  try {
    manifest = JSON.parse(current) as { dependencies?: Record<string, string> };
  } catch {
    return false;
  }
  const wanted = `link:${pluginDir}`;
  const dependencies = manifest.dependencies ?? {};
  if (dependencies[PLUGIN_NAME] === wanted) return false;
  manifest.dependencies = { ...dependencies, [PLUGIN_NAME]: wanted };
  fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return true;
}

/**
 * 建立指向插件目录的模块解析入口（与 `dsh plugin add` 产生的形态一致）。
 *
 * 必须是**目录级**入口：POSIX 用 `dir` 符号链接，Windows 用 junction（目录联接，
 * 普通用户即可创建 —— Windows 上创建符号链接需要管理员或开发者模式）。两者都
 * 失败时退化为直接复制目录：模块解析只需要那个目录存在。
 */
function ensurePluginEntry(entryPath: string, pluginDir: string): boolean {
  // 已是指向同一目标的链接 → 幂等返回
  try {
    if (fs.readlinkSync(entryPath) === pluginDir) return false;
  } catch {
    // 不是符号链接（可能是上一次的拷贝，或尚不存在）
  }
  if (fs.existsSync(entryPath)) {
    // 拷贝形态：客户端 bundle 一致就复用（避免每次启动重写）
    try {
      const existing = fs.readFileSync(path.join(entryPath, 'lib', 'client.js'));
      const wanted = fs.readFileSync(path.join(pluginDir, 'lib', 'client.js'));
      if (existing.equals(wanted)) return false;
    } catch {
      // 读不到 → 下面重建
    }
    fs.rmSync(entryPath, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  try {
    fs.symlinkSync(pluginDir, entryPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    fs.cpSync(pluginDir, entryPath, { recursive: true });
  }
  return true;
}

/**
 * 随包运行时里 persona 包的相对路径 —— **相对 `node_modules` 目录**
 * （即 `dshNodeModulesDir()` 的返回值），不是相对 dsh 包目录。
 *
 * ⚠️ 这里曾多写一层 `node_modules`，拼出
 * `<node_modules>/node_modules/@deepseek-ai/dsh-persona/...` 这种永不存在的路径，
 * 于是 `personaNeedsPrefix` 读不到源码、返回 null、预设原样保留 `text:`；
 * 而 0.1.5 起 persona 要求 `prefix:` —— 预设会 fail-loud 挂载失败，
 * 表现就是「选了法律模式但律师端弹不出来」。
 */
const RUNTIME_PERSONA_ENTRY = ['@deepseek-ai', 'dsh-persona', 'lib', 'index.js'];
/** 用户自备 DSH 的解析根（相对 DSH_HOME，DSH 会在此解析 profile 依赖）。 */
const HOME_PERSONA_ENTRIES = [
  ['profiles', 'node_modules', '@deepseek-ai', 'dsh-persona', 'lib', 'index.js'],
  ['node_modules', '@deepseek-ai', 'dsh-persona', 'lib', 'index.js'],
];

/**
 * 目标 DSH 的 persona 配置要 `text` 还是 `prefix`。
 *
 * 两代 DSH 的 `@deepseek-ai/dsh-persona` Config 不兼容：
 * - 0.1.2 一带：`{ text: 必填, complete, includeRuntimeContext }`
 * - 0.1.5 一带：`{ prefix: 必填, suffix, complete, includeRuntimeContext }`
 *
 * 随包预设只能写一种，写错的那一代会 fail-loud（`S.prefix missing required value`），
 * 整个法律模式预设挂载失败。所以注入前按目标运行时的实际源码判定并改写。
 *
 * @param candidates - 可能的 persona 源码文件路径，按优先级排列。
 * @returns 需要写成 `prefix` 时返回 true；读不到任何线索时返回 null（保持原样）。
 */
function personaNeedsPrefix(candidates: string[]): boolean | null {
  for (const file of candidates) {
    const source = readText(file);
    if (source === null) continue;
    // 新版把 text 拆成 prefix/suffix；以 prefix 是否为必填字段为准。
    if (/prefix:\s*z\.string\(\)\s*\.required\(\)/.test(source)) return true;
    if (/text:\s*z\.string\(\)\s*\.required\(\)/.test(source)) return false;
  }
  return null;
}

/**
 * 按目标运行时改写预设里的 persona 字段名（`text` ⇄ `prefix`）。
 *
 * 只动 persona 那一行 `config:` 下的单个键，其余内容逐字保留。
 * 无法判定目标版本时原样返回，不猜。
 */
function adaptPresetToRuntime(content: string, needsPrefix: boolean | null): string {
  if (needsPrefix === null) return content;
  const lines = content.split('\n');
  const personaAt = lines.findIndex((line) => /^- id:\s*persona\s*$/.test(line));
  if (personaAt < 0) return content;
  for (let i = personaAt + 1; i < lines.length && i < personaAt + 6; i += 1) {
    const from = needsPrefix ? '    text:' : '    prefix:';
    const to = needsPrefix ? '    prefix:' : '    text:';
    if (lines[i].startsWith(from)) {
      lines[i] = to + lines[i].slice(from.length);
      return lines.join('\n');
    }
  }
  return content;
}

/**
 * 幂等注入法律模式载荷。
 *
 * 注入物（共约 130KB，随 app 的 Resources 分发）：
 * - `<home>/plugins/dsh-client-ui-legal-mode/` 插件包本体（含 lib/client.js 客户端半边）
 * - `<home>/profiles/web/node_modules/<name>` 指向上面的软链（profile 的解析点）
 * - `<home>/profiles/web/package.json` 声明 `link:` 依赖
 * - `<home>/profiles/web/cordis.patch.yml` 插入 `ui-legal-mode` 行
 * - `<home>/.agent-presets/legal-mode/` 出厂预设（DSH 花名册据此提供「法律模式」）
 *
 * profile 目录由 DSH 首次启动创建，因此首次调用会返回 `profilePending`：
 * 调用方在 DSH 就绪后再调用一次即可补齐，并让窗口重载。
 *
 * @param home - 本应用专属的 DSH home。
 * @param payloadDir - 随包载荷目录（内含 `plugin/` 与 `preset/`）。
 * @param runtimeDshDir - 实际要拉起的 dsh 包目录（随包运行时或用户自备的），
 *   用于判定 persona 字段名；省略时按随包运行时之外保守处理。
 * @returns 是否写盘，以及 profile 是否还没就位。
 */
export function ensureLegalModeSetup(
  home: string,
  payloadDir: string,
  runtimeDshDir?: string,
): LegalModeSetupResult {
  const pluginSrc = path.join(payloadDir, 'plugin');
  const presetSrc = path.join(payloadDir, 'preset');
  if (!fs.existsSync(pluginSrc) || !fs.existsSync(presetSrc)) {
    return { changed: false, profilePending: false };
  }

  fs.mkdirSync(home, { recursive: true });
  let changed = false;

  // 1. 插件本体与预设
  const pluginDir = path.join(home, 'plugins', 'dsh-client-ui-legal-mode');
  changed = copyTreeIfChanged(pluginSrc, pluginDir) || changed;

  // 预设里的 persona 字段名要跟随目标运行时的版本（见 personaNeedsPrefix）。
  // 候选顺序即优先级，**必须让实际要拉起的运行时排在最前**：
  // home 下可能留着上一次用别的 DSH 版本解析出的旧副本，若让它抢先，
  // 判定出来的字段名会和真正运行的运行时不符（正是本次踩的坑）。
  const personaCandidates = [
    ...(runtimeDshDir ? [path.join(runtimeDshDir, ...RUNTIME_PERSONA_ENTRY)] : []),
    ...HOME_PERSONA_ENTRIES.map((parts) => path.join(home, ...parts)),
  ];
  const needsPrefix = personaNeedsPrefix(personaCandidates);

  for (const name of ['preset.yml', 'agent.cordis.yml']) {
    const sourceText = readText(path.join(presetSrc, name));
    const dest = path.join(home, '.agent-presets', PRESET_ID, name);
    if (sourceText === null) continue;
    const next = name === 'agent.cordis.yml'
      ? adaptPresetToRuntime(sourceText, needsPrefix)
      : sourceText;
    let current: string | null = null;
    try {
      current = fs.readFileSync(dest, 'utf8');
    } catch {
      current = null;
    }
    if (current === next) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, next);
    changed = true;
  }

  // 2. profile 侧：DSH 首次启动后才会创建 profiles/web
  //
  // ⚠️ 目录**先于文件**落盘：DSH 把 profiles/web 建出来后，cordis.patch.yml 与
  // package.json 还要过一会儿才写。早先这里只在"目录不存在"时算 pending，于是
  // 文件那一瞬间不在，下面就静默 `return false` 放弃写入 —— 注入丢失，用户首次
  // 启动选「法律模式」弹不出，重启一次才好。实测同一个包两次全新启动：
  // 一次 3/3 注入成功，一次 0/3。所以把"要写的文件还没就位"也算作 pending，
  // 交给调用方重试。
  const profileDir = path.join(home, 'profiles', 'web');
  const profilePending =
    !fs.existsSync(profileDir) ||
    !fs.existsSync(path.join(profileDir, 'package.json')) ||
    !fs.existsSync(path.join(profileDir, 'cordis.patch.yml'));
  if (!profilePending) {
    changed = ensurePluginEntry(
      path.join(profileDir, 'node_modules', ...PLUGIN_NAME.split('/')),
      pluginDir,
    ) || changed;
    changed = ensureProfileDependency(path.join(profileDir, 'package.json'), pluginDir) || changed;
    changed = ensurePatchRow(path.join(profileDir, 'cordis.patch.yml')) || changed;
  }

  return { changed, profilePending };
}
