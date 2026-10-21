/**
 * 插件安装工具链（pnpm / node）—— 让 GUI 的插件管理器找得到 pnpm。
 *
 * ── 为什么需要它（2026-10-20 用户现场）──────────────────────────────
 * 插件市场 / 「添加插件」弹窗是在 **DSH 运行时进程** 里执行 `pnpm view`、`pnpm add` 的。
 * 而桌面端从 Finder 启动时，macOS 给进程的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin` ——
 * 既没有 pnpm，也没有 node。结果用户点「安装」直接报：
 *
 *     ｜ 无法获取插件信息：Command failed with ENOENT: pnpm view '…' spawn pnpm ENOENT
 *
 * 这不是某个插件的毛病，是**所有插件都装不了**。而且用户机器上哪怕自己装过 pnpm
 * 也未必在那个极简 PATH 里 —— 所以不能只靠"探测系统 pnpm"。
 *
 * ── 做法 ────────────────────────────────────────────────────────────
 * 1. **随包 pnpm**：`node_modules/pnpm/pnpm` 是原生可执行文件（42MB），
 *    物化到 `<DSH_HOME>/runtime-bin/`（用户可写目录，带执行位）。
 *    为什么不直接 exec asar.unpacked 里的那份：asar 里的文件 `stat` 一律 0644，
 *    没有执行位（LibreOffice kit 在 2026-10-15 就是这么栽的，P0-0 事故）。
 * 2. **node 包装脚本**：pacakge 生命周期脚本、部分插件安装步骤会调 `node`；
 *    用「Electron 充当 Node」的包装顶替（与 office-runtime 的 `bin/node` 同一模式）。
 * 3. **PATH 注入**：拉起 DSH 运行时之前，把 runtime-bin 与常见 bin 目录塞到
 *    env.PATH 最前面。系统里已有的 node/pnpm 也认，随包的那份永远优先。
 *
 * 这个模块刻意不 import electron —— 方便离线单测直接 require（见 scripts/test-plugin-toolchain.js）。
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface ToolchainPaths {
  /** 用户可写的工具链目录（`<DSH_HOME>/runtime-bin/bin`） */
  binDir: string;
  /** 随包 pnpm 是否物化成功 */
  pnpm: 'bundled' | 'missing';
  /** 随包 pnpm 的版本（探测失败为空串） */
  pnpmVersion: string;
  /** 要注入 env.PATH 的目录（已按优先级排序，已存在性过滤） */
  pathDirs: string[];
}

export interface EnsureToolchainOptions {
  /** DSH home（`<userData>/dsh-home`），工具链落在它的 runtime-bin 下 */
  home: string;
  /** Electron 可执行文件绝对路径（`process.execPath`） */
  electronPath: string;
  /** 应用根目录（开发态是仓库根；打包态是 `app.getAppPath()`） */
  appPath: string;
  /** 打包态 `process.resourcesPath` */
  resourcesPath: string;
  isPackaged: boolean;
  /** 测试/诊断用：覆盖 pnpm 源文件路径 */
  pnpmSourceOverride?: string;
}

const isWindows = (): boolean => process.platform === 'win32';

/** 用户可写目录：不要往 App 包里写（只读挂载 / Gatekeeper 平移都会失败） */
export function toolchainBinDir(home: string): string {
  return path.join(home, 'runtime-bin', 'bin');
}

function exists(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 列出随包 pnpm 的候选源文件（原生可执行优先，JS 入口兜底） */
function pnpmSourceCandidates(opts: EnsureToolchainOptions): { file: string; kind: 'native' | 'js' }[] {
  const win = isWindows();
  const pkgDirs = [
    // 打包态：asar 外的真实目录
    path.join(opts.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pnpm'),
    // 开发态：仓库根 node_modules
    path.join(opts.appPath, 'node_modules', 'pnpm'),
  ];
  // ⚠️ pnpm 的原生二进制有两种来源（见 pnpm/install.js）：
  //   · 生命周期脚本跑过 → bins 被替换成 host 二进制（<pkg>/pnpm）；
  //   · 脚本被拦（npm 11 默认禁脚本 / Corepack）→ bins 只是占位符，
  //     真正能执行的是可选依赖 @pnpm/exe.<platform>-<arch> 里的二进制。
  // 两种都要找，否则在 CI/干净机器上会静默退化成"找不到 pnpm"。
  const exePkg = process.platform === 'win32'
    ? `@pnpm/exe.win32-${process.arch}`
    : process.platform === 'darwin'
      ? `@pnpm/exe.darwin-${process.arch}`
      : `@pnpm/exe.linux-${process.arch}`;
  const exeDirs = [
    path.join(opts.resourcesPath, 'app.asar.unpacked', 'node_modules', exePkg),
    path.join(opts.appPath, 'node_modules', exePkg),
  ];
  const out: { file: string; kind: 'native' | 'js' }[] = [];
  for (const dir of exeDirs) {
    out.push({ file: path.join(dir, win ? 'pnpm.exe' : 'pnpm'), kind: 'native' });
  }
  for (const dir of pkgDirs) {
    if (win) {
      out.push({ file: path.join(dir, 'pnpm.exe'), kind: 'native' });
      out.push({ file: path.join(dir, 'bin', 'pnpm.cjs'), kind: 'js' });
      out.push({ file: path.join(dir, 'bin', 'pnpm.mjs'), kind: 'js' });
    } else {
      out.push({ file: path.join(dir, 'pnpm'), kind: 'native' });
      out.push({ file: path.join(dir, 'bin', 'pnpm.cjs'), kind: 'js' });
      out.push({ file: path.join(dir, 'bin', 'pnpm.mjs'), kind: 'js' });
    }
  }
  if (opts.pnpmSourceOverride) out.unshift({ file: opts.pnpmSourceOverride, kind: 'native' });
  return out;
}

/** 读一个 `#!/bin/sh` 风格脚本的首行之外无意义；这里只做「写成什么样」的纯逻辑 */
function nodeWrapperBody(electronPath: string): string {
  return isWindows()
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronPath}" %*\r\n`
    : `#!/bin/sh\n# 由深鲸桌面生成：用自带 Electron 充当 Node（插件安装生命周期脚本会调 node）。\nELECTRON_RUN_AS_NODE=1 exec "${electronPath}" "$@"\n`;
}

function pnpmJsWrapperBody(electronPath: string, pnpmJs: string): string {
  return isWindows()
    ? `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronPath}" "${pnpmJs}" %*\r\n`
    : `#!/bin/sh\n# 由深鲸桌面生成：用自带 Electron 充当 Node 跑 pnpm 的 JS 入口。\nELECTRON_RUN_AS_NODE=1 exec "${electronPath}" "${pnpmJs}" "$@"\n`;
}

function writeScript(file: string, body: string): boolean {
  let prev = '';
  try {
    prev = fs.readFileSync(file, 'utf8');
  } catch {
    // 不存在
  }
  if (prev === body) return false;
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, body, { mode: isWindows() ? undefined : 0o755 });
  fs.renameSync(tmp, file);
  if (!isWindows()) {
    try {
      fs.chmodSync(file, 0o755);
    } catch {
      // 某些文件系统不支持权限位：忽略
    }
  }
  return true;
}

/** 复制原生可执行文件；只在大小/时间戳变化时复制（42MB，不能每次启动都拷） */
function materializeNative(src: string, dest: string): boolean {
  try {
    const s = fs.statSync(src);
    const d = exists(dest) ? fs.statSync(dest) : null;
    if (d && d.size === s.size && d.mtimeMs >= s.mtimeMs) {
      if (!isWindows()) {
        try {
          fs.chmodSync(dest, 0o755);
        } catch {
          // 忽略
        }
      }
      return false;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.tmp-${process.pid}`;
    fs.copyFileSync(src, tmp);
    if (!isWindows()) fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dest);
    return true;
  } catch (e) {
    console.warn('[toolchain] 物化 pnpm 失败：', e);
    return false;
  }
}

function probePnpmVersion(bin: string): string {
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process');
    const out = execFileSync(bin, ['--version'], { timeout: 15000, env: { ...process.env, PATH: `${path.dirname(bin)}${path.delimiter}${process.env.PATH || ''}` } });
    return String(out).trim().split('\n').pop() || '';
  } catch {
    return '';
  }
}

/**
 * 常见 bin 目录候选（只返回真实存在的）。
 * 顺序即优先级：先用户级包管理器，再系统级，最后 node 版本管理器。
 */
export function systemBinCandidates(): string[] {
  const home = os.homedir();
  const dirs: string[] = [];
  const push = (p: string) => {
    if (p && isDir(p)) dirs.push(p);
  };
  push(path.join(home, '.npm-global', 'bin'));
  push(path.join(home, '.local', 'share', 'pnpm'));
  push(path.join(home, 'Library', 'pnpm'));
  push(path.join(home, '.volta', 'bin'));
  push(path.join(home, '.local', 'bin'));
  push('/opt/homebrew/bin');
  push('/usr/local/bin');
  push('/opt/local/bin');
  // nvm：挑最新的一版（与 resolveExecutable 的 npx 兜底同思路）
  try {
    const nvm = path.join(home, '.nvm', 'versions', 'node');
    const versions = fs.readdirSync(nvm).sort().reverse();
    for (const v of versions) {
      push(path.join(nvm, v, 'bin'));
      break; // 只用最新的
    }
  } catch {
    // 没装 nvm
  }
  // fnm / asdf
  try {
    const fnm = path.join(home, '.local', 'share', 'fnm', 'node-versions');
    for (const v of fs.readdirSync(fnm).sort().reverse()) {
      const bin = path.join(fnm, v, 'installation', 'bin');
      if (isDir(bin)) {
        dirs.push(bin);
        break;
      }
    }
  } catch {
    // 没装 fnm
  }
  return dirs;
}

/**
 * 准备工具链：物化随包 pnpm + node 包装脚本，并返回要注入 PATH 的目录列表。
 * 幂等：重复调用只会在源变化时重新拷贝。
 */
export function ensurePluginToolchain(opts: EnsureToolchainOptions): ToolchainPaths {
  const binDir = toolchainBinDir(opts.home);
  fs.mkdirSync(binDir, { recursive: true });

  // 1) node 包装（Electron 充当 Node）
  const nodeFile = path.join(binDir, isWindows() ? 'node.cmd' : 'node');
  try {
    writeScript(nodeFile, nodeWrapperBody(opts.electronPath));
  } catch (e) {
    console.warn('[toolchain] 生成 node 包装失败：', e);
  }

  // 2) 随包 pnpm → runtime-bin
  let pnpmState: 'bundled' | 'missing' = 'missing';
  let pnpmVersion = '';
  for (const cand of pnpmSourceCandidates(opts)) {
    if (!exists(cand.file)) continue;
    if (cand.kind === 'native') {
      const dest = path.join(binDir, isWindows() ? 'pnpm.exe' : 'pnpm');
      if (materializeNative(cand.file, dest) || exists(dest)) {
        pnpmVersion = probePnpmVersion(dest);
        if (pnpmVersion) {
          pnpmState = 'bundled';
          break;
        }
      }
    } else {
      // JS 入口：用 node 包装跑
      const dest = path.join(binDir, isWindows() ? 'pnpm.cmd' : 'pnpm');
      try {
        writeScript(dest, pnpmJsWrapperBody(opts.electronPath, cand.file));
        pnpmVersion = probePnpmVersion(dest);
        if (pnpmVersion) {
          pnpmState = 'bundled';
          break;
        }
      } catch {
        // 继续尝试下一个候选
      }
    }
  }
  if (pnpmState === 'missing') {
    console.warn('[toolchain] 未找到随包 pnpm（打包配置可能漏了 node_modules/pnpm）');
  }

  // 3) PATH：runtime-bin 永远第一，然后系统候选
  const pathDirs = [binDir, ...systemBinCandidates()];
  return { binDir, pnpm: pnpmState, pnpmVersion, pathDirs };
}

/** 把工具链目录合并进 env.PATH（去重、保序、不覆盖已有项） */
export function augmentRuntimePath(env: NodeJS.ProcessEnv, extraDirs: string[]): string {
  const current = (env.PATH || '').split(path.delimiter).filter(Boolean);
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const dir of [...extraDirs, ...current]) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    merged.push(dir);
  }
  env.PATH = merged.join(path.delimiter);
  return env.PATH;
}
