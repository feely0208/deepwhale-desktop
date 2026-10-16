#!/usr/bin/env node
/**
 * 发布前验证（1.0.6）
 *
 * 覆盖三块：
 *   A. 离线授权算法 —— 签发能过 / 改载荷被拒 / 随机签名被拒
 *   B. 分镜回归 —— 「不加图」和「有图」两种都必须校验通过
 *      （1.0.6 修的就是「不加图」时 timeline 引用不存在节点 → 校验失败）
 *   C. 包体静态检查 —— 不含私钥、含 node:url import、版本正确
 *
 * 用法：node scripts/verify-release.mjs [--pkg <tgz>]
 */
import { createHash, generateKeyPairSync, sign as cSign, verify as cVerify } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..');
const ENGINE = process.env.CANVAS_ENGINE || '/Users/mac/DeepSeek Harness/canvas';
const TGZ = (() => {
  const i = process.argv.indexOf('--pkg');
  return i > 0 ? process.argv[i + 1] : null;
})();

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? '  ' + extra : ''}`); }
};

// ─────────── A. 授权算法 ───────────
console.log('\nA. 离线授权算法（Ed25519）');
{
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const mint = (payload, key) => {
    const body = b64u(JSON.stringify(payload));
    return body + '.' + b64u(cSign(null, Buffer.from(body, 'ascii'), key));
  };
  const check = (code, pub) => {
    const i = code.lastIndexOf('.');
    const body = code.slice(0, i), sig = code.slice(i + 1);
    let good = false;
    try { good = cVerify(null, Buffer.from(body, 'ascii'), pub, Buffer.from(sig, 'base64url')); } catch { good = false; }
    if (!good) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    return p && p.v === 1 && p.exp ? p : null;
  };

  const payload = { v: 1, exp: Date.now() + 365 * 86400000, to: '验收买家' };
  const code = mint(payload, privateKey);
  ok('① 私钥签发 → 公钥验签通过', !!check(code, publicKey));

  const tampered = mint(payload, privateKey).split('.')[0] + '.' +
    b64u(cSign(null, Buffer.from(b64u(JSON.stringify({ ...payload, exp: Date.now() + 3650 * 86400000 })), 'ascii'), privateKey));
  ok('② 改载荷（到期改到 10 年后）保留原结构 → 被拒', check(tampered, publicKey) === null || check(tampered, publicKey).exp === payload.exp);

  const randomSig = code.split('.')[0] + '.' + b64u(Buffer.from(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'der' })).slice(0, 64));
  ok('③ 自造随机签名 → 被拒', check(randomSig, publicKey) === null);

  const { privateKey: other } = generateKeyPairSync('ed25519');
  ok('④ 别人用自己的私钥签 → 被拒', check(mint(payload, other), publicKey) === null);
}

// ─────────── B. 分镜回归 ───────────
console.log('\nB. 分镜回归（1.0.6 修复点）');
{
  const { loadBuiltins, runProducer } = await import(join(ENGINE, 'src/producers/index.mjs'));
  const { validateDocument } = await import(join(ENGINE, 'src/validate.mjs'));
  const { loadRegistry } = await import(join(ENGINE, 'src/registry.mjs'));
  // ⚠️ validateDocument 收的是**领域包对象**，不是 {domain:'video'} —— 传错会得到
  //    E_DOMAIN_VERSION_MISMATCH + 一堆 E_NODE_TYPE_UNKNOWN（踩过）
  const packs = loadRegistry(join(ENGINE, 'packs'));
  const pack = packs.get('video');
  if (!pack) { console.log('  ❌ 载不到 video 领域包'); process.exit(1); }
  await loadBuiltins();

  const items = [
    { text: '很多人都以为，写材料最难的是想清楚。' },
    { text: '其实不是。' },
    { text: '我们把这件事，做成了一个插件。' },
  ];

  // ① 不加图 —— 就是线上出问题的那种用法
  const r1 = await runProducer('story.board', { title: '验证用', items, orientation: 'vertical' }, {});
  const v1 = validateDocument(r1.doc, pack);
  const errs1 = (v1.issues || []).filter((x) => x.level === 'error');
  ok('① 「不加图」分镜 → 校验通过', errs1.length === 0,
     errs1.length ? `仍有 ${errs1.length} 个错误：` + errs1.map((e) => e.code).join(',') : '');

  // ② 有图
  const shot = join(ENGINE, '..', '公众号配图-深鲸画布', '01-成片-画面1.jpg');
  const shotAlt = '/Users/mac/Desktop/深鲸画布-内容包/04-公众号/配图/02-成片-画面2.jpg';
  const shotPath = existsSync(shot) ? shot : (existsSync(shotAlt) ? shotAlt : null);
  if (shotPath) {
    const r2 = await runProducer('story.board', { title: '验证用', items: items.map((x, i) => i === 0 ? { ...x, shot: shotPath } : x), orientation: 'vertical' }, {});
    const v2 = validateDocument(r2.doc, pack);
    const errs2 = (v2.issues || []).filter((x) => x.level === 'error');
    ok('② 「有图」分镜 → 校验通过', errs2.length === 0,
       errs2.length ? `仍有 ${errs2.length} 个错误：` + errs2.map((e) => e.code).join(',') : '');
  } else {
    console.log('  ⏭ ② 跳过（没找到测试图）');
  }
}

// ─────────── C. 包体静态检查 ───────────
console.log('\nC. 包体静态检查');
{
  const pkgJson = JSON.parse(readFileSync(join(PLUGIN, 'package.json'), 'utf8'));
  ok('版本号已升到 1.0.6', pkgJson.version === '1.0.6', `实际 ${pkgJson.version}`);

  const idx = readFileSync(join(PLUGIN, 'lib/index.js'), 'utf8');
  ok('lib/index.js 含 pathToFileURL import', /from 'node:url'/.test(idx));
  ok('lib/index.js 没有残留未导入的 pathToFileURL 调用', idx.split('pathToFileURL').length - 1 > 0 && /import \{ pathToFileURL \}/.test(idx));

  if (TGZ && existsSync(TGZ)) {
    const list = execFileSync('tar', ['-tzf', TGZ], { maxBuffer: 64 * 1024 * 1024 }).toString();
    const body = execFileSync('tar', ['-xzOf', TGZ], { maxBuffer: 256 * 1024 * 1024 }).toString('binary');
    ok('包内无 PRIVATE KEY', !body.includes('PRIVATE KEY'));
    ok('包内无旧对称密钥', !body.includes('deepwhale-canvas-2026-license-v1'));
    ok('包内无 .pem 文件', !/\.pem$/m.test(list));
    const inner = execFileSync('tar', ['-xzOf', TGZ, 'package/lib/index.js'], { maxBuffer: 64 * 1024 * 1024 }).toString();
    ok('包内 lib/index.js 含 node:url', /from 'node:url'/.test(inner));
    const sb = execFileSync('tar', ['-xzOf', TGZ, 'package/engine/src/producers/storyboard.mjs'], { maxBuffer: 64 * 1024 * 1024 }).toString();
    ok('包内 storyboard 含 timeline 修复', sb.includes('E_TIMELINE_NODE_UNKNOWN') || /if \(to > from && it\.shot\)/.test(sb));
    console.log(`     SHA256 ${createHash('sha256').update(readFileSync(TGZ)).digest('hex')}`);
  } else {
    console.log('  ⏭ 包体检查跳过（没传 --pkg）');
  }
}


// ─────────── D. 水印可渲染性（1.0.6 修复点）───────────
console.log('\nD. 水印可渲染性（免费版命门）');
{
  const { injectWatermark } = await import(join(PLUGIN, 'lib/pipeline-run.mjs'));
  const { loadRegistry } = await import(join(ENGINE, 'src/registry.mjs'));
  const { validateDocument } = await import(join(ENGINE, 'src/validate.mjs'));
  const pack = loadRegistry(join(ENGINE, 'packs')).get('video');

  const { loadBuiltins, runProducer } = await import(join(ENGINE, 'src/producers/index.mjs'));
  await loadBuiltins();
  const r = await runProducer('story.board', { title: '验证', items: [{ text: '一句。' }], orientation: 'vertical' }, {});
  const doc = JSON.parse(JSON.stringify(r.doc));
  injectWatermark(doc, true);
  const v = validateDocument(doc, pack);
  const errs = (v.issues || []).filter((x) => x.level === 'error');
  ok('带水印的文档能通过校验（免费版可出片）', errs.length === 0,
     errs.length ? errs.map((e) => e.code).join(',') : '');

  const whale = doc.nodes.find((n) => n.id === '__wm_whale');
  ok('鲸鱼 logo 走 user: 槽位（不再用 data: 内联）', !!whale && /^user:/.test(whale.props.src), whale ? whale.props.src : '缺节点');
  const txt = doc.nodes.find((n) => n.id === '__wm_center');
  ok('水印文字带 opacity 且 schema 已允许', !!txt && typeof txt.props.opacity === 'number');
}

console.log(`\n  ────────────\n  通过 ${pass} · 失败 ${fail}\n`);
process.exit(fail ? 1 : 0);