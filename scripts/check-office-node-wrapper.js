#!/usr/bin/env node
/**
 * 离线守卫：Office 转换**不许**再依赖 `office-runtime/bin/node`（2026-10-26 真实事故）
 *
 * ── 事故 ──────────────────────────────────────────────────────────────
 * Windows 用户点「打印」永远得到「Office 转换器未就绪」，1.0.61 仍复现。
 * 根因不是引擎缺失，而是：
 *   ① `ensureWrapperNode()` 在 Windows 上写的是 `bin/node.cmd`，而打印/预览两条链路
 *      都硬编码检查 `<home>/office-runtime/bin/node` → existsSync 恒 false；
 *   ② 就算改名成 node.cmd 也没用：Node 18.20+/20.12+ 起 `spawn`/`execFile`
 *      不允许直接执行 `.cmd`（CVE 修复，需 shell:true），走包装本身也脆。
 *
 * 正确做法：直接用自带 Electron 当 Node 跑（`ELECTRON_RUN_AS_NODE=1` + `process.execPath`），
 * 与包装脚本等价，但跨平台无差异。已在 macOS 实测同一条命令能转出 PDF。
 *
 * 这条守卫在 CI 的离线守卫步骤里跑：谁把 `bin/node` 写回来，构建直接红。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const files = [
  path.join(root, 'src', 'main', 'office-preview.ts'),
  path.join(root, 'src', 'main', 'index.ts'),
];

const problems = [];

for (const file of files) {
  const rel = path.relative(root, file);
  let src = '';
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch (e) {
    problems.push(`读不到 ${rel}: ${e.message}`);
    continue;
  }
  // 只找"真的拼路径"的写法：'office-runtime', 'bin', 'node'
  if (/['"]office-runtime['"]\s*,\s*['"]bin['"]\s*,\s*['"]node['"]/.test(src)) {
    problems.push(
      `${rel} 又在拼 \`office-runtime/bin/node\` ——\n` +
        '    Windows 上包装脚本叫 node.cmd，这里永远找不到文件（1.0.61「Office 转换器未就绪」的根因）。\n' +
        '    改用 process.execPath + env ELECTRON_RUN_AS_NODE=1（见 office-preview.ts 的注释）。',
    );
  }
}

// 两条转换链路都必须真的用 Electron-as-Node
for (const file of [path.join(root, 'src', 'main', 'office-preview.ts')]) {
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes('ELECTRON_RUN_AS_NODE') || !src.includes('process.execPath')) {
    problems.push(`${rel} 没有用 process.execPath + ELECTRON_RUN_AS_NODE 跑转换 CLI`);
  }
}
{
  const rel = 'src/main/index.ts';
  const src = fs.readFileSync(path.join(root, rel), 'utf8');
  const 打印段 = src.slice(src.indexOf('async function convertOfficeToPdf'), src.indexOf('async function convertOfficeToPdf') + 4000);
  if (!打印段.includes('ELECTRON_RUN_AS_NODE') || !打印段.includes('process.execPath')) {
    problems.push(`${rel} 的 convertOfficeToPdf 没有用 process.execPath + ELECTRON_RUN_AS_NODE`);
  }
}

if (problems.length) {
  console.error('❌ Office 转换链路守卫失败：\n');
  problems.forEach((p, i) => console.error(`  ${i + 1}. ${p}\n`));
  process.exitCode = 1;
} else {
  console.log('✅ Office 转换链路守卫通过（不再依赖 bin/node，Windows 上也能转）');
}
