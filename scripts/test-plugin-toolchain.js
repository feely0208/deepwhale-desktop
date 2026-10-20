#!/usr/bin/env node
/**
 * 插件安装工具链回归测试（2026-10-20）
 *
 * 背景：GUI 的「添加插件」在 DSH 运行时里 spawn `pnpm`，而 Finder 启动的 App PATH
 * 只有 /usr/bin:/bin:/usr/sbin:/sbin → `spawn pnpm ENOENT`，所有插件都装不上。
 * 修复见 src/main/plugin-toolchain.ts + src/main/service-manager.ts。
 *
 * 这个测试**不依赖网络**，并且刻意把 PATH 压到最小（模拟 Finder 启动）：
 *   1. 工具链能把随包 pnpm 物化出来、能跑 `--version`；
 *   2. 用「只有工具链 PATH」的环境，跑真实的 `dsh plugin add`（file: 本地包），
 *      断言插件被写进 profile —— 证明 GUI 那条链路在修复后是通的；
 *   3. 反证：修复前的环境（没有任何 pnpm 的极简 PATH）必须失败，
 *      否则说明测试根本没在测这件事。
 */
'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { ensurePluginToolchain, augmentRuntimePath } = require(path.join(REPO, 'dist/main/plugin-toolchain.js'));

const MINIMAL_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  failed += 1;
  console.log(`  ❌ ${m}`);
};

function electronPath() {
  const base = path.join(REPO, 'node_modules/electron/dist');
  if (process.platform === 'darwin') return path.join(base, 'Electron.app/Contents/MacOS/Electron');
  if (process.platform === 'win32') return path.join(base, 'electron.exe');
  return path.join(base, 'electron');
}

function findDshBin() {
  const p = path.join(REPO, 'dsh-runtime/node_modules/@deepseek-ai/dsh/lib/bin.js');
  assert(fs.existsSync(p), `找不到随包 DSH 运行时：${p}`);
  return p;
}

function run(cmd, args, env, opts = {}) {
  return cp.spawnSync(cmd, args, {
    env,
    encoding: 'utf8',
    timeout: opts.timeout || 180000,
    cwd: opts.cwd || REPO,
  });
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-toolchain-test-'));
  const home = path.join(tmp, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });

  console.log('\n  [1] 物化随包 pnpm');
  const tc = ensurePluginToolchain({
    home,
    electronPath: electronPath(),
    appPath: REPO,
    resourcesPath: REPO,
    isPackaged: false,
  });
  const pnpmBin = path.join(tc.binDir, process.platform === 'win32' ? 'pnpm.exe' : 'pnpm');
  if (tc.pnpm === 'bundled') ok(`随包 pnpm 已物化（v${tc.pnpmVersion}）→ ${pnpmBin}`);
  else bad('随包 pnpm 没找到（打包配置可能漏了 node_modules/pnpm）');
  if (fs.existsSync(pnpmBin)) ok('pnpm 可执行文件存在');
  else bad('pnpm 可执行文件不存在');

  console.log('\n  [2] 用「Finder 极简 PATH + 工具链」跑 pnpm --version');
  const envMinimal = { PATH: MINIMAL_PATH, HOME: tmp };
  const envFixed = { PATH: MINIMAL_PATH, HOME: tmp };
  augmentRuntimePath(envFixed, tc.pathDirs);
  const before = run(pnpmBin, ['--version'], envMinimal);
  // 直接跑绝对路径时 PATH 只影响它派生出的子进程；这里断言修复后的 PATH 里 pnpm 能被解析
  const which = run('/bin/sh', ['-c', 'command -v pnpm || true'], envFixed);
  if (String(which.stdout).trim()) ok(`修复后 PATH 能解析到 pnpm：${String(which.stdout).trim()}`);
  else bad('修复后 PATH 里还是找不到 pnpm');
  const v = run(pnpmBin, ['--version'], envFixed);
  if (String(v.stdout).trim()) ok(`pnpm 能执行：v${String(v.stdout).trim()}`);
  else bad(`pnpm 执行失败：${String(v.stderr).slice(0, 300)}`);
  if (String(before.stdout).trim()) {
    ok('pnpm 是自包含的原生程序（不依赖 PATH 里的 node）');
  } else {
    bad('pnpm 直接执行失败（可能只给了 JS 入口却找不到 node）');
  }

  console.log('\n  [3] 真实 dsh plugin add（file: 本地包），PATH 只给工具链');
  // 造一个本地假插件包
  const fakeDir = path.join(tmp, 'fake-plugin');
  fs.mkdirSync(path.join(fakeDir, 'lib'), { recursive: true });
  fs.writeFileSync(
    path.join(fakeDir, 'package.json'),
    JSON.stringify({ name: '@test/dsh-fake-plugin', version: '1.0.0', main: './lib/index.js' }, null, 2),
  );
  fs.writeFileSync(path.join(fakeDir, 'lib/index.js'), 'exports.apply = () => {};\n');

  const profileHome = path.join(tmp, 'home2');
  fs.mkdirSync(profileHome, { recursive: true });
  // HOME 指向临时目录，避免污染用户的 pnpm store / 全局配置
  const envAdd = { PATH: envFixed.PATH, HOME: profileHome, DSH_HOME: profileHome, ELECTRON_RUN_AS_NODE: '1' };
  const add = run(process.execPath, [findDshBin(), 'plugin', '--profile', 'web', 'add', `file:${fakeDir}`], envAdd);
  const profPkg = path.join(profileHome, 'profiles', 'web', 'package.json');
  let depsOk = false;
  try {
    depsOk = Boolean(JSON.parse(fs.readFileSync(profPkg, 'utf8')).dependencies['@test/dsh-fake-plugin']);
  } catch {
    // 文件不存在
  }
  if (add.status === 0 && depsOk) ok('dsh plugin add 成功，依赖已写入 profile');
  else {
    bad(`dsh plugin add 失败（status=${add.status}）`);
    console.log(String(add.stdout).slice(-800));
    console.log(String(add.stderr).slice(-800));
  }

  console.log('\n  [5] ServiceManager 真的把工具链 PATH 传给了 DSH 子进程');
  // 用假运行时（打印 PATH 后退出）验证壳的接线 —— 不启动真 DSH，不碰用户数据。
  const { ServiceManager } = require(path.join(REPO, 'dist/main/service-manager.js'));
  const fakeBin = path.join(tmp, 'fake-runtime.js');
  fs.writeFileSync(fakeBin, 'console.log("PATH=" + process.env.PATH);\nsetTimeout(() => {}, 300);\n');
  let sawPath = '';
  const svc = new ServiceManager('dsh', {
    port: 39999,
    bundledBin: fakeBin,
    env: { DSH_HOME: path.join(tmp, 'home3') },
    toolchain: {
      appPath: REPO,
      resourcesPath: REPO,
      isPackaged: false,
      electronPath: electronPath(),
    },
    onLogLine: (line) => {
      if (line.startsWith('PATH=')) sawPath = line.slice(5);
    },
  });
  svc.spawn();
  // 必须让出事件循环：子进程 stdout 是靠事件回调进来的
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !sawPath) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const expectedBinDir = path.join(tmp, 'home3', 'runtime-bin', 'bin');
  if (sawPath.split(':')[0] === expectedBinDir) ok(`子进程 PATH 第一项就是工具链目录（${expectedBinDir}）`);
  else bad(`子进程 PATH 没被注入（期望 ${expectedBinDir}，首项=${sawPath.split(':')[0] || '空'}）`);
  try {
    svc.stop();
  } catch {
    // 停止失败不影响断言
  }

  console.log('\n  [4] 反证：修复前的极简 PATH 必须失败');
  const envBroken = { PATH: MINIMAL_PATH, HOME: profileHome, DSH_HOME: profileHome };
  const addBroken = run(process.execPath, [findDshBin(), 'plugin', '--profile', 'web', 'add', `file:${fakeDir}`], envBroken);
  const brokenText = `${addBroken.stdout || ''}${addBroken.stderr || ''}`;
  if (/ENOENT|not found|pnpm/i.test(brokenText) && addBroken.status !== 0) {
    ok('未注入 PATH 时确实失败（ENOENT/pnpm）—— 说明测试真的在测这件事');
  } else {
    bad('未注入 PATH 竟然成功 —— 这台机器环境里还有别的 pnpm，测试失去意义（或修复没被测到）');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed === 0 ? '\n  ✅ 工具链测试全过\n' : `\n  ❌ 工具链测试失败 ${failed} 项\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('  ❌ 测试异常：', e);
  process.exit(1);
});
