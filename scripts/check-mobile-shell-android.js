/**
 * 守卫：**Android 壳**的完整握手流程（真 DSH + 真网关）
 *
 * 覆盖的是"用户真机上那条路"：壳页面（~/.deepwhale-mobile/web）填地址 + 配对码 →
 * 调网关 /__pair 换令牌 → 跳 <网关>/mobile/ → 我们的界面列出真实会话。
 *
 * 为什么必须真跑（本守卫抓过的真 bug）：
 *   · 网关剥离 `token=` 参数时留下 `&` → `/mobile/&dshApp=1` → 插件 404 → 手机端白屏
 *     （只有"壳跳转带额外参数"这一条路径才复现，单元测试用 `?token=` 干净 URL 永远绿）；
 *   · 页面不接住 URL 里的令牌 → 网关 401 → 退回连接页。
 * 用法：node scripts/check-mobile-shell-android.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const REPO = '/Users/mac/dsh-desktop';
const { startMobileGateway } = require(path.join(REPO, 'dist/main/mobile-gateway.js'));
const WEB_ROOT = path.join(os.homedir(), 'deepwhale-mobile', 'web');
if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
  console.error('❌ 找不到 Android 壳页面：' + WEB_ROOT + '/index.html');
  process.exit(1);
}
const UI_PORT = 47501, DSH_PORT = 47500;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = (req.url || '/').split('?')[0];
  const f = path.join(WEB_ROOT, rel === '/' ? 'index.html' : rel.slice(1));
  try {
    res.writeHead(200, { 'content-type': mime[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(f));
  } catch { res.writeHead(404); res.end('nf'); }
});

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-android-'));
  const dshBin = path.join(REPO, 'dsh-runtime/node_modules/.bin/dsh');
  const env = { ...process.env, DSH_HOME: home, PATH: '/usr/local/bin:' + process.env.PATH };
  const init = spawn(process.execPath, [dshBin, '--profile', 'deepwhale', '--from-default-profile', 'web', '--no-open', '--port', '0'], { cwd: REPO + '/dsh-runtime', env, stdio: 'ignore' });
  await wait(14000); init.kill('SIGKILL'); await wait(400);
  const dst = path.join(home, 'plugins/dsh-shell-mobile');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.cpSync(path.join(REPO, 'shell-plugins/dsh-shell-mobile'), dst, { recursive: true });
  fs.cpSync(path.join(REPO, 'mobile-ui'), path.join(dst, 'ui'), { recursive: true });
  const nm = path.join(home, 'profiles/deepwhale/node_modules/@deepwhale-cn');
  fs.mkdirSync(nm, { recursive: true });
  try { fs.rmSync(path.join(nm, 'dsh-shell-mobile'), { force: true }); } catch {}
  fs.symlinkSync(dst, path.join(nm, 'dsh-shell-mobile'));
  const pk = path.join(home, 'profiles/deepwhale/package.json');
  const pj = JSON.parse(fs.readFileSync(pk, 'utf8'));
  (((pj.dsh ??= {}).profile ??= {}).bundles ??= []).push('@deepwhale-cn/dsh-shell-mobile');
  fs.writeFileSync(pk, JSON.stringify(pj, null, 2));
  const dsh = spawn(process.execPath, [dshBin, '--profile', 'deepwhale', '--no-open', '--port', String(DSH_PORT)], { cwd: REPO + '/dsh-runtime', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; dsh.stdout.on('data', d => log += d); dsh.stderr.on('data', d => log += d);
  let base = '', token = '';
  for (let i = 0; i < 40 && !base; i++) { const m = /dsh web:\s*(https?:\/\/[^\s?]+)\/?\?token=([^\s]+)/.exec(log); if (m) { base = m[1]; token = m[2]; } else await wait(500); }
  if (!base) { console.log('DSH 未就绪'); dsh.kill('SIGKILL'); process.exit(1); }
  const gw = await startMobileGateway({ dshBase: base, dshToken: token });
  await new Promise((r) => server.listen(UI_PORT, '127.0.0.1', r));

  // 直接探测静态资源（决定性证据：HTML 到得了、app.js 到不到）
  const http = require('http');
  const get = (path) => new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: gw.port, path, method: 'GET' }, (x) => {
      let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, len: b.length, ctype: x.headers['content-type'] }));
    });
    r.on('error', (e) => res({ status: 0, err: e.message })); r.end();
  });
  const tok = encodeURIComponent(gw.session.token);
  for (const pth of ['/mobile/', '/mobile/app.js', '/mobile/index.html']) {
    const r = await get(`${pth}?token=${tok}`);
    console.log(`  资源 ${pth} → ${r.status} ${r.len}B ${r.ctype || ''}`);
  }

  const { spawn: sp } = require('child_process');
  // 关键对照：壳跳转用的那个 URL（带 &dshApp=1）返回的是什么
  const withApp = await new Promise((res) => {
    const r = http.request({ host: '127.0.0.1', port: gw.port,
      path: `/mobile/?token=${encodeURIComponent(gw.session.token)}&dshApp=1`, method: 'GET' }, (x) => {
      let b = ''; x.on('data', (c) => (b += c)); x.on('end', () => res({ status: x.statusCode, len: b.length, head: b.slice(0, 180) }));
    });
    r.on('error', (e) => res({ status: 0, err: e.message })); r.end();
  });
  console.log('  跳转 URL 实测 →', withApp.status, withApp.len + 'B', JSON.stringify(String(withApp.head).slice(0, 160)));

  const el = sp(path.join(REPO, 'node_modules/.bin/electron'), ['/tmp/android-shell-run.js'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '', ANDROID_PAGE: `http://127.0.0.1:${UI_PORT}/index.html`,
      GW: `http://127.0.0.1:${gw.port}`, CODE: gw.session.pairCode }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; el.stdout.on('data', d => out += d); el.stderr.on('data', d => out += d);
  await new Promise((r) => el.on('exit', r));
  const m = /ANDROID_RESULT (\{.*\})/.exec(out);
  server.close(); await gw.stop(); dsh.kill('SIGKILL');
  if (!m) { console.log('❌ 没拿到结果:\n' + out.slice(-800)); process.exit(1); }
  const r = JSON.parse(m[1]);
  const problems = [];
  if (!(r.url && /\/mobile\//.test(r.url))) problems.push(`没有跳到手机端界面（url=${r.url}）`);
  if (!(r.rows >= 1)) problems.push(`界面没有列出会话（rows=${r.rows}）`);
  if (r.firstId && !/^session-/.test(String(r.firstId))) problems.push(`列出的不是真实会话（firstId=${r.firstId}）`);
  if (problems.length) {
    console.error('❌ Android 壳流程失败：');
    problems.forEach((x, i) => console.error(`   ${i + 1}. ${x}`));
    process.exit(1);
  }
  console.log(`✅ Android 壳流程通过（配对 → 跳 /mobile/ → 列出 ${r.rows} 行真实会话 ${r.firstId}）`);
  process.exit(0);
})();
