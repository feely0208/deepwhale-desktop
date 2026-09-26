#!/usr/bin/env node
/**
 * 构建随包插件载荷 `bundled-plugins/`。
 *
 * 从 **npm 拉取已发布的正式包**（而不是用本地源码目录）——发出去的应该是经过验证的
 * 发布制品，本地源码可能带着未发布的改动。
 *
 * 产出：
 *   bundled-plugins/
 *   ├── dsh-cn-compliance/         （含 cordis.patch.yml / lib / skill）
 *   └── dsh-cn-doc-formatter/      （含 cordis.patch.yml / lib / skill）
 *
 * 这两个包体积都很小（各 <110KB），随包分发零负担，换来的是**装完即用、不联网**。
 *
 * 用法：
 *   node scripts/build-bundled-plugins.js
 *   node scripts/build-bundled-plugins.js --out dir  # 指定输出目录
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

/** 随包插件清单：包名 → 载荷目录名。目录名取包名去 scope，与 bundled-plugins.ts 对应。 */
const PLUGINS = [
  '@deepwhale-cn/dsh-cn-compliance',
  '@deepwhale-cn/dsh-cn-doc-formatter',
];

function fetchJson(url) {
  return new Promise((resolve, reject) => {
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
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            body += chunk;
          });
          res.on('end', () => resolve(JSON.parse(body)));
        })
        .on('error', reject);
    };
    get(url);
  });
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

async function main() {
  const argv = process.argv.slice(2);
  let outDir = path.join(__dirname, '..', 'bundled-plugins');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') outDir = path.resolve(argv[++i]);
  }

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const name of PLUGINS) {
    const dirName = name.split('/')[1];
    const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    const version = meta['dist-tags'].latest;
    const tarball = meta.versions[version].dist.tarball;
    console.log(`[bundled-plugins] ${name}@${version}`);

    const tgz = path.join(outDir, `${dirName}.tgz`);
    await download(tarball, tgz);

    // npm tarball 里统一是 package/ 前缀，解到临时目录再提上来。
    const staging = path.join(outDir, `.staging-${dirName}`);
    fs.mkdirSync(staging, { recursive: true });
    // 同 build-office-runtime：绝对路径里的盘符会被 GNU tar 当成远程主机
    // （Windows 上 `D:\...` → "Cannot connect to D: resolve failed"），
    // 所以用 cwd + 相对路径。tgz 在 outDir、解压目标是 outDir/.staging-*，
    // 因此是 `../<文件名>` 而不是裸文件名。
    execFileSync('tar', ['-xzf', path.join('..', path.basename(tgz))], {
      cwd: staging,
      stdio: 'inherit',
    });
    fs.rmSync(tgz, { force: true });

    const pkgDir = path.join(staging, 'package');
    const dest = path.join(outDir, dirName);
    fs.renameSync(pkgDir, dest);
    fs.rmSync(staging, { recursive: true, force: true });

    // 核验：包名必须与目录约定一致，且必须带组合层，否则注入了也挂不上。
    const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'package.json'), 'utf8'));
    if (manifest.name !== name) {
      throw new Error(`package name mismatch: expected ${name}, got ${manifest.name}`);
    }
    if (!fs.existsSync(path.join(dest, 'cordis.patch.yml'))) {
      throw new Error(`${name} has no cordis.patch.yml — it is not a bundle plugin`);
    }
    console.log(`[bundled-plugins]   → ${path.relative(process.cwd(), dest)}`);
  }

  console.log(`[bundled-plugins] done → ${outDir}`);
}

main().catch((error) => {
  console.error('[bundled-plugins] failed:', error.message);
  process.exit(1);
});
