/**
 * 发布后检查：主页 docs/index.html 里的下载链接是否指向真实存在的 Release 附件。
 * 用法：node scripts/check-homepage-links.js
 * 发版前/后跑一遍，发现 404 链接直接报错退出（CI 可用）。
 */
'use strict';
const fs = require('fs');
const https = require('https');

const html = fs.readFileSync('docs/index.html', 'utf-8');
const links = [...html.matchAll(/https:\/\/github\.com\/[^"' ]+?\/releases\/download\/[^"' ]+/g)].map(m => m[0]);
const unique = [...new Set(links)];

if (unique.length === 0) {
  console.error('❌ docs/index.html 里没有找到下载链接');
  process.exit(1);
}

function check(url) {
  return new Promise((resolve) => {
    https.get(url, { method: 'HEAD' }, (res) => {
      // GitHub 下载会 302 跳转到 CDN，跟随跳转后再看状态
      if (res.statusCode === 302 && res.headers.location) {
        https.get(res.headers.location, { method: 'HEAD' }, (r2) => {
          resolve({ url, status: r2.statusCode });
          r2.resume();
        }).on('error', () => resolve({ url, status: 0 }));
        res.resume();
      } else {
        resolve({ url, status: res.statusCode });
        res.resume();
      }
    }).on('error', () => resolve({ url, status: 0 }));
  });
}

(async () => {
  const results = await Promise.all(unique.map(check));
  let fail = 0;
  for (const r of results) {
    const ok = r.status === 200 || r.status === 302;
    console.log(`${ok ? '✅' : '❌'} ${r.status} ${r.url}`);
    if (!ok) fail++;
  }
  if (fail > 0) {
    console.error(`\n❌ ${fail} 个下载链接失效，请更新 docs/index.html 到最新版本号！`);
    process.exit(1);
  }
  console.log('\n✅ 主页所有下载链接正常');
})();
