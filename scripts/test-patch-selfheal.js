#!/usr/bin/env node
/**
 * patch 文件自愈的回归测试（2026-10-02）。
 *
 * 起因是一个真实用户：升级到 1.0.37 后第二天打不开应用，报
 *
 *   dsh: failed to parse overlay
 *     ...\dsh-home\profiles\deepwhale\cordis.patch.yml:
 *   YAMLException: null byte is not allowed in input (1:1)
 *
 * 也就是那个 patch 文件**开头多了一个 NUL 字节**，DSH 启动时解析失败 →
 * 整个应用起不来，用户是小白、完全无从下手。
 *
 * 这里用**同样的字节**造一份坏文件，验证壳的体检/自愈能把它救回来。
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const { repairPatchFileIfBroken } = require(path.join(__dirname, '..', 'dist', 'main', 'legal-mode.js'));

let failures = 0;
function check(label, ok, detail) {
  if (ok) console.log(`  ✅ ${label}`);
  else { failures += 1; console.error(`  ❌ ${label}${detail ? ` —— ${detail}` : ''}`); }
}

/** DSH 的判定口径：顶层必须是 YAML 数组（去掉 BOM/注释/空行后首字符是 - 或 [） */
function dshWouldAccept(text) {
  for (const raw of text.replace(/^\uFEFF/, '').split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line === '---') continue;
    return line.startsWith('-') || line.startsWith('[');
  }
  return false;
}
const hasNul = (buf) => buf.includes(0);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-selfheal-'));
function make(name, buf) {
  const f = path.join(dir, name);
  fs.writeFileSync(f, buf);
  return f;
}

console.log('\nA. 用户那次的真实场景：开头一个 NUL 字节');
{
  // 正是用户日志里的内容：NUL + 空行（照抄报错里的 1| \0  2|  3| ）
  const bad = make('nul-first.yml', Buffer.concat([Buffer.from([0x00]), Buffer.from('\n\n')]));
  const fixed = repairPatchFileIfBroken(bad);
  const now = fs.readFileSync(bad);
  check('返回 true（确实判定为坏并修了）', fixed === true);
  check('文件里不再有 NUL 字节', !hasNul(now), JSON.stringify(now.toString('utf8')));
  check('修完之后 DSH 会接受它（顶层是数组）', dshWouldAccept(now.toString('utf8')), JSON.stringify(now.toString('utf8')));
  const baks = fs.readdirSync(dir).filter((n) => n.startsWith('nul-first.yml.bad-'));
  check('原文件被改名备份了（万一里面有配置可人工找回）', baks.length === 1, baks.join(','));
}

console.log('\nB. 其它坏法：非法 UTF-8 / 只有注释 / 空文件');
{
  const bad2 = make('invalid-utf8.yml', Buffer.from([0xff, 0xfe, 0x41, 0x00]));
  check('非法 UTF-8 被判定为坏并修好',
    repairPatchFileIfBroken(bad2) === true && dshWouldAccept(fs.readFileSync(bad2, 'utf8')));
  const bad3 = make('only-comments.yml', Buffer.from('# 只有注释\n# 没有数组\n'));
  check('只有注释（DSH 会报"必须是数组"）也修',
    repairPatchFileIfBroken(bad3) === true && dshWouldAccept(fs.readFileSync(bad3, 'utf8')));
  const bad4 = make('empty.yml', Buffer.from(''));
  check('空文件也修', repairPatchFileIfBroken(bad4) === true && dshWouldAccept(fs.readFileSync(bad4, 'utf8')));
}

console.log('\nC. 正常文件绝不能被误伤（否则会把用户的配置抹掉）');
{
  const good1 = make('good-array.yml', Buffer.from('# 注释\n- insert:\n    - id: ui-legal-mode\n'));
  const before1 = fs.readFileSync(good1);
  check('正常的 - insert 块原样不动', repairPatchFileIfBroken(good1) === false && fs.readFileSync(good1).equals(before1));

  const good2 = make('good-empty-array.yml', Buffer.from('# dsh 生成\n[]\n'));
  const before2 = fs.readFileSync(good2);
  check('正常的 [] 原样不动', repairPatchFileIfBroken(good2) === false && fs.readFileSync(good2).equals(before2));

  const good3 = make('good-crlf.yml', Buffer.from('# 注释\r\n[]\r\n'));
  const before3 = fs.readFileSync(good3);
  check('CRLF 的 [] 原样不动（Windows 上很常见）', repairPatchFileIfBroken(good3) === false && fs.readFileSync(good3).equals(before3));
}

console.log('\nD. 文件不存在时不乱建（DSH 会自己创建）');
{
  const missing = path.join(dir, 'not-there.yml');
  check('不存在 → 返回 false 且不创建文件',
    repairPatchFileIfBroken(missing) === false && !fs.existsSync(missing));
}

fs.rmSync(dir, { recursive: true, force: true });
if (failures > 0) { console.error(`\n❌ patch 自愈测试失败：${failures} 项\n`); process.exit(1); }
console.log('\n✅ 通过：坏文件能救回、好文件不误伤、不存在不乱建\n');
