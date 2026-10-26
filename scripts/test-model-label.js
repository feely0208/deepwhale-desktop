#!/usr/bin/env node
/**
 * 模型显示名补丁「清理」回归（2026-10-26 反转）
 *
 * 背景：1.0.60/1.0.61 往 home patch 里写过 `shell:model-label` 块，把
 * `deepseek-flash` 的显示名覆盖成 `DeepSeek-V4.1-Flash-1017`（纯文本）。
 *
 * 但官方自带 1017 徽章插件，渲染条件是硬编码的：
 *    provider.id ∈ { deepseek-account, deepseek-official }
 *    && model.id === 'deepseek-flash'
 *    && model.name === 'DeepSeek-V4.1-Flash'      ← 必须一字不差
 *
 * API key 那条 provider 的 id 正好是 `deepseek-official`，默认名就是
 * `DeepSeek-V4.1-Flash` —— 不改名才有官方徽章。所以我们改成**把老补丁删掉**。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const yaml = require(path.join(REPO, 'node_modules', 'js-yaml'));
const { removeModelLabelPatch, MODEL_LABEL_MARKER, MODEL_LABEL_BLOCK } = require(
  path.join(REPO, 'dist/main/patch-extras.js'),
);

let failed = 0;
const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m, e) => { failed += 1; console.log(`  ❌ ${m}${e ? `：${e.message}` : ''}`); };
const 检查 = (name, fn) => { try { fn(); ok(name); } catch (e) { bad(name, e); } };

const tmpHome = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `dsh-model-label-${tag}-`));
const patchFile = (home) => path.join(home, 'cordis.patch.yml');

console.log('\n  模型显示名补丁清理');

// ① 有块 + 其它块：只删本块
{
  const home = tmpHome('mixed');
  const 其它 = ['- id: webserver', '  config:', '    port: 3095', '', '- id: office', '  disabled: false', ''].join('\n');
  fs.writeFileSync(patchFile(home), `${其它}\n${MODEL_LABEL_BLOCK}\n`);

  检查('有块：删除返回 true', () => assert.equal(removeModelLabelPatch(home), true));
  检查('有块：标记与改名都消失', () => {
    const 现在 = fs.readFileSync(patchFile(home), 'utf8');
    assert.equal(现在.includes(MODEL_LABEL_MARKER), false);
    assert.equal(现在.includes('DeepSeek-V4.1-Flash-1017'), false);
  });
  检查('有块：YAML 仍合法、其它块还在', () => {
    const 解析 = yaml.load(fs.readFileSync(patchFile(home), 'utf8'));
    assert.ok(Array.isArray(解析), 'patch 应是 YAML 数组');
    const ids = 解析.map((r) => r && r.id);
    assert.ok(ids.includes('webserver'));
    assert.ok(ids.includes('office'));
    assert.equal(ids.includes('llm-deepseek'), false);
  });
  检查('幂等：再调一次返回 false 且文件不变', () => {
    const 前 = fs.readFileSync(patchFile(home), 'utf8');
    assert.equal(removeModelLabelPatch(home), false);
    assert.equal(fs.readFileSync(patchFile(home), 'utf8'), 前);
  });
}

// ② 没有块：不动文件
{
  const home = tmpHome('clean');
  const 原 = '- id: webserver\n  config:\n    port: 3095\n';
  fs.writeFileSync(patchFile(home), 原);
  检查('没有块：返回 false、内容不变', () => {
    assert.equal(removeModelLabelPatch(home), false);
    assert.equal(fs.readFileSync(patchFile(home), 'utf8'), 原);
  });
}

// ③ 只有这一块：清成空文件
{
  const home = tmpHome('only');
  fs.writeFileSync(patchFile(home), `${MODEL_LABEL_BLOCK}\n`);
  检查('只有块：删干净后是空文件', () => {
    assert.equal(removeModelLabelPatch(home), true);
    assert.equal(fs.readFileSync(patchFile(home), 'utf8'), '');
  });
}

// ④ 文件不存在
{
  const home = tmpHome('none');
  检查('文件不存在：返回 false 且不报错', () => assert.equal(removeModelLabelPatch(home), false));
}

console.log(failed ? `\n  失败 ${failed}\n` : '\n  全部通过\n');
process.exit(failed ? 1 : 0);
