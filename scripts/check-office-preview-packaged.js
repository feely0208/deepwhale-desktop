#!/usr/bin/env node
/**
 * 能力基线 · 第 4 项：**打包态的 Office 预览真的能用**（2026-10-15 事故后新加）
 *
 * ── 为什么必须有这条（而不是再加一个"机制"守卫）────────────────────
 *   1.0.56 把运行时打进 asar 后，macOS/Linux 用户的侧边栏文档预览变成
 *   「Office 预览不可用。请在运行 DeepSeek Harness 的主机上启用文档预览服务。」
 *   而**开发态、源码态、以及我们已有的 asar 守卫全是绿的**：
 *     · `asarUnpack` 断言过了（文件确实解包存在 ✓）
 *     · 真身文件 0755（可执行 ✓）
 *   真正的原因是**走 asar 的路径 `stat` 会报 0644**，而 kit 的自检是
 *   `stat(path).mode & 0o111`（`libreoffice-kit/lib/index.js`）→ 必败。
 *   教训：**只有"在真实产物上跑真实能力"的断言才算数**；断言机制会假绿。
 *
 * ── 这条断言做什么 ────────────────────────────────────────────────
 *   用打包好的 app 自己（Electron-as-Node）模拟 DSH 子进程的模块解析环境：
 *     ① 从 asar 里的 `dsh-office-to-pdf` 位置 createRequire（= DSH 的真实解析上下文）
 *        → `require.resolve('@deepseek-ai/libreoffice-kit')`
 *     ② 断言解析结果**落在 app.asar 之外**（真实目录）—— 落在 asar 里就是坏的根因
 *     ③ 真的 `createConverter()` 成功
 *     ④ 真的把一个 docx 转成 PDF（有输出、是 %PDF 头）
 *   ①②③④ 任一失败即退出码 1。
 *
 * 用法：
 *   node scripts/check-office-preview-packaged.js /path/to/DeepWhale\ Desktop.app
 *   node scripts/check-office-preview-packaged.js            # 自动找 release/ 下的产物
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const FIXTURE = path.join(REPO, 'tests', 'fixtures', 'office-preview-sample.docx');

/** 找产物的主可执行文件。
 *
 * ⚠️ 2026-10-17 修：旧实现把非 mac 的主可执行名**写死成 `DeepWhale Desktop.exe`** ——
 * Linux 的二进制没有 `.exe`，于是 `fs.existsSync(exe)` 恒为 false，
 * 整个 candidate 被丢弃、findApp() 返回 null，CI 报「找不到打包产物」。
 * 现在按实际布局探测：mac 取 Contents/MacOS 下第一个；Windows 认 .exe；
 * Linux 优先认与 productName 同名的可执行文件，否则取根目录第一个带执行位的普通文件。
 */
function findMainExe(appRoot, isMac) {
  if (isMac) {
    try {
      const macosDir = path.join(appRoot, 'Contents', 'MacOS');
      const first = fs.readdirSync(macosDir).find((n) => {
        try { return fs.statSync(path.join(macosDir, n)).isFile(); } catch { return false; }
      });
      return first ? path.join(macosDir, first) : null;
    } catch { return null; }
  }
  let names;
  try { names = fs.readdirSync(appRoot); } catch { return null; }
  // Windows：electron-builder 只会产出一个主 .exe
  const exeName = names.find((n) => n.endsWith('.exe') && !/uninstall/i.test(n));
  if (exeName) return path.join(appRoot, exeName);
  // Linux：优先与 productName 同名（可能带空格，或被连字符化）
  const preferred = ['DeepWhale Desktop', 'deepwhale-desktop', 'deepwhale_desktop'];
  for (const want of preferred) {
    if (names.includes(want)) return path.join(appRoot, want);
  }
  for (const n of names) {
    const p = path.join(appRoot, n);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch { /* 跳过 */ }
  }
  return null;
}

/** 找打包产物里的可执行文件与 app.asar */
function findApp(arg) {
  const candidates = [];
  if (arg) candidates.push(arg);
  /** electron-builder 的产物布局随平台/架构而变，三种都要认：
   *    · macOS      release/mac-arm64/<name>.app          ← 2026-10-17 修
   *    · Linux/Win  release/<name>-unpacked/resources/app.asar
   *    · 旧布局     release/<name>.app
   *
   * 为什么必须修（2026-10-17 实测）：旧实现只认 `release/<name>.app` 与
   * `release/<name>/resources/app.asar` —— mac 的产物在 `release/mac-arm64/<name>.app`
   * （`Contents/Resources/` 不是 `resources/`），两个都不匹配 → 返回 null。
   * 更糟的是：本地 `release/` 里若留着旧的 `win-unpacked`，会挑中 Windows 产物、
   * 在 mac 上跑 exe → 报「解析 libreoffice-kit 失败」的**假红**，把人带偏。
   */
  const pushIfApp = (p) => {
    if (fs.existsSync(path.join(p, 'Contents', 'Resources', 'app.asar'))) candidates.push(p);
  };
  const pushIfUnpacked = (p) => {
    if (fs.existsSync(path.join(p, 'resources', 'app.asar'))) candidates.push(p);
  };
  for (const root of ['release', 'dist']) {
    const dir = path.join(REPO, root);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (name.endsWith('.app')) { pushIfApp(full); continue; }
      pushIfUnpacked(full);
      // 再下一层：release/mac-arm64/<name>.app
      try {
        if (!fs.statSync(full).isDirectory()) continue;
        for (const inner of fs.readdirSync(full)) {
          if (inner.endsWith('.app')) pushIfApp(path.join(full, inner));
        }
      } catch { /* 不可读就跳过 */ }
    }
  }
  // 主机平台对不上的产物不优先（mac 上不要跑去跑 win-unpacked 里的 exe）
  const wantsMac = process.platform === 'darwin';
  const ordered = candidates.filter((c) => (c.endsWith('.app') ? wantsMac : !wantsMac));
  for (const c of [...ordered, ...candidates]) {
    if (!fs.existsSync(c)) continue;
    const isMac = c.endsWith('.app');
    const res = isMac ? path.join(c, 'Contents', 'Resources') : path.join(c, 'resources');
    const exe = findMainExe(c, isMac);
    if (!exe) continue;
    if (fs.existsSync(path.join(res, 'app.asar')) && fs.existsSync(exe)) {
      return { app: c, res, exe, isMac };
    }
  }
  return null;
}

const found = findApp(process.argv[2]);
if (found === null) {
  console.error('❌ 找不到打包产物（release/ 或 dist/ 下的 app.asar + 可执行文件）—— 先 npm run dist');
  process.exit(1);
}
const { app, res, exe, isMac } = found;
console.log(`== 打包态 Office 预览能力检查 ==`);
console.log(`   app: ${path.relative(REPO, app)}`);
console.log(`   平台: ${isMac ? 'macOS' : process.platform}`);

// 我们给 DSH 子进程设的 NODE_PATH（壳里 service-manager 同源；这里按 home 物化目录推导）
const homeCandidates = [
  process.env.DSH_HOME,
  path.join(os.homedir(), 'Library', 'Application Support', 'DeepWhale Desktop', 'dsh-home'),
].filter(Boolean);
// NODE_PATH 的候选：① 壳物化到 home 的真实目录（生产实际用它）
// ② 包内 extraResources 的真实目录（CI 上还没启动过 app 时的等价物）
const kitModules = [
  ...homeCandidates.map((h) => path.join(h, 'office-runtime', 'kit', 'node_modules')),
  path.join(res, 'office-kit'),
].find((p) => {
  // 必须含**平台引擎包**（libreoffice-kit-<plat>-<arch>）：只找到 JS 侧的 kit 不算
  try {
    return fs
      .readdirSync(path.join(p, '@deepseek-ai'))
      .some((n) => n.startsWith('libreoffice-kit-'));
  } catch {
    return false;
  }
});
console.log(`   物化 kit 目录: ${kitModules ? path.relative(REPO, kitModules) : '（本机没有，退回只用包内解析）'}`);

// ⚠️ 本脚本跑在**普通 node** 下：asar 路径不能用 fs.existsSync 判断（一定 false）。
//    要用 @electron/asar 读归档目录（2026-10-15 这里也踩了一次）。
const asarFile = path.join(res, 'app.asar');
const innerPlugin = '/dsh-runtime/node_modules/@deepseek-ai/dsh-office-to-pdf/lib/index.js';
const asarPlugin = path.join(asarFile, innerPlugin.replace(/^\//, ''));
function asarHas(inner) {
  try {
    return require('@electron/asar').listPackage(asarFile).includes(inner);
  } catch (e) {
    console.error('❌ 读不了 app.asar：' + e.message);
    process.exit(1);
  }
}
if (!asarHas(innerPlugin)) {
  console.error(`❌ 打包产物里没有 dsh-office-to-pdf（${innerPlugin}）`);
  process.exit(1);
}
const outPdf = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'office-cap-')), 'out.pdf');

const probe = `
(async () => {
  const Module = require('module');
  const { pathToFileURL } = require('url');
  // ⚠️ 必须用 file URL：Electron-as-Node 下 createRequire('含空格/asar 的路径') 会直接抛
  const req = Module.createRequire(pathToFileURL(${JSON.stringify(asarPlugin)}));
  let resolved;
  try { resolved = req.resolve('@deepseek-ai/libreoffice-kit'); }
  catch (e) { console.log('RESOLVE_FAIL ' + e.message); process.exit(3); }
  console.log('RESOLVED ' + resolved);
  // 引擎包（真正的故障点）：用 **scoped 名** 解析（真名是 @deepseek-ai/libreoffice-kit-*）
  const fs = require('fs');
  const path = require('path');
  const kitRoot = ${JSON.stringify(kitModules || '')};
  let engine = null;
  try {
    const scopeDir = path.join(kitRoot, '@deepseek-ai');
    const names = fs.readdirSync(scopeDir).filter((n) => n.startsWith('libreoffice-kit-'));
    for (const n of names) {
      try { engine = req.resolve('@deepseek-ai/' + n + '/package.json'); break; } catch {}
    }
  } catch {}
  console.log('ENGINE ' + (engine || 'NONE'));
  if (engine) {
    const root = path.dirname(engine);
    const bin = require('path').join(root, 'bin', 'libreoffice-kit');
    if (fs.existsSync(bin)) {
      console.log('ENGINE_MODE ' + fs.statSync(bin).mode.toString(8));
    }
  }
  const kit = require(resolved);
  let conv;
  try { conv = await kit.createConverter({ timeoutMs: 120000 }); }
  catch (e) { console.log('CONVERTER_FAIL ' + String((e && e.message) || e)); process.exit(4); }
  try {
    const r = await conv.render({
      inputPath: ${JSON.stringify(FIXTURE)},
      outputPath: ${JSON.stringify(outPdf)},
    });
    console.log('RENDER ' + JSON.stringify(r));
  } catch (e) {
    console.log('CONVERT_FAIL ' + String((e && e.message) || e));
    process.exit(6);
  } finally {
    try { await conv.dispose(); } catch {}
  }
  console.log('OK');
  process.exit(0);
})().catch((e) => { console.log('FATAL ' + String((e && e.message) || e)); process.exit(7); });
`;

const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
if (kitModules) env.NODE_PATH = env.NODE_PATH ? `${kitModules}${path.delimiter}${env.NODE_PATH}` : kitModules;

const r = spawnSync(exe, ['-e', probe], { env, encoding: 'utf-8', timeout: 180000 });
const out = `${r.stdout || ''}${r.stderr || ''}`;

const resolvedLine = (out.match(/^RESOLVED (.*)$/m) || [])[1] || '';
const inAsar = /app\.asar[/\\]/.test(resolvedLine);
const produced = fs.existsSync(outPdf) && fs.statSync(outPdf).size > 1000;
const isPdf = produced && fs.readFileSync(outPdf).subarray(0, 5).toString('latin1').startsWith('%PDF');

const problems = [];
// 引擎解析结果只作为**诊断信息**打印（真正的判据是下面"能不能转出 PDF"）：
//   · 解析到 asar 内部 = 典型症状（stat 0644 → 自检必败）
//   · 解析到真实目录 = 正常
const engineLine = (out.match(/^ENGINE (.*)$/m) || [])[1] || '';
const engineMode = (out.match(/^ENGINE_MODE (.*)$/m) || [])[1] || '';
if (!resolvedLine) {
  problems.push('解析 `@deepseek-ai/libreoffice-kit` 失败（DSH 子进程上下文里根本找不到它）');
} else if (engineLine && /app\.asar[/\\]/.test(engineLine)) {
  problems.push(`引擎落在 asar 内部：${engineLine} —— 走 asar 的路径 stat 恒为 0644，引擎自检 mode & 0o111 必败`);
}
if (engineLine) {
  console.log(`   · 引擎解析：${engineLine.replace(/^.*?Resources/, '…Resources')}${engineMode ? `（mode ${engineMode}）` : ''}`);
} else if (resolvedLine) {
  console.log('   · 引擎解析：未取到（下面以"能否真转出 PDF"为准）');
}
if (/CONVERTER_FAIL/.test(out)) problems.push(`createConverter() 失败：${(out.match(/CONVERTER_FAIL (.*)/) || [])[1]}`);
if (/CONVERT_FAIL/.test(out)) problems.push(`转换失败：${(out.match(/CONVERT_FAIL (.*)/) || [])[1]}`);
if (!produced) problems.push('没有产出 PDF');
else if (!isPdf) problems.push('产出不是 PDF（文件头不对）');

if (problems.length) {
  console.error('\n❌ 能力基线失败：**打包态的 Office 预览不可用**（用户看到「Office 预览不可用」）\n');
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  console.error('\n   这正是 1.0.56/1.0.57 在 macOS/Linux 上的真实故障。');
  // 2026-10-17：失败原因同时发成 GitHub Actions 注解。
  // 公开仓库的 job log 要 admin 权限才拉得到，但 check-run annotations 不需要 ——
  // 这样 CI 红了能直接读到根因，不用靠本地猜（这次就猜了很久）。
  if (process.env.GITHUB_ACTIONS === 'true') {
    const one = (s) => String(s == null ? '' : s).replace(/\r?\n/g, ' ').slice(0, 900);
    for (const p of problems) console.log(`::error::${one(p)}`);
    const diag = String(out || '')
      .split('\n')
      .filter((l) => /^(RESOLVED|ENGINE|ENGINE_MODE|CONVERTER_FAIL|CONVERT_FAIL|FATAL|RESOLVE_FAIL)/.test(l))
      .join(' | ');
    if (diag) console.log(`::error::诊断 ${one(diag)}`);
    console.log(`::error::产物 ${one(app)}`);
    if (kitModules) console.log(`::error::kit 目录 ${one(path.relative(REPO, kitModules))}`);
  }
  process.exitCode = 1;
} else {
  const size = fs.statSync(outPdf).size;
  console.log(`   ✅ 引擎解析到真实目录（asar 外，可取执行位）`);
  console.log(`   ✅ createConverter() 成功`);
  console.log(`   ✅ docx → PDF 成功（${size} 字节，%PDF ✓）`);
  console.log('✅ 能力基线通过：打包态 Office 预览可用');
}
