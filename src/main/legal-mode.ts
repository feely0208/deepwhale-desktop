import * as fs from 'fs';
import * as path from 'path';

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
  return isPackaged ? path.join(resourcesPath, 'legal-mode') : path.join(appPath, 'legal-mode');
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

/** 随包运行时入口的相对路径（相对 dsh 包目录）。 */
const RUNTIME_PERSONA_ENTRY = ['node_modules', '@deepseek-ai', 'dsh-persona', 'lib', 'index.js'];
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
  const profileDir = path.join(home, 'profiles', 'web');
  const profilePending = !fs.existsSync(profileDir);
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
