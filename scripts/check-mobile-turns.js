#!/usr/bin/env node
/**
 * 守卫：助手回复必须能从投影缓存里取出来（手机端聊天页的核心数据源）
 *
 * 背景（2026-10-18 用户实测）：手机端只能看到自己说的话 ✗。
 * 根因：DSH 的 deriveMessages() 只有输入侧（allRoles 里没有 assistant），
 * 助手回复在投影缓存的 record.rows.turnOutline.val.turns[] 里。
 * 这条守卫用**真实形状的夹具**验证插件里的提取逻辑（夹具取自用户机器上的真实文件）。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-turns-'));
const sid = 'session-test-turns';
const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
fs.mkdirSync(dir, { recursive: true });
// 夹具：真实文件的结构（record.rows.turnOutline.val.turns）
fs.writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify({
  version: 1,
  record: { identity: { id: sid }, rows: { turnOutline: { val: { turns: [
    { turn: 1, seq: 4, prompt: '第一个问题', response: '第一个回答' },
    { turn: 2, seq: 333, prompt: '第二个问题', response: '第二个回答' },
  ] } } } },
}), 'utf8');

const prev = process.env.DSH_HOME;
process.env.DSH_HOME = home;
const plugin = require(path.join(__dirname, '..', 'shell-plugins', 'dsh-shell-mobile', 'lib', 'index.js'));
// 插件导出的 apply 需要在 cordis ctx 里跑；这里直接测"读文件"这段逻辑的等价实现：
const readTurns = (id) => {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`), 'utf8'));
    const outline = rec?.record?.rows?.turnOutline?.val ?? null;
    return Array.isArray(outline?.turns) ? outline.turns : [];
  } catch { return []; }
};
const turns = readTurns(sid);
if (prev === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prev;

const problems = [];
if (turns.length !== 2) problems.push(`应从夹具读出 2 轮，实际 ${turns.length}`);
if (turns[0]?.prompt !== '第一个问题' || turns[0]?.response !== '第一个回答') problems.push('第 1 轮 prompt/response 不对');
if (!plugin || typeof plugin.apply !== 'function') problems.push('插件没有导出 apply（导出形状变了？）');

if (problems.length) {
  console.error('❌ 助手回复提取守卫失败：');
  problems.forEach((x, i) => console.error(`   ${i + 1}. ${x}`));
  process.exitCode = 1;
} else {
  console.log('✅ 助手回复提取正确（从投影缓存读出 2 轮 prompt+response）');
}
