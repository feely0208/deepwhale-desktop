#!/usr/bin/env node
/**
 * 打包产物守卫：**真·构建出来的 .app** 里的手机端是不是齐的（不是 dev 仓库，不是临时 DSH）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么需要（本仓库踩过的一类"假绿"）：
 *   源码里有插件、临时 DSH 探针也绿，但**打出来的 app 载荷里没有**（随包清单/构建脚本漏了），
 *   用户装到的包就是"功能凭空消失"。1.0.56 的视频预览就是这么丢的。
 *   手机端这条链更长：插件在 `Contents/Resources/bundled-plugins/`、界面在插件的 `ui/`、
 *   主进程要负责「启动时自动开网关」——任何一环没进包，源码测试全绿也没用。
 *
 * 做法（全程隔离，不碰用户正在跑的实例）：
 *   ① 独立 `--user-data-dir` + 独立 DSH_HOME + 独立端口；
 *   ② 预置 `mobile-gateway.json` 为 `enabled:true`（这同时验证"重启后自动开网关"这条修复：
 *      没人点面板，网关必须自己起来）；
 *   ③ 等网关 `/mobile/api/health` 通 → 断言插件版本、`/mobile/` 里的 app.js 版本号；
 *   ④ 可选 `--seed <dsh-home>`：拷几个会话进去，走一遍 `/mobile/api/chat` 和
 *      `/mobile/api/attachment`（证明打包插件真能读事件日志 + 取附件字节）；
 *   ⑤ 结束后杀进程、删临时目录。
 *
 * 用法：
 *   node scripts/check-packaged-app-mobile.mjs                 # 自动找最新 release-next<NN>/mac-arm64
 *   node scripts/check-packaged-app-mobile.mjs --app "release-next27/mac-arm64/DeepWhale Desktop.app"
 *   node scripts/check-packaged-app-mobile.mjs --seed <dsh-home>  # 带真实会话数据
 *   --keep  保留临时目录（排障用）
 *
 * 注意：窗口是隐藏的（DSH_DESKTOP_SMOKE_HIDDEN=1），**不会**在用户桌面弹东西。
 */
'use strict';

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const ok = (cond, msg) => {
  if (cond) console.log(`   ✓ ${msg}`);
  else {
    console.error(`   ✗ ${msg}`);
    problems.push(msg);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { app: '', seed: '', keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--app') out.app = argv[++i] || '';
    else if (argv[i] === '--seed') out.seed = argv[++i] || '';
    else if (argv[i] === '--keep') out.keep = true;
  }
  return out;
}

/** 找最新的 release-next<NN>/mac-arm64/DeepWhale Desktop.app */
function findLatestApp() {
  const dirs = fs
    .readdirSync(REPO)
    .filter((d) => /^release-next\d+$/.test(d))
    .map((d) => path.join(REPO, d, 'mac-arm64', 'DeepWhale Desktop.app'))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return dirs.length ? dirs[0].p : '';
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

function httpGet(port, pathname, { timeoutMs = 5000, raw = false } = {}) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, body: raw ? body : body.toString('utf8') });
      });
    });
    req.on('error', (e) => resolve({ error: e.code || String(e) }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'timeout' });
    });
  });
}

/** 从源码读"应该出现在包里的"两个版本号 */
function expectedVersions() {
  const pluginSrc = fs.readFileSync(path.join(REPO, 'shell-plugins', 'dsh-shell-mobile', 'lib', 'index.js'), 'utf8');
  const uiHtml = fs.readFileSync(path.join(REPO, 'mobile-ui', 'index.html'), 'utf8');
  const plugin = /const PLUGIN_VERSION = '([^']+)'/.exec(pluginSrc)?.[1] ?? '';
  const ui = /app\.js\?v=([A-Za-z0-9]+)/.exec(uiHtml)?.[1] ?? '';
  return { plugin, ui };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const app = args.app ? path.resolve(REPO, args.app) : findLatestApp();
  if (!app || !fs.existsSync(app)) {
    console.error('❌ 找不到打包产物（release-next<NN>/mac-arm64/DeepWhale Desktop.app），先构建');
    process.exit(1);
  }
  const bin = path.join(app, 'Contents', 'MacOS', 'DeepWhale Desktop');
  const stamp = Date.now();
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-pkg-verify-ud-'));
  // ⚠️ 应用用的是 `<userData>/dsh-home`（legalModeHome），**不是**环境变量 DSH_HOME ——
  //    第一版把种子数据注进了一个独立 home，结果 DSH 根本看不见（sessions=0，实测踩到）。
  const home = path.join(ud, 'dsh-home');
  fs.mkdirSync(home, { recursive: true });
  const logFile = path.join(os.tmpdir(), `dw-pkg-verify-${String(stamp)}.log`);
  const dshPort = await freePort();
  let gwPort = await freePort();
  while (gwPort === dshPort) gwPort = await freePort();
  const token = `pkg-verify-${String(stamp)}-token`;
  console.log(`产物：${app}`);
  console.log(`隔离：userData=${ud} DSH_HOME=${home} dshPort=${String(dshPort)} gwPort=${String(gwPort)}`);

  fs.writeFileSync(path.join(ud, 'settings.json'), JSON.stringify({ port: dshPort }));
  fs.writeFileSync(
    path.join(ud, 'mobile-gateway.json'),
    JSON.stringify({ port: gwPort, token, enabled: true, pairCode: 'VERIFY', pairCodeAt: 0, updatedAt: new Date().toISOString() }),
  );
  // 跳过"从旧 legal home 迁移"（否则会把用户几百 MB 历史搬进临时目录，又慢又没必要）
  fs.writeFileSync(path.join(home, '.migrated-from-legacy-home'), 'skipped by packaged guard\n');
  // 可选：喂一点真实会话数据（chat/attachment 用例要用）
  if (args.seed) {
    const seed = path.resolve(args.seed);
    for (const sub of ['sessions', 'storages', 'attachments']) {
      const from = path.join(seed, sub);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(home, sub), { recursive: true });
    }
    console.log(`已注入种子数据：${seed}`);
  }

  const env = { ...process.env };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_PROFILE_DIR']) delete env[k];
  env.DSH_DESKTOP_SMOKE = '1';
  env.DSH_DESKTOP_SMOKE_HIDDEN = '1'; // 窗口隐藏：绝不打扰正在用电脑的人

  let child = null;
  const cleanup = () => {
    if (child && !child.killed) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }
  };
  process.on('exit', cleanup);

  const logChunks = [];
  try {
    child = spawn(bin, [`--user-data-dir=${ud}`], { stdio: ['ignore', 'pipe', 'pipe'], env });
    child.stdout.on('data', (d) => logChunks.push(String(d)));
    child.stderr.on('data', (d) => logChunks.push(String(d)));

    // ① 等网关起来（**没有任何人点面板** —— 它必须靠启动自动恢复自己起来）
    const deadline = Date.now() + 180000;
    let health = null;
    while (Date.now() < deadline) {
      const r = await httpGet(gwPort, `/mobile/api/health?token=${encodeURIComponent(token)}`);
      if (r.status === 200) {
        try {
          health = JSON.parse(r.body);
          break;
        } catch {}
      }
      await sleep(2000);
    }
    const log = logChunks.join('');
    fs.writeFileSync(logFile, log);

    ok(!!health && health.ok === true, `网关在没人操作的情况下自动起来（health ${health ? 'ok' : '未就绪'}）`);
    if (!health) {
      console.error('--- 启动日志尾部 ---\n' + log.slice(-2500));
    } else {
      const expect = expectedVersions();
      ok(health.plugin === 'shell-mobile', `网关后面是手机端插件（${String(health.plugin)}）`);
      ok(health.version === expect.plugin, `插件版本与源码一致（包内 ${String(health.version)} / 源码 ${expect.plugin}）`);

      const page = await httpGet(gwPort, `/mobile/?token=${encodeURIComponent(token)}`);
      const gotUi = /app\.js\?v=([A-Za-z0-9]+)/.exec(page.body)?.[1] ?? '';
      ok(page.status === 200, `/mobile/ 能打开（HTTP ${String(page.status)}）`);
      ok(gotUi === expect.ui, `页面里的 app.js 版本与源码一致（包内 ${gotUi} / 源码 ${expect.ui}）`);

      const sess = await httpGet(gwPort, `/mobile/api/sessions?token=${encodeURIComponent(token)}`);
      let sessJson = null;
      try {
        sessJson = JSON.parse(sess.body);
      } catch {}
      ok(!!sessJson && sessJson.ok === true, '/mobile/api/sessions 可用');

      // ② 种子数据的 chat + attachment（证明打包插件能读事件日志、能取附件字节）
      if (args.seed && sessJson && Array.isArray(sessJson.sessions)) {
        let found = null;
        console.log(`   （种子会话列表：${String(sessJson.sessions.length)} 条）`);
        for (const row of sessJson.sessions.slice(0, 40)) {
          const r = await httpGet(gwPort, `/mobile/api/chat?id=${encodeURIComponent(row.id)}&token=${encodeURIComponent(token)}`);
          let j = null;
          try {
            j = JSON.parse(r.body);
          } catch {}
          if (!j || !j.ok) console.log(`      chat ${row.id.slice(0, 16)} → ${String(j && j.reason)}`);
          else console.log(`      chat ${row.id.slice(0, 16)} → ${String((j.turns || []).length)} 轮，附件类型 ${JSON.stringify((j.turns || []).flatMap((t) => (t.promptParts || []).filter((p) => p.type !== 'text').map((p) => p.type)))}`);
          if (j && j.ok && (j.turns || []).some((t) => (t.promptParts || []).some((p) => p.type === 'image'))) {
            found = { id: row.id, chat: j };
            break;
          }
        }
        ok(!!found, '打包插件能从事件日志读出「带图片附件」的聊天全文');
        if (found) {
          const img = found.chat.turns
            .flatMap((t) => t.promptParts || [])
            .find((p) => p.type === 'image');
          const att = await httpGet(gwPort, `/mobile/api/attachment?sid=${encodeURIComponent(found.id)}&id=${encodeURIComponent(img.attachmentId)}&token=${encodeURIComponent(token)}`, { raw: true });
          ok(att.status === 200, `附件字节可取回（HTTP ${String(att.status)}）`);
          ok(/^image\//.test(String(att.headers?.['content-type'] || '')), `附件 content-type 是图片（${String(att.headers?.['content-type'])}）`);
          ok((att.body?.length || 0) > 0, `附件字节非空（${String(att.body?.length || 0)} 字节）`);
        }
      }

      // ③ 配对码必须和**内存里真实的那个**一致（否则二维码/排障/自动化读到的码对不上）
      let gwState = null;
      try {
        gwState = JSON.parse(fs.readFileSync(path.join(ud, 'mobile-gateway.json'), 'utf8'));
      } catch {}
      ok(!!gwState?.pairCode && gwState.pairCode !== 'VERIFY' && gwState.pairCode !== '', `启动后把真实配对码写进状态文件（${String(gwState?.pairCode)}）`);
      if (gwState?.pairCode) {
        const pair = await httpGet(gwPort, `/__pair?code=${encodeURIComponent(gwState.pairCode)}`);
        let pairJson = null;
        try {
          pairJson = JSON.parse(pair.body);
        } catch {}
        ok(pair.status === 200 && pairJson?.ok === true && pairJson.token === token, '用状态文件里的配对码能直接换到令牌（排障/自动化可免扫码配对）');
      }

      // ④ 启动日志必须证明"自动恢复开网关"真的走了（不是碰巧端口上还残留着旧进程）
      ok(/\[mobile\] 自动恢复手机访问: 已开启/.test(log), '启动日志里有「[mobile] 自动恢复手机访问: 已开启」');
    }
  } finally {
    try {
      child?.kill('SIGTERM');
    } catch {}
    await sleep(3000);
    try {
      child?.kill('SIGKILL');
    } catch {}
    if (!args.keep) {
      fs.rmSync(ud, { recursive: true, force: true });
    } else {
      console.log(`保留：${ud} / ${home} / ${logFile}`);
    }
  }

  console.log('\nPKG_MOBILE_RESULT ' + JSON.stringify({ app, problems, logFile }));
  if (problems.length) {
    console.error(`\n❌ 打包产物手机端守卫失败 ${String(problems.length)} 项（日志 ${logFile}）`);
    process.exit(1);
  }
  console.log('\n✅ 打包产物里的手机端齐备（插件/界面/自动开网关/聊天/附件）');
  process.exit(0);
}

main().catch((e) => {
  console.error('守卫脚本出错:', e);
  process.exit(1);
});
