#!/usr/bin/env node
/**
 * 守卫：chips 的真值读取（模型/强度/预设/工作区）
 *
 * ⚠️ 必须用**真实插件代码** + **真实投影文件**：之前踩过"测等价逻辑 = 假绿"。
 * 会红的条件：投影里明明有 modelSelection，但 readProjectionMeta 读不出来
 * （实测就踩过——modelSelection.val 是嵌套的，直接读 sel.model 得到空串）。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const HOME_DIR = process.env.DSH_HOME
  || path.join(os.homedir(), 'Library/Application Support/DeepWhale Desktop/dsh-home');
const DIR = path.join(HOME_DIR, 'storages', 'session_projcache', 'sessions');

(async () => {
  if (!fs.existsSync(DIR)) {
    console.log('✅ 跳过：本机还没有会话投影（新装环境）');
    return;
  }
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) {
    console.log('✅ 跳过：投影目录为空');
    return;
  }
  const plugUrl = pathToFileURL(
    path.join(__dirname, '..', 'shell-plugins', 'dsh-shell-mobile', 'lib', 'index.js')
  ).href;
  const { readProjectionMeta } = await import(plugUrl);
  const latest = files
    .map((f) => [f, fs.statSync(path.join(DIR, f)).mtimeMs])
    .sort((a, b) => b[1] - a[1])[0][0];
  const id = latest.replace(/\.json$/, '');
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, latest), 'utf8'));
  const hasModel = JSON.stringify(raw?.record?.rows?.modelSelection ?? {}).includes('"model"');
  const m = readProjectionMeta(id);
  const problems = [];
  if (!m.model && hasModel) problems.push(`投影里有 modelSelection，但没读出模型（${JSON.stringify(raw?.record?.rows?.modelSelection?.val).slice(0, 120)}）`);
  if (!m.preset) problems.push('没读出 agentPreset');
  if (problems.length) {
    console.error('❌ chips 真值读取失败：\n');
    problems.forEach((x, i) => console.error(`   ${i + 1}. ${x}`));
    process.exitCode = 1;
  } else {
    console.log(`✅ chips 真值可读：模型 ${m.model || '（无）'} · 强度 ${m.effort || '（无）'} · 预设 ${m.preset}`);
  }
})();
