#!/usr/bin/env node
/**
 * M0 网关 · **真实 DSH** 端到端验证（手机端 1.1.0）
 *
 * 与 test-mobile-gateway.js 的分工：
 *   · 那个用**替身**验证网关自身的行为（401/配对/流式/轮换/停机）；
 *   · 这个用**真的 dsh web**验证"手机能不能连上"这件事本身 —— 替身测不出
 *     DSH 的 Cookie 鉴权、重定向、真实 HTML 与 WebSocket，**只有真跑才知道**。
 *
 * 断言：
 *   ① 起真 DSH（临时 DSH_HOME，不动用户数据），拿到 `dsh web: http://127.0.0.1:<port>/?token=…`
 *   ② 网关起来后，**不带令牌**请求 → 401（且响应里没有 DSH 页面）
 *   ③ 用配对码换令牌 → 带令牌请求首页 → 200 且返回的是**真的 DSH 页面**（含 __ModuleLoader__）
 *   ④ DSH 的鉴权 Cookie 能穿过网关（第二次请求只带 cookie 也应当拿到 200）
 *   ⑤ 静态资源（client-modules 的 client.js）也能过网关取到（否则手机上是白屏）
 *
 * 用法：node scripts/test-mobile-gateway-live.js
 */
'use strict';

const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const { startMobileGateway } = require(path.join(REPO, 'dist', 'main', 'mobile-gateway.js'));

const DSH_BIN = path.join(REPO, 'dsh-runtime', 'node_modules', '.bin', 'dsh');
const NODE_BIN = process.execPath;
const PORT = 46311;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers: headers || {} },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  const problems = [];
  const ok = (cond, msg) => {
    console.log(cond ? `   ✓ ${msg}` : `   ✗ ${msg}`);
    if (!cond) problems.push(msg);
  };

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-'));
  console.log('== 真实 DSH 端到端验证');
  const dsh = spawn(NODE_BIN, [DSH_BIN, 'web', '--port', String(PORT)], {
    cwd: path.join(REPO, 'dsh-runtime'),
    env: { ...process.env, DSH_HOME: home, PATH: '/usr/local/bin:' + process.env.PATH },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let banner = '';
  dsh.stdout.on('data', (d) => (banner += d.toString()));
  dsh.stderr.on('data', (d) => (banner += d.toString()));

  let dshBase = null;
  let dshToken = '';
  for (let i = 0; i < 60; i += 1) {
    const m = /dsh web:\s*(https?:\/\/[^\s?]+)\/?\?token=([^\s]+)/.exec(banner);
    if (m) {
      dshBase = m[1];
      dshToken = m[2];
      break;
    }
    await wait(500);
  }
  if (!dshBase) {
    console.error('   ✗ 12 秒内没看到 DSH 的就绪 banner；输出：\n' + banner.slice(0, 600));
    dsh.kill('SIGKILL');
    process.exit(1);
  }
  console.log(`   DSH 就绪：${dshBase}（临时 home：${path.basename(home)}）`);

  const gw = await startMobileGateway({ dshBase, dshToken });
  console.log(`   网关：${gw.session.origin}  配对码：${gw.session.pairCode}`);

  try {
    // ② 不带令牌
    const noTok = await get(`http://127.0.0.1:${gw.port}/`);
    ok(noTok.status === 401, `不带令牌 401（实际 ${noTok.status}）`);
    ok(!/__ModuleLoader__/.test(noTok.body), '401 响应里没有 DSH 页面内容');

    // ③ 配对 → 带令牌取真页面
    const pair = await get(`http://127.0.0.1:${gw.port}/__pair?code=${gw.session.pairCode}`);
    ok(pair.status === 200, `配对换令牌 200（实际 ${pair.status}）`);
    const token = JSON.parse(pair.body).token;
    // 像浏览器一样跟随重定向（DSH 首次带 token 会 303 到 ./）
    const firstPage = await get(`http://127.0.0.1:${gw.port}/?token=${encodeURIComponent(token)}`);
    let page = firstPage;
    const ourCookie = (page.headers['set-cookie'] || [])
      .map((c) => String(c).split(';')[0])
      .find((c) => c.startsWith('dsh_mobile='));
    ok(!!ourCookie, '网关下发了自己的会话 cookie（否则重定向后必 401）');
    if (page.status >= 300 && page.status < 400 && page.headers.location) {
      const loc = new URL(page.headers.location, `http://127.0.0.1:${gw.port}/`).toString();
      const cookies = [ourCookie, (page.headers['set-cookie'] || []).map((c) => String(c).split(';')[0]).find((c) => c.startsWith('dsh-auth-'))]
        .filter(Boolean).join('; ');
      page = await get(loc, { cookie: cookies });
      ok(page.status === 200, `跟随 DSH 重定向后 200（实际 ${page.status}）`);
    }
    ok(page.status === 200, `带令牌取首页 200（实际 ${page.status}）`);
    ok(/__ModuleLoader__/.test(page.body), '拿到的是**真的 DSH 页面**（含 __ModuleLoader__）');

    // ④ DSH 的 Cookie 穿过网关
    // ⚠️ 注意：DSH 的 cookie 是在**首次 303** 那一条上下的，跟随重定向后的 200 上不会再有
    const setCookie = firstPage.headers['set-cookie'] || [];
    const dshCookie = setCookie.map((c) => String(c).split(';')[0]).find((c) => /^dsh-auth-/.test(c));
    ok(!!dshCookie, `DSH 的鉴权 cookie 被透传（${(dshCookie || '无').split('=')[0]}）`);
    if (dshCookie) {
      const viaCookie = await get(`http://127.0.0.1:${gw.port}/?token=${encodeURIComponent(token)}`, {
        cookie: dshCookie,
      });
      ok(viaCookie.status === 200, `带 DSH cookie 再次请求 200（实际 ${viaCookie.status}）`);
    }

    // ⑤ 静态资源（手机端白屏与否的关键）
    const assetMatch = /<script src="([^"]*dsh-client-modules\/client\.js[^"]*)"/.exec(page.body);
    if (assetMatch) {
      const assetUrl = assetMatch[1].replace(/&amp;/g, '&');
      const asset = await get(
        `http://127.0.0.1:${gw.port}/${assetUrl}${assetUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`,
      );
      ok(asset.status === 200 && asset.body.length > 1000, `客户端装载器经网关可取（${asset.status}，${asset.body.length} 字节）`);
    } else {
      problems.push('没在页面里找到 dsh-client-modules/client.js 的引用（页面结构变了？）');
    }
  } finally {
    await gw.stop();
    dsh.kill('SIGKILL');
  }

  if (problems.length) {
    console.error(`\n❌ 真实 DSH 端到端验证失败 ${problems.length} 项`);
    process.exitCode = 1;
  } else {
    console.log('\n✅ 真实 DSH 端到端跑通：手机（过网关）能拿到真页面 + 真资源，且没令牌绝不漏内容');
  }
})().catch((e) => {
  console.error('脚本自身出错:', e);
  process.exitCode = 1;
});
