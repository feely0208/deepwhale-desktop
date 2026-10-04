#!/usr/bin/env node
/**
 * 离线守卫：patch 文件损坏自愈（2026-10-04 用户事故回归）
 *
 * 事故：Windows 自动更新中途杀进程 → `cordis.patch.yml` 留下空字节 →
 * DSH 解析失败 → 用户看到「深鲸桌面无法连接到 DSH 服务」。
 * 该脚本复制那份损坏文件，断言 healPatchFiles() 能修好它，并留下 .corrupt-* 证据。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist', 'main', 'patch-heal.js');
if (!fs.existsSync(dist)) {
  console.error('❌ 找不到编译产物 dist/main/patch-heal.js —— 请先 npm run build');
  process.exit(1);
}
const { healPatchFiles, writeFileAtomic } = require(dist);

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-patch-heal-'));
fs.mkdirSync(path.join(home, 'profiles', 'deepwhale'), { recursive: true });

// ① home 级 patch：空字节（复刻用户那份）
const homePatch = path.join(home, 'cordis.patch.yml');
fs.writeFileSync(homePatch, 'insert:\u0000\u0000\n  - id: x\n', 'utf-8');
// ② profile 级 patch：中间夹空字节
const profPatch = path.join(home, 'profiles', 'deepwhale', 'cordis.patch.yml');
fs.writeFileSync(profPatch, '# fine\n\u0000insert: []\n', 'utf-8');
// ③ 正常文件：不应被改动
const good = path.join(home, 'profiles', 'deepwhale', 'good.yml');
fs.writeFileSync(good, 'insert: []\n', 'utf-8');

const res = healPatchFiles(home);
const problems = [];
if (res.checked < 2) problems.push(`只检查到 ${res.checked} 个文件（应 >=2）`);
if (res.healed.length !== 2) problems.push(`修复了 ${res.healed.length} 个文件（应为 2）`);
for (const f of [homePatch, profPatch]) {
  const t = fs.readFileSync(f, 'utf-8');
  if (t.includes('\u0000')) problems.push(`${path.basename(f)} 仍有空字节`);
  if (t.trim().length === 0) problems.push(`${path.basename(f)} 被清空了（应为最小合法文件或保留可用内容）`);
}
const backups = fs.readdirSync(home).filter((n) => n.startsWith('cordis.patch.yml.corrupt-'));
if (backups.length !== 1) problems.push(`home 级备份文件数 = ${backups.length}（应为 1）`);
if (fs.readFileSync(good, 'utf-8') !== 'insert: []\n') problems.push('正常文件被误改');

// ④ 原子写：写完不留临时文件
const atom = path.join(home, 'atomic.yml');
writeFileAtomic(atom, 'insert: []\n');
if (fs.readFileSync(atom, 'utf-8') !== 'insert: []\n') problems.push('原子写内容不对');
if (fs.readdirSync(home).some((n) => n.includes('.tmp-'))) problems.push('原子写残留临时文件');

if (problems.length) {
  console.error('❌ patch 自愈守卫失败：');
  problems.forEach((p) => console.error('  · ' + p));
  process.exitCode = 1;
} else {
  console.log('✅ patch 自愈守卫通过（坏文件修复 + 留证据 + 正常文件不动 + 原子写无残留）');
}
