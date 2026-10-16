#!/usr/bin/env node
/**
 * 手机端**真实用户流程**的端到端断言（独立 App 场景）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 这条断言回答的是"用户拿到 App 之后到底能不能用起来"：
 *   ① 起一个临时 DSH（真 DSH，--no-open，不打扰用户）
 *   ② 起**我们的网关**（局域网 + 一次性配对码 + 令牌 + CORS）
 *   ③ 把 mobile-ui 用一个本地静态服务发出（模拟"手机 App 里的本地页面"，
 *      它与网关**不同源** —— 这一步正是独立 App 与"网页塞手机"的本质区别）
 *   ④ 在浏览器里打开本地页面 → 走连接页 → 用配对码配对 → 断言列出真会话
 *
 * 任何一环断了都会红：DSH 没起、网关没起、CORS 没开、配对码不认、接口形状变了、
 * 界面没渲染 —— 全部都会在这里暴露。
 *
 * 用法：node scripts/check-mobile-standalone-e2e.js
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const { startMobileGateway } = require(path.join(REPO, 'dist', 'main', 'mobile-gateway.js'));
const MINI = require('node:module').createRequire(path.join(REPO, 'scripts', 'x.js'));

const DSH_PORT = 47100;
const UI_PORT = 47101;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 把 mobile-ui 目录当静态站点发出（内容类型简单映射） */
function serveUi() {
  const root = path.join(REPO, 'mobile-ui');
  const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const server = http.createServer((req, res) => {
    const rel = (req.url || '/').split('?')[0];
    const file = path.join(root, rel === '/' ? 'index.html' : rel.slice(1));
    try {
      const body = fs.readFileSync(file);
      // ⚠️ 必须 no-store：否则 Electron 会缓存 app.js，**我改的代码在 E2E 里根本不生效**
      //    （实测症状：改了 UI 逻辑但 E2E 行为不变，白查了很久）
      res.writeHead(200, {
        'content-type': mime[path.extname(file)] ?? 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(UI_PORT, '127.0.0.1', () => resolve(server)));
}

/** Electron：打开本地页面 → 配对 → 断言列表 */
function runBrowser(gwOrigin, pairCode) {
  return new Promise((resolve) => {
    const script = path.join(REPO, 'scripts', '_e2e-standalone.js');
    const el = spawn(path.join(REPO, 'node_modules/.bin/electron'), [script], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        DSH_UI_URL: `http://127.0.0.1:${UI_PORT}/index.html?t=${Date.now()}`,
        DSH_GW_ORIGIN: gwOrigin,
        DSH_GW_CODE: pairCode,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    el.stdout.on('data', (d) => (out += d));
    el.stderr.on('data', (d) => (out += d));
    el.on('exit', () => resolve(out));
  });
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-standalone-'));

  // ⚠️ 必须先初始化 profile 并**装上我们的插件**：独立 App 用的正是 /mobile/api/*，
  //    裸 DSH 上没有这些接口 —— 第一版就是漏了这步，上游 404/403，白查很久（实测）。
  const dshBin = path.join(REPO, 'dsh-runtime/node_modules/.bin/dsh');
  const envDsh = { ...process.env, DSH_HOME: home, PATH: `/usr/local/bin:${process.env.PATH}` };
  await new Promise((resolve) => {
    const init = spawn(process.execPath, [dshBin, '--profile', 'deepwhale', '--from-default-profile', 'web', '--no-open', '--port', '0'], {
      cwd: path.join(REPO, 'dsh-runtime'), env: envDsh, stdio: 'ignore',
    });
    setTimeout(() => { init.kill('SIGKILL'); resolve(); }, 15000);
  });
  const pluginSrc = path.join(REPO, 'shell-plugins', 'dsh-shell-mobile');
  const pluginDst = path.join(home, 'plugins', 'dsh-shell-mobile');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.cpSync(pluginSrc, pluginDst, { recursive: true });
  fs.cpSync(path.join(REPO, 'mobile-ui'), path.join(pluginDst, 'ui'), { recursive: true });
  const nmDir = path.join(home, 'profiles', 'deepwhale', 'node_modules', '@deepwhale-cn');
  fs.mkdirSync(nmDir, { recursive: true });
  try { fs.rmSync(path.join(nmDir, 'dsh-shell-mobile'), { force: true }); } catch {}
  fs.symlinkSync(pluginDst, path.join(nmDir, 'dsh-shell-mobile'));
  const profilePkgPath = path.join(home, 'profiles', 'deepwhale', 'package.json');
  const profilePkg = JSON.parse(fs.readFileSync(profilePkgPath, 'utf8'));
  const bundles = (((profilePkg.dsh ??= {}).profile ??= {}).bundles ??= []);
  if (!bundles.includes('@deepwhale-cn/dsh-shell-mobile')) bundles.push('@deepwhale-cn/dsh-shell-mobile');
  fs.writeFileSync(profilePkgPath, JSON.stringify(profilePkg, null, 2));
  const dsh = spawn(process.execPath, [dshBin, '--profile', 'deepwhale', '--no-open', '--port', String(DSH_PORT)], {
    cwd: path.join(REPO, 'dsh-runtime'),
    env: envDsh,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  dsh.stdout.on('data', (d) => (log += d));
  dsh.stderr.on('data', (d) => (log += d));
  let base = '';
  let token = '';
  for (let i = 0; i < 40 && !base; i += 1) {
    const m = /dsh web:\s*(https?:\/\/[^\s?]+)\/?\?token=([^\s]+)/.exec(log);
    if (m) {
      base = m[1];
      token = m[2];
    } else await wait(500);
  }
  if (!base) {
    console.error('❌ 临时 DSH 未就绪：\n' + log.slice(0, 600));
    dsh.kill('SIGKILL');
    process.exit(1);
  }

  const gw = await startMobileGateway({ dshBase: base, dshToken: token });
  const ui = await serveUi();
  console.log(`== 临时环境就绪：DSH ${base} · 网关 ${gw.session.origin} · 本地页面 http://127.0.0.1:${UI_PORT}/`);

  const out = await runBrowser(`http://127.0.0.1:${gw.port}`, gw.session.pairCode);
  ui.close();
  await gw.stop();
  dsh.kill('SIGKILL');

  const m = /STANDALONE_RESULT (\{.*\})/.exec(out);
  if (!m) {
    console.error('❌ 没拿到结果：\n' + out.slice(-1200));
    process.exit(1);
  }
  const r = JSON.parse(m[1]);
  const problems = [];
  if (!r.paired) problems.push(`配对失败（${r.pairReason ?? '未知'}）`);
  if (!r.showedConnect) problems.push('独立 App 首次进入没有显示连接页');
  if (!(r.rows >= 1)) problems.push(`配对后没有列出会话（rows=${r.rows}）`);
  // ⚠️ 必须校验 id 形态：静态演示行的 data-id 是 "s1"，会冒充"有会话"（实测导致过假绿）
  if (r.firstId && !/^session-/.test(String(r.firstId))) {
    problems.push(`列出的是**演示行**而不是真实会话（firstId=${r.firstId}）`);
  }

  if (problems.length) {
    console.error('❌ 独立 App 流程失败：\n');
    console.error('（浏览器侧输出，便于定位）\n' + out.slice(-1500) + '\n');
    console.error('（建会话结果：' + String(r.createResult ?? '(未调用)') + '）\n');
    problems.forEach((p, i) => console.error(`   ${i + 1}. ${p}`));
    process.exitCode = 1;
  } else {
    console.log(`✅ 独立 App 流程通过：连接页 → 配对 → 列出 ${r.rows} 行真实会话（${r.firstId}）`);
  }
})().catch((e) => {
  console.error('脚本自身出错:', e);
  process.exitCode = 1;
});
