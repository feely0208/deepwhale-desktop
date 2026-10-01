#!/usr/bin/env node
/**
 * 注入行去重复 · 回归测试（离线）
 *
 * 背景：`ui-legal-mode` / `skill-office` / `tool-workspace-dependencies` 这三个 id
 * 原来在 **home 级**和 **profile 级**两个 patch 里各写一份。profile 级那个文件
 * **归 DSH 自己重写**（用户改主题/聊天显示时它会重写，并把我们插的块重新排版），
 * 同一个 id 声明两次属于没必要的重复输入 —— 改成只留 home 级，profile 级的旧行删掉。
 *
 * 这个删除函数最危险的地方是**删多了**：把 DSH 的文件头注释或它自己的设置条目
 * 一起删掉，用户就会莫名丢设置。所以这里用真实形状的文件来钉住：
 *   · 我们的块必须消失
 *   · DSH 写的头部注释、`- id: ui-theme` 这类条目必须原样保留
 *   · 别人（DSH）自己的 insert 块不能误伤
 *
 * 用法：npm run build && node scripts/test-dedupe-inject.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const MOD = path.join(REPO, 'dist/main/legal-mode.js');

if (!fs.existsSync(MOD)) {
  console.error(`\n❌ 找不到 ${MOD}\n   先跑 npm run build。\n`);
  process.exit(1);
}

const { removeOurInsertBlocks } = require(MOD);
const IDS = ['ui-legal-mode', 'skill-office', 'tool-workspace-dependencies'];

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ✅ ${label}`);
  else {
    failures += 1;
    console.error(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 真实形状：DSH 的文件头 + 我们的两块 + DSH 自己的设置条目（含被 DSH 折行的字符串） */
function realisticPatch() {
  return [
    '# Your patch layer for this dsh profile, applied after every bundle layer:',
    '# a top-level YAML array of loader patch entries (id-targeted config',
    '# overrides, disables, and insert lists; `!!js` expressions allowed).',
    '- insert:',
    '    - id: ui-legal-mode',
    "      name: '@deepseek-ai/dsh-client-ui-legal-mode'",
    '',
    '# ── office 能力：文档生成（Word / Excel / PPT）+ 内置 LibreOffice 渲染 PDF ──',
    '- insert:',
    '    - id: skill-office',
    "      name: '@deepseek-ai/dsh-skill-office'",
    '      config:',
    '        node: "/Users/x/office-runtime/bin/node"',
    '        cli: "/Applications/DeepWhale',
    '          Desktop.app/Contents/Resources/libreoffice-kit/lib/cli.js"',
    '    - id: tool-workspace-dependencies',
    "      name: '@deepseek-ai/dsh-tool-workspace-dependencies'",
    '      config:',
    '        source: "/Applications/DeepWhale Desktop.app/Contents/Resources/office-runtime"',
    '- id: ui-theme',
    '  name: "@deepseek-ai/dsh-client-ui-theme"',
    '  config:',
    '    preference: light',
    '- id: ui-chat',
    '  name: "@deepseek-ai/dsh-client-ui-chat"',
    '  config:',
    '    transcriptView: detailed',
    '',
  ].join('\n');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-dedupe-'));

console.log('\nA. 真实形状的文件：我们的行删掉，DSH 的一行都不能动');
{
  const file = path.join(tmp, 'real.yml');
  fs.writeFileSync(file, realisticPatch());
  const changed = removeOurInsertBlocks(file, IDS);
  const after = fs.readFileSync(file, 'utf8');

  check('返回 changed=true', changed === true);
  for (const id of IDS) {
    check(`${id} 已删掉`, !after.includes(id));
  }
  check(
    'DSH 的文件头注释保留',
    after.includes('a top-level YAML array of loader patch entries'),
    after.split('\n').slice(0, 3).join(' | '),
  );
  check('DSH 的 ui-theme 条目保留', after.includes('- id: ui-theme'));
  check('DSH 的 ui-chat 条目保留', after.includes('- id: ui-chat'));
  check('ui-chat 的 config 保留', after.includes('transcriptView: detailed'));
  // 那个折行字符串属于**我们被删掉的 office 块**，所以它应当一起消失 ——
  // 这里反过来钉住："删干净"包括 DSH 重新排版过的那些续行，不能只删掉 id 那一行、
  // 把剩下的 config 残片留在文件里（那会变成半个语法不通的 YAML）。
  check('被折行的 office config 残片也一并删净', !after.includes('libreoffice-kit/lib/cli.js'));
  check('没有留下孤立的 cli: 续行', !after.includes('cli: "/Applications/DeepWhale'));
  check('删完仍是合法形状（没有只有缩进的孤儿行）', !/\n\s+Desktop\.app/.test(after));

  // 幂等：再删一次应当什么都不做
  check('再删一次返回 false（幂等）', removeOurInsertBlocks(file, IDS) === false);
}

console.log('\nB. 我们的块紧跟在文件头之后（最容易把头一起删掉的情形）');
{
  const file = path.join(tmp, 'first.yml');
  fs.writeFileSync(file, realisticPatch());
  removeOurInsertBlocks(path.join(tmp, 'first.yml'), IDS);
  const after = fs.readFileSync(file, 'utf8');
  check('文件头仍在第一行', after.startsWith('# Your patch layer for this dsh profile'), after.split('\n')[0]);
  check('头部第二行也在', after.includes('# overrides, disables, and insert lists'));
}

console.log('\nC. 不能误伤：DSH 自己的 insert 块必须留着');
{
  const file = path.join(tmp, 'other.yml');
  fs.writeFileSync(
    file,
    ['# header', '- insert:', '    - id: ui-something-else', "      name: '@deepseek-ai/xyz'", ''].join('\n'),
  );
  const changed = removeOurInsertBlocks(file, IDS);
  const after = fs.readFileSync(file, 'utf8');
  check('别人的 insert 块没被动 → 返回 false', changed === false);
  check('内容原样', after.includes('ui-something-else'));
}

console.log('\nD. 边界：空文件 / 只有注释 / 文件不存在');
{
  const empty = path.join(tmp, 'empty.yml');
  fs.writeFileSync(empty, '');
  check('空文件 → false，不报错', removeOurInsertBlocks(empty, IDS) === false);
  check('空文件没被写坏', fs.readFileSync(empty, 'utf8') === '');

  const comments = path.join(tmp, 'comments.yml');
  fs.writeFileSync(comments, '# 只有注释\n');
  check('只有注释 → false', removeOurInsertBlocks(comments, IDS) === false);
  check('注释原样', fs.readFileSync(comments, 'utf8') === '# 只有注释\n');

  check('文件不存在 → false，不抛', removeOurInsertBlocks(path.join(tmp, 'nope.yml'), IDS) === false);
}

console.log('\nE. 只删自己的：同一文件里我们和 DSH 各有 insert');
{
  const file = path.join(tmp, 'mixed.yml');
  fs.writeFileSync(
    file,
    [
      '# header',
      '- insert:',
      '    - id: ui-legal-mode',
      "      name: '@deepseek-ai/dsh-client-ui-legal-mode'",
      '- insert:',
      '    - id: ui-dsh-own',
      "      name: '@deepseek-ai/dsh-own-plugin'",
      '',
    ].join('\n'),
  );
  removeOurInsertBlocks(file, ['ui-legal-mode']);
  const after = fs.readFileSync(file, 'utf8');
  check('我们的块没了', !after.includes('ui-legal-mode'));
  check('DSH 的 insert 块还在', after.includes('ui-dsh-own'));
  check('DSH 的块仍有 insert 头', after.includes('- insert:'));
}

fs.rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n❌ 去重复测试失败：${failures} 项\n`);
  process.exit(1);
}
console.log('\n✅ 通过：只删我们自己的注入块，DSH 的内容一行不动\n');
