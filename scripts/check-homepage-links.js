#!/usr/bin/env node
/**
 * 发布后检查：落地页 `docs/index.html` 里的下载链接是否指向**真实存在**的 Release 附件。
 *
 * 用法：
 *   node scripts/check-homepage-links.js
 *   GH_TOKEN=... node scripts/check-homepage-links.js   # 检查 Draft release 时需要
 *
 * ── 为什么重写（2026-09-28）─────────────────────────────────────────
 * 老版本有两个问题，合起来等于"一次都没真正检查过"：
 *
 * ① 它用正则抓 HTML 里的**字面量** GitHub URL：
 *      /https:\/\/github\.com\/[^"' ]+?\/releases\/download\/[^"' ]+/g
 *    但落地页的下载地址是**常量拼出来的**：
 *      GH + '/' + DESKTOP_VERSION + '/DeepWhale-Desktop-' + DESKTOP_VER + '-arm64.dmg'
 *    字面量一个都不存在，所以它检查的是个空集（或直接报"没找到链接"）。
 *
 * ② **没有任何工作流调用它** —— 它连"报错"的机会都没有。
 *
 * 结果：律师端链接一直是 `.../download/v1.0.x/DeepWhale-Lawyer-0.1.3-...`
 * （律师端早就不挂在壳的 release 上了，它有自己的 lawyer-v0.1.3），
 * 实测 404，而没人发现。
 *
 * ── 现在怎么做 ────────────────────────────────────────────────────
 * 把页面里的 `var X = '...'` 常量真解析出来，按页面自己的拼接规则**算出**
 * 每个下载 URL，再逐个 HEAD。等于用脚本模拟一遍"用户点下去会发生什么"。
 */
'use strict';
const fs = require('fs');
const https = require('https');
const path = require('path');

const FILE = path.join(__dirname, '..', 'docs', 'index.html');
const html = fs.readFileSync(FILE, 'utf-8');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

// ── 解析页面里的常量 ─────────────────────────────────────────────
const consts = {};
for (const m of html.matchAll(/var\s+([A-Z][A-Z0-9_]*)\s*=\s*'([^']*)'/g)) {
  consts[m[1]] = m[2];
}
// DESKTOP_VER 这类是从别的常量算出来的，页面里也是这么定义的
if (consts.DESKTOP_VERSION) consts.DESKTOP_VER = consts.DESKTOP_VERSION.replace(/^v/, '');

if (!consts.GH) {
  console.error('❌ 落地页里找不到 GH 常量（下载地址前缀）—— 结构变了，请更新本脚本');
  process.exit(1);
}

// ── 按页面自己的拼接方式，算出所有下载 URL ───────────────────────
// 页面里形如：GH + '/' + DESKTOP_VERSION + '/DeepWhale-Desktop-' + DESKTOP_VER + '-arm64.dmg'
const EXPR = /GH\s*\+\s*'\/'\s*\+\s*([A-Z][A-Z0-9_]*)\s*\+\s*'\/(DeepWhale-[A-Za-z]+-)'\s*\+\s*([A-Z][A-Z0-9_]*)\s*\+\s*'(-[^']+)'/g;

const built = [];
for (const m of html.matchAll(EXPR)) {
  const tagVar = m[1];
  const prefix = m[2];
  const verVar = m[3];
  const suffix = m[4];
  const tag = consts[tagVar];
  const ver = consts[verVar];
  if (!tag || !ver) {
    console.error(`❌ HTML 里的 ${tagVar} 或 ${verVar} 没有定义，拼不出下载地址`);
    process.exit(1);
  }
  built.push({
    url: `${consts.GH}/${tag}/${prefix}${ver}${suffix}`,
    tagVar,
    tag,
    kind: prefix.replace(/^DeepWhale-/, '').replace(/-$/, ''),
    file: `${prefix}${ver}${suffix}`,
  });
}

if (built.length === 0) {
  console.error('❌ 一个下载链接都没解析出来 —— 落地页的拼接写法变了，请更新本脚本的正则');
  process.exit(1);
}

// 同一条 URL 可能对应多个平台条目，去重
const seen = new Map();
for (const b of built) {
  if (!seen.has(b.url)) seen.set(b.url, b);
}
const list = [...seen.values()];

console.log(`落地页常量：DESKTOP_VERSION=${consts.DESKTOP_VERSION} ` +
  `LAWYER_TAG=${consts.LAWYER_TAG || '(无)'} LAWYER_VER=${consts.LAWYER_VER || '(无)'} ` +
  `SUITE_TAG=${consts.SUITE_TAG || '(无)'}`);
console.log(`解析出 ${list.length} 个下载地址，逐个检查：\n`);

function head(url) {
  return new Promise((resolve) => {
    const headers = { 'User-Agent': 'deepwhale-link-check' };
    // Draft release 的附件对公开 URL 是 404，必须带 token 才查得准
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
    const req = https.request(url, { method: 'HEAD', headers, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        head(res.headers.location).then(resolve);
        return;
      }
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

(async () => {
  const results = await Promise.all(list.map(async (b) => ({ ...b, status: await head(b.url) })));
  let fail = 0;
  for (const r of results) {
    const ok = r.status === 200;
    if (!ok) fail += 1;
    console.log(`${ok ? '✅' : '❌'} ${String(r.status).padEnd(4)} ${r.kind.padEnd(8)} ${r.url}`);
    if (!ok) {
      console.log(`         └ tag 取自常量 ${r.tagVar}='${r.tag}'；` +
        `若这是律师端/套装，确认它有没有自己独立的 release tag`);
    }
  }
  console.log('');
  if (fail > 0) {
    console.error(`❌ ${fail}/${results.length} 个下载链接失效 —— 用户在落地页点下去会 404。` +
      `请修正 docs/index.html 的常量，以及 bump-site-version.js 里对应的规则。`);
    process.exit(1);
  }
  console.log(`✅ ${results.length} 个下载链接全部有效（200）`);
})();
