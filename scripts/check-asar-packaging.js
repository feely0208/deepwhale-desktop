#!/usr/bin/env node
/**
 * 离线守卫：asar 打包这一对约束（2026-10-14）
 *
 * 用户要求：「桌面端安装的很慢，也会影响 C 盘的空间和使用效率」。
 * 根因是 2026-10-02 为了 Office 预览把 `asar` 关掉了 —— 散文件 26,444 个，
 * Windows 上 Defender 逐个扫，安装会拖到几分钟；本机实测 17,925 个文件。
 *
 * 现在把 asar 改回 true（本机打包实测：**4,109 个文件**，app.asar 单文件 184.9MB，
 * 未解包区 863 个文件，引擎的 3 个可执行文件带 x 位），前提是**这一对约束必须同时成立**：
 *   ① `asarUnpack` 必须把 LibreOffice 引擎与 kit 解包 —— 它们要执行/被 dlopen，
 *      asar 里的文件没有执行位（2026-10-02 那次事故的根因）；
 *   ② `office-runtime.ts` 的物化必须走 asar 安全的 `copyTree()`，**不能**用 `fs.cpSync`
 *      （实测：`fs.cpSync(asar 内的路径 → 真实目录)` 抛 ENOENT）。
 *
 * 只满足一半的表现都是"静默失效"：Office 三件套凭空消失，日志里看不出原因。
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const root = path.join(__dirname, '..');
const problems = [];

const conf = yaml.load(fs.readFileSync(path.join(root, 'electron-builder.yml'), 'utf-8'));
const officeSrc = fs.readFileSync(path.join(root, 'src', 'main', 'office-runtime.ts'), 'utf-8');

// ① asar 必须是开的（1.0.56 的发布意图：文件数从 1.7 万降到四千级）
if (conf.asar !== true) {
  problems.push(
    `electron-builder.yml 的 asar = ${String(conf.asar)}（应为 true）\n` +
      '  → 关掉它意味着运行时按 2.6 万个散文件落盘，Windows Defender 逐个扫 → 安装几分钟、体积更大。\n' +
      '  → 若确实要关（例如某个依赖必须真实文件），请同时更新本守卫并说明原因。',
  );
}

// ② LibreOffice kit **不许进 asar**（2026-10-15 P0-0 事故后的新不变量）
//
// 之前这里断言的是"kit 在 asarUnpack 里"——那是**机制**，而且事实证明它保证不了**能力**：
// asar 里的路径 `stat` 一律报 0644（归档头不带执行位），kit 的自检是
// `stat(path).mode & 0o111`（libreoffice-kit/lib/index.js）→ 打包态必败，
// 用户看到的只有「Office 预览不可用」。所以现在要求：kit 两个包**根本不进 asar**，
// 走 extraResources 发真实目录，DSH 侧用 NODE_PATH 解析。
// （能力本身由 scripts/check-office-preview-packaged.js 在**打包产物**上真跑一遍来断言。）
const files = Array.isArray(conf.files) ? conf.files.map(String) : [];
// ⚠️ 精确匹配：`kit-*` 那条以 `kit` 结尾的前缀开头，用 includes 会被它蒙对（实测反例不红）
const excludedEngine = files.includes('!dsh-runtime/node_modules/@deepseek-ai/libreoffice-kit-*');
const excludedJsKit = files.includes('!dsh-runtime/node_modules/@deepseek-ai/libreoffice-kit');
if (!excludedEngine) {
  problems.push(
    'electron-builder.yml 的 files 没把**平台引擎包** `libreoffice-kit-*` 排除出 asar\n' +
      '  → 走 asar 的路径 stat 恒为 0644，引擎自检 `mode & 0o111` 必败 → 用户看到「Office 预览不可用」（1.0.56/57 的真实故障）。',
  );
}
if (excludedJsKit) {
  problems.push(
    'files 把 JS 侧 `libreoffice-kit` 也排除了 —— **它必须留在 asar 里**\n' +
      '  → 它的依赖闭包（fontkit 等）在运行时 node_modules 里，搬出去会 import 失败（实测：转换报 Cannot find package fontkit）。',
  );
}
const extra = Array.isArray(conf.extraResources) ? conf.extraResources : [];
const shipsEngine = extra.some(
  (e) => typeof e === 'object' && e && String(e.to || '').includes('office-kit'),
);
if (!shipsEngine) {
  problems.push('extraResources 里没有把平台引擎以**真实目录**随包（to: office-kit/@deepseek-ai）');
}
if (Array.isArray(conf.asarUnpack) &&
    conf.asarUnpack.some((u) => String(u).includes('libreoffice-kit'))) {
  problems.push(
    'asarUnpack 里还留着 libreoffice-kit* —— 已改成"引擎不进 asar"，这两条是旧机制的残留，必须删掉\n' +
      '  （留着会让人误以为"解包就够了"，而这正是 1.0.56 假绿的来源）',
  );
}

// ②b DSH 子进程必须能解析到真实目录：NODE_PATH 指向物化后的 kit
const svc = fs.readFileSync(path.join(root, 'src', 'main', 'service-manager.ts'), 'utf-8');
if (!/env\.NODE_PATH\s*=/.test(svc)) {
  problems.push(
    'service-manager.ts 没有给随包 DSH 设 NODE_PATH\n' +
      '  → kit 不在 asar 里之后，DSH 的 office-to-pdf 将解析不到它（P0-0 修复的一半）。',
  );
}

// ③ 物化必须用 copyTree（asar 安全）：不许再出现"直接从运行时 node_modules 往真实目录 cpSync"
if (!/copyTree\(from, to\)/.test(officeSrc)) {
  problems.push('office-runtime.ts 的 copyPackage 没有走 copyTree(from, to) —— 从 asar 复制包会失败');
}
if (/fs\.cpSync\(\s*target/.test(officeSrc)) {
  problems.push(
    'office-runtime.ts 里对引擎回退复制仍用 fs.cpSync —— 引擎没解包时 target 会是 asar 路径，cpSync 读不了 asar',
  );
}
// copyTree 里必须有 asar 判断 + readdir/readFile 分支
if (!/includes\('app\.asar'\)/.test(officeSrc)) {
  problems.push('copyTree 里没有对 app.asar 源的判断 —— 那样 asar 源仍会走 cpSync 然后 ENOENT');
}

if (problems.length) {
  console.error('❌ asar 打包守卫失败：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log(
    '✅ asar 打包守卫通过（asar=true · 平台引擎不进 asar 走 extraResources · JS kit 留在 asar · DSH 侧 NODE_PATH 已接 · 物化走 asar 安全的 copyTree）',
  );
}
