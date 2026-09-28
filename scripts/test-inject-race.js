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

// 载荷缺失时**必须直接失败**，不能静默跑成"全绿"：
// 注入函数在载荷不存在时会走"早退"分支（例如 office 找不到 runtime.json 就直接 return），
// 那时三行照样可能被写对、断言个个通过 —— 但什么都没验证到。
const PAYLOAD_FILES = [
  [path.join(PAYLOAD.legal, 'plugin'), 'legal-mode/plugin'],
  [path.join(PAYLOAD.office, 'runtime.json'), 'office-runtime/runtime.json'],
  [path.join(PAYLOAD.plugins, 'dsh-cn-compliance'), 'bundled-plugins/dsh-cn-compliance'],
];
{
  const missing = PAYLOAD_FILES.filter(([p]) => !fs.existsSync(p)).map(([, label]) => label);
  if (missing.length > 0) {
    console.error(
      `\n❌ 随包载荷不齐，测试会跑成假通过：缺 ${missing.join('、')}\n` +
        '   先跑 npm run build 与 scripts/build-*.js 生成载荷，再执行本测试。\n',
    );
    process.exit(1);
  }
}

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

// ── 场景 1：home 级注入必须**扛得住**设置导入（本轮修复的核心）──────────
//
// 旧判据是"设置导入后三行消失"——那描述的是**修复前**的症状。
// 修好之后这个期望本身就该失败：现在三行写在 home 级，
// 而设置导入只重写 profile 级，所以它们必须活下来。
console.log('\n场景 1：注入 → DSH 设置导入整段重写 profile patch');
{
  const home = makeHome();
  try {
    const r = inject(home);
    const homePatch = path.join(home, 'cordis.patch.yml');
    check('注入后三行齐备', rowsWhere(home).length === 3, `实际 ${rowsWhere(home).length}/3`);
    check('注入报告 profile 已就位', !r.legal.profilePending && !r.office.profilePending, '');

    // "首启即可见"的载体就是 home 级这个文件：DSH 的客户端插件清单在
    // **服务启动那一刻定型**，而 profile 目录要到 DSH 首次启动才被创建 ——
    // 只写 profile 级在结构上就来不及。home 级由壳自己创建，先于服务启动。
    check('home 级 patch 文件已创建（首启可见的载体）', fs.existsSync(homePatch), homePatch);
    const homeText = fs.existsSync(homePatch) ? fs.readFileSync(homePatch, 'utf8') : '';
    const inHome = ROW_IDS.filter((id) => homeText.includes(id));
    check('三行都写进了 home 级', inHome.length === 3, `实际 ${inHome.join('、') || '无'}`);

    simulateSettingsImport(home);
    // 关键前提：profile 层**确实**被整段重写了。少了这条，本用例就是空转 ——
    // 三行还在也可能只是因为压根没被覆盖过。
    const profileText = fs.readFileSync(
      path.join(home, 'profiles', 'web', 'cordis.patch.yml'),
      'utf8',
    );
    check(
      '设置导入确实清空了 profile 层（否则本用例空转）',
      !ROW_IDS.some((id) => profileText.includes(id)),
      `profile 层剩余注入行: ${ROW_IDS.filter((id) => profileText.includes(id)).length}`,
    );

    check(
      '设置导入后三行仍然生效（home 级 outranks profile 级）',
      rowsWhere(home).length === 3,
      `实际 ${rowsWhere(home).length}/3 —— 退回 0 就是线上「弹不出律师端」复发`,
    );

    // 场景 1b：重试/看护仍是兜底 —— 把 home 级也清掉后，再注入要能补回。
    fs.rmSync(homePatch, { force: true });
    check('清掉 home 级后三行失效（证明上一条不是假通过）', rowsWhere(home).length === 0,
      `实际 ${rowsWhere(home).length}/3`);
    inject(home);
    check('再次注入后三行恢复（重试/看护的判据）', rowsWhere(home).length === 3,
      `实际 ${rowsWhere(home).length}/3`);
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
    check('三行仍然生效', rowsWhere(home).length === 3, `实际 ${rowsWhere(home).length}/3`);
    // 同 id 在 home/profile 两层各一份是**预期内**的：老用户 profile 级里本来就有，
    // 我们不去删（删了要动用户的文件），实测插件只挂载一次、无告警。
    // 所以真正要守的不变量不是"层里不能重复"，而是"**生效的 id 恰好 3 个**"。
    // 原来这条写成 `!some(...) || rowsWhere===3`，右边恒真 —— 恒真的断言等于没有断言。
    const homeText = fs.readFileSync(path.join(home, 'cordis.patch.yml'), 'utf8');
    check(
      '生效的 id 恰好 3 个（两层重复不影响挂载次数）',
      rowsWhere(home).length === ROW_IDS.length && new Set(rowsWhere(home)).size === ROW_IDS.length,
      `home 级 ${ROW_IDS.filter((i) => homeText.includes(i)).length} 行 / profile 级 ${ROW_IDS.filter((i) => profileText.includes(i)).length} 行 / 生效 ${rowsWhere(home).length} 个`,
    );
  } finally {
    rm(home);
  }
}

// ── 场景 4：载荷目录只读（从 dmg 直接运行 / App Translocation）──────────
//
// 线上症状：直接跑挂载好的 dmg 时 office 装不上。
// 根因是壳往**自己的 App 包**里写 `Resources/office-runtime/bin/node`，
// 而挂载点是只读的（App Translocation 还会把 App 复制到随机只读目录再运行）。
// 实测报错：ENOENT: mkdir '.../Resources/office-runtime/bin'。
// 修法是包装脚本写到 `<home>/office-runtime/bin/node`。
console.log('\n场景 4：office 载荷目录只读时，注入不得往载荷里写东西');
{
  const home = makeHome();
  const payload = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ro-payload-'));
  try {
    fs.writeFileSync(path.join(payload, 'runtime.json'), `${JSON.stringify({ version: 'test' })}\n`);
    const before = fs.readdirSync(payload).sort().join(',');
    fs.chmodSync(payload, 0o555); // 只读，模拟 dmg 挂载点

    let threw = null;
    try {
      ensureOfficeSetup(home, payload, RUNTIME_NODE_MODULES, process.execPath);
    } catch (error) {
      threw = error;
    }

    check(
      '只读载荷下注入不抛错（旧代码会 ENOENT: mkdir …/Resources/office-runtime/bin）',
      threw === null,
      threw ? String(threw.message) : '',
    );
    check(
      '载荷目录一个文件都没多',
      fs.readdirSync(payload).sort().join(',') === before,
      `现在: ${fs.readdirSync(payload).sort().join(',')}`,
    );
    const wrapper = path.join(home, 'office-runtime', 'bin', 'node');
    check('包装脚本写在可写的 home 下', fs.existsSync(wrapper), wrapper);
  } finally {
    try {
      fs.chmodSync(payload, 0o755);
    } catch {
      /* ignore */
    }
    rm(payload);
    rm(home);
  }
}

console.log(
  failures === 0
    ? '\n✅ 全部通过\n'
    : `\n❌ ${failures} 项未通过 —— 上面标 ❌ 的就是当前实现的问题\n`,
);
process.exit(failures === 0 ? 0 : 1);
