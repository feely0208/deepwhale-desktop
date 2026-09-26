#!/usr/bin/env node
/**
 * 构建 office 载荷（精简 CPython + 文档库）。
 *
 * 产出：
 *   office-runtime/
 *   ├── runtime.json                 ← 官方 `dsh-tool-workspace-dependencies` 读的清单
 *   └── dependencies/python/...      ← 可移植 CPython + site-packages
 *
 * **必须按目标平台/架构各构建一份**：CPython 二进制是平台绑定的，而 `lxml` / `Pillow`
 * 是二进制 wheel —— pip 默认只装"当前运行的解释器"那套轮子，所以跨架构时要用
 * `--platform` 显式指定（本脚本已处理）。
 *
 * 用法：
 *   node scripts/build-office-runtime.js                     # 按当前平台/架构
 *   node scripts/build-office-runtime.js darwin-x64          # 交叉构建
 *   node scripts/build-office-runtime.js --out dir  win32-x64
 *
 * 只装文档生成所需的库；**不含 numpy / pandas**（官方载荷里的大头，此处用不到），
 * PDF 渲染由 dsh 0.1.7 随包的 LibreOffice Kit 提供。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

/** 与官方运行时同版本，避免两套行为差异。 */
const PY_VERSION = '3.12.14';
const PBS_TAG = '20260924';

/** 目标三元组：platform-arch → python-build-standalone 的 triple。 */
const TRIPLES = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
};

/** pip 的 --platform 取值（跨架构安装用）。 */
const PIP_PLATFORM = {
  'darwin-arm64': 'macosx_11_0_arm64',
  'darwin-x64': 'macosx_11_0_x86_64',
  'win32-x64': 'win_amd64',
  'linux-x64': 'manylinux2014_x86_64',
  'linux-arm64': 'manylinux2014_aarch64',
};

/** 要装的库（版本与官方一致，便于对齐行为）。 */
const PACKAGES = [
  'python-docx==1.2.0',
  'python-pptx==1.0.2',
  'openpyxl==3.1.5',
  'XlsxWriter==3.2.9',
  'Pillow==12.3.0',
  'lxml==6.1.3',
];

/** 清单里声明的包版本（校验用，必须与上面一致）。 */
const MANIFEST_PACKAGES = {
  'python-docx': '1.2.0',
  'python-pptx': '1.0.2',
  'openpyxl': '3.1.5',
  'XlsxWriter': '3.2.9',
  'Pillow': '12.3.0',
  'lxml': '6.1.3',
  'typing_extensions': '4.16.0',
  et_xmlfile: '2.0.0',
};

/** 发行版的 platform 取值（官方要求 win32 / darwin / linux）。 */
function manifestPlatform(target) {
  if (target.startsWith('darwin')) return 'darwin';
  if (target.startsWith('win32')) return 'win32';
  return 'linux';
}

function currentTarget() {
  const p = process.platform;
  const a = process.arch;
  return `${p === 'win32' ? 'win32' : p}-${a === 'x64' ? 'x64' : a}`;
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const get = (u, depth = 0) => {
      if (depth > 5) return reject(new Error(`too many redirects: ${u}`));
      https
        .get(u, { headers: { 'user-agent': 'deepwhale-build' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return get(res.headers.location, depth + 1);
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode} for ${u}`));
          }
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
        })
        .on('error', reject);
    };
    get(url);
  });
}

/** 瘦身：删掉与文档生成无关的组件（含 pip 自身），约省 25%。 */
function trim(pyDir) {
  const rm = (rel) => fs.rmSync(path.join(pyDir, rel), { recursive: true, force: true });
  for (const rel of [
    'lib/python3.12/idlelib',
    'lib/python3.12/tkinter',
    'lib/python3.12/lib2to3',
    'lib/python3.12/ensurepip',
    'lib/python3.12/turtledemo',
    'lib/python3.12/test',
    'include',
    'share',
    'lib/python3.12/site-packages/pip',
    'Scripts/pip.exe',
    'Scripts/pip3.exe',
  ]) {
    rm(rel);
  }
  for (const rel of fs.existsSync(path.join(pyDir, 'lib/python3.12/site-packages'))
    ? fs.readdirSync(path.join(pyDir, 'lib/python3.12/site-packages'))
    : []) {
    if (/^pip-.*\.dist-info$/.test(rel)) rm(path.join('lib/python3.12/site-packages', rel));
  }
}

/** 用 `--platform` 交叉安装（当前解释器架构 != 目标架构时必须走这条）。 */
function pipInstall(pyExe, sitePackages, target, cross) {
  const args = ['-m', 'pip', 'install', '--no-warn-script-location', '--disable-pip-version-check', '-q'];
  if (cross) {
    args.push(
      '--target',
      sitePackages,
      '--platform',
      PIP_PLATFORM[target],
      '--python-version',
      PY_VERSION.split('.').slice(0, 2).join('.'),
      '--only-binary=:all:',
      '--upgrade',
    );
  }
  args.push(...PACKAGES);
  execFileSync(pyExe, args, { stdio: 'inherit' });
}

async function main() {
  const argv = process.argv.slice(2);
  let outDir = path.join(__dirname, '..', 'office-runtime');
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      outDir = path.resolve(argv[++i]);
    } else {
      positional.push(argv[i]);
    }
  }
  const target = positional[0] || currentTarget();
  const triple = TRIPLES[target];
  if (triple === undefined) {
    throw new Error(`unsupported target "${target}" (known: ${Object.keys(TRIPLES).join(', ')})`);
  }

  const windows = target.startsWith('win32');
  // 注意：python-build-standalone 的 install_only 包解压出来就是一个 `python/` 根，
  // 所以 pyDir 之下直接是 bin/ 或 python.exe（Windows），别再补一层 `python`。
  const pyRel = windows ? [] : ['bin'];
  const siteRel = windows ? ['Lib', 'site-packages'] : ['lib', 'python3.12', 'site-packages'];

  const depsDir = path.join(outDir, 'dependencies');
  const pyDir = path.join(depsDir, 'python');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(depsDir, { recursive: true });

  const asset = `cpython-${PY_VERSION}+${PBS_TAG}-${triple}-install_only_stripped.tar.gz`;
  const url = `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/${encodeURIComponent(asset)}`;
  const tarball = path.join(depsDir, asset);
  console.log(`[office-runtime] target=${target} triple=${triple}`);
  console.log(`[office-runtime] download ${asset}`);
  await download(url, tarball);

  console.log('[office-runtime] extract');
  execFileSync('tar', ['-xzf', tarball, '-C', depsDir], { stdio: 'inherit' });
  fs.rmSync(tarball, { force: true });

  const pyExe = path.join(pyDir, ...pyRel, windows ? 'python.exe' : 'python3');
  const sitePackages = path.join(pyDir, ...siteRel);
  const hostTarget = currentTarget();
  const cross = hostTarget !== target;
  console.log(`[office-runtime] pip install${cross ? ` (cross ${hostTarget} → ${target})` : ''}`);
  pipInstall(pyExe, sitePackages, target, cross);

  trim(pyDir);

  const manifest = {
    desktopVersion: require(path.join(__dirname, '..', 'package.json')).version,
    platform: manifestPlatform(target),
    arch: target.endsWith('arm64') ? 'arm64' : 'x64',
    python: PY_VERSION,
    pythonPackages: MANIFEST_PACKAGES,
  };
  fs.writeFileSync(path.join(outDir, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log('[office-runtime] runtime.json written');
  console.log(`[office-runtime] done → ${outDir}`);
}

main().catch((error) => {
  console.error('[office-runtime] failed:', error.message);
  process.exit(1);
});
