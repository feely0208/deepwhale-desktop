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

// ② 引擎/kit 必须在 asarUnpack 里
const unpack = Array.isArray(conf.asarUnpack) ? conf.asarUnpack : [];
const hasKit = unpack.some((s) => String(s).includes('dsh-runtime/node_modules/@deepseek-ai/libreoffice-kit/**'));
const hasEngine = unpack.some((s) => String(s).includes('dsh-runtime/node_modules/@deepseek-ai/libreoffice-kit-*/**'));
if (!hasKit) problems.push('asarUnpack 缺少 libreoffice-kit/**（Office 预览的 JS 侧）');
if (!hasEngine) {
  problems.push(
    'asarUnpack 缺少 libreoffice-kit-*/**（平台引擎）\n' +
      '  → asar 里的文件模式是 0644 没有执行位，引擎自检会抛\n' +
      '    `Installed LibreOfficeKit executable is not executable`，界面只说"Office 预览不可用"。',
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
    '✅ asar 打包守卫通过（asar=true · 引擎与 kit 已解包 · 物化走 asar 安全的 copyTree）',
  );
}
