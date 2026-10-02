#!/usr/bin/env node
/**
 * 断言「法律模式」真的进了 DSH 的 Agent 预设花名册。
 *
 * ── 为什么必须有（2026-09-28，用户在 Windows 上发现）──────────────────
 * 壳原来把预设写成 `<home>/.agent-presets/legal-mode/`，而随包运行时
 * （0.1.7-rc.2）起**已经不读那个目录了**（运行时自带文档原话：
 * "Nothing reads that directory any more."）。预设改由 bundle 的 patch 携带的
 * `@deepseek-ai/dsh-agent-preset` 声明提供。
 *
 * 后果：三平台的预设选择器里都**没有「法律模式」**，而此前所有检查都说"正常" ——
 * 因为冒烟只断言了**客户端插件**在不在（`COUNT=58 含 ui-legal-mode`），
 * 成品包自检只断言了**载荷文件在不在**。两者都不等于"用户能在选择器里选到它"。
 *
 * 所以这条断言直接跑 `dsh --dump-config`（就是界面读的那份组合树），
 * 查 `preset-legal` 那一行在不在、`config.name` 对不对。
 *
 * 用法：node scripts/check-legal-preset-roster.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const DSH_BIN = path.join(REPO, 'dsh-runtime', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const RUNTIME_MODULES = path.join(REPO, 'dsh-runtime', 'node_modules');
const LEGAL_PAYLOAD = path.join(REPO, 'legal-mode');
const BUNDLE_PAYLOAD = path.join(REPO, 'bundled-plugins');
// ⚠️ 2026-10-02：行 id 从 `preset-legal` 改为 `preset-legal-mode`。
//    原因见 scripts/build-legal-preset-bundle.js 里 PRESET_ID 那段注释：
//    预设 id 必须与 src/main/legal-mode.ts 的 PRESET_ID（legal-mode）
//    以及覆盖层插件的比对值一致，否则切到法律模式**覆盖层永远不弹**。
const EXPECTED_ROW = 'preset-legal-mode';
const EXPECTED_NAME = '法律模式';

function fail(msg) {
  console.error(`\n❌ ${msg}\n`);
  process.exit(1);
}

for (const [p, label] of [
  [DSH_BIN, 'dsh-runtime（先准备随包运行时）'],
  [path.join(LEGAL_PAYLOAD, 'preset'), 'legal-mode/preset 载荷'],
  [path.join(BUNDLE_PAYLOAD, 'dsh-legal-preset', 'cordis.patch.yml'), '法律模式 bundle（先跑 npm run build）'],
]) {
  if (!fs.existsSync(p)) fail(`前置缺失：${label} → ${p}`);
}

const { ensureLegalModeSetup } = require(path.join(REPO, 'dist/main/legal-mode.js'));
const { ensureBundledPlugins } = require(path.join(REPO, 'dist/main/bundled-plugins.js'));
// profile 名跟着实现走（实现已从自带 `web` 换成自有 profile）
const { profileDirOf, PROFILE_NAME } = require(path.join(REPO, 'dist/main/profile.js'));

// ── ⓪ 预设 id 的三方一致性（2026-10-02 加，起因是一次真实故障）────────────────
//
// 症状：用户「可以选法律模式了，但覆盖层没弹」。
// 根因：同一个 id 散在三处，其中一处写错：
//   · scripts/build-legal-preset-bundle.js 的 PRESET_ID 写成了 `legal`      ❌
//   · src/main/legal-mode.ts 的 PRESET_ID 是 `legal-mode`                   ✅
//   · 覆盖层插件判 `agentPreset === 'legal-mode'` / `p.id === 'legal-mode'` ✅
// 于是预设注册成了 `legal`，插件永远匹配不上 → 覆盖层不触发。
//
// 这个故障**没有任何检查会报**（花名册里确实有"法律模式"，只是 id 不对），
// 所以在这里把三方钉死：任何一处被改动而另两处没跟上，自检立刻失败。
function presetIdOf(file, re, label) {
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(re);
  if (!m) fail(`读不出 ${label} 里的预设 id（正则 ${re}）→ ${file}`);
  return m[1];
}
const idInGenerator = presetIdOf(
  path.join(REPO, 'scripts/build-legal-preset-bundle.js'),
  /const PRESET_ID = '([^']+)'/,
  '生成器',
);
const idInShell = presetIdOf(
  path.join(REPO, 'src/main/legal-mode.ts'),
  /const PRESET_ID = '([^']+)'/,
  '壳',
);
const idInPlugin = presetIdOf(
  path.join(REPO, 'lawyer/workbench/dsh-plugin-ui-legal-mode/src/client/index.ts'),
  /agentPreset === '([^']+)'/,
  '覆盖层插件',
);
const idInBundle = presetIdOf(
  path.join(BUNDLE_PAYLOAD, 'dsh-legal-preset', 'cordis.patch.yml'),
  /^ {8}id: ([A-Za-z0-9_-]+)$/m,
  'bundle 产物',
);
const ids = { 生成器: idInGenerator, 壳: idInShell, 覆盖层插件: idInPlugin, bundle产物: idInBundle };
const uniq = [...new Set(Object.values(ids))];
if (uniq.length !== 1) {
  fail('预设 id 三方（四方）不一致 —— 覆盖层会永远不弹：\n' +
    Object.entries(ids).map(([k, v]) => `    ${k}: ${v}`).join('\n') +
    '\n  修法：以 src/main/legal-mode.ts 的 PRESET_ID 为准，改生成器后重跑 npm run build。');
}
console.log(`  ✅ 预设 id 四方一致：${uniq[0]}`);

console.log('== 法律模式预设花名册自检 ==');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-roster-'));
try {
  // ① 先造出「DSH 已经建好 profile」的样子，再注入 —— 顺序反了会得到
  //    profilePending=true，bundle 那一半根本没装（实测踩过）。
  const profileDir = profileDirOf(home);
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(
    path.join(profileDir, 'package.json'),
    `${JSON.stringify({ name: `dsh-profile-${PROFILE_NAME}`, private: true }, null, 2)}\n`,
  );

  ensureLegalModeSetup(home, LEGAL_PAYLOAD, RUNTIME_MODULES);
  const plugins = ensureBundledPlugins(home, BUNDLE_PAYLOAD);
  if (plugins.profilePending) fail('注入后 profile 仍未就位，bundle 没装上');

  const manifest = JSON.parse(fs.readFileSync(path.join(profileDir, 'package.json'), 'utf8'));
  const bundles = manifest.dsh?.profile?.bundles ?? [];
  if (!bundles.includes('@deepwhale-cn/dsh-legal-preset')) {
    fail(`profile 的 dsh.profile.bundles 里没有法律模式 bundle：${JSON.stringify(bundles)}`);
  }
  console.log(`  ✅ profile bundles 含 @deepwhale-cn/dsh-legal-preset`);

  // ② 跑组合，看花名册里有没有那一行 —— 这才是用户在选择器里能看到的东西
  //    ⚠️ profile 名要跟注入用的是同一个（写死 `web` 会去 dump 另一个 profile，
  //       然后误报"花名册里没有 preset-legal"）。
  const run = spawnSync(process.execPath, [DSH_BIN, '--profile', PROFILE_NAME, '--dump-config'], {
    env: { ...process.env, DSH_HOME: home },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const out = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  if (!out.trim()) fail('dsh --dump-config 没有任何输出');

  const at = out.indexOf(`- id: ${EXPECTED_ROW}`);
  if (at < 0) {
    fail('组合出来的 profile 树里没有 ' + EXPECTED_ROW +
      ' —— 「法律模式」不会出现在 Agent 预设选择器里');
  }
  console.log(`  ✅ 花名册含 ${EXPECTED_ROW}`);

  // ③ 显示名也要对：选择器里显示的正是 config.name
  //    块的结束位置 = 下一个**顶层**行（`- id:` 在第 0 列）。固定窗口会截断，
  //    第一版用 400 字符，结果只数到 1 条 plugins 就误报"不完整"。
  const rest = out.slice(at + 1);
  const next = rest.search(/\n- id: /);
  const seg = next < 0 ? rest : rest.slice(0, next);
  if (!seg.includes(`name: ${EXPECTED_NAME}`)) {
    fail(`${EXPECTED_ROW} 的 config.name 不是「${EXPECTED_NAME}」：\n${seg}`);
  }
  const pluginRows = (seg.match(/^\s+- id: /gm) ?? []).length;
  if (pluginRows < 10) {
    fail(`${EXPECTED_ROW} 的 plugins 只有 ${pluginRows} 条，像是被截断或没生成完整`);
  }
  console.log(`  ✅ config.name=${EXPECTED_NAME}，plugins ${pluginRows} 条`);

  console.log('\n✅ 通过：法律模式已是花名册里真的可选预设\n');
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
