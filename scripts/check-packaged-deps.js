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

/**
 * 自己读 asar 的条目列表 —— **不依赖任何模块**（2026-10-14 Windows CI 失败后加的）。
 *
 * 为什么不用 `@electron/asar`：Windows 那次（run 38569021113）四平台里只有 Windows 报
 * 「tree-kill / electron-updater / js-yaml 都不在包内」—— 说明 app.asar 找到了，
 * 但依赖 `@electron/asar` 的那条路在那台机器上没走通（模块加载或行为差异），
 * 而我把加载失败静默降级成了"查不到"→ 报了一个**看似合理其实错误**的结论。
 * 打包守卫自己不能依赖第三方解析器：asar 的头格式是公开且极简的，
 * 8 字节 pickle 头 + JSON 头（大小写在第 4 个 uint32），直接读就够了。
 */
function listAsarEntries(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(16);
      fs.readSync(fd, head, 0, 16, 0);
      const jsonSize = head.readUInt32LE(12);
      if (jsonSize <= 0 || jsonSize > 64 * 1024 * 1024) return null;
      const jsonBuf = Buffer.alloc(jsonSize);
      fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
      const header = JSON.parse(jsonBuf.toString('utf8'));
      const out = [];
      const walk = (node, prefix) => {
        for (const [name, child] of Object.entries(node.files || {})) {
          const p = `${prefix}/${name}`;
          if (child && child.files) walk(child, p);
          else out.push(p);
        }
      };
      walk(header, '');
      return out;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
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
  for (const root of roots) {
    try {
      console.error('   ' + root + '/ 顶层：' + fs.readdirSync(root).slice(0, 12).join(', '));
    } catch {
      console.error('   ' + root + '/ 不存在或读不了');
    }
  }
  console.error('   —— 打包产物结构变了，请先确认 electron-builder 的输出位置（见 electron-builder.yml 的 directories.output）');
  process.exit(1);
}
if (found.asarFiles.length > 0) {
  console.log(`  找到 ${found.asarFiles.length} 个 app.asar：${found.asarFiles.map((f) => path.relative(process.cwd(), f)).join(', ')}`);
}
if (found.realNodeModules.length > 0) {
  console.log(`  找到 ${found.realNodeModules.length} 个真实 node_modules：${found.realNodeModules.map((f) => path.relative(process.cwd(), f)).join(', ')}`);
}

/**
 * asar 里是否有 node_modules/<mod>/package.json。
 * ⚠️ 解析失败必须**说出来**（写进 problems → 变成 CI 注释），
 *    不能静默当成"这个依赖不在包里" —— 2026-10-14 Windows 那次就是被静默降级
 *    报成"三个依赖都不在包内"，方向完全指错。
 */
function inAsar(mod) {
  const want = `/node_modules/${mod}/package.json`;
  for (const f of found.asarFiles) {
    const entries = listAsarEntries(f);
    if (entries !== null) {
      if (entries.includes(want)) return true;
      continue;
    }
    if (asar === null) {
      problems.push(`无法解析 ${f} 的 asar 头（且 @electron/asar 不可用）—— 打包守卫自身失效，请人工确认`);
      continue;
    }
    try {
      if (asar.listPackage(f).includes(want)) return true;
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
