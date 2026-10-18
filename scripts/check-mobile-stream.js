#!/usr/bin/env node
/**
 * 守卫：手机端"实时同步"的事件流（SSE）必须真的能推数据
 *
 * ══════════════════════════════════════════════════════════════════════
 * 背景（2026-10-18 用户问"是不是不是实时同步"）：确认——之前打开会话只拉一次快照 ✗。
 * 现在插件提供 `/mobile/api/stream?id=…`（SSE，投影文件 mtime 变化即推 turns），
 * 手机端用 EventSource 订阅。
 *
 * 这条守卫不能只做静态检查（"有路由"≠"推得出数据"✗），必须真起一遍：
 *   临时 DSH（带我们的插件）→ 预置一个投影缓存文件 → 起网关 → 订阅 SSE
 *   → 断言 ① content-type 是 text/event-stream ② 收到 event: turns ③ 内容是预期的 two turns
 * 同时断言"文件变化后会再推一次"（模拟助手回复落盘 → 手机端应看到更新）。
 * 用法：node scripts/check-mobile-stream.js
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const { startMobileGateway } = require(path.join(REPO, 'dist', 'main', 'mobile-gateway.js'));
const DSH_PORT = 47900;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const problems = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stream-'));
  const bin = path.join(REPO, 'dsh-runtime', 'node_modules', '.bin', 'dsh');
  const env = { ...process.env, DSH_HOME: home, PATH: `/usr/local/bin:${process.env.PATH}` };

  // 预置投影缓存（夹具，形状与真实文件一致）
  const sid = 'session-stream-test';
  const cacheDir = path.join(home, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(cacheDir, { recursive: true });
  const cacheFile = path.join(cacheDir, `${sid}.json`);
  const writeTurns = (n) => {
    const turns = [];
    for (let i = 1; i <= n; i += 1) turns.push({ turn: i, prompt: `问题${i}`, response: `回答${i}` });
    fs.writeFileSync(cacheFile, JSON.stringify({ record: { rows: { turnOutline: { val: { turns } } } } }), 'utf8');
  };
  writeTurns(2);

  // 初始化 profile（带我们的插件）
  const init = spawn(process.execPath, [bin, '--profile', 'deepwhale', '--from-default-profile', 'web', '--no-open', '--port', '0'], {
    cwd: path.join(REPO, 'dsh-runtime'), env, stdio: 'ignore',
  });
  await wait(14000);
  init.kill('SIGKILL');
  await wait(400);
  const dst = path.join(home, 'plugins', 'dsh-shell-mobile');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  fs.cpSync(path.join(REPO, 'shell-plugins', 'dsh-shell-mobile'), dst, { recursive: true });
  fs.cpSync(path.join(REPO, 'mobile-ui'), path.join(dst, 'ui'), { recursive: true });
  const nm = path.join(home, 'profiles', 'deepwhale', 'node_modules', '@deepwhale-cn');
  fs.mkdirSync(nm, { recursive: true });
  try { fs.rmSync(path.join(nm, 'dsh-shell-mobile'), { force: true }); } catch { /* 首次安装 */ }
  fs.symlinkSync(dst, path.join(nm, 'dsh-shell-mobile'));
  const pk = path.join(home, 'profiles', 'deepwhale', 'package.json');
  const pj = JSON.parse(fs.readFileSync(pk, 'utf8'));
  (((pj.dsh ??= {}).profile ??= {}).bundles ??= []).push('@deepwhale-cn/dsh-shell-mobile');
  fs.writeFileSync(pk, JSON.stringify(pj, null, 2));

  const dsh = spawn(process.execPath, [bin, '--profile', 'deepwhale', '--no-open', '--port', String(DSH_PORT)], {
    cwd: path.join(REPO, 'dsh-runtime'), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  dsh.stdout.on('data', (d) => (log += d));
  dsh.stderr.on('data', (d) => (log += d));
  let base = '';
  let token = '';
  for (let i = 0; i < 40 && !base; i += 1) {
    const m = /dsh web:\s*(https?:\/\/[^\s?]+)\/?\?token=([^\s]+)/.exec(log);
    if (m) { base = m[1]; token = m[2]; } else await wait(500);
  }
  if (!base) {
    dsh.kill('SIGKILL');
    console.error('❌ DSH 未就绪');
    process.exit(1);
  }
  const gw = await startMobileGateway({ dshBase: base, dshToken: token });

  // 订阅 SSE，收集事件
  const received = [];
  let ctype = '';
  const streamReq = http.request({
    host: '127.0.0.1', port: gw.port,
    path: `/mobile/api/stream?id=${encodeURIComponent(sid)}&token=${encodeURIComponent(gw.session.token)}`,
    method: 'GET',
  }, (res) => {
    ctype = String(res.headers['content-type'] || '');
    let buf = '';
    res.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (/^event: turns/m.test(block)) {
          const data = /^data: (.*)$/m.exec(block);
          try { received.push(JSON.parse(data ? data[1] : '{}')); } catch { /* 忽略坏帧 */ }
        }
      }
    });
  });
  streamReq.on('error', () => {});
  streamReq.end();

  // ① 首次推流
  for (let i = 0; i < 30 && received.length === 0; i += 1) await wait(300);
  if (!/text\/event-stream/.test(ctype)) problems.push(`content-type 不是 text/event-stream（实际 ${ctype || '空'}）`);
  if (received.length === 0) problems.push('没有收到 event: turns（实时推送不工作）');
  else if ((received[0].turns || []).length !== 2) problems.push(`首次推流应有 2 轮，实际 ${(received[0].turns || []).length}`);

  // ② 文件变化后应再推一次（模拟助手回复落盘）
  const before = received.length;
  writeTurns(3);
  for (let i = 0; i < 30 && received.length === before; i += 1) await wait(300);
  if (received.length === before) problems.push('投影文件变化后没有再次推送（不是"实时"）');
  else if ((received[received.length - 1].turns || []).length !== 3) problems.push('再次推流的内容不是最新的 3 轮');

  try { streamReq.destroy(); } catch { /* 已关闭 */ }
  await gw.stop();
  dsh.kill('SIGKILL');

  if (problems.length) {
    console.error('❌ 实时同步（SSE）守卫失败：\n');
    problems.forEach((x, i) => console.error(`   ${i + 1}. ${x}`));
    process.exitCode = 1;
  } else {
    console.log(`✅ 实时同步（SSE）通过：首次 ${received[0].turns.length} 轮 → 文件变化后再推 ${received[received.length - 1].turns.length} 轮`);
  }
})().catch((e) => {
  console.error('❌ 守卫自身异常：', e?.message ?? e);
  process.exitCode = 1;
});
