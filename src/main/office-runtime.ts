import { app } from 'electron';
import { writeFileAtomic } from './patch-heal';
import * as fs from 'fs';
import { profileDirOf } from './profile';
import { removeOurInsertBlocks } from './legal-mode';
import * as path from 'path';
import { DEV_REPO_ROOT } from './dsh-runtime';

/**
 * office 能力注入：官方 office 三件套 + 随包 Python / LibreOffice 载荷。
 *
 * **纯增量**：只往 profile patch 追加自己的 `- insert:` 行，不读改法律模式的任何行。
 * 注入物（幂等，可重复调用）：
 * - `<home>/profiles/web/cordis.patch.yml` 追加 office 两行
 * - `<payload>/bin/node[.cmd]` —— 用 Electron 充当 Node 的包装脚本（见 ensureWrapperNode）
 *
 * profile 目录由 DSH 首次启动创建，因此首次调用返回 `profilePending`，
 * 调用方在 DSH 就绪后再调一次即可（与 legal-mode 同一套时序约定）。
 */

/** office 技能行的行 id —— 用作"是否已注入"的幂等标记。 */
const OFFICE_ROW_ID = 'skill-office';

/** 依赖行 id。 */
const DEPS_ROW_ID = 'tool-workspace-dependencies';

/** 注入结果。 */
export interface OfficeSetupResult {
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

/** 写文件（内容一致则跳过，返回是否真的写了）。 */
function writeIfChanged(file: string, next: string): boolean {
  if (readText(file) === next) return false;
  // 原子写：Windows 自动更新会中途杀进程，直接 writeFileSync 可能留下半截文件（空字节），
  // 之后 DSH 解析 patch 会直接失败（2026-10-04 用户事故）。见 patch-heal.ts。
  writeFileAtomic(file, next);
  return true;
}

/**
 * office 载荷目录：打包后在 `Resources/office-runtime`，开发态在仓库根 `office-runtime`。
 *
 * 与 legal-mode 同理，开发态不能用 `app.getAppPath()`（它是入口脚本所在目录），
 * 所以按存在性依次探测。
 */
export function officePayloadDir(
  isPackaged: boolean,
  appPath: string,
  resourcesPath: string,
): string {
  if (isPackaged) return path.join(resourcesPath, 'office-runtime');
  for (const root of [appPath, DEV_REPO_ROOT, process.cwd()]) {
    const candidate = path.join(root, 'office-runtime');
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // 目录不可读：继续下一个候选
    }
  }
  return path.join(appPath, 'office-runtime');
}

/**
 * 生成"用 Electron 充当 Node"的包装脚本，并返回它的绝对路径。
 *
 * 为什么需要：`@deepseek-ai/dsh-skill-office` 在 Electron 下要求 `node` 是
 * **独立的 Node 可执行文件**（`packaged applications must supply a standalone Node`）。
 * 官方为此随包了一份完整 Node（约 50–90MB）。而插件的校验只有两条 ——
 * **绝对路径**且**是文件**（不看扩展名、不查可执行位），因此可以用一个指向
 * Electron 的包装脚本顶替：Electron 以 `ELECTRON_RUN_AS_NODE=1` 运行时就是 Node。
 *
 * 实测该包装可正常执行 LibreOffice Kit CLI（`capabilities --json` 返回完整能力清单）。
 *
 * @param payloadDir - office 载荷目录。
 * @param electronPath - 当前 Electron 可执行文件的绝对路径（`process.execPath`）。
 * @returns 包装脚本的绝对路径，以及本次是否真的写了盘。
 */
export function ensureWrapperNode(
  outDir: string,
  electronPath: string,
): { file: string; changed: boolean } {
  const windows = process.platform === 'win32';
  // ⚠️ outDir 必须是【可写目录】，不能是 App 包内的载荷目录。
  //
  // 原来这里传的是 payloadDir（`<App>/Contents/Resources/office-runtime`），
  // 于是壳会**往自己的 App 包里写文件**。这在只读位置必然失败：
  //   · 直接运行挂载好的 dmg —— 挂载点是只读的
  //   · macOS 的 App Translocation（Gatekeeper 路径随机化）—— 从 dmg / 下载目录
  //     直接双击运行时，系统把 App 复制到一个**随机的只读目录**再运行
  // 实测报错：ENOENT: mkdir '.../Resources/office-runtime/bin'，整个 office 注入被跳过，
  // 用户表现为「office 功能装不上」（2026-09-27）。
  //
  // 更根本的问题是设计：**程序不该修改自己的安装目录**。App 包是程序文件，
  // 运行时产物属于用户数据，应当写到 `<home>/office-runtime/`（调用方保证可写）。
  const file = path.join(outDir, 'bin', windows ? 'node.cmd' : 'node');
  // 路径可能含空格（macOS 的 .app 就是），必须整体加引号。
  const body = windows
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronPath}" %*\r\n`
    : `#!/bin/sh\n# 由深鲸桌面生成：用自带 Electron 充当 Node，避免再随包一份完整 Node。\nELECTRON_RUN_AS_NODE=1 exec "${electronPath}" "$@"\n`;
  const changed = writeIfChanged(file, body);
  if (!windows) {
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      // 某些文件系统不支持改权限位：忽略，node 只要求"是文件"
    }
  }
  return { file, changed };
}

/**
 * 在【office 行块的范围里】把 node / cli / source 三个路径对齐到当前值。
 *
 * 纯函数、只做文本处理 —— 方便离线守卫直接测（见 scripts/test-office-row-heal.js）。
 *
 * 为什么要**三个都对齐**（2026-10-14 用户事故）：
 *   Windows 升级用户报 `skill-office: Error: Invalid package …\resources\app.asar`
 *   + `1 entry did not activate` → Word/Excel/PPT 三个技能**静默失效**。
 *   根因：`cli:` 是 asar 时代（1.0.49 之前）写下的安装目录绝对路径；之后打进包的方式改成
 *   `asar: false`，那个 app.asar 不复存在，而 Electron 的 fs 对含 app.asar 的路径直接抛
 *   「Invalid package <归档根>」。旧代码**只在 `node:` 变化时才重写**，`cli:` 永远留着 →
 *   老用户升级多少次都修不好。
 *
 * 范围限定：只在「出现 OFFICE_ROW_ID 的那一行」到「下一个顶层 `- ` 行」之间替换，
 * 不能拿整份文件做 `^(\s*)cli:` —— 别人的块里也有同名 key。
 */
export function syncOfficeRowPaths(
  text: string,
  paths: { node: string; cli: string; source: string },
): string {
  const lines = text.split('\n');
  const idIdx = lines.findIndex((l) => l.includes(OFFICE_ROW_ID));
  if (idIdx < 0) return text;

  let start = idIdx;
  while (start > 0 && !/^-\s/.test(lines[start])) start -= 1; // 回退到本块顶层的 `- insert:`
  let end = lines.length;
  for (let i = idIdx + 1; i < lines.length; i += 1) {
    if (/^-\s/.test(lines[i])) { end = i; break; }             // 下一个顶层块
  }

  const block = lines.slice(start, end).join('\n');
  const setKey = (body: string, key: string, value: string): string => {
    const quoted = JSON.stringify(value);
    const re = new RegExp(`^(\\s*)${key}:(.*)$`, 'm');
    if (re.test(body)) return body.replace(re, `$1${key}: ${quoted}`);
    // 老格式里缺这个 key（理论上不会，但缺了就得补上 —— 否则这个能力仍然指向不存在的东西）
    const configRe = /^(\s*)config:\s*$/m;
    if (configRe.test(body)) return body.replace(configRe, `$1config:\n$1  ${key}: ${quoted}`);
    return body;
  };

  const next =
    setKey(setKey(setKey(block, 'node', paths.node), 'cli', paths.cli), 'source', paths.source);
  if (next === block) return text; // 无需改动
  return [...lines.slice(0, start), ...next.split('\n'), ...lines.slice(end)].join('\n');
}

/**
 * 往 home 级 patch 写/修 office 两行（幂等，且会**自愈旧值**）。
 *
 * 与 legal-mode 一样自带一个独立的 `- insert:` 块，两者互不干扰。
 * 路径统一用 JSON 引号包裹 —— 既合法 YAML，又能容纳空格与反斜杠。
 */
function ensureOfficePatchRows(
  file: string,
  nodePath: string,
  cliPath: string,
  payloadDir: string,
): boolean {
  // 文件不存在时按空文件处理并创建 —— home 级 patch 是壳自己创建的，
  // 不存在是常态（详见 legal-mode.ts 里同处说明）。
  const current = readText(file) ?? '';
  if (current.includes(OFFICE_ROW_ID)) {
    // 行已存在 → **三个路径都对齐到当前值**（历史教训：只对齐 node 会让 cli 里的
    // asar 旧路径永远留着，office 技能对升级用户一直是哑的）。
    const next = syncOfficeRowPaths(current, { node: nodePath, cli: cliPath, source: payloadDir });
    return writeIfChanged(file, next);
  }

  const block = [
    '',
    '# ── office 能力：文档生成（Word / Excel / PPT）+ 内置 LibreOffice 渲染 PDF ──',
    '- insert:',
    `    - id: ${OFFICE_ROW_ID}`,
    "      name: '@deepseek-ai/dsh-skill-office'",
    '      config:',
    `        node: ${JSON.stringify(nodePath)}`,
    `        cli: ${JSON.stringify(cliPath)}`,
    `    - id: ${DEPS_ROW_ID}`,
    "      name: '@deepseek-ai/dsh-tool-workspace-dependencies'",
    '      config:',
    `        source: ${JSON.stringify(payloadDir)}`,
    '',
  ].join('\n');

  return writeIfChanged(file, `${current.replace(/\s*$/, '')}\n${block}`);
}

/**
 * 幂等注入 office 能力。
 *
 * @param home - 本应用专属的 DSH home。
 * @param payloadDir - office 载荷目录（含 `runtime.json` 与 `dependencies/`）。
 * @param runtimeNodeModulesDir - 随包运行时的 `node_modules` 绝对路径
 *   （由 `dshNodeModulesDir(bundledBin)` 得到），用于定位 LibreOffice Kit CLI。
 * @param electronPath - 当前 Electron 可执行文件绝对路径。
 * @returns 是否写盘，以及 profile 是否还没就位。
 */
/**
 * 把 office 转换栈"物化"到**真实目录**（2026-10-04）——修「预览 docx 报
 * "Installed LibreOfficeKit executable is not executable"」。
 *
 * 根因（待办-docx预览修复.md 已查实）：
 *   `libreoffice-kit` 用 `require.resolve('<engine-pkg>/package.json')` 找引擎，
 *   打包后拿到的是 **asar 内部路径**，而 asar 里所有文件是 0644（**没有执行位**），
 *   于是自检 `status.mode & 0o111` 失败 → 打包版必挂、开发态正常。
 *
 * 做法：
 *   1. 把 `libreoffice-kit`（纯 JS，小）连同它的依赖闭包**复制**到
 *      `<home>/office-runtime/kit/node_modules/` —— 真实目录，可执行位不受 asar 影响
 *   2. 平台引擎包（`libreoffice-kit-<platform>-<arch>`，140MB+）用**软链**指向
 *      `app.asar.unpacked/...`（electron-builder 已把它解包，文件带执行位）
 *   3. 配置里的 `cli` 指向这份真实路径
 *   版本变化时整目录重建（避免旧 app 的路径残留）。
 */
function materializeOfficeKit(
  home: string,
  runtimeNodeModulesDir: string,
  appVersion: string,
): string | null {
  const kitRoot = path.join(home, 'office-runtime', 'kit');
  const modulesDir = path.join(kitRoot, 'node_modules');
  const scopedDir = path.join(modulesDir, '@deepseek-ai');
  const marker = path.join(kitRoot, '.version');
  const cliRel = ['@deepseek-ai', 'libreoffice-kit', 'lib', 'cli.js'];

  const srcScope = path.join(runtimeNodeModulesDir, '@deepseek-ai');
  const srcKit = path.join(srcScope, 'libreoffice-kit');
  if (!fs.existsSync(path.join(srcKit, 'lib', 'cli.js'))) return null;

  // 版本变了就重建（否则旧 app 的绝对路径会留在软链里）
  try {
    const stamped = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf-8').trim() : '';
    if (stamped && stamped !== appVersion) {
      fs.rmSync(kitRoot, { recursive: true, force: true });
    }
  } catch {
    /* 读不到标记就当没建过 */
  }

  // 递归复制一个包（含它的 dependencies 闭包）——只复制 JS 包，代价很小
  const copied = new Set<string>();
  const copyPackage = (name: string): void => {
    if (copied.has(name)) return;
    copied.add(name);
    const from = path.join(runtimeNodeModulesDir, name);
    const to = path.join(modulesDir, name);
    if (!fs.existsSync(from)) return;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      copyTree(from, to);
    } catch (e) {
      console.warn('[office] 复制依赖失败:', name, e);
      return;
    }
    // 继续它的 dependencies（跳过 platform/optional，失败就算了）
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(from, 'package.json'), 'utf-8')) as {
        dependencies?: Record<string, string>;
      };
      for (const dep of Object.keys(pkg.dependencies || {})) copyPackage(dep);
    } catch {
      /* 没 package.json 或不是 JSON，忽略 */
    }
  };

  try {
    // 1) JS 包 + 依赖闭包
    copyPackage('@deepseek-ai/libreoffice-kit');
    // 2) 平台引擎包：软链到解包目录（那里才有执行位）
    let engines: string[] = [];
    try {
      engines = fs
        .readdirSync(srcScope)
        .filter((n) => n.startsWith('libreoffice-kit-') && n !== 'libreoffice-kit');
    } catch {
      engines = [];
    }
    for (const engine of engines) {
      const linkPath = path.join(scopedDir, engine);
      const asarPath = path.join(srcScope, engine);
      // asar 内部路径 → 对应的解包真实路径
      const unpacked = asarPath.includes('app.asar' + path.sep)
        ? asarPath.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
        : asarPath;
      const target = fs.existsSync(unpacked) ? unpacked : asarPath;
      try {
        fs.rmSync(linkPath, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        fs.symlinkSync(target, linkPath, 'dir');
      } catch (e) {
        console.warn('[office] 引擎软链失败（退回复制）:', engine, e);
        try {
          // ⚠️ 这里也可能是 asar 源（引擎没解包时）→ 必须走 asar 安全的 copyTree，别用 fs.cpSync
          copyTree(target, linkPath);
        } catch (e2) {
          console.warn('[office] 引擎复制也失败:', engine, e2);
        }
      }
    }
    fs.writeFileSync(marker, appVersion, 'utf-8');
  } catch (e) {
    console.warn('[office] 物化转换栈失败:', e);
    return null;
  }

  // ⚠️ 必须落在 `node_modules/` 下（2026-10-14 修）：copyPackage 把包复制到
  //    `<kit>/node_modules/<包名>`，而这里原来写成 `path.join(kitRoot, ...cliRel)`
  //    —— 少了一层 `node_modules`，于是这个函数**永远返回 null**，物化结果被静默丢弃，
  //    注入的 `cli` 一直是随包运行时里的那份（asar 时代就是 asar 里的路径）。
  //    这正是「Office 三件套对升级用户静默失效」事故链条里被隐藏的一环：
  //    物化明明成功了（kit 目录、.version、cli.js 都在），却从来没被用上。
  const realCli = path.join(modulesDir, ...cliRel);
  return fs.existsSync(realCli) ? realCli : null;
}

/**
 * 递归复制目录，**必须能在 asar 内工作**。
 *
 * 为什么不能用 `fs.cpSync`（2026-10-14 用合成 asar 在 Electron-as-Node 下实测）：
 *   · `fs.statSync` / `fs.readFileSync` / `fs.readdirSync` / 动态 `import()` 读 asar 都正常；
 *   · 但 `fs.cpSync(<asar 内路径> → 真实目录)` 直接抛
 *     `ENOENT, pkg not found in …/app.asar` —— 它内部的路径解析不认 asar。
 *   而 `materializeOfficeKit()` 正是要把 `libreoffice-kit` 及其依赖从随包运行时复制到
 *   `<home>/office-runtime/kit/`（真实目录，Office 预览要用它）。所以运行时改回 asar 打包
 *   之后，这一步只有"readdir + readFile + writeFile"这条自己写的路能走通；
 *   不修的话表现是：物化失败 → office 行不注入 → **Office 三件套静默消失**。
 *
 * 源是真实目录时仍走 cpSync（快，且保留文件模式与软链），只在 asar 源上用自写实现。
 */
export function copyTree(from: string, to: string): void {
  if (!from.includes('app.asar')) {
    fs.cpSync(from, to, { recursive: true, dereference: false, force: true });
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dst = path.join(to, name);
    let isDir = false;
    try {
      isDir = fs.statSync(src).isDirectory();
    } catch {
      continue; // 读不到的条目（asar 里的软链等）直接跳过
    }
    if (isDir) {
      copyTree(src, dst);
      continue;
    }
    try {
      fs.writeFileSync(dst, fs.readFileSync(src));
    } catch (e) {
      // asar 里的 `.bin/*` 软链读不出来是正常的 —— 我们要的是库文件本身
      console.warn('[office] 跳过一个 asar 里读不出来的条目:', src, e);
    }
  }
}

export function ensureOfficeSetup(
  home: string,
  payloadDir: string,
  runtimeNodeModulesDir: string | undefined,
  electronPath: string,
  appVersion?: string,
): OfficeSetupResult {
  // 载荷不完整就整体跳过：宁可没有 office，也不要注入一个指向空目录的行。
  if (!fs.existsSync(path.join(payloadDir, 'runtime.json'))) {
    return { changed: false, profilePending: false };
  }
  if (runtimeNodeModulesDir === undefined) {
    return { changed: false, profilePending: false };
  }
  // 随包运行时里到底有没有这份 kit —— 没有就整体跳过（不写任何行）。
  // 注意：这里只作"能力存在性"的判断，**不拿这个路径去注入**（它是 asar 逻辑路径，
  // 注入进去就是 2026-10-14 那个事故；真正注入的是下面物化到真实目录的那份）。
  const kitCliInRuntime = path.join(
    runtimeNodeModulesDir,
    '@deepseek-ai',
    'libreoffice-kit',
    'lib',
    'cli.js',
  );
  if (!fs.existsSync(kitCliInRuntime)) {
    return { changed: false, profilePending: false };
  }
  // ⚠️ 必须用"物化到真实目录"的那份 cli。
  //    历史坑：asar 里的引擎没有执行位 → 打包版必挂（`Installed LibreOfficeKit
  //    executable is not executable`）；而 asar 时代留下的路径在 `asar: false` 之后
  //    更是**根本不存在**，DSH 侧直接报 `Invalid package <归档根>`、该行激活失败
  //    → 用户的 Word/Excel/PPT 技能静默失效（2026-10-14 Windows 用户日志）。
  //
  //    所以：**物化失败就不写这一行**（宁可干净地少一个能力，也不要往用户配置里写一个
  //    指向不存在文件的绝对路径 —— 那种错最难查，用户看到的只是"Office 用不了"）。
  // ⚠️ 别在这里直接用 `app`：CI 的离线守卫脚本用**纯 node** 跑这个模块，
  //    那里 `import { app } from 'electron'` 拿到的是字符串、没有 getVersion
  //    → 2026-10-04 就是把 1.0.49 的 CI 打挂在这个 TypeError 上。
  const version =
    appVersion ?? (typeof app?.getVersion === 'function' ? app.getVersion() : 'dev');
  const materialized = materializeOfficeKit(home, runtimeNodeModulesDir, version);
  if (materialized === null) {
    console.warn(
      '[office] 转换栈物化失败（libreoffice-kit 没能落到真实目录）—— 本次不写 office 行，' +
        '避免注入一条指向 asar/不存在文件的路径；下次启动会自动重试',
    );
    return { changed: false, profilePending: false };
  }
  const cliPath = materialized;

  let changed = false;
  // 包装脚本写到【用户数据目录】，不写 App 包内（理由见 ensureWrapperNode 注释）
  const wrapperDir = path.join(home, 'office-runtime');
  let wrapper: { file: string; changed: boolean };
  try {
    wrapper = ensureWrapperNode(wrapperDir, electronPath);
  } catch (error) {
    // home 也不可写就只能放弃（极端情况），但不能让整个启动失败
    console.error('[office] 包装脚本写入失败:', error);
    return { changed: false, profilePending: false };
  }
  changed = wrapper.changed || changed;

  // ── 写盘之前，把三个要注入的绝对路径逐个验一遍（存在性）──
  // 为什么值得多这一步：DSH 侧的失败形态是「1 entry did not activate」这种**软警告**，
  // 用户只看到"Office 用不了"，看不出是路径问题；而且会被记进我们要用户反馈的故障日志里。
  // 与其注入一条指向不存在文件的路径，不如这次不注入、下次再试。
  for (const [label, p] of [
    ['node', wrapper.file],
    ['cli', cliPath],
    ['source', payloadDir],
  ] as Array<[string, string]>) {
    if (!fs.existsSync(p)) {
      console.warn(`[office] 注入路径不存在（${label}: ${p}）—— 本次不写 office 行`);
      return { changed, profilePending: false };
    }
  }

  // 【home 级】patch —— 与 legal-mode 同理：`<home>` 是壳自己建的，可以在拉起 DSH
  // **之前**写好；而 `<home>/profiles/web/` 是 DSH 首次启动才建的，写在那儿必然太晚。
  // DSH 的插件清单在服务启动那一刻定型，事后重载页面也不变（实测），
  // 所以 office 两行也必须落在 home 级，首次启动才装得上。
  changed = ensureOfficePatchRows(
    path.join(home, 'cordis.patch.yml'),
    wrapper.file,
    cliPath,
    payloadDir,
  ) || changed;

  // profile 级：**不再插行，改把我们以前插的删掉**（2026-10-01 去重复）。
  // 理由同 legal-mode：profile 级 patch 归 DSH 自己重写，我们的行留在那里会让
  // skill-office / tool-workspace-dependencies 这两个 id 被声明两次。
  const profileDir = profileDirOf(home);
  const profilePending =
    !fs.existsSync(profileDir) ||
    !fs.existsSync(path.join(profileDir, 'cordis.patch.yml'));
  if (!profilePending) {
    changed =
      removeOurInsertBlocks(path.join(profileDir, 'cordis.patch.yml'), [
        OFFICE_ROW_ID,
        DEPS_ROW_ID,
      ]) || changed;
  }

  return { changed, profilePending };
}
