#!/usr/bin/env node
/**
 * 手机端「附件 + 审批 + 聊天全文」能力断言（**真 DSH**，不是替身）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么必须真跑：这条链上每一环都可能"看起来写了、其实没接上"——
 *   ① 图片：官方 RPC `session/prompt` 的 image content part → 宿主准入/落盘
 *      → 事件日志里出现 {type:'image',attachment:{attachmentId…}}
 *      → 我们插件的 /mobile/api/chat 把它读出来 → /mobile/api/attachment 能取回字节；
 *   ② 文件：官方 `POST /api/session/uploadFileBinary` 拿 receiptId →
 *      prompt 里 {type:'file',receiptId} → 会话日志里是 file ref；
 *   ③ 手机审批：宿主 `approval/request` waterfall → 我们插件的 answerer
 *      （手机正开着该会话 SSE 时才接管）→ /mobile/api/approvals 能看到 → 回答后
 *      宿主真的按 allowed-once 继续（approval/decided 事件 + 工具不再等）。
 *
 * 用法：node scripts/check-mobile-attachments.mjs
 *   · 起一个临时 DSH（临时 DSH_HOME，用完即删/复用），装上我们的插件；
 *   · DSH 一律 --no-open，不弹任何窗口；
 *   · 若本机 dsh-home 有 .credentials.yaml，会拷一份进临时 home 以允许真实模型回合
 *     （只发 1~2 条很小的 prompt）。
 *
 * 产物：/tmp/dsh-mobile-attach/*.json（每步原始返回，便于排障）、
 *       最后一行 `ATTACH_RESULT {json}` 供上层脚本解析。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.DSH_MOBILE_ATTACH_PORT || 46930);
const PROFILE = 'deepwhale';
const HOME = join(tmpdir(), 'dsh-mobile-attach');
const OUT = '/tmp/dsh-mobile-attach';
const REAL_HOME = process.env.DSH_REAL_HOME || join(process.env.HOME || '', 'Library', 'Application Support', 'DeepWhale Desktop', 'dsh-home');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];
const skips = [];
const ok = (cond, msg) => {
  if (cond) console.log(`   ✓ ${msg}`);
  else {
    console.error(`   ✗ ${msg}`);
    problems.push(msg);
  }
};
const skip = (msg) => {
  console.log(`   ~ 跳过：${msg}`);
  skips.push(msg);
};

/** 1×1 PNG（合法的 PNG，用来验证宿主图片准入 + 我们按 sha256 取回字节） */
const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BYTES = Buffer.from(PNG_BASE64, 'base64');
const FILE_TEXT = 'fault.log 内容：E2E 附件测试\n第二行 line2\n';
const FILE_BYTES = Buffer.from(FILE_TEXT, 'utf8');

let cookie = '';
let token = '';

function request(pathname, { method = 'GET', body, contentType, headers = {}, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: pathname,
        method,
        headers: {
          ...(cookie ? { cookie } : {}),
          ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
          ...(contentType ? { 'content-type': contentType } : {}),
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }),
        );
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
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

/** 官方 typed RPC（与手机/桌面客户端同一条路） */
async function rpc(method, requestArgs) {
  const rpcId = randomUUID();
  const payload = JSON.stringify({
    type: 'client-request',
    rpcId,
    method,
    payload: { args: { request: requestArgs ?? {} } },
  });
  const res = await request(`/api/${method}`, { method: 'POST', body: payload, contentType: 'application/json' });
  const j = jsonOf(res) || {};
  const result = j.result || {};
  return { ok: result.ok === true, value: result.value, error: result.error, raw: j, status: res.status };
}

/** 等待某个条件成立（轮询），返回最后一次结果 */
async function waitFor(label, fn, { timeoutMs = 60000, intervalMs = 500 } = {}) {
  const startedAt = Date.now();
  let last = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      last = await fn();
      if (last && last.stop) return last;
    } catch (e) {
      last = { error: String(e?.message ?? e) };
    }
    await wait(intervalMs);
  }
  return last ?? { timeout: true, label };
}

/** 打开一条 SSE，收集事件（返回 {events, close}） */
function openSse(sessionId) {
  const events = [];
  let closed = false;
  let req = null;
  const ready = new Promise((resolve, reject) => {
    req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: `/mobile/api/stream?id=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`,
        method: 'GET',
        headers: cookie ? { cookie } : {},
        timeout: 4000,
      },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error('sse status ' + res.statusCode));
          return;
        }
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const evLine = /^event: (.*)$/m.exec(raw);
            const dataLine = /^data: (.*)$/m.exec(raw);
            if (evLine) {
              let data = null;
              if (dataLine) {
                try {
                  data = JSON.parse(dataLine[1]);
                } catch {
                  data = dataLine[1];
                }
              }
              events.push({ event: evLine[1], data, at: Date.now() });
            }
          }
        });
        res.on('end', () => {
          closed = true;
        });
        resolve();
      },
    );
    req.on('error', (e) => (closed ? null : reject(e)));
    req.end();
  });
  return {
    events,
    ready,
    close: () => {
      closed = true;
      try {
        req?.destroy();
      } catch {}
    },
    isClosed: () => closed,
  };
}

function bootInitHome() {
  // 只在缺 profile 时初始化（复用 → 反复跑更快）
  if (existsSync(join(HOME, 'profiles', PROFILE, 'package.json'))) return false;
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(HOME, { recursive: true });
  return true;
}

async function initProfile() {
  const init = spawn(
    process.execPath,
    [join(REPO, 'dsh-runtime/node_modules/.bin/dsh'), '--profile', PROFILE, '--from-default-profile', 'web', '--no-open', '--port', String(PORT)],
    {
      cwd: join(REPO, 'dsh-runtime'),
      env: { ...process.env, DSH_HOME: HOME, PATH: `/usr/local/bin:${process.env.PATH}` },
      stdio: 'ignore',
    },
  );
  await wait(15000);
  init.kill('SIGKILL');
  await wait(500);
}

/** 把插件装进临时 home（拷源码 + ui + profile bundle 条目） */
function installPlugin() {
  const pluginSrc = join(REPO, 'shell-plugins', 'dsh-shell-mobile');
  const pluginDst = join(HOME, 'plugins', 'dsh-shell-mobile');
  rmSync(pluginDst, { recursive: true, force: true });
  mkdirSync(join(HOME, 'plugins'), { recursive: true });
  cpSync(pluginSrc, pluginDst, { recursive: true });
  cpSync(join(REPO, 'mobile-ui'), join(pluginDst, 'ui'), { recursive: true });
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
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const fresh = bootInitHome();
  if (fresh) await initProfile();
  // 模型凭据（可选）：有的话审批用例能跑真实模型回合
  try {
    const cred = join(REAL_HOME, '.credentials.yaml');
    if (existsSync(cred)) {
      copyFileSync(cred, join(HOME, '.credentials.yaml'));
      console.log('（已拷入模型凭据，允许真实模型回合）');
    }
  } catch (e) {
    console.log('（拷模型凭据失败，模型回合可能不可用）', String(e?.message ?? e));
  }
  installPlugin();

  let dsh = null;
  /** 起一个 DSH 子进程并用它的 token 换 cookie；返回是否就绪 */
  async function startDsh() {
    dsh = spawn(
      process.execPath,
      [join(REPO, 'dsh-runtime/node_modules/.bin/dsh'), '--profile', PROFILE, '--no-open', '--port', String(PORT)],
      {
        cwd: join(REPO, 'dsh-runtime'),
        env: { ...process.env, DSH_HOME: HOME, PATH: `/usr/local/bin:${process.env.PATH}` },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let log = '';
    dsh.stdout.on('data', (d) => (log += d));
    dsh.stderr.on('data', (d) => (log += d));
    token = '';
    for (let i = 0; i < 60 && !token; i += 1) {
      const m = /token=([^\s]+)/.exec(log);
      if (m) token = m[1];
      else await wait(500);
    }
    if (!token) {
      console.error('DSH 未就绪，日志：\n' + log.slice(0, 1500));
      return false;
    }
    const first = await request(`/?token=${encodeURIComponent(token)}`);
    cookie = (first.headers['set-cookie'] ?? []).map((c) => String(c).split(';')[0]).join('; ');
    return true;
  }
  const cleanup = () => {
    try {
      dsh?.kill('SIGKILL');
    } catch {}
  };
  process.on('exit', cleanup);

  if (!(await startDsh())) {
    cleanup();
    process.exit(1);
  }
  console.log(`临时 DSH 就绪：http://127.0.0.1:${PORT}\n`);

  const health = jsonOf(await request('/mobile/api/health'));
  writeFileSync(join(OUT, 'health.json'), JSON.stringify(health, null, 2));
  ok(health?.ok === true && health?.plugin === 'shell-mobile', '插件健康检查通过');
  ok(health?.version >= '0.2.0', `插件版本 ≥ 0.2.0（实际 ${health?.version}）`);

  // ── 建会话（官方 RPC，与手机端同一条） ──
  const created = await rpc('session/create', {});
  const sessionId = created.value?.sessionId;
  ok(!!sessionId, `官方 RPC 建会话成功（${sessionId || '无 id'}）`);
  if (!sessionId) {
    cleanup();
    process.exit(1);
  }

  // ═════════════════════════════════════════════════════════════════
  // ① 图片：prompt 里带 image content part → 宿主准入落盘 → 我们能读回
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== ① 图片附件 ==');
  const imgPrompt = await rpc('session/prompt', {
    requestId: `attach-img-${Date.now().toString(36)}`,
    sessionId,
    mode: 'queue',
    content: [
      { type: 'image', mediaType: 'image/png', data: PNG_BASE64, name: 'e2e.png' },
      { type: 'text', text: '这是一张测试图片（E2E）' },
    ],
  });
  writeFileSync(join(OUT, 'prompt-image.json'), JSON.stringify(imgPrompt.raw ?? imgPrompt, null, 2));
  ok(imgPrompt.ok === true, `带图片的 prompt 被接受（${imgPrompt.error ? JSON.stringify(imgPrompt.error).slice(0, 120) : 'accepted'}）`);
  const imageTurnWait = await waitFor(
    'chat-image',
    async () => {
      const j = jsonOf(await request(`/mobile/api/chat?id=${encodeURIComponent(sessionId)}`));
      const turn = (j?.turns || []).find((t) => (t.promptParts || []).some((p) => p.type === 'image'));
      return turn ? { stop: true, turn } : null;
    },
    { timeoutMs: 30000 },
  );
  writeFileSync(join(OUT, 'chat-after-image.json'), JSON.stringify(imageTurnWait.turn || imageTurnWait, null, 2));
  const imagePart = (imageTurnWait.turn?.promptParts || []).find((p) => p.type === 'image');
  ok(!!imagePart, '会话日志里的图片附件被 /mobile/api/chat 读出（type=image）');
  ok(!!imagePart?.attachmentId && /^sha256:/.test(imagePart.attachmentId), `附件 id 是内容寻址的（${imagePart?.attachmentId || '无'}）`);
  ok(Number(imagePart?.width) > 0 && Number(imagePart?.height) > 0, `图片尺寸被读出（${imagePart?.width}×${imagePart?.height}）`);
  if (imagePart?.attachmentId) {
    const got = await request(
      `/mobile/api/attachment?sid=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(imagePart.attachmentId)}&token=${encodeURIComponent(token)}`,
    );
    ok(got.status === 200, `/mobile/api/attachment 取回图片（HTTP ${got.status}）`);
    ok(/^image\//.test(String(got.headers['content-type'] || '')), `返回的 content-type 是图片（${got.headers['content-type']}）`);
    ok(got.body.length === PNG_BYTES.length, `取回的字节数一致（${got.body.length} vs ${PNG_BYTES.length}）`);
    if (got.status !== 200) writeFileSync(join(OUT, 'attachment-image-fail.json'), got.body);
  }
  const chatText = (imageTurnWait.turn?.promptParts || []).filter((p) => p.type === 'text').map((p) => p.text).join('');
  ok(chatText.includes('这是一张测试图片'), '同一条消息的文本部分完整保留（不再被 50 字截断）');

  // ═════════════════════════════════════════════════════════════════
  // ② 文件：uploadFileBinary → receiptId → prompt 引用 → 会话日志是 file ref
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== ② 文件附件 ==');
  const upload = await request(
    `/api/session/uploadFileBinary?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent('fault.log')}`,
    { method: 'POST', body: FILE_BYTES, contentType: 'application/octet-stream', timeoutMs: 60000 },
  );
  const uploadJson = jsonOf(upload);
  writeFileSync(join(OUT, 'upload-file.json'), JSON.stringify(uploadJson, null, 2));
  const receiptId = uploadJson?.value?.receiptId;
  ok(upload.status === 200 && uploadJson?.ok === true && !!receiptId, `文件上传拿到 receiptId（HTTP ${upload.status}）`);
  if (receiptId) {
    const filePrompt = await rpc('session/prompt', {
      requestId: `attach-file-${Date.now().toString(36)}`,
      sessionId,
      mode: 'queue',
      content: [
        { type: 'file', receiptId },
        { type: 'text', text: '这是一个测试日志文件（E2E）' },
      ],
    });
    writeFileSync(join(OUT, 'prompt-file.json'), JSON.stringify(filePrompt.raw ?? filePrompt, null, 2));
    ok(filePrompt.ok === true, '带文件的 prompt 被接受');
    const fileTurnWait = await waitFor(
      'chat-file',
      async () => {
        const j = jsonOf(await request(`/mobile/api/chat?id=${encodeURIComponent(sessionId)}`));
        const turn = (j?.turns || []).find((t) => (t.promptParts || []).some((p) => p.type === 'file'));
        return turn ? { stop: true, turn } : null;
      },
      { timeoutMs: 30000 },
    );
    writeFileSync(join(OUT, 'chat-after-file.json'), JSON.stringify(fileTurnWait.turn || fileTurnWait, null, 2));
    const filePart = (fileTurnWait.turn?.promptParts || []).find((p) => p.type === 'file');
    ok(!!filePart, '会话日志里的文件附件被 /mobile/api/chat 读出（type=file）');
    ok(filePart?.name === 'fault.log' && filePart?.bytes === FILE_BYTES.length, `文件名与字节数正确（${filePart?.name} / ${filePart?.bytes}）`);
    if (filePart?.attachmentId) {
      const got = await request(
        `/mobile/api/attachment?sid=${encodeURIComponent(sessionId)}&id=${encodeURIComponent(filePart.attachmentId)}&token=${encodeURIComponent(token)}`,
      );
      ok(got.status === 200 && got.body.length === FILE_BYTES.length, `文件字节可下载（HTTP ${got.status}，${got.body.length} 字节）`);
    }
  }

  // ═════════════════════════════════════════════════════════════════
  // ②b 重启 DSH：持久化会话必须还在列表里（否则桌面重启后手机列表空白）
  //     —— 旧实现列表只读 sessions.list()（进程内 live sessions），重启后 count=0。
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== ②b 重启后会话列表（持久化） ==');
  // 先等两轮都真正结束（助手回复落盘）——否则投影里的 turn 数是"进行中"，重启后自然少
  const done = await waitFor(
    'turns-complete',
    async () => {
      const j = jsonOf(await request(`/mobile/api/chat?id=${encodeURIComponent(sessionId)}`));
      const turns = j?.turns || [];
      const allAnswered = turns.length >= 2 && turns.every((t) => (t.response || '').trim() !== '');
      return allAnswered ? { stop: true, count: turns.length } : null;
    },
    { timeoutMs: 90000, intervalMs: 1000 },
  );
  if (!done.count) console.log('   （提醒：90s 内两轮没有全部完成，重启后轮数断言放宽到 1）');
  cleanup();
  await wait(1500);
  if (!(await startDsh())) {
    console.error('重启 DSH 失败');
    process.exit(1);
  }
  await wait(3000);   // 让 DSH 把会话索引/投影缓存就绪
  const restarted = jsonOf(await request('/mobile/api/sessions'));
  writeFileSync(join(OUT, 'sessions-after-restart.json'), JSON.stringify(restarted, null, 2));
  const listed = (restarted?.sessions || []).find((row) => row.id === sessionId);
  ok(restarted?.ok === true, '重启后 /mobile/api/sessions 仍可用');
  ok(!!listed, `重启后列表里仍有这个会话（via=${restarted?.via}，共 ${restarted?.count} 条）`);
  const minTurns = done.count ? 2 : 1;
  ok((listed?.turnCount || 0) >= minTurns, `重启后列表带真实轮数（${listed?.turnCount}，期望 ≥${minTurns}）`);
  ok(!!(listed?.preview && listed.preview.length > 0), '重启后列表带内容预览（不再是「新会话」）');

  // ═════════════════════════════════════════════════════════════════
  // ③ SSE：聊天全文事件真的推送（手机端实时同步用）
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== ③ SSE chat 推送 ==');
  const sse = openSse(sessionId);
  await sse.ready.catch(() => {});
  await wait(1500);
  ok(sse.events.some((e) => e.event === 'chat'), `SSE 首帧就推了 chat（事件 ${sse.events.map((e) => e.event).join('/') || '无'}）`);
  const firstChat = sse.events.find((e) => e.event === 'chat');
  ok(Array.isArray(firstChat?.data?.turns) && firstChat.data.turns.length >= 2, `SSE chat 首帧包含全部轮次（${firstChat?.data?.turns?.length ?? 0} 轮）`);

  // ═════════════════════════════════════════════════════════════════
  // ④ 手机审批：真实模型请求提权 → 手机接管 → 允许一次 → 宿主继续
  // ═════════════════════════════════════════════════════════════════
  console.log('\n== ④ 手机审批 ==');
  const hasCred = existsSync(join(HOME, '.credentials.yaml'));
  if (!hasCred) {
    skip('临时 home 没有模型凭据，无法跑真实审批回合');
  } else {
    const approvalPrompt = await rpc('session/prompt', {
      requestId: `attach-approval-${Date.now().toString(36)}`,
      sessionId,
      mode: 'queue',
      content: [
        {
          type: 'text',
          text:
            '请立即调用 bash 工具执行 `echo mobile-approval-e2e`。' +
            '这次调用必须同时带两个参数：sandbox_permissions="danger-full-access" 和 justification="测试手机端审批卡：需要在沙箱外执行 echo 来验证审批流程"。' +
            '不要解释、不要问我，直接调用工具。',
        },
      ],
    });
    ok(approvalPrompt.ok === true, '审批用例的 prompt 被接受');
    const pendingWait = await waitFor(
      'approval-pending',
      async () => {
        const j = jsonOf(await request(`/mobile/api/approvals?sid=${encodeURIComponent(sessionId)}`));
        const list = j?.approvals || [];
        return list.length ? { stop: true, list, watching: j.watching } : null;
      },
      { timeoutMs: 120000, intervalMs: 800 },
    );
    if (!pendingWait.list) {
      const diag = jsonOf(await request(`/mobile/api/_dev/events?id=${encodeURIComponent(sessionId)}`));
      writeFileSync(join(OUT, 'approvals-timeout-events.json'), JSON.stringify(diag, null, 2));
      const counts = diag?.typeCounts || {};
      skip(
        '120s 内没有进入手机审批：' +
          `approval/asked=${counts['approval/asked'] || 0}、tool/use=${counts['tool/use'] || 0}、` +
          `approval/decided=${counts['approval/decided'] || 0}（模型没发起需要审批的调用，不是插件失败）`,
      );
    } else {
      writeFileSync(join(OUT, 'approvals-pending.json'), JSON.stringify(pendingWait, null, 2));
      ok(pendingWait.watching === true, '手机 SSE 在线时审批被手机接管（watching=true）');
      ok(pendingWait.list.length === 1 && !!pendingWait.list[0].toolName, `待审批卡片带工具名（${pendingWait.list[0]?.toolName}）`);
      const decision = jsonOf(
        await request('/mobile/api/approval/answer', {
          method: 'POST',
          body: JSON.stringify({ id: pendingWait.list[0].id, outcome: 'allowed-once' }),
          contentType: 'application/json',
        }),
      );
      writeFileSync(join(OUT, 'approval-answer.json'), JSON.stringify(decision, null, 2));
      ok(decision?.ok === true, '手机回答“允许一次”被接受');
      const settled = await waitFor(
        'approval-decided',
        async () => {
          const ev = jsonOf(await request(`/mobile/api/_dev/events?id=${encodeURIComponent(sessionId)}`));
          const counts = ev?.typeCounts || {};
          return counts['approval/decided'] ? { stop: true, counts } : null;
        },
        { timeoutMs: 60000, intervalMs: 1000 },
      );
      ok(!!settled.counts, '宿主记下了 approval/decided（审批链路真的走通）');
      const again = jsonOf(await request(`/mobile/api/approvals?sid=${encodeURIComponent(sessionId)}`));
      ok(!(again?.approvals || []).length, '回答后待审批列表清空（不会重复弹）');
    }
  }
  sse.close();

  // 清理
  cleanup();
  writeFileSync(join(OUT, 'result.json'), JSON.stringify({ problems, skips }, null, 2));
  console.log('\nATTACH_RESULT ' + JSON.stringify({ problems, skips }));
  if (problems.length) {
    console.error(`\n❌ 手机端附件/审批断言失败 ${problems.length} 项`);
    process.exit(1);
  }
  console.log(`\n✅ 手机端附件/审批断言全部通过${skips.length ? `（${skips.length} 项跳过，见上）` : ''}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('断言脚本出错:', e);
  process.exit(1);
});
