#!/usr/bin/env node
/**
 * 组装「深鲸套装」三平台合体包。
 *
 * 背景：套装此前是**纯手工**打的（下载壳和律师端的产物 → 手工改名 → 手工压缩 →
 * 手工核对 sha256），所以它总是落后于壳（发到 1.0.16 时套装还停在 1.0.15）。
 * 这个脚本把整件事变成一条命令。
 *
 * 用法：
 *   node scripts/build-suite.js \
 *     --shell-version 1.0.17 --lawyer-version 0.1.1 \
 *     --artifacts <存放各平台产物的目录> --out <输出目录>
 *
 * `<artifacts>` 需包含 6 个文件（缺失的平台会被跳过并告警）：
 *   DeepWhale-Desktop-<shell>-arm64.zip         壳 · macOS arm64
 *   DeepWhale-Desktop-<shell>-x64-Setup.exe     壳 · Windows x64
 *   DeepWhale-Desktop-<shell>-x86_64.AppImage   壳 · Linux x64
 *   DeepWhale-Lawyer-<lawyer>-arm64.zip         律师端 · macOS arm64
 *   DeepWhale-Lawyer-<lawyer>-x64-Setup.exe     律师端 · Windows x64
 *   DeepWhale-Lawyer-<lawyer>-x86_64.AppImage   律师端 · Linux x64
 *
 * 产出（`<out>` 目录）：
 *   DeepWhale-Suite-<shell>-macOS-arm64.zip
 *   DeepWhale-Suite-<shell>-Windows-x64.zip
 *   DeepWhale-Suite-<shell>-Linux-x64.zip
 *   套装四平台-sha256.txt       ← 发布前核对用
 *   安装说明.txt                ← 单独一份，便于直接查看/贴给用户
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

/** 四个平台：key → { 壳产物后缀, 律师端产物后缀 }。key 直接进套装文件名。 */
const PLATFORMS = [
  { key: 'macOS-arm64', shell: '-arm64.zip', lawyer: '-arm64.zip', label: 'macOS arm64' },
  // Intel Mac 同样要有：壳本来就出 x64 zip，律师端也已补上 x64（见 lawyer-build.yml）
  { key: 'macOS-x64', shell: '-x64.zip', lawyer: '-x64.zip', label: 'macOS x64（Intel）' },
  { key: 'Windows-x64', shell: '-x64-Setup.exe', lawyer: '-x64-Setup.exe', label: 'Windows x64' },
  {
    key: 'Linux-x64',
    shell: '-x86_64.AppImage',
    lawyer: '-x86_64.AppImage',
    label: 'Linux x64',
  },
];

function parseArgs(argv) {
  const out = { artifacts: '.', out: 'suite-out' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    out[key] = argv[i + 1];
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const shellVersion = args['shell-version'];
  const lawyerVersion = args['lawyer-version'];
  if (!shellVersion || !lawyerVersion) {
    throw new Error('missing --shell-version / --lawyer-version');
  }
  const artifacts = path.resolve(args.artifacts);
  const outDir = path.resolve(args.out);
  fs.mkdirSync(outDir, { recursive: true });

  // 安装说明：由模板填版本号。模板缺失就直接报错——说明是套装的一部分，
  // 少了它等于发了一个"用户不知道怎么装"的包。
  const templatePath = path.join(__dirname, 'suite-install-guide.template.txt');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`install guide template missing: ${templatePath}`);
  }
  const guide = fs
    .readFileSync(templatePath, 'utf8')
    .replaceAll('{{SHELL_VERSION}}', shellVersion)
    .replaceAll('{{LAWYER_VERSION}}', lawyerVersion);
  const guidePath = path.join(outDir, '安装说明.txt');
  fs.writeFileSync(guidePath, guide);
  console.log(`[suite] 安装说明已生成（壳 ${shellVersion} / 律师端 ${lawyerVersion}）`);

  const manifest = [];
  const skipped = [];

  for (const platform of PLATFORMS) {
    const shellFile = `DeepWhale-Desktop-${shellVersion}${platform.shell}`;
    const lawyerFile = `DeepWhale-Lawyer-${lawyerVersion}${platform.lawyer}`;
    const shellPath = path.join(artifacts, shellFile);
    const lawyerPath = path.join(artifacts, lawyerFile);

    const missing = [shellPath, lawyerPath].filter((p) => !fs.existsSync(p));
    if (missing.length > 0) {
      for (const p of missing) console.warn(`[suite] 跳过 ${platform.label}：缺少 ${path.basename(p)}`);
      skipped.push(platform.label);
      continue;
    }

    // 暂存目录：套装 zip 的顶层就是这几个文件（不含外层目录），
    // 用户解压出来直接看到「壳 + 律师端 + 说明」。
    const stage = path.join(outDir, `.stage-${platform.key}`);
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    fs.copyFileSync(shellPath, path.join(stage, shellFile));
    fs.copyFileSync(lawyerPath, path.join(stage, lawyerFile));
    fs.copyFileSync(guidePath, path.join(stage, '安装说明.txt'));

    const suiteName = `DeepWhale-Suite-${shellVersion}-${platform.key}.zip`;
    const suitePath = path.join(outDir, suiteName);
    fs.rmSync(suitePath, { force: true });
    // 用 Python 的 zipfile 而不是 `zip` 命令：macOS 自带的 Info-ZIP 不写 UTF-8 标志位，
    // 中文名（安装说明.txt）在 Windows 上会显示成乱码。详见 scripts/zip_utf8.py。
    execFileSync(
      'python3',
      [
        path.join(__dirname, 'zip_utf8.py'),
        suitePath,
        path.join(stage, shellFile),
        path.join(stage, lawyerFile),
        path.join(stage, '安装说明.txt'),
      ],
      { stdio: 'inherit' },
    );
    fs.rmSync(stage, { recursive: true, force: true });

    const size = fs.statSync(suitePath).size;
    const digest = sha256(suitePath);
    manifest.push(`${digest} ${suiteName}`);
    console.log(`[suite] ✅ ${suiteName}  ${(size / 1048576).toFixed(1)} MB`);
  }

  if (manifest.length === 0) throw new Error('没有生成任何套装包');

  fs.writeFileSync(path.join(outDir, '套装四平台-sha256.txt'), `${manifest.join('\n')}\n`);
  console.log('[suite] sha256 清单已写入 套装四平台-sha256.txt');
  if (skipped.length > 0) {
    console.warn(`[suite] ⚠️ 跳过了 ${skipped.length} 个平台：${skipped.join('、')}`);
    process.exitCode = 2;
  }
  console.log(`[suite] done → ${outDir}`);
}

try {
  main();
} catch (error) {
  console.error('[suite] failed:', error.message);
  process.exit(1);
}
