#!/usr/bin/env node
/**
 * 离线守卫：office 行的路径自愈（2026-10-14 Windows 用户事故回归）
 *
 * 事故（真实用户日志）：
 *   `skill-office (@deepseek-ai/dsh-skill-office): Error: Invalid package
 *    D:\Program Files (x86)\DeepWhale Desktop\resources\app.asar`
 *   + `1 entry did not activate` → 升级用户的 Word / Excel / PPT 三个技能**静默失效**。
 *
 * 根因：那行 `cli:` 是 asar 时代（1.0.49 之前）写下的**安装目录绝对路径**；
 * 之后打进包的方式改成 `asar: false`（electron-builder.yml），那个 app.asar 不复存在，
 * 而 Electron 的 fs 对含 app.asar 的路径直接抛「Invalid package <归档根>」。
 * 旧代码只对齐 `node:`，`cli:` 永远留着 → 老用户升级多少次都修不好。
 *
 * 本脚本断言的是**修好之后的行为**（用编译产物 dist/main/office-runtime.js）：
 *   ① 用户那种旧行 → node/cli/source 三个都对齐到当前值
 *   ② 别人块里的同名 key 不被误改（旧的整文件正则会打到第一个 cli:）
 *   ③ 幂等：再跑一次内容不变
 *   ④ 结果仍是合法 YAML，office 行结构完整
 *   ⑤ 老行缺 key 时能补上（不能让能力继续指向不存在的东西）
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const dist = path.join(__dirname, '..', 'dist', 'main', 'office-runtime.js');
if (!fs.existsSync(dist)) {
  console.error('❌ 找不到编译产物 dist/main/office-runtime.js —— 请先 npm run build');
  process.exit(1);
}
const { syncOfficeRowPaths } = require(dist);

const problems = [];
const check = (name, ok, detail) => {
  if (!ok) problems.push(`${name}${detail ? `（${detail}）` : ''}`);
};

const NEW_NODE = '/Users/tester/AppData/Roaming/DeepWhale Desktop/dsh-home/office-runtime/bin/node';
const NEW_CLI =
  '/Users/tester/AppData/Roaming/DeepWhale Desktop/dsh-home/office-runtime/kit/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js';
const NEW_SOURCE = '/Users/tester/AppData/Roaming/DeepWhale Desktop/dsh-home/office-runtime';

// ── 复刻用户那份 home 级 patch：office 行是 asar 时代的旧路径 ──
const userPatch = `- insert:
    - id: ui-legal-mode
      name: '@deepseek-ai/dsh-client-ui-legal-mode'

# ── office 能力：文档生成（Word / Excel / PPT）+ 内置 LibreOffice 渲染 PDF ──
- insert:
    - id: skill-office
      name: '@deepseek-ai/dsh-skill-office'
      config:
        node: "D:/Program Files (x86)/DeepWhale Desktop/resources/office-runtime/bin/node.cmd"
        cli: "D:/Program Files (x86)/DeepWhale Desktop/resources/app.asar/dsh-runtime/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js"
    - id: tool-workspace-dependencies
      name: '@deepseek-ai/dsh-tool-workspace-dependencies'
      config:
        source: "D:/Program Files (x86)/DeepWhale Desktop/resources/office-runtime"

# ── 别人的块：这里也有 cli。/node: 同名 key，不能被误改 ──
- insert:
    - id: someone-elses-row
      name: '@deepseek-ai/dsh-something'
      config:
        cli: "C:/keep-me/cli.js"
        source: "C:/keep-me"
`;

const healed = syncOfficeRowPaths(userPatch, { node: NEW_NODE, cli: NEW_CLI, source: NEW_SOURCE });

// ① 三个路径都被对齐
const officeBlock = healed.slice(healed.indexOf('skill-office'), healed.indexOf('someone-elses-row'));
check('node 已对齐', officeBlock.includes(`node: ${JSON.stringify(NEW_NODE)}`));
check('cli 已对齐（这条是本次事故的核心）', officeBlock.includes(`cli: ${JSON.stringify(NEW_CLI)}`));
check('source 已对齐', officeBlock.includes(`source: ${JSON.stringify(NEW_SOURCE)}`));
check('旧的 app.asar 路径已消失', !healed.includes('app.asar'));

// ② 别人块里的同名 key 原样保留
check('别人的 cli 未被误改', healed.includes('cli: "C:/keep-me/cli.js"'));
check('别人的 source 未被误改', healed.includes('source: "C:/keep-me"'));

// ③ 幂等
const again = syncOfficeRowPaths(healed, { node: NEW_NODE, cli: NEW_CLI, source: NEW_SOURCE });
check('幂等（第二次调用不再改动）', again === healed);

// ④ 仍是合法 YAML，且 office 行结构完整
let parsed = null;
try {
  parsed = yaml.load(healed);
} catch (e) {
  problems.push(`自愈后的文件不是合法 YAML：${e.message}`);
}
if (parsed) {
  const rows = (Array.isArray(parsed) ? parsed : []).flatMap((entry) => entry.insert || []);
  const office = rows.find((r) => r.id === 'skill-office');
  check('office 行仍在', office !== undefined);
  if (office) {
    check('office.name 未被破坏', office.name === '@deepseek-ai/dsh-skill-office');
    check('office.config.cli 是当前真实路径', office.config.cli === NEW_CLI);
    check('office.config.node 是当前真实路径', office.config.node === NEW_NODE);
  }
  const deps = rows.find((r) => r.id === 'tool-workspace-dependencies');
  check('依赖行的 source 已对齐', deps !== undefined && deps.config.source === NEW_SOURCE);
  const other = rows.find((r) => r.id === 'someone-elses-row');
  check('别人的行仍完整', other !== undefined && other.config.cli === 'C:/keep-me/cli.js');
}

// ⑤ 老行缺 key 时补上（不能让能力继续指向不存在的东西）
const missingKey = `- insert:
    - id: skill-office
      name: '@deepseek-ai/dsh-skill-office'
      config:
        node: "old/node"
`;
const filled = syncOfficeRowPaths(missingKey, { node: NEW_NODE, cli: NEW_CLI, source: NEW_SOURCE });
check('缺 cli 时补写', filled.includes(`cli: ${JSON.stringify(NEW_CLI)}`));
check('缺 source 时补写', filled.includes(`source: ${JSON.stringify(NEW_SOURCE)}`));
check('补写后仍是合法 YAML', (() => {
  try {
    yaml.load(filled);
    return true;
  } catch {
    return false;
  }
})());

// ── ⑥ 端到端：真的跑一次 ensureOfficeSetup（真实载荷 + 真实随包运行时）──
// 光测纯函数不够 —— 还要证明"写出来的那一行，三个路径在磁盘上真的存在"。
// 这里用 repo 里的 office-runtime 载荷与 dsh-runtime/node_modules（CI 里由跟版脚本准备）。
const os = require('os');
const repoRoot = path.join(__dirname, '..');
const payloadDir = path.join(repoRoot, 'office-runtime');
const runtimeNodeModules = path.join(repoRoot, 'dsh-runtime', 'node_modules');
const kitCliInRuntime = path.join(
  runtimeNodeModules,
  '@deepseek-ai',
  'libreoffice-kit',
  'lib',
  'cli.js',
);

if (!fs.existsSync(kitCliInRuntime) || !fs.existsSync(path.join(payloadDir, 'runtime.json'))) {
  console.log('⏭  端到端段跳过：本地没有 office 载荷或随包运行时（CI 由跟版脚本准备）');
} else {
  const { ensureOfficeSetup } = require(dist);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-office-heal-'));
  const patchFile = path.join(home, 'cordis.patch.yml');

  // 预先写一份"用户那种"旧行（asar 路径 + 旧 node）
  fs.writeFileSync(
    patchFile,
    [
      '- insert:',
      '    - id: skill-office',
      "      name: '@deepseek-ai/dsh-skill-office'",
      '      config:',
      '        node: "D:/Program Files (x86)/DeepWhale Desktop/resources/office-runtime/bin/node.cmd"',
      '        cli: "D:/Program Files (x86)/DeepWhale Desktop/resources/app.asar/dsh-runtime/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js"',
      '    - id: tool-workspace-dependencies',
      "      name: '@deepseek-ai/dsh-tool-workspace-dependencies'",
      '      config:',
      '        source: "D:/Program Files (x86)/DeepWhale Desktop/resources/office-runtime"',
      '',
    ].join('\n'),
    'utf-8',
  );

  const result = ensureOfficeSetup(home, payloadDir, runtimeNodeModules, process.execPath, '1.0.56-test');
  const after = fs.readFileSync(patchFile, 'utf-8');
  let row = null;
  try {
    const parsedAfter = yaml.load(after);
    const all = (Array.isArray(parsedAfter) ? parsedAfter : []).flatMap((e) => e.insert || []);
    row = all.find((r) => r.id === 'skill-office');
  } catch (e) {
    problems.push(`端到端：自愈后的 patch 不是合法 YAML：${e.message}`);
  }
  check('端到端：旧 app.asar 路径已消失', !after.includes('app.asar'));
  check('端到端：office 行仍在', row !== null && row !== undefined);
  if (row) {
    for (const key of ['node', 'cli']) {
      const value = row.config[key];
      check(`端到端：${key} 指向真实存在的文件`, typeof value === 'string' && fs.existsSync(value), value);
    }
    check(
      '端到端：cli 落在 home 的物化目录里（不是 asar）',
      typeof row.config.cli === 'string' && row.config.cli.startsWith(path.join(home, 'office-runtime')),
      row.config.cli,
    );
  }
  check('端到端：报告了写盘', result.changed === true);
  fs.rmSync(home, { recursive: true, force: true });
}

if (problems.length) {
  console.error('❌ office 行自愈守卫失败：');
  problems.forEach((p) => console.error('  · ' + p));
  process.exitCode = 1;
} else {
  console.log('✅ office 行自愈守卫通过（app.asar 旧路径被治好 · 别人块不被误改 · 幂等 · YAML 合法 · 缺 key 会补）');
}
