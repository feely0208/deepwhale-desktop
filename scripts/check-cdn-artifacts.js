#!/usr/bin/env node
/* CDN 产物完整性核对（`npm run check:cdn`）
 *
 * 为什么要有它（2026-10-03）：
 *   以前发版验收只看更新清单里的 `version:` 那一行 —— 那一步一直是绿的，
 *   但清单里**指向的文件**在 CDN 上到底是 200 还是 403、清单列的是哪个架构，
 *   没人看。结果藏了两个坑整整一周：
 *     ① macOS 自动更新的 `latest-mac.yml` 指向 .zip，而 CDN 上从来没有 zip（403）
 *        → 用户点更新能"检查到有新版本"，一到下载就失败；
 *     ② CI 的 arm64 / x64 两个 job 各传一份 `latest-mac.yml`，后传的覆盖先传的
 *        → 清单里只剩 x64，Apple 芯片的用户会被推 x64 包。
 *   这个脚本把这件"要人肉一个个点"的事变成一条命令：约 10 秒，只发 HEAD + 拉三个
 *   几百字节的清单，不下载安装包。
 *
 * 用法：
 *   node scripts/check-cdn-artifacts.js              # 核对线上 CDN
 *   node scripts/check-cdn-artifacts.js --base URL   # 换源（默认 https://dl.deepwhale.org.cn）
 *   node scripts/check-cdn-artifacts.js --deep       # 额外下载文件核对 sha512（慢，默认关）
 *
 * 退出码：有任何一项不通 = 1（可直接挂进 CI / 发版脚本）。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const BASE = (opt('base', 'https://dl.deepwhale.org.cn')).replace(/\/+$/, '');
const DEEP = args.includes('--deep');
/** 核对范围：all（默认）/ desktop / lawyer ——
 *  桌面发版时用 desktop，免得被"律师端清单旧"这类无关问题连带判失败。 */
const SCOPE = opt('scope', 'all');

/** 更新清单：electron-updater 逐个平台读的那份。
 *  律师端用的是独立通道（lawyer-latest-*），同样必须核对 —— 它今天刚上自动升级。 */
// ⚠️ 2026-10-05 教训：以前只查 lawyer-latest-mac.yml，于是**Windows 那份**（lawyer-latest.yml）
// 在 CDN 上是私有 ACL（HTTP 403）、律师端用户全部报「无法连接到更新服务器」，我们却一直没发现。
// 现在四份桌面清单 + 两份律师端清单一起查。
const ALL_MANIFESTS = [
  'latest.yml',
  'latest-mac.yml',
  'latest-linux.yml',
  'lawyer-latest.yml',
  'lawyer-latest-mac.yml',
];
const MANIFESTS =
  SCOPE === 'desktop'
    ? ALL_MANIFESTS.filter((n) => !n.startsWith('lawyer-'))
    : SCOPE === 'lawyer'
      ? ALL_MANIFESTS.filter((n) => n.startsWith('lawyer-'))
      : ALL_MANIFESTS;
/** mac 清单必须同时含两个架构，否则会把 x64 包推给 Apple 芯片用户 */
const MAC_REQUIRE_BOTH_ARCH = true;

let failures = 0;
/** 需要去 CDN 控制台刷新的 URL（源站已对、缓存未失效） */
const purgeHints = [];
const fail = (msg) => {
  failures += 1;
  console.error('  ❌ ' + msg);
};
const ok = (msg) => console.log('  ✅ ' + msg);

function request(url, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.request(url, { method, headers, timeout: 30000 }, (res) => {
      if (method === 'GET') {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf-8'), headers: res.headers }));
      } else {
        res.resume();
        resolve({ status: res.statusCode, body: '', headers: res.headers });
      }
    });
    req.on('timeout', () => {
      req.destroy(new Error('超时'));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 极简 YAML 解析：只认 electron-builder 生成的这种结构（version / files[url,sha512,size] / path） */
function parseManifest(text) {
  const version = (text.match(/^version:\s*(\S+)/m) ?? [])[1] ?? null;
  const path = (text.match(/^path:\s*(\S+)/m) ?? [])[1] ?? null;
  const files = [];
  const re = /-\s+url:\s*(\S+)\s*\n\s+sha512:\s*(\S+)\s*\n\s+size:\s*(\d+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    files.push({ url: m[1], sha512: m[2], size: Number(m[3]) });
  }
  return { version, path, files };
}

async function checkFile(url, expectSize) {
  let res;
  try {
    res = await request(url, 'HEAD');
  } catch (e) {
    return { okFile: false, why: `请求失败：${e.message}` };
  }
  if (res.status !== 200) {
    return { okFile: false, why: `HTTP ${res.status}` };
  }
  const len = Number(res.headers['content-length'] ?? 0);
  if (expectSize && len && len !== expectSize) {
    // ⚠️ 2026-10-03：大文件（dmg/zip/exe…）在 CDN 上是 30 天缓存，重新上传同名文件后
    //    缓存不会自动失效 —— 只打缓存会看到旧大小，误判成"没传上去"。
    //    这里再打一次**源站**（带 cache-buster）：源站对了 = 只是缓存没刷，需要去控制台刷新 URL。
    let originLen = 0;
    try {
      const busted = await request(`${url}${url.includes('?') ? '&' : '?'}cb=${Date.now()}`, 'HEAD');
      originLen = Number(busted.headers['content-length'] ?? 0);
    } catch (e) {
      originLen = 0;
    }
    if (originLen && originLen === expectSize) {
      return {
        okFile: false,
        why: `清单写 ${expectSize}B，源站已是新文件，但 CDN 缓存还是旧文件（${len}B）→ 去刷新这个 URL`,
        needsPurge: true,
      };
    }
    return { okFile: false, why: `清单写 ${expectSize}B，CDN 实际 ${len}B（源站 ${originLen || '未知'}）` };
  }
  return { okFile: true, size: len || expectSize || 0 };
}

async function sha512Of(url) {
  const mod = url.startsWith('https:') ? https : http;
  return await new Promise((resolve, reject) => {
    mod
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const h = crypto.createHash('sha512');
        res.on('data', (c) => h.update(c));
        res.on('end', () => resolve(h.digest('base64')));
      })
      .on('error', reject);
  });
}

(async () => {
  console.log(`CDN 产物核对：${BASE}（范围：${SCOPE}）\n`);
  const seenVersions = new Map();

  for (const name of MANIFESTS) {
    const url = `${BASE}/${name}?cb=${Date.now()}`;
    let text;
    try {
      const res = await request(url);
      if (res.status !== 200) {
        fail(`${name}: HTTP ${res.status}（清单都取不到，自动更新必然失败）`);
        continue;
      }
      text = res.body;
    } catch (e) {
      fail(`${name}: 请求失败 ${e.message}`);
      continue;
    }
    const mf = parseManifest(text);
    console.log(`\n${name}  version=${mf.version ?? '?'}  files=${mf.files.length}`);
    if (!mf.version) fail(`${name}: 解析不到 version`);
    else seenVersions.set(name, mf.version);
    if (!mf.files.length) fail(`${name}: 清单里没有任何文件条目`);

    for (const f of mf.files) {
      const r = await checkFile(`${BASE}/${f.url}`, f.size);
      if (r.okFile) {
        let extra = '';
        if (DEEP) {
          try {
            const got = await sha512Of(`${BASE}/${f.url}`);
            extra = got === f.sha512 ? '  sha512 ✓' : '  sha512 ✗（与清单不符）';
            if (got !== f.sha512) fail(`${name} → ${f.url}: sha512 与清单不一致`);
          } catch (e) {
            extra = `  sha512 校验失败：${e.message}`;
          }
        }
        ok(`${name} → ${f.url}  HTTP 200  ${(r.size / 1048576).toFixed(1)}MB${extra}`);
      } else {
        fail(`${name} → ${f.url}  ${r.why}  ← 用户走到这一步就会失败`);
        if (r.needsPurge) purgeHints.push(`${BASE}/${f.url}`);
      }
    }

    // mac 清单必须双臂齐全：只有 x64 时，Apple 芯片用户会被推 x64 包
    if (name.endsWith('latest-mac.yml') && MAC_REQUIRE_BOTH_ARCH) {
      const names = mf.files.map((f) => f.url).join(' ');
      const hasArm = /arm64/.test(names);
      const hasX64 = /x64/.test(names);
      if (hasArm && hasX64) ok(`${name} 同时包含 arm64 与 x64 ✓`);
      else fail(`${name} 缺架构：arm64=${hasArm} x64=${hasX64}（Apple 芯片用户会被推错包）`);
    }
  }

  // 桌面端三份清单版本必须一致；律师端单独比
  console.log('');
  const desktop = ['latest.yml', 'latest-mac.yml', 'latest-linux.yml']
    .map((n) => seenVersions.get(n))
    .filter(Boolean);
  const dv = [...new Set(desktop)];
  if (dv.length === 1) ok(`桌面端三个清单版本一致：${dv[0]}`);
  else if (dv.length > 1) fail(`桌面端清单版本不一致：${JSON.stringify(Object.fromEntries(seenVersions))}`);
  const lawyerV = seenVersions.get('lawyer-latest-mac.yml');
  if (lawyerV) ok(`律师端清单版本：${lawyerV}`);

  if (purgeHints.length) {
    console.log('\n需要到 CDN 控制台「刷新预热 → URL 刷新」清缓存：');
    for (const u of purgeHints) console.log('  · ' + u);
  }
  console.log(failures === 0 ? '\n✅ CDN 产物核对通过' : `\n❌ CDN 产物核对失败 ${failures} 项`);
  process.exit(failures === 0 ? 0 : 1);
})();
