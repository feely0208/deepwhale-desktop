#!/usr/bin/env node
/**
 * 手机端端到端能力断言（**真 DSH**，不是替身）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 断言的事只有一件，但它是整条链的"能不能用"：
 *   我们的手机端界面（由我们自己的插件在 /mobile/ 发出）
 *   → 经我们自己的接口（/mobile/api/sessions）
 *   → 从**真 DSH** 拉到真实会话
 *   → 在页面里渲染出至少一行。
 *
 * 这条链上任何一环断了（插件没进包、路由前缀错、接口返回空、页面没渲染），
 * 断言都会红 —— 这正是我们最需要的"用户视角达标"（而不是"代码写了"）。
 *
 * 用法：node scripts/check-mobile-ui-e2e.js
 *   依赖：dsh-runtime 与 electron（本仓库都有）；会建临时 DSH_HOME，用完即删。
 *   注意：DSH 一律 --no-open 启动，窗口透明不可见，**不会打扰正在工作的人**。
 */
'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'probe-mobile-api.mjs'), '--e2e-ui'], {
  cwd: REPO,
  encoding: 'utf8',
  env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH}` },
  timeout: 300000,
});
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
const m = /E2E_RESULT (\{.*\})/.exec(out);
if (!m) {
  console.error('❌ 手机端 E2E 没拿到结果：');
  console.error(out.slice(-1200));
  process.exit(1);
}
let data = {};
try {
  data = JSON.parse(m[1]);
} catch (e) {
  console.error('❌ E2E 结果不是 JSON:', m[1]);
  process.exit(1);
}
const problems = [];
if (!(data.rows >= 1)) problems.push(`页面里没有渲染出任何会话行（rows=${data.rows}）`);
if (data.health !== 'object') problems.push('数据层未加载（window.dshMobileApi 不是对象）');
if (!data.firstId) problems.push('渲染出的行没有 data-id（会话 id 没传进界面）');
// 核心回路：发一条消息后，会话页必须渲染出真实消息
const chat = data.chat || {};
if (!(chat.messages >= 1)) problems.push(`发消息后会话页没有渲染出消息（messages=${chat.messages}）`);
if (chat.page !== 'chat') problems.push('发消息后没有切到会话页');

if (problems.length) {
  console.error('❌ 手机端 E2E 失败：\n');
  problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
  process.exitCode = 1;
} else {
  console.log(
    `✅ 手机端 E2E 通过：列表 ${data.rows} 行真实会话（${data.firstId}）· 发消息后会话页渲染 ${chat.messages} 条消息` +
      (chat.firstText ? `（首条：「${chat.firstText}…」）` : ''),
  );
}
