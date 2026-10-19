#!/usr/bin/env node
/**
 * 手机端界面能力断言（Electron 透明窗口，**真 DSH**）——附件展示/发送、轨迹 tab、chips 切换、手机审批卡
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么用 Electron 而不是在真机上点：这些交互（看图/切模型/审批按钮）需要
 * 精确点击与 DOM 断言；真机上 hdc 坐标点按不稳（交接文档踩过）。Electron 的
 * Chromium 与鸿蒙 WebView 是同一套前端代码，先在桌面端把"页面行为"钉住，
 * 真机只做一眼验收。
 *
 * 复用 `check-mobile-attachments.mjs` 建的临时 home（里面有带图片/文件附件的真会话），
 * 所以两个脚本串起来跑最省时间：先附件链路，再界面链路。
 *
 * 用法：node scripts/check-mobile-features-e2e.mjs
 *   · DSH 一律 --no-open；Electron 窗口不可见（show:false / opacity:0）——不打扰用户；
 *   · 真实模型调用只发 1~2 条很小 prompt（审批卡用例）。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, cpSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSH_MOBILE_FEATURES_PORT || 46940);
const PROFILE = 'deepwhale';
const HOME = join(tmpdir(), 'dsh-mobile-attach');   // 与附件断言共用（跑过附件断言后这里已有真会话）
const OUT = '/tmp/dsh-mobile-features';
const SHOTS = join(OUT, 'shots');
// 用**我们自己的网关**（src/main/mobile-gateway.ts 的编译产物）来加载页面：
// 这样测的是真机同一条链路（手机 → 网关（令牌）→ DSH 插件 → 页面），而不是绕过网关直连 DSH。
const { startMobileGateway } = require(join(REPO, 'dist', 'main', 'mobile-gateway.js'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function request(pathname, { method = 'GET', body, contentType, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method, headers: { ...(contentType ? { 'content-type': contentType } : {}), ...headers, ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function jsonOf(res) {
  try {
    return JSON.parse(res.body.toString('utf8'));
  } catch {
    return null;
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  // 1) 需要临时 home 已初始化（跑过 check-mobile-attachments.mjs 就有）
  if (!existsSync(join(HOME, 'profiles', PROFILE, 'package.json'))) {
    console.error('❌ 临时 DSH home 不存在，请先跑 node scripts/check-mobile-attachments.mjs');
    process.exit(1);
  }
  // 2) 装最新插件 + 手机端界面
  const pluginSrc = join(REPO, 'shell-plugins', 'dsh-shell-mobile');
  const pluginDst = join(HOME, 'plugins', 'dsh-shell-mobile');
  rmSync(pluginDst, { recursive: true, force: true });
  cpSync(pluginSrc, pluginDst, { recursive: true });
  cpSync(join(REPO, 'mobile-ui'), join(pluginDst, 'ui'), { recursive: true });
  try {
    rmSync(join(HOME, 'profiles', PROFILE, 'node_modules', '@deepwhale-cn', 'dsh-shell-mobile'), { force: true });
  } catch {}
  spawn('ln', ['-sfn', pluginDst, join(HOME, 'profiles', PROFILE, 'node_modules', '@deepwhale-cn', 'dsh-shell-mobile')]);
  const pkgPath = join(HOME, 'profiles', PROFILE, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const dshCfg = (pkg.dsh ??= {});
  const prof = (dshCfg.profile ??= {});
  const bundles = (prof.bundles ??= []);
  if (!bundles.includes('@deepwhale-cn/dsh-shell-mobile')) bundles.push('@deepwhale-cn/dsh-shell-mobile');
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));

  // 3) 起 DSH（--no-open）
  const dsh = spawn(
    process.execPath,
    [join(REPO, 'dsh-runtime/node_modules/.bin/dsh'), '--profile', PROFILE, '--no-open', '--port', String(PORT)],
    { cwd: join(REPO, 'dsh-runtime'), env: { ...process.env, DSH_HOME: HOME, PATH: `/usr/local/bin:${process.env.PATH}` }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  dsh.stdout.on('data', (d) => (log += d));
  dsh.stderr.on('data', (d) => (log += d));
  let token = '';
  for (let i = 0; i < 60 && !token; i += 1) {
    const m = /token=([^\s]+)/.exec(log);
    if (m) token = m[1];
    else await wait(500);
  }
  if (!token) {
    console.error('DSH 未就绪，日志：\n' + log.slice(0, 1200));
    dsh.kill('SIGKILL');
    process.exit(1);
  }
  // 4) 起我们自己的网关（真机同一条链路），页面从网关打开
  const gw = await startMobileGateway({ dshBase: `http://127.0.0.1:${PORT}`, dshToken: token, port: 0 });
  const gwBase = `http://127.0.0.1:${gw.port}`;
  const gwToken = gw.session.token;
  console.log(`网关就绪：${gwBase}（页面从这里打开，与真机一致）`);

  // 5) Electron 透明窗口跑界面断言
  const driver = join(REPO, 'scripts', '_e2e-mobile-features.js');
  const el = spawn(join(REPO, 'node_modules/.bin/electron'), [driver], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      DSH_E2E_BASE: gwBase,
      DSH_E2E_TOKEN: gwToken,
      DSH_E2E_SHOTS: SHOTS,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  el.stdout.on('data', (d) => (out += d));
  el.stderr.on('data', (d) => (out += d));
  await new Promise((r) => el.on('exit', r));
  try {
    await gw.stop();
  } catch {}
  dsh.kill('SIGKILL');

  const m = /FEATURES_RESULT (\{.*\})/.exec(out);
  writeFileSync(join(OUT, 'raw.log'), out);
  if (!m) {
    console.error('❌ 界面断言没有产出结果：\n' + out.slice(-2500));
    process.exit(1);
  }
  let data = {};
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    console.error('❌ 结果不是 JSON：', m[1].slice(0, 800));
    process.exit(1);
  }
  const problems = [];
  const skips = [];
  if (!(data.rows >= 1)) problems.push(`列表页没有渲染会话行（${data.rows}）`);
  if (!(data.chatMsgs >= 2)) problems.push(`会话页消息不足（${data.chatMsgs}）`);
  if (!(data.attachCards >= 1)) problems.push('会话页没有渲染出附件卡（图片/文件）');
  if (data.imageLoaded !== true) problems.push(`点击附件卡后图片没有真正加载出来（naturalWidth=${data.imageNaturalWidth}）`);
  if (!(data.traceRows >= 1)) problems.push(`轨迹 tab 没有渲染出内容（${data.traceRows}）`);
  if (!(data.modelOptions >= 1)) problems.push(`模型选择面板没有选项（${data.modelOptions}）`);
  if (data.chipModelAfter === '' || data.chipModelAfter === '模型') skips.push('模型 chip 没有显示真值（可能没有可用模型）');
  if (data.attachmentSent !== true) problems.push('界面里带附件发送没有成功（会话没有新增轮次）');
  if (data.jsError) problems.push(`页面出现 JS 错误：${String(data.jsError).slice(0, 300)}`);
  if (data.approvalShown) {
    if (!(data.approvalAnswered === true)) problems.push('审批卡出现了但点「允许一次」没有生效');
  } else {
    skips.push(`审批卡没出现：${data.approvalNote || '模型没有发起需要审批的调用（非插件失败）'}`);
  }
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ data, problems, skips }, null, 2));
  console.log('\nFEATURES_RESULT ' + JSON.stringify({ data, problems, skips }));
  if (problems.length) {
    console.error(`\n❌ 手机端界面断言失败 ${problems.length} 项`);
    process.exit(1);
  }
  console.log(`\n✅ 手机端界面断言全部通过${skips.length ? `（${skips.length} 项跳过，见上）` : ''}·截图 ${SHOTS}/`);
  process.exit(0);
}

main().catch((e) => {
  console.error('断言脚本出错:', e);
  process.exit(1);
});
