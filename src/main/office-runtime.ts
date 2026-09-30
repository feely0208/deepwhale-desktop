import * as fs from 'fs';
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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
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
 * 往 profile patch 追加 office 两行（幂等）。
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
    // 行已存在 —— 但 `node:` 可能指向**旧位置**：老版本把包装脚本写在 App 包内
    // （`<App>/Contents/Resources/office-runtime/bin/node`），而只读位置下那个文件
    // 根本写不出来。路径变了就原地替换，否则老用户会一直踩这个坑。
    const m = current.match(/^(\s*node:\s*)"([^"]*)"/m);
    if (m && m[2] !== nodePath) {
      const next = current.replace(/^(\s*node:\s*)"[^"]*"/m, `$1${JSON.stringify(nodePath)}`);
      return writeIfChanged(file, next);
    }
    return false;
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
export function ensureOfficeSetup(
  home: string,
  payloadDir: string,
  runtimeNodeModulesDir: string | undefined,
  electronPath: string,
): OfficeSetupResult {
  // 载荷不完整就整体跳过：宁可没有 office，也不要注入一个指向空目录的行。
  if (!fs.existsSync(path.join(payloadDir, 'runtime.json'))) {
    return { changed: false, profilePending: false };
  }
  if (runtimeNodeModulesDir === undefined) {
    return { changed: false, profilePending: false };
  }
  const cliPath = path.join(
    runtimeNodeModulesDir,
    '@deepseek-ai',
    'libreoffice-kit',
    'lib',
    'cli.js',
  );
  if (!fs.existsSync(cliPath)) {
    return { changed: false, profilePending: false };
  }

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

  // profile 级：保留原有注入，兼容只读 profile 级 patch 的 DSH 版本与既有用户。
  // ⚠️ 与 home 级重复是安全的（实测只挂载一次）。
  const profileDir = path.join(home, 'profiles', 'web');
  const profilePending =
    !fs.existsSync(profileDir) ||
    !fs.existsSync(path.join(profileDir, 'cordis.patch.yml'));
  if (!profilePending) {
    changed = ensureOfficePatchRows(
      path.join(profileDir, 'cordis.patch.yml'),
      wrapper.file,
      cliPath,
      payloadDir,
    ) || changed;
  }

  return { changed, profilePending };
}
