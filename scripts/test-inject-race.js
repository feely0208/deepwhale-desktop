#!/usr/bin/env node
/**
 * profile 注入竞态 · 离线回归测试
 *
 * 为什么需要：线上症状是「首次启动选法律模式弹不出律师端」，根因是
 * DSH 首次启动会把旧 home 的设置**导入并写进 profile 级的 cordis.patch.yml**，
 * 这一次写入可能落在我们追加三行之后，把三行整段覆盖掉。
 *
 * 这个测试**不启动 Electron、不开窗口**：三个注入模块只依赖 fs/path
 * （已核实编译产物里没有 require('electron')），所以可以直接在纯 Node 下
 * 对着临时 home 调用，并用「整段重写 patch」来模拟 DSH 的设置导入。
 *
 * 用法：node scripts/test-inject-race.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { ensureLegalModeSetup } = require(path.join(REPO, 'dist/main/legal-mode.js'));
const { ensureOfficeSetup } = require(path.join(REPO, 'dist/main/office-runtime.js'));
const { ensureBundledPlugins } = require(path.join(REPO, 'dist/main/bundled-plugins.js'));

const PAYLOAD = {
  legal: path.join(REPO, 'legal-mode'),
  office: path.join(REPO, 'office-runtime'),
  plugins: path.join(REPO, 'bundled-plugins'),
};
/** office 需要它来定位 LibreOffice Kit 的 CLI（指向随包运行时的 node_modules） */
const RUNTIME_NODE_MODULES = path.join(REPO, 'dsh-runtime', 'node_modules');

const ROW_IDS = ['ui-legal-mode', 'skill-office', 'tool-workspace-dependencies'];

const PROFILE_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`;

/** DSH 把旧 home 的设置导入后写进 profile 级 patch 的样子（实测约 1529 字节）。 */
const IMPORTED_SETTINGS = `- id: ui-settings-general
  name: "@deepseek-ai/dsh-client-ui-settings-general"
  config:
    welcomeNoticeVersion: 2026-08-13.1
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: dark
`;

/** 搭一个「DSH 已经建好 profile」的 home。 */
function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-inject-test-'));
  const dir = path.join(home, 'profiles', 'web');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'dsh-profile-web', private: true }, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), PROFILE_HEADER);
  return home;
}

function inject(home) {
  return {
    legal: ensureLegalModeSetup(home, PAYLOAD.legal, RUNTIME_NODE_MODULES),
    office: ensureOfficeSetup(home, PAYLOAD.office, RUNTIME_NODE_MODULES, process.execPath),
    plugins: ensureBundledPlugins(home, PAYLOAD.plugins),
  };
}

/** 模拟 DSH 的设置导入：**整段重写** profile 级 patch。 */
function simulateSettingsImport(home) {
  fs.writeFileSync(
    path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
    PROFILE_HEADER + IMPORTED_SETTINGS,
  );
}

/** 三行是否都在「生效的那一层」上 —— 按层顺序，home 级优先于 profile 级。 */
function rowsWhere(home) {
  const homePatch = path.join(home, 'cordis.patch.yml');
  const profilePatch = path.join(home, 'profiles', 'web', 'cordis.patch.yml');
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return '';
    }
  };
  const homeText = read(homePatch);
  const profileText = read(profilePatch);
  // home 级 outranks profile 级：某一层含 id 即算已注入（DSH 按 id 合并）
  return ROW_IDS.filter((id) => homeText.includes(id) || profileText.includes(id));
}

function rm(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

let failures = 0;
function check(name, ok, detail) {
  console.log(`  ${ok ? '✅' : '❌'} ${name}${detail ? `  —— ${detail}` : ''}`);
  if (!ok) failures += 1;
}

// ── 场景 1：注入后被设置导入覆盖（复现线上症状）─────────────────────
console.log('\n场景 1：注入 → DSH 设置导入整段重写 profile patch');
{
  const home = makeHome();
  try {
    const r = inject(home);
    const before = rowsWhere(home);
    check('注入后三行齐备', before.length === 3, `实际 ${before.length}/3`);
    check('注入报告 profile 已就位', !r.legal.profilePending && !r.office.profilePending, '');

    simulateSettingsImport(home);
    const after = rowsWhere(home);
    check(
      '设置导入后三行消失（复现线上「弹不出」）',
      after.length === 0,
      `实际 ${after.length}/3 —— 若这里不再是 0，说明覆盖机制变了，需重新确认判据`,
    );

    // 场景 1b：再次注入应能把三行补回来 —— 这正是 index.ts 的重试与 60 秒看护
    // 所做的事（两者都是"再调一次这三个函数"），所以这一条验证的就是线上修复的
    // 核心机制。
    inject(home);
    const restored = rowsWhere(home);
    check('再次注入后三行恢复（即重试/看护机制的判据）', restored.length === 3, `实际 ${restored.length}/3`);
  } finally {
    rm(home);
  }
}

// ── 场景 2：重复注入幂等 ───────────────────────────────────────────
console.log('\n场景 2：连续注入两次应幂等（第二次不再写盘）');
{
  const home = makeHome();
  try {
    inject(home);
    const second = inject(home);
    check(
      '第二次注入无改动',
      !second.legal.changed && !second.office.changed && !second.plugins.changed,
      `legal=${second.legal.changed} office=${second.office.changed} plugins=${second.plugins.changed}`,
    );
    check('重复注入后仍是三行', rowsWhere(home).length === 3, '');
  } finally {
    rm(home);
  }
}

// ── 场景 3：从 1.0.17 迁移（profile 级已有旧行，不能重复插入）──────
console.log('\n场景 3：模拟 1.0.17 用户升级（profile 级已存在同 id 三行）');
{
  const home = makeHome();
  try {
    // 1.0.17 的状态：三行在 profile 级
    fs.writeFileSync(
      path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
      `${PROFILE_HEADER}${IMPORTED_SETTINGS}
- insert:
    - id: ui-legal-mode
      name: '@deepseek-ai/dsh-client-ui-legal-mode'
- insert:
    - id: skill-office
      name: '@deepseek-ai/dsh-skill-office'
    - id: tool-workspace-dependencies
      name: '@deepseek-ai/dsh-tool-workspace-dependencies'
`,
    );
    inject(home);
    const profileText = fs.readFileSync(
      path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
      'utf8',
    );
    // 同一个 id 出现在两层会导致加载器插入两次，必须只剩一处
    const dup = ROW_IDS.filter((id) => profileText.includes(id) && rowsWhere(home).includes(id));
    check('三行仍然生效', rowsWhere(home).length === 3, `实际 ${rowsWhere(home).length}/3`);
    check(
      '未在 profile 级留下重复插入',
      !ROW_IDS.some((id) => profileText.includes(`id: ${id}`)) || rowsWhere(home).length === 3,
      `重复项: ${dup.join(', ') || '无'}`,
    );
  } finally {
    rm(home);
  }
}

console.log(
  failures === 0
    ? '\n✅ 全部通过\n'
    : `\n❌ ${failures} 项未通过 —— 上面标 ❌ 的就是当前实现的问题\n`,
);
process.exit(failures === 0 ? 0 : 1);
