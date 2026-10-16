#!/usr/bin/env node
/**
 * M0 网关的能力断言（手机端 1.1.0）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这个脚本回答一个问题：**"一键开启手机访问"是不是既不漏，也不裸奔**。
 *
 * 用真实的 HTTP 往返验证（不是读代码）：
 *   ① 无令牌 / 错令牌 → 必须 401（**绝不代理内容**）—— 安全红线
 *   ② 配对码：正确码 → 换到令牌；**同一个码第二次用必须 403**（一次性）
 *   ③ 过期码 → 403
 *   ④ 带令牌 → 正常反代，且上游（DSH）看到的是 **DSH 自己的令牌**
 *   ⑤ POST body 透传
 *   ⑥ SSE/流式：首块**先到**，不是等整包（否则手机上看不到"边跑边出"）
 *   ⑦ 轮换令牌后：旧令牌 401、新令牌 200
 *   ⑧ stop() 之后端口不再受理
 *
 * 用法：node scripts/test-mobile-gateway.js
 *   依赖 dist/main/mobile-gateway.js（先 npm run build）
 */
'use strict';

const http = require('http');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..');
const MOD = path.join(REPO, 'dist', 'main', 'mobile-gateway.js');
const { startMobileGateway } = require(MOD);

const DSH_TOKEN = 'dsh-secret-token';

/** 一个最小可用的"DSH"替身：记录收到的 query，支持 POST 回显与 SSE 流 */
function startStubDsh() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ method: req.method, url: req.url });
    if ((req.url || '').startsWith('/sse')) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('data: first\n\n');
      setTimeout(() => {
        res.write('data: second\n\n');
        res.end();
      }, 300);
      return;
    }
    if (req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ got: body, url: req.url }));
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<h1>stub dsh</h1><p>${req.url}</p>`);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, seen });
    });
  });
}

function req(opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(body);
    r.end();
  });
}

/** 读 SSE 的首块到达耗时（用来断言"不是等整包"） */
function firstChunkMs(port, token) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const r = http.request(
      { host: '127.0.0.1', port, path: `/sse?token=${encodeURIComponent(token)}`, method: 'GET' },
      (res) => {
        res.once('data', (chunk) => resolve({ ms: Date.now() - started, chunk: chunk.toString() }));
        res.on('end', () => {});
      },
    );
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const problems = [];
  const ok = (cond, msg) => {
    if (cond) console.log(`   ✓ ${msg}`);
    else {
      console.log(`   ✗ ${msg}`);
      problems.push(msg);
    }
  };

  const stub = await startStubDsh();
  const gw = await startMobileGateway({
    dshBase: `http://127.0.0.1:${stub.port}`,
    dshToken: DSH_TOKEN,
    pairTtlMs: 400,
  });
  const P = gw.port;
  console.log(`== M0 网关断言（网关端口 ${P}，替身 DSH ${stub.port}）`);

  try {
    // ① 无令牌 / 错令牌
    const noTok = await req({ host: '127.0.0.1', port: P, path: '/', method: 'GET' });
    ok(noTok.status === 401, `无令牌必须 401（实际 ${noTok.status}）`);
    const badTok = await req({ host: '127.0.0.1', port: P, path: '/?token=wrong', method: 'GET' });
    ok(badTok.status === 401, `错令牌必须 401（实际 ${badTok.status}）`);
    ok(!/stub dsh/.test(noTok.body), '无令牌时响应体里**不含**上游内容（没漏内容）');

    // ② 配对码：错误码 / 正确码 / 重复使用
    const badCode = await req({ host: '127.0.0.1', port: P, path: '/__pair?code=AAAAAA', method: 'GET' });
    ok(badCode.status === 403, `错误配对码 403（实际 ${badCode.status}）`);
    const good = await req({
      host: '127.0.0.1', port: P,
      path: `/__pair?code=${gw.session.pairCode}`, method: 'GET',
    });
    ok(good.status === 200, `正确配对码 200（实际 ${good.status}）`);
    let token = gw.session.token;
    try {
      token = JSON.parse(good.body).token;
    } catch (e) {
      problems.push('配对响应不是 JSON');
    }
    const reuse = await req({
      host: '127.0.0.1', port: P,
      path: `/__pair?code=${gw.session.pairCode}`, method: 'GET',
    });
    ok(reuse.status === 403, `同一配对码第二次必须 403（一次性，实际 ${reuse.status}）`);

    // ④ 带令牌 → 反代成功，且上游看到 DSH 自己的令牌
    const proxied = await req({ host: '127.0.0.1', port: P, path: `/hello?token=${token}&x=1`, method: 'GET' });
    ok(proxied.status === 200, `带令牌反代 200（实际 ${proxied.status}）`);
    const last = stub.seen[stub.seen.length - 1] || {};
    ok(/token=dsh-secret-token/.test(last.url || ''), `上游看到 DSH 自己的令牌（实际 ${last.url}）`);
    ok(!/x=1/.test(last.url) === false, '其他查询参数原样保留');

    // ⑤ POST body 透传
    const post = await req(
      { host: '127.0.0.1', port: P, path: `/api?token=${token}`, method: 'POST', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ hello: 'world' }),
    );
    ok(post.status === 200 && /hello/.test(post.body), `POST body 透传（实际 ${post.status}）`);

    // ⑥ SSE：首块要"先到"（远小于整包时间）
    const sse = await firstChunkMs(P, token);
    ok(/first/.test(sse.chunk) && sse.ms < 250, `SSE 首块先到（${sse.ms}ms，不是等整包 300ms）`);

    // ⑦ 轮换
    const rotated = gw.rotate();
    const oldTok = await req({ host: '127.0.0.1', port: P, path: `/?token=${token}`, method: 'GET' });
    ok(oldTok.status === 401, `轮换后旧令牌 401（实际 ${oldTok.status}）`);
    const newTok = await req({ host: '127.0.0.1', port: P, path: `/?token=${rotated.token}`, method: 'GET' });
    ok(newTok.status === 200, `轮换后新令牌 200（实际 ${newTok.status}）`);

    // ③ 过期（等待超过 TTL 后，新配对码也要能用旧的过期逻辑验证）
    const expiredGw = await startMobileGateway({
      dshBase: `http://127.0.0.1:${stub.port}`, dshToken: DSH_TOKEN, pairTtlMs: 50,
    });
    await new Promise((r) => setTimeout(r, 120));
    const expired = await req({
      host: '127.0.0.1', port: expiredGw.port,
      path: `/__pair?code=${expiredGw.session.pairCode}`, method: 'GET',
    });
    ok(expired.status === 403, `过期配对码 403（实际 ${expired.status}）`);
    await expiredGw.stop();

    // ⑨ CORS：独立 App（origin 与网关不同）必须能过 —— 预检与响应头都要有
    const pre = await new Promise((resolve, reject) => {
      const r = http.request(
        { host: '127.0.0.1', port: P, path: '/__pair', method: 'OPTIONS',
          headers: { origin: 'http://localhost:5173', 'access-control-request-method': 'POST' } },
        (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers })); },
      );
      r.on('error', reject); r.end();
    });
    ok(
      pre.status === 204 && pre.headers['access-control-allow-origin'] === 'http://localhost:5173',
      `CORS 预检放行且**回显 Origin**（实际 ${pre.status} / ${pre.headers['access-control-allow-origin']}）`,
    );
    ok(pre.headers['access-control-allow-credentials'] === 'true', '预检允许带凭据（DSH cookie 必需）');
    const withCors = await req({ host: '127.0.0.1', port: P, path: '/', method: 'GET', headers: { origin: 'http://localhost:5173' } });
    ok(withCors.headers['access-control-allow-origin'] === 'http://localhost:5173', '普通响应回显 Origin');
    ok(withCors.headers['access-control-allow-credentials'] === 'true', '普通响应允许凭据');

    // ⑧ stop 后端口不再受理
    await gw.stop();
    let refused = false;
    try {
      await req({ host: '127.0.0.1', port: P, path: '/', method: 'GET' });
    } catch (e) {
      refused = true;
    }
    ok(refused, 'stop() 之后端口不再受理（连接被拒）');
  } finally {
    try {
      await gw.stop();
    } catch (e) {
      /* 已停 */
    }
    stub.server.close();
  }

  if (problems.length) {
    console.error(`\n❌ M0 网关断言失败 ${problems.length} 项：`);
    problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
    process.exitCode = 1;
  } else {
    console.log('\n✅ M0 网关断言全部通过（安全红线 + 配对一次性 + 反代/流式/轮换/停机）');
  }
})().catch((e) => {
  console.error('测试本身出错:', e);
  process.exitCode = 1;
});
