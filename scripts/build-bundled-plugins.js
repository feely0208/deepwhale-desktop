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
  let finalDir = path.join(__dirname, '..', 'bundled-plugins');
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') finalDir = path.resolve(argv[++i]);
  }

  // ⚠️ 先写临时目录，**全部成功之后**再原子替换目标（2026-10-01 实测踩到）。
  //
  //   原来是一进来就 `rmSync(outDir)`，于是**中途任何失败都会留下一个空载荷目录**。
  //   本次亲历一次：npm registry 抖动（ECONNRESET）→ bundled-plugins/ 被清空。
  //   而 release.yml 的载荷检查只断言"目录存在且 ≥1 个文件 ≥10KB"，
  //   打包脚本也只看目录在不在 —— 结果就是能**打出一个没有随包插件的安装包**，
  //   而这种包在用户那儿表现为"功能凭空消失"，极难定位。
  //
  //   改成临时目录：失败时把临时目录清掉，**上一个好载荷原样留着**。
  const outDir = `${finalDir}.staging-${String(process.pid)}`;
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  try {
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

  // 第三个是个**本地生成**的 bundle（不是 npm 包）：法律模式预设。
  // 它必须和上面两个一样躺在这个载荷目录里，壳的 ensureBundledPlugins 才会装它。
  // 详见 scripts/build-legal-preset-bundle.js 开头的原因说明。
  execFileSync(process.execPath, [path.join(__dirname, 'build-legal-preset-bundle.js'), '--out', outDir], {
    stdio: 'inherit',
  });

  // 第四个也是**本地源码**的 bundle（不是 npm 包）：会话右键菜单扩展。
  //
  // ⚠️ 它必须由这里拷进载荷，不能直接放在 bundled-plugins/ 下 ——
  //    本目录是 .gitignore 的构建产物（见 .gitignore 第 31 行），
  //    而且本脚本开头就 `fs.rmSync(outDir)` 整个清空重建：
  //    源码放在那里的话，跑一次就没了，而且 git 里根本看不见。
  //
  // ⚠️ 这一步还关系到"发出去的版本有没有这个菜单"：
  //    .github/workflows/release.yml 在打包前会重跑本脚本，
  //    CI 若找不到这一步，打出的包就**没有**这个插件 ——
  //    于是出现"本机能用、用户装了没有"的最难查的分裂。
  const localShellPlugin = path.join(__dirname, '..', 'shell-plugins', 'dsh-shell-session-actions');
  if (!fs.existsSync(path.join(localShellPlugin, 'cordis.patch.yml'))) {
    throw new Error(`缺少本地插件源码：${localShellPlugin}（应随仓库提交，不是构建产物）`);
  }
  fs.cpSync(localShellPlugin, path.join(outDir, 'dsh-shell-session-actions'), { recursive: true });
  console.log('[bundled-plugins]   → dsh-shell-session-actions（本地源码）');

  // 右侧「文档预览」工具栏的「打印」按钮（2026-10-02）。
  // 与上面同理：源码在 shell-plugins/ 下随仓库提交，这里只负责拷进产物 ——
  // 漏了这一步，CI 打出来的包就没有这个按钮（本机能用、用户装了没有）。
  const localPrintPlugin = path.join(__dirname, '..', 'shell-plugins', 'dsh-shell-document-print');
  if (!fs.existsSync(path.join(localPrintPlugin, 'cordis.patch.yml'))) {
    throw new Error(`缺少本地插件源码：${localPrintPlugin}（应随仓库提交，不是构建产物）`);
  }
  fs.cpSync(localPrintPlugin, path.join(outDir, 'dsh-shell-document-print'), { recursive: true });
  console.log('[bundled-plugins]   → dsh-shell-document-print（本地源码）');

  // 到这里才算全部成功 —— 替换目标目录（先删旧的再改名，同分区内是瞬时的）
  fs.rmSync(finalDir, { recursive: true, force: true });
  fs.renameSync(outDir, finalDir);
  console.log(`[bundled-plugins] done → ${finalDir}`);
  } catch (error) {
    // 失败只清本次的临时目录；**绝不碰 finalDir** —— 上一个好载荷要留着
    fs.rmSync(outDir, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error('[bundled-plugins] failed:', error.message);
  process.exit(1);
});
