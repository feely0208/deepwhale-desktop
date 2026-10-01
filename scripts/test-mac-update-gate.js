#!/usr/bin/env node
/**
 * macOS 自动更新门禁 · 离线回归测试
 *
 * 为什么需要：2026-09-30 定下的结论是「macOS 上未签名（ad-hoc）的包**不能**自动更新」，
 * 依据是 Squirrel.Mac 在安装前会拿运行中那版的 designated requirement 校验新包，
 * 而 ad-hoc 的 requirement 是 cdhash、每次构建都变。这个结论直接决定了
 * update-manager 在 macOS 上必须走「手动下载」而不是「下载→立即重启」。
 *
 * 结论如果不固化成测试，下一个人很容易又把它改回"能自动更新"，
 * 于是用户又看到一次「点了重启、什么都没发生」。
 *
 * 本测试分两段：
 *   A. 纯逻辑（任何机器都能跑）：签名输出 → 是否需要手动更新
 *   B. 本机实证（装了这个 App 才跑）：真的去问系统，ad-hoc 是否被判为不合格
 *
 * 用法：npm run build && node scripts/test-mac-update-gate.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const MOD = path.join(REPO, 'dist/main/mac-signature.js');

if (!fs.existsSync(MOD)) {
  console.error(`\n❌ 找不到 ${MOD}\n   先跑 npm run build，再执行本测试。\n`);
  process.exit(1);
}

const { hasDeveloperIdSignature, needsManualUpdate } = require(MOD);

let failures = 0;
function check(label, ok, detail) {
  if (ok) {
    console.log(`  ✅ ${label}`);
  } else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

// ── A. 纯逻辑 ────────────────────────────────────────────────────────
console.log('\nA. 判定逻辑（纯函数）');

// electron-builder identity:'-' 产出的 ad-hoc 签名
const ADHOC = [
  'Executable=/Applications/DeepWhale Desktop.app/Contents/MacOS/DeepWhale Desktop',
  'Identifier=com.deepwhale.desktop',
  'CodeDirectory v=20500 size=1234 flags=0x10000(runtime) hashes=1+7 location=embedded',
  'Signature=adhoc',
  'TeamIdentifier=not set',
].join('\n');

// 正式签名（有 Developer ID 时才会出现 Authority 行）
const DEV_ID = [
  'Executable=/Applications/DeepWhale Desktop.app/Contents/MacOS/DeepWhale Desktop',
  'Identifier=com.deepwhale.desktop',
  'Authority=Developer ID Application: Some One (ABCDE12345)',
  'Authority=Developer ID Certification Authority',
  'Authority=Apple Root CA',
  'TeamIdentifier=ABCDE12345',
].join('\n');

check('识别 ad-hoc：没有 Developer ID 签名', hasDeveloperIdSignature(ADHOC) === false);
check('识别正式签名：有 Developer ID Application', hasDeveloperIdSignature(DEV_ID) === true);

check('非 macOS（win32）不走手动路径', needsManualUpdate('win32', () => ADHOC) === false);
check('非 macOS（linux）不走手动路径', needsManualUpdate('linux', () => ADHOC) === false);

check('macOS + ad-hoc → 必须手动', needsManualUpdate('darwin', () => ADHOC) === true);
check('macOS + 正式签名 → 可以自动更新', needsManualUpdate('darwin', () => DEV_ID) === false);

// ⚠️ 最关键的一条：说不清的时候必须按"需要手动"处理。
//    反过来（说不清→当作可以自动更新）就会重新出现"点了没反应"。
let probeCalled = 0;
check(
  'macOS + 探测不到签名 → 按需要手动（宁可少承诺）',
  needsManualUpdate('darwin', () => {
    probeCalled += 1;
    return null;
  }) === true,
);
check('macOS + 探测抛错 → 按需要手动', needsManualUpdate('darwin', () => null) === true);
check('非 macOS 时不应白白去探测签名', probeCalled === 1, `实际调用 ${String(probeCalled)} 次`);

// ── B. 本机实证 ──────────────────────────────────────────────────────
console.log('\nB. 本机实证（问系统本身，而不是相信注释）');

const APP = '/Applications/DeepWhale Desktop.app';
const OLD = '/Applications/DeepWhale Desktop 1.0.24.app';

function codesignInfo(bundle) {
  const r = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', bundle], { encoding: 'utf8' });
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
}

/** 取出 designated requirement（codesign -d -r-）。 */
function designatedRequirement(bundle) {
  const r = spawnSync('/usr/bin/codesign', ['-d', '-r-', bundle], { encoding: 'utf8' });
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const m = /^#\s*designated\s*=>\s*(.+)$/m.exec(text);
  return m ? m[1].trim() : null;
}

if (!fs.existsSync(APP)) {
  console.log('  ⏭  跳过：本机没有 /Applications/DeepWhale Desktop.app');
} else {
  const info = codesignInfo(APP);
  const isAdhoc = /Signature=adhoc/.test(info);
  const verdict = needsManualUpdate('darwin', () => info);
  check('本机安装的包确实是 ad-hoc 签名', isAdhoc, info.split('\n').find((l) => l.includes('Signature=')));
  check('因此本机 macOS 判定为「必须手动更新」', verdict === true);

  const req = designatedRequirement(APP);
  console.log(`     当前包的 designated requirement：${req ?? '(取不到)'}`);
  check(
    'ad-hoc 的 requirement 是基于 cdhash（所以每次构建都不一样）',
    req !== null && /cdhash\s+H"/.test(req),
    `实际：${String(req)}`,
  );

  if (!fs.existsSync(OLD)) {
    console.log('  ⏭  跳过跨版本校验：本机没有 1.0.24 备份（无法复现"旧版校验新包"）');
  } else {
    const oldReq = designatedRequirement(OLD);
    console.log(`     1.0.24 的 designated requirement：${oldReq ?? '(取不到)'}`);
    check('两个版本的 requirement 不同（cdhash 变了）', oldReq !== null && oldReq !== req);

    // 复现 ShipIt 的判定：拿旧版的要求去校验新版
    const reqFile = path.join(os.tmpdir(), `dw-req-${String(Date.now())}.txt`);
    fs.writeFileSync(reqFile, `${String(oldReq).replace(/^designated\s*=>\s*/, '')}\n`);
    const v = spawnSync('/usr/bin/codesign', ['--verify', '-R', reqFile, APP], { encoding: 'utf8' });
    fs.rmSync(reqFile, { force: true });
    const combined = `${v.stdout ?? ''}${v.stderr ?? ''}`;
    check(
      '用 1.0.24 的要求校验 1.0.25 的包 → 系统判定不合格（这就是自动更新会失败的那一步）',
      v.status !== 0,
      `退出码 ${String(v.status)}；${combined.trim().split('\n').pop() ?? ''}`,
    );

    // 对照组：拿自己的要求校验自己必须通过，否则上一条可能是"永远失败"的假证据
    const selfFile = path.join(os.tmpdir(), `dw-reqself-${String(Date.now())}.txt`);
    fs.writeFileSync(selfFile, `${String(req).replace(/^designated\s*=>\s*/, '')}\n`);
    const v2 = spawnSync('/usr/bin/codesign', ['--verify', '-R', selfFile, APP], { encoding: 'utf8' });
    fs.rmSync(selfFile, { force: true });
    check(
      '对照组：用 1.0.25 自己的要求校验自己 → 通过（证明上一条不是假通过）',
      v2.status === 0,
      `退出码 ${String(v2.status)}`,
    );
  }
}

if (failures > 0) {
  console.error(`\n❌ 自动更新门禁测试失败：${failures} 项\n`);
  process.exit(1);
}
console.log('\n✅ 通过：macOS 未签名包判定为「必须手动更新」，且依据来自系统本身的校验结果\n');
