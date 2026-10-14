#!/usr/bin/env node
/**
 * 离线守卫：旧 preset id（legal → legal-mode）自愈（2026-10-14 Windows 用户事故回归）
 *
 * 事故：Windows 升级用户「新建会话建不了 / 会话区点不上」，
 *      报 `agent-preset/not-found: Unknown agent preset: legal`。
 * 根因：DSH 把每个会话的 preset 存在会话投影里
 *      （`<home>/storages/session_projcache/sessions/<id>.json` → `record.rows.agentPreset.val`），
 *      早期版本写进去的是 `legal`，而后来的花名册只有 `legal-mode` —— 旧值不会自己变。
 *
 * 本脚本用真机同形的 JSON 断言：
 *   ① 含 `legal` 的会话被改写成 `legal-mode`
 *   ② 已经是 `legal-mode` 的文件**一个字节都不动**
 *   ③ 只是正文里出现 "legal" 字样的会话**不动**（按字段判，不按字符串判）
 *   ④ 坏 JSON / 没有该字段的文件不动
 *   ⑤ 幂等：再跑一次不再改动
 *   ⑥ 留了 .legal-bak 证据，且改写后仍是合法 JSON、其它字段原样
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist', 'main', 'preset-heal.js');
if (!fs.existsSync(dist)) {
  console.error('❌ 找不到编译产物 dist/main/preset-heal.js —— 请先 npm run build');
  process.exit(1);
}
const { healLegacyAgentPreset } = require(dist);

const problems = [];
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail ? `（${detail}）` : ''}`);
};

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preset-heal-'));
const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
fs.mkdirSync(dir, { recursive: true });

/** 真机同形的投影文件 */
function projection(preset, extra = {}) {
  return JSON.stringify({
    version: 3,
    record: {
      identity: { sessionId: extra.sessionId ?? 'x' },
      rows: {
        title: { ver: 1, seq: 7, val: extra.title ?? '一个会话' },
        agentPreset: { ver: 1, seq: 54465, val: preset },
        tokenUsage: { ver: 1, seq: 9, val: { input: 1, output: 2 } },
      },
    },
  });
}

const legalFile = path.join(dir, 'a-legal.json');
const alreadyFile = path.join(dir, 'b-already.json');
const textOnlyFile = path.join(dir, 'c-text-only.json');
const brokenFile = path.join(dir, 'd-broken.json');
const noFieldFile = path.join(dir, 'e-no-field.json');

fs.writeFileSync(legalFile, projection('legal'), 'utf-8');
fs.writeFileSync(alreadyFile, projection('legal-mode'), 'utf-8');
fs.writeFileSync(
  textOnlyFile,
  projection('standard', { title: '聊聊 legal 与合规（只是标题里有这个词）' }),
  'utf-8',
);
fs.writeFileSync(brokenFile, '{"version":3,"record":{"rows":{"agentPreset":{"val":"legal"' /* 故意截断 */, 'utf-8');
fs.writeFileSync(noFieldFile, JSON.stringify({ version: 3, record: { rows: { title: { val: 'x' } } } }), 'utf-8');

const before = {
  already: fs.readFileSync(alreadyFile, 'utf-8'),
  textOnly: fs.readFileSync(textOnlyFile, 'utf-8'),
  broken: fs.readFileSync(brokenFile, 'utf-8'),
  noField: fs.readFileSync(noFieldFile, 'utf-8'),
};

// ① 第一次自愈
const res = healLegacyAgentPreset(home);
check('① 只改了一个文件', res.healed.length === 1, `healed=${res.healed.length}`);
check('① 改的正是那个会话', res.healed[0] === legalFile, String(res.healed[0]));

const afterRaw = fs.readFileSync(legalFile, 'utf-8');
let after = null;
try {
  after = JSON.parse(afterRaw);
} catch (e) {
  problems.push(`① 改写后不是合法 JSON：${e.message}`);
}
if (after) {
  const row = after.record.rows.agentPreset;
  check('① preset 已是 legal-mode', row.val === 'legal-mode', String(row.val));
  check('① 其它字段原样（seq/ver）', row.seq === 54465 && row.ver === 1, JSON.stringify(row));
  check(
    '① 其它行原样（title / tokenUsage）',
    after.record.rows.title.val === '一个会话' && after.record.rows.tokenUsage.val.input === 1,
  );
}
check('① 留了 .legal-bak 备份', fs.existsSync(`${legalFile}.legal-bak`));
const backup = JSON.parse(fs.readFileSync(`${legalFile}.legal-bak`, 'utf-8'));
check('① 备份里仍是旧值（可回溯）', backup.record.rows.agentPreset.val === 'legal');

// ②③④ 不该动的，一个字节都不许变
check('② 已是 legal-mode 的文件未被改动', fs.readFileSync(alreadyFile, 'utf-8') === before.already);
check('③ 只是正文里有 "legal" 的会话未被改动', fs.readFileSync(textOnlyFile, 'utf-8') === before.textOnly);
check('④ 坏 JSON 未被改动', fs.readFileSync(brokenFile, 'utf-8') === before.broken);
check('④ 没有该字段的文件未被改动', fs.readFileSync(noFieldFile, 'utf-8') === before.noField);

// ⑤ 幂等
const again = healLegacyAgentPreset(home);
check('⑤ 幂等（第二次不再改动）', again.healed.length === 0, `healed=${again.healed.length}`);

// ⑥ 目录不存在时不能抛（全新安装 / 从没启动过 DSH）
{
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-preset-fresh-'));
  let threw = false;
  let r = null;
  try {
    r = healLegacyAgentPreset(fresh);
  } catch {
    threw = true;
  }
  check('⑥ 没有 storages 目录时不抛错', !threw);
  check('⑥ 没有 storages 目录时报告 0 个', r !== null && r.healed.length === 0);
  fs.rmSync(fresh, { recursive: true, force: true });
}

fs.rmSync(home, { recursive: true, force: true });

if (problems.length) {
  console.error('❌ 旧 preset id 自愈守卫失败：');
  problems.forEach((p) => console.error('  · ' + p));
  process.exitCode = 1;
} else {
  console.log('✅ 旧 preset id 自愈守卫通过（legal → legal-mode · 旁人零改动 · 幂等 · 留证据 · 目录缺失不抛）');
}
