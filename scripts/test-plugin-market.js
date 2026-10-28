#!/usr/bin/env node
/**
 * 官方插件市场索引注入 · 离线回归测试（2026-10-28）
 *
 * 为什么需要：这一步决定**新装用户**打开「插件市场」时是满的 67 个插件，还是空页。
 * 判断标准必须是"写出来的文件对不对"，而不是"函数没报错"，所以这里直接对着临时 home
 * 断言文件内容，并且把三个最容易出事的场景单独立成否定用例：
 *   ① profile 还不存在的首启 → 必须返回 pending，且**一个字都不写**；
 *   ② 用户自己删了我们的索引 → 下次启动**不能**再加回去（播种只做一次）；
 *   ③ 用户已经有别的索引 → 只追加我们的，原有条目（和文件里的注释）必须原样保留。
 *
 * 不启动 Electron、不开窗口：注入模块只依赖 fs/path，可以直接在纯 Node 下调用。
 *
 * 用法：node scripts/test-plugin-market.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const {
  ensurePluginMarket,
  marketSeeded,
  MARKET_BUNDLE,
  MARKET_INDEX_URL,
  MARKET_ROW_ID,
} = require(path.join(REPO, 'dist/main/plugin-market.js'));
const { profileDirOf } = require(path.join(REPO, 'dist/main/profile.js'));

const YAML = (() => {
  try {
    return require(path.join(REPO, 'node_modules/js-yaml'));
  } catch {
    try {
      return require('js-yaml');
    } catch {
      return null;
    }
  }
})();

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ❌ ${name}\n     ${error.message}`);
  }
}

function tempHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-market-test-'));
  return home;
}

/** 造一个"DSH 已经建好 profile"的 home。 */
function makeProfile(home, { bundles = [], patch = '[]\n' } = {}) {
  const dir = profileDirOf(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'deepwhale', dsh: { profile: { bundles } } }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), patch);
  return dir;
}

function readPatch(home) {
  return fs.readFileSync(path.join(profileDirOf(home), 'cordis.patch.yml'), 'utf8');
}

function readManifest(home) {
  return JSON.parse(fs.readFileSync(path.join(profileDirOf(home), 'package.json'), 'utf8'));
}

function parsePatch(text) {
  if (!YAML) throw new Error('需要 js-yaml 才能断言（仓库 devDependencies 里有）');
  return YAML.load(text);
}

const MARKET_ROW_WITH_OTHER = [
  '# 用户自己的配置（这行注释必须保留）',
  '- id: plugin-market',
  '  name: "@deepseek-ai/dsh-plugin-market"',
  '  config:',
  '    indexes:',
  '      - https://example.com/user-index.json',
  '',
].join('\n');

console.log('── ① 首启（profile 还不存在）──');
{
  const home = tempHome();
  const result = ensurePluginMarket(home);
  check('返回 pending=true，且没有写任何文件', () => {
    assert.strictEqual(result.profilePending, true, '首启必须报告 pending');
    assert.strictEqual(result.changed, false, '什么都不该写');
    assert.strictEqual(fs.existsSync(profileDirOf(home)), false, '不该替 DSH 造 profile 目录');
    assert.strictEqual(marketSeeded(home), false, '不该留下播种标记（否则下次就不补了）');
  });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('── ② 运行时里没有官方市场 bundle → 整体跳过 ──');
{
  const home = tempHome();
  makeProfile(home);
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-market-runtime-'));
  const result = ensurePluginMarket(home, runtime);
  check('不往 profile 里写一个装不上的 bundle', () => {
    assert.strictEqual(result.changed, false);
    assert.deepStrictEqual(readManifest(home).dsh.profile.bundles, [], 'bundles 必须保持空');
    assert.strictEqual(readPatch(home), '[]\n', 'patch 必须保持空');
  });
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(runtime, { recursive: true, force: true });
}

console.log('── ③ 空 profile → 写入 bundle + 索引行 + 标记 ──');
{
  const home = tempHome();
  makeProfile(home);
  const result = ensurePluginMarket(home);
  check('bundles 里加上了官方市场 bundle', () => {
    assert.strictEqual(result.changed, true);
    assert.strictEqual(result.profilePending, false);
    assert.deepStrictEqual(readManifest(home).dsh.profile.bundles, [MARKET_BUNDLE]);
  });
  check('patch 里写出了 plugin-market 行 + 我们的索引（YAML 可解析）', () => {
    const parsed = parsePatch(readPatch(home));
    assert.ok(Array.isArray(parsed), 'patch 必须仍是顶层数组');
    const row = parsed.find((entry) => entry && entry.id === MARKET_ROW_ID);
    assert.ok(row, '缺 plugin-market 行');
    assert.deepStrictEqual(row.config.indexes, [MARKET_INDEX_URL]);
    assert.strictEqual(row.name, '@deepseek-ai/dsh-plugin-market');
  });
  check('留下播种标记', () => assert.strictEqual(marketSeeded(home), true));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('── ④ 幂等：第二次调用不再写盘 ──');
{
  const home = tempHome();
  makeProfile(home);
  ensurePluginMarket(home);
  const patchBefore = readPatch(home);
  const manifestBefore = fs.readFileSync(path.join(profileDirOf(home), 'package.json'), 'utf8');
  const result = ensurePluginMarket(home);
  check('changed=false，且文件一个字节都没变', () => {
    assert.strictEqual(result.changed, false);
    assert.strictEqual(readPatch(home), patchBefore);
    assert.strictEqual(
      fs.readFileSync(path.join(profileDirOf(home), 'package.json'), 'utf8'),
      manifestBefore,
    );
  });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('── ⑤ 用户删掉我们的索引 → 不能又给他加回去 ──');
{
  const home = tempHome();
  makeProfile(home);
  ensurePluginMarket(home);
  // 模拟用户在设置里删掉我们的索引（bundle 仍在）
  const dir = profileDirOf(home);
  fs.writeFileSync(
    path.join(dir, 'cordis.patch.yml'),
    '- id: plugin-market\n  name: "@deepseek-ai/dsh-plugin-market"\n  config:\n    indexes: []\n',
  );
  const result = ensurePluginMarket(home);
  check('尊重用户的删除：不重写 patch', () => {
    assert.strictEqual(result.changed, false, '播种标记存在时不该再动 patch');
    assert.ok(!readPatch(home).includes(MARKET_INDEX_URL), '不该把索引加回去');
  });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('── ⑥ 用户已有自己的索引 → 只追加，注释与原有条目都要保留 ──');
{
  const home = tempHome();
  makeProfile(home, { patch: MARKET_ROW_WITH_OTHER });
  const result = ensurePluginMarket(home);
  const text = readPatch(home);
  check('changed=true 且两个索引都在（原来的在前）', () => {
    assert.strictEqual(result.changed, true);
    const parsed = parsePatch(text);
    const row = parsed.find((entry) => entry && entry.id === MARKET_ROW_ID);
    assert.deepStrictEqual(row.config.indexes, ['https://example.com/user-index.json', MARKET_INDEX_URL]);
  });
  check('文件里的注释没被整段重写掉', () => assert.ok(text.includes('这行注释必须保留')));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('── ⑦ 内联写法 indexes: [x] → 换成块状并保留原条目 ──');
{
  const home = tempHome();
  makeProfile(home, {
    patch: '- id: plugin-market\n  name: "@deepseek-ai/dsh-plugin-market"\n  config:\n    indexes: [https://example.com/a.json]\n',
  });
  ensurePluginMarket(home);
  const parsed = parsePatch(readPatch(home));
  const row = parsed.find((entry) => entry && entry.id === MARKET_ROW_ID);
  check('两个索引都在 YAML 里', () => {
    assert.deepStrictEqual(row.config.indexes, ['https://example.com/a.json', MARKET_INDEX_URL]);
  });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('── ⑧ 有 plugin-market 行但没有 config → 补 config.indexes ──');
{
  const home = tempHome();
  makeProfile(home, {
    patch: '- id: plugin-market\n  name: "@deepseek-ai/dsh-plugin-market"\n',
  });
  ensurePluginMarket(home);
  const parsed = parsePatch(readPatch(home));
  const row = parsed.find((entry) => entry && entry.id === MARKET_ROW_ID);
  check('config.indexes 被补出来', () => {
    assert.deepStrictEqual(row.config.indexes, [MARKET_INDEX_URL]);
  });
  fs.rmSync(home, { recursive: true, force: true });
}

console.log('── ⑨ 文件里已有别的行（主题/聊天…）→ 结构不被破坏 ──');
{
  const home = tempHome();
  makeProfile(home, {
    patch: [
      '# Your patch layer for this dsh profile',
      '- id: ui-theme',
      '  name: "@deepseek-ai/dsh-client-ui-theme"',
      '  config:',
      '    preference: system',
      '',
    ].join('\n'),
  });
  ensurePluginMarket(home);
  const parsed = parsePatch(readPatch(home));
  check('原有行还在，且新行被追加', () => {
    assert.strictEqual(parsed.length, 2, `应为 2 行，实际 ${parsed.length}`);
    assert.strictEqual(parsed[0].id, 'ui-theme');
    assert.strictEqual(parsed[1].id, MARKET_ROW_ID);
  });
  fs.rmSync(home, { recursive: true, force: true });
}

if (failed > 0) {
  console.error(`\n❌ ${failed} 个用例失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过');
