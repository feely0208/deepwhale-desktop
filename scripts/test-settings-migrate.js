#!/usr/bin/env node
/**
 * 兜底命令版本迁移回归（2026-10-26）
 *
 * 背景：Windows 1.0.61 用户 settings.json 里存着
 * `npx @deepseek-ai/dsh@0.1.5-rc.1 …`（远古版本）。随包运行时一旦不可用，
 * 壳会静默回退到它 → 用户跑的是 0.1.5：office-to-pdf、1017 徽章、open-in-app 全没有。
 * 这里测迁移函数：只升「我们自己默认形态且更老」的版本，其它一律不动。
 */
'use strict';

const assert = require('assert');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { migrateStaleDshCommand } = require(path.join(REPO, 'dist/main/settings-migrate.js'));
const { DSH_RUNTIME_VERSION } = require(path.join(REPO, 'dist/main/dsh-version.generated.js'));

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m, e) => { failed += 1; console.log(`  ❌ ${m}${e ? `：${e.message}` : ''}`); };
const 检查 = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name, e); } };

console.log(`\n  兜底命令版本迁移（随包版本 ${DSH_RUNTIME_VERSION}）`);

检查('远古 npx 版本 → 升到随包版本', () => {
  const 输入 = 'npx @deepseek-ai/dsh@0.1.5-rc.1 --profile deepwhale --port 3095 --no-open';
  const 输出 = migrateStaleDshCommand(输入);
  assert.ok(输出.includes(`@deepseek-ai/dsh@${DSH_RUNTIME_VERSION}`), 输出);
  assert.ok(输出.includes('--profile deepwhale'), '其它参数要保留');
});

检查('已经是随包版本 → 原封不动', () => {
  const 输入 = `npx @deepseek-ai/dsh@${DSH_RUNTIME_VERSION} web --port 3095`;
  assert.equal(migrateStaleDshCommand(输入), 输入);
});

检查('比随包更新 → 不动（尊重用户提前试新版）', () => {
  const 输入 = 'npx @deepseek-ai/dsh@99.0.0 web';
  assert.equal(migrateStaleDshCommand(输入), 输入);
});

检查('带引号的 npx 路径也升级（仍然是我们的包）', () => {
  const 输入 = '"C:\\Program Files\\nodejs\\npx.cmd" @deepseek-ai/dsh@0.1.5 web';
  const 输出 = migrateStaleDshCommand(输入);
  assert.ok(输出.includes(`@deepseek-ai/dsh@${DSH_RUNTIME_VERSION}`), 输出);
});

检查('完全自定义命令（不含我们的包）→ 不动', () => {
  const 输入 = 'dsh --profile deepwhale --port 3095 --no-open';
  assert.equal(migrateStaleDshCommand(输入), 输入);
});

检查('命令里没有 @deepseek-ai/dsh → 不动', () => {
  const 输入 = 'node ./my-own-dsh.js web --port 3095';
  assert.equal(migrateStaleDshCommand(输入), 输入);
});

console.log(failed ? `\n  失败 ${failed}\n` : '\n  全部通过\n');
process.exit(failed ? 1 : 0);
