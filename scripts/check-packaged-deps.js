#!/usr/bin/env node
/**
 * 打包完整性守卫：**生产依赖必须真的进包**（2026-10-05 事故，2026-10-14 适配 asar）
 *
 * 事故原型：Windows 1.0.52 启动即崩 —— `Error: Cannot find module 'tree-kill'`
 * （主进程顶层 import 失败 → 应用完全打不开）。依赖没进包 = 装完就是一个打不开的软件，
 * 必须在出门前拦住。
 *
 * 为什么单独写成一个脚本（而不是留在 workflow 里）：原来那版用
 * `find release dist -type d -ipath "*resources/app/node_modules/$mod"` —— 只认**真实目录**。
 * 2026-10-14 运行时改回 asar 打包后，`node_modules` 在 `app.asar` **里面**，
 * 于是这个检查在四个平台同时报红（Release run 38567857212，step 13）。
 * 判据必须跟着打包形态走：**真实目录 or asar 里的条目，两条都算数**。
 *
 * 用法：node scripts/check-packaged-deps.js [根目录…]（默认 release dist）
 */
const fs = require('fs');
const path = require('path');

/** 必须进包的生产依赖（package.json 的 dependencies 之外还列了历史上踩过坑的） */
const REQUIRED = ['tree-kill', 'electron-updater', 'js-yaml'];

const roots = process.argv.slice(2).filter((a) => !a.startsWith('-'));
if (roots.length === 0) roots.push('release', 'dist');

/** 收集 app.asar 文件与"真实目录形态"的 resources/app/node_modules */
function scan(root) {
  const asarFiles = [];
  const realNodeModules = [];
  const walk = (dir, depth) => {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // 真实目录形态：……/resources/app/node_modules（或 Resources）
        if (e.name === 'node_modules' && /[/\\](app)[/\\]?$/.test(path.dirname(full))) {
          realNodeModules.push(full);
          continue;
        }
        if (e.name === 'node_modules' || e.name === '.git') continue; // 不深挖，够用了
        walk(full, depth + 1);
      } else if (e.name === 'app.asar') {
        asarFiles.push(full);
      }
    }
  };
  if (fs.existsSync(root)) walk(root, 0);
  return { asarFiles, realNodeModules };
}

let asar;
try {
  asar = require('@electron/asar');
} catch {
  asar = null;
}

const problems = [];
const found = { asarFiles: [], realNodeModules: [] };
for (const root of roots) {
  const r = scan(root);
  found.asarFiles.push(...r.asarFiles);
  found.realNodeModules.push(...r.realNodeModules);
}

if (found.asarFiles.length === 0 && found.realNodeModules.length === 0) {
  console.error('❌ 在 ' + roots.join(' / ') + ' 下既没找到 app.asar 也没找到 resources/app/node_modules');
  console.error('   —— 打包产物结构变了，请先确认 electron-builder 的输出位置（见 electron-builder.yml 的 directories.output）');
  process.exit(1);
}
if (found.asarFiles.length > 0) {
  console.log(`  找到 ${found.asarFiles.length} 个 app.asar：${found.asarFiles.map((f) => path.relative(process.cwd(), f)).join(', ')}`);
}
if (found.realNodeModules.length > 0) {
  console.log(`  找到 ${found.realNodeModules.length} 个真实 node_modules：${found.realNodeModules.map((f) => path.relative(process.cwd(), f)).join(', ')}`);
}

/** asar 里是否有 node_modules/<mod>/package.json */
function inAsar(mod) {
  if (asar === null) return false;
  for (const f of found.asarFiles) {
    try {
      const entries = asar.listPackage(f);
      if (entries.some((p) => p === `/node_modules/${mod}/package.json`)) return true;
    } catch (e) {
      problems.push(`读不了 ${f}: ${e.message}`);
    }
  }
  return false;
}

for (const mod of REQUIRED) {
  const asReal = found.realNodeModules.some((d) => fs.existsSync(path.join(d, mod, 'package.json')));
  const asarHit = asReal ? false : inAsar(mod);
  if (asReal || asarHit) {
    console.log(`  ✅ ${mod} 在包内（${asReal ? '真实目录' : 'app.asar'}）`);
  } else {
    console.log(`  ❌ ${mod} 不在包内（装完会启动崩溃）`);
    problems.push(`${mod} 不在包内`);
  }
}

if (problems.length) {
  console.error('\n::error::打包产物缺少生产依赖，禁止发布：' + problems.join('；'));
  process.exitCode = 1;
} else {
  console.log('✅ 打包完整性检查通过（生产依赖确实进了包）');
}
