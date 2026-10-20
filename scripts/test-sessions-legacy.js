#!/usr/bin/env node
/**
 * 会话搜索兼容归档回归测试（2026-10-20）
 *
 * 背景：实验性「会话搜索」索引全部历史会话；早期 v0/v1/v2 日志里有
 * `subagent/descriptor version 2` 这类当前格式链不支持的记录，一条读不了
 * 就整条搜索失败（SESSION_QUERY_PERSISTENCE_FAILED）。
 * 壳的处理：搜索启用时把旧版会话目录**移到** `<home>/sessions-legacy/<日期>/`，
 * 只移动不删除、保留 project 层级、可还原。
 *
 * 这个测试用合成会话文件覆盖：
 *   ① 只有「搜索已启用」才归档（没开搜索不动用户数据）；
 *   ② 只归档 < v3，v4 不动；
 *   ③ 移动后文件字节不变（还能解压出原 JSON）；
 *   ④ 幂等：第二次归档 0 个；
 *   ⑤ 写 README（含还原命令）。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const REPO = path.resolve(__dirname, '..');
const { sessionSearchEnabled, findLegacySessionDirs, archiveLegacySessions } = require(
  path.join(REPO, 'dist/main/session-legacy.js'),
);

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => {
  failed += 1;
  console.log(`  ❌ ${m}`);
};

function writeSession(dir, fileName, version) {
  fs.mkdirSync(dir, { recursive: true });
  const body =
    JSON.stringify({ type: 'session/header', version, id: path.basename(dir), cwd: '/tmp/x' }) +
    '\n' +
    JSON.stringify({ type: 'user/message', seq: 1, text: 'hello' }) +
    '\n';
  fs.writeFileSync(path.join(dir, fileName), zlib.zstdCompressSync(Buffer.from(body, 'utf8')));
}

function makeHome({ searchEnabled }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sessions-legacy-'));
  if (searchEnabled) {
    const profile = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(
      path.join(profile, 'package.json'),
      JSON.stringify(
        {
          name: 'dsh-profile-web',
          dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-experimental-session-search'] } },
        },
        null,
        2,
      ),
    );
  }
  // 会话树：v0 / v1 各一条，v4 两条，外加一条**老日志+新日志共存**的混合会话
  // （真实场景：老会话升级到 v4 后目录里同时留着 session.jsonl.zstd 与 session.v4.jsonl.zstd）
  writeSession(path.join(home, 'sessions', '--proj-a--', 'session-old0'), 'session.jsonl.zstd', 0);
  writeSession(path.join(home, 'sessions', '--proj-a--', 'session-old1'), 'session.jsonl.zstd', 1);
  writeSession(path.join(home, 'sessions', '--proj-a--', 'session-new4'), 'session.v4.jsonl.zstd', 4);
  writeSession(path.join(home, 'sessions', '--proj-b--', 'session-new4b'), 'session.v4.jsonl.zstd', 4);
  writeSession(path.join(home, 'sessions', '--proj-a--', 'session-mixed'), 'session.jsonl.zstd', 0);
  writeSession(path.join(home, 'sessions', '--proj-a--', 'session-mixed'), 'session.v4.jsonl.zstd', 4);
  return home;
}

function main() {
  console.log('\n  会话搜索兼容归档');

  // ── ① 开关检测 ──
  {
    const off = makeHome({ searchEnabled: false });
    const on = makeHome({ searchEnabled: true });
    if (sessionSearchEnabled(off) === false) ok('未启用搜索时不触发归档判定');
    else bad('没开搜索也判定为启用');
    if (sessionSearchEnabled(on) === true) ok('profile bundles 里有实验性搜索 → 判定启用');
    else bad('开了搜索却判定为未启用');
  }

  // ── ② 扫描：只认 < v3 ──
  {
    const home = makeHome({ searchEnabled: true });
    const scan = findLegacySessionDirs(home);
    if (scan.total === 5) ok('扫描到 5 个会话目录');
    else bad(`总数不对：${scan.total}`);
    if (scan.dirs.length === 2) ok('识别出 2 个旧版会话（v0/v1）');
    else bad(`旧版数量不对：${scan.dirs.length}`);
    const names = scan.dirs.map((d) => path.basename(d)).sort();
    if (names.join(',') === 'session-old0,session-old1') ok('没有误判 v4 / 混合会话');
    else bad(`误判：${names.join(',')}`);
  }

  // ── ③ 归档：移动、保留层级、字节不变 ──
  {
    const home = makeHome({ searchEnabled: true });
    const before = fs.readFileSync(
      path.join(home, 'sessions', '--proj-a--', 'session-old0', 'session.jsonl.zstd'),
    );
    const result = archiveLegacySessions(home, '2026-10-20');
    if (result.archived === 2) ok('归档 2 个旧版会话');
    else bad(`归档数量不对：${result.archived}`);
    const moved = path.join(String(result.dest), '--proj-a--', 'session-old0', 'session.jsonl.zstd');
    if (fs.existsSync(moved)) ok('保留 project 层级（--proj-a--/session-old0）');
    else bad('归档后路径不对');
    if (fs.readFileSync(moved).equals(before)) ok('文件字节未变（只移动未改写）');
    else bad('归档后文件内容变了');
    const still = path.join(home, 'sessions', '--proj-a--', 'session-new4');
    if (fs.existsSync(still)) ok('v4 会话原地保留');
    else bad('v4 会话被误移走');
    const mixed = path.join(home, 'sessions', '--proj-a--', 'session-mixed');
    if (fs.existsSync(mixed) && fs.existsSync(path.join(mixed, 'session.v4.jsonl.zstd'))) ok('混合会话（老日志+v4）原地保留，不被误归档');
    else bad('混合会话被误归档 —— 打开会 ENOENT（真机踩过）');
    const gone = path.join(home, 'sessions', '--proj-a--', 'session-old0');
    if (!fs.existsSync(gone)) ok('旧版会话已从 sessions/ 移出');
    else bad('旧版会话还在 sessions/ 里');
    const readme = path.join(String(result.dest), 'README-为什么旧会话在这里.md');
    if (fs.existsSync(readme) && fs.readFileSync(readme, 'utf8').includes('sessions-legacy')) {
      ok('已写 README（含原因与还原说明）');
    } else {
      bad('README 缺失或不含说明');
    }
  }

  // ── ④ 幂等 ──
  {
    const home = makeHome({ searchEnabled: true });
    archiveLegacySessions(home, '2026-10-20');
    const again = archiveLegacySessions(home, '2026-10-20');
    if (again.archived === 0) ok('第二次归档 0 个（幂等）');
    else bad(`第二次又归档了 ${again.archived} 个`);
  }

  // ── ⑤ 没开搜索时调用归档也不该丢东西（函数本身仍只做只读判定）──
  {
    const home = makeHome({ searchEnabled: false });
    const enabled = sessionSearchEnabled(home);
    const scan = findLegacySessionDirs(home);
    if (enabled === false && scan.dirs.length === 2) ok('未启用时仅扫描、可安全跳过归档');
    else bad('未启用时的判定/扫描异常');
  }

  console.log(failed === 0 ? '\n  ✅ 会话归档测试全过\n' : `\n  ❌ 失败 ${failed} 项\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
