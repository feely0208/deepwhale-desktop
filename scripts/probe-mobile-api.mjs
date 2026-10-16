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

  // 默认流程：health → 新建一个会话 → 列表 → 取该会话详情（一次性拿到全部形状）
  const steps = [];
  if (rawIdx >= 0) {
    steps.push([argv[rawIdx + 1] ?? '/mobile/api/health', 'GET', undefined]);
  } else {
    steps.push(['/mobile/api/health', 'GET', undefined]);
    steps.push(['/mobile/api/session', 'POST', '{}']);
    steps.push(['/mobile/api/sessions', 'GET', undefined]);
  }
  if (sessionIdx >= 0) steps.push([`/mobile/api/session?id=${encodeURIComponent(argv[sessionIdx + 1] ?? '')}`, 'GET', undefined]);

  for (const [p, method, body] of steps) {
    const r = await get(p, cookie, method, body);
    console.log(`\n== ${p}  → HTTP ${r.status}`);
    console.log(r.body.slice(0, 1200));
  }

  dsh.kill('SIGKILL');
  process.exit(0);
}

main().catch((e) => {
  console.error('探针失败:', e);
  process.exit(1);
});
