#!/usr/bin/env node
/**
 * 开发用探针：把一个**临时 DSH**（临时 DSH_HOME + 临时 profile）带我们的
 * `dsh-shell-mobile` 插件跑起来，然后把 /mobile/api/* 的结果打出来。
 *
 * 为什么要有它（而不是每次手敲）：
 *   手机端接口层的"服务形状"必须**实测**，本轮已经因此纠正了三个错误判断
 *   （inject 写多了插件不生效 / sessions.list 被 dump 截断 / searchSessions 被禁用）。
 *   每次手搭 profile 要 30 秒且容易错，所以固化成脚本，迭代一次只要一条命令。
 *
 * 用法：
 *   node scripts/probe-mobile-api.mjs                      # health + sessions
 *   node scripts/probe-mobile-api.mjs --session <id>       # 再取一个会话的详情
 *   node scripts/probe-mobile-api.mjs --raw /mobile/api/_services
 *
 * 注意（用户机器上不许弹东西）：DSH 一律用 `--no-open` 启动；窗口/浏览器都不会打开。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 46900;
const HOME = join(tmpdir(), 'dsh-mobile-probe');
const PROFILE = 'deepwhale';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function get(pathname, cookie, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const rawIdx = argv.indexOf('--raw');
  const postIdx = argv.indexOf('--post');   // --post <path> <json>  （直连 DSH 的 typed RPC 探测）
  const sessionIdx = argv.indexOf('--session');

  // 1) 准备临时 home（首次初始化 profile）
  if (!existsSync(join(HOME, 'profiles', PROFILE, 'package.json'))) {
    rmSync(HOME, { recursive: true, force: true });
    mkdirSync(HOME, { recursive: true });
    const init = spawn(process.execPath, [join(REPO, 'dsh-runtime/node_modules/.bin/dsh'), '--profile', PROFILE, '--from-default-profile', 'web', '--no-open', '--port', String(PORT)], {
      cwd: join(REPO, 'dsh-runtime'),
      env: { ...process.env, DSH_HOME: HOME, PATH: `/usr/local/bin:${process.env.PATH}` },
      stdio: 'ignore',
    });
    await wait(15000);
    init.kill('SIGKILL');
    await wait(500);
  }

  // 2) 装插件（拷源码 + node_modules 链接 + profile bundle 条目用**包名**）
  const pluginSrc = join(REPO, 'shell-plugins', 'dsh-shell-mobile');
  const pluginDst = join(HOME, 'plugins', 'dsh-shell-mobile');
  rmSync(pluginDst, { recursive: true, force: true });
  mkdirSync(join(HOME, 'plugins'), { recursive: true });
  cpSync(pluginSrc, pluginDst, { recursive: true });
  const nm = join(HOME, 'profiles', PROFILE, 'node_modules', '@deepwhale-cn');
  mkdirSync(nm, { recursive: true });
  try {
    rmSync(join(nm, 'dsh-shell-mobile'), { force: true });
  } catch {}
  spawn('ln', ['-sfn', pluginDst, join(nm, 'dsh-shell-mobile')]);
  const pkgPath = join(HOME, 'profiles', PROFILE, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const dshCfg = (pkg.dsh ??= {});
  const prof = (dshCfg.profile ??= {});
  const bundles = (prof.bundles ??= []);
  if (!bundles.includes('@deepwhale-cn/dsh-shell-mobile')) bundles.push('@deepwhale-cn/dsh-shell-mobile');
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  // 3) 起 DSH（--no-open：绝不弹浏览器）
  const dsh = spawn(process.execPath, [join(REPO, 'dsh-runtime/node_modules/.bin/dsh'), '--profile', PROFILE, '--no-open', '--port', String(PORT)], {
    cwd: join(REPO, 'dsh-runtime'),
    env: { ...process.env, DSH_HOME: HOME, PATH: `/usr/local/bin:${process.env.PATH}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  dsh.stdout.on('data', (d) => (log += d));
  dsh.stderr.on('data', (d) => (log += d));
  let token = '';
  for (let i = 0; i < 40 && !token; i += 1) {
    const m = /token=([^\s]+)/.exec(log);
    if (m) token = m[1];
    else await wait(500);
  }
  if (!token) {
    console.error('DSH 未就绪，日志：\n' + log.slice(0, 500));
    dsh.kill('SIGKILL');
    process.exit(1);
  }
  // 用 token 换 cookie
  const first = await get(`/?token=${token}`);
  const cookie = (first.headers['set-cookie'] ?? []).map((c) => String(c).split(';')[0]).join('; ');

  // --boot-client：先用 Electron 以"透明不可见"窗口加载一次官方页面，
  // 让 typert 把远端 RPC descriptor 注册出来（它惰性注册，没人连就是空的）。
  if (argv.includes('--boot-client')) {
    const { spawn: spawnEl } = await import('node:child_process');
    const el = spawnEl(join(REPO, 'node_modules/.bin/electron'), [join(REPO, 'scripts/_boot-dsh-client.js')], {
      env: { ...process.env, DSH_BOOT_URL: `http://127.0.0.1:${PORT}/?token=${token}`, DSH_BOOT_MS: '25000', ELECTRON_RUN_AS_NODE: '' },
      stdio: 'ignore',
    });
    await wait(26000);
    el.kill('SIGKILL');
  }

  // 默认流程：health → 新建一个会话 → 列表 → 取该会话详情（一次性拿到全部形状）
  const steps = [];
  // --rpc-prompt：用 DSH 官方 typed RPC 发一条消息，再用我们的接口读回
  if (argv.includes('--rpc-prompt')) {
    // 用官方 RPC 建会话（我们的 sessions.create() 产出的是占位 id，真会话是 UUID）
    const crid = `probe-c-${Date.now().toString(36)}`;
    const cpay = JSON.stringify({
      type: 'client-request', rpcId: crid, method: 'session/create',
      payload: { args: { request: {} } },
    });
    const created = await get('/api/session/create', cookie, 'POST', cpay);
    console.log('\n== POST /api/session/create →', created.body.slice(0, 400));
    let sid = '';
    try {
      const j = JSON.parse(created.body);
      const v = j?.result?.value ?? j?.result;
      sid = v?.sessionId ?? v?.id ?? v?.session?.id ?? '';
    } catch {}
    if (!sid) {
      console.log('（没拿到 id，改用列表里的第一个）');
      const list = await get('/mobile/api/sessions', cookie);
      sid = JSON.parse(list.body)?.sessions?.[0]?.id ?? '';
    }
    console.log('== 会话 id →', sid);
    const rid = `probe-${Date.now().toString(36)}`;
    const pay = JSON.stringify({
      type: 'client-request', rpcId: rid, method: 'session/prompt',
      payload: { args: { request: { requestId: rid, sessionId: sid, mode: 'queue', content: [{ type: 'text', text: '你好，报一下当前目录' }] } } },
    });
    const r = await get('/api/session/prompt', cookie, 'POST', pay);
    console.log('== POST /api/session/prompt →', r.body.slice(0, 500));
    await wait(3000);
    const back = await get(`/mobile/api/session?id=${encodeURIComponent(sid)}`, cookie);
    console.log('== 我们的接口读回 →', back.body.slice(0, 600));
    dsh.kill('SIGKILL');
    process.exit(0);
  }

  if (postIdx >= 0) {
    for (const p of argv[postIdx + 1].split(',')) {
      steps.push([p, 'POST', argv[postIdx + 2] ?? '{"type":"client-request","rpcId":"11111111-2222-4333-8444-555555555555","method":"x","payload":{}}']);
    }
  } else if (rawIdx >= 0) {
    steps.push([argv[rawIdx + 1] ?? '/mobile/api/health', 'GET', undefined]);
  } else {
    steps.push(['/mobile/api/health', 'GET', undefined]);
    steps.push(['/mobile/api/session', 'POST', '{}']);
    steps.push(['/mobile/api/sessions', 'GET', undefined]);
    // 发一条消息（真实链路；本机没配模型凭据时会如实返回错误——那也是有效结论）
    steps.push(['/mobile/api/_dev/activate', 'POST', JSON.stringify({ sessionId: 'mobile-1' })]);
    steps.push(['/mobile/api/prompt', 'POST', JSON.stringify({ sessionId: 'mobile-1', text: '你好，报一下当前目录' })]);
    steps.push(['/mobile/api/session?id=mobile-1', 'GET', undefined]);
  }
  if (sessionIdx >= 0) steps.push([`/mobile/api/session?id=${encodeURIComponent(argv[sessionIdx + 1] ?? '')}`, 'GET', undefined]);

  for (const [p, method, body] of steps) {
    const r = await get(p, cookie, method, body);
    console.log(`\n== ${p}  → HTTP ${r.status}（${r.body.length} 字节）`);
    // 完整正文写文件（截断打印过 JSON 会解析不了，踩过）
    writeFileSync('/tmp/dsh-mobile-probe-out.json', r.body);
    console.log(r.body.slice(0, 600));
  }

  dsh.kill('SIGKILL');
  process.exit(0);
}

main().catch((e) => {
  console.error('探针失败:', e);
  process.exit(1);
});
