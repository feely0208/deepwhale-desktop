#!/usr/bin/env node
/**
 * 离线守卫：**从 asar 里把包复制出来**必须可行（2026-10-14 实测发现，asar 改回 true 的前提）
 *
 * 背景：为了让安装快、少占 C 盘，`electron-builder.yml` 的 `asar` 改回 `true`。
 *   但 Office 预览依赖 `materializeOfficeKit()` 把 `libreoffice-kit` 及依赖从随包运行时
 *   复制到 `<home>/office-runtime/kit/`（真实目录、带执行位）。
 *
 * 实测（合成 asar，Electron-as-Node）：
 *   · 能读：fs.statSync / readFileSync / readdirSync / 动态 import()
 *   · **不能**：fs.cpSync(<asar 内路径> → 真实目录) → `ENOENT, pkg not found in …/app.asar`
 * 所以运行时改 asar 之后，这一步必须走自写的 `copyTree()`（readdir + readFile + writeFile）。
 * 不修的表现：物化失败 → office 行不注入 → **Office 三件套静默消失**（跟用户报的那个 bug 同形）。
 *
 * 本脚本真的打一个 asar、真的用 Electron-as-Node 去拷 —— 不是读源码文本的静态检查。
 * 找不到 Electron 可执行文件时**跳过**（打印 ⏭），不伪装成通过。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist', 'main', 'office-runtime.js');
if (!fs.existsSync(dist)) {
  console.error('❌ 找不到编译产物 dist/main/office-runtime.js —— 请先 npm run build');
  process.exit(1);
}

/** 找 Electron 可执行文件（Electron-as-Node 需要它才能理解 asar） */
function findElectron() {
  try {
    // 纯 node 里 require('electron') 返回的是二进制路径字符串
    const p = require('electron');
    if (typeof p === 'string' && fs.existsSync(p)) return p;
  } catch {
    /* 没装 electron */
  }
  for (const p of [
    '/Applications/DeepWhale Desktop.app/Contents/MacOS/DeepWhale Desktop',
    path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
  ]) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const electron = findElectron();
if (electron === null) {
  console.log('⏭  跳过：找不到 Electron 可执行文件（asar 语义只能在 Electron 下验证）');
  process.exit(0);
}

// @electron/asar 打包器（electron-builder 的依赖里就有）
let asar = null;
try {
  asar = require('@electron/asar');
} catch {
  console.log('⏭  跳过：找不到 @electron/asar');
  process.exit(0);
}

const problems = [];
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail ? `（${detail}）` : ''}`);
};

async function main() {
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-asar-copy-'));
const src = path.join(work, 'src');
const pkg = path.join(src, 'node_modules', '@deepseek-ai', 'libreoffice-kit');
fs.mkdirSync(path.join(pkg, 'lib'), { recursive: true });
fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', version: '0.0.0-test' }), 'utf-8');
fs.writeFileSync(path.join(pkg, 'lib', 'cli.js'), '// fake cli\nmodule.exports = {};\n', 'utf-8');
fs.writeFileSync(path.join(pkg, 'lib', 'big.bin'), Buffer.alloc(256 * 1024, 7));
// 一个依赖包（copyPackage 会递归它的 dependencies）
const dep = path.join(src, 'node_modules', 'fflate');
fs.mkdirSync(dep, { recursive: true });
fs.writeFileSync(path.join(dep, 'package.json'), JSON.stringify({ name: 'fflate', version: '0.0.0-test' }), 'utf-8');

const asarFile = path.join(work, 'app.asar');
try {
  await asar.createPackage(src, asarFile);
} catch (e) {
  console.error(`❌ 打 asar 失败：${e.message}`);
  process.exit(1);
}

// 让子进程（Electron-as-Node）加载编译产物并调用 copyTree
const probe = path.join(work, 'probe.cjs');
fs.writeFileSync(
  probe,
  `
const fs = require('fs'), path = require('path');
const { copyTree } = require(${JSON.stringify(dist)});
const asarFile = process.argv[2];
const out = process.argv[3];
const from = path.join(asarFile, 'node_modules', '@deepseek-ai', 'libreoffice-kit');
const to = path.join(out, 'kit', 'node_modules', '@deepseek-ai', 'libreoffice-kit');
try {
  copyTree(from, to);
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: e.message }));
  process.exit(0);
}
const pj = JSON.parse(fs.readFileSync(path.join(to, 'package.json'), 'utf8'));
console.log(JSON.stringify({
  ok: true,
  name: pj.name,
  cliOk: fs.existsSync(path.join(to, 'lib', 'cli.js')),
  bigBytes: fs.statSync(path.join(to, 'lib', 'big.bin')).size,
}));
`,
  'utf-8',
);

const outDir = path.join(work, 'out');
const { spawnSync } = require('child_process');
const r = spawnSync(electron, [probe, asarFile, outDir], {
  encoding: 'utf-8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 60_000,
});
const stdout = (r.stdout || '').trim().split('\n').filter(Boolean).pop() || '';
let parsed = null;
try {
  parsed = JSON.parse(stdout);
} catch {
  problems.push(`探针没有输出可解析的结果（stderr: ${(r.stderr || '').slice(0, 200)}）`);
}
if (parsed) {
  check('从 asar 复制整体成功', parsed.ok === true, parsed.error);
  check('复制出的 package.json 正确', parsed.name === '@deepseek-ai/libreoffice-kit', String(parsed.name));
  check('lib/cli.js 到位', parsed.cliOk === true);
  check('大文件字节数一致（256KB）', parsed.bigBytes === 256 * 1024, String(parsed.bigBytes));
}

// 反向对照：证明"用 fs.cpSync 会失败"——这样守卫才真的在测那件事
const probeCp = path.join(work, 'probe-cp.cjs');
fs.writeFileSync(
  probeCp,
  `
const fs = require('fs'), path = require('path');
const asarFile = process.argv[2];
const out = path.join(process.argv[3], 'cp-attempt');
let failed = false, msg = '';
try { fs.cpSync(path.join(asarFile, 'node_modules'), out, { recursive: true }); }
catch (e) { failed = true; msg = e.message; }
console.log(JSON.stringify({ failed, msg: msg.slice(0, 120) }));
`,
  'utf-8',
);
const r2 = spawnSync(electron, [probeCp, asarFile, work], {
  encoding: 'utf-8',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  timeout: 60_000,
});
try {
  const cp = JSON.parse((r2.stdout || '').trim().split('\n').filter(Boolean).pop() || '{}');
  check('对照项：fs.cpSync 从 asar 复制确实失败（说明守卫在测真东西）', cp.failed === true, JSON.stringify(cp));
} catch {
  problems.push('对照项没有输出可解析结果');
}

fs.rmSync(work, { recursive: true, force: true });

if (problems.length) {
  console.error('❌ asar 复制守卫失败：');
  problems.forEach((p) => console.error('  · ' + p));
  process.exitCode = 1;
} else {
  console.log('✅ asar 复制守卫通过（copyTree 能从 asar 复制出包与依赖 · fs.cpSync 确实不行 → 必须用它）');
}
}

main().catch((e) => { console.error('❌ 守卫自身异常:', e); process.exit(1); });
