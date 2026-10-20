#!/usr/bin/env node
/**
 * 守卫：手机端「会话读取器」—— 列表过滤 / 聊天增量解析（合成数据，不需要真 DSH、不碰真机）
 *
 * ══════════════════════════════════════════════════════════════════════
 * 为什么单独立一条（而不是只靠真 DSH 探针）：
 *   探针跑的是"当下这条真实数据"，抓不出**边界**：
 *     · subagent 子会话混进顶层列表（真实 home 里 98 个投影、95 个是 `{}` 的坑）
 *     · 空白/无日志/无投影的目录
 *     · 事件日志**多帧 zstd** 的增量读取（只读新增段、末帧只写了一半、坏帧跳过）
 *   这些恰恰是最容易悄悄回归、又最难在真机上复现的地方，所以用合成 fixture 钉死。
 *
 * 断言：
 *   1. 列表：普通会话进；subagent 不进；无日志/无投影/无标题且 0 轮的不进；字段（标题/轮数/预览）对
 *   2. 聊天：全文 + 图片/文件附件元数据都被解析（promptParts）
 *   3. 增量：追加新帧后 changed=true 且多出新轮；文件没变时 changed=false
 *   4. 半帧：只写一半的帧不能崩、不能推进偏移；补全后能读出来
 *
 * 用法：node scripts/test-mobile-session-readers.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOD = path.join(REPO, 'shell-plugins', 'dsh-shell-mobile', 'lib', 'index.js');
const mod = await import(MOD);

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dw-mobile-readers-'));
const WS = path.join(HOME, 'sessions', '--Users-mac-proj--');
const PROJ = path.join(HOME, 'storages', 'session_projcache', 'sessions');
fs.mkdirSync(WS, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });

const problems = [];
const ok = (cond, msg) => {
  if (cond) console.log(`   ✓ ${msg}`);
  else {
    console.error(`   ✗ ${msg}`);
    problems.push(msg);
  }
};

/** 把一组事件做成一个 zstd 帧（与 DSH 的 session.v4.jsonl.zstd 同格式） */
function frame(events) {
  return zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
}

function writeProj(id, { title = '', turns = [], lastPromptAt = null, subagent = false, workspace = '/Users/mac/proj' } = {}) {
  const rows = {
    title: { ver: 1, seq: 1, val: title },
    turnOutline: { ver: 2, seq: 2, val: { turns, draft: '' } },
    sessionListMetadata: { ver: 1, seq: 1, val: { blank: turns.length === 0, lastPromptAt } },
    workingDirectory: { ver: 1, seq: 1, val: workspace },
    subagent: { ver: 2, seq: 1, val: subagent ? {} : {} },
  };
  fs.writeFileSync(path.join(PROJ, `${id}.json`), JSON.stringify({ version: 1, record: { identity: { createdAt: 1, cwd: workspace }, rows } }));
}

function sessionDir(id) {
  const dir = path.join(WS, id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const header = (id, extra = {}) => ({ type: 'session', version: 4, id, createdAt: 1792000000000, cwd: '/Users/mac/proj', isSeeded: false, ...extra });

// ── fixture 1：普通会话（两轮，第 1 轮带图片+文件+文本，第 2 轮纯文本）──
const S1 = 'session-normal-0001';
const s1Dir = sessionDir(S1);
const s1Frame1 = frame([
  header(S1),
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    data: {
      content: [
        { type: 'image', attachment: { attachmentId: 'sha256:aaa', mediaType: 'image/png', width: 64, height: 64, bytes: 538, name: 'a.png' } },
        { type: 'file', attachment: { attachmentId: 'sha256:bbb', name: 'fault.log', bytes: 52 } },
        { type: 'text', text: '这一轮的问题：完整一句很长很长的话，不能被截断' },
      ],
      source: { kind: 'user' },
    },
  },
  { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '第一轮回答' }] } } },
  { type: 'turn/end', seq: 4, data: { turn: 1 } },
]);
fs.writeFileSync(path.join(s1Dir, 'session.v4.jsonl.zstd'), s1Frame1);
writeProj(S1, { title: '带附件的会话', turns: [{ turn: 1, prompt: 'p', response: 'r' }], lastPromptAt: 1792000000500 });

// 系统注入的 user/message（source 不是 user）不能算聊天
const s1Frame2 = frame([
  { type: 'turn/start', seq: 5, data: { turn: 2 } },
  { type: 'user/message', seq: 6, data: { content: [{ type: 'text', text: '<system-reminder>运行时上下文</system-reminder>' }], source: { kind: 'system' } } },
  { type: 'user/message', seq: 7, data: { content: [{ type: 'text', text: '第二轮' }], source: { kind: 'user' } } },
  { type: 'assistant/message', seq: 8, data: { turn: 2, message: { content: [{ type: 'text', text: '第二轮回答' }] } } },
  { type: 'turn/end', seq: 9, data: { turn: 2 } },
]);

// ── fixture 2：subagent 子会话（头里 origin=subagent）──
const S2 = 'session-subagent-0002';
const s2Dir = sessionDir(S2);
fs.writeFileSync(path.join(s2Dir, 'session.v4.jsonl.zstd'), frame([header(S2, { origin: 'subagent', parentSession: S1 }), { type: 'turn/start', seq: 1, data: { turn: 1 } }]));
writeProj(S2, { title: '子任务', turns: [{ turn: 1, prompt: 'x', response: 'y' }], lastPromptAt: 1792000000900, subagent: true });

// ── fixture 3：无标题 + 0 轮（空会话）→ 不进列表 ──
const S3 = 'session-blank-0003';
fs.writeFileSync(path.join(sessionDir(S3), 'session.v4.jsonl.zstd'), frame([header(S3)]));
writeProj(S3, { title: '', turns: [], lastPromptAt: null });

// ── fixture 4：有目录没日志 → 不进列表 ──
const S4 = 'session-nolog-0004';
fs.mkdirSync(path.join(WS, S4), { recursive: true });
writeProj(S4, { title: '没日志', turns: [{ turn: 1, prompt: 'a', response: 'b' }], lastPromptAt: 1792000000100 });

// ── fixture 5：有日志没投影缓存 → 不进列表 ──
const S5 = 'session-noproj-0005';
fs.writeFileSync(path.join(sessionDir(S5), 'session.v4.jsonl.zstd'), frame([header(S5), { type: 'turn/start', seq: 1, data: { turn: 1 } }]));

// ══════════════════════════════════════════════════════════════════════
// 1) 列表过滤
// ══════════════════════════════════════════════════════════════════════
console.log('\n== 列表过滤 ==');
const list = mod.listPersistedSessions(HOME);
const ids = list.map((r) => r.id);
ok(ids.includes(S1), '普通会话进列表');
ok(!ids.includes(S2), 'subagent 子会话不进顶层列表（只从日志头 origin 判断）');
ok(!ids.includes(S3), '无标题且 0 轮的空会话不进列表');
ok(!ids.includes(S4), '只有目录没有事件日志的不进列表');
ok(!ids.includes(S5), '没有投影缓存的不进列表');
const row1 = list.find((r) => r.id === S1);
ok(row1?.title === '带附件的会话', `标题被读出（${String(row1?.title)}）`);
ok(row1?.turnCount === 1, `轮数来自投影（${String(row1?.turnCount)}）`);
ok(typeof row1?.updatedAt === 'number' && row1.updatedAt === 1792000000500, `updatedAt 用投影里的 lastPromptAt（${String(row1?.updatedAt)}）`);
ok(String(row1?.workspace || '').includes('proj'), `工作区被读出（${String(row1?.workspace)}）`);

// ══════════════════════════════════════════════════════════════════════
// 2) 聊天全文 + 附件 + 增量（追加一帧）
// ══════════════════════════════════════════════════════════════════════
console.log('\n== 聊天解析 + 增量 ==');
const c1 = mod.readSessionChat(S1, HOME);
ok(c1.ok === true, 'readSessionChat ok');
ok(c1.count === 1, `首帧解析出 1 轮（${String(c1.count)}）`);
const t1 = c1.turns[0];
ok(t1?.prompt === '这一轮的问题：完整一句很长很长的话，不能被截断', `用户文本完整（不被截断）（${JSON.stringify(t1?.prompt)}）`);
ok(t1?.response === '第一轮回答', `助手回复被读出（${JSON.stringify(t1?.response)}）`);
const types = (t1?.promptParts || []).map((p) => p.type);
ok(JSON.stringify(types) === JSON.stringify(['image', 'file', 'text']), `附件/文本顺序正确（${JSON.stringify(types)}）`);
const img = (t1?.promptParts || []).find((p) => p.type === 'image');
ok(img?.attachmentId === 'sha256:aaa' && img?.width === 64 && img?.bytes === 538, '图片元数据（id/尺寸/字节）完整');
const file = (t1?.promptParts || []).find((p) => p.type === 'file');
ok(file?.attachmentId === 'sha256:bbb' && file?.name === 'fault.log' && file?.bytes === 52, '文件元数据（id/名字/字节）完整');

const c1again = mod.readSessionChat(S1, HOME);
ok(c1again.changed === false && c1again.count === 1, '文件没变时走缓存（changed=false）');

// 追加第二帧（半帧场景先只写一半）
const second = s1Frame2;
const half = Math.floor(second.length / 2);
fs.appendFileSync(path.join(s1Dir, 'session.v4.jsonl.zstd'), second.subarray(0, half));
const cHalf = mod.readSessionChat(S1, HOME);
ok(cHalf.ok === true && cHalf.count === 1, `半帧（只写了一半）不崩且不多算（count=${String(cHalf.count)}）`);
ok(cHalf.changed === false, '半帧不消费（changed=false，偏移不能推进到帧中间）');
fs.appendFileSync(path.join(s1Dir, 'session.v4.jsonl.zstd'), second.subarray(half));
const c2 = mod.readSessionChat(S1, HOME);
ok(c2.ok === true && c2.count === 2, `补全后新轮读出来（count=${String(c2.count)}）`);
ok(c2.turns[1]?.prompt === '第二轮', `第 2 轮用户消息正确（${JSON.stringify(c2.turns[1]?.prompt)}）`);
ok(c2.turns[1]?.response === '第二轮回答', `第 2 轮回复正确（${JSON.stringify(c2.turns[1]?.response)}）`);
ok(!(c2.turns[1]?.prompt || '').includes('system-reminder'), '系统注入的 user/message 不算用户聊天');
ok(c2.turns[0]?.response === '第一轮回答', '增量解析不丢第 1 轮');

// ══════════════════════════════════════════════════════════════════════
// 3) 按附件 id 反查（/mobile/api/attachment 的授权依据）
// ══════════════════════════════════════════════════════════════════════
console.log('\n== 按 id 找附件 ==');
const foundImg = mod.findChatAttachment(S1, 'sha256:aaa', HOME);
ok(foundImg?.type === 'image' && foundImg?.mediaType === 'image/png', '能按 attachmentId 找到图片元数据');
const foundFile = mod.findChatAttachment(S1, 'sha256:bbb', HOME);
ok(foundFile?.type === 'file' && foundFile?.name === 'fault.log', '能按 attachmentId 找到文件元数据');
const notFound = mod.findChatAttachment(S1, 'sha256:zzz', HOME);
ok(notFound === null, '会话里没引用过的 id 查不到（不会越权读别的附件）');

// 清理
fs.rmSync(HOME, { recursive: true, force: true });

console.log('\n' + (problems.length ? `❌ 会话读取器守卫失败 ${problems.length} 项` : '✅ 会话读取器守卫全部通过'));
process.exit(problems.length ? 1 : 0);
