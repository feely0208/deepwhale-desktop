#!/usr/bin/env node
/**
 * 按**目标架构**准备 LibreOffice 引擎包（Office 预览用）。
 *
 * ── 为什么需要这一步（2026-10-17 定位）────────────────────────────────
 * `@deepseek-ai/libreoffice-kit` 的引擎包是**架构绑定**的：
 *   darwin-arm64 / darwin-x64 / win32-x64 / win32-arm64（linux 只有 wasm 兜底）。
 * 而 CI runner 只会装**宿主架构**那一份 —— 例如 macos-latest 是 arm64，
 * `npm install` 装到的是 `darwin-arm64`，但 matrix 里 `macos-x64` 这个 job
 * 打的是 **x64** 包 → 包里塞进了 arm64 的引擎 → 用户侧表现为
 * **「Office 预览不可用」（装得上、用不了）**，而且所有守卫都是绿的。
 *
 * 这是 release-selfcheck 里明写的坑：「随包载荷的架构与包架构一致，
 * 否则会出现装得上、用不了」。
 *
 * ── 做什么 ────────────────────────────────────────────────────────────
 *   1. 非 linux：确保目标架构引擎已安装（宿主架构的会被移除，避免包体积翻倍）
 *   2. linux：原生引擎从未发布，kit 会自动回退 wasm —— 但**必须先清掉
 *      npm 给不存在的 optionalDependency 建出来的空目录**，否则 kit 抛
 *      `Installed LibreOfficeKit package is incomplete` 而不是回退（实测踩到）
 *   3. 断言：目标引擎能被 require.resolve 到，且 package.json 的 name 对得上
 *
 * 用法：node scripts/prepare-office-engine.js <target>
 *   target: darwin-arm64 | darwin-x64 | win32-x64 | win32-arm64 | linux-x64 | linux-arm64
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const KIT_DIR = path.join(REPO, 'dsh-runtime', 'node_modules', '@deepseek-ai');
const SCOPE = '@deepseek-ai';

const target = process.argv[2];
if (!target) {
  console.error('用法: node scripts/prepare-office-engine.js <darwin-arm64|darwin-x64|win32-x64|win32-arm64|linux-x64|linux-arm64>');
  process.exit(2);
}

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}
function exists(p) {
  try { return fs.statSync(p) !== undefined; } catch { return false; }
}
function engineDir(name) {
  return path.join(KIT_DIR, name);
}
function kitVersion() {
  const p = path.join(KIT_DIR, 'libreoffice-kit', 'package.json');
  if (!exists(p)) die(`找不到 ${SCOPE}/libreoffice-kit（先准备 dsh-runtime）`);
  return JSON.parse(fs.readFileSync(p, 'utf8')).version;
}

const VER = kitVersion();
const isLinux = target.startsWith('linux-');
const engineName = `${SCOPE}/libreoffice-kit-${target}`;

console.log(`== 准备 Office 引擎 ==`);
console.log(`   目标: ${target}`);
console.log(`   kit 版本: ${VER}`);

if (isLinux) {
  // Linux 没有发布原生引擎；清掉空目录让 kit 走 wasm 回退
  const prefix = 'libreoffice-kit-linux-';
  let removed = 0;
  if (exists(KIT_DIR)) {
    for (const name of fs.readdirSync(KIT_DIR)) {
      if (!name.startsWith(prefix)) continue;
      fs.rmSync(engineDir(name), { recursive: true, force: true });
      console.log(`   移除不可用的原生命名目录: ${name}`);
      removed += 1;
    }
  }
  // 兜底：清除**任何**没有 package.json 的引擎目录（npm 给不可用 optionalDependency
  // 建出来的空壳）。kit 的 installedPackageExists 只看目录在不在，空壳会被判成
  // 「incomplete」而不是回退 wasm —— 这正是 Linux CI 红的原因。
  if (exists(KIT_DIR)) {
    for (const name of fs.readdirSync(KIT_DIR)) {
      if (!name.startsWith('libreoffice-kit-')) continue;
      if (!exists(path.join(KIT_DIR, name, 'package.json'))) {
        fs.rmSync(engineDir(name), { recursive: true, force: true });
        console.log(`   清除空壳引擎目录: ${name}`);
      }
    }
    const remain = fs.readdirSync(KIT_DIR).filter((n) => n.startsWith('libreoffice-kit'));
    console.log(`   @deepseek-ai 下引擎目录: ${remain.join(', ') || '(无)'}`);
    if (process.env.GITHUB_ACTIONS === 'true') console.log(`::notice::${target} 引擎目录: ${remain.join(', ') || '(无)'}`);
  }
  const wasmPkg = path.join(KIT_DIR, 'libreoffice-kit-wasm', 'package.json');
  if (!exists(wasmPkg)) die('Linux 需要 libreoffice-kit-wasm 兜底，但它没装上');
  const wv = JSON.parse(fs.readFileSync(wasmPkg, 'utf8')).version;
  if (wv !== VER) die(`wasm 引擎版本 ${wv} ≠ kit ${VER}`);
  console.log(`   ✅ wasm 引擎就位（${wv}）${removed ? `，已清 ${removed} 个空目录` : ''}`);
  process.exit(0);
}

// 非 linux：确保目标架构引擎在，移除其它架构的引擎（避免包体积翻倍）
const wantPkg = path.join(KIT_DIR, `libreoffice-kit-${target}`, 'package.json');
if (!exists(wantPkg)) {
  console.log(`   目标架构引擎缺失，补装 ${engineName}@${VER} …`);
  // ⚠️ --force 必须加：目标架构与宿主不同时 npm 会以 EBADPLATFORM 直接拒绝
  execFileSync('npm', [
    'install', '--prefix', 'dsh-runtime', '--no-save', '--force',
    '--no-audit', '--no-fund', '--loglevel=error',
    `${engineName}@${VER}`,
  ], { cwd: REPO, stdio: 'inherit' });
  if (!exists(wantPkg)) die(`补装后仍找不到 ${engineName}/package.json`);
}

// 移除其它架构的引擎（只保留目标架构）
const keepArch = target.split('-').slice(1).join('-'); // arm64 / x64
for (const name of fs.readdirSync(KIT_DIR)) {
  if (!name.startsWith('libreoffice-kit-')) continue;
  if (name === 'libreoffice-kit' || name === `libreoffice-kit-${target}`) continue;
  fs.rmSync(engineDir(name), { recursive: true, force: true });
  console.log(`   移除非目标架构引擎: ${name}`);
}

// 断言
const pkg = JSON.parse(fs.readFileSync(wantPkg, 'utf8'));
if (pkg.name !== engineName) die(`引擎包名不符: ${pkg.name} ≠ ${engineName}`);
if (pkg.version !== VER) die(`引擎版本不符: ${pkg.version} ≠ ${VER}`);
console.log(`   ✅ 目标引擎就位: ${pkg.name}@${pkg.version}（arch ${keepArch}）`);
